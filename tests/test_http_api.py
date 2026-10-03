import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen

from mygantt.database import Database
from mygantt.holiday_calendar import BUNDLED_HOLIDAYS_2026, API_SOURCE, FALLBACK_SOURCE
from mygantt.server import make_handler


class HttpApiTests(unittest.TestCase):
  def setUp(self):
    self.temp = tempfile.TemporaryDirectory()
    self.db_path = Path(self.temp.name) / "api.sqlite3"
    self.database = Database(self.db_path, holiday_fetcher=self.fetch_holidays)
    self.server = None
    self.start_server()

  @staticmethod
  def fetch_holidays(year):
    return [dict(item) for item in BUNDLED_HOLIDAYS_2026] if year == 2026 else []

  def start_server(self):
    self.server = ThreadingHTTPServer(("127.0.0.1", 0), make_handler(self.database))
    self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
    self.thread.start()
    self.base = f"http://127.0.0.1:{self.server.server_port}"

  def stop_server(self):
    self.server.shutdown()
    self.server.server_close()
    self.thread.join(timeout=2)

  def tearDown(self):
    self.stop_server()
    self.temp.cleanup()

  def call(self, path, method="GET", body=None):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    request = Request(f"{self.base}{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    with urlopen(request, timeout=3) as response:
      raw = response.read()
      content_type = response.headers.get("Content-Type", "")
      return raw.decode("utf-8") if "text/calendar" in content_type else json.loads(raw)

  def test_template_preview_instantiate_repeat_task_update_and_restart(self):
    before = self.call("/api/state")
    template = self.call("/api/templates", "POST", {"name": "소프트웨어 릴리스", "project_color": "#123456", "tasks": [
      {"key": "build", "name": "빌드", "duration_value": 1, "duration_unit": "days", "dependencies": [], "color": "#aabbcc"},
      {"key": "test", "name": "테스트", "duration_value": 2, "duration_unit": "days", "dependencies": ["build"]},
      {"key": "docs", "name": "문서 검토", "duration_value": 1, "duration_unit": "days", "dependencies": []},
      {"key": "release", "name": "배포", "duration_value": 1, "duration_unit": "days", "dependencies": ["test", "docs"]},
    ]})
    preview = self.call("/api/preview", "POST", {"tasks": [
      {"key": "left", "name": "왼쪽", "duration_value": 1, "duration_unit": "days", "dependencies": []},
      {"key": "right", "name": "오른쪽", "duration_value": 1, "duration_unit": "days", "dependencies": ["left"]},
    ], "start_date": "2026-10-05", "calendar_type": "working"})
    self.assertEqual(preview["tasks"][1]["planned_start"], "2026-10-06")

    payload = {"request_id": "submit-once", "template_id": template["id"], "name": "릴리스 01", "start_date": "2026-10-05", "calendar_type": "working"}
    project = self.call("/api/instantiate", "POST", payload)
    retry = self.call("/api/instantiate", "POST", payload)
    self.assertEqual(project["id"], retry["id"])
    self.assertEqual(project["color"], "#123456")
    self.assertEqual(project["tasks"][0]["color"], "#aabbcc")
    self.assertEqual(len(project["tasks"]), 4)
    second_payload = {**payload, "request_id": "submit-two", "name": "릴리스 02", "color": "#654321"}
    second = self.call("/api/instantiate", "POST", second_payload)
    self.assertNotEqual(project["id"], second["id"])
    self.assertEqual(second["color"], "#654321")
    self.assertNotEqual(project["tasks"][0]["id"], second["tasks"][0]["id"])
    self.assertEqual(second["tasks"][0]["color"], "#aabbcc")
    docs = next(task for task in project["tasks"] if task["template_task_key"] == "docs")
    release = next(task for task in project["tasks"] if task["template_task_key"] == "release")
    test = next(task for task in project["tasks"] if task["template_task_key"] == "test")
    expanded = self.call(f"/api/tasks/{docs['id']}", "PATCH", {"duration_value": 4, "duration_unit": "days"})
    self.assertEqual(next(task for task in expanded["tasks"] if task["id"] == release["id"])["planned_start"], "2026-10-09")
    rewired = self.call(f"/api/tasks/{release['id']}", "PATCH", {"dependencies": [test["id"]]})
    self.assertEqual(next(task for task in rewired["tasks"] if task["id"] == release["id"])["planned_start"], "2026-10-08")
    updated = self.call(f"/api/tasks/{project['tasks'][0]['id']}", "PATCH", {"status": "doing", "owner": "빌드팀", "blocker": "CI 대기"})
    self.assertEqual(updated["tasks"][0]["status"], "doing")
    self.assertEqual(updated["tasks"][0]["owner"], "빌드팀")

    # A canceled create modal sends no request, so it cannot add a batch.
    after_cancel = self.call("/api/state")
    self.assertEqual(len(after_cancel["projects"]), len(before["projects"]) + 2)
    ics = self.call("/api/export/calendar.ics")
    self.assertIn("BEGIN:VCALENDAR", ics)

    self.stop_server()
    self.start_server()
    reopened = self.call(f"/api/projects/{project['id']}")
    self.assertEqual(reopened["tasks"][0]["owner"], "빌드팀")
    reopened_release = next(task for task in reopened["tasks"] if task["template_task_key"] == "release")
    self.assertEqual(reopened_release["planned_start"], "2026-10-08")
    self.assertEqual(reopened_release["dependencies"], [test["id"]])
    reopened_second = self.call(f"/api/projects/{second['id']}")
    self.assertEqual(reopened_second["color"], "#654321")
    self.assertEqual(reopened_second["tasks"][0]["color"], "#aabbcc")

  def test_static_app_is_served(self):
    with urlopen(f"{self.base}/", timeout=3) as response:
      html = response.read().decode("utf-8")
    self.assertIn("MyGantt", html)
    self.assertIn("공정 템플릿", html)
    self.assertIn("프로젝트 속성", html)
    self.assertIn("작업 속성", html)
    self.assertIn("group-select", html)

  def test_korean_holiday_data_has_explicit_coverage_and_range_filter(self):
    payload = self.call("/api/holidays?start=2026-10-01&end=2026-10-31")
    self.assertEqual(payload["coverage_years"], [2026])
    self.assertEqual([item["date"] for item in payload["holidays"]], ["2026-10-03", "2026-10-05", "2026-10-09"])
    self.assertEqual(payload["status"], "fresh")
    self.assertEqual(payload["source"], f"{API_SOURCE} + {FALLBACK_SOURCE}")
    self.assertTrue(payload["last_updated"])
    full_year = self.call("/api/holidays?start=2026-01-01&end=2026-12-31")
    substitutes = {item["date"]: item["name"] for item in full_year["holidays"] if "대체공휴일" in item["name"]}
    self.assertEqual(substitutes, {
      "2026-03-02": "삼일절 대체공휴일",
      "2026-05-25": "부처님오신날 대체공휴일",
      "2026-08-17": "광복절 대체공휴일",
      "2026-10-05": "개천절 대체공휴일",
    })
    future = self.call("/api/holidays?start=2027-01-01&end=2027-12-31")
    self.assertEqual(future["holidays"], [])
    self.assertEqual(future["coverage_years"], [2027])


if __name__ == "__main__":
  unittest.main()
