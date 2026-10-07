import sqlite3
import tempfile
import unittest
from pathlib import Path
from mygantt.database import Database
from mygantt.scheduler import ScheduleError


class ProjectOrderTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name) / 'order.sqlite3'
        self.db = Database(self.path, holiday_fetcher=lambda year: [])
        for i in range(7):
            self.db.create_project({'name': str(i), 'start_date': '2026-10-01'})

    def projects(self):
        return [p for p in self.db.state()['projects'] if not p['is_unassigned']]

    def test_insert_preserves_data_directory_and_reopen(self):
        before = self.projects()
        ids = [p['id'] for p in before]
        self.db.reorder_project(ids[-1], ids[2])
        result = self.projects()
        self.assertEqual([p['id'] for p in result], ids[:2] + [ids[-1]] + ids[2:-1])
        self.assertEqual([p['sort_order'] for p in result], list(range(1, len(ids)+1)))
        for p in result:
            original = next(x for x in before if x['id'] == p['id'])
            self.assertEqual({k:v for k,v in p.items() if k != 'sort_order'}, {k:v for k,v in original.items() if k != 'sort_order'})
        directory = {e['project_id']: e['sort_order'] for e in self.db.state()['directory'] if e['kind'] == 'project'}
        self.assertEqual(directory, {p['id']:p['sort_order'] for p in result})
        self.db = Database(self.path, holiday_fetcher=lambda year: [])
        self.assertEqual(self.projects(), result)
        self.db.reorder_project(ids[-1], ids[-2], True)
        self.assertEqual([p['id'] for p in self.projects()], ids)

    def test_append_delete_and_invalid_requests(self):
        before = self.projects()
        first = before[0]['id']
        self.db.reorder_project(first, first)
        for anchor, after in [('missing', False), (first, 1), ('__unassigned__', False)]:
            with self.assertRaises(ScheduleError):
                self.db.reorder_project(first, anchor, after)
        with self.assertRaises(ScheduleError):
            self.db.reorder_project('__unassigned__', first)
        self.assertIsNone(self.db.reorder_project('missing', first))
        self.assertEqual(self.projects(), before)
        self.db.delete_project(first)
        new = self.db.create_project({'name':'appended', 'start_date':'2000-01-01'})
        self.assertEqual(self.projects()[-1]['id'], new['id'])
        self.assertEqual([p['sort_order'] for p in self.projects()], list(range(1,len(before)+1)))

    def test_legacy_migration_preserves_previous_display_order(self):
        with sqlite3.connect(self.path) as db:
            db.execute('DROP TRIGGER project_order_append')
            db.execute('DROP TRIGGER directory_project_order')
            db.execute('ALTER TABLE projects DROP COLUMN sort_order')
            expected = [r[0] for r in db.execute("SELECT id FROM projects WHERE id!='__unassigned__' ORDER BY start_date,name,id")]
        self.db = Database(self.path, holiday_fetcher=lambda year: [])
        self.assertEqual([p['id'] for p in self.projects()], expected)
        self.assertEqual([p['sort_order'] for p in self.projects()], list(range(1,len(expected)+1)))

    def test_existing_unnumbered_projects_get_numbers_on_startup(self):
        with self.db.connection() as db:
            db.execute("UPDATE projects SET sort_order=0")
            expected = [r[0] for r in db.execute("SELECT id FROM projects WHERE id!='__unassigned__' ORDER BY start_date,name,id")]
        self.db = Database(self.path, holiday_fetcher=lambda year: [])
        result = self.projects()
        self.assertEqual([p['id'] for p in result], expected)
        self.assertEqual([p['sort_order'] for p in result], list(range(1,len(result)+1)))
        directory = {e['project_id']:e['sort_order'] for e in self.db.state()['directory'] if e['kind']=='project'}
        self.assertEqual(directory, {p['id']:p['sort_order'] for p in result})
        self.db = Database(self.path, holiday_fetcher=lambda year: [])
        self.assertEqual(self.projects(), result)

    def test_missing_numbers_preserve_assigned_relative_order_and_tasks(self):
        before = self.projects()
        ids = [p['id'] for p in before]
        self.db.reorder_project(ids[-1], ids[0])
        with self.db.connection() as db:
            db.execute("UPDATE projects SET sort_order=0 WHERE id=?", (ids[1],))
            db.execute("UPDATE projects SET sort_order=-1 WHERE id=?", (ids[2],))
            missing = [r[0] for r in db.execute("SELECT id FROM projects WHERE sort_order<=0 AND id!='__unassigned__' ORDER BY start_date,name,id")]
        expected = [p['id'] for p in self.projects() if p['sort_order']>0] + missing
        self.db = Database(self.path, holiday_fetcher=lambda year: [])
        result = self.projects()
        self.assertEqual([p['id'] for p in result], expected)
        self.assertEqual([p['sort_order'] for p in result], list(range(1,len(result)+1)))
        self.assertEqual({p['id']:p['tasks'] for p in result}, {p['id']:p['tasks'] for p in before})

    def test_numeric_order_patch_inserts_and_validates_atomically(self):
        before = self.projects()
        ids = [p['id'] for p in before]
        updated = self.db.update_project(ids[-1], {'sort_order': 2})
        self.assertEqual(updated['sort_order'], 2)
        self.assertEqual([p['id'] for p in self.projects()], ids[:1]+[ids[-1]]+ids[1:-1])
        self.assertEqual({p['id']:p['tasks'] for p in self.projects()}, {p['id']:p['tasks'] for p in before})
        stable = self.projects()
        for order in (0, -1, len(ids)+1, 1.5, True, '2'):
            with self.assertRaises(ScheduleError):
                self.db.update_project(ids[-1], {'sort_order':order})
            self.assertEqual(self.projects(), stable)
        with self.assertRaises(ScheduleError):
            self.db.update_project(ids[-1], {'sort_order':1, 'name':''})
        self.assertEqual(self.projects(), stable)
