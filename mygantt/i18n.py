"""Translation IDs for system-owned API errors; user records are never translated."""
from __future__ import annotations
import json
import re
from functools import lru_cache
from pathlib import Path

@lru_cache(maxsize=1)
def text_table() -> dict[str, dict[str, str]]:
    path = Path(__file__).resolve().parents[1] / 'web' / 'translations.json'
    return {row['textID']: row for row in json.loads(path.read_text(encoding='utf-8'))}

def translate(text_id: str, language: str = 'KR') -> str:
    return text_table()[text_id][language if language in ('KR', 'US', 'JP') else 'KR']

@lru_cache(maxsize=1)
def error_patterns():
    result = []
    for text_id, row in text_table().items():
        parts = re.split(r'(\{\w+\})', row['KR'])
        keys = [part[1:-1] for part in parts if re.fullmatch(r'\{\w+\}', part)]
        pattern = ''.join(r'([\s\S]*?)' if re.fullmatch(r'\{\w+\}', part) else re.escape(part) for part in parts)
        result.append((text_id, keys, re.compile('^' + pattern + '$')))
    return result

def error_reference(message: str) -> dict:
    for text_id, keys, pattern in error_patterns():
        match = pattern.fullmatch(message)
        if match:
            return {'textID': text_id, 'params': dict(zip(keys, match.groups()))}
    return {'textID': 'error.unknown', 'params': {}}
