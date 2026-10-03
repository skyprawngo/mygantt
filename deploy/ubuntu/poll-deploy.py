"""Deliver only the public main commit with successful trusted GitHub-hosted CI."""

from __future__ import annotations

import argparse
import fcntl
import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from delivery import REPOSITORY_URL, SHA_PATTERN, atomic_json, config, current_release, extract_source, isolation_probe, read_status, release_at, successful_ci, switch_release


def git(settings, *args, cwd=None, binary=False):
  env = {
    **os.environ, "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_COUNT": "0",
  }
  result = subprocess.run([
    "/usr/bin/git", "-c", "credential.helper=", "-c", "core.hooksPath=/dev/null",
    "-c", "protocol.file.allow=never", *args,
  ], cwd=cwd, env=env, capture_output=True, timeout=90)
  if result.returncode:
    raise RuntimeError("Public Git source operation failed")
  return result.stdout if binary else result.stdout.decode().strip()


def main_sha(settings):
  value = git(settings, "ls-remote", "--exit-code", REPOSITORY_URL, "refs/heads/main").split()
  if len(value) != 2 or value[1] != "refs/heads/main" or not SHA_PATTERN.fullmatch(value[0]):
    raise ValueError("Unexpected public main reference")
  return value[0]


def prepare(settings, sha, run):
  root = Path(settings["root"])
  release = root / "releases" / sha
  if release.exists():
    release_at(root, release)
    return release
  cache = root / "source-cache.git"
  if not cache.exists():
    git(settings, "init", "--bare", str(cache))
  git(settings, "fetch", "--depth=1", REPOSITORY_URL, "refs/heads/main", cwd=cache)
  if git(settings, "rev-parse", "FETCH_HEAD", cwd=cache) != sha:
    raise RuntimeError("Main changed while preparing this release; activation postponed")
  archive = git(settings, "archive", "--format=tar", sha, cwd=cache, binary=True)
  release.parent.mkdir(parents=True, exist_ok=True)
  with tempfile.TemporaryDirectory(prefix=".staging-", dir=root) as name:
    staging = Path(name)
    extract_source(archive, staging)
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    checks = [
      [settings["python"], "-m", "unittest", "discover", "-s", "tests", "-v"],
      [settings["python"], "-m", "compileall", "-q", "mygantt", "tests", "deploy/ubuntu"],
      [settings["node"], "--check", "web/app.js"],
    ]
    for command in checks:
      subprocess.run(command, cwd=staging, env=env, check=True, timeout=300)
    for path in staging.rglob("__pycache__"):
      shutil.rmtree(path)
    atomic_json(staging / ".mygantt-release.json", {"sha": sha, "ci_run_id": run["id"]})
    os.chmod(staging, 0o755)
    os.replace(staging, release)
  return release


def deliver(settings):
  root = Path(settings["root"])
  root.mkdir(parents=True, exist_ok=True)
  with (root / ".delivery.lock").open("a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    sha = main_sha(settings)
    status = read_status(Path(settings["status"]))
    if status.get("active_sha") == sha and status.get("state") == "healthy":
      print(f"Current main {sha} is already healthy.")
      return
    if status.get("failed_sha") == sha:
      print(f"Main {sha} already failed activation; waiting for a new main commit or operator repair.")
      return
    run = successful_ci(sha)
    if run is None:
      print(f"Main {sha} has no completed successful push/main-dispatch CI run; keeping the active release.")
      return
    release = prepare(settings, sha, run)
    if main_sha(settings) != sha:
      print("Main changed after local tests; keeping the active release until the next poll.")
      return
    try:
      previous, _ = current_release(root)
    except (OSError, ValueError):
      previous = None
    switch_release(root, release)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
      status = read_status(Path(settings["status"]))
      if status.get("requested_sha") == sha:
        if status.get("active_sha") == sha and status.get("state") == "healthy":
          print(f"Delivered tested main {sha}; GitHub CI run {run['id']}; app health verified.")
          return
        if status.get("state") in {"failed", "rollback"}:
          break
      time.sleep(0.5)
    if previous:
      switch_release(root, previous)
    raise RuntimeError("Activation did not become healthy; previous current symlink restored when available")


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument("--config")
  parser.add_argument("--verify-isolation", action="store_true")
  args = parser.parse_args()
  settings = config(args.config)
  if args.verify_isolation:
    isolation_probe(settings, writer=True)
  deliver(settings)


if __name__ == "__main__":
  main()
