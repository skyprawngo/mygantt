"""HTTP API and static server for the local MyGantt application."""

from __future__ import annotations

from .i18n import error_reference, translate

import argparse
import json
import mimetypes
import os
import platform
import socket
import stat
import threading
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from socketserver import ThreadingUnixStreamServer
from typing import Any

from .database import Database
from .scheduler import ScheduleError, schedule_tasks


APP_DIR = Path(__file__).resolve().parent.parent
DB_PATH = APP_DIR / "data" / "mygantt.sqlite3"


def storage_location(database: Database) -> dict[str, str]:
  """Describe the database host, independently of the browser's device."""
  system = platform.system()
  device = platform.node().removesuffix(".local") or "이름 미확인"
  if system == "Darwin":
    os_name = "macOS"
    try:
      import pwd
      account = pwd.getpwuid(os.getuid())
      device = account.pw_gecos.split(",", 1)[0].strip() or account.pw_name or device
    except (ImportError, KeyError, OSError):
      pass
  elif system == "Linux":
    try:
      os_name = platform.freedesktop_os_release().get("NAME", "Linux")
    except OSError:
      os_name = "Linux"
  else:
    os_name = system or "OS 미확인"
  return {
    "label": f"{os_name}⋅{device}",
    "database_path": str(Path(database.path).expanduser().resolve()) if database.path != ":memory:" else ":memory:",
  }


class UnixHTTPServer(ThreadingUnixStreamServer):
  daemon_threads = True


def unix_server(path: Path, handler):
  """Bind a private HTTP socket, refusing to replace live or unrelated files."""
  path.parent.mkdir(parents=True, exist_ok=True)
  if path.exists() or path.is_symlink():
    existing = path.lstat()
    if not stat.S_ISSOCK(existing.st_mode) or existing.st_uid != os.getuid():
      raise FileExistsError(f"Refusing to replace socket path: {path}")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
      probe.settimeout(1)
      try:
        probe.connect(str(path))
      except ConnectionRefusedError:
        path.unlink()
      else:
        raise FileExistsError(f"Another server is listening on socket: {path}")
  mask = os.umask(0o077)
  try:
    server = UnixHTTPServer(str(path), handler)
  finally:
    os.umask(mask)
  os.chmod(path, 0o600)
  return server


def make_handler(database: Database):
  class Handler(BaseHTTPRequestHandler):
    server_version = "MyGantt/1.0"

    def log_message(self, format: str, *args: Any) -> None:
      print(f"[{self.log_date_time_string()}] {format % args}")

    def _json(self, payload: Any, status: int = 200) -> None:
      if isinstance(payload, dict) and isinstance(payload.get("error"), str):
        payload = {**payload, **error_reference(payload["error"])}
      encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
      self.send_response(status)
      self.send_header("Content-Type", "application/json; charset=utf-8")
      self.send_header("Content-Length", str(len(encoded)))
      self.send_header("Cache-Control", "no-store")
      self.end_headers()
      self.wfile.write(encoded)

    def _body(self) -> dict[str, Any]:
      length = int(self.headers.get("Content-Length", "0"))
      if length > 1_000_000:
        raise ScheduleError("요청 본문이 너무 큽니다.")
      if not length:
        return {}
      value = json.loads(self.rfile.read(length))
      if not isinstance(value, dict):
        raise ScheduleError("JSON object 요청이 필요합니다.")
      return value

    def _error(self, message: str, status: int = 400) -> None:
      self._json({"error": message}, status)

    def do_GET(self) -> None:
      parsed = urllib.parse.urlparse(self.path)
      path = parsed.path
      try:
        if path == "/api/state":
          self._json({**database.state(), "storage": storage_location(database), "holiday_country": database.holiday_country()})
          return
        if path == "/api/holiday-calendars":
          from .holiday_calendar import CALENDARS
          self._json({"calendars": CALENDARS, "holiday_country": database.holiday_country()})
          return
        if path == "/api/holidays":
          query = urllib.parse.parse_qs(parsed.query)
          self._json(database.holidays(query.get("start", [None])[0], query.get("end", [None])[0], country=query.get("country", [None])[0]))
          return
        if path == "/api/templates":
          self._json(database.state()["templates"])
          return
        if path.startswith("/api/templates/"):
          item = database.get_template(path.rsplit("/", 1)[-1])
          self._json(item if item else {"error": "템플릿을 찾을 수 없습니다."}, 200 if item else 404)
          return
        if path.startswith("/api/projects/"):
          project = database.get_project(path.rsplit("/", 1)[-1])
          self._json(project if project else {"error": "프로젝트를 찾을 수 없습니다."}, 200 if project else 404)
          return
        if path == "/api/export/calendar.ics":
          query = urllib.parse.parse_qs(parsed.query)
          project_id = query.get("project_id", [None])[0]
          content = database.calendar_ics(project_id).encode("utf-8")
          self.send_response(200)
          self.send_header("Content-Type", "text/calendar; charset=utf-8")
          self.send_header("Content-Disposition", 'attachment; filename="mygantt-schedule.ics"')
          self.send_header("Content-Length", str(len(content)))
          self.end_headers()
          self.wfile.write(content)
          return
        self._static(path)
      except (ScheduleError, ValueError, json.JSONDecodeError) as exc:
        self._error(str(exc))

    def do_POST(self) -> None:
      path = urllib.parse.urlparse(self.path).path
      try:
        payload = self._body()
        parts = path.strip("/").split("/")
        if path == "/api/projects":
          self._json(database.create_project(payload), 201)
          return
        if len(parts) == 4 and parts[:2] == ["api", "projects"] and parts[3] == "complete":
          project = database.complete_project(urllib.parse.unquote(parts[2]))
          self._json(project if project else {"error": "프로젝트를 찾을 수 없습니다."}, 200 if project else 404)
          return
        if path == "/api/templates":
          self._json(database.save_template(payload), 201)
          return
        if path.startswith("/api/projects/") and path.endswith("/tasks") and len(path.split("/")) == 5:
          project = database.create_task(path.split("/")[3], payload)
          self._json(project if project else {"error": "프로젝트를 찾을 수 없습니다."}, 201 if project else 404)
          return
        if path == "/api/instantiate":
          self._json(database.instantiate(payload), 201)
          return
        if path == "/api/preview":
          tasks = payload.get("tasks", [])
          if not tasks:
            raise ScheduleError("미리 볼 작업이 없습니다.")
          key_to_id = {str(task.get("key")): str(task.get("key")) for task in tasks}
          preview_tasks = []
          for index, task in enumerate(tasks):
            preview_tasks.append({**task, "id": key_to_id[str(task.get("key"))], "dependencies": [key_to_id.get(str(dep), str(dep)) for dep in task.get("dependencies", [])], "status": "todo", "sort_order": index})
          result = database.schedule_template(preview_tasks, payload.get("start_date", ""), payload.get("calendar_type", "working"))
          self._json({"tasks": result})
          return
        self._error("경로를 찾을 수 없습니다.", 404)
      except (ScheduleError, ValueError, KeyError, json.JSONDecodeError) as exc:
        self._error(str(exc))

    def do_PUT(self) -> None:
      path = urllib.parse.urlparse(self.path).path
      try:
        payload = self._body()
        if path.startswith("/api/templates/"):
          template_id = path.rsplit("/", 1)[-1]
          item = database.save_template(payload, template_id)
          self._json(item if item else {"error": "템플릿을 찾을 수 없습니다."}, 200 if item else 404)
          return
        self._error("경로를 찾을 수 없습니다.", 404)
      except (ScheduleError, ValueError, KeyError, json.JSONDecodeError) as exc:
        self._error(str(exc))

    def do_DELETE(self) -> None:
      parts = urllib.parse.urlparse(self.path).path.strip("/").split("/")
      try:
        if len(parts) == 3 and parts[0] == "api" and parts[1] in ("projects", "tasks", "templates"):
          delete = {"projects": database.delete_project, "tasks": database.delete_task, "templates": database.delete_template}[parts[1]]
          removed = delete(urllib.parse.unquote(parts[2]))
          if removed:
            self._json({"deleted": True})
          else:
            self._error({"projects": "프로젝트를 찾을 수 없습니다.", "tasks": "작업을 찾을 수 없습니다.", "templates": "템플릿을 찾을 수 없습니다."}[parts[1]], 404)
          return
        self._error("경로를 찾을 수 없습니다.", 404)
      except (ScheduleError, ValueError) as exc:
        self._error(str(exc))

    def do_PATCH(self) -> None:
      path = urllib.parse.urlparse(self.path).path
      try:
        payload = self._body()
        if path == "/api/settings/holiday-calendar":
          self._json(database.set_holiday_country(payload["holiday_country"]))
          return
        if path.startswith("/api/tasks/") and path.endswith("/placement"):
          if "directory_id" not in payload or set(payload) - {"directory_id", "anchor_id", "after"}:
            raise ScheduleError("이동할 프로젝트를 지정하세요.")
          project = database.place_task(path.split("/")[-2], payload["directory_id"], payload.get("anchor_id"), payload.get("after", False))
          self._json(project if project else {"error": "작업을 찾을 수 없습니다."}, 200 if project else 404)
          return
        if path.startswith("/api/tasks/") and path.endswith("/order"):
          if set(payload) != {"anchor_id", "after"}:
            raise ScheduleError("삽입할 작업과 방향을 지정하세요.")
          project = database.reorder_task(path.split("/")[-2], payload["anchor_id"], payload["after"])
          self._json(project if project else {"error": "작업을 찾을 수 없습니다."}, 200 if project else 404)
          return
        if path.startswith("/api/tasks/") and path.endswith("/project"):
          if set(payload) != {"project_id"}:
            raise ScheduleError("이동할 프로젝트를 지정하세요.")
          project = database.move_task(path.split("/")[-2], payload["project_id"])
          self._json(project if project else {"error": "작업을 찾을 수 없습니다."}, 200 if project else 404)
          return
        if path.startswith("/api/tasks/"):
          project = database.update_task(path.rsplit("/", 1)[-1], payload)
          self._json(project if project else {"error": "작업을 찾을 수 없습니다."}, 200 if project else 404)
          return
        if path.startswith("/api/projects/"):
          project = database.update_project(path.rsplit("/", 1)[-1], payload)
          self._json(project if project else {"error": "프로젝트를 찾을 수 없습니다."}, 200 if project else 404)
          return
        self._error("경로를 찾을 수 없습니다.", 404)
      except (ScheduleError, ValueError, KeyError, json.JSONDecodeError) as exc:
        self._error(str(exc))

    def _static(self, path: str) -> None:
      requested = "index.html" if path in {"", "/"} else path.lstrip("/")
      file_path = (APP_DIR / "web" / requested).resolve()
      web_root = (APP_DIR / "web").resolve()
      if web_root not in file_path.parents and file_path != web_root:
        self._error("파일을 찾을 수 없습니다.", 404)
        return
      if not file_path.is_file():
        self._error("파일을 찾을 수 없습니다.", 404)
        return
      data = file_path.read_bytes()
      if requested == 'manifest.webmanifest':
        language = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query).get('language', ['KR'])[0]
        manifest = json.loads(data)
        manifest['name'] = translate('common.mygantt_production_schedule', language)
        manifest['lang'] = {'KR': 'ko-KR', 'US': 'en-US', 'JP': 'ja-JP'}.get(language, 'ko-KR')
        data = json.dumps(manifest, ensure_ascii=False).encode('utf-8')
      content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
      if content_type.startswith("text/") or content_type in {"application/javascript", "application/json"}:
        content_type += "; charset=utf-8"
      self.send_response(200)
      self.send_header("Content-Type", content_type)
      self.send_header("Content-Length", str(len(data)))
      self.send_header("Cache-Control", "no-store")
      self.end_headers()
      self.wfile.write(data)

  return Handler


def main() -> None:
  parser = argparse.ArgumentParser(description="Run the local MyGantt schedule manager")
  parser.add_argument("--host", default="127.0.0.1")
  parser.add_argument("--port", type=int, default=8765)
  parser.add_argument("--db", default=str(DB_PATH))
  parser.add_argument("--no-seed", action="store_true", help="Create an empty production database without example templates or projects")
  parser.add_argument("--unix-socket", type=Path, help="Also serve HTTP on a private Unix socket for an internal reverse proxy")
  args = parser.parse_args()
  database = Database(args.db, seed_samples=not args.no_seed)
  server = ThreadingHTTPServer((args.host, args.port), make_handler(database))
  local_socket = None
  socket_thread = None
  try:
    if args.unix_socket:
      local_socket = unix_server(args.unix_socket, make_handler(database))
      socket_thread = threading.Thread(target=local_socket.serve_forever, daemon=True)
      socket_thread.start()
      print(f"Private HTTP socket: {args.unix_socket}")
    print(f"MyGantt is running at http://{args.host}:{args.port}")
    print(f"SQLite database: {args.db}")
    server.serve_forever()
  except KeyboardInterrupt:
    print("Stopping MyGantt")
  finally:
    server.server_close()
    if local_socket:
      local_socket.shutdown()
      local_socket.server_close()
      socket_thread.join(timeout=2)
      args.unix_socket.unlink(missing_ok=True)


if __name__ == "__main__":
  main()
