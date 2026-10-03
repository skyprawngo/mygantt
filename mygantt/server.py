"""HTTP API and static server for the local MyGantt application."""

from __future__ import annotations

import argparse
import json
import mimetypes
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from .database import Database
from .scheduler import ScheduleError, schedule_tasks


APP_DIR = Path(__file__).resolve().parent.parent
DB_PATH = APP_DIR / "data" / "mygantt.sqlite3"


def make_handler(database: Database):
  class Handler(BaseHTTPRequestHandler):
    server_version = "MyGantt/1.0"

    def log_message(self, format: str, *args: Any) -> None:
      print(f"[{self.log_date_time_string()}] {format % args}")

    def _json(self, payload: Any, status: int = 200) -> None:
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
          self._json(database.state())
          return
        if path == "/api/holidays":
          query = urllib.parse.parse_qs(parsed.query)
          self._json(database.holidays(query.get("start", [None])[0], query.get("end", [None])[0]))
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
        if path == "/api/templates":
          self._json(database.save_template(payload), 201)
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
          result = schedule_tasks(preview_tasks, payload.get("start_date", ""), payload.get("calendar_type", "working"), include_trailing_weekend=True)
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

    def do_PATCH(self) -> None:
      path = urllib.parse.urlparse(self.path).path
      try:
        payload = self._body()
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
  args = parser.parse_args()
  database = Database(args.db)
  server = ThreadingHTTPServer((args.host, args.port), make_handler(database))
  print(f"MyGantt is running at http://{args.host}:{args.port}")
  print(f"SQLite database: {args.db}")
  try:
    server.serve_forever()
  except KeyboardInterrupt:
    print("Stopping MyGantt")
  finally:
    server.server_close()


if __name__ == "__main__":
  main()
