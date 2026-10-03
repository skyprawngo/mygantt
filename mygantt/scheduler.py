"""Small, deterministic forward-pass scheduler for finish-to-start task plans."""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any


class ScheduleError(ValueError):
  pass


def _date(value: str | date) -> date:
  return value if isinstance(value, date) else date.fromisoformat(value)


def is_workday(day: date) -> bool:
  return day.weekday() < 5


def on_or_after_workday(day: date, calendar_type: str) -> date:
  if calendar_type == "calendar":
    return day
  while not is_workday(day):
    day += timedelta(days=1)
  return day


def next_workday(day: date, calendar_type: str) -> date:
  return on_or_after_workday(day + timedelta(days=1), calendar_type)


def duration_days(task: dict[str, Any], calendar_type: str) -> int:
  try:
    value = int(task.get("duration_value", 1))
  except (TypeError, ValueError) as exc:
    raise ScheduleError("기간은 양의 정수여야 합니다.") from exc
  if value < 1:
    raise ScheduleError("기간은 1 이상이어야 합니다.")
  unit = task.get("duration_unit", "days")
  if unit not in {"days", "weeks"}:
    raise ScheduleError("기간 단위는 days 또는 weeks여야 합니다.")
  if unit == "weeks":
    return value * (5 if calendar_type == "working" else 7)
  return value


def finish_date(start: date, days: int, calendar_type: str) -> date:
  cursor = start
  elapsed = 1
  while elapsed < days:
    cursor += timedelta(days=1)
    if calendar_type == "calendar" or is_workday(cursor):
      elapsed += 1
  return cursor


def topological_order(tasks: list[dict[str, Any]]) -> list[dict[str, Any]]:
  by_id = {str(task["id"]): task for task in tasks}
  if len(by_id) != len(tasks):
    raise ScheduleError("작업 ID가 중복되었습니다.")
  incoming: dict[str, set[str]] = {task_id: set() for task_id in by_id}
  outgoing: dict[str, set[str]] = {task_id: set() for task_id in by_id}
  for task in tasks:
    task_id = str(task["id"])
    for dependency in task.get("dependencies", []) or []:
      dependency = str(dependency)
      if dependency not in by_id:
        raise ScheduleError(f"알 수 없는 선행 작업: {dependency}")
      if dependency == task_id:
        raise ScheduleError("작업이 자기 자신에 의존할 수 없습니다.")
      incoming[task_id].add(dependency)
      outgoing[dependency].add(task_id)
  ready = [str(task["id"]) for task in tasks if not incoming[str(task["id"])] ]
  result: list[dict[str, Any]] = []
  while ready:
    task_id = ready.pop(0)
    result.append(by_id[task_id])
    for child in outgoing[task_id]:
      incoming[child].remove(task_id)
      if not incoming[child]:
        ready.append(child)
  if len(result) != len(tasks):
    raise ScheduleError("선행 작업 연결에 순환이 있습니다.")
  return result


def schedule_tasks(
  tasks: list[dict[str, Any]],
  project_start: str | date,
  calendar_type: str = "working",
) -> list[dict[str, Any]]:
  """Return scheduled task copies. Completed rows keep their saved plan and actuals."""
  if calendar_type not in {"working", "calendar"}:
    raise ScheduleError("달력 유형은 working 또는 calendar여야 합니다.")
  start = on_or_after_workday(_date(project_start), calendar_type)
  ordered = topological_order(tasks)
  scheduled: dict[str, dict[str, Any]] = {}
  for original in ordered:
    task = dict(original)
    task_id = str(task["id"])
    done = task.get("status") == "done"
    if done and task.get("planned_start") and task.get("planned_finish"):
      # A completed task is historical data. Never move its saved plan.
      task["planned_start"] = str(task["planned_start"])
      task["planned_finish"] = str(task["planned_finish"])
      scheduled[task_id] = task
      continue

    earliest = start
    for dependency in task.get("dependencies", []) or []:
      predecessor = scheduled[str(dependency)]
      anchor = predecessor.get("actual_finish") if predecessor.get("status") == "done" else None
      anchor = anchor or predecessor.get("planned_finish")
      if anchor:
        candidate = next_workday(_date(anchor), calendar_type)
        if candidate > earliest:
          earliest = candidate
    task_start = on_or_after_workday(earliest, calendar_type)
    task_finish = finish_date(task_start, duration_days(task, calendar_type), calendar_type)
    task["planned_start"] = task_start.isoformat()
    task["planned_finish"] = task_finish.isoformat()
    scheduled[task_id] = task
  return [scheduled[str(task["id"])] for task in tasks]
