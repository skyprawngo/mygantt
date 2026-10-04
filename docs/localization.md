# UI 번역

`web/translations.json`이 공통 번역 테이블입니다. 각 행은 정확히 `textID`, `KR`, `US`, `JP` 네 속성을 갖습니다. `textID`는 저장 데이터의 이름이 아니라 UI 문구의 안정적인 식별자입니다. `status`, `common`, `navigation`, `calendar`, `timeline`, `inspector`, `task`, `template`, `project`, `settings`, `help`, `error`, `holiday`, `source` 접두어로 범주를 구분합니다.

```json
{"textID":"settings.language","KR":"언어","US":"Language","JP":"言語"}
```

- JavaScript: `t('settings.language')`. 동적 값은 `{p0}` 등의 매개변수로 전달합니다. 한국어·영어·일본어의 매개변수 집합은 같아야 합니다.
- 정적 HTML: `data-i18n="settings.language"`. 속성은 `data-i18n-attrs="aria-label:settings.language"`처럼 지정하며 여러 속성은 세미콜론으로 구분합니다.
- `I18n.apply(document)`는 명시적으로 표시된 노드와 HTML template 내용만 갱신합니다. 일반 DOM 텍스트를 검색해서 바꾸지 않습니다.
- 언어 선택은 설정의 언어 메뉴에서 하며, `mygantt-language` 키로 해당 브라우저에 저장됩니다. 기본값은 `KR`입니다. 서버의 사용자·작업 데이터나 다른 기기의 언어는 변경하지 않습니다.
- 프로젝트명, 작업명, 템플릿 이름, 담당, 태그, 그룹, 메모 등 사용자 입력은 번역하지 않습니다. 표시용 날짜 형식과 요일은 선택한 언어를 사용하지만 저장 날짜·주 5일 계산·공휴일 지역은 변경하지 않습니다.
- 서버 오류는 기존 `error` 문자열을 유지하면서 `textID`와 `params`를 추가합니다. 프런트엔드는 키로 표시합니다. 재시작 전 서버와의 호환을 위해 서버 오류 문자열만 카탈로그와 대조하는 경로가 있으며, 사용자 데이터에는 적용하지 않습니다.
- 설치용 manifest 이름과 언어는 `?language=KR` · `?language=US` · `?language=JP`로 제공합니다. 이미 설치된 앱의 OS 표시 이름 갱신 시점은 브라우저가 결정합니다.

새 문구는 테이블에 두 언어를 함께 추가하고 UI에서 해당 키를 참조하세요. HTML 마크업은 번역 테이블에 넣지 말고 뷰에서 구성합니다. 기존 키의 의미를 바꾸지 말고 의미가 달라지면 새 키를 추가합니다. 사용자 입력이 들어가는 HTML은 기존처럼 `esc()`로 이스케이프합니다.

검증: `node --test tests/test_*.cjs`, `python3 -m unittest discover -s tests`. 번역 테스트는 키 중복·누락, 두 언어의 매개변수, 언어 저장, 오류 번역과 사용자 값 보존을 검사합니다.
