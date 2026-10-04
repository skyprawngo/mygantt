"""Folder/file hierarchy with transactional compatibility for existing task APIs.

Projects are folders beneath the workspace root. Unassigned tasks are root files.
The existing project/task records retain their IDs and scheduling data; triggers
keep the directory index in the same transaction as every create, rename, move,
reorder and delete, including writes through older APIs.
"""
from datetime import datetime
from pathlib import Path
import sqlite3

MIGRATION = 'project-task-directory-v1'
ROOT = 'root'


def backup_before_migration(path):
    source = Path(path)
    if not source.is_file():
        return
    with sqlite3.connect(path) as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='projects'").fetchone():
            return
        has_versions = db.execute("SELECT 1 FROM sqlite_master WHERE name='schema_migrations'").fetchone()
        if has_versions and db.execute('SELECT 1 FROM schema_migrations WHERE migration_key=?', (MIGRATION,)).fetchone():
            return
        backup = source.with_name(source.name + '.before-directory-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.bak')
        with sqlite3.connect(backup) as target:
            db.backup(target)


def migrate(db, stamp):
    if db.execute('SELECT 1 FROM schema_migrations WHERE migration_key=?', (MIGRATION,)).fetchone():
        return
    db.execute("""CREATE TABLE directory_entries (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES directory_entries(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('root','project','task')),
        project_id TEXT UNIQUE REFERENCES projects(id) ON DELETE CASCADE,
        task_id TEXT UNIQUE REFERENCES project_tasks(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        CHECK((kind='root' AND id='root' AND parent_id IS NULL AND project_id IS NULL AND task_id IS NULL)
          OR (kind='project' AND parent_id='root' AND project_id IS NOT NULL AND task_id IS NULL AND id='project:'||project_id)
          OR (kind='task' AND parent_id IS NOT NULL AND project_id IS NULL AND task_id IS NOT NULL AND id='task:'||task_id))
    )""")
    db.execute("INSERT INTO directory_entries(id,kind,name) VALUES ('root','root','/')")
    db.execute("""INSERT INTO directory_entries(id,parent_id,kind,project_id,name)
        SELECT 'project:'||id,'root','project',id,name FROM projects WHERE id!='__unassigned__'""")
    db.execute("""INSERT INTO directory_entries(id,parent_id,kind,task_id,name,sort_order)
        SELECT 'task:'||id,CASE WHEN project_id='__unassigned__' THEN 'root' ELSE 'project:'||project_id END,
               'task',id,name,sort_order FROM project_tasks""")
    db.execute('CREATE INDEX directory_children ON directory_entries(parent_id,sort_order,id)')
    # Entry parents must match the actual folder ownership, not merely any node ID.
    for action in ('INSERT', 'UPDATE'):
        db.execute(f"""CREATE TRIGGER directory_validate_{action.lower()} BEFORE {action} ON directory_entries
          WHEN (NEW.kind='task' AND NOT EXISTS (
            SELECT 1 FROM project_tasks t WHERE t.id=NEW.task_id AND NEW.parent_id=
              CASE WHEN t.project_id='__unassigned__' THEN 'root' ELSE 'project:'||t.project_id END))
            OR (NEW.kind='project' AND NEW.project_id='__unassigned__')
          BEGIN SELECT RAISE(ABORT,'Invalid directory parent'); END""")
    for action in ('INSERT', 'UPDATE OF name'):
        suffix = action.split()[0].lower()
        db.execute(f"""CREATE TRIGGER directory_project_{suffix} AFTER {action} ON projects
          WHEN NEW.id!='__unassigned__'
          BEGIN
            INSERT INTO directory_entries(id,parent_id,kind,project_id,name)
            VALUES ('project:'||NEW.id,'root','project',NEW.id,NEW.name)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name;
          END""")
    for action in ('INSERT', 'UPDATE OF project_id,name,sort_order'):
        suffix = action.split()[0].lower()
        db.execute(f"""CREATE TRIGGER directory_task_{suffix} AFTER {action} ON project_tasks
          BEGIN
            INSERT INTO directory_entries(id,parent_id,kind,task_id,name,sort_order)
            VALUES ('task:'||NEW.id,CASE WHEN NEW.project_id='__unassigned__' THEN 'root' ELSE 'project:'||NEW.project_id END,'task',NEW.id,NEW.name,NEW.sort_order)
            ON CONFLICT(id) DO UPDATE SET parent_id=excluded.parent_id,name=excluded.name,sort_order=excluded.sort_order;
          END""")
    db.execute('INSERT INTO schema_migrations VALUES (?,?)', (MIGRATION, stamp))
