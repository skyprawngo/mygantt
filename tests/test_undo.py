import tempfile
import unittest
from pathlib import Path
from mygantt.database import Database
from mygantt.undo import UndoHistory, snapshot
from mygantt.scheduler import ScheduleError

class UndoTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Database(Path(self.tmp.name)/'test.db', seed_samples=False, holiday_fetcher=lambda year: [])
        self.history = UndoHistory(self.db)
        self.p = self.db.create_project({'name':'P','start_date':'2026-10-08','calendar_type':'calendar'})
        self.db.create_task(self.p['id'], {'name':'A','planned_start':'2026-10-08','planned_finish':'2026-10-09'})
        self.task = self.db.get_project(self.p['id'])['tasks'][0]['id']

    def change(self, fn):
        with self.history.transaction() as db:
            before = snapshot(db)
            fn()
            after = snapshot(db)
        return self.history.remember(before, after), before

    def test_dates_progress_delete_and_multiple_undo(self):
        tokens=[]
        for fn in [lambda:self.db.update_task(self.task,{'planned_finish':'2026-10-15','progress':70}),
                   lambda:self.db.delete_project(self.p['id'])]:
            tokens.append(self.change(fn))
        for token, before in reversed(tokens):
            self.history.undo(token)
            with self.db.connection() as db:self.assertEqual(snapshot(db),before)

    def test_conflict_preserves_external_changes(self):
        token,_ = self.change(lambda:self.db.update_task(self.task,{'progress':50}))
        self.db.update_task(self.task,{'name':'External'})
        with self.assertRaises(ScheduleError):self.history.undo(token)
        self.assertEqual(self.db.get_project(self.p['id'])['tasks'][0]['name'],'External')

    def test_create_undo(self):
        token,before=self.change(lambda:self.db.create_project({'name':'New','start_date':'2026-10-08'}))
        self.history.undo(token)
        with self.db.connection() as db:self.assertEqual(snapshot(db),before)

    def test_http_write_returns_token_and_undo_restores_db(self):
        import threading
        import json
        from urllib.request import Request, urlopen
        from http.server import ThreadingHTTPServer
        from mygantt.server import make_handler
        server=ThreadingHTTPServer(('127.0.0.1',0),make_handler(self.db))
        thread=threading.Thread(target=server.serve_forever,daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base=f'http://127.0.0.1:{server.server_port}'
        def request(path,method,body):
            with urlopen(Request(base+path,data=json.dumps(body).encode(),method=method,
                                 headers={'Content-Type':'application/json'})) as response:
                data=json.load(response)
                data['_undo_token']=response.headers.get('X-MyGantt-Undo')
                return data
        changed=request('/api/tasks/'+self.task,'PATCH',{'progress':80})
        self.assertEqual(changed['tasks'][0]['progress'],80)
        request('/api/undo','POST',{'token':changed['_undo_token']})
        self.assertEqual(self.db.get_project(self.p['id'])['tasks'][0]['progress'],0)
        changed=request('/api/projects/'+self.p['id'],'DELETE',{})
        request('/api/undo','POST',{'token':changed['_undo_token']})
        self.assertIsNotNone(self.db.get_project(self.p['id']))

    def test_cascade_and_template_restore(self):
        self.db.create_task(self.p['id'],{'name':'B','planned_start':'2026-10-10','planned_finish':'2026-10-11'})
        child=self.db.get_project(self.p['id'])['tasks'][-1]['id']
        self.db.update_task(child,{'dependencies':[self.task]})
        token,before=self.change(lambda:self.db.update_task(self.task,{'planned_finish':'2026-10-13','cascade_dependents':True}))
        self.history.undo(token)
        with self.db.connection() as db:self.assertEqual(snapshot(db),before)
        template=self.db.save_template({'name':'T','tasks':[{'key':'a','name':'A','duration_value':2,'duration_unit':'days'}]})
        token,before=self.change(lambda:self.db.delete_template(template['id']))
        self.history.undo(token)
        with self.db.connection() as db:self.assertEqual(snapshot(db),before)
