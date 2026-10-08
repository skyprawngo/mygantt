"""Server clock metadata, separate from date-only scheduling and holiday regions."""
import os
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def server_clock():
    candidates = [os.environ.get('TZ', '').lstrip(':')]
    try:
        resolved = str(Path('/etc/localtime').resolve())
        if '/zoneinfo/' in resolved:
            candidates.append(resolved.split('/zoneinfo/', 1)[1])
    except OSError:
        pass
    try:
        candidates.append(Path('/etc/timezone').read_text().strip())
    except OSError:
        pass
    for candidate in candidates:
        if not candidate:
            continue
        try:
            zone = ZoneInfo(candidate)
        except (ValueError, ZoneInfoNotFoundError):
            continue
        now = datetime.now(zone)
        return {'time_zone': candidate, 'offset_minutes': int(now.utcoffset().total_seconds() / 60)}
    now = datetime.now().astimezone()
    return {'time_zone': None, 'offset_minutes': int(now.utcoffset().total_seconds() / 60)}
