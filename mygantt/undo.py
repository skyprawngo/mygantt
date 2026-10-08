"""Server-owned, bounded undo records; snapshots never come from the client."""
from collections import OrderedDict
from contextlib import contextmanager
import uuid
from .scheduler import ScheduleError

TABLES = ('templates', 'template_tasks', 'projects', 'project_tasks',
          'project_creation_requests', 'app_settings', 'directory_entries')


def snapshot(db):
    return {table: [dict(row) for row in db.execute(f'SELECT * FROM {table} ORDER BY 1')]
            for table in TABLES}


class UndoHistory:
    def __init__(self, database):
        self.database = database
        self.records = OrderedDict()

    @contextmanager
    def transaction(self):
        with self.database.connection() as db:
            db.execute('BEGIN IMMEDIATE')
            self.database._transaction.connection = db
            try:
                yield db
            finally:
                del self.database._transaction.connection

    def remember(self, before, after):
        if before == after:
            return None
        token = str(uuid.uuid4())
        self.records[token] = (before, after)
        while len(self.records) > 100:
            self.records.popitem(last=False)
        return token

    def undo(self, token):
        with self.transaction() as db:
            record = self.records.get(token)
            if record is None:
                raise ScheduleError('실행 취소 기록이 만료되었습니다. 페이지를 새로고침하세요.')
            before, after = record
            if snapshot(db) != after:
                raise ScheduleError('다른 변경사항이 있어 실행 취소할 수 없습니다. 새로고침 후 확인하세요.')
            db.execute('PRAGMA defer_foreign_keys = ON')
            for table in reversed(TABLES):
                db.execute(f'DELETE FROM {table}')
            for table in TABLES:
                # Project/task triggers rebuild directory entries during inserts.
                if table == 'directory_entries':
                    db.execute('DELETE FROM directory_entries')
                for row in before[table]:
                    columns = ','.join(row)
                    placeholders = ','.join('?' for _ in row)
                    db.execute(f'INSERT INTO {table} ({columns}) VALUES ({placeholders})', tuple(row.values()))
            for row in before['projects']:
                db.execute('UPDATE projects SET sort_order=? WHERE id=?', (row['sort_order'], row['id']))
            if snapshot(db) != before:
                raise ScheduleError('실행 취소 검증에 실패했습니다. 변경사항은 유지됩니다.')
        del self.records[token]
