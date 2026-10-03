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
    self.db = Database(self.path)

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

  def test_board_workflow_is_only_a_generic_seed_template(self):
    state = self.db.state()
    template = next(item for item in state["templates"] if item["name"] == SAMPLE_TEMPLATE["name"])
    by_name = {task["name"]: task for task in template["tasks"]}
    self.assertEqual(by_name["PCB발주"]["dependencies"], [])
    self.assertEqual(by_name["소자발주"]["dependencies"], [])
    self.assertEqual(set(by_name["자삽"]["dependencies"]), {by_name["PCB입고검사"]["id"], by_name["소자발주"]["id"]})
    self.assertEqual(len([p for p in state["projects"] if p["name"] in SAMPLE_BATCHES]), len(SAMPLE_BATCHES))

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
    b = {task["template_task_key"]: task for task in second["tasks"]}
    self.assertEqual(len(b["bench"]["dependencies"]), 2)
    self.assertEqual(len(b["release"]["dependencies"]), 2)

    original_second_release = b["release"]["planned_start"]
    first_bench = next(task for task in first["tasks"] if task["template_task_key"] == "bench")
    self.db.update_task(first_bench["id"], {"duration_value": 4, "duration_unit": "days", "status": "doing"})
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
    after = self.db.update_task(vendor["id"], {"status": "done", "actual_start": "2026-10-05", "actual_finish": "2026-10-09"})
    updated_inspection = next(task for task in after["tasks"] if task["id"] == inspection["id"])
    updated_vendor = next(task for task in after["tasks"] if task["id"] == vendor["id"])
    self.assertEqual(updated_vendor["planned_finish"], vendor["planned_finish"])
    self.assertEqual(updated_vendor["actual_finish"], "2026-10-09")
    self.assertEqual(updated_inspection["planned_start"], "2026-10-12")

  def test_adding_dependency_edge_propagates_only_within_target_project(self):
    template = self.db.save_template({"name": "분기 조정", "tasks": [
      {"key": "build", "name": "조립", "duration_value": 1, "duration_unit": "days", "dependencies": []},
      {"key": "vendor", "name": "외주 준비", "duration_value": 4, "duration_unit": "days", "dependencies": []},
      {"key": "join", "name": "통합 확인", "duration_value": 1, "duration_unit": "days", "dependencies": ["build"]},
    ]})
    first = self.db.instantiate({"template_id": template["id"], "name": "분기 조정 A", "start_date": "2026-10-05"})
    second = self.db.instantiate({"template_id": template["id"], "name": "분기 조정 B", "start_date": "2026-10-05"})
    first_tasks = {task["template_task_key"]: task for task in first["tasks"]}
    second_tasks = {task["template_task_key"]: task for task in second["tasks"]}
    self.assertEqual(first_tasks["join"]["planned_start"], "2026-10-06")
    self.assertEqual(second_tasks["join"]["planned_start"], "2026-10-06")

    updated = self.db.update_task(first_tasks["join"]["id"], {"dependencies": [first_tasks["build"]["id"], first_tasks["vendor"]["id"]]})
    updated_tasks = {task["template_task_key"]: task for task in updated["tasks"]}
    untouched_second = self.db.get_project(second["id"])
    untouched_tasks = {task["template_task_key"]: task for task in untouched_second["tasks"]}
    self.assertEqual(updated_tasks["join"]["planned_start"], "2026-10-09")
    self.assertEqual(len(updated_tasks["join"]["dependencies"]), 2)
    self.assertEqual(untouched_tasks["join"]["planned_start"], "2026-10-06")

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
    updated = self.db.update_task(vendor["id"], {"duration_value": 4, "duration_unit": "days", "color": "#12abef", "group_name": "업체 작업", "tags": ["대기", "외주"]})
    updated_vendor = next(task for task in updated["tasks"] if task["id"] == vendor["id"])
    updated_inspection = next(task for task in updated["tasks"] if task["id"] == inspection["id"])
    self.assertEqual(updated_vendor["color"], "#12abef")
    self.assertEqual(updated_vendor["group_name"], "업체 작업")
    self.assertEqual(updated_vendor["tags"], ["대기", "외주"])
    self.assertNotEqual(updated_inspection["planned_start"], before_finish)
    edited_project = self.db.update_project(project["id"], {"name": "색상 테스트 A 수정", "start_date": "2026-10-12", "color": "#abcdef", "group_name": "마르코스", "tags": ["MAIN", "시제품"]})
    self.assertEqual(edited_project["name"], "색상 테스트 A 수정")
    self.assertEqual(edited_project["color"], "#abcdef")
    self.assertEqual(edited_project["group_name"], "마르코스")
    reopened = Database(self.path).get_project(project["id"])
    self.assertEqual(reopened["tags"], ["MAIN", "시제품"])
    self.assertEqual(next(task for task in reopened["tasks"] if task["id"] == vendor["id"])["color"], "#12abef")

  def test_template_project_and_task_colors_are_snapshotted_per_batch(self):
    payload = self.custom_template()
    payload["project_color"] = "#123456"
    payload["tasks"][0]["color"] = "#aabbcc"
    payload["tasks"][1]["color"] = "#bbccdd"
    template = self.db.save_template(payload)
    first = self.db.instantiate({"template_id": template["id"], "name": "색상 스냅샷 A", "start_date": "2026-10-05"})
    manual = self.db.instantiate({"template_id": template["id"], "name": "색상 수동 지정", "start_date": "2026-10-06", "color": "#654321"})
    self.assertEqual(first["color"], "#123456")
    self.assertEqual(manual["color"], "#654321")
    self.assertEqual(first["tasks"][0]["color"], "#aabbcc")
    self.assertEqual(first["tasks"][1]["color"], "#bbccdd")

    edited = self.custom_template()
    edited["project_color"] = "#fedcba"
    edited["tasks"][0]["color"] = "#112233"
    updated_template = self.db.save_template(edited, template["id"])
    later = self.db.instantiate({"template_id": updated_template["id"], "name": "색상 스냅샷 B", "start_date": "2026-10-07"})
    self.assertEqual(self.db.get_project(first["id"])["color"], "#123456")
    self.assertEqual(self.db.get_project(first["id"])["tasks"][0]["color"], "#aabbcc")
    self.assertEqual(self.db.get_project(manual["id"])["color"], "#654321")
    self.assertEqual(later["color"], "#fedcba")
    self.assertEqual(later["tasks"][0]["color"], "#112233")

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
    self.assertTrue(project["color"].startswith("#"))
    self.assertTrue(project["tasks"][0]["color"].startswith("#"))
    self.assertEqual(project["tasks"][0]["tags"], [])
    self.assertEqual(migrated.instantiate({"request_id": "request", "template_id": "t", "name": "무시될 반복 요청", "start_date": "2026-10-05"})["id"], "p")

  def test_calendar_export_includes_scheduled_task_events(self):
    ics = self.db.calendar_ics()
    self.assertIn("BEGIN:VCALENDAR", ics)
    self.assertIn("DTSTART;VALUE=DATE:", ics)
    self.assertIn("SUMMARY:MARKOS MAIN보드 50EA", ics)
    self.assertIn("END:VCALENDAR", ics)


if __name__ == "__main__":
  unittest.main()
