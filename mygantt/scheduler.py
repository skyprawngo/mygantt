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


def template_start_day(task: dict[str, Any]) -> int | None:
  value = task.get("start_day")
  if value is None:
    return None
  if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 10000:
    raise ScheduleError("템플릿 시작일은 D+1부터 D+10000 사이의 정수여야 합니다.")
  return value


def finish_date(start: date, days: int, calendar_type: str) -> date:
  cursor = start
  elapsed = 1
  while elapsed < days:
    cursor += timedelta(days=1)
    if calendar_type == "calendar" or is_workday(cursor):
      elapsed += 1
  return cursor


def validate_date_range(start_value: str, finish_value: str) -> tuple[date, date]:
  """Validate an explicitly stored inclusive start/finish range."""
  if not isinstance(start_value, str) or not isinstance(finish_value, str) or not start_value or not finish_value:
    raise ScheduleError("시작일과 종료일을 모두 입력하세요.")
  try:
    start = date.fromisoformat(start_value)
    finish = date.fromisoformat(finish_value)
  except ValueError as exc:
    raise ScheduleError("날짜를 YYYY-MM-DD 형식으로 입력하세요.") from exc
  if start.isoformat() != start_value or finish.isoformat() != finish_value:
    raise ScheduleError("날짜를 YYYY-MM-DD 형식으로 입력하세요.")
  if finish < start:
    raise ScheduleError("종료일은 시작일보다 빠를 수 없습니다.")
  return start, finish


def _inclusive_duration(start: date, finish: date, calendar_type: str) -> int:
  if calendar_type == "calendar":
    return (finish - start).days + 1
  cursor = start
  count = 0
  while cursor <= finish:
    if is_workday(cursor):
      count += 1
    cursor += timedelta(days=1)
  return max(1, count)


def _add_eligible_days(day: date, count: int, calendar_type: str) -> date:
  cursor = day
  step = 1 if count >= 0 else -1
  remaining = abs(count)
  while remaining:
    cursor += timedelta(days=step)
    if calendar_type == "calendar" or is_workday(cursor):
      remaining -= 1
  return cursor


def _eligible_gap(start: date, end: date, calendar_type: str) -> int:
  """Count eligible-day steps from start to end, excluding start."""
  if end <= start:
    return 0
  cursor = start
  count = 0
  while cursor < end:
    cursor = _add_eligible_days(cursor, 1, calendar_type)
    count += 1
  return count


def _effective_finish(task: dict[str, Any]) -> date | None:
  value = task.get("actual_finish") if task.get("status") == "done" else None
  value = value or task.get("planned_finish")
  return _date(value) if value else None


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
  *,
  include_trailing_weekend: bool = False,
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
    explicit_day = template_start_day(task)
    if explicit_day is not None:
      task_start = _add_eligible_days(start, explicit_day - 1, calendar_type)
    task_finish = finish_date(task_start, duration_days(task, calendar_type), calendar_type)
    if include_trailing_weekend and calendar_type == "working" and task_finish.weekday() == 4:
      task_finish += timedelta(days=2)
    task["planned_start"] = task_start.isoformat()
    task["planned_finish"] = task_finish.isoformat()
    scheduled[task_id] = task
  return [scheduled[str(task["id"])] for task in tasks]


def update_schedule_dates(
  tasks: list[dict[str, Any]],
  task_id: str,
  planned_start: str,
  planned_finish: str,
  calendar_type: str,
  cascade_dependents: bool = False,
  target_fields: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
  """Shift every descendant plan by the change in the later planned/actual end.

  Calendar-day offsets preserve every interval and overlap, including at merges.
  Completed tasks participate; their actual records are never shifted.
  """
  if calendar_type not in {"working", "calendar"}:
    raise ScheduleError("달력 유형은 working 또는 calendar여야 합니다.")
  new_start, new_finish = validate_date_range(planned_start, planned_finish)
  original = {str(task["id"]): dict(task) for task in tasks}
  if task_id not in original:
    raise ScheduleError("작업을 찾을 수 없습니다.")
  changed = {key: dict(value) for key, value in original.items()}
  changed[task_id].update(target_fields or {})
  changed[task_id]["planned_start"] = new_start.isoformat()
  changed[task_id]["planned_finish"] = new_finish.isoformat()

  topological_order(list(changed.values()))
  if not cascade_dependents:
    return [changed[str(task["id"])] for task in tasks]

  def later_finish(task: dict[str, Any]) -> date:
    return max(_date(value) for value in (task.get("planned_finish"), task.get("actual_finish")) if value)

  offset = later_finish(changed[task_id]) - later_finish(original[task_id])
  if not offset.days:
    return [changed[str(task["id"])] for task in tasks]

  outgoing: dict[str, set[str]] = {key: set() for key in changed}
  for task in changed.values():
    for predecessor in task.get("dependencies", []) or []:
      outgoing[str(predecessor)].add(str(task["id"]))
  descendants: set[str] = set()
  pending = list(outgoing[task_id])
  while pending:
    descendant = pending.pop()
    if descendant in descendants:
      continue
    descendants.add(descendant)
    pending.extend(outgoing[descendant])

  for current_id in descendants:
    old_start, old_finish = validate_date_range(
      original[current_id].get("planned_start", ""), original[current_id].get("planned_finish", "")
    )
    try:
      changed[current_id]["planned_start"] = (old_start + offset).isoformat()
      changed[current_id]["planned_finish"] = (old_finish + offset).isoformat()
    except OverflowError as exc:
      raise ScheduleError("후행 작업 날짜가 지원 범위를 벗어납니다.") from exc

  return [changed[str(task["id"])] for task in tasks]
