"""Cached Korean public holiday data for the Gantt date header.

The Nager.Date Community API is refreshed by year. Only the country code and
year are sent to that provider; project or task data is never included. The
2026 bundled calendar is a clearly identified offline fallback, verified
against KASI and Korea Customs Service public calendar listings.
"""

from __future__ import annotations

import json
import ssl
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable
from urllib.request import Request, urlopen


API_URL = "https://nagerholidays.com/api/v4/Holidays/KR/{year}"
API_SOURCE = "Nager.Date Community API v4"
API_SOURCE_URL = "https://nagerholidays.com/api"
FALLBACK_SOURCE = "KASI / 관세청 2026 기본 자료"
FALLBACK_SOURCE_URL = "https://www.customs.go.kr/engportal/cm/cntnts/cntntsView.do?cntntsId=7401&mi=13284"
SUPPORTED_FUTURE_YEARS = 5
CACHE_TTL = timedelta(days=7)
RETRY_COOLDOWN = timedelta(hours=6)
REQUEST_TIMEOUT_SECONDS = 4

BUNDLED_HOLIDAYS_2026 = [
  {"date": "2026-01-01", "name": "신정"},
  {"date": "2026-02-16", "name": "설날 연휴"},
  {"date": "2026-02-17", "name": "설날"},
  {"date": "2026-02-18", "name": "설날 연휴"},
  {"date": "2026-03-01", "name": "삼일절"},
  {"date": "2026-03-02", "name": "삼일절 대체공휴일"},
  {"date": "2026-05-01", "name": "노동절"},
  {"date": "2026-05-05", "name": "어린이날"},
  {"date": "2026-05-24", "name": "부처님오신날"},
  {"date": "2026-05-25", "name": "부처님오신날 대체공휴일"},
  {"date": "2026-06-03", "name": "전국동시지방선거일"},
  {"date": "2026-06-06", "name": "현충일"},
  {"date": "2026-07-17", "name": "제헌절"},
  {"date": "2026-08-15", "name": "광복절"},
  {"date": "2026-08-17", "name": "광복절 대체공휴일"},
  {"date": "2026-09-24", "name": "추석 연휴"},
  {"date": "2026-09-25", "name": "추석"},
  {"date": "2026-09-26", "name": "추석 연휴"},
  {"date": "2026-10-03", "name": "개천절"},
  {"date": "2026-10-05", "name": "개천절 대체공휴일"},
  {"date": "2026-10-09", "name": "한글날"},
  {"date": "2026-12-25", "name": "성탄절"},
]

KOREAN_NAMES = {
  "New Year's Day": "신정",
  "New Year's Eve": "연말",
  "Seollal": "설날",
  "Seollal Holiday": "설날 연휴",
  "Independence Movement Day": "삼일절",
  "Labor Day": "노동절",
  "Children's Day": "어린이날",
  "Buddha's Birthday": "부처님오신날",
  "Memorial Day": "현충일",
  "Constitution Day": "제헌절",
  "Liberation Day": "광복절",
  "Chuseok": "추석",
  "Chuseok Holiday": "추석 연휴",
  "National Foundation Day": "개천절",
  "Hangul Day": "한글날",
  "Christmas Day": "성탄절",
  "Election Day": "선거일",
  "Temporary Public Holiday": "임시공휴일",
}


def _parse_provider_date(value: Any) -> date:
  raw = str(value or "").strip()
  if not raw:
    raise ValueError("Holiday date is empty")
  # The provider normally sends YYYY-MM-DD; accepting ISO timestamps makes
  # the cache tolerant of a future response-format extension.
  try:
    return date.fromisoformat(raw[:10])
  except ValueError as error:
    raise ValueError(f"Invalid holiday date: {raw[:40]}") from error


def normalize_provider_year(year: int, payload: Any) -> list[dict[str, str]]:
  if not isinstance(payload, list):
    raise ValueError("Holiday API response must be a list")
  normalized: dict[str, str] = {}
  for item in payload:
    if not isinstance(item, dict):
      continue
    if str(item.get("countryCode", "KR")).upper() != "KR":
      continue
    subdivisions = item.get("subdivisionCodes") or []
    if subdivisions:
      continue
    holiday_types = item.get("holidayTypes") or []
    if isinstance(holiday_types, str):
      holiday_types = [holiday_types]
    if "Public" not in holiday_types:
      continue
    holiday_date = _parse_provider_date(item.get("date"))
    if holiday_date.year != year:
      continue
    name = str(item.get("localName") or KOREAN_NAMES.get(str(item.get("name", "")), item.get("name", "공휴일"))).strip()
    if name:
      normalized[holiday_date.isoformat()] = name
  return [{"date": key, "name": normalized[key]} for key in sorted(normalized)]


def fetch_public_holidays(year: int) -> list[dict[str, str]]:
  """Fetch one public year from Nager.Date without sending app data."""
  request = Request(
    API_URL.format(year=year),
    headers={"Accept": "application/json", "User-Agent": "MyGantt-local/1.0"},
    method="GET",
  )
  try:
    import certifi
    ssl_context = ssl.create_default_context(cafile=certifi.where())
  except ImportError:
    ssl_context = ssl.create_default_context()
  with urlopen(request, timeout=REQUEST_TIMEOUT_SECONDS, context=ssl_context) as response:
    payload = json.loads(response.read().decode("utf-8"))
  return normalize_provider_year(year, payload)


def _iso(value: datetime) -> str:
  if value.tzinfo is None:
    value = value.replace(tzinfo=timezone.utc)
  return value.astimezone(timezone.utc).isoformat(timespec="seconds")


def _parse_stamp(value: str | None) -> datetime | None:
  if not value:
    return None
  try:
    parsed = datetime.fromisoformat(value)
  except ValueError:
    return None
  return parsed.replace(tzinfo=timezone.utc) if parsed.tzinfo is None else parsed.astimezone(timezone.utc)


def _range_dates(start: str | None, end: str | None, today: date) -> tuple[date, date]:
  start_date = date.fromisoformat(start) if start else today
  end_date = date.fromisoformat(end) if end else today.replace(month=12, day=31)
  if end_date < start_date:
    raise ValueError("Holiday calendar end date must not be before its start date")
  if (end_date - start_date).days > 3660:
    raise ValueError("Holiday calendar range cannot exceed ten years")
  return start_date, end_date


def calendar_payload(
  database: Any,
  start: str | None = None,
  end: str | None = None,
  *,
  now: datetime | None = None,
  fetcher: Callable[[int], list[dict[str, str]]] | None = None,
) -> dict[str, Any]:
  """Refresh requested years as needed, return cached data and honest status."""
  current = now or datetime.now(timezone.utc)
  if current.tzinfo is None:
    current = current.replace(tzinfo=timezone.utc)
  current = current.astimezone(timezone.utc)
  start_date, end_date = _range_dates(start, end, current.date())
  years = list(range(start_date.year, end_date.year + 1))
  active_fetcher = fetcher or database.holiday_fetcher
  supported_first = current.year
  supported_last = current.year + SUPPORTED_FUTURE_YEARS
  available_entries: dict[int, dict[str, Any]] = {}

  # Serializing refreshes prevents concurrent page requests from issuing
  # duplicate requests for the same year.
  with database.holiday_lock:
    for year in years:
      with database.connection() as connection:
        row = connection.execute("SELECT * FROM holiday_cache WHERE year=?", (year,)).fetchone()
        cached = dict(row) if row else None
      is_supported = supported_first <= year <= supported_last
      attempted = _parse_stamp(cached.get("attempted_at") if cached else None)
      last_success = _parse_stamp(cached.get("last_success_at") if cached else None)
      cache_is_fresh = bool(last_success and current - last_success < CACHE_TTL and not (cached or {}).get("last_error"))
      retry_cooling = bool(attempted and current - attempted < RETRY_COOLDOWN)
      should_refresh = is_supported and not cache_is_fresh and not retry_cooling

      if should_refresh:
        fetched_at = _iso(current)
        try:
          holidays = active_fetcher(year)
          # Revalidate injected and future provider implementations before
          # persisting data. The helper expects the same canonical shape.
          canonical = []
          for item in holidays:
            holiday_date = _parse_provider_date(item.get("date"))
            if holiday_date.year == year and str(item.get("name", "")).strip():
              canonical.append({"date": holiday_date.isoformat(), "name": str(item["name"]).strip()})
          canonical.sort(key=lambda item: item["date"])
          with database.connection() as connection:
            connection.execute(
              """INSERT INTO holiday_cache (year, source, source_url, attempted_at, last_success_at, last_error, holidays_json)
                 VALUES (?, ?, ?, ?, ?, '', ?)
                 ON CONFLICT(year) DO UPDATE SET source=excluded.source, source_url=excluded.source_url,
                   attempted_at=excluded.attempted_at, last_success_at=excluded.last_success_at,
                   last_error='', holidays_json=excluded.holidays_json""",
              (year, API_SOURCE, API_SOURCE_URL, fetched_at, fetched_at, json.dumps(canonical, ensure_ascii=False)),
            )
          cached = {"year": year, "source": API_SOURCE, "source_url": API_SOURCE_URL, "attempted_at": fetched_at, "last_success_at": fetched_at, "last_error": "", "holidays_json": json.dumps(canonical, ensure_ascii=False)}
        except Exception as error:
          message = str(error).strip() or error.__class__.__name__
          with database.connection() as connection:
            if cached:
              connection.execute("UPDATE holiday_cache SET attempted_at=?, last_error=? WHERE year=?", (fetched_at, message[:300], year))
            else:
              connection.execute(
                "INSERT INTO holiday_cache (year, source, source_url, attempted_at, last_success_at, last_error, holidays_json) VALUES (?, ?, ?, ?, '', ?, '[]')",
                (year, API_SOURCE, API_SOURCE_URL, fetched_at, message[:300]),
              )
          if cached:
            cached["attempted_at"] = fetched_at
            cached["last_error"] = message[:300]
          else:
            cached = {"year": year, "source": API_SOURCE, "source_url": API_SOURCE_URL, "attempted_at": fetched_at, "last_success_at": "", "last_error": message[:300], "holidays_json": "[]"}

      if cached:
        try:
          cached["holidays"] = json.loads(cached.get("holidays_json") or "[]")
        except (TypeError, json.JSONDecodeError):
          cached["holidays"] = []
        if year == 2026 and cached.get("source") == API_SOURCE:
          # The community feed currently omits several Korean substitute
          # holidays. Keep its fresh dates, then overlay the checked 2026
          # calendar so provider refreshes cannot remove those known dates.
          merged = {item["date"]: item for item in cached["holidays"] if item.get("date")}
          merged.update({item["date"]: item for item in BUNDLED_HOLIDAYS_2026})
          cached["holidays"] = [merged[key] for key in sorted(merged)]
        cached["last_success"] = _parse_stamp(cached.get("last_success_at"))
        cached["is_supported"] = is_supported
        available_entries[year] = cached

  covered_years = [year for year, item in available_entries.items() if item.get("last_success") or item.get("holidays")]
  requested_all_covered = len(covered_years) == len(years)
  fresh = requested_all_covered and all(
    item.get("is_supported") and item.get("last_success") and not item.get("last_error") and current - item["last_success"] < CACHE_TTL
    for item in available_entries.values()
  )
  any_available = bool(covered_years)
  status = "fresh" if fresh else "stale" if any_available else "unavailable"
  source_names = []
  source_urls = []
  for year, item in available_entries.items():
    if item.get("source"):
      source_names.append(item["source"])
      source_urls.append(item.get("source_url") or "")
      if year == 2026 and item["source"] == API_SOURCE:
        source_names.append(FALLBACK_SOURCE)
        source_urls.append(FALLBACK_SOURCE_URL)
  source_names = list(dict.fromkeys(name for name in source_names if name))
  source_urls = list(dict.fromkeys(url for url in source_urls if url))
  last_updates = [item["last_success"] for item in available_entries.values() if item.get("last_success")]
  last_updated = _iso(max(last_updates)) if last_updates else None
  holidays = []
  for item in available_entries.values():
    holidays.extend(item.get("holidays", []))
  holidays = [item for item in holidays if start_date.isoformat() <= item["date"] <= end_date.isoformat()]
  holidays.sort(key=lambda item: item["date"])
  errors = [f"{year}: {item['last_error']}" for year, item in available_entries.items() if item.get("last_error")]
  unsupported = [year for year in years if not (supported_first <= year <= supported_last)]
  coverage_start = min(covered_years) if covered_years else None
  coverage_end = max(covered_years) if covered_years else None
  source = " + ".join(source_names) if source_names else API_SOURCE
  return {
    "region": "KR",
    "source": source,
    "source_label": source,
    "source_url": source_urls[0] if len(source_urls) == 1 else API_SOURCE_URL,
    "source_urls": source_urls,
    "last_updated": last_updated,
    "coverage_years": covered_years,
    "requested_years": years,
    "supported_years": {"from": supported_first, "through": supported_last},
    "status": status,
    "last_error": "; ".join(errors) or None,
    "unsupported_years": unsupported,
    "coverage_label": f"공휴일 자료 · {source} · 갱신 {last_updated[:10] if last_updated else '기록 없음'} · 범위 {', '.join(map(str, covered_years)) if covered_years else '자료 없음'}",
    "holidays": holidays,
  }
