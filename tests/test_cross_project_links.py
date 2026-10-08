import tempfile
import unittest
from pathlib import Path
from mygantt.database import Database
from mygantt.scheduler import ScheduleError
from mygantt.undo import UndoHistory, snapshot

class CrossProjectLinksTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.db=Database(Path(self.tmp.name)/'test.db',seed_samples=False,holiday_fetcher=lambda year:[])
        self.projects=[self.db.create_project({'name':name,'start_date':'2026-10-01','calendar_type':'calendar'}) for name in ['P','Q','R']]
        self.tasks=[self.db.create_task(p['id'],{'name':'Same name','planned_start':'2026-10-08','planned_finish':'2026-10-09'})['tasks'][0]['id'] for p in self.projects]

    def links(self):
        with self.db.connection() as db:return [dict(row) for row in db.execute('SELECT * FROM task_links')]

    def test_uuid_link_move_cascade_and_delete(self):
        a,b,c=self.tasks
        result=self.db.update_task(a,{'successors':[b]})
        self.assertEqual(result['affected_projects'][0]['id'],self.projects[1]['id'])
        self.db.update_task(c,{'dependencies':[b]})
        self.db.update_task(a,{'planned_finish':'2026-10-12','cascade_dependents':True})
        self.assertEqual(self.db.get_project(self.projects[2]['id'])['tasks'][0]['planned_start'],'2026-10-11')
        self.db.move_task(b,self.projects[0]['id'])
        link=next(row for row in self.links() if row['successor_task_id']==b)
        self.assertEqual(link['successor_project_id'],self.projects[0]['id'])
        self.assertEqual(link['predecessor_task_id'],a)
        self.db.delete_project(self.projects[0]['id'])
        self.assertEqual(self.links(),[])
        self.assertEqual(self.db.get_project(self.projects[2]['id'])['tasks'][0]['dependencies'],[])

    def test_cycle_self_and_unknown_rejected_atomically(self):
        a,b,c=self.tasks
        self.db.update_task(b,{'dependencies':[a]})
        self.db.update_task(c,{'dependencies':[b]})
        before=self.db.state()
        for fields in [{'dependencies':[c]},{'dependencies':[a]},{'dependencies':['missing']},{'successors':['missing']}]:
            with self.subTest(fields=fields),self.assertRaises(ScheduleError):self.db.update_task(a,fields)
            self.assertEqual(self.db.state(),before)

    def test_migration_idempotent_preserves_links_and_undo(self):
        a,b,_=self.tasks
        self.db.update_task(b,{'dependencies':[a]})
        original=self.db.state();self.db.initialize();self.assertEqual(self.db.state(),original)
        history=UndoHistory(self.db)
        with history.transaction() as db:
            before=snapshot(db)
            self.db.update_task(a,{'planned_finish':'2026-10-15','cascade_dependents':True})
            after=snapshot(db)
        history.undo(history.remember(before,after))
        self.assertEqual(self.db.state(),original)

    def test_upgrade_backs_up_and_preserves_existing_same_project_links(self):
        a,b,_=self.tasks
        self.db.move_task(b,self.projects[0]['id'])
        self.db.update_task(b,{'dependencies':[a]})
        before=self.db.state()
        with self.db.connection() as db:
            db.execute('DROP TRIGGER task_links_cleanup')
            db.execute('DROP VIEW task_links')
            db.execute("DELETE FROM schema_migrations WHERE migration_key='cross-project-dependencies-v1'")
        self.db.initialize()
        self.assertEqual(self.db.state(),before)
        self.assertEqual(len(self.links()),1)
        self.assertTrue(list(Path(self.tmp.name).glob('*.before-task-links-*.bak')))
