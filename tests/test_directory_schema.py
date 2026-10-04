import sqlite3
import tempfile
import unittest
from pathlib import Path
from mygantt.database import Database
from mygantt.scheduler import ScheduleError
from mygantt.directory_schema import MIGRATION


class DirectoryTests(unittest.TestCase):
  def setUp(self):
    self.temp = tempfile.TemporaryDirectory()
    self.path = Path(self.temp.name) / 'directory.db'
    self.db = Database(self.path, holiday_fetcher=lambda year: [])

  def tearDown(self):
    self.temp.cleanup()

  def entry(self, task):
    with self.db.connection() as db:
      return dict(db.execute('SELECT * FROM directory_entries WHERE task_id=?', (task,)).fetchone())

  def test_legacy_migration_preserves_records_and_is_idempotent(self):
    before = self.db.state()['projects']
    with self.db.connection() as db:
      for row in db.execute("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'directory_%'").fetchall():
        db.execute('DROP TRIGGER ' + row[0])
      db.execute('DROP TABLE directory_entries')
      db.execute('DELETE FROM schema_migrations WHERE migration_key=?', (MIGRATION,))
    migrated = Database(self.path, holiday_fetcher=lambda year: [])
    self.assertEqual(before, migrated.state()['projects'])
    backups = list(self.path.parent.glob('*.before-directory-*.bak'))
    self.assertEqual(len(backups), 1)
    with sqlite3.connect(backups[0]) as backup:
      self.assertEqual(backup.execute('SELECT COUNT(*) FROM project_tasks').fetchone()[0], sum(len(p['tasks']) for p in before))
      self.assertIsNone(backup.execute("SELECT 1 FROM sqlite_master WHERE name='directory_entries'").fetchone())
    again = Database(self.path, holiday_fetcher=lambda year: [])
    self.assertEqual(migrated.state()['directory'], again.state()['directory'])
    self.assertEqual(len(list(self.path.parent.glob('*.before-directory-*.bak'))), 1)

  def test_atomic_cross_folder_placement_root_and_return(self):
    source, target = self.db.state()['projects'][:2]
    task = source['tasks'][1]
    anchor = target['tasks'][1]
    moved = self.db.move_task(task['id'], target['id'], anchor['id'], False)
    self.assertEqual(moved['tasks'][1]['id'], task['id'])
    self.assertEqual(self.entry(task['id'])['parent_id'], 'project:' + target['id'])
    self.assertEqual(self.entry(task['id'])['sort_order'], 2)
    for key in task.keys() - {'project_id','sort_order','dependencies'}:
      self.assertEqual(moved['tasks'][1][key], task[key])
    self.db.move_task(task['id'], None)
    self.assertEqual(self.entry(task['id'])['parent_id'], 'root')
    self.db.move_task(task['id'], source['id'], source['tasks'][0]['id'], True)
    self.assertEqual(self.entry(task['id'])['parent_id'], 'project:' + source['id'])
    self.db.update_task(task['id'], {'name':'Renamed'})
    self.assertEqual(self.entry(task['id'])['name'], 'Renamed')
    self.db.update_project(source['id'], {'name':'Folder'})
    with self.db.connection() as db:
      self.assertEqual(db.execute('SELECT name FROM directory_entries WHERE project_id=?',(source['id'],)).fetchone()[0], 'Folder')
      self.assertEqual(db.execute('PRAGMA foreign_key_check').fetchall(), [])
    self.db.delete_project(source['id'])
    with self.db.connection() as db:
      self.assertIsNone(db.execute('SELECT 1 FROM directory_entries WHERE task_id=?',(task['id'],)).fetchone())

  def test_invalid_destination_anchor_does_not_partially_move(self):
    source, target = self.db.state()['projects'][:2]
    task = source['tasks'][0]
    before = self.db.state()
    with self.assertRaises(ScheduleError):
      self.db.move_task(task['id'], target['id'], source['tasks'][1]['id'])
    self.assertEqual(self.db.state(), before)
    with self.assertRaises(ScheduleError):
      self.db.place_task(task['id'], 'task:' + source['tasks'][1]['id'])
    self.assertEqual(self.db.state(), before)
    with self.assertRaises(sqlite3.IntegrityError):
      with self.db.connection() as db:
        db.execute('UPDATE directory_entries SET parent_id=? WHERE task_id=?', ('task:'+source['tasks'][1]['id'],task['id']))
    self.assertEqual(self.db.state(), before)
