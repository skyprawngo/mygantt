# MyGantt · 생산 일정 관리

MyGantt is a local browser app for reusable process templates and concurrent production batches. The Korean interface talks to a Python standard-library HTTP backend, which persists templates, project snapshots, task status and dependency edges in SQLite. It needs no package install or separate database service.

## Run locally on macOS or Linux

From the project root, run:

```sh
python3 -m mygantt.server --host 127.0.0.1 --port 8765
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765). Stop the server with `Ctrl+C`. It listens on loopback by default. The only external request is a read-only Korean public-holiday lookup by country and year; no project or task data is sent.

The first launch creates the editable **보드 제작 기본 공정** template and six example batches: MARKOS MAIN보드 50EA, MARKOS MAIN보드 200EA, MARKOS DIB보드 50EA, VIDEO, OUTPUT, and ICE640N 메인보드. Initial durations are clearly editable sample estimates, not supplied production commitments. Seed data is inserted only when the database has no templates.

For an empty production database, add `--no-seed` and set `--db` to a persistent path outside the source checkout. Keep `--no-seed` on every production start. It suppresses example templates and batches while preserving the schema, holiday fallback, and existing records. It does not remove data from an existing database.

## Templates and schedules

In **공정 템플릿**, add, remove, and rename arbitrary tasks; edit each task's duration in days or weeks, color and responsible team/vendor; set the default project tint; and check any number of predecessor tasks. A task with no predecessor is a parallel branch. A task with multiple predecessors waits for all of them. Use **일정 미리보기** to inspect the computed dates and catch cycles before saving. The board workflow is regular seed data in this same editor and scheduler.

Project creation copies every template task, color, dependency and the chosen project tint into an independent snapshot. Subsequent template edits do not alter existing projects. Creating a batch is idempotent for repeat submissions from the same form. The calendar-first Gantt groups each project summary row with its tasks, shows one column per calendar date and aligns the date header, day-of-week labels, project-tinted rows, Saturday/Sunday and holiday shading, task-color keys, and today marker during horizontal and vertical scrolling. Project rows collapse independently. Use the right-side **프로젝트 속성** and **작업 속성** sections to edit names, colors, group, tags, durations, ownership, status, blockers, handoff, dependencies, actual dates and notes. Project/task selection, accordion choice, and collapsed project rows survive reloads in that browser profile. The overall schedule supports sidebar project filters, text search, task status filters, group-by-group layout, start/name/progress sorting, Gantt/list layouts, date-column zoom, and a today button. Planned dates are read-only derived values. The explicit **오늘 완료 처리** action records today's actual dates; routine schedule recalculation leaves recorded actuals and completed task plan dates intact.

## Scheduling convention

- Dependencies are finish-to-start: a successor starts on the next eligible day after every predecessor finishes.
- The default **주 5일** calendar counts Monday–Friday and skips only Saturday and Sunday; **달력일** counts every day. Holiday labels never affect schedule calculations. The app refreshes countrywide Korean public-holiday dates from the [Nager.Date Community API](https://nagerholidays.com/api), whose documented coverage is the current year plus five future years. The source, last successful update, covered years, and stale/error state appear beside the Gantt legend. For 2026, refreshed provider data is combined with the verified [Korea Customs Service 2026 list](https://www.customs.go.kr/engportal/cm/cntnts/cntntsView.do?cntntsId=7401&mi=13284) and [Korea Astronomy and Space Science Institute 2026 calendar](https://astro.kasi.re.kr/kor/life/post/calendarData?search_year=2026); this preserves substitute dates missing from the community feed. The same checked snapshot remains available offline. For every other year, the app displays Nager.Date data alone and warns in the Gantt legend that substitute holidays may be missing; check an official calendar before relying on those dates. Nager.Date is community-maintained rather than a Korean government feed, so verify dates for payroll, legal or other authoritative use. Regional dates and memorial days may be excluded by the provider.
- Durations are positive whole numbers. One week means five workdays in the workday calendar and seven days in the calendar-day setting. Finish dates are inclusive.
- Scheduling is day-granular. It does not include working hours, resource leveling/capacity, external dependencies, or drag-to-reschedule bars. Bars are selectable, but dragging to reschedule is not implemented.
- Completed tasks retain their saved planned dates. Their actual finish date, when entered, anchors successor work. A status change alone does not invent or rewrite actual dates.

## Local data and backup

SQLite lives at `data/mygantt.sqlite3`. For a consistent manual backup, stop MyGantt and copy that file, for example:

```sh
cp data/mygantt.sqlite3 data/mygantt-backup.sqlite3
```

The app does not transmit schedules. Calendar export downloads a standard `.ics` snapshot that can be imported into Apple Calendar or Google Calendar. Editing that exported file in a calendar does not sync changes back. A provider-neutral adapter contract is in `mygantt/integrations/provider.py`; live Google/Apple sync, credentials, and account grants are not configured.

## Tests

Using only the Python standard library:

```sh
python3 -m unittest discover -s tests -v
node --check web/app.js
python3 -m compileall -q mygantt tests
```

Tests cover parallel branches, multi-predecessor joins, workday/calendar-day conventions, cycle and missing-edge rejection, completed actual dates, calendar export, the generic sample board graph, a completely different branching template, two isolated snapshots, template-color snapshots and overrides, repeat submissions, holiday parsing, cache refresh and offline fallback, API restart persistence, and local static serving.

Holiday data is cached persistently in SQLite. A successful response is reused for seven days; failed requests keep the last cached year and retry after six hours. With no provider cache, only the 2026 verified snapshot can be shown offline. Requests to Nager.Date contain only `KR` and the requested year; no API key or account grant is used. This remains a display calendar rather than an authoritative payroll calendar.

On first startup against an older SQLite file, MyGantt adds template/project/task color fields, holiday-cache storage, and the existing group/tag fields. It does not replace the database or rewrite stored actual dates or existing project snapshots. Migration tests build a legacy-schema database and verify preservation.

## CI and deployment

.github/workflows/ci.yml runs the standard-library test suite, Python compilation and JavaScript syntax check on GitHub-hosted Ubuntu workers, with pinned official actions and read-only repository permissions. PR jobs have no deployment credentials and never run on the production host. deploy/ubuntu supplies a credential-free host timer that accepts successful CI only for the exact current main SHA from a push or main dispatch, reruns local tests and switches releases. An unprivileged supervisor backs up SQLite before migration, checks startup and restores previous code on failure. Hardened units and private Docker/Unix-socket origin examples require reviewed host installation and a verified Cloudflare Access gate before public routing. See [Ubuntu deployment](deploy/ubuntu/README.md) for paths, boundaries and limitations.

## MVP limitations

The current UI can edit reusable templates and existing project tasks. It does not yet create one-off tasks inside an instantiated project, delete/archive projects, drag bars, draw dependency arrows, support milestones, custom calendars, or live bidirectional calendar sync. Holiday-provider coverage is limited to its documented current-year-plus-five-year window, with an offline snapshot only for 2026. Gantt bars show day-level planned ranges; list view carries the more detailed handoff/blocker fields.
