import tempfile
import unittest
from pathlib import Path
from mygantt.database import Database

class TemplateMetadataTests(unittest.TestCase):
    def test_roundtrip_instantiation_overrides_and_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'test.sqlite3'
            db = Database(path, seed_samples=False, holiday_fetcher=lambda year: [])
            payload = {'name': 'Template', 'group_name': ' Production ', 'tags': ['Batch', 'Batch'], 'tasks': [
                {'key': 'a', 'name': 'A', 'duration_value': 1, 'duration_unit': 'days', 'dependencies': [], 'group_name': ' QA ', 'tags': ['Check']}]}
            template = db.save_template(payload)
            self.assertEqual(template['group_name'], 'Production')
            self.assertEqual(template['tags'], ['Batch'])
            self.assertEqual(template['tasks'][0]['group_name'], 'QA')
            self.assertEqual(template['tasks'][0]['tags'], ['Check'])
            db = Database(path, seed_samples=False, holiday_fetcher=lambda year: [])
            self.assertEqual(db.get_template(template['id']), template)
            args = {'template_id': template['id'], 'name': 'Instance', 'start_date': '2026-10-08', 'calendar_type': 'calendar'}
            project = db.instantiate(args)
            self.assertEqual(project['group_name'], 'Production')
            self.assertEqual(project['tags'], ['Batch'])
            self.assertEqual(project['tasks'][0]['tags'], ['Check'])
            self.assertEqual(project['tasks'][0]['group_name'], 'QA')
            override = db.instantiate({**args, 'group_name': '', 'tags': []})
            self.assertEqual(override['group_name'], '')
            self.assertEqual(override['tags'], [])
            payload.update(group_name='Changed', tags=[])
            payload['tasks'][0].update(group_name='', tags=[])
            changed = db.save_template(payload, template['id'])
            self.assertEqual(changed['tags'], [])
            self.assertEqual(changed['tasks'][0]['tags'], [])
            self.assertEqual(db.get_project(project['id']), project)

    def test_existing_schema_migrates_with_empty_defaults(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'test.sqlite3'
            db = Database(path, seed_samples=False)
            template = db.save_template({'name':'Old', 'tasks':[{'key':'a','name':'A','duration_value':1,'duration_unit':'days'}]})
            with db.connection() as conn:
                for table in ('templates', 'template_tasks'):
                    for field in ('group_name', 'tags'):
                        conn.execute(f'ALTER TABLE {table} DROP COLUMN {field}')
            db = Database(path, seed_samples=False)
            restored = db.get_template(template['id'])
            self.assertEqual(restored['tags'], [])
            self.assertEqual(restored['tasks'][0]['tags'], [])
            self.assertEqual(restored['tasks'][0]['name'], 'A')
