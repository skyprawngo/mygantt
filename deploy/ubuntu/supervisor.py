"""Supervise an unprivileged MyGantt child; back up and check each code switch."""

from __future__ import annotations

import argparse
import json
import os
import signal
import subprocess
import threading
import time
from pathlib import Path
from urllib.request import urlopen

from delivery import atomic_json, config, current_release, isolation_probe, read_status, release_at, verified_backup


class Supervisor:
  def __init__(self, settings):
    self.settings = settings
    self.root = Path(settings["root"])
    self.status_path = Path(settings["status"])
    self.process = None
    self.active = None
    self.failed = None
    self.stop_event = threading.Event()

  def status(self, state, requested, error=None):
    atomic_json(self.status_path, {
      "state": state,
      "requested_sha": requested,
      "active_sha": self.active.name if self.active else None,
      "failed_sha": self.failed,
      "error": error,
      "updated_at": time.time(),
    })

  def stop_child(self):
    if self.process is None:
      return
    if self.process.poll() is None:
      self.process.send_signal(signal.SIGINT)
      try:
        self.process.wait(timeout=10)
      except subprocess.TimeoutExpired:
        self.process.kill()
        self.process.wait(timeout=5)
    self.process = None

  def launch(self, release):
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"}
    self.process = subprocess.Popen([
      self.settings["python"], "-m", "mygantt.server", "--host", "127.0.0.1",
      "--port", str(self.settings["port"]), "--db", self.settings["db"], "--no-seed",
      "--unix-socket", self.settings["socket"],
    ], cwd=release, env=env)
    deadline = time.monotonic() + self.settings["health_timeout"]
    while time.monotonic() < deadline and not self.stop_event.is_set():
      if self.process.poll() is not None:
        return False
      try:
        with urlopen(f"http://127.0.0.1:{self.settings['port']}/api/state", timeout=1) as response:
          state = json.load(response)
        if isinstance(state.get("templates"), list) and isinstance(state.get("projects"), list):
          return True
      except (OSError, ValueError):
        pass
      self.stop_event.wait(0.1)
    return False

  def activate(self, release):
    previous = self.active
    self.status("activating", release.name)
    self.stop_child()
    try:
      verified_backup(Path(self.settings["db"]), Path(self.settings["backups"]), previous.name if previous else "initial")
      if not self.launch(release):
        raise RuntimeError("New release did not pass the loopback health check")
    except Exception as exc:
      self.stop_child()
      self.failed = release.name
      if previous is not None and self.launch(previous):
        self.active = previous
        self.status("rollback", release.name, str(exc))
        print(f"Release {release.name} failed; previous code {previous.name} is healthy. SQLite was not reverted.", flush=True)
      else:
        self.stop_child()
        self.active = None
        self.status("failed", release.name, str(exc))
        print(f"Release {release.name} failed; no healthy previous release available.", flush=True)
      return
    self.active = release
    self.failed = None
    self.status("healthy", release.name)
    print(f"Activated {release.name}; SQLite backup/migration and loopback health check completed.", flush=True)

  def run(self):
    prior = read_status(self.status_path)
    prior_sha = prior.get("active_sha")
    if prior_sha and prior_sha != prior.get("failed_sha"):
      try:
        previous, _ = release_at(self.root, self.root / "releases" / prior_sha)
        self.activate(previous)
      except (OSError, ValueError):
        pass
    try:
      while not self.stop_event.is_set():
        try:
          release, _ = current_release(self.root)
          if release != self.active and release.name != self.failed:
            self.activate(release)
          elif self.process is not None and self.process.poll() is not None:
            raise RuntimeError("Active application process exited unexpectedly")
        except (OSError, ValueError) as exc:
          self.status("waiting", None, str(exc))
        self.stop_event.wait(0.5)
    finally:
      self.stop_child()


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument("--config")
  parser.add_argument("--verify-isolation", action="store_true")
  args = parser.parse_args()
  settings = config(args.config)
  if args.verify_isolation:
    isolation_probe(settings, writer=False)
  supervisor = Supervisor(settings)
  signal.signal(signal.SIGTERM, lambda *_: supervisor.stop_event.set())
  signal.signal(signal.SIGINT, lambda *_: supervisor.stop_event.set())
  supervisor.run()


if __name__ == "__main__":
  main()
