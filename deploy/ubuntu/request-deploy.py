#!/usr/bin/python3
"""Request the same restricted deployment service without sudo or credentials."""

import argparse
import json
import os
import time
import uuid
from pathlib import Path

from delivery import atomic_json, read_status


def request_deploy(root):
  if os.geteuid() == 0:
    raise RuntimeError("Run manual deployment as the existing unprivileged service user")
  if not root.is_dir():
    raise RuntimeError("Reviewed host deployment is not installed at the requested path")
  request_id = str(uuid.uuid4())
  atomic_json(root / "manual-deploy.request", {"request_id": request_id, "requested_at": time.time()})
  return request_id


def wait_for_result(root, request_id, timeout):
  deadline = time.monotonic() + timeout
  while time.monotonic() < deadline:
    result = read_status(root / "manual-deploy.result.json")
    if result.get("request_id") == request_id:
      return result
    time.sleep(0.2)
  raise TimeoutError("No completed matching deployment result; check mygantt-deploy.path and mygantt-deploy.service")


def main():
  parser = argparse.ArgumentParser(description=__doc__)
  parser.add_argument("--root", type=Path, default=Path("/srv/mygantt"))
  parser.add_argument("--wait", action="store_true", help="Wait for the service's CI/deployment result")
  parser.add_argument("--timeout", type=float, default=610)
  args = parser.parse_args()
  request_id = request_deploy(args.root)
  print(f"Requested CI-gated deployment: {request_id}", flush=True)
  if args.wait:
    result = wait_for_result(args.root, request_id, args.timeout)
    print(json.dumps(result), flush=True)
    raise SystemExit(0 if result["result"] in {"deployed", "unchanged"} else 3)


if __name__ == "__main__":
  main()
