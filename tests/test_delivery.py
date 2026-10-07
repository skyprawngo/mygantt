import io
import importlib.util
import json
import os
import shutil
import socket
import sqlite3
import sys
import tarfile
import tempfile
import unittest
import threading
from unittest.mock import patch
from pathlib import Path
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "deploy/ubuntu"))
from delivery import REPOSITORY, WORKFLOW_ID, atomic_json, extract_source, qualifying_run, read_status, verified_backup
from supervisor import Supervisor
from mygantt.server import make_handler, unix_server
from mygantt.database import Database


def host_module(name, filename):
  path = Path(__file__).resolve().parent.parent / "deploy/ubuntu" / filename
  spec = importlib.util.spec_from_file_location(name, path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  return module


manual = host_module("request_deploy", "request-deploy.py")
poller = host_module("poll_deploy", "poll-deploy.py")


class ManualDeliveryTests(unittest.TestCase):
  def test_request_is_local_private_and_result_must_match_request(self):
    with tempfile.TemporaryDirectory() as name:
      root = Path(name)
      request_id = manual.request_deploy(root)
      marker = root / "manual-deploy.request"
      self.assertEqual(read_status(marker)["request_id"], request_id)
      self.assertEqual(marker.stat().st_mode & 0o777, 0o600)
      atomic_json(root / "manual-deploy.result.json", {"request_id": "other", "result": "deployed"})
      result = {"request_id": request_id, "result": "waiting_for_ci", "sha": "a" * 40}
      worker = threading.Timer(0.05, atomic_json, args=(root / "manual-deploy.result.json", result))
      worker.start()
      self.assertEqual(manual.wait_for_result(root, request_id, 2), result)
      worker.join()

  def test_manual_receipt_does_not_claim_pending_ci_was_deployed(self):
    with tempfile.TemporaryDirectory() as name:
      root = Path(name)
      request_id = manual.request_deploy(root)
      expected = {"result": "waiting_for_ci", "sha": "a" * 40}
      with patch.object(poller, "deliver", return_value=expected) as delivery:
        self.assertEqual(poller.run_delivery({"root": str(root)}), expected)
        delivery.assert_called_once()
      receipt = read_status(root / "manual-deploy.result.json")
      self.assertEqual(receipt["request_id"], request_id)
      self.assertEqual(receipt["result"], "waiting_for_ci")

  def test_manual_failure_receipt_is_written_and_exception_preserved(self):
    with tempfile.TemporaryDirectory() as name:
      root = Path(name)
      request_id = manual.request_deploy(root)
      with patch.object(poller, "deliver", side_effect=RuntimeError("Temporary health failure")):
        with self.assertRaises(RuntimeError):
          poller.run_delivery({"root": str(root)})
      receipt = read_status(root / "manual-deploy.result.json")
      self.assertEqual(receipt["request_id"], request_id)
      self.assertEqual(receipt["result"], "failed")


class DeliverySafetyTests(unittest.TestCase):
  def test_only_current_main_successful_push_or_dispatch_qualifies(self):
    sha = "a" * 40
    base = {"id": 10, "workflow_id": WORKFLOW_ID, "head_sha": sha, "head_branch": "main", "event": "push", "status": "completed", "conclusion": "success", "head_repository": {"full_name": REPOSITORY}}
    self.assertEqual(qualifying_run([base], sha), base)
    self.assertEqual(qualifying_run([{**base, "event": "workflow_dispatch"}], sha)["event"], "workflow_dispatch")
    for changed in [{"event": "pull_request"}, {"event": "pull_request_target"}, {"event": "workflow_run"}, {"head_branch": "feature"}, {"head_sha": "b" * 40}, {"conclusion": "failure"}, {"head_repository": {"full_name": "untrusted/fork"}}, {"workflow_id": 1}]:
      with self.subTest(changed=changed):
        self.assertIsNone(qualifying_run([{**base, **changed}], sha))
    self.assertIsNone(qualifying_run([base, {**base, "id": 11, "status": "in_progress", "conclusion": None}], sha))

  def test_source_extraction_rejects_escape_links_and_databases(self):
    with tempfile.TemporaryDirectory() as name:
      root = Path(name)
      for filename, kind in [("../escape.py", tarfile.REGTYPE), ("link", tarfile.SYMTYPE), ("data/mygantt.sqlite3", tarfile.REGTYPE), ("nested/database.db", tarfile.REGTYPE), (".env", tarfile.REGTYPE), ("nested/.env.production", tarfile.REGTYPE), ("devtools/db-sync/.env.example", tarfile.REGTYPE)]:
        with self.subTest(filename=filename):
          data = io.BytesIO()
          with tarfile.open(fileobj=data, mode="w") as archive:
            member = tarfile.TarInfo(filename)
            member.type = kind
            member.linkname = "../../outside"
            member.size = 1 if kind == tarfile.REGTYPE else 0
            archive.addfile(member, io.BytesIO(b"x") if member.size else None)
          with self.assertRaises(ValueError):
            extract_source(data.getvalue(), root)
          self.assertEqual(list(root.iterdir()), [])

  def test_configuration_instructions_can_ship_without_runtime_env(self):
    with tempfile.TemporaryDirectory() as folder:
      data = io.BytesIO()
      content = b"MYGANTT_SYNC_ENABLED=false\n"
      with tarfile.open(fileobj=data, mode="w") as archive:
        member = tarfile.TarInfo("devtools/db-sync/config.env.example")
        member.size = len(content)
        archive.addfile(member, io.BytesIO(content))
      root = Path(folder)
      extract_source(data.getvalue(), root)
      self.assertEqual((root / "devtools/db-sync/config.env.example").read_bytes(), content)
      self.assertFalse((root / "devtools/db-sync/.env").exists())

  def test_backup_is_consistent_private_and_does_not_change_source(self):
    with tempfile.TemporaryDirectory() as name:
      root = Path(name)
      db = root / "persistent.sqlite3"
      with sqlite3.connect(db) as connection:
        connection.execute("CREATE TABLE records (value TEXT)")
        connection.execute("INSERT INTO records VALUES ('Preserved record')")
      backup = verified_backup(db, root / "backups", "a" * 40)
      self.assertEqual(backup.stat().st_mode & 0o777, 0o600)
      for path in [db, backup]:
        with sqlite3.connect(path) as connection:
          self.assertEqual(connection.execute("SELECT value FROM records").fetchone()[0], "Preserved record")
          self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")

  def test_socket_refuses_regular_file_and_an_existing_live_listener(self):
    with tempfile.TemporaryDirectory() as name:
      root = Path(name)
      path = root / "http.sock"
      path.write_text("Preserve existing file")
      handler = make_handler(Database(root / "db.sqlite3", seed_samples=False))
      with self.assertRaises(FileExistsError):
        unix_server(path, handler)
      self.assertEqual(path.read_text(), "Preserve existing file")
      path.unlink()
      with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
        listener.bind(str(path))
        listener.listen(1)
        with self.assertRaises(FileExistsError):
          unix_server(path, handler)


class SupervisorIntegrationTests(unittest.TestCase):
  def test_real_app_switch_backup_and_failed_release_rollback_preserve_data(self):
    with tempfile.TemporaryDirectory() as name:
      root = Path(name)
      source = Path(__file__).resolve().parent.parent
      for sha in ["a" * 40, "b" * 40, "c" * 40]:
        release = root / "releases" / sha
        shutil.copytree(source / "mygantt", release / "mygantt", ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copytree(source / "web", release / "web")
        atomic_json(release / ".mygantt-release.json", {"sha": sha, "ci_run_id": 1})
      (root / "releases" / ("c" * 40) / "mygantt/server.py").write_text("raise RuntimeError('Intentional temporary release failure')\n")
      probe = socket.socket()
      probe.bind(("127.0.0.1", 0))
      port = probe.getsockname()[1]
      probe.close()
      settings = {"root": str(root), "db": str(root / "persistent/mygantt.sqlite3"), "backups": str(root / "backups"), "socket": str(root / "run/http.sock"), "status": str(root / "run/status.json"), "python": sys.executable, "port": port, "health_timeout": 3}
      supervisor = Supervisor(settings)
      base = f"http://127.0.0.1:{port}"
      try:
        supervisor.activate(root / "releases" / ("a" * 40))
        self.assertEqual(read_status(Path(settings["status"]))["state"], "healthy")
        with urlopen(base + "/api/state", timeout=2) as response:
          self.assertEqual(json.load(response)["projects"], [])
        self.assertEqual(Path(settings["socket"]).stat().st_mode & 0o777, 0o600)
        self.assertEqual(Path(settings["socket"]).stat().st_uid, os.getuid())
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
          client.settimeout(2)
          client.connect(settings["socket"])
          client.sendall(b"GET /api/state HTTP/1.0\r\nHost: localhost\r\n\r\n")
          response = b""
          while block := client.recv(4096):
            response += block
          self.assertEqual(json.loads(response.split(b"\r\n\r\n", 1)[1])["templates"], [])
        request = Request(base + "/api/templates", data=json.dumps({"name": "Temporary persistence check", "tasks": [{"key": "build", "name": "Build", "duration_value": 1, "duration_unit": "days", "dependencies": []}]}).encode(), headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=2) as response:
          saved = json.load(response)
        supervisor.activate(root / "releases" / ("b" * 40))
        self.assertEqual(len(list((root / "backups").glob("*.sqlite3"))), 1)
        supervisor.activate(root / "releases" / ("c" * 40))
        status = read_status(Path(settings["status"]))
        self.assertEqual(status["state"], "rollback")
        self.assertEqual(status["active_sha"], "b" * 40)
        with urlopen(base + "/api/state", timeout=2) as response:
          self.assertEqual(json.load(response)["templates"][0]["id"], saved["id"])
        self.assertEqual(len(list((root / "backups").glob("*.sqlite3"))), 2)
      finally:
        supervisor.stop_child()


if __name__ == "__main__":
  unittest.main()
