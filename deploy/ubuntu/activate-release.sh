#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: sudo $0 CURRENT_LINK RELEASE_DIR SERVICE.service [LOCAL_HEALTH_URL]" >&2
  echo "Example: sudo $0 /srv/mygantt/current /srv/mygantt/releases/COMMIT mygantt.service" >&2
}

if [[ $# -lt 3 || $# -gt 4 ]]; then
  usage
  exit 2
fi

if (( EUID != 0 )); then
  echo "Run this host-side activation helper with sudo." >&2
  exit 1
fi

current_link=$1
release_input=$2
service_name=$3
health_url=${4:-http://127.0.0.1:8765/api/state}

if [[ "$current_link" != /* ]]; then
  echo "CURRENT_LINK must be an absolute path." >&2
  exit 2
fi
if [[ ! "$service_name" =~ ^[-A-Za-z0-9_@.]+\.service$ ]]; then
  echo "SERVICE must be a valid systemd service name ending in .service." >&2
  exit 2
fi
if [[ ! "$health_url" =~ ^http://(127\.0\.0\.1|localhost|\[::1\]):[0-9]{1,5}/ ]]; then
  echo "LOCAL_HEALTH_URL must use HTTP on loopback." >&2
  exit 2
fi

command -v systemctl >/dev/null || { echo "systemctl is required." >&2; exit 1; }
command -v curl >/dev/null || { echo "curl is required for the local health check." >&2; exit 1; }
command -v realpath >/dev/null || { echo "realpath is required." >&2; exit 1; }

release_dir=$(realpath -e -- "$release_input")
if [[ ! -f "$release_dir/mygantt/server.py" || ! -f "$release_dir/web/index.html" ]]; then
  echo "RELEASE_DIR must contain mygantt/server.py and web/index.html." >&2
  exit 1
fi
if compgen -G "$release_dir/data/*.sqlite3*" >/dev/null; then
  echo "A SQLite database or backup is present in RELEASE_DIR; refusing activation." >&2
  exit 1
fi

current_parent=$(realpath -e -- "$(dirname -- "$current_link")")
current_link="$current_parent/$(basename -- "$current_link")"
if [[ -e "$current_link" && ! -L "$current_link" ]]; then
  echo "CURRENT_LINK exists and is not a symlink; refusing to replace it." >&2
  exit 1
fi
if [[ "$current_link" == "$release_dir" ]]; then
  echo "CURRENT_LINK must be separate from RELEASE_DIR." >&2
  exit 1
fi

previous_release=""
if [[ -L "$current_link" ]]; then
  previous_release=$(realpath -e -- "$current_link" 2>/dev/null || true)
fi

next_link="$current_link.next.$$"
rollback_link="$current_link.rollback.$$"
cleanup() {
  rm -f -- "$next_link" "$rollback_link"
}
trap cleanup EXIT

ln -s -- "$release_dir" "$next_link"
mv -Tf -- "$next_link" "$current_link"

rollback() {
  if [[ -n "$previous_release" && -d "$previous_release" ]]; then
    ln -s -- "$previous_release" "$rollback_link"
    mv -Tf -- "$rollback_link" "$current_link"
    if ! systemctl restart "$service_name"; then
      echo "Warning: previous release was restored, but its service restart failed." >&2
      return 1
    fi
    echo "Previous release restored; persistent database contents were left unchanged." >&2
  else
    rm -f -- "$current_link"
    systemctl stop "$service_name" || true
    echo "No prior release was available; the new current link was removed." >&2
  fi
}

if ! systemctl restart "$service_name"; then
  echo "Service restart failed; attempting release rollback." >&2
  rollback || true
  exit 1
fi

healthy=0
for ((attempt = 1; attempt <= 20; attempt++)); do
  if curl --fail --silent --show-error --max-time 2 "$health_url" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done

if (( healthy == 1 )); then
  echo "Activated $release_dir; local health check passed."
  exit 0
fi

echo "Local health check failed; attempting release rollback." >&2
rollback || true
exit 1
