import unittest

from mygantt.scheduler import ScheduleError, schedule_tasks, update_schedule_dates


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

  def test_date_edits_without_cascade_leave_every_other_task_untouched(self):
    tasks = schedule_tasks([
      {"id": "a", "duration_value": 1, "duration_unit": "days", "dependencies": []},
      {"id": "b", "duration_value": 2, "duration_unit": "days", "dependencies": ["a"]},
      {"id": "c", "duration_value": 1, "duration_unit": "days", "dependencies": ["b"]},
    ], "2026-10-05", "working")
    changed = {task["id"]: task for task in update_schedule_dates(tasks, "a", "2026-10-12", "2026-10-13", "working", False)}
    original = {task["id"]: task for task in tasks}
    self.assertEqual((changed["a"]["planned_start"], changed["a"]["planned_finish"]), ("2026-10-12", "2026-10-13"))
    self.assertEqual(changed["b"]["planned_start"], original["b"]["planned_start"])
    self.assertEqual(changed["c"]["planned_finish"], original["c"]["planned_finish"])

  def test_cascade_moves_chain_later_and_earlier_and_is_repeatable(self):
    tasks = schedule_tasks([
      {"id": "a", "duration_value": 1, "duration_unit": "days", "dependencies": []},
      {"id": "b", "duration_value": 2, "duration_unit": "days", "dependencies": ["a"]},
      {"id": "c", "duration_value": 1, "duration_unit": "days", "dependencies": ["b"]},
    ], "2026-10-05", "working")
    late = update_schedule_dates(tasks, "a", "2026-10-12", "2026-10-13", "working", True)
    late_by_id = {task["id"]: task for task in late}
    self.assertEqual((late_by_id["b"]["planned_start"], late_by_id["b"]["planned_finish"]), ("2026-10-14", "2026-10-15"))
    self.assertEqual(late_by_id["c"]["planned_start"], "2026-10-16")
    repeated = update_schedule_dates(late, "a", "2026-10-12", "2026-10-13", "working", True)
    self.assertEqual([(task["planned_start"], task["planned_finish"]) for task in repeated], [(task["planned_start"], task["planned_finish"]) for task in late])
    early = update_schedule_dates(tasks, "a", "2026-10-01", "2026-10-01", "working", True)
    early_by_id = {task["id"]: task for task in early}
    self.assertEqual(early_by_id["b"]["planned_start"], "2026-10-02")
    self.assertEqual(early_by_id["c"]["planned_start"], "2026-10-04")

  def test_cascade_offsets_parallel_merge_once_in_calendar_days(self):
    original = schedule_tasks(self.tasks, "2026-10-05", "working")
    later = {task["id"]: task for task in update_schedule_dates(original, "buy", "2026-10-12", "2026-10-13", "working", True)}
    self.assertEqual(later["design"]["planned_start"], "2026-10-05")
    self.assertEqual(later["bench"]["planned_start"], "2026-10-19")
    self.assertEqual(later["release"]["planned_start"], "2026-10-21")

    calendar = schedule_tasks([
      {"id": "a", "duration_value": 1, "duration_unit": "days", "dependencies": []},
      {"id": "b", "duration_value": 3, "duration_unit": "days", "dependencies": ["a"]},
    ], "2026-10-05", "calendar")
    shifted = {task["id"]: task for task in update_schedule_dates(calendar, "a", "2026-10-10", "2026-10-10", "calendar", True)}
    self.assertEqual((shifted["b"]["planned_start"], shifted["b"]["planned_finish"]), ("2026-10-11", "2026-10-13"))

  def test_date_validation_rejects_reversed_and_non_iso_ranges(self):
    tasks = schedule_tasks([{"id": "a", "duration_value": 1, "duration_unit": "days", "dependencies": []}], "2026-10-05")
    with self.assertRaisesRegex(ScheduleError, "종료일"):
      update_schedule_dates(tasks, "a", "2026-10-07", "2026-10-06", "working")
    with self.assertRaisesRegex(ScheduleError, "YYYY-MM-DD"):
      update_schedule_dates(tasks, "a", "20261005", "2026-10-06", "working")

  def test_completed_successor_plans_shift_but_actuals_are_preserved(self):
    tasks = schedule_tasks([
      {"id": "a", "duration_value": 1, "duration_unit": "days", "dependencies": []},
      {"id": "b", "duration_value": 1, "duration_unit": "days", "dependencies": ["a"], "status": "done", "actual_start": "2026-10-06", "actual_finish": "2026-10-06"},
      {"id": "c", "duration_value": 1, "duration_unit": "days", "dependencies": ["b"]},
    ], "2026-10-05", "working")
    before_b = next(task for task in tasks if task["id"] == "b")
    after = {task["id"]: task for task in update_schedule_dates(tasks, "a", "2026-10-12", "2026-10-12", "working", True)}
    self.assertEqual(after["b"]["planned_start"], "2026-10-13")
    self.assertEqual(after["b"]["actual_finish"], "2026-10-06")
    self.assertEqual(after["c"]["planned_start"], "2026-10-14")

  def test_later_planned_or_actual_end_drives_offset_not_status(self):
    tasks = [
      {"id": "a", "dependencies": [], "status": "todo", "planned_start": "2026-10-01", "planned_finish": "2026-10-05", "actual_finish": "2026-10-08"},
      {"id": "b", "dependencies": ["a"], "planned_start": "2026-10-04", "planned_finish": "2026-10-09"},
      {"id": "c", "dependencies": ["a"], "planned_start": "2026-10-10", "planned_finish": "2026-10-11"},
      {"id": "d", "dependencies": ["b", "c"], "planned_start": "2026-10-12", "planned_finish": "2026-10-15"},
    ]
    for finish, actual, expected in [("2026-10-07", "2026-10-08", 0), ("2026-10-10", "2026-10-08", 2), ("2026-10-05", "2026-10-11", 3), ("2026-10-05", "2026-10-06", -2), ("2026-10-05", "", -3)]:
      with self.subTest(finish=finish, actual=actual):
        after = update_schedule_dates(tasks, "a", "2026-10-02", finish, "working", True, {"actual_finish": actual})
        from datetime import date
        for before, changed in zip(tasks[1:], after[1:]):
          for key in ["planned_start", "planned_finish"]:
            self.assertEqual((date.fromisoformat(changed[key]) - date.fromisoformat(before[key])).days, expected)

  def test_start_only_changes_and_disabled_actual_cascade_leave_descendants(self):
    tasks = [
      {"id": "a", "dependencies": [], "planned_start": "2026-10-01", "planned_finish": "2026-10-05"},
      {"id": "b", "dependencies": ["a"], "planned_start": "2026-10-06", "planned_finish": "2026-10-09"},
    ]
    self.assertEqual(update_schedule_dates(tasks, "a", "2026-10-02", "2026-10-05", "working", True)[1], tasks[1])
    self.assertEqual(update_schedule_dates(tasks, "a", "2026-10-01", "2026-10-05", "working", False, {"actual_finish": "2026-10-20"})[1], tasks[1])


if __name__ == "__main__":
  unittest.main()
