import tempfile
import unittest
from pathlib import Path
from mygantt.database import Database
from mygantt.scheduler import ScheduleError


class EmptyProjectTests(unittest.TestCase):
  def test_creation_retry_color_and_task_addition(self):
    with tempfile.TemporaryDirectory() as folder:
      db = Database(Path(folder) / 'test.sqlite3', seed_samples=False, holiday_fetcher=lambda year: [])
      fields = dict(name='빈 프로젝트', start_date='2026-10-04', calendar_type='working', request_id='first', color='#5872d9')
      project = db.create_project(fields)
      self.assertEqual(project['tasks'], [])
      self.assertIsNone(project['template_id'])
      self.assertEqual(project['progress'], 0)
      self.assertEqual(db.create_project(fields)['id'], project['id'])
      second = db.create_project({**fields, 'request_id': 'second'})
      self.assertNotEqual(second['color'], project['color'])
      result = db.create_task(project['id'], dict(name='작업', planned_start='2026-10-05', planned_finish='2026-10-06'))
      self.assertEqual(len(result['tasks']), 1)
      self.assertEqual(db.get_project(project['id'])['name'], '빈 프로젝트')
      for invalid in [dict(name=''), dict(start_date='invalid'), dict(calendar_type='invalid')]:
        with self.assertRaises((ScheduleError, ValueError)):
          db.create_project({**fields, **invalid, 'request_id': ''})

  def test_add_task_without_any_project(self):
    with tempfile.TemporaryDirectory() as folder:
      db = Database(Path(folder) / 'test.sqlite3', seed_samples=False, holiday_fetcher=lambda year: [])
      fields = dict(name='Unassigned task', planned_start='2026-10-05', planned_finish='2026-10-06')
      project = db.create_task('__unassigned__', fields)
      self.assertTrue(project['is_unassigned'])
      self.assertEqual(len(project['tasks']), 1)
      self.assertEqual(len(db.create_task('__unassigned__', fields)['tasks']), 2)
      self.assertIsNone(db.create_task('missing', fields))
