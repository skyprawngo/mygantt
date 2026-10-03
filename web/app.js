const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let savedUi = {};
try { savedUi = JSON.parse(localStorage.getItem('mygantt-ui') || '{}'); } catch { savedUi = {}; }
const state = { data: { templates: [], projects: [] }, view: 'timeline', layout: 'gantt', zoom: 46, filterProject: null, selectedTemplateId: null, draft: null, preview: null, selection: savedUi.selection || null, inspectorOpen: savedUi.inspectorOpen || 'project', collapsedProjects: new Set(savedUi.collapsedProjects || []), cascadeDependents: savedUi.cascadeDependents ?? false, drag: null, holidays: {} };
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
  if (path === '/api/state') state.appVersion = response.headers.get('server')?.match(/MyGantt\/([^\s]+)/)?.[1] || null;
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
  localStorage.setItem('mygantt-ui', JSON.stringify({ selection: state.selection, inspectorOpen: state.inspectorOpen, collapsedProjects: [...state.collapsedProjects], cascadeDependents: state.cascadeDependents }));
}
function setCascadeSetting(value) {
  state.cascadeDependents = Boolean(value);
  persistUi();
  $$('[data-cascade-dependents]').forEach((input) => { input.checked = state.cascadeDependents; });
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
  $('#settings-view').classList.toggle('hidden', view !== 'settings');
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $('#breadcrumb-title').textContent = { timeline: '전체 일정', templates: '공정 템플릿', settings: '설정' }[view];
  $('#page-description').textContent = { timeline: '프로젝트별 공정을 날짜 단위로 보고, 오른쪽에서 선택한 항목을 편집합니다.', templates: '업무 흐름을 한 번 구성하고, 각 배치에 전체 작업과 일정을 함께 적용합니다.', settings: '앱 버전과 공휴일 자료 정보를 확인합니다.' }[view];
  renderAll();
}
function renderAll() {
  renderSidebar();
  if (state.view === 'timeline') renderTimeline();
  else if (state.view === 'templates') renderTemplates();
  else renderSettings();
}
function renderSidebar() {
  $('#sidebar-project-section').classList.toggle('hidden', state.view !== 'timeline');
  $('#sidebar-template-section').classList.toggle('hidden', state.view !== 'templates');
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
  const node = $('#holiday-settings');
  if (!node) return;
  const holidayData = state.holidayData || {};
  const source = holidayData.source_label || holidayData.source || 'Nager.Date Community API v4';
  const updated = holidayData.last_updated ? holidayData.last_updated.slice(0, 10) : '갱신일 기록 없음';
  const years = holidayData.coverage_years || [];
  const unverifiedSubstituteYears = (holidayData.requested_years || years).filter((year) => Number(year) !== 2026);
  const coverage = years.length ? years.join(', ') : `자료 없음 · 지원 ${holidayData.supported_years?.from || '현재'}–${holidayData.supported_years?.through || '현재+5년'}`;
  const freshness = holidayData.status === 'fresh' ? '최신' : holidayData.status === 'stale' ? (holidayData.last_error ? '갱신 실패 · 저장 자료 표시' : '저장 자료 표시') : '자료 없음';
  node.innerHTML = `<dl class="settings-details"><div><dt>출처</dt><dd>${esc(source)}</dd></div><div><dt>최근 갱신</dt><dd>${esc(updated)}</dd></div><div><dt>자료 범위</dt><dd>${esc(coverage)}</dd></div><div><dt>상태</dt><dd><span class="holiday-freshness">${esc(freshness)}</span></dd></div></dl>`;
  node.dataset.status = holidayData.status || 'unavailable';
  node.dataset.substituteWarning = String(unverifiedSubstituteYears.length > 0);
  const warnings = [];
  if (unverifiedSubstituteYears.length) warnings.push(`2026년 외 연도(${unverifiedSubstituteYears.join(', ')})는 Nager.Date 자료만 사용합니다. 대체공휴일이 누락될 수 있으니 공식 달력을 확인하세요.`);
  if (holidayData.last_error) warnings.push(holidayData.last_error);
  if (holidayData.unsupported_years?.length) warnings.push(`자동 제공 범위 밖: ${holidayData.unsupported_years.join(', ')}`);
  if (warnings.length) node.insertAdjacentHTML('beforeend', `<p class="settings-warning">${warnings.map(esc).join('<br>')}</p>`);
}
function renderSettings() {
  $('#app-version').textContent = state.appVersion || '버전 정보 없음';
  renderHolidayStatus();
}
function projectBounds(projects) {
  const tasks = flatten(projects);
  const starts = tasks.flatMap((task) => [task.planned_start, task.actual_start, task.actual_finish]).filter(Boolean).sort();
  const ends = tasks.flatMap((task) => [task.planned_finish, task.actual_start, task.actual_finish]).filter(Boolean).sort();
  if (!starts.length) return { start: todayInput(), end: todayInput() };
  return { start: starts[0], end: ends[ends.length - 1] };
}
// Partial actual records are date markers, never an inferred duration.
function actualTaskRange(task) {
  if (!task.actual_start && !task.actual_finish) return null;
  return {
    start: task.actual_start || task.actual_finish,
    finish: task.actual_finish || task.actual_start,
    partial: !task.actual_start || !task.actual_finish,
    label: task.actual_start && task.actual_finish ? '실제' : task.actual_start ? '실제 시작 · 종료 미입력' : '실제 종료 · 시작 미입력',
  };
}
function taskRowHeight(task) { return actualTaskRange(task) ? 54 : 36; }
// A filled neck grows from the predecessor's facing edge into the successor.
// End faces meet square edges; surface joins tuck under the bar's solid fill.
function dependencyRibbon(from, to, outline = {}) {
  const span = to.x - from.x;
  if (from.kind === 'gap') {
    // Across a date gap, join the full end faces of the bars. Each half
    // narrows toward a shared waist whose tangent follows the diagonal.
    // Using identical X controls on both contours prevents a swollen middle.
    const sx = from.x, tx = to.x, mx = (sx + tx) / 2;
    const sy = from.centerY, ty = to.centerY, my = (sy + ty) / 2;
    const sh = from.height / 2, th = to.height / 2;
    const neck = Math.min(2, sh * .25, th * .25);
    const bend = span * .2;
    const rise = (ty - sy) * .2;
    return `M ${sx} ${sy - sh}
      C ${sx + bend} ${sy - sh}, ${mx - bend} ${my - neck - rise}, ${mx} ${my - neck}
      C ${mx + bend} ${my - neck + rise}, ${tx - bend} ${ty - th}, ${tx} ${ty - th}
      ${outline.target || `L ${tx} ${ty + th}`}
      C ${tx - bend} ${ty + th}, ${mx + bend} ${my + neck + rise}, ${mx} ${my + neck}
      C ${mx - bend} ${my + neck - rise}, ${sx + bend} ${sy + sh}, ${sx} ${sy + sh} ${outline.source || ''} Z`;
  }
  {
    // Surface joins have their own attachment intervals. Flare horizontally
    // along each bar, then carry a slanted neck into the receiving surface.
    // Matching Y controls keep the two contours from crossing, even upward.
    const sx = from.surfaceX, tx = to.surfaceX;
    const sy = from.y, ty = to.y, mx = (sx + tx) / 2, my = (sy + ty) / 2;
    const sh = from.width / 2, th = to.width / 2;
    const neck = Math.min(4, sh * .2, th * .2);
    const bend = (ty - sy) * .18;
    // Even aligned attachment centers retain a diagonal through the waist.
    const drift = Math.sign(tx - sx || 1) * Math.max(3, Math.min(14, Math.abs(tx - sx) * .18));
    return `M ${sx - sh} ${sy}
      C ${sx - sh * .15} ${sy}, ${mx - neck - drift} ${my - bend}, ${mx - neck} ${my}
      C ${mx - neck + drift} ${my + bend}, ${tx - th * .15} ${ty}, ${tx - th} ${ty}
      ${outline.target || `L ${tx + th} ${ty}`}
      C ${tx + th * .15} ${ty}, ${mx + neck + drift} ${my + bend}, ${mx + neck} ${my}
      C ${mx + neck - drift} ${my - bend}, ${sx + sh * .15} ${sy}, ${sx + sh} ${sy} ${outline.source || ''} Z`;
  }

}
function dependencySourceKind(task, drag = state.drag, targetBelow = true) {
  const current = drag?.taskId === task.id && drag.valid ? { ...task, ...drag.previewFields } : task;
  if (!current.actual_finish) return 'planned';
  // Equal ends form one stacked edge. Leave from the outer tier facing the
  // successor so the ribbon is not hidden behind the other tier.
  if (current.actual_finish === current.planned_finish) return targetBelow ? 'actual' : 'planned';
  return current.actual_finish > current.planned_finish ? 'actual' : 'planned';
}
function draggedDateChange(drag, delta) {
  const field = `${drag.period}_${drag.edge === 'start' ? 'start' : 'finish'}`;
  const base = drag.edge === 'start' ? drag.originalStart || drag.originalFinish : drag.originalFinish || drag.originalStart;
  const value = shiftIsoDate(base, delta);
  const start = drag.edge === 'start' ? value : drag.originalStart;
  const finish = drag.edge === 'end' ? value : drag.originalFinish;
  return { fields: { [field]: value }, start: start || finish, finish: finish || start, valid: !start || !finish || start <= finish };
}
// Walk the three other faces and the unused parts of the attachment face.
// The shared attachment segment is NEVER drawn: it is interior to the union.
function dependencyBarOutline(rect, style, origin, side, start, end) {
  const x = rect.left - origin.left, y = rect.top - origin.top;
  const w = rect.width, h = rect.height;
  const radius = (value) => Math.min(parseFloat(value) || 0, w / 2, h / 2);
  const tl = radius(style.borderTopLeftRadius), tr = radius(style.borderTopRightRadius);
  const br = radius(style.borderBottomRightRadius), bl = radius(style.borderBottomLeftRadius);
  const faces = [
    { start: [x + tl, y], end: [x + w - tr, y], radius: tr },
    { start: [x + w, y + tr], end: [x + w, y + h - br], radius: br },
    { start: [x + w - br, y + h], end: [x + bl, y + h], radius: bl },
    { start: [x, y + h - bl], end: [x, y + tl], radius: tl },
  ];
  const face = faces[side];
  const forward = (end[0] - start[0]) * (face.end[0] - face.start[0])
    + (end[1] - start[1]) * (face.end[1] - face.start[1]);
  const direction = forward > 0 ? -1 : 1;
  const sweep = direction === 1 ? 1 : 0;
  let path = '';
  for (let step = 0; step < 4; step++) {
    const i = (side + direction * step + 4) % 4;
    const next = (i + direction + 4) % 4;
    const cornerStart = direction === 1 ? faces[i].end : faces[i].start;
    const cornerEnd = direction === 1 ? faces[next].start : faces[next].end;
    const r = direction === 1 ? faces[i].radius : faces[next].radius;
    path += ` L ${cornerStart.join(' ')} A ${r} ${r} 0 0 ${sweep} ${cornerEnd.join(' ')}`;
  }
  return `${path} L ${end.join(' ')}`;
}
function dependencyConnectedPath(from, to, source, target, origin) {
  const gap = from.kind === 'gap';
  const below = to.y > from.y;
  const sourceStart = gap ? [from.x, from.centerY + from.height / 2] : [from.surfaceX + from.width / 2, from.y];
  const sourceEnd = gap ? [from.x, from.centerY - from.height / 2] : [from.surfaceX - from.width / 2, from.y];
  const targetStart = gap ? [to.x, to.centerY - to.height / 2] : [to.surfaceX - to.width / 2, to.y];
  const targetEnd = gap ? [to.x, to.centerY + to.height / 2] : [to.surfaceX + to.width / 2, to.y];
  return dependencyRibbon(from, to, {
    source: dependencyBarOutline(source.rect, source.style, origin, gap ? 1 : below ? 2 : 0, sourceStart, sourceEnd),
    target: dependencyBarOutline(target.rect, target.style, origin, gap ? 3 : below ? 0 : 2, targetStart, targetEnd),
  });
}
function renderDependencyLinks() {
  const body = $('.gantt-body', $('#gantt'));
  if (!body) return;
  $('.dependency-layer', body)?.remove();
  $$('.has-dependency', body).forEach((bar) => bar.classList.remove('has-dependency', 'dependency-join-left', 'dependency-join-right', 'svg-backed'));
  if (state.layout !== 'gantt') return;
  const origin = body.getBoundingClientRect();
  const bars = new Map($$('.task-bar', body).map((bar) => [bar.dataset.taskSelect, bar]));
  const actualBars = new Map($$('.actual-task-bar', body).map((bar) => [bar.dataset.taskSelect, bar]));
  const edges = [];
  const gradients = [];
  const connectedBars = new Set();
  for (const project of filteredProjects()) {
    const visibleTasks = new Map(project.tasks.map((task) => [task.id, task]));
    for (const task of project.tasks) {
      const targetBar = bars.get(task.id);
      if (!targetBar) continue;
      const target = targetBar.getBoundingClientRect();
      for (const predecessorId of new Set(task.dependencies || [])) {
        const predecessor = visibleTasks.get(predecessorId);
        if (!predecessor || predecessorId === task.id) continue;
        const plannedBar = bars.get(predecessorId);
        if (!plannedBar) continue;
        const sourceKind = dependencySourceKind(predecessor, state.drag, target.top > plannedBar.getBoundingClientRect().top);
        const sourceBar = sourceKind === 'actual' ? actualBars.get(predecessorId) : bars.get(predecessorId);
        if (!sourceBar) continue;
        sourceBar.classList.add('has-dependency');
        targetBar.classList.add('has-dependency');
        const source = sourceBar.getBoundingClientRect();
        const below = target.top > source.top;
        // Only end-face joins square the attached side; surface joins keep their radii.
        const kind = target.left - source.right >= 12 ? 'gap' : 'surface';
        if (kind === 'gap') {
          sourceBar.classList.add('dependency-join-right');
          targetBar.classList.add('dependency-join-left');
        }
        const from = { kind, x: source.right - origin.left, y: (below ? source.bottom : source.top) - origin.top, centerY: source.top + source.height / 2 - origin.top, height: source.height };
        const to = { x: target.left - origin.left, y: (below ? target.top : target.bottom) - origin.top, centerY: target.top + target.height / 2 - origin.top, height: target.height };
        const sourceStyle = getComputedStyle(sourceBar);
        const targetStyle = getComputedStyle(targetBar);
        const sourceSurfaceY = from.y, targetSurfaceY = to.y;
        if (kind === 'surface') {
          // Keep the source finish and target start distinct instead of
          // collapsing both anchors onto the center of their shared dates.
          const overlap = Math.max(0, Math.min(source.right, target.right) - Math.max(source.left, target.left));
          const flare = Math.min(120, Math.max(48, overlap + 32));
          // Stay clear of rounded corners. The bar and ribbon share the
          // exact surface boundary in one SVG path, with no pixel overlap.
          const cornerInset = (style, width) => Math.min(width / 4, Math.max(...[
            style.borderTopLeftRadius, style.borderTopRightRadius,
            style.borderBottomLeftRadius, style.borderBottomRightRadius,
          ].map((radius) => parseFloat(radius) || 0)));
          const sourceInset = cornerInset(sourceStyle, source.width);
          const targetInset = cornerInset(targetStyle, target.width);
          from.x -= sourceInset;
          to.x += targetInset;
          from.width = Math.min(flare, source.width - sourceInset * 2);
          to.width = Math.min(flare, target.width - targetInset * 2);
          from.surfaceX = from.x - from.width / 2;
          to.surfaceX = to.x + to.width / 2;
        }
        const gradientId = `dependency-fill-${edges.length}`;
        // A constant color along each joining edge avoids a visible seam:
        // horizontal gradient for end faces, vertical gradient for top/bottom.
        const gradientAxis = kind === 'gap'
          ? `x1="${from.x}" y1="0" x2="${to.x}" y2="0"`
          : `x1="0" y1="${sourceSurfaceY}" x2="0" y2="${targetSurfaceY}"`;
        gradients.push(`<linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" ${gradientAxis}><stop offset="0" stop-color="${esc(sourceStyle.backgroundColor)}"/><stop offset="1" stop-color="${esc(targetStyle.backgroundColor)}"/></linearGradient>`);
        const related = state.selection?.type === 'task' && [task.id, predecessorId].includes(state.selection.id);
        const label = `${project.name} · ${predecessor.name} → ${task.name} (완료 후 시작)`;
        connectedBars.add(sourceBar);
        connectedBars.add(targetBar);
        edges.push({ from, to, sourceBar, targetBar, gradientId, related, kind, task, predecessorId, sourceKind, label });
      }
    }
  }
  if (!edges.length) return;
  // Resolve corners after every edge marks its square joining sides.
  // A single exterior contour has no internal edges to antialias separately.
  const geometry = new Map([...connectedBars].map((bar) => [bar,
    { rect: bar.getBoundingClientRect(), style: getComputedStyle(bar) }]));
  const markup = edges.map(({ from, to, sourceBar, targetBar, gradientId, related, kind, task, predecessorId, sourceKind, label }) => {
    const ribbon = dependencyRibbon(from, to);
    const paint = dependencyConnectedPath(from, to, geometry.get(sourceBar), geometry.get(targetBar), origin);
    return `<path class="dependency-paint" d="${paint}" fill="url(#${gradientId})" fill-rule="nonzero" aria-hidden="true"/>
      <path class="dependency-link${related ? ' is-related' : ''}" d="${ribbon}" fill="transparent" data-connection-kind="${kind}" data-task-select="${esc(task.id)}" data-predecessor="${esc(predecessorId)}" data-source-period="${sourceKind}" role="button" tabindex="0" aria-label="${esc(label)}"><title>${esc(label)}</title></path>`;
  }).join('');
  body.insertAdjacentHTML('beforeend', `<svg class="dependency-layer" width="${body.scrollWidth}" height="${body.offsetHeight}" aria-label="선행 작업과 후행 작업 연결"><defs>${gradients.join('')}</defs>${markup}</svg>`);
  connectedBars.forEach((bar) => bar.classList.add('svg-backed'));
}

function renderTimeline({ preserveInspector = false } = {}) {
  const projects = filteredProjects();
  const tasks = flatten(projects);
  const bounds = projectBounds(projects);
  let start = bounds.start; let end = bounds.end;
  const today = todayInput();
  if (today < start) start = today;
  if (today > end) end = today;
  const days = Math.max(1, dayDiff(start, end) + 1);
  $('#range-label').textContent = dateRangeLabel(bounds.start, bounds.end);
  const pxPerDay = state.zoom;
  const labelWidth = 254;
  const timelineWidth = Math.max(720, days * pxPerDay);
  const dates = dateColumns(start, days, pxPerDay);
  renderHolidayStatus();
  $('#gantt-wrap').classList.toggle('hidden', state.layout !== 'gantt' || !tasks.length);
  $('#list-wrap').classList.toggle('hidden', state.layout !== 'list' || !tasks.length);
  $('#empty-state').classList.toggle('hidden', tasks.length > 0);
  if (!tasks.length) { $('#gantt').innerHTML = ''; $('#list-wrap').innerHTML = ''; if (!preserveInspector) renderInspector(); return; }
  const todayOffset = dayDiff(start, today);
  let rows = '';
  let bodyHeight = 0;
  const projectBands = [];
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
    const projectTop = bodyHeight;
    const projectHeight = 38 + (collapsed ? 0 : project.tasks.reduce((height, task) => height + taskRowHeight(task), 0));
    if (!collapsed) projectBands.push({ project, top: projectTop, height: projectHeight, left: labelWidth + projectX, width: projectBarWidth });
    const summaryClass = collapsed ? '' : ' expanded-project-label';
      rows += `<div class="gantt-row project-row ${isProjectSelected ? 'selected-row' : ''}" style="--project-color:${esc(project.color)}">
      <div class="gantt-left project-left">
        <button class="project-select" type="button" data-collapse="${esc(project.id)}" aria-expanded="${!collapsed}" aria-label="${esc(project.name)} ${collapsed ? '펼치기' : '접기'}"><i class="group-dot" style="background:${esc(project.color)}"></i><span class="project-name" title="${esc(project.name)}">${esc(project.name)}</span><span class="project-meta">${project.progress}%</span></button>
      </div>
      <div class="gantt-right project-timeline" style="width:${timelineWidth}px;${timelineCellStyle}"><div class="row-date-shading">${rowShading}</div><div class="today-line" style="left:${todayOffset * pxPerDay}px"></div><button class="project-summary-bar${summaryClass}" type="button" data-project-select="${esc(project.id)}" style="left:${projectX}px;width:${projectBarWidth}px;--bar-color:${esc(project.color)}" title="프로젝트 기간 ${fmtDate(projectStart, true)} — ${fmtDate(projectFinish, true)}"><i style="width:${project.progress}%"></i><span>${esc(project.name)} · ${project.progress}%</span></button></div>
    </div>`;
    bodyHeight += 38;
    if (collapsed) continue;
    for (const task of project.tasks) {
      const startX = Math.max(0, dayDiff(start, task.planned_start)) * pxPerDay;
      const width = Math.max(pxPerDay, (dayDiff(task.planned_start, task.planned_finish) + 1) * pxPerDay);
      const actual = actualTaskRange(task);
      const actualX = actual ? dayDiff(start, actual.start) * pxPerDay : 0;
      const actualWidth = actual ? Math.max(pxPerDay, (dayDiff(actual.start, actual.finish) + 1) * pxPerDay) : 0;
      const actualTitle = actual ? `${task.name} · ${actual.label} · ${fmtDate(actual.start, true)}${actual.partial ? '' : `–${fmtDate(actual.finish, true)}`}` : '';
      const actualMarkup = actual ? `<button data-date-period="actual" class="actual-task-bar${actual.partial ? ' partial-actual' : ''}" type="button" data-task-select="${esc(task.id)}" data-project="${esc(project.id)}" style="left:${actualX}px;width:${actualWidth}px;--bar-color:${esc(task.color)}" title="${esc(actualTitle)}" aria-label="${esc(actualTitle)}"><span class="resize-handle resize-start" data-resize-edge="start" aria-label="${esc(task.name)} 실제 시작일 조정"></span><span class="bar-text">${esc(actual.label)} · ${esc(task.name)}</span><span class="resize-handle resize-end" data-resize-edge="end" aria-label="${esc(task.name)} 실제 종료일 조정"></span></button>` : '';
      const status = task.status;
      const isSelected = state.selection?.type === 'task' && state.selection.id === task.id;
      rows += `<div class="gantt-row task-row${actual ? ' has-actual' : ''} ${isSelected ? 'selected-row' : ''}" style="--project-color:${esc(project.color)}">
        <div class="gantt-left task-left"><button class="task-label" type="button" data-task-select="${esc(task.id)}" data-project="${esc(project.id)}"><i class="task-state ${status}" style="--task-color:${esc(task.color)}" title="${esc(statusNames[status] || status)}"></i><span class="task-name" title="${esc(task.name)}">${esc(task.name)}</span><span class="task-owner">${esc(task.owner || '담당 미지정')}</span></button></div>
        <div class="gantt-right project-timeline" style="width:${timelineWidth}px;${timelineCellStyle}"><div class="row-date-shading">${rowShading}</div><div class="today-line" style="left:${todayOffset * pxPerDay}px"></div><button class="task-bar ${status}" type="button" data-task-select="${esc(task.id)}" data-project="${esc(project.id)}" style="left:${startX}px;width:${width}px;--bar-color:${esc(task.color)}" title="${esc(task.name)} · 예정 ${fmtDate(task.planned_start, true)}–${fmtDate(task.planned_finish, true)}"><span class="resize-handle resize-start" data-resize-edge="start" aria-label="${esc(task.name)} 시작일 조정"></span><i class="bar-progress" style="width:${status === 'done' ? 100 : status === 'doing' ? 45 : 0}%"></i><span class="bar-text">${actual ? '예정 · ' : ''}${esc(task.name)}</span><span class="resize-handle resize-end" data-resize-edge="end" aria-label="${esc(task.name)} 종료일 조정"></span></button>${actualMarkup}</div>
      </div>`;
      bodyHeight += taskRowHeight(task);
    }
    }
  }
  const headerDates = dates.map((item) => `<div class="date-header ${item.saturday ? 'saturday' : ''} ${item.sunday ? 'sunday' : ''} ${item.holiday ? 'holiday' : ''} ${item.today ? 'today' : ''}" style="width:${pxPerDay}px" title="${item.key}${item.holiday ? ` · ${esc(item.holiday)}` : ''}"><b>${esc(item.dateText)}</b><small>${item.weekday}</small>${item.holiday ? `<i>${esc(item.holiday)}</i>` : ''}</div>`).join('');
  const projectBandMarkup = projectBands.map((band) => `<div class="project-duration-band" aria-hidden="true" style="left:${band.left}px;top:${band.top}px;width:${band.width}px;height:${band.height}px;--bar-color:${esc(band.project.color)};--progress:${band.project.progress}%"></div>`).join('');
  $('#gantt').innerHTML = `<div class="gantt-head"><div class="gantt-left gantt-head-left" style="width:${labelWidth}px"><span>프로젝트 / 작업</span></div><div class="gantt-right gantt-head-right" style="width:${timelineWidth}px"><div class="date-axis">${headerDates}</div></div></div><div class="gantt-body" style="width:${labelWidth + timelineWidth}px;min-height:${bodyHeight}px">${projectBandMarkup}${rows}</div>`;
  renderDependencyLinks();
  if (!preserveInspector) renderInspector();
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
      <div class="property-grid">
      <label class="inspector-field"><span>프로젝트 이름</span><input id="ins-project-name" class="text-input" value="${esc(project.name)}" required></label>
      <div class="inspector-field"><span><label for="ins-project-color">프로젝트 색상</label></span><div class="color-field"><input id="ins-project-color" type="color" value="${esc(project.color || '#5872d9')}"><code>${esc(project.color || '#5872d9')}</code></div></div>
      <label class="inspector-field"><span>시작일</span><input id="ins-project-start" type="date" class="text-input" value="${esc(project.start_date)}"></label>
      <label class="inspector-field"><span>일정 기준</span><select id="ins-project-calendar" class="select-input"><option value="working" ${project.calendar_type === 'working' ? 'selected' : ''}>주 5일 (월–금)</option><option value="calendar" ${project.calendar_type === 'calendar' ? 'selected' : ''}>달력일 (주 7일)</option></select></label>
      <div class="inspector-field property-readonly"><span>예정 범위 <span class="info-tip"><button type="button" class="info-tip-button" aria-label="예정 범위 도움말" aria-describedby="project-dates-tooltip">i</button><span id="project-dates-tooltip" class="info-tip-text" role="tooltip">배치 시작일과 달력을 수정해도 저장된 작업 날짜는 유지됩니다.</span></span></span><div class="derived-date"><small>${project.calendar_type === 'working' ? '주 5일, 공휴일 미반영' : '달력일'}</small><b>${fmtDate(project.tasks.map((item) => item.planned_start).filter(Boolean).sort()[0], true)} — ${fmtDate(project.tasks.map((item) => item.planned_finish).filter(Boolean).sort().at(-1), true)}</b></div></div>
      <label class="inspector-field"><span>그룹</span><input id="ins-project-group" class="text-input" value="${esc(project.group_name || '')}" placeholder="예: MARKOS · 2026 4분기"></label>
      <label class="inspector-field"><span>태그 <small>쉼표로 구분</small></span><input id="ins-project-tags" class="text-input" value="${esc((project.tags || []).join(', '))}" placeholder="예: MAIN보드, 긴급"></label>
      </div>
      <small class="project-autosave-state" role="status" aria-live="polite">포커스를 이동하면 자동 저장됩니다.</small>
    </form>`;
  } else {
    $('#project-inspector').innerHTML = `<div class="inspector-empty"><span>▤</span><b>프로젝트를 선택하세요</b><small>간트의 프로젝트 행 또는 왼쪽 목록을 선택하면 속성을 편집할 수 있습니다.</small></div>`;
  }
  if (task && project) {
    const relatedTasks = project.tasks.filter((item) => item.id !== task.id);
    $('#task-inspector').innerHTML = `
      <form id="task-inspector-form" class="inspector-form">
        <div class="property-grid">
        <label class="inspector-field"><span>작업명</span><input id="ins-task-name" class="text-input" value="${esc(task.name)}" required></label>
        <div class="inspector-field"><span><label for="ins-task-color">작업 색상</label></span><div class="color-field"><input id="ins-task-color" type="color" value="${esc(task.color || project.color || '#5872d9')}"><code>${esc(task.color || project.color || '#5872d9')}</code></div></div>
        <div class="inspector-row"><label class="inspector-field"><span>예정 시작일</span><input id="ins-task-planned-start" type="date" class="text-input" value="${esc(task.planned_start)}" required></label><label class="inspector-field"><span>예정 종료일</span><input id="ins-task-planned-finish" type="date" class="text-input" value="${esc(task.planned_finish)}" required></label></div>
        <div class="inspector-row"><label class="inspector-field"><span>실제 시작일</span><input id="ins-task-actual-start" type="date" class="text-input" value="${esc(task.actual_start || '')}"></label><label class="inspector-field"><span>실제 종료일</span><input id="ins-task-actual-finish" type="date" class="text-input" value="${esc(task.actual_finish || '')}"></label></div>
        <div class="property-cascade"><label for="ins-task-cascade"><input id="ins-task-cascade" data-cascade-dependents type="checkbox" ${state.cascadeDependents ? 'checked' : ''}><span>연결된 후행 작업 같이 변경</span></label><span class="info-tip"><button type="button" class="info-tip-button" aria-label="후행 작업 일정 이동 도움말" aria-describedby="cascade-tooltip">i</button><span id="cascade-tooltip" class="info-tip-text" role="tooltip">예정·실제 종료일 중 더 늦은 날짜의 변경량만큼 모든 후행 작업의 예정 시작·종료일을 이동합니다. 실제 기록은 유지됩니다.</span></span></div>
        <label class="inspector-field"><span>그룹</span><input id="ins-task-group" class="text-input" value="${esc(task.group_name || '')}" placeholder="예: 외주 작업"></label>
        <label class="inspector-field"><span>태그 <small>쉼표로 구분</small></span><input id="ins-task-tags" class="text-input" value="${esc((task.tags || []).join(', '))}" placeholder="예: 검사, 대기"></label>
        <label class="inspector-field"><span>담당 / 협력사</span><input id="ins-task-owner" class="text-input" value="${esc(task.owner || '')}" placeholder="부서 또는 업체"></label>
        <label class="inspector-field"><span>상태</span><select id="ins-task-status" class="select-input">${Object.entries(statusNames).map(([key, name]) => `<option value="${key}" ${task.status === key ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
        <label id="ins-task-blocker-row" class="inspector-field${task.status === 'blocked' ? '' : ' hidden'}"><span>막힘 / 대기 사유</span><input id="ins-task-blocker" class="text-input" value="${esc(task.blocker || '')}" placeholder="예: 부품 납기 확인 중"></label>
        <div class="inspector-field property-relations"><span>작업 연결 <small>여러 작업 선택 가능</small></span><div class="inspector-relations"><table aria-label="선행 및 후행 작업"><thead><tr><th scope="col">작업</th><th scope="col">선행 작업</th><th scope="col">후행 작업</th></tr></thead><tbody>${relatedTasks.map((item) => `<tr><th scope="row">${esc(item.name)}</th><td><input type="checkbox" class="ins-task-dependency" value="${esc(item.id)}" aria-label="${esc(item.name)} 선행 작업" ${task.dependencies.includes(item.id) ? 'checked' : ''}></td><td><input type="checkbox" class="ins-task-successor" value="${esc(item.id)}" aria-label="${esc(item.name)} 후행 작업" ${(item.dependencies || []).includes(task.id) ? 'checked' : ''}></td></tr>`).join('') || '<tr><td colspan="3">연결할 다른 작업이 없습니다.</td></tr>'}</tbody></table></div><small class="successor-help">선행: 이 작업보다 먼저 · 후행: 이 작업 다음</small></div>
        <label class="inspector-field"><span>메모</span><textarea id="ins-task-notes" class="text-area" rows="3" placeholder="검사 결과, 연락 사항 등">${esc(task.notes || '')}</textarea></label>
        </div>
        <button class="button button-primary inspector-save" type="submit">작업 속성 저장</button>
        <button class="button complete-button inspector-complete" id="ins-task-complete" type="button">✓ 오늘 완료 처리</button>
      </form>`;
  } else {
    $('#task-inspector').innerHTML = `<div class="inspector-empty"><span>⌁</span><b>작업을 선택하세요</b><small>작업 이름이나 간트 막대를 누르면 계획 날짜, 담당, 상태, 선행 관계와 인계 내용을 편집할 수 있습니다.</small></div>`;
  }
  bindInspector(project, task);
  syncAccordionVisibility();
}

function syncAccordionVisibility() {
  $('#inspector-save-state').textContent = state.selection ? state.inspectorOpen === 'project' ? '자동 저장' : '편집 후 저장' : '선택 항목 없음';
  for (const section of ['project', 'task']) {
    const open = state.inspectorOpen === section;
    $(`#${section}-accordion`).setAttribute('aria-expanded', String(open));
    $(`#${section}-accordion .accordion-chevron`).textContent = open ? '⌄' : '›';
    $(`#${section}-inspector`).classList.toggle('hidden', !open);
  }
}

// Serialize patches across inspector instances so an older blur cannot win a race.
const projectSaveQueues = new Map();
function saveProjectField(projectId, fields) {
  const previous = projectSaveQueues.get(projectId) || Promise.resolve();
  const request = previous.catch(() => {}).then(() => api(`/api/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify(fields) }));
  projectSaveQueues.set(projectId, request);
  const cleanup = () => { if (projectSaveQueues.get(projectId) === request) projectSaveQueues.delete(projectId); };
  request.then(cleanup, cleanup);
  return request;
}
function bindProjectAutoSave(form, project) {
  const fieldNames = { 'ins-project-name': 'name', 'ins-project-color': 'color', 'ins-project-start': 'start_date', 'ins-project-calendar': 'calendar_type', 'ins-project-group': 'group_name', 'ins-project-tags': 'tags' };
  const inputs = $$('input, select', form);
  const saved = new Map(inputs.map(input => [input.id, input.value]));
  const queued = new Map();
  const errors = new Map();
  const status = $('.project-autosave-state', form);
  let pending = 0;
  const showStatus = () => {
    status.textContent = errors.size ? [...errors.values()][0] : pending ? '저장 중…' : inputs.some(input => input.value !== saved.get(input.id)) ? '수정 중 · 포커스를 이동하면 저장됩니다.' : '자동 저장됨';
    status.classList.toggle('save-error', errors.size > 0);
  };
  async function save(input) {
    const key = fieldNames[input.id];
    if (!key) return;
    const value = input.value;
    if (value === (queued.has(input.id) ? queued.get(input.id) : saved.get(input.id))) return;
    const invalid = !input.checkValidity() || (key === 'name' && !value.trim()) || (key === 'start_date' && !value);
    if (invalid) {
      errors.set(input.id, key === 'name' ? '프로젝트 이름을 입력하세요.' : '올바른 날짜를 입력하세요.');
      input.setAttribute('aria-invalid', 'true');
      showStatus();
      return;
    }
    errors.delete(input.id);
    input.removeAttribute('aria-invalid');
    queued.set(input.id, value);
    pending++;
    showStatus();
    try {
      const updated = await saveProjectField(project.id, { [key]: value });
      saved.set(input.id, value);
      errors.delete(input.id);
      if (input.value === value) input.removeAttribute('aria-invalid');
      // Update metadata only; a concurrent task edit may have fresher task dates.
      const current = state.data.projects.find(item => item.id === project.id);
      if (current) for (const field of [...Object.values(fieldNames), 'updated_at']) current[field] = updated[field];
      if (form.isConnected) {
        if (key === 'color') $('.color-field code', form).textContent = updated.color;
        if (key === 'calendar_type') $('.derived-date small', form).textContent = updated.calendar_type === 'working' ? '주 5일, 공휴일 미반영' : '달력일';
        $('#project-context-label').textContent = updated.name;
        if (state.selection?.type === 'project' && state.selection.id === project.id) $('#task-context-label').textContent = updated.name;
        $('.selection-context i', form).style.background = updated.color;
      }
      if (state.view === 'timeline' && !state.drag) {
        renderSidebar();
        renderTimeline({ preserveInspector: true });
      }
    } catch (error) {
      errors.set(input.id, `저장 실패: ${error.message} 포커스를 다시 이동하면 재시도합니다.`);
      if (!form.isConnected) toast(`프로젝트 저장 실패: ${error.message}`);
      input.setAttribute('aria-invalid', 'true');
    } finally {
      if (queued.get(input.id) === value) queued.delete(input.id);
      pending--;
      showStatus();
    }
  }
  form.addEventListener('submit', event => event.preventDefault());
  for (const input of inputs) {
    input.addEventListener('input', () => {
      errors.delete(input.id);
      input.removeAttribute('aria-invalid');
      showStatus();
    });
    input.addEventListener('blur', () => save(input));
    if (input.tagName === 'SELECT' || input.type === 'color') input.addEventListener('change', () => save(input));
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); input.blur(); }
    });
  }
}

function bindInspector(project, task) {
  const projectForm = $('#project-inspector-form');
  if (projectForm && project) bindProjectAutoSave(projectForm, project);
  const taskForm = $('#task-inspector-form');
  if (taskForm && project && task) {
    $('#ins-task-status', taskForm).addEventListener('change', (event) => {
      $('#ins-task-blocker-row', taskForm).classList.toggle('hidden', event.target.value !== 'blocked');
    });
    $$('[data-cascade-dependents]', taskForm).forEach((input) => input.addEventListener('change', () => setCascadeSetting(input.checked)));
    $$('.inspector-relations input', taskForm).forEach((input) => input.addEventListener('change', () => {
      if (input.checked) {
        const opposite = input.classList.contains('ins-task-dependency') ? '.ins-task-successor' : '.ins-task-dependency';
        $(opposite, input.closest('tr')).checked = false;
      }
    }));
    const payload = () => ({ name: $('#ins-task-name').value.trim(), color: $('#ins-task-color').value, planned_start: $('#ins-task-planned-start').value, planned_finish: $('#ins-task-planned-finish').value, cascade_dependents: state.cascadeDependents, group_name: $('#ins-task-group').value, tags: $('#ins-task-tags').value, owner: $('#ins-task-owner').value, status: $('#ins-task-status').value, blocker: $('#ins-task-blocker').value, dependencies: $$('.ins-task-dependency:checked', taskForm).map((input) => input.value), successors: $$('.ins-task-successor:checked', taskForm).map((input) => input.value), actual_start: $('#ins-task-actual-start').value, actual_finish: $('#ins-task-actual-finish').value, notes: $('#ins-task-notes').value });
    taskForm.addEventListener('submit', async (event) => {
      event.preventDefault();
      const button = $('.inspector-save', taskForm);
      if (button.disabled) return;
      button.disabled = true;
      try { await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify(payload()) }); await loadState(); toast('작업 날짜와 속성을 저장했습니다.'); }
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

async function saveDraggedTaskDates(taskId, fields, period) {
  const cascade = state.cascadeDependents;
  await api(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...fields, cascade_dependents: cascade }),
  });
  state.selection = { type: 'task', id: taskId };
  state.inspectorOpen = 'task';
  persistUi();
  await loadState();
  toast(period === 'actual' ? '실제 작업 날짜를 저장했습니다.' : cascade ? '작업 날짜와 연결된 후행 일정을 저장했습니다.' : '작업 날짜를 저장했습니다.');
}

function shiftIsoDate(value, days) {
  const shifted = dateFrom(value);
  shifted.setDate(shifted.getDate() + days);
  return dateKey(shifted);
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
// Relative-day projection shares the server's legacy forward-pass behavior.
function templateSchedule(tasks, calendar = 'working') {
  const result = new Map(), visiting = new Set();
  const byKey = new Map(tasks.map(t => [t.key, t]));
  function visit(task) {
    if (result.has(task.key)) return result.get(task.key);
    if (visiting.has(task.key)) throw new Error('선행 작업 연결에 순환이 있습니다.');
    visiting.add(task.key);
    let earliest = 1;
    for (const key of task.dependencies || []) {
      if (!byKey.has(key)) throw new Error('선행 작업을 찾을 수 없습니다.');
      earliest = Math.max(earliest, visit(byKey.get(key)).end + 1);
    }
    const start = task.start_day ?? earliest;
    const duration = Math.max(1, Number(task.duration_value) || 1) * (task.duration_unit === 'weeks' ? (calendar === 'working' ? 5 : 7) : 1);
    const row = {task, start, end: start + duration - 1};
    visiting.delete(task.key); result.set(task.key, row); return row;
  }
  return tasks.map(visit);
}
// Stored template days remain one-based for compatibility; the UI starts at D.
function templateDayLabel(day) { return day === 1 ? 'D' : `D+${day - 1}`; }
function renderTemplateGantt() {
  const chart = $('#template-gantt');
  if (!chart) return;
  let rows;
  try { rows = templateSchedule(state.draft.tasks, state.templateCalendar); }
  catch (error) { chart.innerHTML = `<p class="preview-error">${esc(error.message)}</p>`; return; }
  const px = state.templateZoom || 46, label = 254, days = Math.max(21, ...rows.map(r => r.end + 5));
  const links = [];
  const byKey = new Map(rows.map((r, i) => [r.task.key, {...r, i}]));
  for (const [i, row] of rows.entries()) for (const key of row.task.dependencies || []) {
    const source = byKey.get(key), sx = label + source.end * px, tx = label + (row.start - 1) * px;
    const sy = 38 + source.i * 36 + 18, ty = 38 + i * 36 + 18;
    const kind = tx - sx >= 12 ? 'gap' : 'surface';
    const from = {kind, x:sx, centerY:sy, height:22, y:sy + (ty > sy ? 11 : -11), width:Math.min(32,(source.end-source.start+1)*px)};
    const to = {x:tx, centerY:ty, height:22, y:ty + (ty > sy ? -11 : 11), width:Math.min(32,(row.end-row.start+1)*px)};
    from.surfaceX = sx-from.width/2; to.surfaceX = tx+to.width/2;
    links.push(`<path d="${dependencyRibbon(from,to)}" fill="${esc(source.task.color || taskColors[0])}" opacity=".5"/>`);
  }
  const projectStart = rows.length ? Math.min(...rows.map(r => r.start)) : 1;
  const projectEnd = Math.max(1, ...rows.map(r => r.end));
  const projectRow = `<div class="gantt-row project-row ${state.templateTaskKey === '__project__' ? 'selected-row' : ''}"><div class="gantt-left project-left"><button class="project-select" data-template-project aria-pressed="${state.templateTaskKey === '__project__'}"><i class="group-dot" style="background:${esc(state.draft.project_color || projectColors[0])}"></i><span class="project-name">${esc(state.draft.name || '새 프로젝트')}</span><span class="project-meta">${rows.length}개 작업</span></button></div><div class="gantt-right project-timeline" style="width:${days*px}px"><button class="project-summary-bar" data-template-project style="left:${(projectStart-1)*px}px;width:${(projectEnd-projectStart+1)*px}px;--bar-color:${esc(state.draft.project_color || projectColors[0])}"><span>${templateDayLabel(projectStart)}–${templateDayLabel(projectEnd)}</span></button></div></div>`;
  const scroll = chart.scrollLeft, scrollTop = chart.scrollTop;
  chart.innerHTML = `<div class="template-chart-content" style="--project-color:${esc(state.draft.project_color || projectColors[0])};width:${label+days*px}px;--day-width:${px}px"><div class="gantt-head"><div class="gantt-left">프로젝트 / 작업</div><div class="gantt-right date-axis">${Array.from({length:days},(_,i)=>`<div class="template-day">${templateDayLabel(i+1)}</div>`).join('')}</div></div><div class="gantt-body" style="height:${38+rows.length*36}px">${projectRow}${rows.map(({task,start,end})=>`<div class="gantt-row task-row ${task.key===state.templateTaskKey?'selected-row':''}"><div class="gantt-left task-left"><button class="task-label" data-template-select="${esc(task.key)}"><i class="task-state" style="background:${esc(task.color || taskColors[0])}"></i><span class="task-name">${esc(task.name)}</span></button></div><div class="gantt-right project-timeline" style="width:${days*px}px"><button class="task-bar template-bar ${task.key===state.templateTaskKey?'template-selected':''}" data-template-select="${esc(task.key)}" style="left:${(start-1)*px}px;width:${(end-start+1)*px}px;--bar-color:${esc(task.color || taskColors[0])}" title="${esc(task.name)} · ${templateDayLabel(start)}–${templateDayLabel(end)}"><span class="resize-handle resize-start" data-template-edge="start"></span><span class="bar-text">${esc(task.name)} · ${templateDayLabel(start)}–${templateDayLabel(end)}</span><span class="resize-handle resize-end" data-template-edge="end"></span></button></div></div>`).join('')}<svg class="dependency-layer" width="${label+days*px}" height="${38+rows.length*36}" aria-hidden="true">${links.join('')}</svg></div></div>`;
  $('#template-range').textContent = `${templateDayLabel(projectStart)} — ${templateDayLabel(projectEnd)}`;
  chart.scrollLeft = scroll;
  chart.scrollTop = scrollTop;
  for (const row of rows) {
    const fields = $(`[data-template-days="${CSS.escape(row.task.key)}"]`);
    if (fields) { $('.template-start-day', fields).value=row.start-1; $('.template-end-day', fields).value=row.end-1; }
  }
}
function attachTemplateDrag() {
  const chart = $('#template-gantt');
  let drag = null, suppressClick = false;
  chart.addEventListener('click', event => {
    if (suppressClick) { suppressClick=false; return; }
    if (event.target.closest('[data-template-project]')) { syncDraftFromEditor(); state.templateTaskKey='__project__'; renderTemplateEditor(); return; }
    const button = event.target.closest('[data-template-select]');
    if (!button) return;
    syncDraftFromEditor(); state.templateTaskKey=button.dataset.templateSelect; renderTemplateEditor();
  });
  chart.addEventListener('pointerdown', event => {
    const bar=event.target.closest('.template-bar');
    if (!bar || event.button!==0 || !event.isPrimary) return;
    event.preventDefault();
    const row=templateSchedule(state.draft.tasks,state.templateCalendar).find(r=>r.task.key===bar.dataset.templateSelect);
    drag={...row,bar,x:event.clientX,id:event.pointerId,edge:event.target.closest('[data-template-edge]')?.dataset.templateEdge,delta:0};
    bar.setPointerCapture(event.pointerId);
  });
  chart.addEventListener('pointermove', event => {
    if (!drag || drag.id!==event.pointerId) return;
    const delta=Math.round((event.clientX-drag.x)/(state.templateZoom || 46));
    const start=drag.edge==='end'?drag.start:Math.max(1,Math.min(10000,drag.start+delta));
    const end=drag.edge==='start'?drag.end:drag.edge==='end'?Math.max(start,drag.end+delta):start+drag.end-drag.start;
    if (start>end) return;
    drag.preview={start,end}; drag.delta=delta;
    drag.bar.style.left=`${(start-1)*(state.templateZoom || 46)}px`; drag.bar.style.width=`${(end-start+1)*(state.templateZoom || 46)}px`;
    $('.bar-text',drag.bar).textContent=`${drag.task.name} · ${templateDayLabel(start)}–${templateDayLabel(end)}`;
  });
  chart.addEventListener('pointerup', event => {
    if (!drag || drag.id!==event.pointerId) return;
    const current=drag; drag=null;
    if (current.preview && current.delta) {
      current.task.start_day=current.preview.start;
      current.task.duration_value=current.preview.end-current.preview.start+1; current.task.duration_unit='days';
      state.templateTaskKey=current.task.key; suppressClick=true;
      renderTemplateEditor();
    }
  });
  chart.addEventListener('pointercancel', () => { drag=null; renderTemplateGantt(); });
}
function templateTaskProperties(task, index, tasks) {
  return `<section class="template-properties-card property-grid"><div class="template-day-fields" data-template-days="${esc(task.key)}"><label class="inspector-field"><span>시작 D+</span><input class="text-input template-start-day" type="number" min="0" max="9999" required></label><label class="inspector-field"><span>종료 D+</span><input class="text-input template-end-day" type="number" min="0" required></label><button class="button button-small template-auto-days">선행 기준 자동 배치</button></div>${templateTaskRow(task,index,tasks)}</section>`;
}
function attachTemplateDayFields() {
  $$('[data-template-days]').forEach(fields => {
    const task=state.draft.tasks.find(t=>t.key===fields.dataset.templateDays);
    const startField=$('.template-start-day',fields), endField=$('.template-end-day',fields);
    for (const input of [startField,endField]) input.addEventListener('input',()=>{
      if (!startField.value || !endField.value) return;
      const start=Number(startField.value)+1,end=Number(endField.value)+1;
      if (!Number.isInteger(start)||!Number.isInteger(end)||start<1||start>10000||end<start) return;
      task.start_day=start;task.duration_value=end-start+1;task.duration_unit='days';
      const card=fields.closest('.template-properties-card');
      $('.template-task-duration',card).value=task.duration_value;$('.template-task-unit',card).value='days';renderTemplateGantt();
    });
    $('.template-auto-days',fields).addEventListener('click',()=>{task.start_day=null;renderTemplateEditor();});
  });
}

function renderTemplateEditor() {
  const editor = $('#template-editor');
  const chart = $('#template-gantt');
  const position = { x: window.scrollX, y: window.scrollY, left: chart?.scrollLeft || 0, top: chart?.scrollTop || 0 };
  const minHeight = editor.style.minHeight;
  // Keep the document height stable while the chart is temporarily empty.
  editor.style.minHeight = `${editor.getBoundingClientRect().height}px`;
  try {
    renderTemplateEditorContent();
  } finally {
    editor.style.minHeight = minHeight;
    const updatedChart = $('#template-gantt');
    if (updatedChart) {
      updatedChart.scrollLeft = position.left;
      updatedChart.scrollTop = position.top;
    }
    window.scrollTo({ left: position.x, top: position.y, behavior: 'instant' });
  }
}
function renderTemplateEditorContent() {
  const draft = state.draft;
  if (!draft) {
    $('#template-editor').innerHTML = '<div class="no-template">템플릿을 만들거나 왼쪽 목록에서 선택하세요.</div>';
    return;
  }
  const selectedTask = draft.tasks.find(t => t.key === state.templateTaskKey) || draft.tasks[0];
  const projectOpen = state.templateTaskKey === '__project__' || !selectedTask;
  $('#template-editor').innerHTML = `
    <div class="timeline-layout">
      <div class="timeline-main"><div class="schedule-card">
        <div class="toolbar"><div class="toolbar-left"><span class="template-chart-title">${esc(draft.name || '새 템플릿')}</span><button id="add-template-task" class="button button-small">＋ 작업 추가</button></div><div class="toolbar-right"><label class="template-calendar-label">기간 기준 <select id="template-calendar" class="select-control"><option value="working">주 5일</option><option value="calendar">달력일</option></select></label><label class="zoom-slider-control">축척 <input id="template-zoom" type="range" min="34" max="62" value="${state.templateZoom || 46}" aria-label="템플릿 축척"><output>${Math.round((state.templateZoom || 46)/46*100)}%</output></label><button id="save-template" class="button button-primary">템플릿 저장</button></div></div>
        <div class="schedule-legend"><span><i class="legend-swatch project-swatch"></i>프로젝트 요약</span><span>작업 연결</span><span class="legend-date-range" id="template-range"></span><span class="info-tip schedule-info"><button type="button" class="info-tip-button" aria-label="템플릿 일정 기준" aria-describedby="template-rules">i</button><span id="template-rules" class="info-tip-text" role="tooltip">D는 프로젝트 첫 작업일이며 D+1은 다음 작업일입니다. 주 5일은 토·일을 제외합니다. 막대와 양끝을 끌어 시작과 기간을 조정할 수 있습니다. 저장한 템플릿은 새 배치에 적용됩니다.</span></span></div>
        <div id="template-gantt" class="gantt-wrap template-gantt"></div>
      </div></div>
      <aside class="inspector" aria-label="템플릿 속성"><div class="inspector-title"><div><span class="eyebrow">INSPECTOR</span><h2>속성</h2></div><span class="inspector-state">템플릿 · 편집 후 저장</span></div>
        <section class="inspector-section"><button type="button" id="template-project-accordion" class="inspector-accordion" aria-expanded="${projectOpen}"><span class="accordion-chevron">${projectOpen?'⌄':'›'}</span><span>프로젝트 속성</span><small>${esc(draft.name)}</small></button><div class="inspector-content property-grid ${projectOpen?'':'hidden'}">
          <label class="inspector-field"><span>템플릿 이름</span><input id="template-name" class="text-input" value="${esc(draft.name)}"></label>
          <label class="inspector-field"><span>설명</span><input id="template-description" class="text-input" value="${esc(draft.description || '')}"></label>
          <div class="inspector-field"><span>프로젝트 색상</span><div class="color-field"><input id="template-project-color" type="color" value="${esc(draft.project_color || projectColors[0])}" aria-label="템플릿 기본 프로젝트 색상"><code>${esc(draft.project_color || projectColors[0])}</code></div></div>
        </div></section>
        <section class="inspector-section"><button type="button" id="template-task-accordion" class="inspector-accordion" aria-expanded="${!projectOpen}"><span class="accordion-chevron">${projectOpen?'›':'⌄'}</span><span>작업 속성</span><small>${esc(selectedTask?.name || '작업 없음')}</small></button><div id="template-tasks" class="inspector-content ${projectOpen?'hidden':''}">${selectedTask ? templateTaskProperties(selectedTask,draft.tasks.indexOf(selectedTask),draft.tasks) : '<p>작업을 추가하세요.</p>'}</div></section>
      </aside>
    </div>`;
  $('#template-project-accordion').addEventListener('click', () => { syncDraftFromEditor(); state.templateTaskKey='__project__'; renderTemplateEditor(); });
  $('#template-task-accordion').addEventListener('click', () => { syncDraftFromEditor(); state.templateTaskKey=selectedTask?.key; renderTemplateEditor(); });
  $('#template-zoom').addEventListener('input', event => { state.templateZoom=Number(event.target.value); event.target.nextElementSibling.textContent=`${Math.round(state.templateZoom/46*100)}%`; renderTemplateGantt(); });
  $('#template-calendar').value = state.templateCalendar || 'working';
  $('#template-calendar').addEventListener('change', event => { state.templateCalendar = event.target.value; renderTemplateGantt(); });
  renderTemplateGantt();
  attachTemplateDrag();
  attachTemplateDayFields();
  $('#template-name').addEventListener('input', (event) => { draft.name = event.target.value; renderTemplateGantt(); });
  $('#template-description').addEventListener('input', (event) => { draft.description = event.target.value; });
  $('#template-project-color').addEventListener('input', (event) => { draft.project_color = event.target.value; event.target.nextElementSibling.textContent = event.target.value; renderTemplateGantt(); });
  $$('.template-task-name').forEach((input) => input.addEventListener('input', () => updateTemplateField(input)));
  $$('.template-task-duration').forEach((input) => input.addEventListener('input', () => updateTemplateField(input)));
  $$('.template-task-unit').forEach((input) => input.addEventListener('change', () => updateTemplateField(input)));
  $$('.template-task-color').forEach((input) => input.addEventListener('input', () => updateTemplateField(input)));
  $$('.template-task-owner').forEach((input) => input.addEventListener('input', () => updateTemplateField(input)));
  $$('.template-task-handoff').forEach((input) => input.addEventListener('input', () => updateTemplateField(input)));
  $$('.dep-summary').forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); button.closest('.dep-picker').classList.toggle('open'); }));
  $$('.template-dependency, .template-successor').forEach(input => input.addEventListener('change', () => {
    try {
      setTemplateRelation(draft.tasks, input.dataset.task, input.dataset.dependency, input.classList.contains('template-successor'), input.checked);
    } catch (error) { toast(error.message); }
    // Both directions and all visible task cards describe the same edge.
    $$('.template-dependency, .template-successor').forEach(box => {
      const successor = box.classList.contains('template-successor');
      const target = draft.tasks.find(t => t.key === (successor ? box.dataset.dependency : box.dataset.task));
      box.checked = target.dependencies.includes(successor ? box.dataset.task : box.dataset.dependency);
    });
    $$('.dep-picker[data-task]').forEach(picker => {
      const task=draft.tasks.find(t=>t.key===picker.dataset.task);
      $('.dep-summary',picker).textContent=templateRelationSummary(task,draft.tasks);
    });
    renderTemplateGantt();
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
    state.templateTaskKey = draft.tasks.at(-1).key;
    state.preview = null; renderTemplateEditor();
  });

  $('#save-template').addEventListener('click', saveTemplate);
}
function templateRelationSummary(task, tasks) {
  const successors = tasks.filter(other => (other.dependencies || []).includes(task.key)).length;
  return `선행 및 후행 작업 · ${task.dependencies.length} / ${successors}`;
}
function setTemplateRelation(tasks, taskKey, otherKey, successor, checked) {
  const target = tasks.find(t => t.key === (successor ? otherKey : taskKey));
  const predecessor = successor ? taskKey : otherKey;
  const previous = target.dependencies;
  target.dependencies = checked ? [...new Set([...previous, predecessor])] : previous.filter(key => key !== predecessor);
  try { templateSchedule(tasks); }
  catch (error) { target.dependencies = previous; throw error; }
}
function templateTaskRow(task, index, tasks) {
  const field = (label, content) => `<label class="inspector-field"><span>${label}</span>${content}</label>`;
  return `${field('작업명',`<input class="text-input template-task-name" data-key="${esc(task.key)}" value="${esc(task.name)}">`)}
    <div class="inspector-field"><span>작업 색상</span><div class="color-field"><input class="template-task-color" data-key="${esc(task.key)}" type="color" value="${esc(task.color || taskColors[index % taskColors.length])}" aria-label="작업 색상"></div></div>
    <div class="inspector-field"><span>기간</span><div class="duration-field"><input class="text-input template-task-duration" data-key="${esc(task.key)}" type="number" min="1" max="520" value="${esc(task.duration_value)}" aria-label="기간"><select class="select-input template-task-unit" data-key="${esc(task.key)}" aria-label="기간 단위"><option value="days" ${task.duration_unit==='days'?'selected':''}>일</option><option value="weeks" ${task.duration_unit==='weeks'?'selected':''}>주</option></select></div></div>
    ${field('담당 / 협력사',`<input class="text-input template-task-owner" data-key="${esc(task.key)}" value="${esc(task.owner || '')}">`)}
    <div class="property-relations-label">작업 연결</div><div class="inspector-relations"><table aria-label="템플릿 선행 및 후행 작업"><thead><tr><th>작업</th><th>선행</th><th>후행</th></tr></thead><tbody>${tasks.filter(other=>other.key!==task.key).map(other=>`<tr><th><span class="template-relation-name" data-key="${esc(other.key)}">${esc(other.name)}</span></th><td><input type="checkbox" class="template-dependency" data-task="${esc(task.key)}" data-dependency="${esc(other.key)}" aria-label="${esc(other.name)} 선행 작업" ${task.dependencies.includes(other.key)?'checked':''}></td><td><input type="checkbox" class="template-successor" data-task="${esc(task.key)}" data-dependency="${esc(other.key)}" aria-label="${esc(other.name)} 후행 작업" ${(other.dependencies||[]).includes(task.key)?'checked':''}></td></tr>`).join('') || '<tr><td colspan="3">연결할 다른 작업이 없습니다.</td></tr>'}</tbody></table></div>
    ${field('메모',`<input class="text-input template-task-handoff" data-key="${esc(task.key)}" value="${esc(task.handoff || '')}">`)}
    <button class="button button-small danger-button remove-task" data-index="${index}" type="button">작업 삭제</button>`;
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
    // Unselected tasks have no inspector inputs; preserve their dependencies.
    if (byKey('.template-task-name')) task.dependencies = $$('.template-dependency:checked').filter((input) => input.dataset.task === task.key).map((input) => input.dataset.dependency);
  }
}
function updateTemplateField(input) {
  const task = state.draft.tasks.find((item) => item.key === input.dataset.key);
  if (!task) return;
  if (input.classList.contains('template-task-name')) {
    task.name = input.value;
    $$(`.template-relation-name[data-key="${CSS.escape(task.key)}"]`).forEach((label) => { label.textContent = task.name; });
  }
  if (input.classList.contains('template-task-duration')) task.duration_value = Math.max(1, Number(input.value) || 1);
  if (input.classList.contains('template-task-unit')) task.duration_unit = input.value;
  if (input.classList.contains('template-task-color')) task.color = input.value;
  if (input.classList.contains('template-task-owner')) task.owner = input.value;
  if (input.classList.contains('template-task-handoff')) task.handoff = input.value;
  renderTemplateGantt();
}
async function saveTemplate() {
  const button = $('#save-template');
  if (button.disabled) return;
  button.disabled = true;
  try {
    for (const fields of $$('[data-template-days]')) {
      const startField=$('.template-start-day',fields),endField=$('.template-end-day',fields);
      if (!startField.checkValidity() || !endField.checkValidity() || Number(endField.value)<Number(startField.value)) throw new Error('시작·종료 D+범위를 확인하세요.');
    }
    syncDraftFromEditor();
    if (!state.draft.name.trim()) throw new Error('템플릿 이름을 입력하세요.');
    if (!state.draft.tasks.length) throw new Error('작업을 한 개 이상 추가하세요.');
    if (state.draft.tasks.some((task) => !String(task.name).trim())) throw new Error('작업명을 입력하세요.');
    const payload = { name: state.draft.name.trim(), description: state.draft.description || '', project_color: state.draft.project_color || projectColors[0], tasks: state.draft.tasks.map((task, index) => ({ key: task.key, name: task.name.trim(), duration_value: Number(task.duration_value), duration_unit: task.duration_unit, start_day: task.start_day ?? null, dependencies: task.dependencies, owner: task.owner || '', handoff: task.handoff || '', color: task.color || taskColors[index % taskColors.length], sort_order: index })) };
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
  const depMarkup = dependencies.length ? dependencies.map((item) => `<label><input type='checkbox' class='task-dep-checkbox' value='${esc(item.id)}' ${task.dependencies.includes(item.id) ? 'checked' : ''}><span>${esc(item.name)}</span></label>`).join('') : '<span class="form-help">다른 작업을 추가하면 연결할 수 있습니다.</span>';
  const body = `<div class='task-details'><div class='form-grid'>
    <label class='form-field full'><span class='field-label'>작업명</span><input id='edit-task-name' class='text-input' value='${esc(task.name)}' required></label>
    <label class='form-field'><span class='field-label'>예정 시작일</span><input id='edit-task-planned-start' type='date' class='text-input' value='${esc(task.planned_start)}' required></label>
    <label class='form-field'><span class='field-label'>예정 종료일</span><input id='edit-task-planned-finish' type='date' class='text-input' value='${esc(task.planned_finish)}' required></label>
    <label class='form-field'><span class='field-label'>담당 / 협력사</span><input id='edit-task-owner' class='text-input' value='${esc(task.owner)}' placeholder='담당 부서 또는 업체'></label>
    <label class='form-field'><span class='field-label'>상태</span><select id='edit-task-status' class='select-input'>${Object.entries(statusNames).map(([key, name]) => `<option value='${key}' ${task.status === key ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
    <label class='form-field full cascade-inline'><input data-cascade-dependents type='checkbox' ${state.cascadeDependents ? 'checked' : ''}><span>연결된 후행 작업 같이 변경</span></label>
    <div class='form-field full schedule-note'><span>↳</span><span>더 늦은 예정·실제 종료일의 변경량만큼 모든 후행 작업의 예정 날짜를 이동합니다. 실제 기록은 유지됩니다.</span></div>
    <label class='form-field full'><span class='field-label'>선행 작업 <span style='font-weight:400;color:#a2aab5'> · 복수 선택 시 모든 선행 작업이 끝나야 시작</span></span><div class='dependency-box'>${depMarkup}</div></label>
    <label class='form-field full'><span class='field-label'>막힘 / 대기 사유</span><input id='edit-task-blocker' class='text-input' value='${esc(task.blocker)}' placeholder='예: 부품 납기 확인 중'></label>
    <div class='form-field full'><span class='field-label'>실제 작업일</span><div class='actual-grid'><label><input id='edit-task-actual-start' type='date' class='text-input' value='${esc(task.actual_start)}'><div class='form-help'>실제 시작일</div></label><label><input id='edit-task-actual-finish' type='date' class='text-input' value='${esc(task.actual_finish)}'><div class='form-help'>실제 완료일</div></label></div></div>
    <label class='form-field full'><span class='field-label'>메모</span><textarea id='edit-task-notes' class='text-area' rows='2' placeholder='검사 결과, 연락 사항 등'>${esc(task.notes)}</textarea></label>
  </div></div>`;
  const footer = `<button id='mark-complete' class='button complete-button'>✓ 오늘 완료 처리</button><div class='modal-footer-right'><button id='cancel-task' class='button'>취소</button><button id='save-task' class='button button-primary'>변경 저장</button></div>`;
  openModal(task.name, `${project.name} · 예정 ${fmtDate(task.planned_start, true)} – ${fmtDate(task.planned_finish, true)}`, body, footer, () => {
    $('#cancel-task').addEventListener('click', closeModal);
    $$('[data-cascade-dependents]', $('#modal-root')).forEach((input) => input.addEventListener('change', () => setCascadeSetting(input.checked)));
    const formPayload = () => ({
      name: $('#edit-task-name').value.trim(),
      planned_start: $('#edit-task-planned-start').value,
      planned_finish: $('#edit-task-planned-finish').value,
      cascade_dependents: state.cascadeDependents,
      owner: $('#edit-task-owner').value,
      status: $('#edit-task-status').value,
      dependencies: $$('.task-dep-checkbox:checked').map((input) => input.value),
      blocker: $('#edit-task-blocker').value,
      actual_start: $('#edit-task-actual-start').value,
      actual_finish: $('#edit-task-actual-finish').value,
      notes: $('#edit-task-notes').value,
    });
    let saving = false;
    const save = async (complete = false) => {
      if (saving) return;
      const payload = formPayload();
      if (!payload.name) { setModalError('작업명을 입력하세요.'); return; }
      if (complete) { payload.status = 'done'; payload.actual_start ||= todayInput(); payload.actual_finish ||= todayInput(); }
      saving = true;
      $('#save-task').disabled = true;
      $('#mark-complete').disabled = true;
      try {
        await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        closeModal();
        await loadState();
        toast(complete ? '실제 완료일을 기록했습니다.' : '작업 날짜와 속성을 저장했습니다.');
      } catch (error) {
        setModalError(error.message);
        saving = false;
        $('#save-task').disabled = false;
        $('#mark-complete').disabled = false;
      }
    };
    $('#save-task').addEventListener('click', () => save(false));
    $('#mark-complete').addEventListener('click', () => save(true));
  });
}
function openProjectEditor(projectId) {
  const project = state.data.projects.find((item) => item.id === projectId);
  if (!project) return;
  const body = `<div class="form-grid"><label class="form-field full"><span class="field-label">프로젝트 이름</span><input id="edit-project-name" class="text-input" value="${esc(project.name)}"></label><label class="form-field"><span class="field-label">시작일</span><input id="edit-project-start" type="date" class="text-input" value="${esc(project.start_date)}"></label><label class="form-field"><span class="field-label">일정 계산 기준</span><select id="edit-project-calendar" class="select-input"><option value="working" ${project.calendar_type === 'working' ? 'selected' : ''}>주 5일 (월–금)</option><option value="calendar" ${project.calendar_type === 'calendar' ? 'selected' : ''}>달력일 (주 7일)</option></select></label><div class="form-field full"><div class="form-help">시작일과 달력 기준을 바꾸어도 저장된 작업 날짜는 그대로 유지됩니다.</div></div></div>`;
  const footer = `<button id="cancel-project-edit" class="button">취소</button><div class="modal-footer-right"><button id="save-project-edit" class="button button-primary">프로젝트 정보 저장</button></div>`;
  openModal('프로젝트 설정', `${project.tasks.length}개 작업 · ${project.template_name}`, body, footer, () => {
    $('#cancel-project-edit').addEventListener('click', closeModal);
    $('#save-project-edit').addEventListener('click', async () => {
      try { await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', body: JSON.stringify({ name: $('#edit-project-name').value.trim(), start_date: $('#edit-project-start').value, calendar_type: $('#edit-project-calendar').value }) }); closeModal(); await loadState(); toast('프로젝트 정보를 저장했습니다. 작업 날짜는 그대로 유지됩니다.'); }
      catch (error) { setModalError(error.message); }
    });
  });
}
function attachEvents() {
  const cascadeSetting = $('#cascade-setting');
  cascadeSetting.checked = state.cascadeDependents;
  cascadeSetting.addEventListener('change', () => setCascadeSetting(cascadeSetting.checked));
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
  const zoomSlider = $('#zoom-slider');
  let zoomFrame = null;
  zoomSlider.addEventListener('input', () => {
    const value = Math.max(34, Math.min(62, Number(zoomSlider.value)));
    const label = `${Math.round(value / 46 * 100)}%`;
    $('#zoom-value').textContent = label;
    zoomSlider.setAttribute('aria-valuetext', label);
    if (zoomFrame !== null) cancelAnimationFrame(zoomFrame);
    zoomFrame = requestAnimationFrame(() => {
      zoomFrame = null;
      const wrap = $('#gantt-wrap');
      const oldLeft = wrap.scrollLeft, oldTop = wrap.scrollTop;
      const halfVisible = Math.max(0, wrap.clientWidth - 254) / 2;
      const centerDay = (oldLeft + halfVisible) / state.zoom;
      state.zoom = value;
      renderTimeline({ preserveInspector: true });
      wrap.scrollLeft = oldLeft === 0 ? 0 : centerDay * value - halfVisible;
      wrap.scrollTop = oldTop;
    });
  });
  $('#today-button').addEventListener('click', () => {
    const wrap = $('#gantt-wrap');
    if (state.layout === 'gantt' && !wrap.classList.contains('hidden')) {
      const line = $('.today-line', $('#gantt'));
      if (line) wrap.scrollLeft = Math.max(0, 254 + Number(line.style.left.replace('px', '')) - wrap.clientWidth / 2);
    }
  });
  $('#refresh-button').addEventListener('click', async () => { try { await loadState(); toast('일정을 새로 불러왔습니다.'); } catch (error) { toast(error.message); } });
  $('#gantt').addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('.resize-handle');
    const bar = handle?.closest('.task-bar, .actual-task-bar');
    if (!handle || !bar || !event.isPrimary || event.button !== 0 || state.savingDates) return;
    event.preventDefault();
    const edge = handle.dataset.resizeEdge;
    const period = bar.dataset.datePeriod || 'planned';
    const task = state.data.projects.find((project) => project.id === bar.dataset.project)?.tasks.find((task) => task.id === bar.dataset.taskSelect);
    if (!task) return;
    const originalStart = task[`${period}_start`] || '';
    const originalFinish = task[`${period}_finish`] || '';
    if (!originalStart && !originalFinish) return;
    const pxPerDay = state.zoom;
    state.drag = {
      pointerId: event.pointerId,
      edge,
      taskId: bar.dataset.taskSelect,
      projectId: bar.dataset.project,
      bar,
      handle,
      startX: event.clientX,
      pxPerDay,
      left: Number.parseFloat(bar.style.left) || 0,
      width: Number.parseFloat(bar.style.width) || pxPerDay,
      period,
      originalStart,
      originalFinish,
      displayStart: originalStart || originalFinish,
      previewFields: {},
      delta: 0,
      valid: true,
    };
    bar.classList.add('is-resizing');
    handle.setPointerCapture(event.pointerId);
  });
  $('#gantt').addEventListener('pointermove', (event) => {
    const drag = state.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    const delta = Math.round((event.clientX - drag.startX) / drag.pxPerDay);
    const candidate = draggedDateChange(drag, delta);
    drag.delta = delta;
    drag.valid = candidate.valid;
    drag.handle.classList.toggle('resize-invalid', !drag.valid);
    if (!drag.valid) return;
    drag.previewFields = candidate.fields;
    drag.bar.style.left = `${drag.left + dayDiff(drag.displayStart, candidate.start) * drag.pxPerDay}px`;
    drag.bar.style.width = `${(dayDiff(candidate.start, candidate.finish) + 1) * drag.pxPerDay}px`;
    renderDependencyLinks();
    drag.bar.title = `${drag.period === 'actual' ? '실제' : '예정'} · ${fmtDate(candidate.start, true)}–${fmtDate(candidate.finish, true)}`;
  });
  $('#gantt').addEventListener('pointerup', async (event) => {
    const drag = state.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    event.preventDefault();
    drag.bar.classList.remove('is-resizing');
    drag.handle.classList.remove('resize-invalid');
    state.drag = null;
    if (!drag.valid || !drag.delta) { renderTimeline(); return; }
    const candidate = draggedDateChange(drag, drag.delta);
    state.savingDates = true;
    try {
      await saveDraggedTaskDates(drag.taskId, candidate.fields, drag.period);
    } catch (error) {
      renderTimeline();
      toast(error.message);
    } finally {
      state.savingDates = false;
    }
  });
  $('#gantt').addEventListener('pointercancel', (event) => {
    if (!state.drag || event.pointerId !== state.drag.pointerId) return;
    state.drag.bar.classList.remove('is-resizing');
    state.drag = null;
    renderTimeline();
  });
  $('#gantt').addEventListener('keydown', (event) => {
    const edge = event.target.closest('.dependency-link');
    if (edge && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      selectItem('task', edge.dataset.taskSelect);
    }
  });
  $('#gantt').addEventListener('click', (event) => {
    const collapse = event.target.closest('[data-collapse]');
    if (collapse) {
      const projectId = collapse.dataset.collapse;
      state.collapsedProjects.has(projectId) ? state.collapsedProjects.delete(projectId) : state.collapsedProjects.add(projectId);
      persistUi();
      renderTimeline();
      return;
    }
    if (event.target.closest('.resize-handle')) { event.preventDefault(); return; }
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
