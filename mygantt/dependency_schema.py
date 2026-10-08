"""Cross-project dependency index, derived from stable task UUIDs.

The compatibility JSON stores predecessor task IDs. Project ownership is joined,
never copied, so moving either endpoint cannot leave a stale project reference.
"""
from datetime import datetime
from pathlib import Path
import sqlite3

MIGRATION = 'cross-project-dependencies-v1'


def backup_before_migration(path):
    source = Path(path)
    if not source.is_file():
        return
    with sqlite3.connect(path) as db:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE name='project_tasks'").fetchone():
            return
        if db.execute("SELECT 1 FROM sqlite_master WHERE name='task_links'").fetchone():
            return
        backup = source.with_name(source.name + '.before-task-links-' + datetime.now().strftime('%Y%m%d-%H%M%S-%f') + '.bak')
        with sqlite3.connect(backup) as target:
            db.backup(target)


def migrate(db, stamp):
    if db.execute('SELECT 1 FROM schema_migrations WHERE migration_key=?', (MIGRATION,)).fetchone():
        return
    db.execute('''CREATE VIEW task_links AS
        SELECT DISTINCT predecessor.id AS predecessor_task_id,
               predecessor.project_id AS predecessor_project_id,
               successor.id AS successor_task_id,
               successor.project_id AS successor_project_id
        FROM project_tasks successor, json_each(successor.dependencies) dependency
        JOIN project_tasks predecessor ON predecessor.id=dependency.value''')
    # Applies to project deletion cascades and sync writes, not only HTTP deletes.
    db.execute('''CREATE TRIGGER task_links_cleanup AFTER DELETE ON project_tasks
        BEGIN
          UPDATE project_tasks SET dependencies=(
            SELECT json_group_array(value) FROM json_each(project_tasks.dependencies)
            WHERE value!=OLD.id
          ) WHERE EXISTS(SELECT 1 FROM json_each(project_tasks.dependencies) WHERE value=OLD.id);
        END''')
    db.execute('INSERT INTO schema_migrations VALUES (?,?)', (MIGRATION, stamp))
