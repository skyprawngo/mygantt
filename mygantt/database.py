"""SQLite persistence and snapshot-based project/template operations."""

from __future__ import annotations

import json
import hashlib
import unicodedata
import sqlite3
import threading
import uuid
from contextlib import contextmanager
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from .scheduler import ScheduleError, schedule_tasks, topological_order, update_schedule_dates, validate_date_range, template_start_day, duration_days


SAMPLE_TEMPLATE = json.loads(Path(__file__).with_name('seed_template.json').read_text(encoding='utf-8'))

SAMPLE_BATCHES = [
  "MARKOS MAIN보드 50EA",
  "MARKOS MAIN보드 200EA",
  "MARKOS DIB보드 50EA",
  "VIDEO",
  "OUTPUT",
  "ICE640N 메인보드",
]

UNASSIGNED_PROJECT_ID = "__unassigned__"

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
  def __init__(self, path: str | Path, holiday_fetcher=None, *, seed_samples: bool = True):
    self.path = str(path)
    self.seed_samples = seed_samples
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
    from .directory_schema import backup_before_migration, migrate
    backup_before_migration(self.path)
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
      migrate(db, now_iso())
      self._migrate_project_order(db)
      # Retain existing Korean cache rows while introducing country/year keys.
      if "country" not in {row[1] for row in db.execute("PRAGMA table_info(holiday_cache)")}:
        db.execute("ALTER TABLE holiday_cache RENAME TO holiday_cache_legacy")
        db.execute("""CREATE TABLE holiday_cache (
          country TEXT NOT NULL DEFAULT 'KR', year INTEGER NOT NULL,
          source TEXT NOT NULL, source_url TEXT NOT NULL DEFAULT '',
          attempted_at TEXT NOT NULL DEFAULT '', last_success_at TEXT NOT NULL DEFAULT '',
          last_error TEXT NOT NULL DEFAULT '', holidays_json TEXT NOT NULL DEFAULT '[]',
          PRIMARY KEY(country, year))""")
        db.execute("INSERT INTO holiday_cache SELECT 'KR', * FROM holiday_cache_legacy")
        db.execute("DROP TABLE holiday_cache_legacy")
      db.execute("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
      self._seed_holiday_fallback(db)
      count = db.execute("SELECT COUNT(*) FROM templates").fetchone()[0]
      seeded = db.execute("SELECT 1 FROM schema_migrations WHERE migration_key='sample-initialized'").fetchone()
      if self.seed_samples and not seeded:
        if count == 0 and not db.execute("SELECT 1 FROM projects LIMIT 1").fetchone():
          self._seed(db)
        db.execute("INSERT INTO schema_migrations(migration_key,applied_at) VALUES ('sample-initialized',?)", (now_iso(),))
      self._normalize_project_order(db)
      for row in db.execute("SELECT id FROM projects").fetchall():
        self._normalize_task_order(db, row[0])

  def _seed(self, db: sqlite3.Connection) -> None:
    template_id = new_id()
    stamp = now_iso()
    db.execute("INSERT INTO templates (id, name, description, project_color, calendar_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)", (template_id, SAMPLE_TEMPLATE["name"], SAMPLE_TEMPLATE["description"], SAMPLE_TEMPLATE["project_color"], SAMPLE_TEMPLATE["calendar_type"], stamp, stamp))
    key_to_id = {task["key"]: new_id() for task in SAMPLE_TEMPLATE["tasks"]}
    tasks = []
    for index, task in enumerate(SAMPLE_TEMPLATE["tasks"]):
      tasks.append({**task, "id": key_to_id[task["key"]], "dependencies": [key_to_id[key] for key in task["dependencies"]], "sort_order": index, "color": task.get("color", TASK_COLORS[index % len(TASK_COLORS)])})
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
          "duration_value": task["duration_value"], "duration_unit": task["duration_unit"], "start_day": task.get("start_day"),
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
        (id, template_id, task_key, name, duration_value, duration_unit, dependencies, owner, handoff, color, sort_order, start_day)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""", (
        task.get("id") or new_id(), template_id, task["key"], task["name"], int(task["duration_value"]),
        task["duration_unit"], json.dumps(task.get("dependencies", []), ensure_ascii=False),
        self._canonical_owner(db, task.get("owner", "")), task.get("handoff", ""), self._validate_color(task.get("color")) or TASK_COLORS[index % len(TASK_COLORS)], int(task.get("sort_order", index)), task.get("start_day"),
      ))

  def _insert_project_tasks(self, db: sqlite3.Connection, project_id: str, tasks: list[dict[str, Any]]) -> None:
    columns = {row[1] for row in db.execute("PRAGMA table_info(project_tasks)")}
    for index, task in enumerate(tasks):
      names = ["id", "project_id", "template_task_key", "name", "dependencies", "owner", "handoff", "blocker", "status", "planned_start", "planned_finish", "actual_start", "actual_finish", "notes", "color", "group_name", "tags", "sort_order"]
      values = [
        task.get("id") or new_id(), project_id, task.get("template_task_key", task.get("key", "")), task["name"],
        json.dumps(task.get("dependencies", []), ensure_ascii=False), self._canonical_owner(db, task.get("owner", "")), task.get("handoff", ""), task.get("blocker", ""), task.get("status", "todo"),
        task.get("planned_start", ""), task.get("planned_finish", ""), task.get("actual_start", ""), task.get("actual_finish", ""), task.get("notes", ""),
        task.get("color", TASK_COLORS[index % len(TASK_COLORS)]), str(task.get("group_name", "")), json.dumps(self._normalize_tags(task.get("tags", [])), ensure_ascii=False), int(task.get("sort_order", index)),
      ]
      # Keep old local schemas writable, but never read or use these fields for scheduling.
      if {"duration_value", "duration_unit"} <= columns:
        names[4:4] = ["duration_value", "duration_unit"]
        values[4:4] = [int(task.get("duration_value", 1)), str(task.get("duration_unit", "days"))]
      placeholders = ", ".join("?" for _ in names)
      db.execute(f"INSERT INTO project_tasks ({', '.join(names)}) VALUES ({placeholders})", values)
    self._normalize_task_order(db, project_id)

  @staticmethod
  def _normalize_task_order(db, project_id):
    rows = db.execute("SELECT id,sort_order FROM project_tasks WHERE project_id=? ORDER BY sort_order,id", (project_id,)).fetchall()
    for order, row in enumerate(rows, 1):
      if row["sort_order"] != order:
        db.execute("UPDATE project_tasks SET sort_order=? WHERE id=?", (order, row["id"]))

  @staticmethod
  def _normalize_project_order(db):
    # Keep assigned relative order; append unnumbered legacy projects in their
    # original display order. This also repairs gaps and duplicate numbers.
    rows = db.execute("""SELECT id,sort_order FROM projects WHERE id!='__unassigned__'
      ORDER BY CASE WHEN sort_order > 0 THEN 0 ELSE 1 END,
               CASE WHEN sort_order > 0 THEN sort_order END,start_date,name,id""").fetchall()
    for order, row in enumerate(rows, 1):
      if row["sort_order"] != order:
        db.execute("UPDATE projects SET sort_order=? WHERE id=?", (order, row["id"]))

  def _migrate_project_order(self, db):
    if "sort_order" in {row[1] for row in db.execute("PRAGMA table_info(projects)")}:
      return
    db.execute("ALTER TABLE projects ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
    rows = db.execute("SELECT id FROM projects WHERE id!='__unassigned__' ORDER BY start_date,name,id").fetchall()
    for order, row in enumerate(rows, 1):
      db.execute("UPDATE projects SET sort_order=? WHERE id=?", (order, row[0]))
    db.execute("""UPDATE directory_entries SET sort_order=(SELECT sort_order FROM projects WHERE projects.id=directory_entries.project_id) WHERE kind='project'""")
    db.execute("""CREATE TRIGGER project_order_append AFTER INSERT ON projects
      WHEN NEW.id!='__unassigned__'
      BEGIN
        UPDATE projects SET sort_order=(SELECT COALESCE(MAX(sort_order),0)+1 FROM projects WHERE id!=NEW.id AND id!='__unassigned__') WHERE id=NEW.id;
      END""")
    db.execute("""CREATE TRIGGER directory_project_order AFTER UPDATE OF sort_order ON projects
      WHEN NEW.id!='__unassigned__'
      BEGIN
        INSERT INTO directory_entries(id,parent_id,kind,project_id,name,sort_order)
        VALUES ('project:'||NEW.id,'root','project',NEW.id,NEW.name,NEW.sort_order)
        ON CONFLICT(id) DO UPDATE SET sort_order=excluded.sort_order;
      END""")

  def duplicate_row(self, payload):
    kind, source_id = payload.get("kind"), payload.get("source_id")
    if kind not in {"project", "task"} or not isinstance(source_id, str):
      raise ScheduleError("복사할 행이 올바르지 않습니다.")
    with self.connection() as db:
      db.execute("BEGIN IMMEDIATE")
      table = "projects" if kind == "project" else "project_tasks"
      source = db.execute(f"SELECT * FROM {table} WHERE id=?", (source_id,)).fetchone()
      if not source or source_id == UNASSIGNED_PROJECT_ID:
        raise ScheduleError("복사할 행을 찾을 수 없습니다.")
      def insert(table, record):
        columns = list(record)
        db.execute(f"INSERT INTO {table} ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})", list(record.values()))
      if kind == "project":
        project = dict(source)
        project_id = new_id()
        project.update(id=project_id, created_at=now_iso(), updated_at=now_iso())
        insert("projects", project)
        tasks = [dict(row) for row in db.execute("SELECT * FROM project_tasks WHERE project_id=? ORDER BY sort_order,id", (source_id,))]
        ids = {task["id"]: new_id() for task in tasks}
        for task in tasks:
          task.update(id=ids[task["id"]], project_id=project_id,
                      dependencies=json.dumps([ids[dep] for dep in json_load(task["dependencies"], []) if dep in ids]))
          insert("project_tasks", task)
        return {"project": self._project(db, project_id), "selection": {"type":"project", "id":project_id}}
      project_id = payload.get("project_id") or source["project_id"]
      if not isinstance(project_id, str) or not self._project(db, project_id):
        raise ScheduleError("붙여넣을 프로젝트를 찾을 수 없습니다.")
      ids = [row[0] for row in db.execute("SELECT id FROM project_tasks WHERE project_id=? ORDER BY sort_order,id", (project_id,))]
      anchor = payload.get("anchor_id")
      if anchor is not None and anchor not in ids:
        raise ScheduleError("삽입 위치가 올바르지 않습니다.")
      task = dict(source)
      task.update(id=new_id(), project_id=project_id, sort_order=len(ids)+1)
      if project_id != source["project_id"]:
        task["dependencies"] = "[]"
      insert("project_tasks", task)
      ids.insert(ids.index(anchor)+1 if anchor else len(ids), task["id"])
      for order, ident in enumerate(ids, 1):
        db.execute("UPDATE project_tasks SET sort_order=? WHERE id=?", (order, ident))
      db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now_iso(), project_id))
      return {"project":self._project(db, project_id), "selection":{"type":"task", "id":task["id"]}}

  def reorder_project(self, project_id, anchor_id, after=False):
    if not isinstance(anchor_id, str) or type(after) is not bool:
      raise ScheduleError("삽입 위치가 올바르지 않습니다.")
    with self.connection() as db:
      db.execute("BEGIN IMMEDIATE")
      ids = [row[0] for row in db.execute("SELECT id FROM projects WHERE id!='__unassigned__' ORDER BY sort_order,id")]
      if project_id == UNASSIGNED_PROJECT_ID or anchor_id not in ids:
        raise ScheduleError("프로젝트 사이에만 순서를 지정할 수 있습니다.")
      if project_id not in ids:
        return None
      if project_id != anchor_id:
        ids.remove(project_id)
        ids.insert(ids.index(anchor_id) + int(after), project_id)
        for order, ident in enumerate(ids, 1):
          db.execute("UPDATE projects SET sort_order=? WHERE id=?", (order, ident))
      return self._project(db, project_id)

  def reorder_task(self, task_id, anchor_id, after=False):
    if not isinstance(anchor_id, str) or type(after) is not bool:
      raise ScheduleError("삽입 위치가 올바르지 않습니다.")
    with self.connection() as db:
      db.execute("BEGIN IMMEDIATE")
      task = db.execute("SELECT project_id FROM project_tasks WHERE id=?", (task_id,)).fetchone()
      if not task:
        return None
      project_id = task["project_id"]
      ids = [row[0] for row in db.execute("SELECT id FROM project_tasks WHERE project_id=? ORDER BY sort_order,id", (project_id,))]
      if anchor_id not in ids:
        raise ScheduleError("같은 프로젝트 안의 작업에만 순서를 지정할 수 있습니다.")
      if anchor_id != task_id:
        ids.remove(task_id)
        ids.insert(ids.index(anchor_id) + int(after), task_id)
        for index, ident in enumerate(ids, 1):
          db.execute("UPDATE project_tasks SET sort_order=? WHERE id=?", (index, ident))
        db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now_iso(), project_id))
      return self._project(db, project_id)

  def _migrate(self, db: sqlite3.Connection) -> None:
    """Add fields while keeping existing instance records intact."""
    migration_key = "instance-planned-dates-authoritative-v1"
    task_columns_before = {row[1] for row in db.execute("PRAGMA table_info(project_tasks)")}
    migration_exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").fetchone()
    applied = migration_exists and db.execute("SELECT 1 FROM schema_migrations WHERE migration_key=?", (migration_key,)).fetchone()
    if not applied and {"duration_value", "duration_unit"} & task_columns_before:
      self._backup_before_date_migration(db)
    db.execute("CREATE TABLE IF NOT EXISTS schema_migrations (migration_key TEXT PRIMARY KEY, applied_at TEXT NOT NULL)")
    if not applied:
      db.execute("INSERT OR IGNORE INTO schema_migrations VALUES (?, ?)", (migration_key, now_iso()))
    columns = {
      "templates": {
        "project_color": "TEXT NOT NULL DEFAULT ''",
        "calendar_type": "TEXT NOT NULL DEFAULT 'working'",
      },
      "template_tasks": {
        "color": "TEXT NOT NULL DEFAULT ''",
        "start_day": "INTEGER",
      },
      "projects": {
        "color": "TEXT NOT NULL DEFAULT ''",
        "group_name": "TEXT NOT NULL DEFAULT ''",
        "tags": "TEXT NOT NULL DEFAULT '[]'",
      },
      "project_tasks": {
        "progress": "INTEGER",
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

  def _backup_before_date_migration(self, db: sqlite3.Connection) -> None:
    """Make a consistent local snapshot before date-authority changes are marked."""
    if self.path == ":memory:":
      return
    source = Path(self.path)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = source.with_name(f"{source.name}.before-date-authority-{stamp}.bak")
    suffix = 1
    while backup.exists():
      backup = source.with_name(f"{source.name}.before-date-authority-{stamp}-{suffix}.bak")
      suffix += 1
    destination = sqlite3.connect(str(backup))
    try:
      db.backup(destination)
      destination.commit()
    finally:
      destination.close()

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
      # Legacy database files may retain these columns; dates are now the only
      # instance schedule properties exposed through the API.
      item["progress"] = item.get("progress") if item.get("progress") is not None else {"todo": 0, "doing": 10, "blocked": 10, "done": 100}.get(item["status"], 0)
      item.pop("duration_value", None)
      item.pop("duration_unit", None)
      item["dependencies"] = json_load(item["dependencies"], [])
      item["tags"] = json_load(item.get("tags"), [])
      tasks.append(item)
    completed = sum(1 for task in tasks if task["status"] == "done")
    total = len(tasks)
    project = dict(row)
    project["tags"] = json_load(project.get("tags"), [])
    return {**project, "is_unassigned": project_id == UNASSIGNED_PROJECT_ID, "tasks": tasks, "progress": round(sum(task["progress"] for task in tasks) / total) if total else 0}

  def state(self) -> dict[str, Any]:
    with self.connection() as db:
      templates = [self._template(db, row[0]) for row in db.execute("SELECT id FROM templates ORDER BY name")]
      projects = [self._project(db, row[0]) for row in db.execute("SELECT id FROM projects ORDER BY sort_order, id")]
      return {"tag_colors": {row[0][10:]: row[1] for row in db.execute("SELECT key,value FROM app_settings WHERE key LIKE 'tag_color:%'")}, "templates": templates, "projects": [p for p in projects if not p["is_unassigned"] or p["tasks"]], "directory": [dict(row) for row in db.execute("SELECT * FROM directory_entries ORDER BY parent_id,sort_order,id")]}

  def set_tag_color(self, tag, color):
    key = " ".join(unicodedata.normalize("NFKC", str(tag)).split()).lower()
    if not key or len(key) > 200:
      raise ValueError("Invalid tag name")
    color = self._validate_color(color)
    with self.connection() as db:
      if color:
        db.execute("INSERT INTO app_settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", ("tag_color:" + key, color))
      else:
        db.execute("DELETE FROM app_settings WHERE key=?", ("tag_color:" + key,))
    return {"key": key, "color": color}

  def holiday_country(self):
    with self.connection() as db:
      row = db.execute("SELECT value FROM app_settings WHERE key='holiday_country'").fetchone()
      return row[0] if row else "KR"

  def set_holiday_country(self, country):
    from .holiday_calendar import validate_country
    country = validate_country(country)
    with self.connection() as db:
      db.execute("INSERT INTO app_settings(key,value) VALUES ('holiday_country',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (country,))
    return {"holiday_country": country}

  def holidays(self, start: str | None = None, end: str | None = None, *, country: str | None = None, now: datetime | None = None, fetcher=None) -> dict[str, Any]:
    from .holiday_calendar import calendar_payload
    return calendar_payload(self, start, end, country=country or self.holiday_country(), now=now, fetcher=fetcher)

  def schedule_template(self, tasks, start_date, calendar_type):
    country = self.holiday_country()
    years = {}
    def is_holiday(day):
      if day.year not in years:
        data = self.holidays(f"{day.year}-01-01", f"{day.year}-12-31", country=country)
        if day.year not in data["coverage_years"]:
          raise ScheduleError(f"{day.year}년 공휴일 자료가 없어 주 5일 일정을 계산할 수 없습니다.")
        years[day.year] = {entry["date"] for entry in data["holidays"]}
      return day.isoformat() in years[day.year]
    return schedule_tasks(tasks, start_date, calendar_type, include_trailing_weekend=True, is_holiday=is_holiday)

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
      template_start_day(task)
      duration_days(task, "working")
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
      basis = payload.get("calendar_type")
      if basis is not None:
        if basis not in {"working", "calendar"}:
          raise ScheduleError("일정 기준이 올바르지 않습니다.")
        db.execute("UPDATE templates SET calendar_type=? WHERE id=?", (basis, template_id))
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
      calendar_type = str(payload.get("calendar_type") or template.get("calendar_type") or "working")
      # Resolve holiday years before opening the project write transaction.
      planned = {t["key"]: t for t in self.schedule_template(template["tasks"], start_date, calendar_type)}
      project_id = new_id()
      stamp = now_iso()
      db.execute("BEGIN IMMEDIATE")
      # Recheck idempotency after acquiring the write lock, before choosing a color.
      if request_id:
        prior = db.execute("SELECT project_id FROM project_creation_requests WHERE request_id=?", (request_id,)).fetchone()
        if prior:
          return self._project(db, prior[0])
      color = self._validate_color(payload.get("color"))
      used = {self._validate_color(row[0]) for row in db.execute("SELECT color FROM projects")}
      if not color or color in used:
        color = self._next_project_color(db)
      group_name = self._canonical_group(db, payload.get("group_name", ""))
      tags = json.dumps(self._normalize_tags(payload.get("tags", [])), ensure_ascii=False)
      db.execute("INSERT INTO projects (id, name, template_id, template_name, start_date, calendar_type, color, group_name, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (project_id, name, template_id, template["name"], start_date, calendar_type, color, group_name, tags, stamp, stamp))
      snapshot = []
      key_map = {task["key"]: new_id() for task in template["tasks"]}
      old_id_to_key = {task["id"]: task["key"] for task in template["tasks"]}
      for task in template["tasks"]:
        snapshot.append({
          "id": key_map[task["key"]], "template_task_key": task["key"], "name": task["name"],
          "duration_value": task["duration_value"], "duration_unit": task["duration_unit"],
          "start_day": task.get("start_day"),
          "dependencies": [key_map[old_id_to_key[dep]] for dep in task["dependencies"]],
          "owner": task["owner"], "handoff": task["handoff"], "sort_order": task["sort_order"],
          "status": "todo", "blocker": "", "planned_start": "", "planned_finish": "",
          "actual_start": "", "actual_finish": "", "notes": "",
          "color": task.get("color") or TASK_COLORS[task["sort_order"] % len(TASK_COLORS)],
          "group_name": "", "tags": [],
        })
      scheduled = [{**task, "planned_start": planned[task["template_task_key"]]["planned_start"], "planned_finish": planned[task["template_task_key"]]["planned_finish"]} for task in snapshot]
      self._insert_project_tasks(db, project_id, scheduled)
      if request_id:
        db.execute("INSERT INTO project_creation_requests VALUES (?, ?)", (request_id, project_id))
      return self._project(db, project_id)

  def create_project(self, payload: dict[str, Any]) -> dict[str, Any]:
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
      db.execute("BEGIN IMMEDIATE")
      if request_id:
        prior = db.execute("SELECT project_id FROM project_creation_requests WHERE request_id=?", (request_id,)).fetchone()
        if prior:
          return self._project(db, prior[0])
      color = self._validate_color(payload.get("color"))
      used = {self._validate_color(row[0]) for row in db.execute("SELECT color FROM projects")}
      if not color or color in used:
        color = self._next_project_color(db)
      project_id, stamp = new_id(), now_iso()
      db.execute("INSERT INTO projects (id, name, template_id, template_name, start_date, calendar_type, color, group_name, tags, created_at, updated_at) VALUES (?, ?, NULL, '', ?, ?, ?, '', '[]', ?, ?)", (project_id, name, start_date, calendar_type, color, stamp, stamp))
      if request_id:
        db.execute("INSERT INTO project_creation_requests VALUES (?, ?)", (request_id, project_id))
      return self._project(db, project_id)

  def get_project(self, project_id: str) -> dict[str, Any] | None:
    with self.connection() as db:
      return self._project(db, project_id)

  def update_project(self, project_id: str, fields: dict[str, Any]) -> dict[str, Any] | None:
    if project_id == UNASSIGNED_PROJECT_ID:
      raise ScheduleError("프로젝트 없음 그룹의 속성은 변경할 수 없습니다.")
    allowed = {"name", "start_date", "calendar_type", "color", "group_name", "tags", "sort_order"}
    if set(fields) - allowed:
      raise ScheduleError("수정할 수 없는 프로젝트 필드입니다.")
    with self.connection() as db:
      db.execute("BEGIN IMMEDIATE")
      project = self._project(db, project_id)
      if not project:
        return None
      if "sort_order" in fields:
        order = fields["sort_order"]
        ids = [row[0] for row in db.execute("SELECT id FROM projects WHERE id!='__unassigned__' ORDER BY sort_order,id")]
        if type(order) is not int or not 1 <= order <= len(ids):
          raise ScheduleError(f"프로젝트 순서는 1부터 {len(ids)} 사이의 정수여야 합니다.")
        ids.remove(project_id)
        ids.insert(order - 1, project_id)
        for position, ident in enumerate(ids, 1):
          db.execute("UPDATE projects SET sort_order=? WHERE id=?", (position, ident))
      updated = {**project, **fields}
      if not str(updated.get("name", "")).strip():
        raise ScheduleError("프로젝트 이름을 입력하세요.")
      date.fromisoformat(updated["start_date"])
      if updated["calendar_type"] not in {"working", "calendar"}:
        raise ScheduleError("달력 유형은 working 또는 calendar여야 합니다.")
      color = self._validate_color(updated.get("color")) or project["color"]
      tags = json.dumps(self._normalize_tags(updated.get("tags", [])), ensure_ascii=False)
      group_name = self._canonical_group(db, updated.get("group_name", ""))
      db.execute("UPDATE projects SET name=?, start_date=?, calendar_type=?, color=?, group_name=?, tags=?, updated_at=? WHERE id=?", (str(updated["name"]).strip(), updated["start_date"], updated["calendar_type"], color, group_name, tags, now_iso(), project_id))
      # Saved task dates are concrete values. Changing project metadata must
      # not silently recalculate or overwrite any existing task range.
      return self._project(db, project_id)

  def create_task(self, project_id: str, fields: dict[str, Any]) -> dict[str, Any] | None:
    if set(fields) - {"name", "planned_start", "planned_finish"}:
      raise ScheduleError("추가할 수 없는 작업 필드입니다.")
    name = str(fields.get("name", "")).strip()
    if not name:
      raise ScheduleError("작업명을 입력하세요.")
    validate_date_range(fields.get("planned_start"), fields.get("planned_finish"))
    with self.connection() as db:
      db.execute("BEGIN IMMEDIATE")
      if project_id == UNASSIGNED_PROJECT_ID:
        stamp = now_iso()
        db.execute("INSERT OR IGNORE INTO projects (id,name,template_name,start_date,calendar_type,color,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                   (project_id, "프로젝트 없음", "", fields["planned_start"], "calendar", "#94a3b8", stamp, stamp))
      project = self._project(db, project_id)
      if not project:
        return None
      order = max((task["sort_order"] for task in project["tasks"]), default=-1) + 1
      self._insert_project_tasks(db, project_id, [{
        "name": name, "planned_start": fields["planned_start"],
        "planned_finish": fields["planned_finish"], "sort_order": order,
        "color": TASK_COLORS[order % len(TASK_COLORS)],
      }])
      db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now_iso(), project_id))
      return self._project(db, project_id)

  def place_task(self, task_id: str, directory_id: str, anchor_id: str | None = None, after: bool = False) -> dict[str, Any] | None:
    """Resolve a folder node; files can never become parents of other files."""
    if not isinstance(directory_id, str):
      raise ScheduleError("이동할 프로젝트를 지정하세요.")
    with self.connection() as db:
      folder = db.execute("SELECT kind,project_id FROM directory_entries WHERE id=?", (directory_id,)).fetchone()
      if not folder or folder["kind"] not in {"root", "project"}:
        raise ScheduleError("프로젝트를 찾을 수 없습니다.")
      project_id = folder["project_id"]
    return self.move_task(task_id, project_id, anchor_id, after)

  def move_task(self, task_id: str, project_id: str | None, anchor_id: str | None = None, after: bool = False) -> dict[str, Any] | None:
    """Keep task records intact; remove links that would cross project boundaries.

    A reserved storage container keeps unassigned tasks editable without changing
    existing NOT NULL foreign keys. It is exposed as an unassigned group in UI.
    """
    if project_id is not None and (not isinstance(project_id, str) or not project_id):
      raise ScheduleError("프로젝트가 올바르지 않습니다.")
    if (anchor_id is not None and not isinstance(anchor_id, str)) or type(after) is not bool:
      raise ScheduleError("삽입 위치가 올바르지 않습니다.")
    destination = project_id or UNASSIGNED_PROJECT_ID
    with self.connection() as db:
      db.execute("BEGIN IMMEDIATE")
      task = db.execute("SELECT * FROM project_tasks WHERE id=?", (task_id,)).fetchone()
      if not task:
        return None
      if anchor_id is not None:
        anchor = db.execute("SELECT project_id FROM project_tasks WHERE id=?", (anchor_id,)).fetchone()
        if not anchor or anchor["project_id"] != destination:
          raise ScheduleError("삽입 위치가 올바르지 않습니다.")
      if destination == task["project_id"]:
        if anchor_id and anchor_id != task_id:
          ids = [row[0] for row in db.execute("SELECT id FROM project_tasks WHERE project_id=? ORDER BY sort_order,id", (destination,)) if row[0] != task_id]
          ids.insert(ids.index(anchor_id) + int(after), task_id)
          for index, ident in enumerate(ids, 1):
            db.execute("UPDATE project_tasks SET sort_order=? WHERE id=?", (index, ident))
          db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now_iso(), destination))
        return self._project(db, destination)
      stamp = now_iso()
      if destination == UNASSIGNED_PROJECT_ID:
        db.execute("INSERT OR IGNORE INTO projects (id,name,template_name,start_date,calendar_type,color,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
                   (destination, "프로젝트 없음", "", task["planned_start"], "calendar", "#94a3b8", stamp, stamp))
      elif not db.execute("SELECT 1 FROM projects WHERE id=?", (destination,)).fetchone():
        raise ScheduleError("프로젝트를 찾을 수 없습니다.")
      order = db.execute("SELECT COALESCE(MAX(sort_order),-1)+1 FROM project_tasks WHERE project_id=?", (destination,)).fetchone()[0]
      for row in db.execute("SELECT id,dependencies FROM project_tasks WHERE project_id=?", (task["project_id"],)).fetchall():
        deps = json_load(row["dependencies"], [])
        if task_id in deps:
          db.execute("UPDATE project_tasks SET dependencies=? WHERE id=?", (json.dumps([dep for dep in deps if dep != task_id]), row["id"]))
      db.execute("UPDATE project_tasks SET project_id=?,dependencies='[]',sort_order=? WHERE id=?", (destination, order, task_id))
      db.execute("UPDATE projects SET updated_at=? WHERE id IN (?,?)", (stamp, task["project_id"], destination))
      self._normalize_task_order(db, task["project_id"])
      self._normalize_task_order(db, destination)
      if anchor_id:
        ids = [row[0] for row in db.execute("SELECT id FROM project_tasks WHERE project_id=? ORDER BY sort_order,id", (destination,)) if row[0] != task_id]
        ids.insert(ids.index(anchor_id) + int(after), task_id)
        for index, ident in enumerate(ids, 1):
          db.execute("UPDATE project_tasks SET sort_order=? WHERE id=?", (index, ident))
      return self._project(db, destination)

  def complete_project(self, project_id: str) -> dict[str, Any] | None:
    """Complete all tasks atomically without inventing or shifting date records."""
    with self.connection() as db:
      db.execute("BEGIN IMMEDIATE")
      if not db.execute("SELECT id FROM projects WHERE id=?", (project_id,)).fetchone():
        return None
      db.execute("UPDATE project_tasks SET status='done',progress=100 WHERE project_id=?", (project_id,))
      db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now_iso(), project_id))
      return self._project(db, project_id)

  def delete_template(self, template_id: str) -> bool:
    # Instantiated projects own independent snapshots; only template rows cascade.
    with self.connection() as db:
      db.execute("BEGIN IMMEDIATE")
      return db.execute("DELETE FROM templates WHERE id=?", (template_id,)).rowcount > 0

  def delete_project(self, project_id: str) -> bool:
    if project_id == UNASSIGNED_PROJECT_ID:
      raise ScheduleError("프로젝트 없음 그룹은 삭제할 수 없습니다.")
    with self.connection() as db:
      db.execute("BEGIN IMMEDIATE")
      removed = db.execute("DELETE FROM projects WHERE id=?", (project_id,)).rowcount > 0
      self._normalize_project_order(db)
      return removed

  def delete_task(self, task_id: str) -> bool:
    with self.connection() as db:
      db.execute("BEGIN IMMEDIATE")
      row = db.execute("SELECT project_id FROM project_tasks WHERE id=?", (task_id,)).fetchone()
      if not row:
        return False
      project_id = row["project_id"]
      for task in db.execute("SELECT id,dependencies FROM project_tasks WHERE project_id=?", (project_id,)).fetchall():
        deps = json_load(task["dependencies"], [])
        if task_id in deps:
          db.execute("UPDATE project_tasks SET dependencies=? WHERE id=?", (json.dumps([dep for dep in deps if dep != task_id]), task["id"]))
      db.execute("DELETE FROM project_tasks WHERE id=?", (task_id,))
      self._normalize_task_order(db, project_id)
      db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now_iso(), project_id))
      return True

  def update_task(self, task_id: str, fields: dict[str, Any]) -> dict[str, Any] | None:
    allowed = {"name", "dependencies", "successors", "owner", "handoff", "blocker", "status", "planned_start", "planned_finish", "actual_start", "actual_finish", "notes", "color", "group_name", "tags", "cascade_dependents", "progress"}
    if set(fields) - allowed:
      raise ScheduleError("수정할 수 없는 작업 필드입니다.")
    if "status" in fields and fields["status"] not in {"todo", "doing", "blocked", "done"}:
      raise ScheduleError("작업 상태가 올바르지 않습니다.")
    if "progress" in fields:
      value = fields["progress"]
      if type(value) is not int or value < 0 or value > 100 or value % 10:
        raise ScheduleError("진행률은 0부터 100까지 10 단위여야 합니다.")
      if fields.get("status") != "blocked":
        fields = {**fields, "status": "todo" if value == 0 else "done" if value == 100 else "doing"}
    cascade_dependents = fields.get("cascade_dependents", False)
    if not isinstance(cascade_dependents, bool):
      raise ScheduleError("후행 작업 일정 조정 옵션이 올바르지 않습니다.")
    with self.connection() as db:
      db.execute("BEGIN IMMEDIATE")
      row = db.execute("SELECT project_id FROM project_tasks WHERE id=?", (task_id,)).fetchone()
      if not row:
        return None
      project_id = row[0]
      project = self._project(db, project_id)
      target = next(task for task in project["tasks"] if task["id"] == task_id)
      if "status" in fields and "progress" not in fields:
        status = fields["status"]
        fields = {**fields, "progress": 0 if status == "todo" else 100 if status == "done" else max(10, min(90, target["progress"])) if status == "doing" else target["progress"]}
      deps = fields.get("dependencies", target["dependencies"])
      if not isinstance(deps, list):
        raise ScheduleError("선행 작업 형식이 올바르지 않습니다.")
      deps = list(dict.fromkeys(str(value) for value in deps))
      new_target = {**target, **{key: value for key, value in fields.items() if key not in {"cascade_dependents", "successors"}}, "dependencies": deps}
      linked_tasks = [{**task, "dependencies": list(task["dependencies"])} for task in project["tasks"]]
      if "successors" in fields:
        if not isinstance(fields["successors"], list):
          raise ScheduleError("후행 작업 형식이 올바르지 않습니다.")
        successors = set(str(value) for value in fields["successors"])
        available = {task["id"] for task in linked_tasks} - {task_id}
        if not successors <= available:
          raise ScheduleError("후행 작업은 같은 프로젝트의 다른 작업이어야 합니다.")
        for task in linked_tasks:
          if task["id"] == task_id:
            continue
          task["dependencies"] = [dep for dep in task["dependencies"] if dep != task_id]
          if task["id"] in successors:
            task["dependencies"].append(task_id)
      if not str(new_target.get("name", "")).strip():
        raise ScheduleError("작업명을 입력하세요.")
      new_target["color"] = self._validate_color(new_target.get("color")) or target["color"]
      new_target["owner"] = self._canonical_owner(db, new_target.get("owner", ""))
      new_target["group_name"] = self._canonical_group(db, new_target.get("group_name", ""))
      new_target["tags"] = self._normalize_tags(new_target.get("tags", []))
      actual_start = str(new_target.get("actual_start", "") or "")
      actual_finish = str(new_target.get("actual_finish", "") or "")
      if actual_start and actual_finish:
        validate_date_range(actual_start, actual_finish)
      else:
        for value in (actual_start, actual_finish):
          if value:
            try:
              parsed = date.fromisoformat(value)
            except ValueError as exc:
              raise ScheduleError("실제 날짜를 YYYY-MM-DD 형식으로 입력하세요.") from exc
            if parsed.isoformat() != value:
              raise ScheduleError("실제 날짜를 YYYY-MM-DD 형식으로 입력하세요.")
      scheduled = update_schedule_dates(
        linked_tasks,
        task_id,
        str(new_target.get("planned_start", "")),
        str(new_target.get("planned_finish", "")),
        project["calendar_type"],
        cascade_dependents,
        new_target,
      )
      for task in scheduled:
        if task["id"] == task_id:
          db.execute("""UPDATE project_tasks SET name=?, dependencies=?, owner=?, handoff=?, blocker=?, status=?, planned_start=?, planned_finish=?, actual_start=?, actual_finish=?, notes=?, color=?, group_name=?, tags=?, progress=? WHERE id=?""", (
            task["name"], json.dumps(task["dependencies"], ensure_ascii=False), self._canonical_owner(db, task.get("owner", "")), task.get("handoff", ""), task.get("blocker", ""), task.get("status", "todo"),
            task["planned_start"], task["planned_finish"], task.get("actual_start", ""), task.get("actual_finish", ""), task.get("notes", ""),
            task.get("color", ""), str(task.get("group_name", "")), json.dumps(self._normalize_tags(task.get("tags", [])), ensure_ascii=False), task.get("progress", 0), task["id"],
          ))
          continue
        original_task = next(item for item in project["tasks"] if item["id"] == task["id"])
        if task["dependencies"] != original_task["dependencies"]:
          db.execute("UPDATE project_tasks SET dependencies=? WHERE id=?", (json.dumps(task["dependencies"], ensure_ascii=False), task["id"]))
        if (task["planned_start"], task["planned_finish"]) != (original_task["planned_start"], original_task["planned_finish"]):
          db.execute("UPDATE project_tasks SET planned_start=?, planned_finish=? WHERE id=?", (task["planned_start"], task["planned_finish"], task["id"]))
      db.execute("UPDATE projects SET updated_at=? WHERE id=?", (now_iso(), project_id))
      return self._project(db, project_id)

  def _canonical_owner(self, db, value):
    name = " ".join(unicodedata.normalize("NFKC", str(value or "")).split())
    if not name:
      return ""
    for row in db.execute("SELECT owner FROM project_tasks UNION SELECT owner FROM template_tasks ORDER BY owner"):
      existing = " ".join(unicodedata.normalize("NFKC", row[0] or "").split())
      if existing.lower() == name.lower():
        return existing
    return name

  def _canonical_group(self, db, value):
    name = " ".join(unicodedata.normalize("NFKC", str(value or "")).split())
    key = name.lower()
    if not key:
      return ""
    rows = db.execute("SELECT group_name FROM projects UNION SELECT group_name FROM project_tasks ORDER BY group_name")
    for row in rows:
      existing = " ".join(unicodedata.normalize("NFKC", row[0] or "").split())
      if existing.lower() == key:
        return existing
    return name

  def _next_project_color(self, db: sqlite3.Connection) -> str:
    used = {self._validate_color(row[0]) for row in db.execute("SELECT color FROM projects")}
    used.add("#5872d9")  # Reserved default UI color, never assign randomly.
    seed = f"{now_iso()}:{new_id()}"
    attempt = 0
    while True:
      digest = hashlib.sha256(f"{seed}:{attempt}".encode()).digest()
      color = "#" + "".join(f"{64 + (channel & 127):02x}" for channel in digest[:3])
      if color not in used:
        return color
      attempt += 1

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
