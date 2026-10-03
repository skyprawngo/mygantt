import unittest

from mygantt.scheduler import ScheduleError, schedule_tasks


class SchedulerTests(unittest.TestCase):
  def setUp(self):
    self.tasks = [
      {"id": "design", "name": "설계", "duration_value": 1, "duration_unit": "weeks", "dependencies": []},
      {"id": "buy", "name": "부품 준비", "duration_value": 2, "duration_unit": "days", "dependencies": []},
      {"id": "bench", "name": "벤치 테스트", "duration_value": 2, "duration_unit": "days", "dependencies": ["design", "buy"]},
      {"id": "compliance", "name": "인증 검토", "duration_value": 1, "duration_unit": "weeks", "dependencies": ["buy"]},
      {"id": "release", "name": "출시 인계", "duration_value": 1, "duration_unit": "days", "dependencies": ["bench", "compliance"]},
    ]

  def test_workday_calendar_parallel_branches_and_multi_predecessor_join(self):
    scheduled = {task["id"]: task for task in schedule_tasks(self.tasks, "2026-10-05", "working")}
    self.assertEqual(scheduled["design"]["planned_start"], "2026-10-05")
    self.assertEqual(scheduled["design"]["planned_finish"], "2026-10-09")
    self.assertEqual(scheduled["buy"]["planned_start"], "2026-10-05")
    self.assertEqual(scheduled["buy"]["planned_finish"], "2026-10-06")
    self.assertEqual(scheduled["bench"]["planned_start"], "2026-10-12")
    self.assertEqual(scheduled["compliance"]["planned_start"], "2026-10-07")
    self.assertEqual(scheduled["release"]["planned_start"], "2026-10-14")

  def test_calendar_day_mode_uses_seven_day_weeks(self):
    scheduled = {task["id"]: task for task in schedule_tasks(self.tasks, "2026-10-05", "calendar")}
    self.assertEqual(scheduled["design"]["planned_finish"], "2026-10-11")
    self.assertEqual(scheduled["bench"]["planned_start"], "2026-10-12")

  def test_korean_holiday_display_does_not_change_weekday_scheduler(self):
    scheduled = schedule_tasks([{"id": "a", "duration_value": 1, "duration_unit": "days", "dependencies": []}], "2026-10-05", "working")
    self.assertEqual(scheduled[0]["planned_start"], "2026-10-05")
    self.assertEqual(scheduled[0]["planned_finish"], "2026-10-05")

  def test_rejects_cycles_and_missing_predecessors(self):
    cyclic = [dict(task) for task in self.tasks]
    cyclic[0]["dependencies"] = ["release"]
    with self.assertRaisesRegex(ScheduleError, "순환"):
      schedule_tasks(cyclic, "2026-10-05")
    missing = [dict(task) for task in self.tasks]
    missing[0]["dependencies"] = ["not-there"]
    with self.assertRaisesRegex(ScheduleError, "알 수 없는"):
      schedule_tasks(missing, "2026-10-05")

  def test_completed_task_plan_is_immutable_and_successors_use_actual_finish(self):
    tasks = [
      {"id": "a", "duration_value": 2, "duration_unit": "days", "dependencies": [], "status": "done", "planned_start": "2026-10-05", "planned_finish": "2026-10-06", "actual_start": "2026-10-05", "actual_finish": "2026-10-09"},
      {"id": "b", "duration_value": 1, "duration_unit": "days", "dependencies": ["a"], "status": "todo"},
    ]
    scheduled = {task["id"]: task for task in schedule_tasks(tasks, "2026-10-05", "working")}
    self.assertEqual(scheduled["a"]["planned_finish"], "2026-10-06")
    self.assertEqual(scheduled["a"]["actual_finish"], "2026-10-09")
    self.assertEqual(scheduled["b"]["planned_start"], "2026-10-12")


if __name__ == "__main__":
  unittest.main()
