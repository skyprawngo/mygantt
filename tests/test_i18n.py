import unittest
from mygantt.i18n import error_reference, translate

class TranslationTests(unittest.TestCase):
    def test_system_errors_have_ids_and_preserve_values(self):
        result = error_reference('알 수 없는 선행 작업: 고객 작업')
        self.assertEqual(result['params'], {'p0': '고객 작업'})
        self.assertEqual(translate(result['textID'], 'US'), 'Unknown predecessor: {p0}')

    def test_unknown_error_has_safe_fallback(self):
        self.assertEqual(error_reference('unexpected'), {'textID': 'error.unknown', 'params': {}})

    def test_supported_language_fallback(self):
        self.assertEqual(translate('settings.language', 'invalid'), '언어')
