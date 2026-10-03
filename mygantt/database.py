"""SQLite persistence and snapshot-based project/template operations."""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from .scheduler import ScheduleError, schedule_tasks, topological_order


SAMPLE_TEMPLATE = {
  "name": "보드 제작 기본 공정",
  "description": "PCB·소자 발주부터 코팅 입고검사까지. 기간은 편집 가능한 샘플 기본값입니다.",
  "tasks": [
    {"key": "pcb_order", "name": "PCB발주", "duration_value": 1, "duration_unit": "weeks", "dependencies": [], "owner": "구매팀", "handoff": "PCB 입고검사 담당자에게 PCB 전달"},
    {"key": "pcb_inspection", "name": "PCB입고검사", "duration_value": 2, "duration_unit": "days", "dependencies": ["pcb_order"], "owner": "품질팀", "handoff": "자삽 담당자에게 합격 PCB 전달"},
    {"key": "parts_order", "name": "소자발주", "duration_value": 1, "duration_unit": "weeks", "dependencies": [], "owner": "구매팀", "handoff": "자삽 담당자에게 소자 전달"},
    {"key": "assembly", "name": "자삽", "duration_value": 3, "duration_unit": "days", "dependencies": ["pcb_inspection", "parts_order"], "owner": "외주 자삽 업체", "handoff": "PBA입고검사 담당자에게 조립품 전달"},
    {"key": "pba_inspection", "name": "PBA입고검사", "duration_value": 2, "duration_unit": "days", "dependencies": ["assembly"], "owner": "품질팀", "handoff": "PBA기능검사 담당자에게 합격품 전달"},
    {"key": "pba_function", "name": "PBA기능검사", "duration_value": 3, "duration_unit": "days", "dependencies": ["pba_inspection"], "owner": "개발팀", "handoff": "코팅 담당자에게 검사 완료품 전달"},
    {"key": "coating", "name": "코팅", "duration_value": 2, "duration_unit": "days", "dependencies": ["pba_function"], "owner": "외주 코팅 업체", "handoff": "코팅 입고검사 담당자에게 회수품 전달"},
    {"key": "coating_inspection", "name": "코팅 입고검사", "duration_value": 1, "duration_unit": "days", "dependencies": ["coating"], "owner": "품질팀", "handoff": "후속 조립 또는 출하 담당자에게 인계"},
  ],
}

SAMPLE_BATCHES = [
  "MARKOS MAIN보드 50EA",
  "MARKOS MAIN보드 200EA",
  "MARKOS DIB보드 50EA",
  "VIDEO",
  "OUTPUT",
  "ICE640N 메인보드",
]

PROJECT_COLORS = ["#5872d9", "#b96749", "#27897f", "#a45ca8", "#b48527", "#3978a8", "#c45670", "#5a8d45", "#765bb2", "#368a9b", "#c06f2d", "#657386"]
TASK_COLORS = ["#5872d9", "#b96749", "#27897f", "#a45ca8", "#b48527", "#3978a8", "#c45670", "#5a8d45", "#765bb2", "#368a9b", "#c06f2d", "#657386"]


def now_iso() -> str:
  return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id() -> str:
  return str(uuid.uuid4())


def json_load(value: str | None, fallback: Any) -> Any:
  if value is None:
    return fallback
  return json.loads(value)


class Database:
  def __init__(self, path: str | Path, holiday_fetcher=None):
    self.path = str(path)
    from .holiday_calendar import fetch_public_holidays
    self.holiday_fetcher = holiday_fetcher or fetch_public_holidays
    self.holiday_lock = threading.Lock()
    Path(self.path).parent.mkdir(parents=True, exist_ok=True)
    self.initialize()

  def connect(self) -> sqlite3.Connection:
    connection = sqlite3.connect(self.path)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    return connection

  @contextmanager
  def connection(self):
    connection = self.connect()
    try:
      yield connection
      connection.commit()
    except Exception:
      connection.rollback()
      raise
    finally:
      connection.close()

  def initialize(self) -> None:
    with self.connection() as db:
      db.executescript("""
        CREATE TABLE IF NOT EXISTS templates (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          project_color TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS template_tasks (
          id TEXT PRIMARY KEY,
          template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
          task_key TEXT NOT NULL,
          name TEXT NOT NULL,
          duration_value INTEGER NOT NULL,
          duration_unit TEXT NOT NULL,
          dependencies TEXT NOT NULL DEFAULT '[]',
          owner TEXT NOT NULL DEFAULT '',
          handoff TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL,
          UNIQUE(template_id, task_key)
        );
        CREATE TABLE IF NOT EXISTS projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          template_id TEXT,
          template_name TEXT NOT NULL,
          start_date TEXT NOT NULL,
          calendar_type TEXT NOT NULL,
          color TEXT NOT NULL DEFAULT '',
          group_name TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS project_tasks (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          template_task_key TEXT NOT NULL,
          name TEXT NOT NULL,
          duration_value INTEGER NOT NULL,
          duration_unit TEXT NOT NULL,
          dependencies TEXT NOT NULL DEFAULT '[]',
          owner TEXT NOT NULL DEFAULT '',
          handoff TEXT NOT NULL DEFAULT '',
          blocker TEXT NOT NULL DEFAULT '',
          status TEXT NOT NULL DEFAULT 'todo',
          planned_start TEXT NOT NULL DEFAULT '',
          planned_finish TEXT NOT NULL DEFAULT '',
          actual_start TEXT NOT NULL DEFAULT '',
          actual_finish TEXT NOT NULL DEFAULT '',
          notes TEXT NOT NULL DEFAULT '',
          color TEXT NOT NULL DEFAULT '',
          group_name TEXT NOT NULL DEFAULT '',
          tags TEXT NOT NULL DEFAULT '[]',
          sort_order INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS project_tasks_project_order ON project_tasks(project_id, sort_order);
        CREATE TABLE IF NOT EXISTS project_creation_requests (
          request_id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS holiday_cache (
          year INTEGER PRIMARY KEY,
          source TEXT NOT NULL,
          source_url TEXT NOT NULL DEFAULT '',
          attempted_at TEXT NOT NULL DEFAULT '',
          last_success_at TEXT NOT NULL DEFAULT '',
          last_error TEXT NOT NULL DEFAULT '',
          holidays_json TEXT NOT NULL DEFAULT '[]'
        );
      """)
      self._migrate(db)
      self._seed_holiday_fallback(db)
      count = db.execute("SELECT COUNT(*) FROM templates").fetchone()[0]
      if count == 0:
        self._seed(db)

  def _seed(self, db: sqlite3.Connection) -> None:
    template_id = new_id()
    stamp = now_iso()
    db.execute("INSERT INTO templates (id, name, description, project_color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", (template_id, SAMPLE_TEMPLATE["name"], SAMPLE_TEMPLATE["description"], PROJECT_COLORS[0], stamp, stamp))
    key_to_id = {task["key"]: new_id() for task in SAMPLE_TEMPLATE["tasks"]}
    tasks = []
    for index, task in enumerate(SAMPLE_TEMPLATE["tasks"]):
      tasks.append({**task, "id": key_to_id[task["key"]], "dependencies": [key_to_id[key] for key in task["dependencies"]], "sort_order": index, "color": TASK_COLORS[index % len(TASK_COLORS)]})
    self._insert_template_tasks(db, template_id, tasks)
    for offset, name in enumerate(SAMPLE_BATCHES):
      project_id = new_id()
      start_date = date.today().isoformat()
      project_color = PROJECT_COLORS[offset % len(PROJECT_COLORS)]
      db.execute("INSERT INTO projects (id, name, template_id, template_name, start_date, calendar_type, color, group_name, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (project_id, name, template_id, SAMPLE_TEMPLATE["name"], start_date, "working", project_color, "", "[]", stamp, stamp))
      snapshot = []
      project_task_ids = {task["id"]: new_id() for task in tasks}
      for task in tasks:
        snapshot.append({
          "id": project_task_ids[task["id"]], "template_task_key": task["key"], "name": task["name"],
          "duration_value": task["duration_value"], "duration_unit": task["duration_unit"],
          "dependencies": [project_task_ids[dependency] for dependency in task["dependencies"]], "owner": task["owner"], "handoff": task["handoff"],
          "blocker": "", "status": "todo", "planned_start": "", "planned_finish": "",
          "actual_start": "", "actual_finish": "", "notes": "", "sort_order": task["sort_order"],
          "color": TASK_COLORS[(offset * 3 + task["sort_order"]) % len(TASK_COLORS)], "group_name": "", "tags": [],
        })
      scheduled = schedule_tasks(snapshot, start_date, "working")
      self._insert_project_tasks(db, project_id, scheduled)

  def _insert_template_tasks(self, db: sqlite3.Connection, template_id: str, tasks: list[dict[str, Any]]) -> None:
    for index, task in enumerate(tasks):
      db.execute("""INSERT INTO template_tasks
        (id, template_id, task_key, name, duration_value, duration_unit, dependencies, owner, handoff, color, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (
        task.get("id") or new_id(), template_id, task["key"], task["name"], int(task["duration_value"]),
        task["duration_unit"], json.dumps(task.get("dependencies", []), ensure_ascii=False),
        task.get("owner", ""), task.get("handoff", ""), self._validate_color(task.get("color")) or TASK_COLORS[index % len(TASK_COLORS)], int(task.get("sort_order", index)),
      ))

  def _insert_project_tasks(self, db: sqlite3.Connection, project_id: str, tasks: list[dict[str, Any]]) -> None:
    for index, task in enumerate(tasks):
      db.execute("""INSERT INTO project_tasks
        (id, project_id, template_task_key, name, duration_value, duration_unit, dependencies, owner, handoff,
        blocker, status, planned_start, planned_finish, actual_start, actual_finish, notes, color, group_name, tags, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (
        task.get("id") or new_id(), project_id, task.get("template_task_key", task.get("key", "")), task["name"],
        int(task["duration_value"]), task["duration_unit"], json.dumps(task.get("dependencies", []), ensure_ascii=False),
        task.get("owner", ""), task.get("handoff", ""), task.get("blocker", ""), task.get("status", "todo"),
        task.get("planned_start", ""), task.get("planned_finish", ""), task.get("actual_start", ""),
        task.get("actual_finish", ""), task.get("notes", ""), task.get("color", TASK_COLORS[index % len(TASK_COLORS)]),
        str(task.get("group_name", "")), json.dumps(self._normalize_tags(task.get("tags", [])), ensure_ascii=False), int(task.get("sort_order", index)),
      ))

  def _migrate(self, db: sqlite3.Connection) -> None:
    """Add inspector fields to older local databases without replacing user data."""
    columns = {
      "templates": {
        "project_color": "TEXT NOT NULL DEFAULT ''",
      },
      "template_tasks": {
        "color": "TEXT NOT NULL DEFAULT ''",
      },
      "projects": {
        "color": "TEXT NOT NULL DEFAULT ''",
        "group_name": "TEXT NOT NULL DEFAULT ''",
        "tags": "TEXT NOT NULL DEFAULT '[]'",
      },
      "project_tasks": {
        "color": "TEXT NOT NULL DEFAULT ''",
        "group_name": "TEXT NOT NULL DEFAULT ''",
        "tags": "TEXT NOT NULL DEFAULT '[]'",
      },
    }
    for table, fields in columns.items():
      existing = {row[1] for row in db.execute(f"PRAGMA table_info({table})")}
      for field, declaration in fields.items():
        if field not in existing:
          db.execute(f"ALTER TABLE {table} ADD COLUMN {field} {declaration}")

    project_rows = list(db.execute("SELECT id, color FROM projects ORDER BY created_at, id"))
    project_indexes = {row["id"]: index for index, row in enumerate(project_rows)}
    for index, row in enumerate(project_rows):
      if not row["color"]:
        db.execute("UPDATE projects SET color=? WHERE id=?", (PROJECT_COLORS[index % len(PROJECT_COLORS)], row["id"]))
    for row in db.execute("SELECT id, project_id, sort_order, color FROM project_tasks ORDER BY project_id, sort_order, id"):
      if not row["color"]:
        color_index = (project_indexes.get(row["project_id"], 0) * 3 + int(row["sort_order"])) % len(TASK_COLORS)
        db.execute("UPDATE project_tasks SET color=? WHERE id=?", (TASK_COLORS[color_index], row["id"]))

    template_rows = list(db.execute("SELECT id, project_color FROM templates ORDER BY created_at, id"))
    template_indexes = {row["id"]: index for index, row in enumerate(template_rows)}
    for index, row in enumerate(template_rows):
      if not row["project_color"]:
        db.execute("UPDATE templates SET project_color=? WHERE id=?", (PROJECT_COLORS[index % len(PROJECT_COLORS)], row["id"]))
    for row in db.execute("SELECT id, template_id, sort_order, color FROM template_tasks ORDER BY template_id, sort_order, id"):
      if not row["color"]:
        color_index = (template_indexes.get(row["template_id"], 0) * 3 + int(row["sort_order"])) % len(TASK_COLORS)
        db.execute("UPDATE template_tasks SET color=? WHERE id=?", (TASK_COLORS[color_index], row["id"]))

  @staticmethod
  def _seed_holiday_fallback(db: sqlite3.Connection) -> None:
    from .holiday_calendar import BUNDLED_HOLIDAYS_2026, FALLBACK_SOURCE, FALLBACK_SOURCE_URL
    db.execute(
      "INSERT OR IGNORE INTO holiday_cache (year, source, source_url, attempted_at, last_success_at, last_error, holidays_json) VALUES (?, ?, ?, '', '', '', ?)",
      (2026, FALLBACK_SOURCE, FALLBACK_SOURCE_URL, json.dumps(BUNDLED_HOLIDAYS_2026, ensure_ascii=False)),
    )

  @staticmethod
  def _normalize_tags(value: Any) -> list[str]:
    if isinstance(value, str):
      values = value.split(",")
    elif isinstance(value, list):
      values = value
    else:
      raise ScheduleError("태그는 쉼표로 구분한 문자열 또는 배열이어야 합니다.")
    return list(dict.fromkeys(str(item).strip() for item in values if str(item).strip()))[:20]

  @staticmethod
  def _validate_color(value: Any) -> str:
    color = str(value or "").strip()
    if not color:
      return ""
    if len(color) != 7 or color[0] != "#" or any(char not in "0123456789abcdefABCDEF" for char in color[1:]):
      raise ScheduleError("색상은 #RRGGBB 형식이어야 합니다.")
    return color.lower()

  def _template(self, db: sqlite3.Connection, template_id: str) -> dict[str, Any] | None:
    row = db.execute("SELECT * FROM templates WHERE id=?", (template_id,)).fetchone()
    if not row:
      return None
    tasks = []
    for task in db.execute("SELECT * FROM template_tasks WHERE template_id=? ORDER BY sort_order", (template_id,)):
      item = dict(task)
      item["key"] = item.pop("task_key")
      item["dependencies"] = json_load(item.pop("dependencies"), [])
      tasks.append(item)
    return {**dict(row), "tasks": tasks}

  def _project(self, db: sqlite3.Connection, project_id: str) -> dict[str, Any] | None:
    row = db.execute("SELECT * FROM projects WHERE id=?", (project_id,)).fetchone()
    if not row:
      return None
    tasks = []
    for task in db.execute("SELECT * FROM project_tasks WHERE project_id=? ORDER BY sort_order", (project_id,)):
      item = dict(task)
      item["dependencies"] = json_load(item["dependencies"], [])
      item["tags"] = json_load(item.get("tags"), [])
      tasks.append(item)
    completed = sum(1 for task in tasks if task["status"] == "done")
    total = len(tasks)
    project = dict(row)
    project["tags"] = json_load(project.get("tags"), [])
    return {**project, "tasks": tasks, "progress": round(100 * completed / total) if total else 0}

  def state(self) -> dict[str, Any]:
    with self.connection() as db:
      templates = [self._template(db, row[0]) for row in db.execute("SELECT id FROM templates ORDER BY name")]
      projects = [self._project(db, row[0]) for row in db.execute("SELECT id FROM projects ORDER BY start_date, name")]
      return {"templates": templates, "projects": projects}

  def holidays(self, start: str | None = None, end: str | None = None, *, now: datetime | None = None, fetcher=None) -> dict[str, Any]:
    from .holiday_calendar import calendar_payload
    return calendar_payload(self, start, end, now=now, fetcher=fetcher)

  def get_template(self, template_id: str) -> dict[str, Any] | None:
    with self.connection() as db:
      return self._template(db, template_id)

  def save_template(self, payload: dict[str, Any], template_id: str | None = None) -> dict[str, Any]:
    name = str(payload.get("name", "")).strip()
    tasks = payload.get("tasks")
    if not name or not isinstance(tasks, list) or not tasks:
      raise ScheduleError("템플릿 이름과 1개 이상의 작업이 필요합니다.")
    prepared = []
    key_ids: dict[str, str] = {}
    for index, task in enumerate(tasks):
      key = str(task.get("key") or f"task_{index + 1}")
      if key in key_ids:
        raise ScheduleError("템플릿 작업 key가 중복되었습니다.")
      key_ids[key] = new_id()
      prepared.append({**task, "key": key, "id": key_ids[key], "sort_order": index, "color": self._validate_color(task.get("color")) or TASK_COLORS[index % len(TASK_COLORS)]})
    for task in prepared:
      deps = task.get("dependencies", []) or []
      task["dependencies"] = [key_ids.get(dep, dep) for dep in deps]
    # Ensure dependencies target keys in the submitted template and reject cycles.
    allowed = set(key_ids.values())
    if any(dep not in allowed for task in prepared for dep in task["dependencies"]):
      raise ScheduleError("선행 작업이 템플릿에 없습니다.")
    for task in prepared:
      task["id"] = key_ids[task["key"]]
    topological_order(prepared)
    with self.connection() as db:
      stamp = now_iso()
      if template_id:
        current = db.execute("SELECT project_color FROM templates WHERE id=?", (template_id,)).fetchone()
        if not current:
          return None
        project_color = self._validate_color(payload.get("project_color")) or current["project_color"] or self._next_template_color(db)
        db.execute("UPDATE templates SET name=?, description=?, project_color=?, updated_at=? WHERE id=?", (name, payload.get("description", ""), project_color, stamp, template_id))
        db.execute("DELETE FROM template_tasks WHERE template_id=?", (template_id,))
      else:
        template_id = new_id()
        project_color = self._validate_color(payload.get("project_color")) or self._next_template_color(db)
        db.execute("INSERT INTO templates (id, name, description, project_color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", (template_id, name, payload.get("description", ""), project_color, stamp, stamp))
      self._insert_template_tasks(db, template_id, prepared)
      return self._template(db, template_id)

  def instantiate(self, payload: dict[str, Any]) -> dict[str, Any]:
    template_id = str(payload.get("template_id", ""))
    name = str(payload.get("name", "")).strip()
    start_date = str(payload.get("start_date", ""))
    calendar_type = str(payload.get("calendar_type", "working"))
    request_id = str(payload.get("request_id", "")).strip()
    if not name or not start_date:
      raise ScheduleError("프로젝트 이름과 시작일이 필요합니다.")
    date.fromisoformat(start_date)
    if calendar_type not in {"working", "calendar"}:
      raise ScheduleError("달력 유형은 working 또는 calendar여야 합니다.")
    with self.connection() as db:
      if request_id:
        prior = db.execute("SELECT project_id FROM project_creation_requests WHERE request_id=?", (request_id,)).fetchone()
        if prior:
          existing = self._project(db, prior[0])
          if existing:
            return existing
      template = self._template(db, template_id)
      if not template:
        raise ScheduleError("템플릿을 찾을 수 없습니다.")
      project_id = new_id()
      stamp = now_iso()
      color = self._validate_color(payload.get("color")) or template.get("project_color") or self._next_project_color(db)
      group_name = str(payload.get("group_name", "")).strip()
      tags = json.dumps(self._normalize_tags(payload.get("tags", [])), ensure_ascii=False)
      db.execute("INSERT INTO projects (id, name, template_id, template_name, start_date, calendar_type, color, group_name, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (project_id, name, template_id, template["name"], start_date, calendar_type, color, group_name, tags, stamp, stamp))
      snapshot = []
      key_map = {task["key"]: new_id() for task in template["tasks"]}
      old_id_to_key = {task["id"]: task["key"] for task in template["tasks"]}
      for task in template["tasks"]:
        snapshot.append({
          "id": key_map[task["key"]], "template_task_key": task["key"], "name": task["name"],
          "duration_value": task["duration_value"], "duration_unit": task["duration_unit"],
          "dependencies": [key_map[old_id_to_key[dep]] for dep in task["dependencies"]],
          "owner": task["owner"], "handoff": task["handoff"], "sort_order": task["sort_order"],
          "status": "todo", "blocker": "", "planned_start": "", "planned_finish": "",
          "actual_start": "", "actual_finish": "", "notes": "",
          "color": task.get("color") or TASK_COLORS[task["sort_order"] % len(TASK_COLORS)],
          "group_name": "", "tags": [],
        })
      scheduled = schedule_tasks(snapshot, start_date, calendar_type)
      self._insert_project_tasks(db, project_id, scheduled)
      if request_id:
        db.execute("INSERT INTO project_creation_requests VALUES (?, ?)", (request_id, project_id))
      return self._project(db, project_id)

  def get_project(self, project_id: str) -> dict[str, Any] | None:
    with self.connection() as db:
      return self._project(db, project_id)

  def update_project(self, project_id: str, fields: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {"name", "start_date", "calendar_type", "color", "group_name", "tags"}
    if set(fields) - allowed:
      raise ScheduleError("수정할 수 없는 프로젝트 필드입니다.")
    with self.connection() as db:
      project = self._project(db, project_id)
      if not project:
        return None
      updated = {**project, **fields}
      if not str(updated.get("name", "")).strip():
        raise ScheduleError("프로젝트 이름을 입력하세요.")
      date.fromisoformat(updated["start_date"])
      if updated["calendar_type"] not in {"working", "calendar"}:
        raise ScheduleError("달력 유형은 working 또는 calendar여야 합니다.")
      color = self._validate_color(updated.get("color")) or project["color"]
      tags = json.dumps(self._normalize_tags(updated.get("tags", [])), ensure_ascii=False)
      group_name = str(updated.get("group_name", "")).strip()
      db.execute("UPDATE projects SET name=?, start_date=?, calendar_type=?, color=?, group_name=?, tags=?, updated_at=? WHERE id=?", (str(updated["name"]).strip(), updated["start_date"], updated["calendar_type"], color, group_name, tags, now_iso(), project_id))
      tasks = project["tasks"]
      scheduled = schedule_tasks(tasks, updated["start_date"], updated["calendar_type"])
      for task in scheduled:
        db.execute("UPDATE project_tasks SET planned_start=?, planned_finish=? WHERE id=?", (task["planned_start"], task["planned_finish"], task["id"]))
      return self._project(db, project_id)

  def update_task(self, task_id: str, fields: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {"name", "duration_value", "duration_unit", "dependencies", "owner", "handoff", "blocker", "status", "actual_start", "actual_finish", "notes", "color", "group_name", "tags"}
    if set(fields) - allowed:
      raise ScheduleError("수정할 수 없는 작업 필드입니다.")
    if "status" in fields and fields["status"] not in {"todo", "doing", "blocked", "done"}:
      raise ScheduleError("작업 상태가 올바르지 않습니다.")
    if "duration_value" in fields and (int(fields["duration_value"]) < 1 or int(fields["duration_value"]) > 520):
      raise ScheduleError("기간은 1~520 사이여야 합니다.")
    if "duration_unit" in fields and fields["duration_unit"] not in {"days", "weeks"}:
      raise ScheduleError("기간 단위가 올바르지 않습니다.")
    with self.connection() as db:
      row = db.execute("SELECT project_id FROM project_tasks WHERE id=?", (task_id,)).fetchone()
      if not row:
        return None
      project_id = row[0]
      project = self._project(db, project_id)
      target = next(task for task in project["tasks"] if task["id"] == task_id)
      deps = fields.get("dependencies", target["dependencies"])
      if not isinstance(deps, list):
        raise ScheduleError("선행 작업 형식이 올바르지 않습니다.")
      new_target = {**target, **fields, "dependencies": deps}
      if not str(new_target.get("name", "")).strip():
        raise ScheduleError("작업명을 입력하세요.")
      new_target["color"] = self._validate_color(new_target.get("color")) or target["color"]
      new_target["group_name"] = str(new_target.get("group_name", "")).strip()
      new_target["tags"] = self._normalize_tags(new_target.get("tags", []))
      tasks = [new_target if task["id"] == task_id else task for task in project["tasks"]]
      scheduled = schedule_tasks(tasks, project["start_date"], project["calendar_type"])
      for task in scheduled:
        db.execute("""UPDATE project_tasks SET name=?, duration_value=?, duration_unit=?, dependencies=?, owner=?, handoff=?, blocker=?, status=?, planned_start=?, planned_finish=?, actual_start=?, actual_finish=?, notes=?, color=?, group_name=?, tags=? WHERE id=?""", (
          task["name"], int(task["duration_value"]), task["duration_unit"], json.dumps(task["dependencies"], ensure_ascii=False),
          task.get("owner", ""), task.get("handoff", ""), task.get("blocker", ""), task.get("status", "todo"),
          task["planned_start"], task["planned_finish"], task.get("actual_start", ""), task.get("actual_finish", ""), task.get("notes", ""),
          task.get("color", ""), str(task.get("group_name", "")), json.dumps(self._normalize_tags(task.get("tags", [])), ensure_ascii=False), task["id"],
        ))
      db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now_iso(), project_id))
      return self._project(db, project_id)

  def _next_project_color(self, db: sqlite3.Connection) -> str:
    used = [row[0] for row in db.execute("SELECT color FROM projects WHERE color != ''")]
    counts = {color: used.count(color) for color in PROJECT_COLORS}
    return min(PROJECT_COLORS, key=lambda color: (counts[color], PROJECT_COLORS.index(color)))

  def _next_template_color(self, db: sqlite3.Connection) -> str:
    used = [row[0] for row in db.execute("SELECT project_color FROM templates WHERE project_color != ''")]
    counts = {color: used.count(color) for color in PROJECT_COLORS}
    return min(PROJECT_COLORS, key=lambda color: (counts[color], PROJECT_COLORS.index(color)))

  def calendar_ics(self, project_id: str | None = None) -> str:
    projects = self.state()["projects"]
    if project_id:
      projects = [project for project in projects if project["id"] == project_id]
    if project_id and not projects:
      raise KeyError(project_id)
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//MyGantt//Local Schedule//KO", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"]
    for project in projects:
      for task in project["tasks"]:
        start = task.get("planned_start")
        finish = task.get("planned_finish")
        if not start or not finish:
          continue
        uid = f"{task['id']}@mygantt.local"
        end_exclusive = date.fromisoformat(finish).toordinal() + 1
        end = date.fromordinal(end_exclusive).strftime("%Y%m%d")
        summary = self._ics_escape(f"{project['name']} · {task['name']}")
        description = self._ics_escape(f"담당: {task.get('owner') or '미지정'}\n상태: {task.get('status')}\n다음 인계: {task.get('handoff') or '미지정'}")
        lines.extend(["BEGIN:VEVENT", f"UID:{uid}", f"DTSTAMP:{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}", f"DTSTART;VALUE=DATE:{date.fromisoformat(start).strftime('%Y%m%d')}", f"DTEND;VALUE=DATE:{end}", f"SUMMARY:{summary}", f"DESCRIPTION:{description}", "END:VEVENT"])
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"

  @staticmethod
  def _ics_escape(value: str) -> str:
    return value.replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")
