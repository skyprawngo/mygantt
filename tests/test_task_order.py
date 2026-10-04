import tempfile
import unittest
from pathlib import Path
from mygantt.database import Database
from mygantt.scheduler import ScheduleError

class TaskOrderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'order.sqlite3'
        self.db = Database(self.path, holiday_fetcher=lambda year: [])
        self.project = self.db.state()['projects'][0]
        while len(self.project['tasks']) < 10:
            self.project = self.db.create_task(self.project['id'], {'name':'extra','planned_start':'2026-10-01','planned_finish':'2026-10-02'})
    def tearDown(self):
        self.temp.cleanup()
    def test_tenth_to_third_preserves_records_and_persists(self):
        before = self.project['tasks']
        ids = [t['id'] for t in before]
        result = self.db.reorder_task(ids[9], ids[2])['tasks']
        self.assertEqual([t['id'] for t in result], ids[:2]+[ids[9]]+ids[2:9])
        self.assertEqual([t['sort_order'] for t in result], list(range(1,11)))
        for task in result:
            original = next(t for t in before if t['id']==task['id'])
            self.assertEqual({k:v for k,v in task.items() if k!='sort_order'}, {k:v for k,v in original.items() if k!='sort_order'})
        reopened = Database(self.path, holiday_fetcher=lambda year: [])
        self.assertEqual(reopened.get_project(self.project['id'])['tasks'], result)
        last = self.db.reorder_task(ids[9],ids[8],True)['tasks']
        self.assertEqual([t['id'] for t in last],ids)
        first = self.db.reorder_task(ids[9],ids[0])['tasks']
        self.assertEqual(first[0]['id'],ids[9])
    def test_invalid_anchor_and_self_leave_order_unchanged(self):
        task = self.project['tasks'][0]
        self.assertEqual(self.db.reorder_task(task['id'],task['id'])['tasks'],self.project['tasks'])
        other = self.db.state()['projects'][1]['tasks'][0]
        with self.assertRaises(ScheduleError): self.db.reorder_task(task['id'],other['id'])
        self.assertEqual(self.db.get_project(self.project['id'])['tasks'],self.project['tasks'])
