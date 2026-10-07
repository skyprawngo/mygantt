import tempfile
import unittest
from pathlib import Path
from mygantt.database import Database
from mygantt.scheduler import ScheduleError

class RowClipboardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = Database(Path(self.temp.name)/'copy.sqlite3', holiday_fetcher=lambda year: [])
        self.source = self.db.state()['projects'][0]

    def test_project_copy_remaps_all_links_and_preserves_original(self):
        result = self.db.duplicate_row({'kind':'project','source_id':self.source['id']})
        copy = result['project']
        self.assertNotEqual(copy['id'],self.source['id'])
        mapping = dict(zip([t['id'] for t in self.source['tasks']], [t['id'] for t in copy['tasks']]))
        for old, new in zip(self.source['tasks'],copy['tasks']):
            self.assertNotEqual(old['id'],new['id'])
            for key in old:
                if key not in ('id','project_id','dependencies'):
                    self.assertEqual(old[key],new[key],key)
            self.assertEqual(new['dependencies'],[mapping[d] for d in old['dependencies']])
        self.assertEqual(self.db.get_project(self.source['id']),self.source)
        self.assertEqual(result['selection']['id'],copy['id'])

    def test_task_copy_insertion_cross_project_and_repeated_paste(self):
        tasks = self.source['tasks']
        task = tasks[-1]
        result = self.db.duplicate_row({'kind':'task','source_id':task['id'],'project_id':self.source['id'],'anchor_id':tasks[0]['id']})
        self.assertEqual(result['project']['tasks'][1]['id'],result['selection']['id'])
        self.assertEqual(result['project']['tasks'][1]['dependencies'],task['dependencies'])
        target = self.db.create_project({'name':'destination','start_date':'2026-10-07'})
        copies = [self.db.duplicate_row({'kind':'task','source_id':task['id'],'project_id':target['id']}) for _ in range(2)]
        self.assertNotEqual(copies[0]['selection']['id'],copies[1]['selection']['id'])
        self.assertEqual([t['sort_order'] for t in copies[-1]['project']['tasks']],[1,2])
        self.assertTrue(all(t['dependencies']==[] for t in copies[-1]['project']['tasks']))

    def test_invalid_target_is_atomic(self):
        before = self.db.state()
        with self.assertRaises(ScheduleError):
            self.db.duplicate_row({'kind':'task','source_id':self.source['tasks'][0]['id'],'anchor_id':'missing'})
        self.assertEqual(self.db.state(),before)
