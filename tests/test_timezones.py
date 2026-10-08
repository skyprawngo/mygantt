import unittest
from unittest.mock import patch
from mygantt.timezones import server_clock
class TimeZoneTests(unittest.TestCase):
    def test_explicit_server_environment(self):
        with patch.dict('os.environ',{'TZ':'Asia/Kolkata'}):
            self.assertEqual(server_clock(),{'time_zone':'Asia/Kolkata','offset_minutes':330})
    def test_invalid_environment_falls_back_without_crashing(self):
        with patch.dict('os.environ',{'TZ':'Invalid/Zone'}):
            result=server_clock()
            self.assertIsInstance(result['offset_minutes'],int)
