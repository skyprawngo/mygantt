import tempfile
import unittest
from pathlib import Path
from mygantt.database import Database

class TagColors(unittest.TestCase):
    def test_shared_colors_persist_and_validate(self):
        with tempfile.TemporaryDirectory() as folder:
            path=Path(folder)/'test.sqlite3'
            db=Database(path,holiday_fetcher=lambda year: [])
            db.set_tag_color(' Ｔeam  A ', '#CC6600')
            self.assertEqual(db.state()['tag_colors']['team a'],'#cc6600')
            db.set_tag_color('TEAM A','#229944')
            reopened=Database(path,holiday_fetcher=lambda year: [])
            self.assertEqual(reopened.state()['tag_colors'],{'team a':'#229944'})
            with self.assertRaises(ValueError): db.set_tag_color(' ','#229944')
            with self.assertRaises(ValueError): db.set_tag_color('team a','invalid')
            db.set_tag_color('team a','')
            self.assertEqual(db.state()['tag_colors'],{})
