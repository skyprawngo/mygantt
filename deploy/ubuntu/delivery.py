"""Fixed, unprivileged host delivery helpers. No credentials or root commands."""

from __future__ import annotations

import io
import json
import os
import re
import sqlite3
import tarfile
import tempfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from urllib.request import Request, urlopen


REPOSITORY = "skyprawngo/mygantt"
REPOSITORY_URL = f"https://github.com/{REPOSITORY}.git"
WORKFLOW_ID = 373631820
SHA_PATTERN = re.compile(r"^[0-9a-f]{40}$")
DEFAULT_CONFIG = {
  "root": "/srv/mygantt",
  "db": "/var/lib/mygantt/mygantt.sqlite3",
  "backups": "/var/lib/mygantt/backups",
  "socket": "/var/lib/mygantt-socket/http.sock",
  "status": "/var/lib/mygantt-delivery/status.json",
  "port": 8765,
  "python": "/usr/bin/python3",
  "node": "/usr/bin/node",
  "health_timeout": 20,
}


def config(path=None):
  if os.geteuid() == 0:
    raise RuntimeError("MyGantt delivery processes must run as an unprivileged user")
  result = dict(DEFAULT_CONFIG)
  if path:
    result.update(json.loads(Path(path).read_text()))
  for key in ("root", "db", "backups", "socket", "status", "python", "node"):
    if not Path(result[key]).is_absolute():
      raise ValueError(f"Configuration path must be absolute: {key}")
  return result


def isolation_probe(settings, *, writer):
  """Check effective namespace permissions; return booleans, never file contents."""
  import subprocess
  forbidden = ["/home", "/root", "/run/user", "/proc", "/run/docker.sock", "/run/dbus/system_bus_socket", "/run/libvirt"]
  if writer:
    forbidden += ["/var/lib/mygantt", str(Path(settings["socket"]).parent)]
  denied = {path: not os.access(path, os.R_OK | os.X_OK if Path(path).is_dir() else os.R_OK | os.W_OK) for path in forbidden}
  root_writable = os.access(settings["root"], os.W_OK)
  data_visible = os.access(settings["db"], os.R_OK)
  sudo = subprocess.run(["/usr/bin/sudo", "-n", "/usr/bin/true"], capture_output=True, timeout=5)
  result = {"uid": os.geteuid(), "forbidden_paths_denied": denied, "release_root_writable": root_writable, "database_visible": data_visible, "sudo_blocked": sudo.returncode != 0}
  if not all(denied.values()) or not result["sudo_blocked"] or root_writable != writer or writer and data_visible:
    raise RuntimeError("Service namespace permission check failed: " + json.dumps(result))
  print("Effective service isolation: " + json.dumps(result), flush=True)
  return result


def atomic_json(path: Path, value):
  path.parent.mkdir(parents=True, exist_ok=True)
  handle, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
  try:
    with os.fdopen(handle, "w") as output:
      json.dump(value, output)
      output.write("\n")
      output.flush()
      os.fsync(output.fileno())
    os.replace(name, path)
  finally:
    Path(name).unlink(missing_ok=True)


def read_status(path: Path):
  try:
    return json.loads(path.read_text())
  except (FileNotFoundError, ValueError):
    return {}


def release_at(root: Path, path: Path):
  release = path.resolve(strict=True)
  if release.parent != (root / "releases").resolve() or not SHA_PATTERN.fullmatch(release.name):
    raise ValueError("Release must be an exact commit directory beneath the fixed release root")
  metadata = json.loads((release / ".mygantt-release.json").read_text())
  if metadata.get("sha") != release.name:
    raise ValueError("Release metadata does not match its commit directory")
  if not (release / "mygantt/server.py").is_file() or not (release / "web/index.html").is_file():
    raise ValueError("Release lacks application files")
  return release, metadata


def current_release(root: Path):
  current = root / "current"
  if not current.is_symlink():
    raise ValueError("Current release must be a symlink")
  return release_at(root, current)


def switch_release(root: Path, release: Path):
  release_at(root, release)
  current = root / "current"
  if current.exists() and not current.is_symlink():
    raise ValueError("Refusing to replace a non-symlink current path")
  next_link = root / f".current.{os.getpid()}"
  try:
    next_link.symlink_to(Path("releases") / release.name)
    os.replace(next_link, current)
  finally:
    next_link.unlink(missing_ok=True)


def verified_backup(db: Path, backups: Path, previous_sha: str):
  if not db.exists():
    return None
  backups.mkdir(parents=True, exist_ok=True)
  stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
  destination = backups / f"{stamp}-{previous_sha}.sqlite3"
  source = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True)
  target = sqlite3.connect(destination)
  try:
    source.backup(target)
    if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
      raise RuntimeError("SQLite backup integrity check failed")
  except Exception:
    target.close()
    destination.unlink(missing_ok=True)
    raise
  finally:
    source.close()
    target.close()
  os.chmod(destination, 0o600)
  return destination


def qualifying_run(runs, sha):
  if not SHA_PATTERN.fullmatch(sha):
    raise ValueError("Invalid commit SHA")
  eligible = [run for run in runs if (
    run.get("head_sha") == sha
    and run.get("head_branch") == "main"
    and run.get("event") in {"push", "workflow_dispatch"}
    and run.get("workflow_id") == WORKFLOW_ID
    and run.get("head_repository", {}).get("full_name") == REPOSITORY
  )]
  if not eligible:
    return None
  latest = max(eligible, key=lambda run: (run.get("id", 0), run.get("run_attempt", 0)))
  if latest.get("status") != "completed" or latest.get("conclusion") != "success":
    return None
  return latest


def successful_ci(sha):
  url = f"https://api.github.com/repos/{REPOSITORY}/actions/workflows/{WORKFLOW_ID}/runs?branch=main&head_sha={sha}&per_page=30"
  request = Request(url, headers={"Accept": "application/vnd.github+json", "User-Agent": "MyGantt-credential-free-delivery"})
  with urlopen(request, timeout=20) as response:
    data = response.read(2_000_001)
  if len(data) > 2_000_000:
    raise ValueError("Workflow response exceeds the delivery limit")
  return qualifying_run(json.loads(data)["workflow_runs"], sha)


def extract_source(archive: bytes, destination: Path):
  if len(archive) > 20_000_000:
    raise ValueError("Source archive exceeds the delivery limit")
  with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as source:
    members = source.getmembers()
    if len(members) > 1000 or sum(member.size for member in members) > 20_000_000:
      raise ValueError("Expanded source exceeds the delivery limit")
    for member in members:
      path = PurePosixPath(member.name)
      if path.is_absolute() or ".." in path.parts or not path.parts:
        raise ValueError("Unsafe source path")
      if not (member.isfile() or member.isdir()):
        raise ValueError("Source links and special files are not accepted")
      if any(part in {".git", "data"} or part.startswith(".env") for part in path.parts):
        raise ValueError("Database/credential directory found in source")
      if path.name.endswith((".db", ".db-wal", ".db-shm", ".log")) or ".sqlite" in path.name:
        raise ValueError("Database or log file found in source")
    for member in members:
      target = destination.joinpath(*PurePosixPath(member.name).parts)
      if member.isdir():
        target.mkdir(parents=True, exist_ok=True)
      else:
        target.parent.mkdir(parents=True, exist_ok=True)
        with source.extractfile(member) as input_file, target.open("xb") as output:
          output.write(input_file.read())
        os.chmod(target, 0o644)
