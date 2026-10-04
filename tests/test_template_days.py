import tempfile
import unittest
from pathlib import Path
from mygantt.database import Database
from mygantt.scheduler import ScheduleError

class TemplateDayTests(unittest.TestCase):
  def test_roundtrip_offsets_overlap_and_existing_project_snapshot(self):
    with tempfile.TemporaryDirectory() as folder:
      db = Database(Path(folder) / 'test.sqlite3', holiday_fetcher=lambda year: [])
      payload = {'name':'D+ template', 'tasks':[
        {'key':'a','name':'A','duration_value':5,'duration_unit':'days','start_day':3,'dependencies':[]},
        {'key':'b','name':'B','duration_value':2,'duration_unit':'days','start_day':4,'dependencies':['a']},
        {'key':'c','name':'C','duration_value':1,'duration_unit':'days','dependencies':['a','b']}]}
      template = db.save_template(payload)
      self.assertEqual([t['start_day'] for t in db.get_template(template['id'])['tasks']], [3,4,None])
      project = db.instantiate({'template_id':template['id'],'name':'Test','start_date':'2026-10-05','calendar_type':'working'})
      self.assertEqual([(t['planned_start'],t['planned_finish']) for t in project['tasks']], [('2026-10-08','2026-10-15'),('2026-10-12','2026-10-13'),('2026-10-16','2026-10-18')])
      payload['tasks'][0]['start_day']=9
      db.save_template(payload, template['id'])
      self.assertEqual(db.get_project(project['id'])['tasks'],project['tasks'])
      for invalid in [0,-1,1.5,True,10001]:
        payload['tasks'][0]['start_day']=invalid
        with self.assertRaises(ScheduleError): db.save_template(payload)

  def test_instantiation_expands_weekends_and_friday_boundary(self):
    with tempfile.TemporaryDirectory() as folder:
      db = Database(Path(folder) / 'weekends.sqlite3', holiday_fetcher=lambda year: [])
      for start, days, expected in [('2026-11-02',5,'2026-11-08'),('2026-11-05',3,'2026-11-09'),('2026-11-02',10,'2026-11-15'),('2026-11-06',1,'2026-11-08'),('2026-11-02',4,'2026-11-05')]:
        template=db.save_template({'name':'weekends','tasks':[{'key':'a','name':'A','duration_value':days,'duration_unit':'days','dependencies':[]},{'key':'b','name':'B','duration_value':1,'duration_unit':'days','dependencies':['a']}]})
        project=db.instantiate({'template_id':template['id'],'name':'working','start_date':start,'calendar_type':'working'})
        self.assertEqual(project['tasks'][0]['planned_finish'],expected)
        self.assertNotIn(__import__('datetime').date.fromisoformat(project['tasks'][1]['planned_start']).weekday(),[5,6])
        if expected.endswith('08'): self.assertEqual(project['tasks'][1]['planned_start'],'2026-11-09')
      calendar=db.instantiate({'template_id':template['id'],'name':'calendar','start_date':'2026-11-03','calendar_type':'calendar'})
      self.assertEqual(calendar['tasks'][0]['planned_finish'],'2026-11-06')

  def test_week_basis_saved_and_seven_day_arithmetic(self):
    with tempfile.TemporaryDirectory() as folder:
      db=Database(Path(folder)/'basis.sqlite3',holiday_fetcher=lambda year: [])
      template=db.save_template({'name':'seven','calendar_type':'calendar','tasks':[{'key':'a','name':'A','duration_value':3,'duration_unit':'days','start_day':2,'dependencies':[]}]})
      self.assertEqual(db.get_template(template['id'])['calendar_type'],'calendar')
      project=db.instantiate({'template_id':template['id'],'name':'seven','start_date':'2026-10-09'})
      self.assertEqual((project['tasks'][0]['planned_start'],project['tasks'][0]['planned_finish']),('2026-10-10','2026-10-12'))

  def test_holiday_year_boundary_and_missing_coverage(self):
    with tempfile.TemporaryDirectory() as folder:
      db=Database(Path(folder)/'years.sqlite3',holiday_fetcher=lambda year: [{'date':f'{year}-01-01','name':'New year'}])
      tasks=[{'id':'a','duration_value':2,'duration_unit':'days','dependencies':[]}]
      result=db.schedule_template(tasks,'2026-12-31','working')
      self.assertEqual(result[0]['planned_finish'],'2027-01-04')
      self.assertEqual(db.schedule_template(tasks,'2026-12-31','calendar')[0]['planned_finish'],'2027-01-01')
      db.holidays=lambda *args, **kwargs: {'coverage_years':[],'holidays':[]}
      with self.assertRaises(ScheduleError): db.schedule_template(tasks,'2027-01-04','working')
