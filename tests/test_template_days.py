import tempfile
import unittest
from pathlib import Path
from mygantt.database import Database
from mygantt.scheduler import ScheduleError

class TemplateDayTests(unittest.TestCase):
  def test_roundtrip_offsets_overlap_and_existing_project_snapshot(self):
    with tempfile.TemporaryDirectory() as folder:
      db = Database(Path(folder) / 'test.sqlite3')
      payload = {'name':'D+ template', 'tasks':[
        {'key':'a','name':'A','duration_value':5,'duration_unit':'days','start_day':3,'dependencies':[]},
        {'key':'b','name':'B','duration_value':2,'duration_unit':'days','start_day':4,'dependencies':['a']},
        {'key':'c','name':'C','duration_value':1,'duration_unit':'days','dependencies':['a','b']}]}
      template = db.save_template(payload)
      self.assertEqual([t['start_day'] for t in db.get_template(template['id'])['tasks']], [3,4,None])
      project = db.instantiate({'template_id':template['id'],'name':'Test','start_date':'2026-10-05','calendar_type':'working'})
      self.assertEqual([(t['planned_start'],t['planned_finish']) for t in project['tasks']], [('2026-10-07','2026-10-13'),('2026-10-08','2026-10-11'),('2026-10-14','2026-10-14')])
      payload['tasks'][0]['start_day']=9
      db.save_template(payload, template['id'])
      self.assertEqual(db.get_project(project['id'])['tasks'],project['tasks'])
      for invalid in [0,-1,1.5,True,10001]:
        payload['tasks'][0]['start_day']=invalid
        with self.assertRaises(ScheduleError): db.save_template(payload)

  def test_instantiation_expands_weekends_and_friday_boundary(self):
    with tempfile.TemporaryDirectory() as folder:
      db = Database(Path(folder) / 'weekends.sqlite3')
      for start, days, expected in [('2026-10-05',5,'2026-10-11'),('2026-10-08',3,'2026-10-12'),('2026-10-05',10,'2026-10-18'),('2026-10-09',1,'2026-10-11'),('2026-10-05',4,'2026-10-08')]:
        template=db.save_template({'name':'weekends','tasks':[{'key':'a','name':'A','duration_value':days,'duration_unit':'days','dependencies':[]},{'key':'b','name':'B','duration_value':1,'duration_unit':'days','dependencies':['a']}]})
        project=db.instantiate({'template_id':template['id'],'name':'working','start_date':start,'calendar_type':'working'})
        self.assertEqual(project['tasks'][0]['planned_finish'],expected)
        self.assertNotIn(__import__('datetime').date.fromisoformat(project['tasks'][1]['planned_start']).weekday(),[5,6])
        if expected.endswith('11'): self.assertEqual(project['tasks'][1]['planned_start'],'2026-10-12')
      calendar=db.instantiate({'template_id':template['id'],'name':'calendar','start_date':'2026-10-06','calendar_type':'calendar'})
      self.assertEqual(calendar['tasks'][0]['planned_finish'],'2026-10-09')
