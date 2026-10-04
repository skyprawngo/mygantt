import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from mygantt.database import Database
from mygantt.holiday_calendar import API_SOURCE, FALLBACK_SOURCE, FALLBACK_SOURCE_URL, normalize_provider_year


class HolidayCalendarTests(unittest.TestCase):
  def setUp(self):
    self.temp = tempfile.TemporaryDirectory()
    self.path = Path(self.temp.name) / "holidays.sqlite3"
    self.now = datetime(2026, 10, 1, 9, 30, tzinfo=timezone.utc)

  def tearDown(self):
    self.temp.cleanup()

  def test_provider_parser_keeps_countrywide_public_dates_and_handles_iso_timestamp(self):
    payload = normalize_provider_year(2026, [
      {"date": "2026-01-01", "name": "New Year's Day", "countryCode": "KR", "holidayTypes": ["Public"]},
      {"date": "2026-03-01T00:00:00", "name": "Independence Movement Day", "countryCode": "KR", "holidayTypes": ["Public"]},
      {"date": "2026-03-02", "name": "School Day", "countryCode": "KR", "holidayTypes": ["School"]},
      {"date": "2026-04-01", "name": "Regional Holiday", "countryCode": "KR", "holidayTypes": ["Public"], "subdivisionCodes": ["KR-11"]},
      {"date": "2027-01-01", "name": "Wrong year", "countryCode": "KR", "holidayTypes": ["Public"]},
      {"date": "2026-05-01", "name": "Foreign Holiday", "countryCode": "JP", "holidayTypes": ["Public"]},
    ])
    self.assertEqual(payload, [
      {"date": "2026-01-01", "name": "신정"},
      {"date": "2026-03-01", "name": "삼일절"},
    ])
    with self.assertRaisesRegex(ValueError, "list"):
      normalize_provider_year(2026, {"date": "2026-01-01"})

  def test_failed_refresh_serves_persistent_stale_fallback_with_failure_metadata(self):
    calls = []

    def offline(year):
      calls.append(year)
      raise OSError("provider offline")

    first_db = Database(self.path, holiday_fetcher=offline)
    first = first_db.holidays("2026-01-01", "2026-12-31", now=self.now)
    self.assertEqual(first["status"], "stale")
    self.assertEqual(first["source"], FALLBACK_SOURCE)
    self.assertEqual(first["coverage_years"], [2026])
    self.assertIsNone(first["last_updated"])
    self.assertIn("provider offline", first["last_error"])
    self.assertEqual(len(first["holidays"]), 22)
    self.assertEqual(calls, [2026])

    reopened = Database(self.path, holiday_fetcher=offline)
    after_restart = reopened.holidays("2026-01-01", "2026-12-31", now=self.now + timedelta(hours=1))
    self.assertEqual(after_restart["status"], "stale")
    self.assertEqual(after_restart["holidays"], first["holidays"])
    self.assertEqual(calls, [2026], "persistent retry cooldown avoids repeat outage requests")

  def test_refreshes_two_years_at_boundary_and_reuses_fresh_cache(self):
    calls = []

    def fetcher(year):
      calls.append(year)
      return [
        {"date": f"{year}-01-01", "name": "New Year's Day"},
        {"date": f"{year}-12-31", "name": "Year End"},
      ]

    database = Database(self.path, holiday_fetcher=fetcher)
    result = database.holidays("2026-12-31", "2027-01-01", now=datetime(2026, 12, 30, tzinfo=timezone.utc))
    self.assertEqual(calls, [2026, 2027])
    self.assertEqual(result["status"], "fresh")
    self.assertEqual(result["source"], f"{API_SOURCE} + {FALLBACK_SOURCE}")
    self.assertEqual(result["coverage_years"], [2026, 2027])
    self.assertEqual([item["date"] for item in result["holidays"]], ["2026-12-31", "2027-01-01"])

    again = database.holidays("2026-12-31", "2027-01-01", now=datetime(2026, 12, 31, tzinfo=timezone.utc))
    self.assertEqual(again["status"], "fresh")
    self.assertEqual(calls, [2026, 2027])

  def test_live_2026_data_keeps_verified_substitute_holiday_overlay(self):
    database = Database(self.path, holiday_fetcher=lambda year: [
      {"date": "2026-03-01", "name": "Independence Movement Day"},
      {"date": "2026-10-03", "name": "National Foundation Day"},
      {"date": "2026-10-09", "name": "Hangul Day"},
    ])
    result = database.holidays("2026-01-01", "2026-12-31", now=self.now)
    substitute_dates = {item["date"] for item in result["holidays"] if "대체공휴일" in item["name"]}
    self.assertEqual(substitute_dates, {"2026-03-02", "2026-05-25", "2026-08-17", "2026-10-05"})
    self.assertEqual(result["source"], f"{API_SOURCE} + {FALLBACK_SOURCE}")
    self.assertIn(FALLBACK_SOURCE_URL, result["source_urls"])

  def test_year_beyond_documented_coverage_is_reported_without_fetch(self):
    calls = []
    database = Database(self.path, holiday_fetcher=lambda year: calls.append(year) or [])
    result = database.holidays("2032-01-01", "2032-12-31", now=self.now)
    self.assertEqual(result["status"], "unavailable")
    self.assertEqual(result["coverage_years"], [])
    self.assertEqual(result["unsupported_years"], [2032])
    self.assertEqual(calls, [])

  def test_country_caches_are_isolated_and_selection_persists(self):
    calls = []
    def fetch(year, country="KR"):
      calls.append((country, year))
      return [{"date": f"{year}-07-04", "name": country}]
    db = Database(self.path, holiday_fetcher=fetch, seed_samples=False)
    kr = db.holidays("2026-01-01", "2026-12-31", now=self.now)
    db.set_holiday_country("US")
    us = db.holidays("2026-01-01", "2026-12-31", now=self.now)
    self.assertEqual(us["region"], "US")
    self.assertEqual(us["holidays"], [{"date":"2026-07-04", "name":"US"}])
    self.assertNotIn(FALLBACK_SOURCE, us["source"])
    self.assertGreater(len(kr["holidays"]), 1)
    restarted = Database(self.path, holiday_fetcher=fetch, seed_samples=False)
    self.assertEqual(restarted.holiday_country(), "US")
    restarted.holidays("2026-01-01", "2026-12-31", now=self.now)
    self.assertEqual(calls, [("KR",2026),("US",2026)])
    with self.assertRaises(ValueError): db.set_holiday_country("INVALID")
    self.assertEqual(db.holiday_country(), "US")

  def test_foreign_failure_never_uses_korean_fallback(self):
    def offline(year, country="KR"): raise OSError("offline")
    db = Database(self.path, holiday_fetcher=offline, seed_samples=False)
    result = db.holidays("2026-01-01", "2026-12-31", country="JP", now=self.now)
    self.assertEqual(result["status"], "unavailable")
    self.assertEqual(result["holidays"], [])
    self.assertNotIn(FALLBACK_SOURCE, result["source"])

  def test_old_cache_migrates_without_losing_dates(self):
    import sqlite3
    with sqlite3.connect(self.path) as conn:
      conn.execute("CREATE TABLE holiday_cache (year INTEGER PRIMARY KEY, source TEXT NOT NULL, source_url TEXT, attempted_at TEXT, last_success_at TEXT, last_error TEXT, holidays_json TEXT)")
      conn.execute("INSERT INTO holiday_cache VALUES (2027,'old','url','','','','[]')")
    db = Database(self.path, seed_samples=False)
    with db.connection() as conn:
      row = conn.execute("SELECT * FROM holiday_cache WHERE year=2027").fetchone()
      self.assertEqual(row["country"], "KR")
      self.assertEqual(row["source"], "old")

  def test_new_schedule_uses_selected_country_without_editing_existing_projects(self):
    db = Database(self.path, holiday_fetcher=lambda year, country="KR": [{"date":f"{year}-10-05", "name":"Test holiday"}] if country=="US" else [], seed_samples=False)
    db.set_holiday_country("US")
    tasks = [{"id":"a", "key":"a", "name":"A", "duration_value":1, "duration_unit":"days", "dependencies":[]}]
    result = db.schedule_template(tasks,"2026-10-05","working")
    self.assertEqual(result[0]["planned_start"], "2026-10-06")

  def test_foreign_names_and_national_filter(self):
    result = normalize_provider_year(2026, [
      {"date":"2026-01-01", "countryCode":"US", "name":"New Year's Day", "holidayTypes":["Public"]},
      {"date":"2026-01-02", "countryCode":"US", "name":"Regional", "nationalHoliday":False, "holidayTypes":["Public"]},
    ], "US")
    self.assertEqual(result, [{"date":"2026-01-01", "name":"New Year's Day"}])


if __name__ == "__main__":
  unittest.main()
