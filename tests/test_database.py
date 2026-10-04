import tempfile
import sqlite3
import unittest
from pathlib import Path

from mygantt.database import Database, SAMPLE_BATCHES, SAMPLE_TEMPLATE
from mygantt.scheduler import ScheduleError


class DatabaseTests(unittest.TestCase):
  def setUp(self):
    self.temp = tempfile.TemporaryDirectory()
    self.path = Path(self.temp.name) / "test.sqlite3"
    self.db = Database(self.path, holiday_fetcher=lambda year: [])

  def tearDown(self):
    self.temp.cleanup()

  def custom_template(self):
    return {
      "name": "서비스 릴리스 검증",
      "description": "보드 생산과 다른 분기·병합 예제",
      "tasks": [
        {"key": "design", "name": "설계", "duration_value": 1, "duration_unit": "weeks", "dependencies": [], "owner": "제품팀"},
        {"key": "buy", "name": "부품 준비", "duration_value": 2, "duration_unit": "days", "dependencies": [], "owner": "구매팀"},
        {"key": "bench", "name": "벤치 테스트", "duration_value": 2, "duration_unit": "days", "dependencies": ["design", "buy"], "owner": "QA"},
        {"key": "compliance", "name": "인증 검토", "duration_value": 1, "duration_unit": "weeks", "dependencies": ["buy"], "owner": "인증팀"},
        {"key": "release", "name": "출시 인계", "duration_value": 1, "duration_unit": "days", "dependencies": ["bench", "compliance"], "owner": "운영팀"},
      ],
    }

  def test_progress_and_stopped_state_persist(self):
    template = self.db.save_template({"name": "진행률", "tasks": [{"key": "a", "name": "A", "duration_value": 1, "duration_unit": "days", "dependencies": []}]})
    project = self.db.instantiate({"template_id": template["id"], "name": "진행률", "start_date": "2026-10-06"})
    task_id = project["tasks"][0]["id"]
    for progress, status in [(0, "todo"), (10, "doing"), (90, "doing"), (100, "done")]:
      result = self.db.update_task(task_id, {"progress": progress})
      self.assertEqual(result["tasks"][0]["status"], status)
      self.assertEqual(result["progress"], progress)
    self.db.update_task(task_id, {"progress": 40, "status": "blocked"})
    reopened = Database(self.path, holiday_fetcher=lambda year: [])
    self.assertEqual(reopened.get_project(project["id"])["tasks"][0]["progress"], 40)
    self.assertEqual(reopened.get_project(project["id"])["tasks"][0]["status"], "blocked")
    self.assertEqual(self.db.update_task(task_id, {"progress": 50})["tasks"][0]["status"], "doing")
    with self.assertRaises(ScheduleError): self.db.update_task(task_id, {"progress": 45})
    self.assertEqual(self.db.update_task(task_id, {"status": "done"})["tasks"][0]["progress"], 100)

  def test_empty_production_database_stays_empty_after_restart(self):
    path = Path(self.temp.name) / "production.sqlite3"
    production = Database(path, holiday_fetcher=lambda year: [], seed_samples=False)
    self.assertEqual(production.state()["templates"], [])
    self.assertEqual(production.state()["projects"], [])
    with production.connection() as db:
      self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
      self.assertEqual(db.execute("SELECT COUNT(*) FROM holiday_cache").fetchone()[0], 1)
    reopened = Database(path, holiday_fetcher=lambda year: [], seed_samples=False)
    self.assertEqual(reopened.state()["templates"], [])
    self.assertEqual(reopened.state()["projects"], [])

  def test_no_seed_preserves_user_created_production_records(self):
    path = Path(self.temp.name) / "production.sqlite3"
    production = Database(path, holiday_fetcher=lambda year: [], seed_samples=False)
    template = production.save_template(self.custom_template())
    project = production.instantiate({"request_id": "production-submit", "template_id": template["id"], "name": "Release verification", "start_date": "2026-10-05", "calendar_type": "working"})
    production.update_task(project["tasks"][0]["id"], {"status": "done", "actual_finish": "2026-10-09"})
    reopened = Database(path, holiday_fetcher=lambda year: [], seed_samples=False)
    self.assertEqual(len(reopened.state()["templates"]), 1)
    self.assertEqual(len(reopened.state()["projects"]), 1)
    self.assertEqual(reopened.get_project(project["id"])["tasks"][0]["actual_finish"], "2026-10-09")

  def test_no_seed_does_not_delete_existing_records(self):
    before = self.db.state()
    self.assertEqual(Database(self.path, seed_samples=False).state(), before)

  def test_selected_template_is_seeded_with_relative_days_colors_and_connections(self):
    state = self.db.state()
    template = next(item for item in state["templates"] if item["name"] == "New schedule template")
    self.assertEqual(template["project_color"], "#b96749")
    self.assertEqual(template["calendar_type"], "working")
    self.assertEqual(len(template["tasks"]), 5)
    by_id = {task["id"]: task["key"] for task in template["tasks"]}
    for actual, expected in zip(template["tasks"], SAMPLE_TEMPLATE["tasks"]):
      for field in ("key", "name", "start_day", "duration_value", "duration_unit", "color", "owner", "handoff"):
        self.assertEqual(actual[field], expected[field])
      self.assertEqual([by_id[key] for key in actual["dependencies"]], expected["dependencies"])
    self.assertEqual(len([p for p in state["projects"] if p["name"] in SAMPLE_BATCHES]), len(SAMPLE_BATCHES))
    before = self.db.state()
    self.assertEqual(Database(self.path, holiday_fetcher=lambda year: []).state(), before)

  def test_new_instance_rows_store_date_ranges_without_duration_columns(self):
    template = self.db.save_template({"name": "날짜 속성", "tasks": [
      {"key": "work", "name": "실제 작업", "duration_value": 2, "duration_unit": "days", "dependencies": []},
    ]})
    project = self.db.instantiate({"template_id": template["id"], "name": "날짜 배치", "start_date": "2026-10-05"})
    task = project["tasks"][0]
    self.assertEqual((task["planned_start"], task["planned_finish"]), ("2026-10-06", "2026-10-07"))
    self.assertNotIn("duration_value", task)
    self.assertNotIn("duration_unit", task)
    with self.db.connection() as db:
      columns = {row[1] for row in db.execute("PRAGMA table_info(project_tasks)")}
    self.assertNotIn("duration_value", columns)
    self.assertNotIn("duration_unit", columns)

  def test_custom_branching_template_two_instances_snapshot_and_persistence(self):
    template = self.db.save_template(self.custom_template())
    tasks = {task["key"]: task for task in template["tasks"]}
    self.assertEqual(set(tasks["bench"]["dependencies"]), {tasks["design"]["id"], tasks["buy"]["id"]})
    first = self.db.instantiate({"request_id": "batch-one", "template_id": template["id"], "name": "릴리스 A", "start_date": "2026-10-05", "calendar_type": "working"})
    first_retry = self.db.instantiate({"request_id": "batch-one", "template_id": template["id"], "name": "릴리스 A", "start_date": "2026-10-05", "calendar_type": "working"})
    second = self.db.instantiate({"request_id": "batch-two", "template_id": template["id"], "name": "릴리스 B", "start_date": "2026-10-12", "calendar_type": "working"})
    self.assertEqual(first["id"], first_retry["id"], "repeat submission with the same request ID is idempotent")
    self.assertNotEqual(first["id"], second["id"])
    self.assertNotEqual(first["tasks"][0]["id"], second["tasks"][0]["id"])
    self.assertEqual(len(first["tasks"]), 5)
    self.assertNotIn("duration_value", first["tasks"][0])
    self.assertNotIn("duration_unit", first["tasks"][0])
    b = {task["template_task_key"]: task for task in second["tasks"]}
    self.assertEqual(len(b["bench"]["dependencies"]), 2)
    self.assertEqual(len(b["release"]["dependencies"]), 2)

    original_second_release = b["release"]["planned_start"]
    first_bench = next(task for task in first["tasks"] if task["template_task_key"] == "bench")
    self.db.update_task(first_bench["id"], {"planned_start": "2026-10-20", "planned_finish": "2026-10-23", "status": "doing"})
    second_after_edit = self.db.get_project(second["id"])
    self.assertEqual(next(task for task in second_after_edit["tasks"] if task["template_task_key"] == "release")["planned_start"], original_second_release)

    edited_payload = self.custom_template()
    edited_payload["name"] = "서비스 릴리스 검증 v2"
    edited_payload["tasks"][0]["name"] = "확정 설계"
    self.db.save_template(edited_payload, template["id"])
    self.assertEqual(self.db.get_project(first["id"])["tasks"][0]["name"], "설계")
    reopened = Database(self.path).state()
    self.assertTrue(any(project["id"] == first["id"] for project in reopened["projects"]))
    self.assertTrue(any(item["name"] == "서비스 릴리스 검증 v2" for item in reopened["templates"]))

  def test_template_replacement_keeps_existing_project_snapshot_unchanged(self):
    template = self.db.save_template(self.custom_template())
    project = self.db.instantiate({"template_id": template["id"], "name": "독립 일정", "start_date": "2026-10-05"})
    self.db.update_task(project["tasks"][0]["id"], {"status": "doing", "notes": "보존 기록", "actual_start": "2026-10-06"})
    before = self.db.get_project(project["id"])
    replacement = {"name": "교체 템플릿", "description": "완전히 변경", "project_color": "#123456", "calendar_type": "calendar", "tasks": [
      {"key": "new_a", "name": "새 공정 A", "duration_value": 3, "duration_unit": "days", "dependencies": [], "owner": "다른 담당", "color": "#abcdef"},
      {"key": "new_b", "name": "새 공정 B", "duration_value": 2, "duration_unit": "weeks", "dependencies": ["new_a"]},
    ]}
    self.db.save_template(replacement, template["id"])
    self.assertEqual(self.db.get_project(project["id"]), before)
    reopened = Database(self.path, holiday_fetcher=lambda year: [])
    self.assertEqual(reopened.get_project(project["id"]), before)
    new_project = reopened.instantiate({"template_id": template["id"], "name": "새 일정", "start_date": "2026-10-05"})
    self.assertEqual([t["name"] for t in new_project["tasks"]], ["새 공정 A", "새 공정 B"])
    self.assertEqual(len(new_project["tasks"][1]["dependencies"]), 1)

  def test_rejects_cyclic_template_graph_without_saving_it(self):
    payload = self.custom_template()
    payload["tasks"][0]["dependencies"] = ["release"]
    with self.assertRaisesRegex(ScheduleError, "순환"):
      self.db.save_template(payload)
    self.assertFalse(any(item["name"] == payload["name"] for item in self.db.state()["templates"]))

  def test_completed_actual_date_is_used_for_dependency_recalculation(self):
    template = self.db.save_template({"name": "완료일 검사", "tasks": [
      {"key": "vendor", "name": "외주 작업", "duration_value": 2, "duration_unit": "days", "dependencies": []},
      {"key": "inspection", "name": "입고 검사", "duration_value": 1, "duration_unit": "days", "dependencies": ["vendor"]},
    ]})
    project = self.db.instantiate({"template_id": template["id"], "name": "실제일 확인", "start_date": "2026-10-05"})
    vendor = next(task for task in project["tasks"] if task["template_task_key"] == "vendor")
    inspection = next(task for task in project["tasks"] if task["template_task_key"] == "inspection")
    after = self.db.update_task(vendor["id"], {"status": "done", "actual_start": "2026-10-05", "actual_finish": "2026-10-09", "cascade_dependents": True})
    updated_inspection = next(task for task in after["tasks"] if task["id"] == inspection["id"])
    updated_vendor = next(task for task in after["tasks"] if task["id"] == vendor["id"])
    self.assertEqual(updated_vendor["planned_finish"], vendor["planned_finish"])
    self.assertEqual(updated_vendor["actual_finish"], "2026-10-09")
    self.assertEqual(updated_inspection["planned_start"], "2026-10-10")

  def test_dependency_edits_do_not_recalculate_dates_without_explicit_date_change(self):
    template = self.db.save_template({"name": "분기 조정", "tasks": [
      {"key": "build", "name": "조립", "duration_value": 1, "duration_unit": "days", "dependencies": []},
      {"key": "vendor", "name": "외주 준비", "duration_value": 4, "duration_unit": "days", "dependencies": []},
      {"key": "join", "name": "통합 확인", "duration_value": 1, "duration_unit": "days", "dependencies": ["build"]},
    ]})
    first = self.db.instantiate({"template_id": template["id"], "name": "분기 조정 A", "start_date": "2026-10-05"})
    second = self.db.instantiate({"template_id": template["id"], "name": "분기 조정 B", "start_date": "2026-10-05"})
    first_tasks = {task["template_task_key"]: task for task in first["tasks"]}
    second_tasks = {task["template_task_key"]: task for task in second["tasks"]}
    self.assertEqual(first_tasks["join"]["planned_start"], "2026-10-07")
    self.assertEqual(second_tasks["join"]["planned_start"], "2026-10-07")

    updated = self.db.update_task(first_tasks["join"]["id"], {"dependencies": [first_tasks["build"]["id"], first_tasks["vendor"]["id"]]})
    updated_tasks = {task["template_task_key"]: task for task in updated["tasks"]}
    untouched_second = self.db.get_project(second["id"])
    untouched_tasks = {task["template_task_key"]: task for task in untouched_second["tasks"]}
    self.assertEqual(updated_tasks["join"]["planned_start"], "2026-10-07")
    self.assertEqual(len(updated_tasks["join"]["dependencies"]), 2)
    self.assertEqual(untouched_tasks["join"]["planned_start"], "2026-10-07")

  def test_successor_edits_preserve_other_predecessors_and_are_atomic(self):
    template = self.db.save_template(self.custom_template())
    project = self.db.instantiate({"template_id": template["id"], "name": "연결 편집", "start_date": "2026-10-05"})
    tasks = {t["template_task_key"]: t for t in project["tasks"]}
    design, buy, bench, compliance = [tasks[k]["id"] for k in ["design", "buy", "bench", "compliance"]]
    after = self.db.update_task(design, {"successors": [bench, compliance, compliance], "cascade_dependents": True})
    indexed = {t["id"]: t for t in after["tasks"]}
    self.assertEqual(set(indexed[bench]["dependencies"]), {design, buy})
    self.assertEqual(set(indexed[compliance]["dependencies"]), {design, buy})
    self.assertEqual([(t["planned_start"], t["planned_finish"]) for t in project["tasks"]], [(t["planned_start"], t["planned_finish"]) for t in after["tasks"]])
    for invalid in [{"dependencies": [bench], "successors": [bench]}, {"successors": [design]}, {"successors": ["other-project-id"]}, {"successors": "bad"}]:
      with self.subTest(invalid=invalid):
        with self.assertRaises(ScheduleError):
          self.db.update_task(design, {"name": "must rollback", **invalid})
        self.assertEqual(self.db.get_project(project["id"]), after)
    # Reverse an existing edge in one request, validating only the final graph.
    reversed_graph = self.db.update_task(design, {"dependencies": [bench], "successors": []})
    indexed = {t["id"]: t for t in reversed_graph["tasks"]}
    self.assertEqual(indexed[design]["dependencies"], [bench])
    self.assertEqual(indexed[bench]["dependencies"], [buy])
    self.assertEqual(indexed[compliance]["dependencies"], [buy])
    self.assertEqual(Database(self.path).get_project(project["id"]), reversed_graph)

  def test_successor_edit_and_finish_offset_use_final_graph_once(self):
    template = self.db.save_template(self.custom_template())
    project = self.db.instantiate({"template_id": template["id"], "name": "연결 이동", "start_date": "2026-10-05"})
    tasks = {t["template_task_key"]: t for t in project["tasks"]}
    after = self.db.update_task(tasks["design"]["id"], {"successors": [tasks["bench"]["id"], tasks["compliance"]["id"]], "planned_finish": "2026-10-16", "cascade_dependents": True})
    from datetime import date
    for task in after["tasks"]:
      key = task["template_task_key"]
      if key in {"bench", "compliance", "release"}:
        for field in ["planned_start", "planned_finish"]:
          self.assertEqual((date.fromisoformat(task[field]) - date.fromisoformat(tasks[key][field])).days, 3)

  def test_inspector_properties_are_persisted_and_recompute_dependencies(self):
    template = self.db.save_template({"name": "속성 저장", "tasks": [
      {"key": "vendor", "name": "외주 작업", "duration_value": 2, "duration_unit": "days", "dependencies": []},
      {"key": "inspection", "name": "입고 검사", "duration_value": 1, "duration_unit": "days", "dependencies": ["vendor"]},
    ]})
    project = self.db.instantiate({"template_id": template["id"], "name": "색상 테스트 A", "start_date": "2026-10-05", "group_name": "MAIN", "tags": "긴급, 외주"})
    second = self.db.instantiate({"template_id": template["id"], "name": "색상 테스트 B", "start_date": "2026-10-05", "color": "#1040af"})
    self.assertNotEqual(project["color"], second["color"])
    self.assertEqual(project["tags"], ["긴급", "외주"])
    vendor, inspection = project["tasks"]
    before_finish = inspection["planned_start"]
    updated = self.db.update_task(vendor["id"], {"planned_start": "2026-10-05", "planned_finish": "2026-10-08", "cascade_dependents": True, "color": "#12abef", "group_name": "업체 작업", "tags": ["대기", "외주"]})
    updated_vendor = next(task for task in updated["tasks"] if task["id"] == vendor["id"])
    updated_inspection = next(task for task in updated["tasks"] if task["id"] == inspection["id"])
    self.assertEqual(updated_vendor["color"], "#12abef")
    self.assertEqual(updated_vendor["group_name"], "업체 작업")
    self.assertEqual(updated_vendor["tags"], ["대기", "외주"])
    self.assertNotEqual(updated_inspection["planned_start"], before_finish)
    before_project_edit = (updated_vendor["planned_start"], updated_vendor["planned_finish"], updated_inspection["planned_start"])
    edited_project = self.db.update_project(project["id"], {"name": "색상 테스트 A 수정", "start_date": "2026-10-12", "color": "#abcdef", "group_name": "마르코스", "tags": ["MAIN", "시제품"]})
    self.assertEqual(edited_project["name"], "색상 테스트 A 수정")
    self.assertEqual(edited_project["color"], "#abcdef")
    self.assertEqual(edited_project["group_name"], "마르코스")
    edited_dates = {task["id"]: (task["planned_start"], task["planned_finish"]) for task in edited_project["tasks"]}
    self.assertEqual(edited_dates[vendor["id"]], before_project_edit[:2])
    self.assertEqual(edited_dates[inspection["id"]][0], before_project_edit[2])
    reopened = Database(self.path).get_project(project["id"])
    self.assertEqual(reopened["tags"], ["MAIN", "시제품"])
    self.assertEqual(next(task for task in reopened["tasks"] if task["id"] == vendor["id"])["color"], "#12abef")

  def test_project_color_is_independent_and_task_colors_are_snapshotted_per_batch(self):
    payload = self.custom_template()
    payload["project_color"] = "#123456"
    payload["tasks"][0]["color"] = "#aabbcc"
    payload["tasks"][1]["color"] = "#bbccdd"
    template = self.db.save_template(payload)
    first = self.db.instantiate({"template_id": template["id"], "name": "색상 스냅샷 A", "start_date": "2026-10-05"})
    manual = self.db.instantiate({"template_id": template["id"], "name": "색상 수동 지정", "start_date": "2026-10-06", "color": "#654321"})
    self.assertRegex(first["color"], r"^#[0-9a-f]{6}$")
    self.assertEqual(manual["color"], "#654321")
    self.assertEqual(first["tasks"][0]["color"], "#aabbcc")
    self.assertEqual(first["tasks"][1]["color"], "#bbccdd")

    edited = self.custom_template()
    edited["project_color"] = "#fedcba"
    edited["tasks"][0]["color"] = "#112233"
    updated_template = self.db.save_template(edited, template["id"])
    later = self.db.instantiate({"template_id": updated_template["id"], "name": "색상 스냅샷 B", "start_date": "2026-10-07"})
    self.assertEqual(self.db.get_project(first["id"])["color"], first["color"])
    self.assertEqual(self.db.get_project(first["id"])["tasks"][0]["color"], "#aabbcc")
    self.assertEqual(self.db.get_project(manual["id"])["color"], "#654321")
    self.assertNotIn(later["color"], [first["color"], manual["color"]])
    self.assertEqual(later["tasks"][0]["color"], "#112233")

  def test_new_project_colors_do_not_repeat_and_conflicting_requests_are_serialized(self):
    from concurrent.futures import ThreadPoolExecutor
    template = self.db.save_template(self.custom_template())
    base = {"template_id": template["id"], "name": "색상", "start_date": "2026-10-05", "calendar_type": "calendar"}
    with ThreadPoolExecutor(max_workers=2) as pool:
      projects = list(pool.map(lambda i: self.db.instantiate({**base, "request_id": f"color-{i}", "color": "#ABCDEF"}), range(2)))
    self.assertEqual(len({p["color"] for p in projects}), 2)
    self.assertIn("#abcdef", [p["color"] for p in projects])
    for i in range(14):
      self.db.instantiate({**base, "request_id": f"auto-{i}"})
    colors = [p["color"] for p in self.db.state()["projects"]]
    self.assertEqual(len(colors), len(set(colors)))
    again = self.db.instantiate({**base, "request_id": "color-0", "color": "#ABCDEF"})
    self.assertEqual(again["id"], projects[0]["id"])
    self.assertEqual(again["color"], projects[0]["color"])

  def test_migrates_legacy_database_without_replacing_rows_or_actual_dates(self):
    legacy_path = Path(self.temp.name) / "legacy.sqlite3"
    db = sqlite3.connect(legacy_path)
    db.executescript("""
      CREATE TABLE templates (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE template_tasks (id TEXT PRIMARY KEY, template_id TEXT NOT NULL, task_key TEXT NOT NULL, name TEXT NOT NULL, duration_value INTEGER NOT NULL, duration_unit TEXT NOT NULL, dependencies TEXT NOT NULL DEFAULT '[]', owner TEXT NOT NULL DEFAULT '', handoff TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL);
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, template_id TEXT, template_name TEXT NOT NULL, start_date TEXT NOT NULL, calendar_type TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE project_tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, template_task_key TEXT NOT NULL, name TEXT NOT NULL, duration_value INTEGER NOT NULL, duration_unit TEXT NOT NULL, dependencies TEXT NOT NULL DEFAULT '[]', owner TEXT NOT NULL DEFAULT '', handoff TEXT NOT NULL DEFAULT '', blocker TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'todo', planned_start TEXT NOT NULL DEFAULT '', planned_finish TEXT NOT NULL DEFAULT '', actual_start TEXT NOT NULL DEFAULT '', actual_finish TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL);
      CREATE TABLE project_creation_requests (request_id TEXT PRIMARY KEY, project_id TEXT NOT NULL);
      INSERT INTO templates VALUES ('t', '기존 템플릿', '', '2026-01-01', '2026-01-01');
      INSERT INTO template_tasks VALUES ('tt', 't', 'work', '기존 작업', 1, 'days', '[]', '', '', 0);
      INSERT INTO projects VALUES ('p', '기존 배치', 't', '기존 템플릿', '2026-10-05', 'working', '2026-01-01', '2026-01-01');
      INSERT INTO project_tasks VALUES ('pt', 'p', 'work', '기존 작업', 1, 'days', '[]', '품질팀', '', '', 'done', '2026-10-05', '2026-10-05', '2026-10-05', '2026-10-06', '기존 메모', 0);
      INSERT INTO project_creation_requests VALUES ('request', 'p');
    """)
    db.commit()
    db.close()
    migrated = Database(legacy_path)
    project = migrated.get_project("p")
    self.assertEqual(project["name"], "기존 배치")
    self.assertEqual(project["tasks"][0]["owner"], "품질팀")
    self.assertEqual(project["tasks"][0]["actual_finish"], "2026-10-06")
    self.assertEqual((project["tasks"][0]["planned_start"], project["tasks"][0]["planned_finish"]), ("2026-10-05", "2026-10-05"))
    self.assertNotIn("duration_value", project["tasks"][0])
    self.assertTrue(project["color"].startswith("#"))
    self.assertTrue(project["tasks"][0]["color"].startswith("#"))
    self.assertEqual(project["tasks"][0]["tags"], [])
    backups = list(legacy_path.parent.glob("legacy.sqlite3.before-date-authority-*.bak"))
    self.assertEqual(len(backups), 1)
    with sqlite3.connect(legacy_path) as raw:
      columns = {row[1] for row in raw.execute("PRAGMA table_info(project_tasks)")}
      legacy_task = raw.execute("SELECT duration_value, duration_unit, planned_start, planned_finish, actual_start, actual_finish FROM project_tasks WHERE id='pt'").fetchone()
    self.assertTrue({"duration_value", "duration_unit"} <= columns, "legacy fields are retained without being used")
    self.assertEqual(legacy_task, (1, "days", "2026-10-05", "2026-10-05", "2026-10-05", "2026-10-06"))
    Database(legacy_path)
    self.assertEqual(len(list(legacy_path.parent.glob("legacy.sqlite3.before-date-authority-*.bak"))), 1, "migration is idempotent")
    self.assertEqual(migrated.instantiate({"request_id": "request", "template_id": "t", "name": "무시될 반복 요청", "start_date": "2026-10-05"})["id"], "p")

  def test_calendar_export_includes_scheduled_task_events(self):
    ics = self.db.calendar_ics()
    self.assertIn("BEGIN:VCALENDAR", ics)
    self.assertIn("DTSTART;VALUE=DATE:", ics)
    self.assertIn("SUMMARY:MARKOS MAIN보드 50EA", ics)
    self.assertIn("END:VCALENDAR", ics)


if __name__ == "__main__":
  unittest.main()
