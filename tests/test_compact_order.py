import tempfile
import unittest
from pathlib import Path
from mygantt.database import Database
from mygantt.scheduler import ScheduleError
from mygantt.undo import UndoHistory, snapshot

class CompactOrderTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / 'test.db'
        self.db = Database(self.path, seed_samples=False, holiday_fetcher=lambda year: [])
        self.p = self.db.create_project({'name':'P','start_date':'2026-10-08'})['id']
        self.q = self.db.create_project({'name':'Q','start_date':'2026-10-08'})['id']
        for name in ['A','B','C','A']:
            project = self.db.create_task(self.p, {'name':name,
                'planned_start':'2026-10-08','planned_finish':'2026-10-09'})
            self.db.update_task(project['tasks'][-1]['id'], {'owner':name,'group_name':name,'tags':[name]})

    def fields(self, mode='owner', row='C', anchor='A'):
        key = lambda name: self.db._compact_row_key({'owner':name,'group_name':name,'tags':[name]},mode)
        return dict(mode=mode,project_id=self.p,row_id=key(row),anchor_id=key(anchor),after=False)

    def test_modes_persist_independently_and_preserve_schedule(self):
        before = self.db.state()['projects']
        for mode in ['owner','group','tags']:
            self.db.reorder_compact(self.fields(mode,'B' if mode == 'group' else 'C'))
        self.db.reorder_compact(dict(mode='owner',project_id=None,row_id=self.q,anchor_id=self.p,after=False))
        state = Database(self.path, seed_samples=False, holiday_fetcher=lambda year: []).state()
        self.assertEqual(state['projects'],before)
        self.assertEqual(state['compact_orders']['owner']['projects'],[self.q,self.p])
        self.assertEqual(state['compact_orders']['group']['projects'],[])
        for mode in ['owner','group','tags']:
            self.assertEqual(len(state['compact_orders'][mode]['tasks'][self.p]),3)
            self.assertEqual(state['compact_orders'][mode]['tasks'][self.p][0],self.fields(mode,'B' if mode == 'group' else 'C')['row_id'])

    def test_invalid_moves_do_not_write(self):
        for changes in [dict(mode='bad'),dict(project_id=self.q),dict(project_id='missing'),dict(anchor_id='missing'),dict(after='false')]:
            with self.assertRaises(ScheduleError): self.db.reorder_compact(self.fields() | changes)
        self.assertEqual(self.db.state()['compact_orders'],{})

    def test_order_undo_restores_previous_view(self):
        history=UndoHistory(self.db)
        self.db.reorder_compact(self.fields())
        with history.transaction() as db:
            before=snapshot(db)
            self.db.reorder_compact(self.fields(row='B'))
            after=snapshot(db)
        history.undo(history.remember(before,after))
        with self.db.connection() as db: self.assertEqual(snapshot(db),before)
