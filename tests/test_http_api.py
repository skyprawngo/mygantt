import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.request import Request, urlopen
from unittest.mock import patch
from types import SimpleNamespace

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

  def test_country_calendar_settings_and_holiday_query(self):
    from urllib.error import HTTPError
    options = self.call('/api/holiday-calendars')
    self.assertEqual(options['holiday_country'], 'KR')
    self.assertIn('JP', [item['country'] for item in options['calendars']])
    before = self.call('/api/state')['projects']
    self.call('/api/settings/holiday-calendar', 'PATCH', {'holiday_country':'JP'})
    self.database.holiday_fetcher = lambda year, country='KR': [{'date':f'{year}-01-01','name':country}]
    result = self.call('/api/holidays?start=2026-01-01&end=2026-12-31')
    self.assertEqual(result['region'], 'JP')
    self.assertEqual(result['holidays'], [{'date':'2026-01-01','name':'JP'}])
    self.assertEqual(self.call('/api/state')['projects'], before)
    with self.assertRaises(HTTPError) as error:
      self.call('/api/settings/holiday-calendar', 'PATCH', {'holiday_country':'XX'})
    self.assertEqual(error.exception.code, 400)

  def test_delete_template_preserves_instantiated_projects(self):
    from urllib.error import HTTPError
    before = self.call('/api/state')
    template_id = before['templates'][0]['id']
    self.assertEqual(self.call('/api/templates/' + template_id, 'DELETE'), {'deleted': True})
    after = self.call('/api/state')
    self.assertFalse(any(item['id'] == template_id for item in after['templates']))
    self.assertEqual(before['projects'], after['projects'])
    reopened = Database(self.db_path, holiday_fetcher=lambda year: [])
    self.assertEqual(reopened.state()['templates'], after['templates'])
    with self.database.connection() as db:
      self.assertEqual(db.execute('SELECT count(*) FROM template_tasks WHERE template_id=?', (template_id,)).fetchone()[0], 0)
      self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
    with self.assertRaises(HTTPError) as error:
      self.call('/api/templates/' + template_id, 'DELETE')
    self.assertEqual(error.exception.code, 404)

  def test_empty_project_creation_and_restart(self):
    payload = {'name': 'Empty project', 'start_date': '2026-10-04', 'calendar_type': 'working', 'request_id': 'empty-http'}
    project = self.call('/api/projects', 'POST', payload)
    self.assertEqual(project['tasks'], [])
    self.assertEqual(self.call('/api/projects', 'POST', payload)['id'], project['id'])
    self.stop_server()
    self.start_server()
    self.assertEqual(self.call('/api/projects/' + project['id'])['name'], 'Empty project')
    updated = self.call('/api/projects/' + project['id'] + '/tasks', 'POST', {'name': 'First task', 'planned_start': '2026-10-05', 'planned_finish': '2026-10-06'})
    self.assertEqual(len(updated['tasks']), 1)

  def test_directory_placement_moves_into_folder_and_back_to_root(self):
    source, target = self.call('/api/state')['projects'][:2]
    task, anchor = source['tasks'][0], target['tasks'][0]
    moved = self.call('/api/tasks/' + task['id'] + '/placement', 'PATCH', {'directory_id': 'project:' + target['id'], 'anchor_id': anchor['id'], 'after': False})
    self.assertEqual(moved['tasks'][0]['id'], task['id'])
    root = self.call('/api/tasks/' + task['id'] + '/placement', 'PATCH', {'directory_id': 'root'})
    self.assertTrue(root['is_unassigned'])
    node = next(n for n in self.call('/api/state')['directory'] if n['task_id'] == task['id'])
    self.assertEqual(node['parent_id'], 'root')

  def test_delete_task_cleans_links_and_project_cascades(self):
    template = self.call('/api/templates', 'POST', {'name': 'Delete test', 'tasks': [
      {'key': 'a', 'name': 'A', 'duration_value': 1, 'duration_unit': 'days', 'dependencies': []},
      {'key': 'b', 'name': 'B', 'duration_value': 1, 'duration_unit': 'days', 'dependencies': ['a']},
    ]})
    project = self.call('/api/instantiate', 'POST', {'template_id': template['id'], 'name': 'Delete test', 'start_date': '2026-10-01', 'calendar_type': 'calendar'})
    a, b = project['tasks']
    completed = self.call('/api/projects/' + project['id'] + '/complete', 'POST', {})
    self.assertEqual(completed['progress'], 100)
    for before, after in zip(project['tasks'], completed['tasks']):
      self.assertEqual(after['status'], 'done')
      self.assertEqual(after['progress'], 100)
      for field in ('planned_start', 'planned_finish', 'actual_start', 'actual_finish'):
        self.assertEqual(after[field], before[field])
    self.assertEqual(self.call('/api/tasks/' + a['id'], 'DELETE'), {'deleted': True})
    remaining = self.call('/api/projects/' + project['id'])['tasks']
    self.assertEqual(len(remaining), 1)
    self.assertEqual(remaining[0]['dependencies'], [])
    self.assertEqual(remaining[0]['sort_order'], 1)
    self.assertEqual(remaining[0]['planned_start'], b['planned_start'])
    self.assertEqual(self.call('/api/projects/' + project['id'], 'DELETE'), {'deleted': True})
    with self.database.connection() as db:
      self.assertEqual(db.execute('SELECT COUNT(*) FROM project_tasks WHERE project_id=?', (project['id'],)).fetchone()[0], 0)
      self.assertIsNotNone(db.execute('SELECT id FROM templates WHERE id=?', (template['id'],)).fetchone())
    from urllib.error import HTTPError
    with self.assertRaises(HTTPError) as missing:
      self.call('/api/tasks/' + b['id'], 'DELETE')
    self.assertEqual(missing.exception.code, 404)
    with self.assertRaises(HTTPError) as protected:
      self.call('/api/projects/__unassigned__', 'DELETE')
    self.assertEqual(protected.exception.code, 400)

  def test_storage_location_reports_mac_account_and_actual_database(self):
    with patch("mygantt.server.platform.system", return_value="Darwin"), \
         patch("mygantt.server.platform.node", return_value="mac-host.local"), \
         patch("pwd.getpwuid", return_value=SimpleNamespace(pw_gecos="이정윤", pw_name="test-user")):
      storage = self.call("/api/state")["storage"]
    self.assertEqual(storage["label"], "macOS⋅이정윤")
    self.assertEqual(storage["database_path"], str(self.db_path.resolve()))

  def test_storage_location_reports_ubuntu_server_not_browser_device(self):
    with patch("mygantt.server.platform.system", return_value="Linux"), \
         patch("mygantt.server.platform.node", return_value="Sub-FP750"), \
         patch("mygantt.server.platform.freedesktop_os_release", return_value={"NAME": "Ubuntu"}):
      storage = self.call("/api/state")["storage"]
    self.assertEqual(storage["label"], "Ubuntu⋅Sub-FP750")
    self.assertEqual(storage["database_path"], str(self.db_path.resolve()))

  def test_storage_location_falls_back_when_linux_release_is_unavailable(self):
    with patch("mygantt.server.platform.system", return_value="Linux"), \
         patch("mygantt.server.platform.node", return_value="Sub-FP750"), \
         patch("mygantt.server.platform.freedesktop_os_release", side_effect=OSError):
      self.assertEqual(self.call("/api/state")["storage"]["label"], "Linux⋅Sub-FP750")

  def test_add_individual_task_persists_without_changing_template_or_existing_tasks(self):
    from urllib.error import HTTPError
    state = self.call("/api/state")
    project = state["projects"][0]
    path = f"/api/projects/{project['id']}/tasks"
    fields = {"name": "개별 검사", "planned_start": "2026-10-05", "planned_finish": "2026-10-07"}
    created = self.call(path, "POST", fields)
    self.assertEqual(created["tasks"][:-1], project["tasks"])
    task = created["tasks"][-1]
    self.assertEqual(task["name"], fields["name"])
    self.assertEqual(task["planned_finish"], fields["planned_finish"])
    self.assertEqual(task["dependencies"], [])
    self.assertEqual(task["actual_finish"], "")
    self.assertEqual(self.call("/api/state")["templates"], state["templates"])
    for invalid in [{**fields, "name": " "}, {**fields, "planned_finish": "2026-10-01"}]:
      with self.assertRaises(HTTPError) as error:
        self.call(path, "POST", invalid)
      self.assertEqual(error.exception.code, 400)
    with self.assertRaises(HTTPError) as error:
      self.call("/api/projects/missing/tasks", "POST", fields)
    self.assertEqual(error.exception.code, 404)
    self.stop_server()
    self.database = Database(self.db_path, holiday_fetcher=self.fetch_holidays)
    self.start_server()
    self.assertEqual(self.call(f"/api/projects/{project['id']}")["tasks"], created["tasks"])

  def test_successor_checkboxes_and_actual_finish_offset_roundtrip(self):
    project = self.call("/api/state")["projects"][0]
    a, b, c = project["tasks"][:3]
    updated = self.call(f"/api/tasks/{a['id']}", "PATCH", {"successors": [b["id"], c["id"]]})
    by_id = {t["id"]: t for t in updated["tasks"]}
    self.assertIn(a["id"], by_id[c["id"]]["dependencies"])
    from datetime import date, timedelta
    finish = (date.fromisoformat(a["planned_finish"]) + timedelta(days=2)).isoformat()
    shifted = self.call(f"/api/tasks/{a['id']}", "PATCH", {"actual_finish": finish, "cascade_dependents": True})
    for task in shifted["tasks"]:
      if task["id"] in {b["id"], c["id"]}:
        for field in ["planned_start", "planned_finish"]:
          self.assertEqual((date.fromisoformat(task[field]) - date.fromisoformat(by_id[task["id"]][field])).days, 2)
    removed = self.call(f"/api/tasks/{a['id']}", "PATCH", {"successors": []})
    self.assertFalse(any(a["id"] in task["dependencies"] for task in removed["tasks"]))

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
    self.assertEqual(preview["tasks"][1]["planned_start"], "2026-10-07")

    payload = {"request_id": "submit-once", "template_id": template["id"], "name": "릴리스 01", "start_date": "2026-10-05", "calendar_type": "working"}
    project = self.call("/api/instantiate", "POST", payload)
    retry = self.call("/api/instantiate", "POST", payload)
    self.assertEqual(project["id"], retry["id"])
    self.assertRegex(project["color"], r"^#[0-9a-f]{6}$")
    self.assertNotIn(project["color"], [item["color"] for item in before["projects"]])
    self.assertEqual(project["color"], retry["color"])
    self.assertEqual(project["tasks"][0]["color"], "#aabbcc")
    self.assertEqual(len(project["tasks"]), 4)
    self.assertNotIn("duration_value", project["tasks"][0])
    self.assertNotIn("duration_unit", project["tasks"][0])
    second_payload = {**payload, "request_id": "submit-two", "name": "릴리스 02", "color": "#654321"}
    second = self.call("/api/instantiate", "POST", second_payload)
    self.assertNotEqual(project["id"], second["id"])
    self.assertEqual(second["color"], "#654321")
    self.assertNotEqual(project["tasks"][0]["id"], second["tasks"][0]["id"])
    self.assertEqual(second["tasks"][0]["color"], "#aabbcc")
    docs = next(task for task in project["tasks"] if task["template_task_key"] == "docs")
    release = next(task for task in project["tasks"] if task["template_task_key"] == "release")
    test = next(task for task in project["tasks"] if task["template_task_key"] == "test")
    expanded = self.call(f"/api/tasks/{docs['id']}", "PATCH", {"planned_start": "2026-10-05", "planned_finish": "2026-10-08", "cascade_dependents": True})
    self.assertEqual(next(task for task in expanded["tasks"] if task["id"] == release["id"])["planned_start"], "2026-10-14")
    rewired = self.call(f"/api/tasks/{release['id']}", "PATCH", {"dependencies": [test["id"]]})
    self.assertEqual(next(task for task in rewired["tasks"] if task["id"] == release["id"])["planned_start"], "2026-10-14")
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
    self.assertEqual(reopened_release["planned_start"], "2026-10-14")
    self.assertEqual(reopened_release["dependencies"], [test["id"]])
    reopened_second = self.call(f"/api/projects/{second['id']}")
    self.assertEqual(reopened_second["color"], "#654321")
    self.assertEqual(reopened_second["tasks"][0]["color"], "#aabbcc")

  def test_static_app_is_served(self):
    with urlopen(f"{self.base}/", timeout=3) as response:
      html = response.read().decode("utf-8")
    self.assertIn("MyGantt", html)
    self.assertIn("일정 템플릿", html)
    self.assertIn("프로젝트 속성", html)
    self.assertIn("작업 속성", html)
    self.assertRegex(html, r'value="group"[^>]*data-i18n="timeline.group_view"')
    self.assertIn('/i18n.js', html)

  def test_translations_and_language_specific_manifest(self):
    rows = self.call('/translations.json')
    language = next(row for row in rows if row['textID'] == 'settings.language')
    self.assertEqual(language, {'textID': 'settings.language', 'KR': '언어', 'US': 'Language', 'JP': '言語'})
    english = self.call('/manifest.webmanifest?language=US')
    korean = self.call('/manifest.webmanifest?language=KR')
    self.assertEqual(english['lang'], 'en-US')
    japanese = self.call('/manifest.webmanifest?language=JP')
    self.assertEqual(japanese['lang'], 'ja-JP')
    self.assertEqual(japanese['name'], 'MyGantt · 生産スケジュール')
    self.assertEqual(english['name'], 'MyGantt · Production Schedule')
    self.assertEqual(korean['name'], 'MyGantt · 생산 일정')

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
