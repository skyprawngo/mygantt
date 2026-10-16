import tempfile
import unittest
from pathlib import Path
from mygantt.database import Database
from mygantt.scheduler import ScheduleError
from mygantt.undo import UndoHistory, snapshot

class TaskRowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'rows.db'
        self.db = Database(self.path, seed_samples=False, holiday_fetcher=lambda year: [])
        self.p = self.db.create_project(dict(name='반복 작업', start_date='2026-11-01', calendar_type='calendar'))['id']
        self.fields = dict(name='검사', planned_start='2026-11-01', planned_finish='2026-11-03')
        self.first = self.db.create_task(self.p, self.fields)['tasks'][0]['id']

    def add(self, anchor=None):
        return self.db.create_task(self.p, {**self.fields, 'planned_start':'2026-11-07', 'planned_finish':'2026-11-09', 'same_row_as':anchor or self.first})

    def test_repeats_survive_restart_and_keep_independent_dates_progress(self):
        tasks = self.add()['tasks']
        self.assertEqual([t['gantt_row_id'] for t in tasks], [self.first, self.first])
        self.db.update_task(tasks[1]['id'], {'progress':50})
        reopened = Database(self.path, seed_samples=False, holiday_fetcher=lambda year: [])
        tasks = reopened.get_project(self.p)['tasks']
        self.assertEqual([t['planned_start'] for t in tasks], ['2026-11-01','2026-11-07'])
        self.assertEqual([t['progress'] for t in tasks], [0,50])
        self.assertEqual(len({t['gantt_row_id'] for t in tasks}),1)

    def test_deleting_original_keeps_remaining_group_and_allows_more_repeats(self):
        second = self.add()['tasks'][1]['id']
        self.db.delete_task(self.first)
        tasks = self.add(second)['tasks']
        self.assertEqual(len(tasks),2)
        self.assertEqual({t['gantt_row_id'] for t in tasks}, {self.first})

    def test_foreign_or_missing_anchor_is_rejected_without_creating_task(self):
        q = self.db.create_project(dict(name='Other',start_date='2026-11-01'))['id']
        for anchor in ['missing', self.first]:
            with self.assertRaises(ScheduleError):
                self.db.create_task(q, {**self.fields,'same_row_as':anchor})
        self.assertEqual(self.db.get_project(q)['tasks'], [])

    def test_undo_restores_original_ungrouped_task(self):
        history = UndoHistory(self.db)
        with history.transaction() as db:
            before = snapshot(db)
            self.add()
            after = snapshot(db)
        history.undo(history.remember(before,after))
        with self.db.connection() as db:
            self.assertEqual(snapshot(db),before)

    def test_move_and_task_copy_start_new_rows(self):
        second = self.add()['tasks'][1]['id']
        copied = self.db.duplicate_row({'kind':'task','source_id':second})
        copy_id = copied['selection']['id']
        self.assertEqual(next(t for t in copied['project']['tasks'] if t['id']==copy_id)['gantt_row_id'],'')
        q = self.db.create_project(dict(name='Other',start_date='2026-11-01'))['id']
        moved = self.db.move_task(second,q)
        self.assertEqual(moved['tasks'][0]['gantt_row_id'],'')

    def test_same_row_defaults_match_anchor_color_and_preserve_migration(self):
        self.db.update_task(self.first, {'color':'#123456'})
        tasks = self.db.create_task(self.p, {**self.fields, 'same_row_as':self.first})['tasks']
        for field in ['planned_start','planned_finish','color']:
            self.assertEqual(tasks[0][field],tasks[1][field])
        with self.db.connection() as db:
            db.execute("ALTER TABLE project_tasks DROP COLUMN gantt_row_id")
        reopened = Database(self.path, seed_samples=False, holiday_fetcher=lambda year: [])
        tasks = reopened.get_project(self.p)['tasks']
        self.assertEqual(len(tasks),2)
        self.assertTrue(all(task['gantt_row_id'] == '' for task in tasks))

    def test_dependencies_cascade_and_undo_are_scoped_to_each_repeat(self):
        tasks = self.add()['tasks']
        second = tasks[1]['id']
        self.db.create_task(self.p, {**self.fields,'name':'첫 작업 후행','planned_start':'2026-11-04','planned_finish':'2026-11-05'})
        project = self.db.create_task(self.p, {**self.fields,'name':'둘째 작업 후행','planned_start':'2026-11-10','planned_finish':'2026-11-11'})
        first_child, second_child = [task['id'] for task in project['tasks'][-2:]]
        self.db.update_task(first_child, {'dependencies':[self.first]})
        self.db.update_task(second_child, {'dependencies':[second]})
        history = UndoHistory(self.db)
        with history.transaction() as db:
            before = snapshot(db)
            project = self.db.update_task(second, {'planned_finish':'2026-11-12','cascade_dependents':True})
            after = snapshot(db)
        by_id = {task['id']:task for task in project['tasks']}
        self.assertEqual(by_id[self.first]['planned_finish'],'2026-11-03')
        self.assertEqual(by_id[first_child]['planned_start'],'2026-11-04')
        self.assertEqual(by_id[second_child]['planned_start'],'2026-11-13')
        self.assertEqual(by_id[first_child]['dependencies'],[self.first])
        self.assertEqual(by_id[second_child]['dependencies'],[second])
        history.undo(history.remember(before,after))
        with self.db.connection() as db:
            self.assertEqual(snapshot(db),before)
        self.db.delete_task(second)
        by_id = {task['id']:task for task in self.db.get_project(self.p)['tasks']}
        self.assertEqual(by_id[first_child]['dependencies'],[self.first])
        self.assertEqual(by_id[second_child]['dependencies'],[])

    def test_same_row_creation_preserves_compact_category_and_physical_anchor(self):
        self.db.update_task(self.first, {'owner':'Vendor', 'group_name':'Assembly', 'tags':['urgent']})
        self.db.create_task(self.p, {**self.fields, 'name':'Different physical row'})
        tasks = self.add()['tasks']
        first, other, added = tasks
        self.assertEqual(added['gantt_row_id'], first['gantt_row_id'])
        self.assertEqual(other['gantt_row_id'], '')
        for field in ['owner','group_name','tags']:
            self.assertEqual(added[field],first[field])
        reopened = Database(self.path, seed_samples=False, holiday_fetcher=lambda year: [])
        self.assertEqual(reopened.get_project(self.p)['tasks'][-1]['tags'],['urgent'])
