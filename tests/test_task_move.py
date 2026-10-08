import tempfile
import unittest
from pathlib import Path
from mygantt.database import Database
from mygantt.scheduler import ScheduleError

class TaskMoveTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.temp.name) / 'test.db', holiday_fetcher=lambda year: [])
    def tearDown(self):
        self.temp.cleanup()
    def test_move_preserves_records_and_both_link_directions(self):
        source, target = self.db.state()['projects'][:2]
        task = next(t for t in source['tasks'] if t['dependencies'])
        self.db.update_task(task['id'], {'actual_start': '2026-10-01', 'actual_finish':'2026-10-02', 'notes':'keep'})
        before = next(t for t in self.db.get_project(source['id'])['tasks'] if t['id']==task['id'])
        result = self.db.move_task(task['id'], target['id'])
        after = next(t for t in result['tasks'] if t['id']==task['id'])
        for key in before.keys() - {'project_id','dependencies','sort_order'}:
            self.assertEqual(before[key], after[key], key)
        self.assertEqual(after['dependencies'], before['dependencies'])
        for t in self.db.get_project(source['id'])['tasks']:
            original=next(item for item in source['tasks'] if item['id']==t['id'])
            self.assertEqual(t['dependencies'], original['dependencies'])
        self.assertEqual(len(result['tasks']),len(target['tasks'])+1)
    def test_unassigned_edit_and_return(self):
        source = self.db.state()['projects'][0]
        task = source['tasks'][0]
        result = self.db.move_task(task['id'], None)
        self.assertTrue(result['is_unassigned'])
        self.assertTrue(any(p['is_unassigned'] for p in self.db.state()['projects']))
        self.db.update_task(task['id'], {'notes':'unassigned edit'})
        self.db.move_task(task['id'], source['id'])
        self.assertFalse(any(p['is_unassigned'] for p in self.db.state()['projects']))
        self.assertEqual(next(t for t in self.db.get_project(source['id'])['tasks'] if t['id']==task['id'])['notes'],'unassigned edit')
    def test_invalid_and_same_destination_preserve_links(self):
        source = self.db.state()['projects'][0]
        task = source['tasks'][1]
        with self.assertRaises(ScheduleError): self.db.move_task(task['id'], 'missing')
        self.assertEqual(self.db.get_project(source['id']), source)
        self.assertEqual(self.db.move_task(task['id'], source['id']), source)
