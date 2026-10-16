"""Persistent notes API, independent of schedule undo and existing schedules."""
import json
import tempfile
import threading
import unittest
from pathlib import Path
from http.server import ThreadingHTTPServer
from urllib.request import Request, urlopen
from urllib.error import HTTPError
from mygantt.database import Database
from mygantt.server import make_handler
from mygantt.undo import snapshot


class NotesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / 'notes.sqlite3'
        self.db = Database(self.path, seed_samples=False)
        self.server = ThreadingHTTPServer(('127.0.0.1', 0), make_handler(self.db))
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def call(self, path='/api/notes', method='GET', body=None):
        request = Request(f'http://127.0.0.1:{self.server.server_port}{path}', method=method,
                          data=json.dumps(body).encode() if body is not None else None,
                          headers={'Content-Type': 'application/json'})
        with urlopen(request) as response:
            return json.load(response)

    def test_multiple_notes_partial_updates_and_restart(self):
        with self.db.connection() as db:
            before = snapshot(db)
        self.assertEqual(self.call(), [])
        first = self.call(method='POST', body={'title': '회의', 'content': '첫 줄\n둘째 줄'})
        second = self.call(method='POST', body={'title': '할 일'})
        self.call('/api/notes/' + first['id'], 'PATCH', {'content': '<script>문자 그대로</script>'})
        self.call('/api/notes/' + first['id'], 'PATCH', {'title': '새 제목'})
        self.assertNotEqual(first['id'], second['id'])
        reopened = Database(self.path, seed_samples=False).list_notes()
        self.assertEqual(len(reopened), 2)
        self.assertEqual(reopened[0]['title'], '새 제목')
        self.assertEqual(reopened[0]['content'], '<script>문자 그대로</script>')
        with self.db.connection() as db:
            self.assertEqual(snapshot(db), before)

    def test_colors_and_deletion_persist(self):
        notes = [self.call(method='POST', body={'title': str(i)}) for i in range(7)]
        self.assertEqual([note['color'] for note in notes], [0, 1, 2, 3, 4, 0, 1])
        self.call('/api/notes/' + notes[1]['id'], 'DELETE')
        remaining = Database(self.path, seed_samples=False).list_notes()
        self.assertEqual([note['color'] for note in remaining], [0, 2, 3, 4, 0, 1])
        with self.assertRaises(HTTPError) as error:
            self.call('/api/notes/' + notes[1]['id'], 'PATCH', {'content': 'late save'})
        self.assertEqual(error.exception.code, 404)
        with self.assertRaises(HTTPError) as error:
            self.call('/api/notes/' + notes[1]['id'], 'DELETE')
        self.assertEqual(error.exception.code, 404)

    def test_existing_note_schema_migration(self):
        with self.db.connection() as db:
            db.execute('ALTER TABLE notes DROP COLUMN color')
            for i in range(3):
                db.execute("INSERT INTO notes VALUES (?, ?, ?, ?, ?)", (str(i), 'title', 'body', str(i), str(i)))
        migrated = Database(self.path, seed_samples=False).list_notes()
        self.assertEqual([note['color'] for note in migrated], [0, 1, 2])
        self.assertTrue(all(note['content'] == 'body' for note in migrated))

    def test_validation_and_missing_note(self):
        for body in ({'title': 'x' * 201}, {'content': 42}, {'content': 'x' * 100001}):
            with self.assertRaises(HTTPError) as error:
                self.call(method='POST', body=body)
            self.assertEqual(error.exception.code, 400)
        self.assertEqual(self.call(), [])
        with self.assertRaises(HTTPError) as error:
            self.call('/api/notes/missing', 'PATCH', {'title': 'missing'})
        self.assertEqual(error.exception.code, 404)
