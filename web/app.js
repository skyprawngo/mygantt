const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let savedUi = {};
try { savedUi = JSON.parse(localStorage.getItem('mygantt-ui') || '{}'); } catch { savedUi = {}; }
const state = { data: { templates: [], projects: [] }, view: 'timeline', layout: 'gantt', zoom: 'week', filterProject: null, selectedTemplateId: null, draft: null, preview: null, selection: savedUi.selection || null, inspectorOpen: savedUi.inspectorOpen || 'project', collapsedProjects: new Set(savedUi.collapsedProjects || []), holidays: {} };
const statusNames = { todo: '예정', doing: '진행 중', blocked: '막힘', done: '완료' };
const durationNames = { days: '일', weeks: '주' };
const projectColors = ['#5872d9', '#b96749', '#27897f', '#a45ca8', '#b48527', '#3978a8', '#c45670', '#5a8d45', '#765bb2', '#368a9b', '#c06f2d', '#657386'];
const taskColors = [...projectColors];
let previewTimer;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
function todayInput() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
function dateFrom(value) { return new Date(`${value}T00:00:00`); }
function dateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function dayDiff(start, end) { return Math.round((dateFrom(end) - dateFrom(start)) / 86400000); }
function fmtDate(value, year = false) {
  if (!value) return '—';
  const d = dateFrom(value);
  return year ? `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}` : `${d.getMonth() + 1}/${d.getDate()}`;
}
function dateRangeLabel(start, end) {
  if (!start || !end) return '일정 없음';
  return `${fmtDate(start, true)} — ${fmtDate(end, true)}`;
}
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => node.classList.remove('show'), 2600);
}
async function api(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data?.error || `요청 실패 (${response.status})`);
  return data;
}
async function loadState() {
  state.data = await api('/api/state');
  const dates = state.data.projects.flatMap((project) => project.tasks.flatMap((task) => [task.planned_start, task.planned_finish])).filter(Boolean).sort();
  const start = dates[0] && dates[0] < todayInput() ? dates[0] : todayInput();
  const end = dates.at(-1) && dates.at(-1) > todayInput() ? dates.at(-1) : todayInput();
  try {
    state.holidayData = await api(`/api/holidays?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
  } catch (error) {
    state.holidayData = { region: 'KR', source_label: 'Nager.Date Community API v4', status: 'unavailable', last_updated: null, coverage_years: [], holidays: [], last_error: error.message };
  }
  if (!state.selectedTemplateId && state.data.templates.length) state.selectedTemplateId = state.data.templates[0].id;
  if (state.selectedTemplateId && !state.data.templates.some((t) => t.id === state.selectedTemplateId)) state.selectedTemplateId = state.data.templates[0]?.id || null;
  state.holidays = Object.fromEntries((state.holidayData?.holidays || []).map((holiday) => [holiday.date, holiday.name]));
  if (!state.data.projects.some((project) => project.id === state.selection?.id || project.tasks.some((task) => task.id === state.selection?.id))) state.selection = null;
  renderAll();
}
function persistUi() {
  localStorage.setItem('mygantt-ui', JSON.stringify({ selection: state.selection, inspectorOpen: state.inspectorOpen, collapsedProjects: [...state.collapsedProjects] }));
}
function selectItem(type, id) {
  state.selection = id ? { type, id } : null;
  state.inspectorOpen = type === 'task' ? 'task' : 'project';
  persistUi();
  renderTimeline();
}
function switchView(view) {
  state.view = view;
  state.filterProject = null;
  $('#timeline-view').classList.toggle('hidden', view !== 'timeline');
  $('#templates-view').classList.toggle('hidden', view !== 'templates');
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $('#breadcrumb-title').textContent = view === 'timeline' ? '전체 일정' : '공정 템플릿';
  renderAll();
}
function renderAll() {
  renderSidebar();
  if (state.view === 'timeline') renderTimeline();
  else renderTemplates();
}
function renderSidebar() {
  $('#project-count').textContent = state.data.projects.length;
  $('#sidebar-projects').innerHTML = state.data.projects.map((project) => `
    <button class="side-project ${state.selection?.type === 'project' && state.selection.id === project.id ? 'selected' : ''}" data-project="${esc(project.id)}" title="${esc(project.name)}">
      <i style="background:${esc(project.color)}"></i><span>${esc(project.name)}</span><span class="side-progress">${project.progress}%</span>
    </button>`).join('');
  $$('.side-project').forEach((button) => button.addEventListener('click', () => {
    switchView('timeline');
    state.filterProject = button.dataset.project;
    selectItem('project', button.dataset.project);
  }));
}
function filteredProjects() {
  let projects = [...state.data.projects];
  if (state.filterProject) projects = projects.filter((project) => project.id === state.filterProject);
  const query = ($('#search-filter')?.value || '').trim().toLocaleLowerCase();
  const status = $('#status-filter')?.value || 'all';
  projects = projects.map((project) => ({
    ...project,
    tasks: project.tasks.filter((task) => {
      const projectMatch = !query || [project.name, project.group_name, ...(project.tags || [])].some((value) => String(value || '').toLocaleLowerCase().includes(query));
      const taskMatch = !query || [task.name, task.owner, task.handoff, task.blocker, task.group_name, ...(task.tags || [])].some((value) => String(value || '').toLocaleLowerCase().includes(query));
      return (projectMatch || taskMatch) && (status === 'all' || task.status === status);
    }),
  })).filter((project) => project.tasks.length);
  const sort = $('#sort-select')?.value || 'start';
  projects.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, 'ko') : sort === 'progress' ? b.progress - a.progress : a.start_date.localeCompare(b.start_date));
  return projects;
}
function flatten(projects) { return projects.flatMap((project) => project.tasks.map((task) => ({ ...task, projectName: project.name, projectId: project.id }))); }
const weekdayNames = ['일', '월', '화', '수', '목', '금', '토'];
function dateColumns(start, days, perDay) {
  const first = dateFrom(start);
  return Array.from({ length: days }, (_, index) => {
    const current = new Date(first);
    current.setDate(first.getDate() + index);
    const key = dateKey(current);
    const holiday = state.holidays[key];
    const isWeekend = current.getDay() === 0 || current.getDay() === 6;
    const today = key === todayInput();
    const dateText = current.getDate() === 1 || index === 0 ? `${current.getMonth() + 1}.${current.getDate()}` : String(current.getDate());
    return { key, holiday, isWeekend, saturday: current.getDay() === 6, sunday: current.getDay() === 0, today, dateText, weekday: weekdayNames[current.getDay()], x: index * perDay };
  });
}
function renderHolidayStatus() {
  const node = $('#calendar-coverage');
  if (!node) return;
  const holidayData = state.holidayData || {};
  const source = holidayData.source_label || holidayData.source || 'Nager.Date Community API v4';
  const updated = holidayData.last_updated ? holidayData.last_updated.slice(0, 10) : '갱신일 기록 없음';
  const years = holidayData.coverage_years || [];
  const unverifiedSubstituteYears = (holidayData.requested_years || years).filter((year) => Number(year) !== 2026);
  const coverage = years.length ? years.join(', ') : `자료 없음 · 지원 ${holidayData.supported_years?.from || '현재'}–${holidayData.supported_years?.through || '현재+5년'}`;
  const freshness = holidayData.status === 'fresh' ? '최신' : holidayData.status === 'stale' ? (holidayData.last_error ? '갱신 실패 · 저장 자료 표시' : '저장 자료 표시') : '자료 없음';
  const substituteWarning = unverifiedSubstituteYears.length ? `⚠ ${unverifiedSubstituteYears.join(', ')}년 대체공휴일 누락 가능 · ` : '';
  node.textContent = `${substituteWarning}공휴일 ${source} · 갱신 ${updated} · 범위 ${coverage} · ${freshness}`;
  node.dataset.status = holidayData.status || 'unavailable';
  node.dataset.substituteWarning = String(unverifiedSubstituteYears.length > 0);
  const warnings = [];
  if (unverifiedSubstituteYears.length) warnings.push(`2026년 외 연도(${unverifiedSubstituteYears.join(', ')})는 Nager.Date 자료만 사용합니다. 대체공휴일이 누락될 수 있으니 공식 달력을 확인하세요.`);
  if (holidayData.last_error) warnings.push(holidayData.last_error);
  if (holidayData.unsupported_years?.length) warnings.push(`자동 제공 범위 밖: ${holidayData.unsupported_years.join(', ')}`);
  node.title = warnings.join('\n') || '공휴일은 일정 계산에 반영하지 않습니다.';
  node.setAttribute('aria-label', node.textContent);
}
function projectBounds(projects) {
  const tasks = flatten(projects);
  const starts = tasks.map((task) => task.planned_start).filter(Boolean).sort();
  const ends = tasks.map((task) => task.planned_finish).filter(Boolean).sort();
  if (!starts.length) return { start: todayInput(), end: todayInput() };
  return { start: starts[0], end: ends[ends.length - 1] };
}
function renderTimeline() {
  const projects = filteredProjects();
  const tasks = flatten(projects);
  const bounds = projectBounds(projects);
  let start = bounds.start; let end = bounds.end;
  const today = todayInput();
  if (today < start) start = today;
  if (today > end) end = today;
  const days = Math.max(1, dayDiff(start, end) + 1);
  $('#range-label').textContent = dateRangeLabel(bounds.start, bounds.end);
  const pxPerDay = { day: 62, week: 46, month: 34 }[state.zoom];
  const labelWidth = 254;
  const timelineWidth = Math.max(720, days * pxPerDay);
  const dates = dateColumns(start, days, pxPerDay);
  renderHolidayStatus();
  $('#gantt-wrap').classList.toggle('hidden', state.layout !== 'gantt' || !tasks.length);
  $('#list-wrap').classList.toggle('hidden', state.layout !== 'list' || !tasks.length);
  $('#empty-state').classList.toggle('hidden', tasks.length > 0);
  if (!tasks.length) { $('#gantt').innerHTML = ''; $('#list-wrap').innerHTML = ''; renderInspector(); return; }
  const todayOffset = dayDiff(start, today);
  let rows = '';
  let bodyHeight = 0;
  const rowShading = dates.map((item) => `<div class="date-shade ${item.isWeekend ? 'weekend-shade' : ''} ${item.saturday ? 'weekend-saturday' : ''} ${item.sunday ? 'weekend-sunday' : ''} ${item.holiday ? 'holiday-shade' : ''}" style="left:${item.x}px;width:${pxPerDay}px" title="${item.key}${item.holiday ? ` · ${esc(item.holiday)}` : item.isWeekend ? ' · 주말' : ''}"></div>`).join('');
  const timelineCellStyle = `--day-width:${pxPerDay}px;`;
  const groupMode = $('#group-select')?.value === 'group';
  const groupedProjects = groupMode ? [...projects.reduce((groups, project) => {
    const groupName = project.group_name?.trim() || '그룹 미지정';
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(project);
    return groups;
  }, new Map()).entries()].sort(([a], [b]) => a.localeCompare(b, 'ko')).map(([name, items]) => ({ name, projects: items })) : [{ name: '', projects }];
  for (const projectGroup of groupedProjects) {
    if (groupMode) {
      rows += `<div class="gantt-row group-header-row"><div class="gantt-left"><span class="group-header-label"><i></i>${esc(projectGroup.name)}<small>${projectGroup.projects.length}개 프로젝트</small></span></div><div class="gantt-right" style="width:${timelineWidth}px"></div></div>`;
      bodyHeight += 30;
    }
    for (const project of projectGroup.projects) {
    const collapsed = state.collapsedProjects.has(project.id);
    const projectStart = project.tasks.map((task) => task.planned_start).filter(Boolean).sort()[0];
    const projectFinish = project.tasks.map((task) => task.planned_finish).filter(Boolean).sort().at(-1);
    const projectX = Math.max(0, dayDiff(start, projectStart || start)) * pxPerDay;
    const projectBarWidth = Math.max(pxPerDay, (dayDiff(projectStart || start, projectFinish || projectStart || start) + 1) * pxPerDay);
    const isProjectSelected = state.selection?.type === 'project' && state.selection.id === project.id;
      rows += `<div class="gantt-row project-row ${isProjectSelected ? 'selected-row' : ''}" style="--project-color:${esc(project.color)}">
      <div class="gantt-left project-left">
        <button class="collapse-toggle" type="button" data-collapse="${esc(project.id)}" aria-label="${collapsed ? '펼치기' : '접기'} ${esc(project.name)}">${collapsed ? '›' : '⌄'}</button>
        <button class="project-select" type="button" data-project-select="${esc(project.id)}"><i class="group-dot" style="background:${esc(project.color)}"></i><span class="project-name" title="${esc(project.name)}">${esc(project.name)}</span><span class="project-meta">${project.progress}%</span></button>
      </div>
      <div class="gantt-right project-timeline" style="width:${timelineWidth}px;${timelineCellStyle}"><div class="row-date-shading">${rowShading}</div><div class="today-line" style="left:${todayOffset * pxPerDay}px"></div><button class="project-summary-bar" type="button" data-project-select="${esc(project.id)}" style="left:${projectX}px;width:${projectBarWidth}px;--bar-color:${esc(project.color)}" title="프로젝트 기간 ${fmtDate(projectStart, true)} — ${fmtDate(projectFinish, true)}"><i style="width:${project.progress}%"></i><span>${esc(project.name)} · ${project.progress}%</span></button></div>
    </div>`;
    bodyHeight += 38;
    if (collapsed) continue;
    for (const task of project.tasks) {
      const startX = Math.max(0, dayDiff(start, task.planned_start)) * pxPerDay;
      const width = Math.max(pxPerDay, (dayDiff(task.planned_start, task.planned_finish) + 1) * pxPerDay);
      const status = task.status;
      const isSelected = state.selection?.type === 'task' && state.selection.id === task.id;
      rows += `<div class="gantt-row task-row ${isSelected ? 'selected-row' : ''}" style="--project-color:${esc(project.color)}">
        <div class="gantt-left task-left"><button class="task-label" type="button" data-task-select="${esc(task.id)}" data-project="${esc(project.id)}"><i class="task-state ${status}" style="--task-color:${esc(task.color)}" title="${esc(statusNames[status] || status)}"></i><span class="task-name" title="${esc(task.name)}">${esc(task.name)}</span><span class="task-owner">${esc(task.owner || '담당 미지정')}</span></button></div>
        <div class="gantt-right project-timeline" style="width:${timelineWidth}px;${timelineCellStyle}"><div class="row-date-shading">${rowShading}</div><div class="today-line" style="left:${todayOffset * pxPerDay}px"></div><button class="task-bar ${status}" type="button" data-task-select="${esc(task.id)}" data-project="${esc(project.id)}" style="left:${startX}px;width:${width}px;--bar-color:${esc(task.color)}" title="${esc(task.name)} · ${fmtDate(task.planned_start, true)}–${fmtDate(task.planned_finish, true)}"><i class="bar-progress" style="width:${status === 'done' ? 100 : status === 'doing' ? 45 : 0}%"></i><span class="bar-text">${esc(task.name)}</span></button></div>
      </div>`;
      bodyHeight += 36;
    }
    }
  }
  const headerDates = dates.map((item) => `<div class="date-header ${item.saturday ? 'saturday' : ''} ${item.sunday ? 'sunday' : ''} ${item.holiday ? 'holiday' : ''} ${item.today ? 'today' : ''}" style="width:${pxPerDay}px" title="${item.key}${item.holiday ? ` · ${esc(item.holiday)}` : ''}"><b>${esc(item.dateText)}</b><small>${item.weekday}</small>${item.holiday ? `<i>${esc(item.holiday)}</i>` : ''}</div>`).join('');
  $('#gantt').innerHTML = `<div class="gantt-head"><div class="gantt-left gantt-head-left" style="width:${labelWidth}px"><span>프로젝트 / 작업</span></div><div class="gantt-right gantt-head-right" style="width:${timelineWidth}px"><div class="date-axis">${headerDates}</div></div></div><div class="gantt-body" style="width:${labelWidth + timelineWidth}px;min-height:${bodyHeight}px">${rows}</div>`;
  renderInspector();
  $('#list-wrap').innerHTML = `<table class="list-table"><thead><tr><th>프로젝트</th><th>작업</th><th>담당 / 협력사</th><th>예정</th><th>상태</th><th>막힘</th><th>다음 인계</th></tr></thead><tbody>${projects.flatMap((project) => project.tasks.map((task) => `<tr class="list-task-row" data-project="${esc(project.id)}" data-task="${esc(task.id)}"><td>${esc(project.name)}</td><td class="list-task">${esc(task.name)}</td><td>${esc(task.owner || '미지정')}</td><td>${fmtDate(task.planned_start, true)} – ${fmtDate(task.planned_finish, true)}</td><td><span class="status-pill ${task.status}">${statusNames[task.status] || task.status}</span></td><td>${esc(task.blocker || '—')}</td><td>${esc(task.handoff || '—')}</td></tr>`)).join('')}</tbody></table>`;
  $$('.list-task-row', $('#list-wrap')).forEach((row) => row.addEventListener('click', () => selectItem('task', row.dataset.task)));
}

function renderInspector() {
  const project = state.data.projects.find((item) => item.id === (state.selection?.type === 'project' ? state.selection.id : state.data.projects.find((p) => p.tasks.some((task) => task.id === state.selection?.id))?.id));
  const task = project?.tasks.find((item) => item.id === state.selection?.id && state.selection?.type === 'task');
  $('#project-context-label').textContent = project ? project.name : '선택 필요';
  $('#task-context-label').textContent = task ? task.name : project ? project.name : '선택 필요';
  $('#inspector-save-state').textContent = state.selection ? '편집 후 저장' : '선택 항목 없음';
  if (project) {
    $('#project-inspector').innerHTML = `<form id="project-inspector-form" class="inspector-form">
      <div class="selection-context"><i style="background:${esc(project.color)}"></i><span>${esc(project.template_name || '직접 프로젝트')}</span></div>
      <label class="inspector-field"><span>프로젝트 이름</span><input id="ins-project-name" class="text-input" value="${esc(project.name)}" required></label>
      <div class="inspector-field"><span>프로젝트 색상</span><div class="color-field"><input id="ins-project-color" type="color" value="${esc(project.color || '#5872d9')}"><code>${esc(project.color || '#5872d9')}</code></div></div>
      <label class="inspector-field"><span>시작일</span><input id="ins-project-start" type="date" class="text-input" value="${esc(project.start_date)}"></label>
      <label class="inspector-field"><span>일정 기준</span><select id="ins-project-calendar" class="select-input"><option value="working" ${project.calendar_type === 'working' ? 'selected' : ''}>주 5일 (월–금)</option><option value="calendar" ${project.calendar_type === 'calendar' ? 'selected' : ''}>달력일 (주 7일)</option></select></label>
      <div class="derived-date"><small>예정 범위 · ${project.calendar_type === 'working' ? '주 5일, 공휴일 미반영' : '달력일'}</small><b>${fmtDate(project.tasks.map((item) => item.planned_start).filter(Boolean).sort()[0], true)} — ${fmtDate(project.tasks.map((item) => item.planned_finish).filter(Boolean).sort().at(-1), true)}</b><span>시작일, 기간, 선행 관계를 바꾸면 계산됩니다.</span></div>
      <label class="inspector-field"><span>그룹</span><input id="ins-project-group" class="text-input" value="${esc(project.group_name || '')}" placeholder="예: MARKOS · 2026 4분기"></label>
      <label class="inspector-field"><span>태그 <small>쉼표로 구분</small></span><input id="ins-project-tags" class="text-input" value="${esc((project.tags || []).join(', '))}" placeholder="예: MAIN보드, 긴급"></label>
      <button class="button button-primary inspector-save" type="submit">프로젝트 속성 저장</button>
    </form>`;
  } else {
    $('#project-inspector').innerHTML = `<div class="inspector-empty"><span>▤</span><b>프로젝트를 선택하세요</b><small>간트의 프로젝트 행 또는 왼쪽 목록을 선택하면 속성을 편집할 수 있습니다.</small></div>`;
  }
  if (task && project) {
    const predecessors = project.tasks.filter((item) => item.id !== task.id);
    $('#task-inspector').innerHTML = `<div class="inspector-context"><b>${esc(project.name)}</b><span>상위 프로젝트 · ${esc(project.group_name || '그룹 미지정')}</span></div>
      <form id="task-inspector-form" class="inspector-form">
        <label class="inspector-field"><span>작업명</span><input id="ins-task-name" class="text-input" value="${esc(task.name)}" required></label>
        <div class="inspector-field"><span>작업 색상</span><div class="color-field"><input id="ins-task-color" type="color" value="${esc(task.color || project.color || '#5872d9')}"><code>${esc(task.color || project.color || '#5872d9')}</code></div></div>
        <div class="inspector-row"><label class="inspector-field"><span>기간</span><input id="ins-task-duration" class="text-input" type="number" min="1" max="520" value="${esc(task.duration_value)}"></label><label class="inspector-field"><span>단위</span><select id="ins-task-unit" class="select-input"><option value="days" ${task.duration_unit === 'days' ? 'selected' : ''}>일</option><option value="weeks" ${task.duration_unit === 'weeks' ? 'selected' : ''}>주</option></select></label></div>
        <div class="derived-date"><small>계산된 예정 범위</small><b>${fmtDate(task.planned_start, true)} — ${fmtDate(task.planned_finish, true)}</b><span>날짜는 기간, 프로젝트 시작일, 선행 작업에서 계산됩니다.</span></div>
        <label class="inspector-field"><span>그룹</span><input id="ins-task-group" class="text-input" value="${esc(task.group_name || '')}" placeholder="예: 외주 작업"></label>
        <label class="inspector-field"><span>태그 <small>쉼표로 구분</small></span><input id="ins-task-tags" class="text-input" value="${esc((task.tags || []).join(', '))}" placeholder="예: 검사, 대기"></label>
        <label class="inspector-field"><span>담당 / 협력사</span><input id="ins-task-owner" class="text-input" value="${esc(task.owner || '')}" placeholder="부서 또는 업체"></label>
        <label class="inspector-field"><span>상태</span><select id="ins-task-status" class="select-input">${Object.entries(statusNames).map(([key, name]) => `<option value="${key}" ${task.status === key ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
        <label class="inspector-field"><span>막힘 / 대기 사유</span><input id="ins-task-blocker" class="text-input" value="${esc(task.blocker || '')}" placeholder="예: 부품 납기 확인 중"></label>
        <label class="inspector-field"><span>다음 인계</span><input id="ins-task-handoff" class="text-input" value="${esc(task.handoff || '')}" placeholder="다음 담당자에게 전달할 결과"></label>
        <div class="inspector-field"><span>선행 작업 <small>모두 완료 후 시작</small></span><div class="inspector-dependencies">${predecessors.map((item) => `<label><input type="checkbox" class="ins-task-dependency" value="${esc(item.id)}" ${task.dependencies.includes(item.id) ? 'checked' : ''}><span>${esc(item.name)}</span></label>`).join('') || '<small>연결할 다른 작업이 없습니다.</small>'}</div></div>
        <div class="inspector-field"><span>실제 작업일</span><div class="inspector-row"><label><small>시작</small><input id="ins-task-actual-start" type="date" class="text-input" value="${esc(task.actual_start || '')}"></label><label><small>완료</small><input id="ins-task-actual-finish" type="date" class="text-input" value="${esc(task.actual_finish || '')}"></label></div></div>
        <label class="inspector-field"><span>메모</span><textarea id="ins-task-notes" class="text-area" rows="3" placeholder="검사 결과, 연락 사항 등">${esc(task.notes || '')}</textarea></label>
        <button class="button button-primary inspector-save" type="submit">작업 속성 저장</button>
        <button class="button complete-button inspector-complete" id="ins-task-complete" type="button">✓ 오늘 완료 처리</button>
      </form>`;
  } else {
    $('#task-inspector').innerHTML = `<div class="inspector-empty"><span>⌁</span><b>작업을 선택하세요</b><small>작업 이름이나 간트 막대를 누르면 담당, 상태, 기간, 선행 관계와 인계 내용을 편집할 수 있습니다.</small></div>`;
  }
  bindInspector(project, task);
  syncAccordionVisibility();
}

function syncAccordionVisibility() {
  for (const section of ['project', 'task']) {
    const open = state.inspectorOpen === section;
    $(`#${section}-accordion`).setAttribute('aria-expanded', String(open));
    $(`#${section}-accordion .accordion-chevron`).textContent = open ? '⌄' : '›';
    $(`#${section}-inspector`).classList.toggle('hidden', !open);
  }
}

function bindInspector(project, task) {
  const projectForm = $('#project-inspector-form');
  if (projectForm && project) projectForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = $('.inspector-save', projectForm);
    if (button.disabled) return;
    button.disabled = true;
    try {
      await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', body: JSON.stringify({ name: $('#ins-project-name').value.trim(), color: $('#ins-project-color').value, start_date: $('#ins-project-start').value, calendar_type: $('#ins-project-calendar').value, group_name: $('#ins-project-group').value, tags: $('#ins-project-tags').value }) });
      await loadState();
      toast('프로젝트 속성을 저장하고 예정 일정을 다시 계산했습니다.');
    } catch (error) { toast(error.message); button.disabled = false; }
  });
  const taskForm = $('#task-inspector-form');
  if (taskForm && project && task) {
    const payload = () => ({ name: $('#ins-task-name').value.trim(), color: $('#ins-task-color').value, duration_value: Number($('#ins-task-duration').value), duration_unit: $('#ins-task-unit').value, group_name: $('#ins-task-group').value, tags: $('#ins-task-tags').value, owner: $('#ins-task-owner').value, status: $('#ins-task-status').value, blocker: $('#ins-task-blocker').value, handoff: $('#ins-task-handoff').value, dependencies: $$('.ins-task-dependency:checked').map((input) => input.value), actual_start: $('#ins-task-actual-start').value, actual_finish: $('#ins-task-actual-finish').value, notes: $('#ins-task-notes').value });
    taskForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $('.inspector-save', taskForm);
      if (button.disabled) return;
      button.disabled = true;
      try { await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify(payload()) }); await loadState(); toast('작업 속성과 선행 일정이 저장되었습니다.'); }
      catch (error) { toast(error.message); button.disabled = false; }
    });
    $('#ins-task-complete').addEventListener('click', async () => {
      const fields = payload();
      fields.status = 'done';
      fields.actual_start ||= todayInput();
      fields.actual_finish ||= todayInput();
      try { await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify(fields) }); await loadState(); toast('실제 완료일을 기록했습니다.'); }
      catch (error) { toast(error.message); }
    });
  }
}

function normalizedTemplate(template) {
  const idToKey = Object.fromEntries(template.tasks.map((task) => [task.id, task.key]));
  return { ...template, tasks: template.tasks.map((task) => ({ ...task, dependencies: task.dependencies.map((id) => idToKey[id] || id) })) };
}
function renderTemplates() {
  const templates = state.data.templates;
  $('#template-count').textContent = templates.length;
  $('#template-list').innerHTML = templates.map((template) => `<div class="template-card ${template.id === state.selectedTemplateId ? 'selected' : ''}" data-template="${esc(template.id)}"><b>${esc(template.name)}</b><span>${template.tasks.length}개 작업 · ${(template.description || '설명 없음').slice(0, 36)}</span></div>`).join('');
  $$('.template-card').forEach((card) => card.addEventListener('click', () => {
    state.selectedTemplateId = card.dataset.template;
    state.draft = normalizedTemplate(templates.find((item) => item.id === state.selectedTemplateId));
    state.preview = null;
    renderTemplates();
  }));
  const selected = templates.find((template) => template.id === state.selectedTemplateId);
  if (!state.draft && selected) state.draft = normalizedTemplate(selected);
  renderTemplateEditor();
}
function renderTemplateEditor() {
  const draft = state.draft;
  if (!draft) {
    $('#template-editor').innerHTML = `<div class="no-template"><div><div style="font-size:28px;color:#aab4ee;margin-bottom:10px">▦</div>템플릿을 만들거나 왼쪽 목록에서 선택하세요.</div></div>`;
    return;
  }
  $('#template-editor').innerHTML = `
    <div class="editor-top"><div><h2 class="editor-title">${draft.id ? '템플릿 편집' : '새 템플릿'}</h2><p class="editor-subtitle">작업을 추가하고 선행 관계를 지정해 나만의 공정 흐름을 구성하세요.</p></div><div class="editor-actions"><button id="preview-template" class="button">일정 미리보기</button><button id="save-template" class="button button-primary">저장</button></div></div>
    <div class="editor-fields"><label><span class="field-label">템플릿 이름</span><input id="template-name" class="text-input" value="${esc(draft.name)}" placeholder="예: 보드 제작 기본 공정"></label><label><span class="field-label">설명</span><input id="template-description" class="text-input" value="${esc(draft.description || '')}" placeholder="이 템플릿이 적용되는 업무를 간단히 설명하세요."></label><label><span class="field-label">기본 프로젝트 색상</span><div class="color-field template-project-color-field"><input id="template-project-color" type="color" value="${esc(draft.project_color || projectColors[0])}" aria-label="템플릿 기본 프로젝트 색상"><code>${esc(draft.project_color || projectColors[0])}</code></div></label></div>
    <div class="task-editor-heading"><span>#</span><span>작업명</span><span>기간</span><span>색상</span><span>담당</span><span>선행 작업 · 체크하면 여러 작업 연결</span><span></span></div>
    <div id="template-tasks">${draft.tasks.map((task, index) => templateTaskRow(task, index, draft.tasks)).join('')}</div>
    <button id="add-template-task" class="add-task-button">＋ 작업 추가</button>
    <div class="preview-section"><div class="preview-heading"><div><b>일정 미리보기</b><span style="margin-left:8px">의존 관계 순환 여부와 예상 날짜를 확인합니다.</span></div><div style="display:flex;gap:6px;align-items:center"><input id="preview-start" type="date" class="text-input" style="width:130px;height:27px;padding:4px 6px" value="${esc(state.preview?.start_date || todayInput())}"><select id="preview-calendar" class="select-input" style="width:104px;height:27px;padding:4px 6px"><option value="working">주 5일</option><option value="calendar">달력일</option></select></div></div><div id="preview-result">${state.preview?.html || '<div class="form-help" style="margin-top:8px">미리보기 버튼을 눌러 예상 일정을 계산하세요. 기본 주 5일이며 공휴일은 제외하지 않습니다.</div>'}</div></div>`;
  $('#preview-calendar').value = state.preview?.calendar_type || 'working';
  $('#template-name').addEventListener('input', (event) => { draft.name = event.target.value; });
  $('#template-description').addEventListener('input', (event) => { draft.description = event.target.value; });
  $('#template-project-color').addEventListener('input', (event) => { draft.project_color = event.target.value; event.target.nextElementSibling.textContent = event.target.value; });
  $$('.template-task-name').forEach((input) => input.addEventListener('input', () => updateTemplateField(input)));
  $$('.template-task-duration').forEach((input) => input.addEventListener('input', () => updateTemplateField(input)));
  $$('.template-task-unit').forEach((input) => input.addEventListener('change', () => updateTemplateField(input)));
  $$('.template-task-color').forEach((input) => input.addEventListener('input', () => updateTemplateField(input)));
  $$('.template-task-owner').forEach((input) => input.addEventListener('input', () => updateTemplateField(input)));
  $$('.template-task-handoff').forEach((input) => input.addEventListener('input', () => updateTemplateField(input)));
  $$('.dep-summary').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); button.closest('.dep-picker').classList.toggle('open'); }));
  $$('.template-dependency').forEach((input) => input.addEventListener('change', () => {
    const task = draft.tasks.find((item) => item.key === input.dataset.task);
    const dependency = input.dataset.dependency;
    task.dependencies = input.checked ? [...new Set([...task.dependencies, dependency])] : task.dependencies.filter((key) => key !== dependency);
    const summary = input.closest('.dep-picker').querySelector('.dep-summary');
    summary.textContent = task.dependencies.length ? `${task.dependencies.length}개 선행 작업` : '선행 작업 없음';
  }));
  $$('.remove-task').forEach((button) => button.addEventListener('click', () => {
    const removed = draft.tasks[Number(button.dataset.index)];
    draft.tasks.splice(Number(button.dataset.index), 1);
    draft.tasks.forEach((task) => { task.dependencies = task.dependencies.filter((key) => key !== removed.key); });
    state.preview = null; renderTemplateEditor();
  }));
  $('#add-template-task').addEventListener('click', () => {
    const ordinal = draft.tasks.length + 1;
    draft.tasks.push({ key: `task_${crypto.randomUUID().slice(0, 8)}`, name: `새 작업 ${ordinal}`, duration_value: 1, duration_unit: 'days', dependencies: [], owner: '', handoff: '', color: taskColors[draft.tasks.length % taskColors.length], sort_order: draft.tasks.length });
    state.preview = null; renderTemplateEditor();
  });
  $('#preview-template').addEventListener('click', previewDraft);
  $('#save-template').addEventListener('click', saveTemplate);
}
function templateTaskRow(task, index, tasks) {
  const dependencySummary = task.dependencies.length ? `${task.dependencies.length}개 선행 작업` : '선행 작업 없음';
  return `<div class="task-editor-row"><span class="task-order">${String(index + 1).padStart(2, '0')}</span><input class="text-input template-task-name" data-key="${esc(task.key)}" value="${esc(task.name)}" aria-label="작업명"><div class="duration-field"><input class="text-input template-task-duration" data-key="${esc(task.key)}" type="number" min="1" max="520" value="${esc(task.duration_value)}" aria-label="기간"><select class="select-input template-task-unit" data-key="${esc(task.key)}" aria-label="기간 단위"><option value="days" ${task.duration_unit === 'days' ? 'selected' : ''}>일</option><option value="weeks" ${task.duration_unit === 'weeks' ? 'selected' : ''}>주</option></select></div><input class="template-task-color" data-key="${esc(task.key)}" type="color" value="${esc(task.color || taskColors[index % taskColors.length])}" aria-label="${esc(task.name)} 색상"><input class="text-input template-task-owner" data-key="${esc(task.key)}" value="${esc(task.owner || '')}" placeholder="담당 / 업체" aria-label="담당"><div class="dep-picker"><button class="dep-summary" type="button">${dependencySummary}</button><div class="dep-options">${tasks.filter((other) => other.key !== task.key).map((other) => `<label class="dep-option"><input type="checkbox" class="template-dependency" data-task="${esc(task.key)}" data-dependency="${esc(other.key)}" ${task.dependencies.includes(other.key) ? 'checked' : ''}><span>${esc(other.name)}</span></label>`).join('') || '<div class="form-help">다른 작업을 추가하면 선행 관계를 지정할 수 있습니다.</div>'}</div></div><button class="remove-task" data-index="${index}" title="작업 삭제">×</button></div><label class="handoff-editor"><span>다음 인계</span><input class="text-input template-task-handoff" data-key="${esc(task.key)}" value="${esc(task.handoff || '')}" placeholder="다음 담당자에게 전달할 결과"></label>`;
}
function syncDraftFromEditor() {
  if (!state.draft || !$('#template-name')) return;
  state.draft.name = $('#template-name').value;
  state.draft.description = $('#template-description').value;
  state.draft.project_color = $('#template-project-color')?.value || state.draft.project_color || projectColors[0];
  for (const task of state.draft.tasks) {
    const byKey = (selector) => $(`${selector}[data-key="${CSS.escape(task.key)}"]`);
    task.name = byKey('.template-task-name')?.value ?? task.name;
    task.duration_value = Math.max(1, Number(byKey('.template-task-duration')?.value) || task.duration_value || 1);
    task.duration_unit = byKey('.template-task-unit')?.value ?? task.duration_unit;
    task.color = byKey('.template-task-color')?.value ?? task.color ?? taskColors[state.draft.tasks.indexOf(task) % taskColors.length];
    task.owner = byKey('.template-task-owner')?.value ?? task.owner;
    task.handoff = byKey('.template-task-handoff')?.value ?? task.handoff;
    task.dependencies = $$('.template-dependency:checked').filter((input) => input.dataset.task === task.key).map((input) => input.dataset.dependency);
  }
}
function updateTemplateField(input) {
  const task = state.draft.tasks.find((item) => item.key === input.dataset.key);
  if (!task) return;
  if (input.classList.contains('template-task-name')) {
    task.name = input.value;
    $$(`.template-dependency[data-dependency="${CSS.escape(task.key)}"] + span`).forEach((label) => { label.textContent = task.name; });
  }
  if (input.classList.contains('template-task-duration')) task.duration_value = Math.max(1, Number(input.value) || 1);
  if (input.classList.contains('template-task-unit')) task.duration_unit = input.value;
  if (input.classList.contains('template-task-color')) task.color = input.value;
  if (input.classList.contains('template-task-owner')) task.owner = input.value;
  if (input.classList.contains('template-task-handoff')) task.handoff = input.value;
}
async function previewDraft() {
  if (!state.draft) return;
  try {
    syncDraftFromEditor();
    const previewStart = $('#preview-start').value || todayInput();
    const calendarType = $('#preview-calendar').value;
    const tasks = state.draft.tasks.map((task) => ({ key: task.key, name: task.name, duration_value: task.duration_value, duration_unit: task.duration_unit, dependencies: [...task.dependencies], owner: task.owner || '' }));
    const result = await api('/api/preview', { method: 'POST', body: JSON.stringify({ tasks, start_date: previewStart, calendar_type: calendarType }) });
    const html = `<table class="preview-table"><thead><tr><th>작업 / branch</th><th>예상 시작</th><th>예상 완료</th><th>기간</th><th>선행</th></tr></thead><tbody>${result.tasks.map((task) => `<tr><td>${esc(task.name)}</td><td>${fmtDate(task.planned_start, true)}</td><td>${fmtDate(task.planned_finish, true)}</td><td>${task.duration_value}${durationNames[task.duration_unit]}</td><td>${task.dependencies.length ? task.dependencies.map((key) => state.draft.tasks.find((item) => item.key === key)?.name || key).map(esc).join(', ') : '—'}</td></tr>`).join('')}</tbody></table>`;
    state.preview = { html, start_date: previewStart, calendar_type: calendarType };
    $('#preview-result').innerHTML = html;
  } catch (error) {
    $('#preview-result').innerHTML = `<div class="preview-error">일정 미리보기 실패: ${esc(error.message)} · 선행 관계를 확인하세요.</div>`;
    state.preview = null;
  }
}
async function saveTemplate() {
  const button = $('#save-template');
  if (button.disabled) return;
  button.disabled = true;
  try {
    syncDraftFromEditor();
    if (!state.draft.name.trim()) throw new Error('템플릿 이름을 입력하세요.');
    if (!state.draft.tasks.length) throw new Error('작업을 한 개 이상 추가하세요.');
    if (state.draft.tasks.some((task) => !String(task.name).trim())) throw new Error('작업명을 입력하세요.');
    const payload = { name: state.draft.name.trim(), description: state.draft.description || '', project_color: state.draft.project_color || projectColors[0], tasks: state.draft.tasks.map((task, index) => ({ key: task.key, name: task.name.trim(), duration_value: Number(task.duration_value), duration_unit: task.duration_unit, dependencies: task.dependencies, owner: task.owner || '', handoff: task.handoff || '', color: task.color || taskColors[index % taskColors.length], sort_order: index })) };
    const saved = state.draft.id ? await api(`/api/templates/${encodeURIComponent(state.draft.id)}`, { method: 'PUT', body: JSON.stringify(payload) }) : await api('/api/templates', { method: 'POST', body: JSON.stringify(payload) });
    state.selectedTemplateId = saved.id;
    state.draft = null; state.preview = null;
    await loadState();
    toast('템플릿을 저장했습니다. 기존 프로젝트 일정은 유지됩니다.');
  } catch (error) { toast(error.message); }
  finally { button.disabled = false; }
}
function createTemplate() {
  const key = `task_${crypto.randomUUID().slice(0, 8)}`;
  state.selectedTemplateId = null;
  state.draft = { name: '새 공정 템플릿', description: '', project_color: projectColors[state.data.templates.length % projectColors.length], tasks: [{ key, name: '작업 1', duration_value: 1, duration_unit: 'days', dependencies: [], owner: '', handoff: '', color: taskColors[0] }] };
  state.preview = null;
  switchView('templates');
}

function openModal(title, subtitle, body, footer, onOpen = null) {
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><header class="modal-head"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="icon-button modal-close" aria-label="닫기">×</button></header><div class="inline-error" id="modal-error"></div><div class="modal-body">${body}</div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}</section></div>`;
  $('.modal-close').addEventListener('click', closeModal);
  $('.modal-backdrop').addEventListener('click', (event) => { if (event.target.classList.contains('modal-backdrop')) closeModal(); });
  if (onOpen) onOpen();
}
function closeModal() { $('#modal-root').innerHTML = ''; }
function setModalError(message) { $('#modal-error').textContent = message; }
function openInstantiate() {
  if (!state.data.templates.length) { toast('먼저 공정 템플릿을 만들어주세요.'); switchView('templates'); return; }
  const options = state.data.templates.map((template) => `<option value="${esc(template.id)}">${esc(template.name)} · ${template.tasks.length}개 작업</option>`).join('');
  const requestId = crypto.randomUUID();
  const firstTemplate = state.data.templates[0];
  const body = `<div class="form-grid"><label class="form-field full"><span class="field-label">프로젝트 / 생산 배치 이름</span><input id="project-name" class="text-input" placeholder="예: MARKOS MAIN보드 50EA" autofocus></label><label class="form-field"><span class="field-label">적용할 템플릿</span><select id="project-template" class="select-input">${options}</select></label><label class="form-field"><span class="field-label">프로젝트 시작일</span><input id="project-start" type="date" class="text-input" value="${todayInput()}"></label><label class="form-field"><span class="field-label">일정 계산 기준</span><select id="project-calendar" class="select-input"><option value="working">주 5일 (월–금)</option><option value="calendar">달력일 (주 7일)</option></select><div class="form-help">작업 완료일 다음 작업일에 후속 공정을 시작합니다. 공휴일은 일정 계산에서 제외됩니다.</div></label><label class="form-field"><span class="field-label">프로젝트 색상</span><div class="color-field modal-project-color"><input id="project-color" type="color" value="${esc(firstTemplate.project_color || projectColors[0])}" aria-label="새 프로젝트 색상"><code>${esc(firstTemplate.project_color || projectColors[0])}</code></div><div class="form-help">템플릿 기본색으로 시작하며 여기서 변경할 수 있습니다.</div></label><div class="form-field full"><div id="project-template-summary" class="project-template-summary"></div></div></div>`;
  const footer = `<button class="button" id="cancel-project">취소</button><div class="modal-footer-right"><button class="button button-primary" id="confirm-project">모든 작업으로 프로젝트 생성</button></div>`;
  openModal('템플릿으로 프로젝트 만들기', '선택한 템플릿의 작업과 의존 관계를 한 번에 복사합니다.', body, footer, () => {
    const summary = () => { const template = state.data.templates.find((item) => item.id === $('#project-template').value); $('#project-template-summary').textContent = `${template.name}: ${template.tasks.length}개 작업 · 작업 색상과 의존 관계를 복사하고 일정은 시작일로부터 자동 계산합니다.`; $('#project-color').value = template.project_color || projectColors[0]; $('#project-color').nextElementSibling.textContent = $('#project-color').value; };
    $('#project-template').addEventListener('change', summary); summary();
    $('#project-color').addEventListener('input', (event) => { event.target.nextElementSibling.textContent = event.target.value; });
    $('#cancel-project').addEventListener('click', closeModal);
    $('#confirm-project').addEventListener('click', async () => {
      const button = $('#confirm-project'); if (button.disabled) return;
      button.disabled = true;
      try {
      const project = await api('/api/instantiate', { method: 'POST', body: JSON.stringify({ request_id: requestId, name: $('#project-name').value.trim(), template_id: $('#project-template').value, start_date: $('#project-start').value, calendar_type: $('#project-calendar').value, color: $('#project-color').value }) });
        closeModal(); state.filterProject = project.id; state.selection = { type: 'project', id: project.id }; state.inspectorOpen = 'project'; persistUi(); switchView('timeline'); await loadState(); toast(`${project.name} · ${project.tasks.length}개 작업을 생성했습니다.`);
      } catch (error) { setModalError(error.message); button.disabled = false; }
    });
    $('#project-name').focus();
  });
}
function openTaskEditor(projectId, taskId) {
  const project = state.data.projects.find((item) => item.id === projectId);
  const task = project?.tasks.find((item) => item.id === taskId);
  if (!task || !project) return;
  const dependencies = project.tasks.filter((item) => item.id !== task.id);
  const depMarkup = dependencies.length ? dependencies.map((item) => `<label><input type="checkbox" class="task-dep-checkbox" value="${esc(item.id)}" ${task.dependencies.includes(item.id) ? 'checked' : ''}><span>${esc(item.name)}</span></label>`).join('') : '<span class="form-help">다른 작업을 추가하면 연결할 수 있습니다.</span>';
  const body = `<div class="task-details"><div class="form-grid"><label class="form-field full"><span class="field-label">작업명</span><input id="edit-task-name" class="text-input" value="${esc(task.name)}"></label><label class="form-field"><span class="field-label">기간</span><div class="duration-field"><input id="edit-task-duration" class="text-input" type="number" min="1" max="520" value="${esc(task.duration_value)}"><select id="edit-task-unit" class="select-input"><option value="days" ${task.duration_unit === 'days' ? 'selected' : ''}>일</option><option value="weeks" ${task.duration_unit === 'weeks' ? 'selected' : ''}>주</option></select></div></label><label class="form-field"><span class="field-label">담당 / 협력사</span><input id="edit-task-owner" class="text-input" value="${esc(task.owner)}" placeholder="담당 부서 또는 업체"></label><label class="form-field"><span class="field-label">상태</span><select id="edit-task-status" class="select-input">${Object.entries(statusNames).map(([key, name]) => `<option value="${key}" ${task.status === key ? 'selected' : ''}>${name}</option>`).join('')}</select></label><label class="form-field"><span class="field-label">예정 시작 — 완료</span><div class="form-help" style="padding:8px 1px">${fmtDate(task.planned_start, true)} — ${fmtDate(task.planned_finish, true)} · ${project.calendar_type === 'working' ? '주 5일' : '달력일'}</div></label><label class="form-field full"><span class="field-label">선행 작업 <span style="font-weight:400;color:#a2aab5"> · 복수 선택 시 모든 선행 작업이 끝나야 시작</span></span><div class="dependency-box">${depMarkup}</div></label><label class="form-field full"><span class="field-label">막힘 / 대기 사유</span><input id="edit-task-blocker" class="text-input" value="${esc(task.blocker)}" placeholder="예: 부품 납기 확인 중"></label><label class="form-field full"><span class="field-label">다음 인계</span><input id="edit-task-handoff" class="text-input" value="${esc(task.handoff)}" placeholder="예: 다음 공정 담당자에게 합격품 전달"></label><div class="form-field full"><span class="field-label">실제 작업일</span><div class="actual-grid"><label><input id="edit-task-actual-start" type="date" class="text-input" value="${esc(task.actual_start)}"><div class="form-help">실제 시작일</div></label><label><input id="edit-task-actual-finish" type="date" class="text-input" value="${esc(task.actual_finish)}"><div class="form-help">실제 완료일</div></label></div></div><label class="form-field full"><span class="field-label">메모</span><textarea id="edit-task-notes" class="text-area" rows="2" placeholder="검사 결과, 연락 사항 등">${esc(task.notes)}</textarea></label></div></div>`;
  const footer = `<button id="mark-complete" class="button complete-button">✓ 오늘 완료 처리</button><div class="modal-footer-right"><button id="cancel-task" class="button">취소</button><button id="save-task" class="button button-primary">변경 저장</button></div>`;
  openModal(task.name, `${project.name} · 예정 ${fmtDate(task.planned_start, true)} – ${fmtDate(task.planned_finish, true)}`, body, footer, () => {
    $('#cancel-task').addEventListener('click', closeModal);
    const formPayload = () => ({ name: $('#edit-task-name').value.trim(), duration_value: Number($('#edit-task-duration').value), duration_unit: $('#edit-task-unit').value, owner: $('#edit-task-owner').value, status: $('#edit-task-status').value, dependencies: $$('.task-dep-checkbox:checked').map((input) => input.value), blocker: $('#edit-task-blocker').value, handoff: $('#edit-task-handoff').value, actual_start: $('#edit-task-actual-start').value, actual_finish: $('#edit-task-actual-finish').value, notes: $('#edit-task-notes').value });
    const save = async (complete = false) => {
      const payload = formPayload();
      if (!payload.name) { setModalError('작업명을 입력하세요.'); return; }
      if (complete) { payload.status = 'done'; payload.actual_start ||= todayInput(); payload.actual_finish ||= todayInput(); }
      try { await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify(payload) }); closeModal(); await loadState(); toast(complete ? '실제 완료일을 기록했습니다.' : '작업 정보를 저장했습니다.'); }
      catch (error) { setModalError(error.message); }
    };
    $('#save-task').addEventListener('click', () => save(false));
    $('#mark-complete').addEventListener('click', () => save(true));
  });
}
function openProjectEditor(projectId) {
  const project = state.data.projects.find((item) => item.id === projectId);
  if (!project) return;
  const body = `<div class="form-grid"><label class="form-field full"><span class="field-label">프로젝트 이름</span><input id="edit-project-name" class="text-input" value="${esc(project.name)}"></label><label class="form-field"><span class="field-label">시작일</span><input id="edit-project-start" type="date" class="text-input" value="${esc(project.start_date)}"></label><label class="form-field"><span class="field-label">일정 계산 기준</span><select id="edit-project-calendar" class="select-input"><option value="working" ${project.calendar_type === 'working' ? 'selected' : ''}>주 5일 (월–금)</option><option value="calendar" ${project.calendar_type === 'calendar' ? 'selected' : ''}>달력일 (주 7일)</option></select></label><div class="form-field full"><div class="form-help">기준을 바꾸면 예정 일정이 다시 계산됩니다. 완료된 작업의 저장된 예정일과 실제 작업일은 유지합니다.</div></div></div>`;
  const footer = `<button id="cancel-project-edit" class="button">취소</button><div class="modal-footer-right"><button id="save-project-edit" class="button button-primary">일정 기준 저장</button></div>`;
  openModal('프로젝트 설정', `${project.tasks.length}개 작업 · ${project.template_name}`, body, footer, () => {
    $('#cancel-project-edit').addEventListener('click', closeModal);
    $('#save-project-edit').addEventListener('click', async () => {
      try { await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', body: JSON.stringify({ name: $('#edit-project-name').value.trim(), start_date: $('#edit-project-start').value, calendar_type: $('#edit-project-calendar').value }) }); closeModal(); await loadState(); toast('프로젝트 일정을 다시 계산했습니다.'); }
      catch (error) { setModalError(error.message); }
    });
  });
}
function attachEvents() {
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('#new-project').addEventListener('click', openInstantiate);
  $('#new-project-side').addEventListener('click', openInstantiate);
  $('#create-template').addEventListener('click', createTemplate);
  $('#export-calendar').addEventListener('click', () => { window.location.href = '/api/export/calendar.ics'; });
  $('#search-filter').addEventListener('input', renderTimeline);
  $('#status-filter').addEventListener('change', renderTimeline);
  $('#sort-select').addEventListener('change', renderTimeline);
  $('#group-select').addEventListener('change', renderTimeline);
  $$('[data-layout]').forEach((button) => button.addEventListener('click', () => {
    state.layout = button.dataset.layout;
    $$('[data-layout]').forEach((item) => item.classList.toggle('selected', item === button));
    renderTimeline();
  }));
  $$('[data-zoom]').forEach((button) => button.addEventListener('click', () => {
    state.zoom = button.dataset.zoom;
    $$('[data-zoom]').forEach((item) => item.classList.toggle('selected', item === button));
    renderTimeline();
  }));
  $('#today-button').addEventListener('click', () => {
    const wrap = $('#gantt-wrap');
    if (state.layout === 'gantt' && !wrap.classList.contains('hidden')) {
      const line = $('.today-line', $('#gantt'));
      if (line) wrap.scrollLeft = Math.max(0, 254 + Number(line.style.left.replace('px', '')) - wrap.clientWidth / 2);
    }
  });
  $('#refresh-button').addEventListener('click', async () => { try { await loadState(); toast('일정을 새로 불러왔습니다.'); } catch (error) { toast(error.message); } });
  $('#gantt').addEventListener('click', (event) => {
    const collapse = event.target.closest('[data-collapse]');
    if (collapse) {
      const projectId = collapse.dataset.collapse;
      state.collapsedProjects.has(projectId) ? state.collapsedProjects.delete(projectId) : state.collapsedProjects.add(projectId);
      persistUi();
      renderTimeline();
      return;
    }
    const selectedProject = event.target.closest('[data-project-select]');
    if (selectedProject) { selectItem('project', selectedProject.dataset.projectSelect); return; }
    const selectedTask = event.target.closest('[data-task-select]');
    if (selectedTask) selectItem('task', selectedTask.dataset.taskSelect);
  });
  $('#project-accordion').addEventListener('click', () => {
    state.inspectorOpen = state.inspectorOpen === 'project' ? '' : 'project';
    persistUi();
    syncAccordionVisibility();
  });
  $('#task-accordion').addEventListener('click', () => {
    state.inspectorOpen = state.inspectorOpen === 'task' ? '' : 'task';
    persistUi();
    syncAccordionVisibility();
  });
}

attachEvents();
loadState().catch((error) => { toast(`로컬 백엔드에 연결할 수 없습니다: ${error.message}`); $('#gantt').innerHTML = `<div class="empty-state"><strong>서버가 실행 중인지 확인하세요</strong><span>python3 -m mygantt.server --port 8765</span></div>`; });
