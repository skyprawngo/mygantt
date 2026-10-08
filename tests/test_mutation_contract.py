"""Verify optimistic graph/date reducers against the real SQLite domain rules."""
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from mygantt.database import Database

ROOT = Path(__file__).resolve().parent.parent

class MutationContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.db = Database(Path(self.tmp.name) / 'test.db', seed_samples=False, holiday_fetcher=lambda year: [])
        self.project = self.db.create_project({'name':'P','start_date':'2026-10-01','calendar_type':'calendar'})
        self.other = self.db.create_project({'name':'Q','start_date':'2026-10-01','calendar_type':'calendar'})
        for name in ['a','b','c','d']:
            self.db.create_task(self.project['id'], {'name':name,'planned_start':'2026-10-08','planned_finish':'2026-10-09'})
        self.tasks = self.db.get_project(self.project['id'])['tasks']
        a,b,c,d = [t['id'] for t in self.tasks]
        for ident,deps in [(b,[a]),(c,[a]),(d,[b,c])]:
            self.db.update_task(ident,{'dependencies':deps})

    def preview(self, path, fields, method='PATCH'):
        payload = {'data':self.db.state(),'op':{'path':path,'fields':fields,'method':method,'tempId':'pending:test'}}
        script = "const fs=require('fs');const {data,op}=JSON.parse(fs.readFileSync(0,'utf8'));process.stdout.write(JSON.stringify(require('./web/mutations.js').apply(data,op)));"
        result = subprocess.run(['node','-e',script],input=json.dumps(payload),text=True,capture_output=True,cwd=ROOT,check=True)
        return json.loads(result.stdout)

    def assert_domain_equal(self, projected):
        fields = ['id','name','sort_order','progress','start_date','calendar_type','tags']
        task_fields = ['id','project_id','name','sort_order','dependencies','planned_start','planned_finish','actual_start','actual_finish','status','progress','tags','notes']
        def comparable(data):
            return sorted([{**{key:p.get(key) for key in fields},'tasks':sorted([{key:t.get(key) for key in task_fields} for t in p['tasks']],key=lambda t:t['id'])} for p in data['projects']],key=lambda p:p['id'])
        self.assertEqual(comparable(projected),comparable(self.db.state()))

    def test_dates_relations_status_and_tags(self):
        a,b,c,d = [t['id'] for t in self.tasks]
        for fields in [
            {'actual_finish':'2026-10-14','cascade_dependents':True},
            {'planned_finish':'2026-10-15','cascade_dependents':True},
            {'successors':[b,d]}, {'progress':50}, {'status':'done'}, {'tags':'Alpha, Beta, Alpha'},
        ]:
            with self.subTest(fields=fields):
                projected=self.preview(f'/api/tasks/{a}',fields)
                self.db.update_task(a,fields)
                self.assert_domain_equal(projected)

    def test_order_move_delete_and_project_metadata(self):
        a,b,c,d = [t['id'] for t in self.tasks]
        p,q=self.project['id'],self.other['id']
        cases=[
            (f'/api/tasks/{d}/order',{'anchor_id':a,'after':False},lambda:self.db.reorder_task(d,a,False),'PATCH'),
            (f'/api/tasks/{a}/project',{'project_id':p},lambda:self.db.move_task(a,p),'PATCH'),
            (f'/api/tasks/{a}/placement',{'directory_id':f'project:{q}'},lambda:self.db.move_task(a,q),'PATCH'),
            (f'/api/projects/{p}',{'sort_order':2,'start_date':'2026-11-01'},lambda:self.db.update_project(p,{'sort_order':2,'start_date':'2026-11-01'}),'PATCH'),
            (f'/api/tasks/{b}',{},lambda:self.db.delete_task(b),'DELETE'),
            (f'/api/projects/{q}/complete',{},lambda:self.db.complete_project(q),'POST'),
            (f'/api/projects/{q}',{},lambda:self.db.delete_project(q),'DELETE'),
        ]
        for path,fields,save,method in cases:
            with self.subTest(path=path):
                projected=self.preview(path,fields,method);save();self.assert_domain_equal(projected)

    def test_template_preview_friday_includes_trailing_weekend(self):
        template=self.db.save_template({'name':'T','tasks':[{'key':'a','name':'A','duration_value':2,'duration_unit':'days'}]})
        fields={'template_id':template['id'],'name':'New','start_date':'2026-10-15','calendar_type':'working'}
        projected=self.preview('/api/instantiate',fields,'POST')['projects'][-1]
        saved=self.db.instantiate(fields)
        self.assertEqual(projected['tasks'][0]['planned_finish'],'2026-10-18')
        for field in ['planned_start','planned_finish']:
            self.assertEqual(projected['tasks'][0][field],saved['tasks'][0][field])
