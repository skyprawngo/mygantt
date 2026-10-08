I18n.ready.then(() => {
const t = (textID, params) => I18n.t(textID, params);
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let savedUi = {};
try { savedUi = JSON.parse(localStorage.getItem('mygantt-ui') || '{}'); } catch { savedUi = {}; }
function restoreZoom(value, minimum) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(minimum, Math.min(62, value)) : 46;
}
const state = { data: { templates: [], projects: [] }, view: 'timeline', layout: 'gantt', zoom: restoreZoom(savedUi.zoom, 24), templateZoom: restoreZoom(savedUi.templateZoom, 12), filterProject: null, selectedTemplateId: null, draft: null, preview: null, selection: savedUi.selection || null, inspectorOpen: savedUi.inspectorOpen || 'project', collapsedProjects: new Set(savedUi.collapsedProjects || []), hiddenProjects: new Set(savedUi.hiddenProjects || []), cascadeDependents: savedUi.cascadeDependents ?? false, drag: null, holidays: {} };
const statusNames = { get todo() { return t("status.planned"); }, get doing() { return t("status.in_progress"); }, get blocked() { return t("status.stopped"); }, get done() { return t("status.complete"); } };
const durationNames = { get days() { return t("common.days"); }, get weeks() { return t("common.weeks"); } };
const projectColors = ['#5872d9', '#b96749', '#27897f', '#a45ca8', '#b48527', '#3978a8', '#c45670', '#5a8d45', '#765bb2', '#368a9b', '#c06f2d', '#657386'];
const taskColors = [...projectColors];
let previewTimer;
let timelineReferenceTime = new Date();

// Shared palette for every user-selected project/task color (HTML and SVG).
const paletteCache = new Map();
function colorPalette(value) {
  let base = String(value || '').toLowerCase();
  if (/^#[0-9a-f]{3}$/.test(base)) base = '#' + [...base.slice(1)].map(c => c+c).join('');
  if (!/^#[0-9a-f]{6}$/.test(base)) base = '#5872d9';
  if (paletteCache.has(base)) return paletteCache.get(base);
  const rgb = base.slice(1).match(/../g).map(c => parseInt(c,16));
  const mix = (target, amount) => '#' + rgb.map(c => Math.round(c*(1-amount)+target*amount).toString(16).padStart(2,'0')).join('');
  const luminance = hex => hex.slice(1).match(/../g).map(c => parseInt(c,16)/255).map(c => c<=.04045 ? c/12.92 : ((c+.055)/1.055)**2.4).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
  // Progress: strengthen muted chromatic colors without dimming them;
  // already vivid colors become darker. Neutrals have no hue to saturate.
  const maximum = Math.max(...rgb), minimum = Math.min(...rgb);
  const saturation = maximum ? (maximum-minimum)/maximum : 0;
  const progress = saturation > 0 && saturation < .55
    ? '#' + rgb.map(channel => Math.round(maximum-(maximum-channel)*Math.min(.85,saturation+.3)/saturation).toString(16).padStart(2,'0')).join('')
    : mix(0,.28);
  const dark = mix(0,.28), light = mix(255,.78);
  // Prefer white on colored backgrounds; reserve black for very light colors.
  const useDarkInk = luminance(base) >= .72;
  const palette = Object.freeze({base,dark,progress,light,surface:mix(255,.93),hover:mix(255,.88),border:mix(255,.65),ink:useDarkInk?'#000000':'#ffffff'});
  paletteCache.set(base,palette);
  return palette;
}
function paletteStyle(value, prefix='bar') {
  const p = colorPalette(value);
  return Object.entries(p).map(([key,color])=>`--${prefix}-${key==='base'?'color':key}:${color}`).join(';')+';';
}
function applyPalette(element, value, prefix='task-tag') {
  const p = colorPalette(value);
  for (const [key,color] of Object.entries(p)) element.style.setProperty(`--${prefix}-${key==='base'?'color':key}`,color);
}
function connectionFill(progress, direction) {
  const value = Math.max(0, Math.min(100, Number(progress) || 0));
  return direction === 'incoming' ? Math.min(1, value / 10) : Math.max(0, (value - 90) / 10);
}
function connectionColor(task, direction = 'incoming') {
  const p = colorPalette(task.color), fill = connectionFill(taskProgress(task), direction);
  return '#' + [1,3,5].map(i => Math.round(parseInt(p.base.slice(i,i+2),16)*(1-fill) + parseInt(p.progress.slice(i,i+2),16)*fill).toString(16).padStart(2,'0')).join('');
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
let selectedTimeZone = '';
try { selectedTimeZone = localStorage.getItem('mygantt-timezone') || ''; } catch {}
function clockParts(now = new Date()) { return MyGanttTime.parts(now,selectedTimeZone,state.data.server_clock); }
function todayInput() { return clockParts().date; }
function timeOfDayFraction(now = new Date()) {
  const parts=clockParts(now);
  return (Number(parts.hour)*3600+Number(parts.minute)*60+Number(parts.second))/86400;
}
function updateCurrentTimeMarker() {
  const chart = $('#gantt');
  if (state.view !== 'timeline' || !chart.dataset.todayDate || state.drag) return;
  const now = timelineReferenceTime, fraction = timeOfDayFraction(now);
  const x = (Number(chart.dataset.todayOffset) + fraction) * state.zoom;
  $$('.today-line', chart).forEach(line => { line.style.left = `${x}px`; });
  const cell = $('.date-header.today', chart);
  if (cell) {
    cell.style.setProperty('--time-progress', `${fraction * 100}%`);
    cell.title = t("common.updated_at_left_00_00_right", {p0:clockParts(now).date,p1:clockParts(now).hour,p2:clockParts(now).minute});
  }
}
function dateFrom(value) { return new Date(`${value}T00:00:00`); }
function dateKey(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function dayDiff(start, end) { return Math.round((dateFrom(end) - dateFrom(start)) / 86400000); }
function fmtDate(value, year = false) {
  if (!value) return '—';
  const d = dateFrom(value);
  if (I18n.language !== 'KR') return new Intl.DateTimeFormat(I18n.locale, {month:'numeric',day:'numeric',...(year?{year:'numeric'}:{})}).format(d);
  return year ? `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}` : `${d.getMonth() + 1}/${d.getDate()}`;
}
function dateRangeLabel(start, end) {
  if (!start || !end) return t("common.no_schedule");
  return `${fmtDate(start, true)} — ${fmtDate(end, true)}`;
}
function toast(message) {
  const node = $('#toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => node.classList.remove('show'), 2600);
}
async function requestJson(path, options = {}) {
  const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
  if (path === '/api/state') state.appVersion = response.headers.get('server')?.match(/MyGantt\/([^\s]+)/)?.[1] || null;
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data?.error ? I18n.serverError(data) : t("common.request_failed", {p0:response.status}));
  const undoToken = response.headers.get('X-MyGantt-Undo');
  if (undoToken && data && typeof data === 'object') data._undo_token = undoToken;
  return data;
}
// All persisted chart changes enter here before any network await. The journal
// owns state.data; callers keep only view state and unsaved inspector drafts.
const chartMutations = ChartMutations.create({
  initial: state.data,
  send: requestJson,
  context: () => ({holidays:Object.keys(state.holidays || {})}),
  publish(data, event) {
    state.data = data;
    const op = event.operation;
    if (event.phase === 'optimistic') {
      const newProject = op.path === '/api/projects' || op.path === '/api/instantiate' || (op.path === '/api/duplicate' && op.fields.kind === 'project');
      const newTask = /\/projects\/[^/]+\/tasks$/.test(op.path) || (op.path === '/api/duplicate' && op.fields.kind === 'task');
      if (newProject || newTask) {
        state.filterProject = null;
        $('#search-filter').value = ''; $('#status-filter').value = 'all';
        state.selection = {type:newProject ? 'project' : 'task',id:op.tempId};
        state.inspectorOpen = state.selection.type;
      }
      if (newTask || /\/tasks\/[^/]+\/(project|placement)$/.test(op.path)) {
        const id = newTask ? op.tempId : decodeURIComponent(op.path.split('/')[3]);
        const target = data.projects.find(p=>p.tasks.some(task=>task.id===id));
        if (target) {
          state.collapsedProjects.delete(target.id); state.hiddenProjects.delete(target.id);
          if (state.filterProject) state.filterProject = target.id;
        }
      }
    }
    if (event.phase === 'confirmed' && /^\/api\/tasks\/[^/]+(?:\/[^/]+)?$/.test(op.path)) {
      externalRelationRows.delete(decodeURIComponent(op.path.split('/')[3]));
    }
    if (event.phase === 'rejected' && state.selection?.id === op.tempId) state.selection = null;
    if (state.selection) state.selection.id = chartMutations.resolveId(state.selection.id);
    if (state.filterProject) state.filterProject = chartMutations.resolveId(state.filterProject);
    document.dispatchEvent(new Event('chart-data-changed'));
  },
});
let undoBusy = false;
document.addEventListener('keydown', async event => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'z' || event.isComposing) return;
  // Native text editing keeps its own undo stack until the field loses focus.
  if (event.target.closest('input:not([type="range"]):not([type="checkbox"]),textarea,[contenteditable="true"]')) return;
  event.preventDefault();
  if (undoBusy || event.repeat) return;
  undoBusy = true;
  try {
    await templateSaveQueue;
    const undone = await chartMutations.undo();
    if (undone) {
      if (state.view === 'templates') {
        const template = state.data.templates.find(item => item.id === state.selectedTemplateId);
        state.draft = template ? normalizedTemplate(template) : null;
        renderTemplateEditor();
      }
    }
    toast(t(undone ? 'undo.completed' : 'undo.empty'));
  } catch (error) { toast(error.message); }
  finally { undoBusy = false; }
});
function api(path, options = {}) {
  if (['POST','PUT','PATCH','DELETE'].includes((options.method || 'GET').toUpperCase())) return chartMutations.mutate(path,options);
  if (path === '/api/state') return chartMutations.refresh();
  return requestJson(path,options);
}
async function loadState() {
  await api('/api/state');
  if (!state.holidayCalendars) state.holidayCalendars = (await api('/api/holiday-calendars')).calendars;
  timelineReferenceTime = new Date();
  const {start,end} = timelineCalendarRange();
  try {
    state.holidayData = await api(`/api/holidays?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&country=${encodeURIComponent(state.data.holiday_country || 'KR')}`);
  } catch (error) {
    state.holidayData = { region: state.data.holiday_country || 'KR', source_label: 'Nager.Date Community API v4', status: 'unavailable', last_updated: null, coverage_years: [], holidays: [], last_error: error.message };
  }
  if (!state.selectedTemplateId && state.data.templates.length) state.selectedTemplateId = state.data.templates[0].id;
  if (state.selectedTemplateId && !state.data.templates.some((t) => t.id === state.selectedTemplateId)) state.selectedTemplateId = state.data.templates[0]?.id || null;
  state.holidays = Object.fromEntries((state.holidayData?.holidays || []).map((holiday) => [holiday.date, holiday.name]));
  if (!state.data.projects.some((project) => project.id === state.selection?.id || project.tasks.some((task) => task.id === state.selection?.id))) state.selection = null;
  renderAll();
}
function persistUi() {
  localStorage.setItem('mygantt-ui', JSON.stringify({ zoom: state.zoom, templateZoom: state.templateZoom, selection: state.selection, inspectorOpen: state.inspectorOpen, collapsedProjects: [...state.collapsedProjects], hiddenProjects: [...(state.hiddenProjects || [])], cascadeDependents: state.cascadeDependents }));
}
function setCascadeSetting(value) {
  state.cascadeDependents = Boolean(value);
  persistUi();
  $$('[data-cascade-dependents]').forEach((input) => { input.checked = state.cascadeDependents; });
}
function selectItem(type, id) {
  const closeMobile = mobileLayout() && document.body.classList.contains('inspector-open') && state.selection?.type === type && state.selection?.id === id;
  const collapseProject = type === 'project' && state.selection?.type === 'project' && state.selection.id === id && state.inspectorOpen === 'project';
  state.selection = id ? { type, id } : null;
  state.inspectorOpen = collapseProject ? '' : type === 'task' ? 'task' : 'project';
  persistUi();
  renderTimeline();
  if (mobileLayout()) setMobileDrawer(closeMobile ? null : 'inspector');
}
function switchView(view) {
  setMobileDrawer(null);
  state.view = view;
  state.filterProject = null;
  $('#timeline-view').classList.toggle('hidden', view !== 'timeline');
  $('#templates-view').classList.toggle('hidden', view !== 'templates');
  $('#settings-view').classList.toggle('hidden', view !== 'settings');
  $$('.nav-item').forEach((item) => item.classList.toggle('active', item.dataset.view === view));
  $('#new-project').classList.toggle('hidden', view !== 'timeline');
  $('#import-project-template').classList.toggle('hidden', view !== 'templates');
  $('#breadcrumb-title').textContent = { timeline: t("navigation.all_schedules"), templates: t("navigation.schedule_templates"), settings: t("navigation.settings") }[view];
  $('#page-description').textContent = { timeline: t("navigation.view_each_project_s_daily_schedule"), templates: t("navigation.define_a_workflow_once_and_apply"), settings: t("navigation.view_the_app_version_and_public") }[view];
  renderAll();
}
function renderAll() {
  renderStorageLocation();
  renderSidebar();
  if (state.view === 'timeline') renderTimeline();
  else if (state.view === 'templates') renderTemplates();
  else renderSettings();
}
function renderStorageLocation() {
  const storage = state.data.storage;
  const label = storage?.label || t("navigation.storage_location_unavailable");
  const detail = storage?.database_path ? `${label}\nSQLite: ${storage.database_path}` : label;
  $('#storage-location-name').textContent = label;
  $('#storage-indicator-name').textContent = label;
  $('#storage-location').title = detail;
  $('#storage-indicator').title = detail;
}
function renderSidebar() {
  $('#sidebar-project-section').classList.toggle('hidden', state.view !== 'timeline');
  $('#sidebar-template-section').classList.toggle('hidden', state.view !== 'templates');
  $('#project-count').textContent = state.data.projects.filter(project => !project.is_unassigned).length;
  $('#sidebar-projects').innerHTML = filteredProjects({forSidebar:true}).map((project) => `
    <div class="side-project-swipe" data-swipe-project="${esc(project.id)}"><div class="side-project-row"><button class="side-project ${state.selection?.type === 'project' && state.selection.id === project.id ? 'selected' : ''}" data-project="${esc(project.id)}" title="${esc(project.is_unassigned ? t("inspector.no_project") : project.name)}">
      <i style="background:${colorPalette(project.color).base}"></i><span>${esc(project.is_unassigned ? t("inspector.no_project") : project.name)}</span>
    </button><button type="button" class="project-visibility" data-visibility-project="${esc(project.id)}" aria-pressed="${!state.hiddenProjects.has(project.id)}" aria-label="${esc(t(state.hiddenProjects.has(project.id) ? "project.show" : "project.hide", {p0:project.is_unassigned ? t("inspector.no_project") : project.name}))}" title="${esc(t(state.hiddenProjects.has(project.id) ? "project.show" : "project.hide", {p0:project.is_unassigned ? t("inspector.no_project") : project.name}))}"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>${state.hiddenProjects.has(project.id) ? '<path d="M3 3 21 21"/>' : ''}</svg></button><span class="side-progress">${project.progress}%</span></div>${project.is_unassigned ? '' : `<button type="button" class="side-project-delete" tabindex="-1" aria-hidden="true" aria-label="${esc(project.name)} ${t("project.delete")}">${t("template.delete")}</button>`}</div>`).join('');
  bindSidebarProjectSwipe();
  $$('.project-visibility').forEach(button => button.addEventListener('click', () => {
    const id = button.dataset.visibilityProject;
    if (state.hiddenProjects.has(id)) state.hiddenProjects.delete(id);
    else state.hiddenProjects.add(id);
    persistUi();
    renderSidebar();
    renderTimeline({preserveInspector:true});
  }));
  $$('.side-project').forEach((button) => button.addEventListener('click', () => {
    const projectId = button.dataset.project;
    if (state.hiddenProjects.delete(projectId)) persistUi();
    state.filterProject = projectId;
    switchView('timeline');
    selectItem('project', projectId);
  }));
}
function bindSidebarProjectSwipe() {
  const shells = $$('.side-project-swipe');
  const setOpen = (shell, open) => {
    shell.classList.toggle('swipe-open',open);
    shell.style.removeProperty('--swipe-offset');
    const button=$('.side-project-delete',shell);
    if (button) { button.tabIndex=open?0:-1; button.setAttribute('aria-hidden',String(!open)); }
  };
  for (const shell of shells) {
    const remove=$('.side-project-delete',shell);
    if (!remove) continue;
    let drag=null, suppressClick=false;
    shell.addEventListener('pointerdown',event=>{
      suppressClick=false;
      if (event.button!==0 || !event.isPrimary || event.target.closest('.side-project-delete')) return;
      drag={id:event.pointerId,x:event.clientX,y:event.clientY,open:shell.classList.contains('swipe-open'),horizontal:false,offset:0};
    });
    shell.addEventListener('pointermove',event=>{
      if (!drag || event.pointerId!==drag.id) return;
      const dx=event.clientX-drag.x,dy=event.clientY-drag.y;
      if (!drag.horizontal) {
        if (Math.abs(dy)>8 && Math.abs(dy)>Math.abs(dx)) {drag=null;return;}
        if (Math.abs(dx)<8 || Math.abs(dx)<=Math.abs(dy)) return;
        drag.horizontal=true; suppressClick=true;
        shells.forEach(other=>{if(other!==shell)setOpen(other,false);});
        shell.setPointerCapture(event.pointerId);
        shell.classList.add('swipe-dragging');
      }
      event.preventDefault();
      drag.offset=Math.max(-64,Math.min(0,(drag.open?-64:0)+dx));
      shell.style.setProperty('--swipe-offset',`${drag.offset}px`);
    });
    const finish=(event,cancelled=false)=>{
      if (!drag || event.pointerId!==drag.id) return;
      const current=drag;drag=null;shell.classList.remove('swipe-dragging');
      if(current.horizontal)setOpen(shell,cancelled?current.open:current.offset<=-24);
    };
    shell.addEventListener('pointerup',event=>finish(event));
    shell.addEventListener('pointercancel',event=>finish(event,true));
    shell.addEventListener('click',event=>{
      if(suppressClick){event.preventDefault();event.stopImmediatePropagation();suppressClick=false;return;}
      if(shell.classList.contains('swipe-open')&&!event.target.closest('.side-project-delete')){setOpen(shell,false);event.preventDefault();event.stopImmediatePropagation();}
    },true);
    shell.addEventListener('keydown',event=>{
      if(event.key==='ArrowLeft'){event.preventDefault();shells.forEach(other=>setOpen(other,other===shell));remove.focus();}
      if(event.key==='Escape'||event.key==='ArrowRight'){setOpen(shell,false);$('.side-project',shell)?.focus();}
    });
    let wheelOffset=0;
    shell.addEventListener('wheel',event=>{
      if(Math.abs(event.deltaX)<=Math.abs(event.deltaY))return;
      event.preventDefault();wheelOffset+=event.deltaX;
      if(wheelOffset>24){shells.forEach(other=>setOpen(other,other===shell));wheelOffset=0;}
      else if(wheelOffset < -24){setOpen(shell,false);wheelOffset=0;}
    },{passive:false});
    remove.addEventListener('click',()=>{
      const project=state.data.projects.find(item=>item.id===shell.dataset.swipeProject);
      if(project)deleteInspectorItem('projects',project.id,project.name);
    });
  }
}
function filteredProjects({forSidebar=false} = {}) {
  let projects = state.data.projects.filter(project => forSidebar || !state.hiddenProjects?.has(project.id));
  if (!forSidebar && state.filterProject) projects = projects.filter((project) => project.id === state.filterProject);
  const query = forSidebar ? '' : ($('#search-filter')?.value || '').trim().toLocaleLowerCase();
  const status = forSidebar ? 'all' : ($('#status-filter')?.value || 'all');
  projects = projects.map((project) => ({
    ...project,
    tasks: project.tasks.filter((task) => {
      const projectMatch = !query || [project.name, project.group_name, ...(project.tags || [])].some((value) => String(value || '').toLocaleLowerCase().includes(query));
      const taskMatch = !query || [task.name, task.owner, task.handoff, task.blocker, task.group_name, ...(task.tags || [])].some((value) => String(value || '').toLocaleLowerCase().includes(query));
      return (projectMatch || taskMatch) && (status === 'all' || task.status === status);
    }),
  })).filter((project) => project.tasks.length || (!project.is_unassigned && status === 'all' && !state.data.projects.find(item => item.id === project.id)?.tasks.length && (!query || [project.name, project.group_name, ...(project.tags || [])].some(value => String(value || '').toLocaleLowerCase().includes(query)))));
  const sort = $('#sort-select')?.value || 'manual';
  projects.forEach(project => project.tasks.sort((a,b) => sort === 'name' ? a.name.localeCompare(b.name,I18n.locale) : sort === 'progress' ? taskProgress(b)-taskProgress(a) : sort === 'start' ? a.planned_start.localeCompare(b.planned_start) : (a.sort_order || 0)-(b.sort_order || 0)));
  if (sort === 'manual') projects.sort((a,b) => (a.sort_order || 0)-(b.sort_order || 0));
  if (sort !== 'manual') projects.sort((a, b) => sort === 'name' ? a.name.localeCompare(b.name, I18n.locale) : sort === 'progress' ? b.progress - a.progress : (a.tasks[0]?.planned_start || a.start_date).localeCompare(b.tasks[0]?.planned_start || b.start_date));
  return projects;
}
function flatten(projects) { return projects.flatMap((project) => project.tasks.map((task) => ({ ...task, projectName: project.name, projectId: project.id }))); }
const weekdayIDs = ["weekday.sun", "calendar.mon", "calendar.tue", "calendar.wed", "calendar.thu", "calendar.fri", "calendar.sat"];
function dateColumns(start, days, perDay) {
  const first = dateFrom(start);
  return Array.from({ length: days }, (_, index) => {
    const current = new Date(first);
    current.setDate(first.getDate() + index);
    const key = dateKey(current);
    const holiday = (state.holidayData?.region || 'KR') === 'KR' ? I18n.systemText(state.holidays[key], 'holiday.') : state.holidays[key];
    const isWeekend = current.getDay() === 0 || current.getDay() === 6;
    const today = key === clockParts(timelineReferenceTime).date;
    const dateText = current.getDate() === 1 || index === 0 ? `${current.getMonth() + 1}.${current.getDate()}` : String(current.getDate());
    return { key, holiday, isWeekend, saturday: current.getDay() === 6, sunday: current.getDay() === 0, today, dateText, weekday: t(weekdayIDs[current.getDay()]), x: index * perDay };
  });
}
function renderHolidayStatus() {
  const node = $('#holiday-settings');
  if (!node) return;
  const holidayData = state.holidayData || {};
  const source = (holidayData.source_label || holidayData.source || 'Nager.Date Community API v4').split(' + ').map(part => I18n.systemText(part,'source.')).join(' + ');
  const countrySelect = $('#holiday-country-select');
  for (const calendar of state.holidayCalendars || []) {
    const option = countrySelect?.querySelector(`option[value="${calendar.country}"]`);
    if (option) option.textContent = `${t(calendar.textID)} — ${(holidayData.region || state.data.holiday_country || 'KR') === calendar.country ? source : 'Nager.Date Community API v4'}`;
  }
  const updated = holidayData.last_updated ? holidayData.last_updated.slice(0, 10) : t("calendar.no_update_recorded");
  const years = holidayData.coverage_years || [];
  const unverifiedSubstituteYears = (holidayData.region || 'KR') === 'KR' ? (holidayData.requested_years || years).filter((year) => Number(year) !== 2026) : [];
  const coverage = years.length ? years.join(', ') : t("calendar.no_data_supported", {p0:holidayData.supported_years?.from || t("calendar.current"),p1:holidayData.supported_years?.through || t("calendar.current_5_years")});
  const freshness = holidayData.status === 'fresh' ? t("calendar.up_to_date") : holidayData.status === 'stale' ? (holidayData.last_error ? t("calendar.update_failed_showing_saved_data") : t("calendar.showing_saved_data")) : t("calendar.no_data");
  node.innerHTML = `<dl class="settings-details"><div><dt>${t("calendar.last_updated")}</dt><dd>${esc(updated)}</dd></div><div><dt>${t("calendar.coverage")}</dt><dd>${esc(coverage)}</dd></div><div><dt>${t("calendar.status")}</dt><dd><span class="holiday-freshness">${esc(freshness)}</span></dd></div></dl>`;
  node.dataset.status = holidayData.status || 'unavailable';
  node.dataset.substituteWarning = String(unverifiedSubstituteYears.length > 0);
  const warnings = [];
  if (unverifiedSubstituteYears.length) warnings.push(t("calendar.years_other_than_2026_use_nager", {p0:unverifiedSubstituteYears.join(', ')}));
  if (holidayData.last_error) warnings.push(I18n.serverError({error:holidayData.last_error}));
  if (holidayData.unsupported_years?.length) warnings.push(t("calendar.outside_automatic_coverage", {p0:holidayData.unsupported_years.join(', ')}));
  if (warnings.length) node.insertAdjacentHTML('beforeend', `<p class="settings-warning">${warnings.map(esc).join('<br>')}</p>`);
}
function renderSettings() {
  $('#app-version').textContent = state.appVersion || t("calendar.version_unavailable");
  const select = $('#holiday-country-select');
  const groups = new Map();
  for (const calendar of state.holidayCalendars || []) {
    if (!groups.has(calendar.group)) groups.set(calendar.group, []);
    groups.get(calendar.group).push(calendar);
  }
  select.innerHTML = [...groups].map(([group, calendars]) => `<optgroup label="${esc(t('calendar.group.'+group))}">${calendars.map(calendar => `<option value="${esc(calendar.country)}">${esc(t(calendar.textID))}</option>`).join('')}</optgroup>`).join('');
  select.value = state.data.holiday_country || 'KR';
  renderHolidayStatus();
  renderTimeZoneSettings();
}
// Calendar range is independent of project dates, including an empty workspace.
function renderTimeZoneSettings() {
  const select=$('#timezone-select');
  if(!select)return;
  const server=state.data.server_clock || {};
  const offset=Number(server.offset_minutes)||0;
  const name=server.time_zone || `UTC${offset<0?'-':'+'}${String(Math.floor(Math.abs(offset)/60)).padStart(2,'0')}:${String(Math.abs(offset)%60).padStart(2,'0')}`;
  select.innerHTML=`<option value="">${esc(t('settings.server_timezone'))} (${esc(name)})</option>`+MyGanttTime.zones([server.time_zone,selectedTimeZone]).map(zone=>`<option value="${esc(zone)}">${esc(zone.replaceAll('_',' '))}</option>`).join('');
  select.value=MyGanttTime.valid(selectedTimeZone)?selectedTimeZone:'';
  select.onchange=async()=>{
    selectedTimeZone=select.value;
    try { localStorage.setItem('mygantt-timezone',selectedTimeZone); } catch {}
    state.calendarRange=null;state.calendarPositioned=false;
    try { await loadState(); } catch(error) { toast(error.message); }
  };
}
function calendarMonthOffset(value, months) {
  const date = dateFrom(value), day = date.getDate();
  date.setDate(1); date.setMonth(date.getMonth() + months);
  const last = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, last));
  return dateKey(date);
}
function timelineCalendarRange() {
  const today = clockParts(timelineReferenceTime).date;
  if (!state.calendarRange) state.calendarRange = {start:calendarMonthOffset(today,-2),end:calendarMonthOffset(today,3)};
  return state.calendarRange;
}
function calendarHeaderMarkup(dates, pxPerDay) {
  return dates.map((item) => `<div class="date-header ${item.saturday ? 'saturday' : ''} ${item.sunday ? 'sunday' : ''} ${item.holiday ? 'holiday' : ''} ${item.today ? 'today' : ''}" style="width:${pxPerDay}px" title="${item.key}${item.holiday ? ` · ${esc(item.holiday)}` : ''}"><b>${esc(item.dateText)}</b><small>${item.weekday}</small>${item.holiday ? `<i>${esc(item.holiday)}</i>` : ''}</div>`).join('');
}
function calendarShadingMarkup(dates, pxPerDay) {
  return dates.map((item) => `<div class="date-shade ${item.isWeekend ? 'weekend-shade' : ''} ${item.saturday ? 'weekend-saturday' : ''} ${item.sunday ? 'weekend-sunday' : ''} ${item.holiday ? 'holiday-shade' : ''}" style="left:${item.x}px;width:${pxPerDay}px" title="${item.key}${item.holiday ? ` · ${esc(item.holiday)}` : item.isWeekend ? t("timeline.weekend") : ''}"></div>`).join('');
}
function extendTimelineCalendar(oldStart, oldEnd) {
  const chart = $('#gantt'), range = timelineCalendarRange(), px = state.zoom;
  const prepend = dayDiff(range.start,oldStart), append = dayDiff(oldEnd,range.end);
  const width = (dayDiff(range.start,range.end)+1)*px, shift = prepend*px;
  const addedStart = prepend ? range.start : (() => { const d=dateFrom(oldEnd); d.setDate(d.getDate()+1); return dateKey(d); })();
  const added = dateColumns(addedStart,prepend || append,px).map(day => ({...day,x:dayDiff(range.start,day.key)*px}));
  if (shift) {
    $$('.task-bar,.actual-task-bar,.project-summary-bar,.project-duration-band,.date-shade,.today-line',chart).forEach(node => {
      node.style.left = `${parseFloat(node.style.left)+shift}px`;
    });
  }
  $$('.gantt-right',chart).forEach(node => { node.style.width=`${width}px`; });
  const label = parseFloat(chart.style.getPropertyValue('--label-width'));
  $('.gantt-body',chart).style.width=`${width+label}px`;
  $('.date-axis',chart).insertAdjacentHTML(prepend?'afterbegin':'beforeend',calendarHeaderMarkup(added,px));
  $$('.row-date-shading',chart).forEach(node => node.insertAdjacentHTML('beforeend',calendarShadingMarkup(added,px)));
  chart.dataset.todayOffset=dayDiff(range.start,clockParts(timelineReferenceTime).date);
  $('#range-label').textContent=dateRangeLabel(range.start,range.end);
  updateCurrentTimeMarker();
  renderDependencyLinks();
}
function bindTimelineCalendarScroll() {
  const wrap = $('#gantt-wrap');
  let previous = wrap.scrollLeft;
  wrap.onscroll = () => {
    const left = wrap.scrollLeft, direction = Math.sign(left-previous);
    previous = left;
    if (!direction || state.drag || state.layout !== 'gantt') return;
    if (!(direction < 0 && left < 360) && !(direction > 0 && left + wrap.clientWidth > wrap.scrollWidth - 180)) return;
    const range = timelineCalendarRange(), top = wrap.scrollTop, oldStart = range.start, oldEnd = range.end;
    if (direction < 0) range.start = calendarMonthOffset(range.start,-1);
    else range.end = calendarMonthOffset(range.end,1);
    extendTimelineCalendar(oldStart,oldEnd);
    wrap.scrollLeft = left + dayDiff(range.start,oldStart)*state.zoom;
    wrap.scrollTop = top;
    bindTimelineCalendarScroll();
    refreshCalendarHolidays();
  };
}
let calendarHolidayRequest = 0;
async function refreshCalendarHolidays() {
  const request = ++calendarHolidayRequest, range = {...timelineCalendarRange()};
  const country = state.data.holiday_country || 'KR';
  try {
    const data = await api(`/api/holidays?start=${range.start}&end=${range.end}&country=${encodeURIComponent(country)}`);
    if (request !== calendarHolidayRequest || country !== (state.data.holiday_country || 'KR')) return;
    state.holidayData = data;
    state.holidays = Object.fromEntries((data.holidays || []).map(h => [h.date,h.name]));
    if (state.drag) return;
    renderTimeline({preserveInspector:true});
  } catch (error) { toast(error.message); }
}
function projectBounds(projects) {
  const tasks = flatten(projects);
  const emptyDates = projects.filter(project => !project.tasks.length).map(project => project.start_date).filter(Boolean);
  const starts = [...emptyDates, ...tasks.flatMap((task) => [task.planned_start, task.actual_start, task.actual_finish])].filter(Boolean).sort();
  const ends = [...emptyDates, ...tasks.flatMap((task) => [task.planned_finish, task.actual_start, task.actual_finish])].filter(Boolean).sort();
  if (!starts.length) return { start: todayInput(), end: todayInput() };
  return { start: starts[0], end: ends[ends.length - 1] };
}
// Open ends join the planned tier visually; inferred bounds are never saved.
function actualTaskRange(task) {
  if (!task.actual_start && !task.actual_finish) return null;
  return {
    start: task.actual_start || [task.planned_start, task.actual_finish].filter(Boolean).sort()[0],
    finish: task.actual_finish || [task.planned_finish, task.actual_start].filter(Boolean).sort().at(-1),
    openSide: !task.actual_start ? "left" : !task.actual_finish ? "right" : null,
    partial: !task.actual_start || !task.actual_finish,
    label: t("timeline.actual"),
  };
}
function actualOpenStyle(range, width) {
  if (!range?.openSide) return '';
  const c = Math.min(96, width * .65), h = 20;
  const path = range.openSide === 'right'
    ? `M 0 0 H ${width} C ${width-c*.45} 0 ${width-c*.55} ${h} ${width-c} ${h} H 0 Z`
    : `M 0 0 H ${width} V ${h} H ${c} C ${c*.55} ${h} ${c*.45} 0 0 0 Z`;
  return `--actual-open-side:${range.openSide};clip-path:path('${path}');`;
}
function taskRowHeight(task) { return actualTaskRange(task) ? 54 : 36; }
// A filled neck grows from the predecessor's facing edge into the successor.
// End faces meet square edges; surface joins tuck under the bar's solid fill.
function dependencyRibbon(from, to, outline = {}) {
  const gap = from.kind === 'gap';
  const sx = gap ? from.x : from.surfaceX, tx = gap ? to.x : to.surfaceX;
  const sy = gap ? from.centerY : from.y, ty = gap ? to.centerY : to.y;
  const dx=tx-sx, dy=ty-sy;
  const sh=(gap ? from.height : from.width)/2, th=(gap ? to.height : to.width)/2;
  const baseNeck=Math.min(2,sh*.25,th*.25);
  // Axis-aligned ribbon widths look hairline-thin when nearly parallel to
  // their chord. Raise only waists projecting below 3px onto its normal.
  const tangentY=dy*(gap?1.25:1);
  const projection=Math.abs(gap?dx:dy)/Math.max(1,Math.hypot(dx,tangentY));
  const midWeight=gap ? .109375 : .03125;
  const requiredNeck=(1.5/Math.max(.05,projection)-(sh+th)*midWeight)/(1-2*midWeight);
  const neck=Math.max(baseNeck,Math.min(sh*.85,th*.85,requiredNeck));
  // The endpoint chord is the reference everywhere. Endpoint influence decays
  // smoothly toward it; there is no waist anchor or straight middle segment.
  const weight=t=>gap ? (1-t)**5*(1+5*t) : (1-t)**5;
  const weightDerivative=t=>gap ? -30*t*(1-t)**4 : -5*(1-t)**4;
  function point(t, sign) {
    const u=1-t;
    const bias=t*u**5-u*t**5;
    const biasDerivative=u**5-5*t*u**4+t**5-5*u*t**4;
    const width=neck+(sh-neck)*weight(t)+(th-neck)*weight(u);
    const widthDerivative=(sh-neck)*weightDerivative(t)-(th-neck)*weightDerivative(u);
    // Surface joins flare in opposite directions along the bar face. A shared
    // horizontal tangent would make one edge curl back into the attachment.
    return {x:sx+dx*(gap?t:t-bias)+(gap?0:sign*width), y:sy+dy*(t-bias)+(gap?sign*width:0),
      vx:dx*(gap?1:1-biasDerivative)+(gap?0:sign*widthDerivative), vy:dy*(1-biasDerivative)+(gap?sign*widthDerivative:0)};
  }
  function edge(sign, reverse=false) {
    // Uniform Hermite conversion only approximates the analytic curve for SVG;
    // none of these samples controls the shape or fixes a midpoint.
    const steps=16, dt=(reverse?-1:1)/steps;
    let path='';
    for(let i=0;i<steps;i++) {
      const a=point(reverse?1-i/steps:i/steps,sign), b=point(reverse?1-(i+1)/steps:(i+1)/steps,sign);
      path+=` C ${a.x+a.vx*dt/3} ${a.y+a.vy*dt/3} ${b.x-b.vx*dt/3} ${b.y-b.vy*dt/3} ${b.x} ${b.y}`;
    }
    return path;
  }
  return `M ${sx-(gap?0:sh)} ${sy-(gap?sh:0)} ${edge(-1)}
    ${outline.target || `L ${tx+(gap?0:th)} ${ty+(gap?th:0)}`}
    ${edge(1,true)} ${outline.source || ''} Z`;
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
  if (drag.edge === 'move') {
    // Translate recorded dates only; a partial actual range stays partial.
    const start = drag.originalStart ? shiftIsoDate(drag.originalStart, delta) : '';
    const finish = drag.originalFinish ? shiftIsoDate(drag.originalFinish, delta) : '';
    const fields = {};
    if (start) fields[`${drag.period}_start`] = start;
    if (finish) fields[`${drag.period}_finish`] = finish;
    return { fields, start: start || finish, finish: finish || start, valid: !start || !finish || start <= finish };
  }
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
  const openSide = style.getPropertyValue?.('--actual-open-side').trim();
  const curve = Math.min(96, w * .65);
  const faces = [
    { start: [x + tl, y], end: [x + w - tr, y], radius: tr },
    { start: [x + w, y + tr], end: [x + w, y + h - br], radius: br },
    { start: [x + w - br, y + h], end: [x + bl, y + h], radius: bl },
    { start: [x, y + h - bl], end: [x, y + tl], radius: tl },
  ];
  if (openSide === 'left') {
    faces[0].start = [x, y]; faces[2].end = [x + curve, y + h];
    faces[3].start = faces[3].end = [x, y];
  } else if (openSide === 'right') {
    faces[0].end = [x + w, y]; faces[1].start = faces[1].end = [x + w, y];
    faces[2].start = [x + w - curve, y + h];
  }
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
    const corner = direction === 1 ? i : next;
    if (openSide === 'left' && corner === 2 || openSide === 'right' && corner === 1) {
      const controls = openSide === 'left'
        ? [[x + curve*.55, y+h], [x + curve*.45, y]]
        : [[x+w-curve*.45, y], [x+w-curve*.55, y+h]];
      if (direction === -1) controls.reverse();
      path += ` L ${cornerStart.join(' ')} C ${controls[0].join(' ')} ${controls[1].join(' ')} ${cornerEnd.join(' ')}`;
    } else path += ` L ${cornerStart.join(' ')} A ${r} ${r} 0 0 ${sweep} ${cornerEnd.join(' ')}`;
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
// Incoming attachments fill in the first tenth; outgoing attachments in the last.
// Both use the same direction-aware fill rule as the connection gradients. Ports use bar-local coordinates, so zoom/drag can recompute them.
function attachmentProgress(progress, connected = true) {
  const value = Math.max(0, Math.min(100, Number(progress) || 0));
  return { front: Math.min(1, value / (connected ? 90 : 100)), release: connectionFill(value, 'outgoing') };
}
function outgoingConnectionColor(task) { return connectionColor(task, 'outgoing'); }
function attachmentProgressMask(width, height, progress, ports) {
  const {front, release} = attachmentProgress(progress, ports.some(p => p.direction !== 'incoming'));
  const holes = ports.map(port => {
    const side = port.side;
    const cx = port.cx ?? (side === 'right' ? width : side === 'left' ? 0 : port.x);
    const cy = port.cy ?? (side === 'top' ? 0 : side === 'bottom' ? height : height/2);
    const portHeight = port.height ?? height, portWidth = port.barWidth ?? width;
    const rx = ['left','right'].includes(side) ? Math.min(portWidth*.55, portHeight*1.5) : Math.max(1, port.width*.72 + portHeight*.35);
    const ry = ['left','right'].includes(side) ? portHeight*1.3 : portHeight*.9;
    return {cx,cy,rx,ry,direction:port.direction || 'outgoing'};
  });
  // Opaque black plateaus protect the entire contact span, with a soft,
  // curved transition farther inside the bar. All outgoing ports are combined.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs>
    <linearGradient id="front"><stop offset="0" stop-color="white"/><stop offset="${Math.max(0,front-3/width)}" stop-color="white"/><stop offset="${front}" stop-color="black"/><stop offset="1" stop-color="black"/></linearGradient>
    <radialGradient id="port"><stop offset="0.7" stop-color="black"/><stop offset="1" stop-color="black" stop-opacity="0"/></radialGradient>
    <radialGradient id="incoming"><stop offset="0.7" stop-color="white"/><stop offset="1" stop-color="white" stop-opacity="0"/></radialGradient>
    <mask id="fill" maskUnits="userSpaceOnUse" x="0" y="0" width="${width}" height="${height}" style="mask-type:luminance">
    <rect width="${width}" height="${height}" fill="${front===1?'white':front===0?'black':'url(#front)'}"/>
    <g opacity="${1-release}">${holes.filter(h=>h.direction==='outgoing').map(h=>`<ellipse cx="${h.cx}" cy="${h.cy}" rx="${h.rx}" ry="${h.ry}" fill="url(#port)"/>`).join('')}</g>
    <g opacity="${connectionFill(progress, 'incoming')}">${holes.filter(h=>h.direction==='incoming').map(h=>`<ellipse cx="${h.cx}" cy="${h.cy}" rx="${h.rx}" ry="${h.ry}" fill="url(#incoming)"/>`).join('')}</g>
    </mask></defs><rect width="${width}" height="${height}" fill="white" mask="url(#fill)"/></svg>`;
}

// A stacked task is painted once; its two HTML buttons only provide labels and handles.
function unifiedTaskShape(planned, actual, openSide = '', plannedRadii = [4,4,4,4], actualRadii = [4,4,4,4]) {
  // Independently positioned HTML tiers can differ by a subpixel after zoom.
  // Snap shared boundaries before merging vertices; otherwise the tiny edge
  // caps the corner radius at nearly zero (notably the open-right finish).
  const shared = (a,b) => Math.abs(a-b) < 1 ? b : a;
  actual = {...actual, left:shared(actual.left,planned.left), right:shared(actual.right,planned.right), top:shared(actual.top,planned.bottom)};
  actual.width = actual.right-actual.left;

  const left = Math.min(planned.left, actual.left), right = Math.max(planned.right, actual.right);
  const top = planned.top, bottom = actual.bottom, join = actual.top;
  const curve = Math.min(96, actual.width * .65);
  const vertex = (x,y,r=0,controls=null) => ({x,y,r,controls});
  const [ptl,ptr,pbr,pbl] = plannedRadii, [atl,atr,abr,abl] = actualRadii;
  const upper = [vertex(planned.left,top,ptl),vertex(planned.right,top,ptr),vertex(planned.right,planned.bottom,pbr),vertex(planned.left,planned.bottom,pbl)];
  const lower = [vertex(actual.left,join,openSide==='left'?(actual.left===planned.left?pbl:0):atl),vertex(actual.right,join,openSide==='right'?(actual.right===planned.right?pbr:0):atr),
    openSide==='right' ? vertex(actual.right-curve,bottom,0,[[actual.right-curve*.45,join],[actual.right-curve*.55,bottom]]) : vertex(actual.right,bottom,abr),
    vertex(openSide==='left'?actual.left+curve:actual.left,bottom,openSide==='left'?0:abl)];
  if (openSide==='left') lower[0].controls=[[actual.left+curve*.55,bottom],[actual.left+curve*.45,join]];
  function contour(vertices) {
    // Collapse coincident attachment corners before computing short-edge radii.
    const points=[];
    for (const v of vertices) {
      const previous=points.at(-1);
      if (previous && previous.x===v.x && previous.y===v.y && !v.controls) previous.r=previous.controls ? Math.max(previous.r,v.r) : Math.min(previous.r,v.r);
      else points.push({...v});
    }
    const corners=points.map((v,i)=>{
      const prev=points[(i+points.length-1)%points.length], next=points[(i+1)%points.length];
      const tangent=v.controls ? {x:v.controls[1][0],y:v.controls[1][1]} : prev;
      // Curve joins use their endpoint tangents, not the diagonal endpoint
      // chord. Only attached end faces (zero CSS radii) remain square.
      const outgoingTangent=next.controls ? {x:next.controls[0][0],y:next.controls[0][1]} : next;
      const incoming=Math.hypot(v.x-tangent.x,v.y-tangent.y), outgoing=Math.hypot(outgoingTangent.x-v.x,outgoingTangent.y-v.y);
      const cross=(v.x-tangent.x)*(outgoingTangent.y-v.y)-(v.y-tangent.y)*(outgoingTangent.x-v.x);
      const r=!cross ? 0 : Math.min(v.r,incoming/2,outgoing/2);
      return {v,r,entry:[v.x+(tangent.x-v.x)*(r/(incoming||1)),v.y+(tangent.y-v.y)*(r/(incoming||1))],exit:[v.x+(outgoingTangent.x-v.x)*(r/(outgoing||1)),v.y+(outgoingTangent.y-v.y)*(r/(outgoing||1))]};
    });
    let path=`M ${corners[0].exit.join(' ')}`;
    for(let step=1;step<=corners.length;step++) {
      const {v,r,entry,exit}=corners[step%corners.length];
      path+=v.controls ? ` C ${v.controls[0].join(' ')} ${v.controls[1].join(' ')} ${entry.join(' ')}` : ` L ${entry.join(' ')}`;
      if(r) path+=` Q ${v.x} ${v.y} ${exit.join(' ')}`;
    }
    return path+' Z';
  }
  const touching = actual.left < planned.right && actual.right > planned.left && Math.abs(planned.bottom-join) < 1;
  // A single rounded exterior, including reentrant Z/S corners. Disjoint dates stay disjoint.
  const path=touching ? contour([...upper.slice(0,3),...lower.slice(1),lower[0],upper[3]]) : contour(upper)+' '+contour(lower);
  return {path, left, right, top, bottom};
}
function unifiedTaskBarShape(plannedBar, actualBar, origin) {
  const relative = bar => {
    const r=bar.getBoundingClientRect();
    return {left:r.left-origin.left,right:r.right-origin.left,top:r.top-origin.top,bottom:r.bottom-origin.top,width:r.width};
  };
  const openSide = actualBar.classList.contains('open-left') ? 'left' : actualBar.classList.contains('open-right') ? 'right' : '';
  // Read the same computed radii as dependencyBarOutline, after connection
  // classes have disabled the corners on attached left/right faces.
  const radii = bar => {
    const style=getComputedStyle(bar);
    return [style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomRightRadius,style.borderBottomLeftRadius].map(value=>parseFloat(value)||0);
  };
  return unifiedTaskShape(relative(plannedBar), relative(actualBar), openSide, radii(plannedBar), radii(actualBar));
}
function taskBarShape(plannedBar, actualBar, origin) {
  if (actualBar) return unifiedTaskBarShape(plannedBar, actualBar, origin);
  const rect = plannedBar.getBoundingClientRect(), style = getComputedStyle(plannedBar);
  const start = [rect.left-origin.left+Math.min(parseFloat(style.borderTopLeftRadius)||0,rect.width/2,rect.height/2),rect.top-origin.top];
  return {path:`M ${start.join(' ')}${dependencyBarOutline(rect,style,origin,0,start,start)} Z`, left:rect.left-origin.left, right:rect.right-origin.left, top:rect.top-origin.top, bottom:rect.bottom-origin.top};
}
function unifiedTaskPaint(task, plannedBar, actualBar, origin, index, attachmentPorts = new Map(), shape = unifiedTaskBarShape(plannedBar, actualBar, origin)) {
  const palette = colorPalette(task.color), progress = Math.max(0,Math.min(100,taskProgress(task)));
  const id = `unified-task-progress-${index}`;
  const ports = [plannedBar,actualBar].flatMap(bar => {
    const rect=bar.getBoundingClientRect(), x=rect.left-origin.left-shape.left, y=rect.top-origin.top-shape.top;
    return (attachmentPorts.get(bar)?.ports || []).map(port=>({...port,
      cx:x+(port.side==='right'?rect.width:port.side==='left'?0:port.x),
      cy:y+(port.side==='top'?0:port.side==='bottom'?rect.height:rect.height/2),
      height:rect.height,barWidth:rect.width}));
  });
  const width=shape.right-shape.left,height=shape.bottom-shape.top;
  const maskMarkup=attachmentProgressMask(width,height,progress,ports)
    .replace('<svg ', `<svg x="${shape.left}" y="${shape.top}" `)
    .replace(/id="([^"]+)"/g, (_, name) => `id="${id}-${name}"`)
    .replace(/url\(#([^)]*)\)/g, (_, name) => `url(#${id}-${name})`);
  plannedBar.classList.add('unified-task-backed'); actualBar.classList.add('unified-task-backed');
  // Paint grips in the same SVG as the fill. HTML spans remain transparent hit targets.
  const grips = [[plannedBar, true, true], [actualBar, Boolean(task.actual_start), Boolean(task.actual_finish)]]
    .flatMap(([bar, start, end]) => {
      const rect = bar.getBoundingClientRect();
      const r = {left:rect.left-origin.left,right:rect.right-origin.left,top:rect.top-origin.top,bottom:rect.bottom-origin.top};
      return [[start, r.left + 2], [end, r.right - 4]].filter(([visible]) => visible)
        .map(([, x]) => `<line class="unified-task-grip" x1="${x+1}" x2="${x+1}" y1="${r.top+6}" y2="${r.bottom-6}" stroke="${palette.ink}" stroke-width="2" stroke-linecap="round" opacity=".45" pointer-events="none"/>`);
    }).join('');
  return `<defs><mask id="${id}" maskUnits="userSpaceOnUse" maskContentUnits="userSpaceOnUse" x="${shape.left}" y="${shape.top}" width="${width}" height="${height}" style="mask-type:alpha">${maskMarkup}</mask></defs><path class="unified-task-paint" data-unified-task="${esc(task.id)}" d="${shape.path}" fill="${progress === 100 ? palette.progress : palette.base}" pointer-events="none"/><path class="unified-task-progress" d="${shape.path}" fill="${palette.progress}" mask="url(#${id})" pointer-events="none"/>${grips}${task.status === 'blocked' ? `<path class="blocked-task-outline" d="${shape.path}"/>` : ''}`;
}

function renderDependencyLinks(options = null) {
  const body = $('.gantt-body', options?.chart || $('#gantt'));
  if (!body) return;
  $('.dependency-layer', body)?.remove();
  $('.dependency-hidden-layer', body)?.remove?.();
  $$('.bar-label-overlay',body).forEach(label=>label.remove());
  $$('.has-label-overlay',body).forEach(bar=>bar.classList.remove('has-label-overlay'));
  $$('.has-dependency', body).forEach((bar) => bar.classList.remove('has-dependency', 'dependency-join-left', 'dependency-join-right', 'svg-backed'));
  if (!options && state.layout !== 'gantt') return;
  const origin = body.getBoundingClientRect();
  const bars = new Map($$('.task-bar', body).filter(bar => bar.getBoundingClientRect().height > 0.1).map((bar) => [bar.dataset.taskSelect, bar]));
  const actualBars = new Map($$('.actual-task-bar', body).filter(bar => bar.getBoundingClientRect().height > 0.1).map((bar) => [bar.dataset.taskSelect, bar]));
  const projects = options?.projects || filteredProjects();
  const edges = [];
  const attachmentPorts = new Map();
  for (const bar of [...bars.values(), ...actualBars.values()]) {
    bar.classList.remove('unified-task-backed');
    const fill = $('.task-progress-completed', bar);
    if (!fill?.style) continue;
    if (fill.dataset.linearWidth) fill.style.width = fill.dataset.linearWidth;
    fill.style.removeProperty('mask-image'); fill.style.removeProperty('-webkit-mask-image');
  }
  const gradients = [];
  const connectedBars = new Set();
  const visibleTasks = new Map(projects.flatMap(project=>project.tasks).map(task=>[task.id,task]));
  for (const project of projects) {
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
          // Attachment size follows bar thickness, not overlapping date width.
          // Long overlapping tasks must not turn the ribbon into a wide sheet.
          const flare = Math.min(source.height, target.height) * 1.5;
          // Stay clear of rounded corners. The bar and ribbon share the
          // exact surface boundary in one SVG path, with no pixel overlap.
          const cornerInset = (style, width) => Math.min(width / 4, Math.max(...[
            style.borderTopLeftRadius, style.borderTopRightRadius,
            style.borderBottomLeftRadius, style.borderBottomRightRadius,
          ].map((radius) => parseFloat(radius) || 0)) + 3);
          const sourceInset = cornerInset(sourceStyle, source.width);
          const targetInset = cornerInset(targetStyle, target.width);
          from.x -= sourceInset;
          to.x += targetInset;
          from.width = Math.min(flare, source.width - sourceInset * 2 - (sourceBar.classList.contains('open-left') ? Math.min(96, source.width * .65) : 0));
          to.width = Math.min(flare, target.width - targetInset * 2);
          from.surfaceX = from.x - from.width / 2;
          to.surfaceX = to.x + to.width / 2;
        }
        const gradientId = `${options ? 'template-' : ''}dependency-fill-${edges.length}`;
        // A constant color along each joining edge avoids a visible seam:
        // horizontal gradient for end faces, vertical gradient for top/bottom.
        const gradientAxis = kind === 'gap'
          ? `x1="${from.x}" y1="0" x2="${to.x}" y2="0"`
          : `x1="0" y1="${sourceSurfaceY}" x2="0" y2="${targetSurfaceY}"`;
        gradients.push(`<linearGradient id="${gradientId}" gradientUnits="userSpaceOnUse" ${gradientAxis}><stop offset="0" stop-color="${taskProgress(predecessor) === 100 ? colorPalette(predecessor.color).progress : colorPalette(predecessor.color).base}"/><stop offset="1" stop-color="${taskProgress(task) === 100 ? colorPalette(task.color).progress : colorPalette(task.color).base}"/></linearGradient>`);
        gradients.push(`<linearGradient id="${gradientId}-progress" gradientUnits="userSpaceOnUse" ${gradientAxis}><stop offset="0" stop-color="${outgoingConnectionColor(predecessor)}"/><stop offset="1" stop-color="${connectionColor(task)}"/></linearGradient>`);
        if (!attachmentPorts.has(sourceBar)) attachmentPorts.set(sourceBar, {task:predecessor, ports:[]});
        attachmentPorts.get(sourceBar).ports.push(kind === 'gap'
          ? {side:'right',direction:'outgoing'}
          : {side:below?'bottom':'top', x:from.surfaceX-(source.left-origin.left), width:from.width,direction:'outgoing'});
        if (!attachmentPorts.has(targetBar)) attachmentPorts.set(targetBar, {task, ports:[]});
        attachmentPorts.get(targetBar).ports.push(kind === 'gap'
          ? {side:'left',direction:'incoming'}
          : {side:below?'top':'bottom',x:to.surfaceX-(target.left-origin.left),width:to.width,direction:'incoming'});
        const related = state.selection?.type === 'task' && [task.id, predecessorId].includes(state.selection.id);
        const label = t("timeline.finish_to_start", {p0:project.name,p1:predecessor.name,p2:task.name});
        connectedBars.add(sourceBar);
        connectedBars.add(targetBar);
        edges.push({ from, to, sourceBar, targetBar, gradientId, related, kind, task, predecessorId, sourceKind, label });
      }
    }
  }
  for (const [bar, {task, ports}] of attachmentPorts) {
    const fill = $('.task-progress-completed', bar);
    if (!fill?.style) continue;
    const rect = bar.getBoundingClientRect();
    fill.dataset.linearWidth ||= fill.style.width;
    fill.style.width = '100%';
    const mask = `url("data:image/svg+xml,${encodeURIComponent(attachmentProgressMask(rect.width, rect.height, taskProgress(task), ports))}")`;
    fill.style.setProperty('mask-image', mask); fill.style.setProperty('-webkit-mask-image', mask);
  }
  const selectedBars = [...bars.values()].filter(bar => bar.closest?.('.selected-row'));
  if (!edges.length && !actualBars.size && !selectedBars.length) return;
  // Resolve corners after every edge marks its square joining sides.
  // A single exterior contour has no internal edges to antialias separately.
  const geometry = new Map([...connectedBars].map((bar) => [bar,
    { rect: bar.getBoundingClientRect(), style: getComputedStyle(bar) }]));
  // Local to one redraw: drag, zoom and attachment classes invalidate geometry.
  const shapes = new Map();
  const shapeFor = id => {
    if (!shapes.has(id)) shapes.set(id,taskBarShape(bars.get(id),actualBars.get(id),origin));
    return shapes.get(id);
  };
  const outlineFor = id => shapeFor(id).path;
  const tasks = projects.flatMap(project=>project.tasks);
  const markup = edges.map(({ from, to, sourceBar, targetBar, gradientId, related, kind, task, predecessorId, sourceKind, label }) => {
    const ribbon = dependencyRibbon(from, to);
    const paint = dependencyConnectedPath(from, to, geometry.get(sourceBar), geometry.get(targetBar), origin);
    // A connection redraws both endpoint bars. Clip that paint to the same
    // stacked exterior so a separate rectangular tier cannot fill its fillets.
    const stacked = [sourceBar,targetBar].some(bar=>actualBars.has(bar.dataset.taskSelect));
    const exterior = stacked ? [sourceBar,targetBar].map(bar=>outlineFor(bar.dataset.taskSelect)) : [];
    const exteriorClip = stacked ? `<clipPath id="${gradientId}-stacked" clipPathUnits="userSpaceOnUse">${[...exterior,ribbon].map(path=>`<path d="${path}"/>`).join('')}</clipPath>` : '';
    const clipAttribute = stacked ? ` clip-path="url(#${gradientId}-stacked)"` : '';

    // Overlap the progress paint at shared faces, clipped to the existing
    // exterior: separate antialiased edges otherwise expose a hairline of base color.
    return `<defs>${exteriorClip}<clipPath id="${gradientId}-outline" clipPathUnits="userSpaceOnUse"><path d="${paint}"/></clipPath></defs><path class="dependency-paint" d="${paint}"${clipAttribute} fill="url(#${gradientId})" fill-rule="nonzero" aria-hidden="true"/>
      <path class="dependency-progress" d="${ribbon}" fill="url(#${gradientId}-progress)" stroke="url(#${gradientId}-progress)" stroke-width="1" stroke-linejoin="round" clip-path="url(#${gradientId}-outline)" pointer-events="none" aria-hidden="true"/>
      <path class="dependency-link${related ? ' is-related' : ''}" d="${ribbon}" fill="transparent" data-connection-kind="${kind}" data-task-select="${esc(task.id)}" data-predecessor="${esc(predecessorId)}" data-source-period="${sourceKind}" role="button" tabindex="0" aria-label="${esc(label)}"><title>${esc(label)}</title></path>`;
  }).join('');
  const unifiedMarkup = tasks.filter(task => bars.has(task.id) && actualBars.has(task.id))
    .map((task,index) => unifiedTaskPaint(task,bars.get(task.id),actualBars.get(task.id),origin,index,attachmentPorts,shapeFor(task.id))).join('');
  const blockedMarkup = tasks
    .filter(task => task.status === 'blocked' && bars.has(task.id) && !actualBars.has(task.id) && connectedBars.has(bars.get(task.id)))
    .map(task => {
      const path = outlineFor(task.id);
      return `<path class="blocked-task-outline" d="${path}"/>`;
    }).join('');
  const selectionMarkup = selectedBars.map(bar => {
    const path = outlineFor(bar.dataset.taskSelect);
    return `<path class="selected-task-halo" d="${path}"/><path class="selected-task-outline" d="${path}"/>${bar.classList.contains('blocked') ? `<path class="selected-task-blocked" d="${path}"/>` : ''}`;
  }).join('');
  // Connections remain in front at unrelated crossings. Mark the occluded
  // bar contour (not the visible ribbon contour) within the overlap only.
  const silhouettes = [...bars.keys()].map(id=>({id,path:outlineFor(id)}));
  const hiddenMarkup = edges.map(({from,to,gradientId,task,predecessorId}) => {
    const occluded = silhouettes.filter(item=>item.id!==task.id && item.id!==predecessorId);
    if (!occluded.length) return '';
    const id = `${gradientId}-hidden`, ribbon = dependencyRibbon(from,to);
    // Reuse the ribbon's progress gradient for the overlap so ordinary HTML
    // bars and SVG-backed/actual bars all have the same front/back ordering.
    return `<defs><clipPath id="${id}" clipPathUnits="userSpaceOnUse"><path d="${ribbon}"/></clipPath><clipPath id="${id}-bars" clipPathUnits="userSpaceOnUse">${occluded.map(item=>`<path d="${item.path}"/>`).join('')}</clipPath><pattern id="${id}-hatch" patternUnits="userSpaceOnUse" width="6" height="6"><path d="M -1 1 L 1 -1 M 0 6 L 6 0 M 5 7 L 7 5" stroke="#fff" stroke-width="2"/><path d="M -1 1 L 1 -1 M 0 6 L 6 0 M 5 7 L 7 5" stroke="#344054" stroke-width=".8"/></pattern></defs><path class="dependency-crossing-paint" d="${ribbon}" fill="url(#${gradientId}-progress)" clip-path="url(#${id}-bars)"/><path class="dependency-crossing-hatch" d="${ribbon}" fill="url(#${id}-hatch)" clip-path="url(#${id}-bars)"/><g clip-path="url(#${id})">${occluded.map(item=>`<path class="dependency-hidden-halo" data-occluded-task="${esc(item.id)}" d="${item.path}"/><path class="dependency-hidden-line" data-occluded-task="${esc(item.id)}" d="${item.path}"/>`).join('')}</g>`;
  }).join('');
  body.insertAdjacentHTML('beforeend', `<svg class="dependency-layer" width="${body.scrollWidth}" height="${body.offsetHeight}" aria-label="${t("timeline.predecessor_and_successor_connections")}"><defs>${gradients.join('')}</defs>${markup}${unifiedMarkup}${blockedMarkup}${selectionMarkup}</svg>${hiddenMarkup ? `<svg class="dependency-hidden-layer" width="${body.scrollWidth}" height="${body.offsetHeight}" aria-hidden="true">${hiddenMarkup}</svg>` : ''}`);
  connectedBars.forEach((bar) => bar.classList.add('svg-backed'));
  if (hiddenMarkup) {
    for (const bar of [...bars.values(),...actualBars.values()]) {
      const text = $('.bar-text',bar);
      if (!text) continue;
      const label = document.createElement('div');
      label.className = 'bar-label-overlay';
      label.setAttribute('aria-hidden','true');
      const style = getComputedStyle(bar);
      for (const key of ['left','top','width','height','paddingLeft','paddingRight','color','fontSize','borderRadius']) label.style[key] = style[key];
      const copy = text.cloneNode(true);
      const textStyle = getComputedStyle(text);
      copy.style.marginLeft = textStyle.marginLeft;
      copy.style.marginRight = textStyle.marginRight;
      label.append(copy);
      bar.insertAdjacentElement('afterend',label);
      bar.classList.add('has-label-overlay');
    }
  }


}

function ganttAddRow(id, width, label = t("timeline.add_single_task"), rootDrop = false) {
  return `<div class="gantt-row gantt-add-row"><div class="gantt-left" ${rootDrop ? 'data-drop-project="__unassigned__" data-directory-id="root"' : ''}><button type="button" id="${id}" class="gantt-add-button" aria-label="${esc(label)}"><span class="gantt-add-icon" aria-hidden="true">＋</span><span class="gantt-add-title">${esc(label.replace(/^[＋+]\s*/, ''))}</span></button></div><div class="gantt-right" style="width:${width}px"></div></div>`;
}
function addTemplateTask() {
  syncDraftFromEditor();
  const draft = state.draft;
  const startDay = Math.max(0, ...templateSchedule(draft.tasks).map(row => row.end)) + 1;
  draft.tasks.push({ key: `task_${ChartMutations.randomUUID().slice(0,8)}`, name: t("timeline.new_task", {p0:draft.tasks.length+1}), start_day:startDay, duration_value:1, duration_unit:'days', dependencies:[], owner:'', handoff:'', color:taskColors[draft.tasks.length % taskColors.length], sort_order:draft.tasks.length });
  state.templateTaskKey=draft.tasks.at(-1).key; state.templateTaskCollapsed=false;
  state.preview=null;
  renderTemplateEditor();
  queueTemplateSave();
  setMobileDrawer('inspector');
  $('.template-task-name')?.focus();
}
let quickCreatePending = false;
async function createScheduleItem(type) {
  if (quickCreatePending) return;
  quickCreatePending = true;
  try {
    const today = todayInput();
    const request = type === 'project'
      ? api('/api/projects', {method:'POST',body:JSON.stringify({request_id:ChartMutations.randomUUID(),name:t('template.new_project'),start_date:today,calendar_type:'working'})})
      : api('/api/projects/__unassigned__/tasks', {method:'POST',body:JSON.stringify({name:t('timeline.new_task_name'),planned_start:today,planned_finish:today})});
    state.pendingNameFocus = {...state.selection};
    persistUi();
    await request;
  } catch (error) { toast(error.message); }
  finally { quickCreatePending = false; }
}
function openAddProjectTask() { return createScheduleItem('task'); }

let labelWidthMotion = null;
const labelContentSelector = '.task-name, .project-name, .task-owner, .project-meta, .gantt-label-title, .chart-header-info, .group-header-label, .gantt-add-title';
const labelAnchorSelector = '.task-state, .group-dot, .gantt-label-toggle > span[aria-hidden], .gantt-add-icon';
function captureLabelContents(chart) {
  return new Map($$('.gantt-left',chart).flatMap(label=>
    $$(labelContentSelector+', '+labelAnchorSelector,label).filter(el=>el.getClientRects().length).map(el=>{
      const rect=el.getBoundingClientRect();
      return [el,{left:rect.left,top:rect.top,opacity:Number(getComputedStyle(el).opacity)}];
    })));
}
function currentGanttLabelWidth(chart) {
  if (labelWidthMotion?.chart===chart) return labelWidthMotion.width();
  return $('.gantt-head-left', chart).getBoundingClientRect().width;
}
function animateGanttLabelWidth(chart, from, initial = new Map()) {
  labelWidthMotion?.cancel();
  const to = parseFloat(chart.style.getPropertyValue('--label-width'));
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || Math.abs(to-from) < 1) return;
  const collapsed = chart.classList.contains('labels-collapsed');
  const animations = [];
  const animate = (element, first, last) => animations.push(element.animate([first,last],
    {duration:180,easing:'linear',fill:'both'}));
  chart.classList.add('labels-width-animating');
  chart.classList.remove('labels-collapsed');
  const width = Math.max(from,to,Number(chart.dataset.expandedLabelWidth || 0)), saved = [];
  const labels=$$('.gantt-left',chart), anchors=labels.flatMap(label=>$$(labelAnchorSelector,label));
  // Measure both endpoints once. Badges and the chevron must arrive at their
  // collapsed centers, rather than jumping when the collapsed class is restored.
  for(const label of labels) {saved.push([label,label.style.cssText]);label.style.width=label.style.flexBasis='36px';}
  chart.classList.add('labels-collapsed');
  const folded=new Map(anchors.map(el=>[el,el.getBoundingClientRect()]));
  chart.classList.remove('labels-collapsed');
  // Clip an opaque label surface instead of relaying out every row on each
  // display refresh. Calendar children move independently to keep text above SVG.
  for (const label of labels) {
    label.style.width=label.style.flexBasis=`${width}px`;
    label.style.marginRight=`${to-width}px`;
    animate(label,{clipPath:`inset(0 ${width-from}px 0 0)`},{clipPath:`inset(0 ${width-to}px 0 0)`});
  }
  for (const element of $$('.gantt-head-right, .gantt-row > .gantt-right > *, .project-duration-band, .dependency-layer, .dependency-hidden-layer',chart)) {
    const offset=Number(element.dataset.columnOffset || 0);
    animate(element,{transform:`translateX(${offset+from-to}px)`},{transform:`translateX(${offset}px)`});
  }
  for(const element of anchors) {
    const rect=element.getBoundingClientRect(),target=folded.get(element),start=initial.get(element);
    const dx=target.left-rect.left,dy=target.top-rect.top;
    animate(element,{transform:`translate(${start?start.left-rect.left:collapsed?0:dx}px,${start?start.top-rect.top:collapsed?0:dy}px)`},
      {transform:`translate(${collapsed?dx:0}px,${collapsed?dy:0}px)`});
  }
  for(const element of labels.flatMap(label=>$$(labelContentSelector,label))) {
    const rect=element.getBoundingClientRect(),start=initial.get(element);
    const rightAligned=element.matches('.task-owner, .project-meta');
    const endX=collapsed?(rightAligned?to-width:-6):0;
    const startX=start?start.left-rect.left:collapsed?0:rightAligned?from-width:-6;
    // Names disappear before the narrow gutter reaches them. Trailing metadata
    // follows the moving edge; expansion reveals names only after space opens.
    animations.push(element.animate([
      {transform:`translateX(${startX}px)`,opacity:start?.opacity ?? (collapsed?1:0)},
      {transform:`translateX(${startX+(endX-startX)*(collapsed?.65:.25)}px)`,opacity:collapsed?0:(start?.opacity ?? 0),offset:collapsed?.65:.25},
      {transform:`translateX(${endX}px)`,opacity:collapsed?0:1}
    ],{duration:180,easing:'linear',fill:'both'}));
  }
  const motion = {chart,width() {return from+(to-from)*(animations[0].effect.getComputedTiming().progress ?? 0);},cancel() {
    for (const animation of animations) animation.cancel();
    for (const [element,cssText] of saved) element.style.cssText=cssText;
    chart.classList.remove('labels-width-animating');
    chart.classList.toggle('labels-collapsed',collapsed);
    if (labelWidthMotion === motion) labelWidthMotion = null;
  }};
  labelWidthMotion = motion;
  Promise.all(animations.map(a=>a.finished)).then(() => {
    if (labelWidthMotion === motion) motion.cancel();
  }, () => {});
}

function toggleGanttLabels(chart) {
  const from=currentGanttLabelWidth(chart), initial=captureLabelContents(chart);
  labelWidthMotion?.cancel();
  const expanded=chart.classList.contains('labels-collapsed');
  const previous=parseFloat(chart.style.getPropertyValue('--label-width'));
  if (!expanded) chart.dataset.expandedLabelWidth=String(previous);
  const width=expanded?Number(chart.dataset.expandedLabelWidth || 254):36;
  const delta=width-previous;
  if(mobileLayout()) state.mobileLabelsExpanded=expanded; else state.desktopLabelsExpanded=expanded;
  chart.classList.toggle('labels-collapsed',!expanded);
  chart.style.setProperty('--label-width',`${width}px`);
  $('.gantt-head-left',chart).style.width=`${width}px`;
  const body=$('.gantt-body',chart),content=$('.template-chart-content',chart);
  body.style.width=`${parseFloat(body.style.width)+delta}px`;
  if(content) content.style.width=body.style.width;
  for(const band of $$('.project-duration-band',chart)) band.style.left=`${parseFloat(band.style.left)+delta}px`;
  for(const layer of $$('.dependency-layer, .dependency-hidden-layer',chart)) {
    const offset=Number(layer.dataset.columnOffset || 0)+delta;
    layer.dataset.columnOffset=String(offset);layer.style.transform=`translateX(${offset}px)`;
    layer.setAttribute('width',body.style.width);
  }
  const button=$('.gantt-label-toggle',chart);
  button.setAttribute('aria-expanded',String(expanded));
  button.setAttribute('aria-label',`${t("timeline.project_task_column")} ${t(expanded?'timeline.collapse_2':'timeline.expand_2')}`);
  $('span[aria-hidden]',button).textContent=expanded?'‹':'›';
  animateGanttLabelWidth(chart,from,initial);
}

function renderTimeline({ preserveInspector = false } = {}) {
  if (inlineNameEditor?.isConnected) return;
  labelWidthMotion?.cancel();
  $('#gantt').classList.remove('labels-width-animating');
  $('#gantt').style.removeProperty('--label-content-opacity');
  if (typeof projectMotion !== 'undefined') projectMotion.observe();
  const calendarWrap = $('#gantt-wrap');
  const calendarScroll = {left:calendarWrap.scrollLeft,top:calendarWrap.scrollTop};
  const visibleProjects = filteredProjects();
  const rootProject = visibleProjects.find(project => project.is_unassigned) || {id:'__unassigned__',is_unassigned:true,name:t("inspector.no_project"),color:'#94a3b8',tasks:[],progress:0};
  const projects = [...visibleProjects.filter(project => !project.is_unassigned), rootProject];
  const tasks = flatten(projects);
  const bounds = timelineCalendarRange();
  const {start,end} = bounds;
  const today = clockParts(timelineReferenceTime).date;
  const days = dayDiff(start,end) + 1;
  $('#range-label').textContent = dateRangeLabel(start,end);
  const pxPerDay = state.zoom;
  const labelsExpanded = mobileLayout() ? Boolean(state.mobileLabelsExpanded) : state.desktopLabelsExpanded !== false;
  const labelWidth = labelsExpanded ? 254 : 36;
  $('#gantt').style.setProperty('--label-width', `${labelWidth}px`);
  $('#gantt').classList.toggle('labels-collapsed', !labelsExpanded);
  const timelineWidth = Math.max(720, days * pxPerDay);
  const dates = dateColumns(start, days, pxPerDay);
  renderHolidayStatus();
  $('#gantt-wrap').classList.toggle('hidden', state.layout !== 'gantt');
  $('#list-wrap').classList.toggle('hidden', state.layout !== 'list' || !tasks.length);
  $('#empty-state').classList.toggle('hidden', state.layout === 'gantt' || tasks.length > 0);

  const todayOffset = dayDiff(start, today);
  const nowOffset = todayOffset + timeOfDayFraction(timelineReferenceTime);
  $('#gantt').dataset.todayDate = today;
  $('#gantt').dataset.todayOffset = todayOffset;
  let rows = '';
  let bodyHeight = 0;
  const projectBands = [];
  const rowShading = calendarShadingMarkup(dates,pxPerDay);
  const timelineCellStyle = `--day-width:${pxPerDay}px;`;
  const groupMode = $('#sort-select')?.value === 'group';
  const groupedProjects = groupMode ? [...projects.reduce((groups, project) => {
    if (project.is_unassigned) return groups;
    const groupName = canonicalGroupName(project.group_name) || t("timeline.ungrouped");
    if (!groups.has(groupName)) groups.set(groupName, []);
    groups.get(groupName).push(project);
    return groups;
  }, new Map()).entries()].sort(([a], [b]) => a.localeCompare(b, I18n.locale)).map(([name, items]) => ({ name, projects: items })) : [{ name: '', projects }];
  if (groupMode) groupedProjects.push({ name: '', projects: projects.filter(project => project.is_unassigned) });
  for (const projectGroup of groupedProjects) {
    if (groupMode && projectGroup.name) {
      rows += `<div class="gantt-row group-header-row"><div class="gantt-left"><span class="group-header-label"><i></i>${esc(projectGroup.name)}<small>${projectGroup.projects.length}${t("timeline.projects")}</small></span></div><div class="gantt-right" style="width:${timelineWidth}px"></div></div>`;
      bodyHeight += 30;
    }
    for (const project of projectGroup.projects) {
    const collapsed = !project.is_unassigned && state.collapsedProjects.has(project.id);
    if (!project.is_unassigned) {
    const projectStart = project.tasks.map((task) => task.planned_start).filter(Boolean).sort()[0] || project.start_date;
    const projectFinish = project.tasks.map((task) => task.planned_finish).filter(Boolean).sort().at(-1);
    const projectX = dayDiff(start, projectStart || start) * pxPerDay;
    const projectBarWidth = Math.max(pxPerDay, (dayDiff(projectStart || start, projectFinish || projectStart || start) + 1) * pxPerDay);
    const isProjectSelected = state.selection?.type === 'project' && state.selection.id === project.id;
    const projectTop = bodyHeight;
    const projectHeight = 38 + (collapsed ? 0 : project.tasks.reduce((height, task) => height + taskRowHeight(task), 0));
    if (!collapsed) projectBands.push({ project, top: projectTop, height: projectHeight, left: labelWidth + projectX, width: projectBarWidth });
    const summaryClass = collapsed ? '' : ' expanded-project-label';
      rows += `<div class="gantt-row project-row ${isProjectSelected ? 'selected-row' : ''}" style="${paletteStyle(project.color, 'project')}">
      <div class="gantt-left project-left" data-drop-project="${esc(project.id)}" data-directory-id="project:${esc(project.id)}">
        <button class="project-select" type="button" draggable="${!project.is_unassigned && $('#sort-select').value === 'manual'}" title="${t("directory.drag_project")}" data-collapse="${esc(project.id)}" aria-expanded="${!collapsed}" aria-label="${esc(project.is_unassigned ? t("inspector.no_project") : project.name)} ${collapsed ? t("timeline.expand") : t("timeline.collapse")}"><i class="group-dot project-order" style="background:${colorPalette(project.color).base}" aria-label="${t("timeline.default_order")} ${project.sort_order ?? ''}">${project.sort_order ?? ''}</i><span class="project-name" title="${esc(project.is_unassigned ? t("inspector.no_project") : project.name)}">${esc(project.is_unassigned ? t("inspector.no_project") : project.name)}</span><span class="project-meta">${project.progress}%</span></button>
      </div>
      <div class="gantt-right project-timeline" style="width:${timelineWidth}px;${timelineCellStyle}"><div class="row-date-shading">${rowShading}</div><div class="today-line" style="left:${nowOffset * pxPerDay}px"></div><button class="project-summary-bar${summaryClass}" type="button" data-project-select="${esc(project.id)}" style="left:${projectX}px;width:${projectBarWidth}px;${paletteStyle(project.color, 'bar')}" title="${t("timeline.project_duration")} ${fmtDate(projectStart, true)} — ${fmtDate(projectFinish, true)}"><i style="width:${project.progress}%"></i><span>${esc(project.is_unassigned ? t("inspector.no_project") : project.name)} · ${project.progress}%</span></button></div>
    </div>`;
    bodyHeight += 38;
    }
    if (collapsed) continue;
    for (const task of project.tasks) {
      const startX = dayDiff(start, task.planned_start) * pxPerDay;
      const width = Math.max(pxPerDay, (dayDiff(task.planned_start, task.planned_finish) + 1) * pxPerDay);
      const actual = actualTaskRange(task);
      const actualX = actual ? dayDiff(start, actual.start) * pxPerDay : 0;
      const actualWidth = actual ? Math.max(pxPerDay, (dayDiff(actual.start, actual.finish) + 1) * pxPerDay) : 0;
      const actualTitle = actual ? `${task.name} · ${actual.label} · ${fmtDate(task.actual_start || task.actual_finish, true)}${actual.partial ? '' : `–${fmtDate(actual.finish, true)}`}` : '';
      const actualMarkup = actual ? `<button data-date-period="actual" class="actual-task-bar${actual.partial ? ` partial-actual open-${actual.openSide}` : ''}" type="button" data-task-select="${esc(task.id)}" data-project="${esc(project.id)}" style="left:${actualX}px;width:${actualWidth}px;${paletteStyle(task.color, 'bar')};${actualOpenStyle(actual, actualWidth)}" title="${esc(actualTitle)}" aria-label="${esc(actualTitle)}">${task.actual_start ? `<span class="resize-handle resize-start" data-resize-edge="start" aria-label="${esc(task.name)} ${t("timeline.adjust_actual_start")}"></span>` : ''}<i class="bar-progress task-progress-completed" style="width:${taskProgress(task)}%"></i><span class="bar-text">${esc(actual.label)} · ${esc(task.name)}</span>${task.actual_finish ? `<span class="resize-handle resize-end" data-resize-edge="end" aria-label="${esc(task.name)} ${t("timeline.adjust_actual_finish")}"></span>` : ''}</button>` : '';
      const status = task.status;
      const isSelected = state.selection?.type === 'task' && state.selection.id === task.id;
      rows += `<div class="gantt-row task-row${project.is_unassigned ? ' unassigned-task-row' : ''}${actual ? ' has-actual' : ''} ${isSelected ? 'selected-row' : ''}" style="${paletteStyle(project.color, 'project')}">
        <div class="gantt-left task-left"><button class="task-label" type="button" draggable="true" title="${t("directory.drag_task")}" data-task-select="${esc(task.id)}" data-project="${esc(project.id)}"><span class="task-state task-order ${status}" style="${paletteStyle(task.color, 'task')}" title="${esc(statusNames[status] || status)}" aria-label="${t("timeline.default_order")} ${task.sort_order}">${task.sort_order}</span><span class="task-name" title="${esc(task.name)}">${esc(task.name)}</span><span class="task-owner">${esc(task.owner || t("timeline.unassigned"))}</span></button></div>
        <div class="gantt-right project-timeline" style="width:${timelineWidth}px;${timelineCellStyle}"><div class="row-date-shading">${rowShading}</div><div class="today-line" style="left:${nowOffset * pxPerDay}px"></div><button class="task-bar ${status}" type="button" data-task-select="${esc(task.id)}" data-project="${esc(project.id)}" style="left:${startX}px;width:${width}px;${paletteStyle(task.color, 'bar')}" title="${esc(task.name)} ${t("timeline.planned")} ${fmtDate(task.planned_start, true)}–${fmtDate(task.planned_finish, true)}"><span class="resize-handle resize-start" data-resize-edge="start" aria-label="${esc(task.name)} ${t("timeline.adjust_start_date")}"></span><i class="bar-progress task-progress-completed" style="width:${taskProgress(task)}%"></i><span class="bar-text">${actual ? t("timeline.planned_2") : ''}${esc(task.name)} · ${taskProgress(task)}%${status === 'blocked' ? t("timeline.stopped") : ''}</span><span class="resize-handle resize-end" data-resize-edge="end" aria-label="${esc(task.name)} ${t("timeline.adjust_finish_date")}"></span></button>${actualMarkup}</div>
      </div>`;
      bodyHeight += taskRowHeight(task);
    }
    }
  }
  rows += ganttAddRow('add-empty-project', timelineWidth, t("project.add_row"), true);
  rows += ganttAddRow('add-project-task', timelineWidth, t("timeline.add_single_task"), true);
  bodyHeight += 76;
  const headerDates = calendarHeaderMarkup(dates,pxPerDay);
  const projectBandMarkup = projectBands.map((band) => `<div class="project-duration-band" data-project-band="${esc(band.project.id)}" aria-hidden="true" style="left:${band.left}px;top:${band.top}px;width:${band.width}px;height:${band.height}px;${paletteStyle(band.project.color, 'bar')};--progress:${band.project.progress}%"></div>`).join('');
  $('#gantt').innerHTML = `<div class="gantt-head"><div class="gantt-left gantt-head-left" style="width:${labelWidth}px">${`<button type="button" class="gantt-label-toggle" aria-expanded="${labelsExpanded}" aria-label="${t("timeline.project_task_column")} ${labelsExpanded ? t("timeline.collapse_2") : t("timeline.expand_2")}"><span class="gantt-label-title">${t("timeline.project_task")}</span><span aria-hidden="true">${labelsExpanded ? '‹' : '›'}</span></button>`}${$('#chart-info-template').innerHTML}</div><div class="gantt-right gantt-head-right" style="width:${timelineWidth}px"><div class="date-axis">${headerDates}</div></div></div><div class="gantt-body" style="width:${labelWidth + timelineWidth}px;min-height:${bodyHeight}px">${projectBandMarkup}${rows}</div>`;
  if (mobileLayout() && state.mobileLabelsExpanded) {
    const textWidth = node => {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect().width;
    };
    const widths = $$('.project-name, .task-name', $('#gantt')).map(name => {
      const button = name.closest('button'), style = getComputedStyle(button);
      const icon = button.querySelector('.group-dot, .task-state');
      return textWidth(name) + (icon?.getBoundingClientRect().width || 0) +
        (parseFloat(style.columnGap) || 0) + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    });
    const width = Math.ceil(Math.max(120, ...widths,
      ...$$('.group-header-label', $('#gantt')).map(label => textWidth(label) + 30))) + 2;
    $('#gantt').style.setProperty('--label-width', `${width}px`);
    $('.gantt-head-left', $('#gantt')).style.width = `${width}px`;
    $('.gantt-body', $('#gantt')).style.width = `${width + timelineWidth}px`;
    $$('.project-duration-band', $('#gantt')).forEach(band => {
      band.style.left = `${parseFloat(band.style.left) + width - labelWidth}px`;
    });
  }
  $('.gantt-head-left', $('#gantt')).addEventListener('click', event => {
    if (event.target.closest('.info-tip')) return;
    const keyboard = event.detail === 0;
    toggleGanttLabels($('#gantt'));
    if (keyboard) $('.gantt-label-toggle', $('#gantt'))?.focus();
  });
  $('#add-empty-project').addEventListener('click', () => openProjectCreate(false));
  $('#add-project-task').addEventListener('click', openAddProjectTask);
  updateCurrentTimeMarker();
  renderDependencyLinks();
  if (!preserveInspector) renderInspector();
  $('#list-wrap').innerHTML = `<table class="list-table"><thead><tr><th>${t("timeline.project")}</th><th>${t("timeline.task")}</th><th>${t("timeline.owner_vendor")}</th><th>${t("status.planned")}</th><th>${t("calendar.status")}</th><th>${t("timeline.stop_reason")}</th><th>${t("timeline.next_handoff")}</th></tr></thead><tbody>${projects.flatMap((project) => project.tasks.map((task) => `<tr class="list-task-row" data-project="${esc(project.id)}" data-task="${esc(task.id)}"><td>${esc(project.is_unassigned ? t("inspector.no_project") : project.name)}</td><td class="list-task">${esc(task.name)}</td><td>${esc(task.owner || t("timeline.unassigned_2"))}</td><td>${fmtDate(task.planned_start, true)} – ${fmtDate(task.planned_finish, true)}</td><td><span class="status-pill ${task.status}">${statusNames[task.status] || task.status}</span></td><td>${esc(task.blocker || '—')}</td><td>${esc(task.handoff || '—')}</td></tr>`)).join('')}</tbody></table>`;
  $$('.list-task-row', $('#list-wrap')).forEach((row) => row.addEventListener('click', () => selectItem('task', row.dataset.task)));
  calendarWrap.scrollLeft = state.calendarPositioned ? calendarScroll.left : Math.max(0, todayOffset * pxPerDay - 2 * pxPerDay);
  calendarWrap.scrollTop = calendarScroll.top;
  state.calendarPositioned = true;
  bindTimelineCalendarScroll();
}

function taskDateGrid(plannedStart, plannedFinish, actualStart, actualFinish) {
  return `<table class="task-date-grid" aria-label="${t("inspector.task_schedule")}"><colgroup><col class="date-row-label"><col><col></colgroup>
    <thead><tr><th scope="col">${t("inspector.dates")}</th><th scope="col">${t("inspector.start_date")}</th><th scope="col">${t("inspector.finish_date")}</th></tr></thead>
    <tbody><tr><th scope="row">${t("inspector.planned_dates")}</th><td>${plannedStart}</td><td>${plannedFinish}</td></tr>
    ${actualStart != null ? `<tr><th scope="row">${t("inspector.actual_dates")}</th><td>${actualStart}</td><td>${actualFinish}</td></tr>` : ''}</tbody></table>`;
}

function paintInspectorContext(project,task) {
  $('#project-context-label').textContent = project ? project.name : t("inspector.select_an_item");
  $('#project-context-label').classList.toggle('task-color-tag', Boolean(project));
  applyPalette($('#project-context-label'), project?.color || '#5872d9');
  $('#project-context-label').title = task ? t("inspector.change_task_project") : project?.name || '';
  $('#project-context-label').disabled = !task;
  $('#project-context-label').setAttribute('aria-label', task ? t("inspector.change_task_project_2", {p0:project.name}) : project?.name || t("inspector.select_an_item"));
  $('#project-context-label').onclick = task ? () => openTaskProjectMenu(task.id) : null;
  $('#task-context-label').textContent = task ? task.name : t("inspector.not_selected");
  $('#task-context-label').classList.toggle('task-color-tag', Boolean(task));
  applyPalette($('#task-context-label'), task?.color || project?.color || '#5872d9');
  $('#task-context-label').title = task?.name || '';
  $('#inspector-save-state').textContent = state.selection ? t("inspector.auto_save") : t("inspector.nothing_selected");
}
function syncInspectorProjection() {
  const project = state.data.projects.find(item=>state.selection?.type === 'project' ? item.id === state.selection.id : item.tasks.some(task=>task.id === state.selection?.id));
  const task = state.selection?.type === 'task' ? project?.tasks.find(item=>item.id === state.selection.id) : null;
  const projectForm = $('#project-inspector-form'), taskForm = $('#task-inspector-form');
  const projectId = project && !project.is_unassigned ? project.id : undefined;
  if (chartMutations.resolveId(projectForm?.entityId) !== projectId || chartMutations.resolveId(taskForm?.entityId) !== task?.id) {
    renderInspector();return;
  }
  projectForm?.syncProjection?.();taskForm?.syncProjection?.();taskForm?.syncProgress?.();
  paintInspectorContext(project,task);
  if (projectForm) {
    $('.color-field code',projectForm).textContent = $('#ins-project-color').value;
    $('.derived-date small',projectForm).textContent = project.calendar_type === 'working' ? t("inspector.5_day_week_excludes_weekends_and") : t("inspector.7_day_week");
    $('.derived-date b',projectForm).textContent = `${fmtDate(project.planned_start,true)} — ${fmtDate(project.planned_finish,true)}`;
    $('#ins-project-complete').disabled = !project.tasks.length;
  }
  if (taskForm) {
    $('.color-field code',taskForm).textContent = $('#ins-task-color').value;
    applyPalette($('.task-progress-control',taskForm),task.color,'bar');
    syncRelationRowOrder(project,task,taskForm);
  }
}

const externalRelationRows = new Map();
function relationRows(project, task, projects) {
  const extra = externalRelationRows.get(task.id) || new Set();
  const decorate = (item, parent) => ({...item, relationProjectColor:parent.is_unassigned?'#94a3b8':parent.color, relationProjectOrder:parent.is_unassigned?'':(parent.sort_order ?? ''), relationProjectLabel:parent.is_unassigned?t('inspector.no_project'):parent.name});
  const own = project.tasks.filter(item=>item.id!==task.id).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(item=>decorate(item,project));
  const external = projects.filter(parent=>parent.id!==project.id).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).flatMap(parent=>[...parent.tasks].sort((a,b)=>(a.sort_order||0)-(b.sort_order||0))
    .filter(item=>extra.has(item.id) || task.dependencies.includes(item.id) || (item.dependencies||[]).includes(task.id))
    .map(item=>({...decorate(item,parent),relationProjectName:parent.is_unassigned?t('inspector.no_project'):parent.name})));
  return [...own,...external].map(item=>({...item,showRelationProject:external.length>0}));
}
function relationPositionMarker(color) {
  return `<tr class="relation-position-marker" aria-hidden="true"><td colspan="3" style="--relation-marker-color:${colorPalette(color).base}"></td></tr>`;
}
function syncRelationRowOrder(project, task, form) {
  const body = $('.inspector-relations tbody',form);
  if (!body) return;
  const addRow = $('.relation-add-cell',body)?.closest('tr');
  const rows = new Map($$('.ins-task-dependency',body).map(input=>[input.value,input.closest('tr')]));
  $('.relation-position-marker',body)?.remove();
  const currentRows = relationRows(project,task,state.data.projects);
  const currentIds = new Set(currentRows.map(item=>item.id));
  for (const [id,row] of rows) if (!currentIds.has(id)) row.remove();
  for (const item of currentRows) {
    const row = rows.get(item.id);
    if (!row) continue;
    body.insertBefore(row,addRow || null);
    const badge = $('.relation-project-badge',row);
    if (badge) {
      badge.hidden = !item.showRelationProject;
      badge.textContent = item.relationProjectOrder;
      badge.style.background = colorPalette(item.relationProjectColor).base;
      badge.style.color = colorPalette(item.relationProjectColor).ink;
    }
  }
  const own = [...project.tasks].sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
  const next = own.slice(own.findIndex(item=>item.id===task.id)+1).find(item=>rows.has(item.id));
  const external = currentRows.find(item=>item.relationProjectName);
  const anchor = (next && rows.get(next.id)) || (external && rows.get(external.id)) || addRow;
  if (anchor) anchor.insertAdjacentHTML('beforebegin',relationPositionMarker(task.color));
  else body.insertAdjacentHTML('beforeend',relationPositionMarker(task.color));
}
function openExternalRelationPicker(taskId, projectId, trigger) {
  $('#external-relation-picker')?.remove();
  const popup=document.createElement('div');
  popup.id='external-relation-picker';popup.className='external-relation-picker';
  popup.setAttribute('popover','auto');popup.setAttribute('role','dialog');popup.setAttribute('aria-label',t('relations.add_external'));
  const task=state.data.projects.flatMap(parent=>parent.tasks).find(item=>item.id===taskId);
  const project=state.data.projects.find(parent=>parent.id===projectId);
  if(!task || !project)return;
  const listed=new Set(relationRows(project,task,state.data.projects).map(item=>item.id));
  const choices=state.data.projects.filter(parent=>parent.id!==projectId && parent.tasks.some(item=>!listed.has(item.id)));
  popup.innerHTML=`<strong>${t('relations.add_external')}</strong><label>${t('timeline.project')}<select class="select-input" data-project aria-label="${t('timeline.project')}">${choices.map(parent=>`<option value="${esc(parent.id)}">${esc(parent.is_unassigned?t('inspector.no_project'):parent.name)}</option>`).join('')}</select></label><label>${t('timeline.task')}<select class="select-input" data-task aria-label="${t('timeline.task')}"></select></label><p>${t(choices.length?'relations.choose_direction':'relations.no_external')}</p><button type="button" class="button button-primary" data-add>${t('relations.add_row')}</button>`;
  document.body.append(popup);
  const projectSelect=popup.querySelector('[data-project]'),taskSelect=popup.querySelector('[data-task]'),add=popup.querySelector('[data-add]');
  const update=()=>{
    const parent=choices.find(item=>item.id===projectSelect.value);
    taskSelect.innerHTML=(parent?.tasks || []).filter(item=>!listed.has(item.id)).map(item=>`<option value="${esc(item.id)}">${esc(item.name)}</option>`).join('');
    add.disabled=!taskSelect.value;projectSelect.disabled=!choices.length;taskSelect.disabled=!taskSelect.value;
  };
  projectSelect.addEventListener('change',update);update();
  add.addEventListener('click',async()=>{
    const id=taskSelect.value;if(!id)return;
    const extra=externalRelationRows.get(taskId)||new Set();extra.add(id);externalRelationRows.set(taskId,extra);
    popup.hidePopover();popup.remove();
    await chartMutations.whenIdle();
    if(state.selection?.id!==taskId)return;
    renderInspector();
    const box=$$('.ins-task-dependency').find(input=>input.value===id);box?.focus({preventScroll:true});box?.scrollIntoView({block:'nearest'});
  });
  popup.addEventListener('toggle',()=>{if(!popup.matches(':popover-open'))popup.remove();});
  popup.showPopover();
  const rect=trigger.getBoundingClientRect();
  popup.style.left=`${Math.max(8,Math.min(rect.left,innerWidth-popup.offsetWidth-8))}px`;
  popup.style.top=`${Math.max(8,Math.min(rect.bottom+5,innerHeight-popup.offsetHeight-8))}px`;
  projectSelect.focus();
}

function renderInspector() {
  const project = state.data.projects.find((item) => item.id === (state.selection?.type === 'project' ? state.selection.id : state.data.projects.find((p) => p.tasks.some((task) => task.id === state.selection?.id))?.id));
  const task = project?.tasks.find((item) => item.id === state.selection?.id && state.selection?.type === 'task');
  paintInspectorContext(project,task);
  if (project && !project.is_unassigned) {
    $('#project-inspector').innerHTML = `<form id="project-inspector-form" class="inspector-form">
      <div class="property-grid">
      <div class="inspector-field project-name-order"><span><label for="ins-project-name">${t("inspector.project_name")}</label></span><input id="ins-project-name" class="text-input" autocomplete="off" value="${esc(project.name)}" required><input id="ins-project-order" class="text-input" type="number" min="1" max="${state.data.projects.filter(p=>!p.is_unassigned).length}" step="1" aria-label="${t("timeline.default_order")}" title="${t("timeline.default_order")}" value="${project.sort_order ?? ''}" required></div>
      <div class="inspector-field"><span><label for="ins-project-color">${t("inspector.project_color")}</label></span><div class="color-field"><input id="ins-project-color" type="color" value="${esc(project.color || '#5872d9')}"><code>${esc(project.color || '#5872d9')}</code>${randomColorButton()}</div></div>
      <label class="inspector-field"><span>${t("inspector.start_date")}</span><input id="ins-project-start" type="date" class="text-input" value="${esc(project.start_date)}"></label>
      <label class="inspector-field"><span>${t("inspector.calendar")}</span><select id="ins-project-calendar" class="select-input"><option value="working" ${project.calendar_type === 'working' ? 'selected' : ''}>${t("inspector.5_day_week_mon_fri")}</option><option value="calendar" ${project.calendar_type === 'calendar' ? 'selected' : ''}>${t("inspector.7_day_week")}</option></select></label>
      <div class="inspector-field property-readonly"><span>${t("inspector.planned_range")} <span class="info-tip"><button type="button" class="info-tip-button" aria-label="${t("inspector.planned_range_help")}" aria-describedby="project-dates-tooltip">i</button><span id="project-dates-tooltip" class="info-tip-text" role="tooltip">${t("inspector.changing_the_batch_start_or_calendar")}</span></span></span><div class="derived-date"><small>${project.calendar_type === 'working' ? t("inspector.5_day_week_excludes_weekends_and") : t("inspector.7_day_week")}</small><b>${fmtDate(project.tasks.map((item) => item.planned_start).filter(Boolean).sort()[0], true)} — ${fmtDate(project.tasks.map((item) => item.planned_finish).filter(Boolean).sort().at(-1), true)}</b></div></div>
      <label class="inspector-field"><span>${t("inspector.group")}</span><input id="ins-project-group" class="text-input" value="${esc(project.group_name || '')}" placeholder="${t("inspector.group_placeholder")}"></label>
      <label class="inspector-field"><span>${t("inspector.tags")} <small>${t("inspector.comma_separated")}</small></span><input id="ins-project-tags" class="text-input" value="${esc((project.tags || []).join(', '))}" placeholder="${t("inspector.tags_placeholder")}"></label>
      </div>
      <small class="project-autosave-state" role="status" aria-live="polite"></small>
      <div class="inspector-actions"><button class="button delete-button" id="ins-project-delete" type="button">${t("project.delete")}</button><button class="button complete-button" id="ins-project-complete" type="button" ${project.tasks.length ? '' : 'disabled'}>${t("project.complete")}</button></div>
    </form>`;
  } else if (project?.is_unassigned) {
    $('#project-inspector').innerHTML = `<div class="inspector-empty"><b>${t("inspector.no_project")}</b><small>${t("inspector.select_a_task_and_use_the")}</small></div>`;
  } else {
    $('#project-inspector').innerHTML = `<div class="inspector-empty"><span>▤</span><b>${t("inspector.select_a_project")}</b><small>${t("inspector.select_a_project_row_in_the")}</small></div>`;
  }
  if (task && project) {
    const relatedTasks = relationRows(project,task,state.data.projects);
    $('#task-inspector').innerHTML = `
      <form id="task-inspector-form" class="inspector-form">
        <div class="property-grid">
        <div class="inspector-field task-name-order"><span><label for="ins-task-name">${t("timeline.task_name")}</label></span><input id="ins-task-name" class="text-input" value="${esc(task.name)}" required><input id="ins-task-order" class="text-input" type="number" min="1" max="${project.tasks.length}" step="1" aria-label="${t("timeline.default_order")}" title="${t("timeline.default_order")}" value="${task.sort_order ?? ''}" required></div>
        <div class="inspector-field"><span><label for="ins-task-color">${t("inspector.task_color")}</label></span><div class="color-field"><input id="ins-task-color" type="color" value="${esc(task.color || project.color || '#5872d9')}"><code>${esc(task.color || project.color || '#5872d9')}</code>${randomColorButton()}</div></div>
        ${taskDateGrid(`<input id="ins-task-planned-start" aria-label="${t("timeline.planned_start")}" type="date" class="text-input" value="${esc(task.planned_start)}" required>`, `<input id="ins-task-planned-finish" aria-label="${t("timeline.planned_finish")}" type="date" class="text-input" value="${esc(task.planned_finish)}" required>`, `<input id="ins-task-actual-start" aria-label="${t("inspector.actual_start")}" type="date" class="text-input" value="${esc(task.actual_start || '')}">`, `<input id="ins-task-actual-finish" aria-label="${t("inspector.actual_finish")}" type="date" class="text-input" value="${esc(task.actual_finish || '')}">`)}
        <label class="inspector-field"><span>${t("inspector.group")}</span><input id="ins-task-group" class="text-input" value="${esc(task.group_name || '')}" placeholder="${t("inspector.group_placeholder")}"></label>
        <label class="inspector-field"><span>${t("timeline.owner_vendor")}</span><input id="ins-task-owner" class="text-input" value="${esc(task.owner || '')}" placeholder="${t("inspector.owner_placeholder")}"></label>
        <div class="inspector-field task-status-help" data-hover-help="${esc(t("help.progress_knob_stop"))}"><span><button type="button" class="status-help-trigger" aria-describedby="floating-help">${t("calendar.status")}</button></span><div class="task-progress-control" style="${paletteStyle(task.color)}"><div class="task-progress-track"><div class="task-progress-fill"></div><button type="button" id="task-progress-knob" aria-describedby="floating-help" class="task-progress-knob" role="slider" aria-label="${t("inspector.task_progress")}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${taskProgress(task)}"></button></div><output id="task-progress-label"></output></div></div>
        <label id="ins-task-blocker-row" class="inspector-field${task.status === 'blocked' ? '' : ' hidden'}"><span>${t("inspector.stopped_waiting_reason")}</span><input id="ins-task-blocker" class="text-input" value="${esc(task.blocker || '')}" placeholder="${t("inspector.blocker_placeholder")}"></label>
        <div class="inspector-field property-relations"><div class="inspector-relations"><table aria-label="${t("inspector.predecessors_and_successors")}"><thead><tr><th scope="col" class="relation-heading">${t("relations.title")} <span class="info-tip relation-info"><button type="button" class="info-tip-button" aria-label="${t("inspector.predecessor_successor_help")}" aria-describedby="task-relations-help">i</button><span id="task-relations-help" class="info-tip-text" role="tooltip">${t("inspector.predecessor_before_this_task_successor_after")}<br>${t("inspector.select_multiple_tasks")}</span></span></th><th scope="col">${t("inspector.predecessors")}</th><th scope="col">${t("inspector.successors")}</th></tr></thead><tbody>${relatedTasks.map(item=>`<tr class="${item.id===task.id?'relation-current-task':''}"><th scope="row"><span class="relation-task-label"><span class="relation-project-badge" ${item.showRelationProject?'':'hidden'} style="background:${colorPalette(item.relationProjectColor).base};color:${colorPalette(item.relationProjectColor).ink}" title="${esc(item.relationProjectLabel)}">${esc(item.relationProjectOrder)}</span><span class="relation-task-dot" style="background:${colorPalette(item.color).base}" aria-hidden="true"></span><span class="relation-task-name">${item.relationProjectName?`<small class="relation-project-name">${esc(item.relationProjectName)}</small>`:''}${esc(item.name)}</span></span></th><td><input type="checkbox" class="ins-task-dependency" value="${esc(item.id)}" aria-label="${esc(item.name)} ${t('inspector.predecessors')}" ${item.id===task.id?'disabled':''} ${task.dependencies.includes(item.id)?'checked':''}></td><td><input type="checkbox" class="ins-task-successor" value="${esc(item.id)}" aria-label="${esc(item.name)} ${t('inspector.successors')}" ${item.id===task.id?'disabled':''} ${(item.dependencies||[]).includes(task.id)?'checked':''}></td></tr>`).join('')}<tr><td colspan="3" class="relation-add-cell"><button id="add-external-relation" type="button" aria-label="${t('relations.add_external')}">＋</button></td></tr></tbody></table></div></div>
        <label class="inspector-field"><span>${t("inspector.tags")} <small>${t("inspector.comma_separated")}</small></span><input id="ins-task-tags" class="text-input" value="${esc((task.tags || []).join(', '))}" placeholder="${t("inspector.tags_placeholder")}"></label>
        <label class="inspector-field"><span>${t("inspector.notes")}</span><textarea id="ins-task-notes" class="text-area" rows="3" placeholder="${t("inspector.notes_placeholder")}">${esc(task.notes || '')}</textarea></label>
        </div>
        <small class="task-autosave-state" role="status" aria-live="polite">${t("inspector.changes_are_saved_when_you_leave")}</small>
        <div class="inspector-actions"><button class="button delete-button" id="ins-task-delete" type="button">${t("task.delete")}</button><button class="button complete-button" id="ins-task-complete" type="button">${t("task.complete")}</button></div>
      </form>`;
  } else {
    $('#task-inspector').innerHTML = `<div class="inspector-empty"><span>⌁</span><b>${t("inspector.select_a_task")}</b><small>${t("inspector.click_a_task_name_or_bar")}</small></div>`;
  }
  if(task) $('#add-external-relation').onclick=event=>openExternalRelationPicker(task.id,project.id,event.currentTarget);
  bindInspector(project, task);
  bindTagColors();
  if (project && !project.is_unassigned) $('#ins-project-delete').onclick = () => deleteInspectorItem('projects', project.id, project.name);
  if (project && !project.is_unassigned) $('#ins-project-complete').onclick = () => completeProject(project.id);
  if (task) $('#ins-task-delete').onclick = () => deleteInspectorItem('tasks', task.id, task.name);
  syncAccordionVisibility();
}

const chartActions = ChartEditing.createActions();
async function completeProject(projectId) {
  try {
    await chartActions.run(`complete-project:${projectId}`,()=>api(`/api/projects/${encodeURIComponent(projectId)}/complete`, {method:'POST', body:'{}'}));
    toast(t("project.completed"));
  } catch (error) { toast(error.message); }
}

async function deleteInspectorItem(kind, id, name) {
  if (!window.confirm(t(kind === 'projects' ? "project.delete_confirm" : "task.delete_confirm", {p0:name}))) return;
  try {
    await api(`/api/${kind}/${encodeURIComponent(id)}`, {method:'DELETE'});
    if (state.selection?.id === id) state.selection = null;
    if (kind === 'projects' && state.filterProject === id) state.filterProject = null;
    persistUi();
    toast(t("common.deleted"));
  } catch (error) { toast(error.message); }
}

function openTaskProjectMenu(taskId) {
  document.querySelector('#task-project-menu')?.closeMenu();
  const trigger = $('#project-context-label');
  const current = state.data.projects.find(project => project.tasks.some(task => task.id === taskId));
  const choices = [{id:null, name:t("inspector.no_project"), color:'#94a3b8'}, ...state.data.projects.filter(project => !project.is_unassigned)];
  const menu = document.createElement('div');
  menu.id = 'task-project-menu'; menu.className = 'task-context-menu project-picker'; menu.setAttribute('role','menu');
  menu.innerHTML = choices.map((project, index) => `<button type="button" role="menuitemradio" aria-checked="${project.id === current?.id || (!project.id && current?.is_unassigned) ? 'true' : 'false'}" data-choice="${index}"><i style="background:${colorPalette(project.color).base}" aria-hidden="true"></i><span>${esc(project.is_unassigned ? t("inspector.no_project") : project.name)}</span><small>${esc(project.color)}</small></button>`).join('') + `<p>${t("inspector.moving_a_task_removes_its_existing")}</p>`;
  document.body.append(menu);
  const rect = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, innerHeight - menu.offsetHeight - 8))}px`;
  trigger.setAttribute('aria-expanded','true');
  function close() { menu.remove(); trigger.setAttribute('aria-expanded','false'); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keyboard); }
  menu.closeMenu = close;
  function outside(event) { if (!menu.contains(event.target) && event.target !== trigger) close(); }
  function keyboard(event) {
    const buttons = [...menu.querySelectorAll('button')];
    if (event.key === 'Escape') { close(); trigger.focus({preventScroll:true}); }
    if (['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); buttons[(buttons.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus(); }
  }
  document.addEventListener('pointerdown', outside); document.addEventListener('keydown', keyboard);
  menu.querySelector('[aria-checked="true"]')?.focus({preventScroll:true});
  menu.addEventListener('click', async event => {
    const button = event.target.closest('[data-choice]');
    if (!button) return;
    const destination = choices[Number(button.dataset.choice)];
    close();
    const request = (async () => {
      const project = await api(`/api/tasks/${encodeURIComponent(taskId)}/project`, {method:'PATCH',body:JSON.stringify({project_id:destination.id})});
      persistUi();
      toast(t("inspector.task_moved_to", {p0:destination.name}));
    })();
      try { await request; } catch(error) { toast(error.message); }
  });
}

const inspectorMotions = new WeakMap();
function animateInspectorSection(element, open) {
  const previous = inspectorMotions.get(element);
  if (previous?.open === open) return;
  if (!previous && element.classList.contains('hidden') === !open) return;
  const height = element.classList.contains('hidden') ? 0 : element.getBoundingClientRect().height;
  const opacity = element.classList.contains('hidden') ? 0 : Number(getComputedStyle(element).opacity);
  previous?.animation.cancel();
  element.classList.remove('hidden');
  element.inert = !open;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    element.classList.toggle('hidden', !open);
    inspectorMotions.delete(element);
    return;
  }
  const target = element.getBoundingClientRect().height;
  const padding = getComputedStyle(element);
  const animation = element.animate([
    {height:`${height}px`,opacity,overflow:'clip',paddingTop:height?padding.paddingTop:'0px',paddingBottom:height?padding.paddingBottom:'0px'},
    {height:`${open ? target : 0}px`,opacity:open?1:0,overflow:'clip',paddingTop:open?padding.paddingTop:'0px',paddingBottom:open?padding.paddingBottom:'0px'}
  ], {duration:180,easing:'linear',fill:'both'});
  const motion = {open,animation};
  inspectorMotions.set(element,motion);
  animation.finished.then(() => {
    if (inspectorMotions.get(element) !== motion) return;
    element.classList.toggle('hidden',!open);
    animation.cancel();
    inspectorMotions.delete(element);
  }, () => {});
}
function syncAccordionVisibility() {
  $('#inspector-save-state').textContent = state.selection ? t("inspector.auto_save") : t("inspector.nothing_selected");
  for (const section of ['project', 'task']) {
    const open = state.inspectorOpen === section;
    $(`#${section}-accordion`).setAttribute('aria-expanded', String(open));
    $(`#${section}-accordion .accordion-chevron`).textContent = open ? '⌄' : '›';
    animateInspectorSection($(`#${section}-inspector`), open);
  }
}

// Persistence and rollback are owned by the common journal.
function saveProjectField(projectId, fields) {
  return api(`/api/projects/${encodeURIComponent(projectId)}`, {method:'PATCH',body:JSON.stringify(fields)});
}
function bindInspectorProjection(form, inputs, valueFor, changed, errorText) {
  const fields = ChartEditing.createFields({inputs,valueFor,
    focused:input=>document.activeElement === input,changed,errorText});
  form.syncProjection = fields.sync;
  return fields;
}
function bindProjectAutoSave(form, project) {
  const fieldNames = { 'ins-project-name': 'name', 'ins-project-order': 'sort_order', 'ins-project-color': 'color', 'ins-project-start': 'start_date', 'ins-project-calendar': 'calendar_type', 'ins-project-group': 'group_name', 'ins-project-tags': 'tags' };
  form.entityId = project.id;
  const inputs = $$('input, select', form), status = $('.project-autosave-state', form);
  const fields = bindInspectorProjection(form,inputs,input => {
    const current = state.data.projects.find(item=>item.id===chartMutations.resolveId(project.id));
    return current?.[fieldNames[input.id]];
  },showStatus,error=>t("inspector.save_failed_leave_the_field_again", {p0:error.message}));
  function showStatus() {
    status.textContent = fields.errors.size ? [...fields.errors.values()][0] : fields.pending ? t("inspector.saving") : fields.dirty ? t("inspector.editing_leave_the_field_to_save") : t("inspector.saved_automatically");
    status.classList.toggle('save-error', fields.errors.size > 0);
  }
  async function save(input) {
    const key = fieldNames[input.id], value = input.value;
    if (!key || !fields.needsSave(input)) return;
    if (!input.checkValidity() || (key === 'name' && !value.trim()) || (key === 'start_date' && !value)) {
      fields.invalid(input, key === 'name' ? t("inspector.enter_a_project_name") : key === 'sort_order' ? t("inspector.valid_project_order") : t("inspector.enter_a_valid_date"));
      return;
    }
    if (key === 'sort_order') $('#sort-select').value = 'manual';
    try { await fields.save([input],()=>saveProjectField(project.id, { [key]: key === 'sort_order' ? Number(value) : value })); }
    catch (error) { if (!form.isConnected) toast(t("inspector.project_save_failed", {p0:error.message})); }
  }
  form.addEventListener('submit', event => event.preventDefault());
  for (const input of inputs) {
    input.addEventListener('input', () => fields.edit(input));
    input.addEventListener('blur', () => save(input));
    if (input.tagName === 'SELECT' || input.type === 'color') input.addEventListener('change', () => save(input));
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); input.blur(); }
    });
  }
}

function disableFieldSuggestions(root) {
  if (!root) return;
  root.setAttribute('autocomplete', 'off');
  $$('input, textarea, select', root).forEach(field => {
    field.setAttribute('autocomplete', 'off');
    field.setAttribute('autocorrect', 'off');
    field.setAttribute('autocapitalize', 'off');
    field.setAttribute('spellcheck', 'false');
    field.setAttribute('writingsuggestions', 'false');
  });
}

function taskProgress(task) { return task.progress ?? ({todo:0,doing:10,blocked:10,done:100}[task.status] || 0); }
function bindTaskProgress(form, task) {
  const knob = $('#task-progress-knob', form), track = knob.parentElement;
  const label = $('#task-progress-label', form);
  let progress = taskProgress(task), stopped = task.status === 'blocked', drag = null;
  function paint() {
    track.style.setProperty('--progress', `${progress}%`);
    knob.classList.toggle('stopped', stopped); knob.textContent = stopped ? '−' : '';
    const text = stopped ? t("task.stopped", {p0:progress}) : progress === 0 ? t("task.planned_0") : progress === 100 ? t("task.complete_100") : t("task.in_progress", {p0:progress});
    label.textContent = text; knob.setAttribute('aria-valuenow', progress); knob.setAttribute('aria-valuetext', text);
    $('#ins-task-blocker-row', form).classList.toggle('hidden', !stopped);
  }
  form.syncProgress = () => {
    if (drag) return;
    const current = state.data.projects.flatMap(project=>project.tasks).find(item=>item.id===chartMutations.resolveId(task.id));
    if (!current) return;
    progress=taskProgress(current);stopped=current.status==='blocked';paint();
  };
  async function commit() {
    const status = stopped ? 'blocked' : progress === 0 ? 'todo' : progress === 100 ? 'done' : 'doing';
    try { await saveTaskFields(task.id, {progress, status}); }
    catch(error) { toast(t("task.progress_save_failed", {p0:error.message})); }
  }
  knob.addEventListener('pointerdown', event => {
    if(event.button !== 0 || !event.isPrimary) return;
    event.preventDefault(); knob.setPointerCapture(event.pointerId);
    drag = {id:event.pointerId,x:event.clientX,progress,stopped,moved:false};
  });
  knob.addEventListener('pointermove', event => {
    if(!drag || drag.id!==event.pointerId) return;
    if(Math.abs(event.clientX-drag.x)>3) drag.moved=true;
    if(!drag.moved) return;
    progress = Math.max(0,Math.min(100,Math.round((drag.progress+(event.clientX-drag.x)/track.getBoundingClientRect().width*100)/10)*10));
    stopped=false; paint();
  });
  knob.addEventListener('pointerup', event => {
    if(!drag || drag.id!==event.pointerId) return;
    if(!drag.moved) stopped=!stopped;
    drag=null; paint(); commit();
  });
  knob.addEventListener('pointercancel', () => {if(drag){progress=drag.progress;stopped=drag.stopped;drag=null;paint();}});
  knob.addEventListener('keydown', event => {
    if(!['ArrowLeft','ArrowDown','ArrowRight','ArrowUp','Home','End',' ','Enter'].includes(event.key)) return;
    event.preventDefault();
    if([' ','Enter'].includes(event.key)) stopped=!stopped;
    else {stopped=false;progress=event.key==='Home'?0:event.key==='End'?100:Math.max(0,Math.min(100,progress+(['ArrowRight','ArrowUp'].includes(event.key)?10:-10)));}
    paint();commit();
  });
  paint();
}

// Delegate once so every page and dynamically rendered editing cell agrees.
function bindTextCellSelection(root) {
  // Native selection dragging must not become a chart-row reorder operation.
  root.addEventListener('dragstart', event => {
    if (event.target.closest('input, textarea')) event.stopPropagation();
  }, true);
  root.addEventListener('dblclick', event => {
    const input = event.target.closest('input, textarea');
    if (!input || input.disabled || event.button !== 0) return;
    if (input.tagName !== 'TEXTAREA' && !['text','search','url','tel','email','password','number'].includes(input.type)) return;
    event.preventDefault();
    input.focus({preventScroll:true});
    input.select();
  });
}

function bindInspector(project, task) {
  const projectForm = $('#project-inspector-form');
  if (projectForm && project) bindProjectAutoSave(projectForm, project);
  const taskForm = $('#task-inspector-form');
  disableFieldSuggestions(taskForm);
  if (taskForm && project && task) {
    bindTaskProgress(taskForm, task);
    $$('.inspector-relations input', taskForm).forEach((input) => input.addEventListener('change', () => {
      if (input.checked) {
        const opposite = input.classList.contains('ins-task-dependency') ? '.ins-task-successor' : '.ins-task-dependency';
        $(opposite, input.closest('tr')).checked = false;
      }
    }));
    syncRelationRowOrder(project,task,taskForm);
    bindTaskAutoSave(taskForm, task);
    $('#ins-task-complete').addEventListener('click', async () => {
      try { await chartActions.run(`complete-task:${task.id}`,()=>saveTaskFields(task.id, {status:'done'})); toast(t("task.marked_complete")); } catch (error) { toast(error.message); }
    });
  }
}

// Inspector, menu, modal and drag changes share the same optimistic journal.
function saveTaskFields(taskId, fields) {
  let path = `/api/tasks/${encodeURIComponent(taskId)}`, payload = fields;
  if (Object.hasOwn(fields, 'sort_order')) {
    const current = state.data.projects.find(item => item.tasks.some(task => task.id === taskId));
    const tasks = [...(current?.tasks || [])].sort((a,b)=>a.sort_order-b.sort_order);
    const position = fields.sort_order;
    if (!Number.isInteger(position) || position < 1 || position > tasks.length) return Promise.reject(new Error(t("task.check_the_input_value")));
    payload = {anchor_id:tasks[position - 1].id,after:tasks.findIndex(task=>task.id === taskId) < position - 1};
    path += '/order';
    $('#sort-select').value = 'manual';
  }
  const request = api(path, {method:'PATCH',body:JSON.stringify(payload)});
  return request;
}
function bindTaskAutoSave(form, task) {
  const names = { name:'name', order:'sort_order', color:'color', 'planned-start':'planned_start', 'planned-finish':'planned_finish', 'actual-start':'actual_start', 'actual-finish':'actual_finish', group:'group_name', tags:'tags', owner:'owner', status:'status', blocker:'blocker', notes:'notes' };
  form.entityId = task.id;
  const inputs = $$('input, select, textarea', form), status = $('.task-autosave-state', form);
  const fields = bindInspectorProjection(form,inputs,input => {
    const current = state.data.projects.flatMap(project=>project.tasks).find(item=>item.id===chartMutations.resolveId(task.id));
    if (input.type === 'checkbox') {
      if (!current) return undefined;
      if (input.classList.contains('ins-task-dependency')) return current.dependencies.includes(input.value);
      return state.data.projects.flatMap(project=>project.tasks).find(item=>item.id===input.value)?.dependencies.includes(current.id);
    }
    return current?.[names[input.id.replace('ins-task-', '')]];
  },showStatus,error=>t("task.save_failed_leave_the_field_again", {p0:error.message}));
  function showStatus() {
    status.textContent = fields.errors.size ? [...fields.errors.values()][0] : fields.pending ? t("inspector.saving") : fields.dirty ? t("inspector.editing_leave_the_field_to_save") : t("inspector.saved_automatically");
    status.classList.toggle('save-error', fields.errors.size > 0);
  }
  async function save(input) {
    const value = input.type === 'checkbox' ? input.checked : input.value;
    if (!fields.needsSave(input)) return;
    if (!input.checkValidity() || (input.id === 'ins-task-name' && !value.trim())) {
      fields.invalid(input,t("task.check_the_input_value"));return;
    }
    const payload = { cascade_dependents: state.cascadeDependents };
    let affected = [input];
    if (input.type === 'checkbox') {
      payload.dependencies = $$('.ins-task-dependency:checked', form).map(node => node.value);
      payload.successors = $$('.ins-task-successor:checked', form).map(node => node.value);
      affected = $$('.inspector-relations input', form);
    } else payload[names[input.id.replace('ins-task-', '')]] = input.id === 'ins-task-order' ? Number(value) : value;
    try { await fields.save(affected,()=>saveTaskFields(task.id,payload)); }
    catch (error) { toast(error.message); }
  }
  form.addEventListener('submit', event => { event.preventDefault(); document.activeElement?.blur(); });
  for (const input of inputs) {
    input.addEventListener('input', () => fields.edit(input));
    input.addEventListener('blur', () => save(input));
    if (input.tagName === 'SELECT' || ['color', 'checkbox'].includes(input.type)) input.addEventListener('change', () => save(input));
    input.addEventListener('keydown', event => {
      if (['Escape', 'Backspace'].includes(event.key) && input.type === 'date' && !event.isComposing) {
        event.preventDefault();event.stopPropagation();input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));fields.edit(input);
        if (!input.required) save(input);
        else status.textContent = t("task.enter_a_planned_date_to_save");
        return;
      }
      if (event.key === 'Enter' && input.tagName !== 'TEXTAREA' && !event.isComposing) { event.preventDefault(); input.blur(); }
    });
  }
}

async function completeTask(taskId) {
  const task = state.data.projects.flatMap(project => project.tasks).find(item => item.id === taskId);
  if (!task) return;
  await chartActions.run(`complete-task:${taskId}`,()=>saveTaskFields(taskId, { status: 'done', actual_start: task.actual_start || todayInput(), actual_finish: task.actual_finish || (task.actual_start > todayInput() ? task.actual_start : todayInput()), cascade_dependents: state.cascadeDependents }));
  toast(t("task.marked_complete"));
}
function openTaskMenu(event) {
  const bar = event.target.closest('.task-bar, .actual-task-bar');
  if (!bar || !bar.dataset.taskSelect) return;
  event.preventDefault();
  document.querySelector('#task-context-menu')?.closeMenu();
  const taskId = bar.dataset.taskSelect;
  const menu = document.createElement('div');
  menu.id = 'task-context-menu'; menu.className = 'task-context-menu'; menu.setAttribute('role', 'menu');
  menu.innerHTML = `<button type="button" role="menuitem" data-action="complete">${t("task.mark_complete")}</button><button type="button" role="menuitem" data-action="actual">${t("task.show_actual_start_finish")}</button>`;
  document.body.append(menu);
  menu.style.left = `${Math.max(8, Math.min(event.clientX, innerWidth - menu.offsetWidth - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(event.clientY, innerHeight - menu.offsetHeight - 8))}px`;
  function close() { menu.remove(); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', keyboard); window.removeEventListener('scroll', close, true); }
  menu.closeMenu = close;
  function outside(e) { if (!menu.contains(e.target)) close(); }
  function keyboard(e) {
    const buttons = [...menu.querySelectorAll('button')];
    if (e.key === 'Escape') { close(); bar.focus({preventScroll:true}); }
    if (['ArrowDown','ArrowUp'].includes(e.key)) { e.preventDefault(); buttons[(buttons.indexOf(document.activeElement) + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus(); }
  }
  document.addEventListener('pointerdown', outside); document.addEventListener('keydown', keyboard); window.addEventListener('scroll', close, true);
  menu.querySelector('button').focus({preventScroll:true});
  menu.addEventListener('click', async e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (!action) return;
    close();
    try {
      if (action === 'complete') await completeTask(taskId);
      else {
        const task = state.data.projects.flatMap(project => project.tasks).find(item => item.id === taskId);
        if (!task.actual_start && !task.actual_finish) await saveTaskFields(taskId, { actual_start: todayInput(), cascade_dependents: state.cascadeDependents });
        selectItem('task', taskId);
        $('#ins-task-actual-start').focus({preventScroll:true});
      }
    } catch (error) { toast(error.message); }
  });
}
document.addEventListener('contextmenu', openTaskMenu);

async function saveDraggedTaskDates(taskId, fields, period) {
  const cascade = state.cascadeDependents;
  state.selection = { type:'task', id:taskId };
  state.inspectorOpen = 'task';
  persistUi();
  await saveTaskFields(taskId, {...fields,cascade_dependents:cascade});
  toast(period === 'actual' ? t("task.actual_dates_saved") : cascade ? t("task.task_dates_and_connected_successor_schedules") : t("task.task_dates_saved"));
}

function shiftIsoDate(value, days) {
  const shifted = dateFrom(value);
  shifted.setDate(shifted.getDate() + days);
  return dateKey(shifted);
}

function projectTemplatePayload(project, name) {
  if (!name.trim()) throw new Error(t('template.enter_a_template_name'));
  if (!project?.tasks?.length) throw new Error(t('template.import_empty'));
  const tasks = [...project.tasks].sort((a,b) => (a.sort_order || 0)-(b.sort_order || 0));
  const keys = new Map(tasks.map((task,index) => [task.id,`task_${index+1}`]));
  if (tasks.some(task => !/^\d{4}-\d{2}-\d{2}$/.test(task.planned_start || '') || !/^\d{4}-\d{2}-\d{2}$/.test(task.planned_finish || '') || task.planned_finish < task.planned_start)) throw new Error(t('template.import_dates_invalid'));
  const start = tasks.map(task => task.planned_start).sort()[0];
  return {name:name.trim(),description:'',project_color:project.color,group_name:project.group_name || '',tags:project.tags || [],calendar_type:'calendar',tasks:tasks.map(task => ({
    key:keys.get(task.id),name:task.name,start_day:dayDiff(start,task.planned_start)+1,
    duration_value:dayDiff(task.planned_start,task.planned_finish)+1,duration_unit:'days',
    dependencies:(task.dependencies || []).filter(id => keys.has(id)).map(id => keys.get(id)),
    owner:task.owner || '',handoff:task.handoff || '',color:task.color,group_name:task.group_name || '',tags:task.tags || []
  }))};
}
async function openProjectTemplateImport() {
  try {
    await templateSaveQueue;
    const latest = await api('/api/state');
    const projects = latest.projects.filter(project => !project.is_unassigned && project.id !== '__unassigned__' && project.tasks.length);
    if (!projects.length) { toast(t('template.import_empty')); return; }
    const body = `<div class="form-grid"><label class="form-field full"><span class="field-label">${t('timeline.project')}</span><select id="template-source-project" class="select-input">${projects.map(project => `<option value="${esc(project.id)}">${esc(project.name)}</option>`).join('')}</select></label><label class="form-field full"><span class="field-label">${t('template.template_name')}</span><input id="import-template-name" class="text-input" value="${esc(projects[0].name)}" required></label></div>`;
    const footer = `<span></span><button type="button" id="confirm-template-import" class="button button-primary">${t('template.save')}</button>`;
    openModal(t('template.import_project'),t('template.import_description'),body,footer,() => {
      $('#template-source-project').addEventListener('change',event => { $('#import-template-name').value=projects.find(project=>project.id===event.target.value).name; });
      $('#confirm-template-import').addEventListener('click',async event => {
        const button=event.currentTarget;button.disabled=true;
        try {
          const project=projects.find(project=>project.id===$('#template-source-project').value);
          const saved=await api('/api/templates',{method:'POST',body:JSON.stringify(projectTemplatePayload(project,$('#import-template-name').value))});
          state.selectedTemplateId=saved.id;state.draft=normalizedTemplate(saved);
          state.templateTaskKey='__project__';state.templateProjectCollapsed=false;
          closeModal();renderTemplates();
        } catch(error) { if ($('#modal-error')) setModalError(error.message); else toast(error.message); }
        finally { if (button.isConnected) button.disabled=false; }
      });
    });
  } catch(error) { toast(error.message); }
}
function normalizedTemplate(template) {
  const idToKey = Object.fromEntries(template.tasks.map((task) => [task.id, task.key]));
  return { ...template, tasks: template.tasks.map((task) => ({ ...task, dependencies: task.dependencies.map((id) => idToKey[id] || id) })) };
}
function renderTemplateList() {
  const templates = state.data.templates;
  $('#template-count').textContent = templates.length;
  $('#template-list').innerHTML = templates.map((template) => `<div class="template-card ${template.id === state.selectedTemplateId ? 'selected' : ''}" data-template="${esc(template.id)}"><b class="template-name-with-color"><i class="template-color-dot" aria-hidden="true" style="background:${colorPalette(template.project_color || projectColors[0]).base}"></i>${esc(template.name)}</b><span>${template.tasks.length}${t("task.tasks")} ${(template.description || t("task.no_description")).slice(0, 36)}</span></div>`).join('');
  $$('.template-card').forEach((card) => card.addEventListener('click', () => {
    state.selectedTemplateId = card.dataset.template;
    state.draft = normalizedTemplate(templates.find((item) => item.id === state.selectedTemplateId));
    state.preview = null;
    renderTemplates();
  }));
}
function renderTemplates() {
  renderTemplateList();
  const selected = state.data.templates.find((template) => template.id === state.selectedTemplateId);
  if (!state.draft && selected) state.draft = normalizedTemplate(selected);
  renderTemplateEditor();
}
// Relative-day projection shares the server's legacy forward-pass behavior.
function templateSchedule(tasks, calendar = 'working') {
  const result = new Map(), visiting = new Set();
  const byKey = new Map(tasks.map(t => [t.key, t]));
  function visit(task) {
    if (result.has(task.key)) return result.get(task.key);
    if (visiting.has(task.key)) throw new Error(t("task.task_dependencies_contain_a_cycle"));
    visiting.add(task.key);
    let earliest = 1;
    for (const key of task.dependencies || []) {
      if (!byKey.has(key)) throw new Error(t("task.predecessor_not_found"));
      earliest = Math.max(earliest, visit(byKey.get(key)).end + 1);
    }
    const start = task.start_day ?? earliest;
    const duration = Math.max(1, Number(task.duration_value) || 1) * (task.duration_unit === 'weeks' ? (calendar === 'working' ? 5 : 7) : 1);
    const row = {task, start, end: start + duration - 1};
    visiting.delete(task.key); result.set(task.key, row); return row;
  }
  return tasks.map(visit);
}
// Apply one end-offset to every reachable successor, including joins only once.
// Materialize implicit positions so an unchecked edit cannot move successors indirectly.
function updateTemplateSchedule(taskKey, fields) {
  const tasks = state.draft.tasks;
  const before = templateSchedule(tasks);
  const original = before.find(row => row.task.key === taskKey);
  const candidate = tasks.map(task => ({...task}));
  const edited = candidate.find(task => task.key === taskKey);
  Object.assign(edited, fields);
  const after = templateSchedule(candidate).find(row => row.task.key === taskKey);
  const offset = state.cascadeDependents ? after.end - original.end : 0;
  const reachable = new Set([taskKey]);
  for (const key of reachable) {
    for (const task of tasks) if ((task.dependencies || []).includes(key)) reachable.add(task.key);
  }
  for (const row of before) {
    if (row.task.key !== taskKey && reachable.has(row.task.key)) {
      candidate.find(task => task.key === row.task.key).start_day = row.start + offset;
    }
  }
  if (candidate.some(task => task.start_day != null && (!Number.isInteger(task.start_day) || task.start_day < 1 || task.start_day > 10000))) {
    throw new Error(t("task.start_dates_including_successors_must_be"));
  }
  templateSchedule(candidate);
  candidate.forEach((task, index) => Object.assign(tasks[index], task));
}
// Stored template days remain one-based for compatibility; the UI starts at D.
function templateDayLabel(day) { return day === 1 ? 'D' : t("template.d", {p0:day - 1}); }
function fitTemplateDayLabels(chart) {
  for (const cell of chart.querySelectorAll('.template-day')) {
    const text = cell.querySelector('span');
    const day = Number(cell.dataset.day);
    const full = templateDayLabel(day);
    const candidates = day === 1 ? [full] : [full, `+${day-1}`, String(day-1)];
    const range = document.createRange();
    for (const candidate of candidates) {
      text.textContent = candidate;
      range.selectNodeContents(text);
      if (range.getBoundingClientRect().width <= cell.clientWidth) break;
    }
  }
}
function templateWeekendMarkup(days, px, calendar) {
  let html='';
  for(let day=1;day<days;day++) {
    if(calendar==='calendar') {
      const weekend=day%7===6?'saturday':day%7===0?'sunday':'';
      if(weekend) html+=`<div class="date-shade weekend-shade weekend-${weekend}" style="left:${day*px}px;width:${px}px"></div>`;
    } else if(day>=6 && (day-6)%5===0) {
      html+=`<div class="template-week-break" style="left:${day*px}px"></div>`;
    }
  }
  return `<div class="row-date-shading" aria-hidden="true">${html}</div>`;
}
function renderTemplateGantt() {
  labelWidthMotion?.cancel();
  const chart = $('#template-gantt');
  if (!chart) return;
  let rows;
  try { rows = templateSchedule(state.draft.tasks); }
  catch (error) { chart.innerHTML = `<p class="preview-error">${esc(error.message)}</p>`; return; }
  if (state.templateRangeDraft !== state.draft) {
    state.templateRangeDraft = state.draft;
    state.templateVisibleDays = 45;
  }
  const requiredDays = Math.max(45, ...rows.map(row => row.end));
  state.templateVisibleDays = Math.max(state.templateVisibleDays, 45 + Math.ceil((requiredDays - 45) / 15) * 15);
  const labelsExpanded = mobileLayout() ? Boolean(state.mobileLabelsExpanded) : state.desktopLabelsExpanded !== false;
  const px = state.templateZoom || 46, label = labelsExpanded ? 254 : 36, days = state.templateVisibleDays;
  chart.style.setProperty('--label-width', `${label}px`);
  chart.classList.toggle('labels-collapsed', !labelsExpanded);
  const weekendMarkup=templateWeekendMarkup(days,px,state.draft.calendar_type);
  const projectStart = rows.length ? Math.min(...rows.map(r => r.start)) : 1;
  const projectEnd = Math.max(1, ...rows.map(r => r.end));
  const projectRow = `<div class="gantt-row project-row ${state.templateTaskKey === '__project__' ? 'selected-row' : ''}"><div class="gantt-left project-left"><button class="project-select" data-template-project aria-pressed="${state.templateTaskKey === '__project__'}"><i class="group-dot" style="background:${colorPalette(state.draft.project_color || projectColors[0]).base}"></i><span class="project-name">${esc(state.draft.name || t("template.new_project"))}</span><span class="project-meta">${rows.length}${t("template.tasks")}</span></button></div><div class="gantt-right project-timeline" style="width:${days*px}px">${weekendMarkup}<button class="project-summary-bar" data-template-project style="left:${(projectStart-1)*px}px;width:${(projectEnd-projectStart+1)*px}px;${paletteStyle(state.draft.project_color || projectColors[0], 'bar')}"><span>${templateDayLabel(projectStart)}–${templateDayLabel(projectEnd)}</span></button></div></div>`;
  const scroll = chart.scrollLeft, scrollTop = chart.scrollTop;
  chart.innerHTML = `<div class="template-chart-content" style="${paletteStyle(state.draft.project_color || projectColors[0], 'project')};width:${label+days*px}px;--day-width:${px}px"><div class="gantt-head"><div class="gantt-left gantt-head-left"><button type="button" class="gantt-label-toggle" aria-expanded="${labelsExpanded}" aria-label="${t("timeline.project_task_column")}"><span class="gantt-label-title">${t("timeline.project_task")}</span><span aria-hidden="true">${labelsExpanded ? '‹' : '›'}</span></button></div><div class="gantt-right date-axis">${weekendMarkup}${Array.from({length:days},(_,i)=>`<div class="template-day" data-day="${i+1}" title="${esc(templateDayLabel(i+1))}" aria-label="${esc(templateDayLabel(i+1))}"><span>${templateDayLabel(i+1)}</span></div>`).join('')}</div></div><div class="gantt-body" style="height:${76+rows.length*36}px">${projectRow}${rows.map(({task,start,end},index)=>`<div class="gantt-row task-row ${task.key===state.templateTaskKey?'selected-row':''}"><div class="gantt-left task-left"><button class="task-label" draggable="true" data-template-select="${esc(task.key)}"><span class="task-state task-order" style="${paletteStyle(task.color || taskColors[0], 'task')}" aria-label="${t("timeline.default_order")} ${index+1}">${index+1}</span><span class="task-name">${esc(task.name)}</span></button></div><div class="gantt-right project-timeline" style="width:${days*px}px">${weekendMarkup}<button class="task-bar template-bar ${task.key===state.templateTaskKey?'template-selected':''}" data-template-select="${esc(task.key)}" data-task-select="${esc(task.key)}" style="left:${(start-1)*px}px;width:${(end-start+1)*px}px;${paletteStyle(task.color || taskColors[0], 'bar')}" title="${esc(task.name)} · ${templateDayLabel(start)}–${templateDayLabel(end)}"><span class="resize-handle resize-start" data-template-edge="start"></span><span class="bar-text">${esc(task.name)} · ${templateDayLabel(start)}–${templateDayLabel(end)}</span><span class="resize-handle resize-end" data-template-edge="end"></span></button></div></div>`).join('')}${ganttAddRow('add-template-task',days*px)}</div></div>`;
  const content = $('.template-chart-content', chart), body = $('.gantt-body', chart);
  let width = label;
  if (mobileLayout() && labelsExpanded) {
    width = Math.ceil(Math.max(120, ...$$('.project-name, .task-name', chart).map(name => {
      const range = document.createRange(); range.selectNodeContents(name);
      const button = name.closest('button'), style = getComputedStyle(button);
      return range.getBoundingClientRect().width + (button.querySelector('.group-dot, .task-state')?.getBoundingClientRect().width || 0) +
        (parseFloat(style.columnGap) || 0) + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    }))) + 2;
  }
  chart.style.setProperty('--label-width', `${width}px`);
  content.style.width = body.style.width = `${width + days*px}px`;
  $('.gantt-head-left', chart).addEventListener('click', event => {
    toggleGanttLabels(chart);
    if (event.detail === 0) $('.gantt-label-toggle', chart).focus();
  });
  fitTemplateDayLabels(chart);
  $('#add-template-task').addEventListener('click', addTemplateTask);
  renderTemplateConnections();
  $('#template-range').textContent = `${templateDayLabel(projectStart)} — ${templateDayLabel(projectEnd)}`;
  chart.scrollLeft = scroll;
  chart.scrollTop = scrollTop;
  let previousLeft = scroll;
  chart.onscroll = () => {
    const movedRight = chart.scrollLeft > previousLeft;
    previousLeft = chart.scrollLeft;
    if (!movedRight || chart.scrollLeft + chart.clientWidth < chart.scrollWidth - 2) return;
    state.templateVisibleDays += 15;
    renderTemplateGantt();
  };
  for (const row of rows) {
    const fields = $(`[data-template-days="${CSS.escape(row.task.key)}"]`);
    if (fields) { $('.template-start-day', fields).value=row.start-1; $('.template-end-day', fields).value=row.end-1; }
  }
}
function renderTemplateConnections() {
  renderDependencyLinks({chart: $('#template-gantt'), projects: [{name: state.draft.name, tasks: state.draft.tasks.map(task => ({...task, id: task.key}))}]});
}
function attachTemplateDrag() {
  const chart = $('#template-gantt');
  let drag = null, suppressClick = false;
  chart.addEventListener('click', event => {
    if (suppressClick) { suppressClick=false; return; }
    if (event.target.closest('[data-template-project]')) { syncDraftFromEditor(); queueTemplateSave(); state.templateProjectCollapsed = !mobileLayout() && state.templateTaskKey === '__project__' && !state.templateProjectCollapsed; state.templateTaskKey='__project__'; renderTemplateEditor(); setMobileDrawer('inspector'); return; }
    const button = event.target.closest('[data-template-select],.dependency-link[data-task-select]');
    if (!button) return;
    syncDraftFromEditor(); queueTemplateSave(); state.templateTaskKey=button.dataset.templateSelect || button.dataset.taskSelect; state.templateTaskCollapsed=false; renderTemplateEditor(); setMobileDrawer('inspector');
  });
  chart.addEventListener('keydown', event => {
    if (!['Enter', ' '].includes(event.key) || !event.target.matches('.dependency-link')) return;
    event.preventDefault(); syncDraftFromEditor(); queueTemplateSave(); state.templateTaskKey=event.target.dataset.taskSelect; state.templateTaskCollapsed=false; renderTemplateEditor(); setMobileDrawer('inspector');
  });
  chart.addEventListener('pointerdown', event => {
    const bar=event.target.closest('.template-bar');
    if (!bar || event.button!==0 || !event.isPrimary) return;
    event.preventDefault();
    const row=templateSchedule(state.draft.tasks).find(r=>r.task.key===bar.dataset.templateSelect);
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
    renderTemplateConnections();
  });
  chart.addEventListener('pointerup', event => {
    if (!drag || drag.id!==event.pointerId) return;
    const current=drag; drag=null;
    if (current.preview && current.delta) {
      try {
        updateTemplateSchedule(current.task.key, {start_day:current.preview.start, duration_value:current.preview.end-current.preview.start+1, duration_unit:'days'});
      } catch (error) { toast(error.message); renderTemplateGantt(); return; }
      state.templateTaskKey=current.task.key; state.templateTaskCollapsed=false; suppressClick=true;
      renderTemplateEditor();
      queueTemplateSave();
    }
  });
  chart.addEventListener('pointercancel', () => { drag=null; renderTemplateGantt(); });
}
function bindTemplateReordering() {
  const chart = $('#template-gantt');
  let sourceKey = null;
  chart.addEventListener('dragstart', event => {
    sourceKey = event.target.closest('.task-label[data-template-select]')?.dataset.templateSelect || null;
    if (sourceKey) { event.dataTransfer.effectAllowed='move'; event.dataTransfer.setData('text/plain',sourceKey); }
  });
  chart.addEventListener('dragover', event => {
    if (sourceKey && event.target.closest('.task-label[data-template-select]')) { event.preventDefault(); event.dataTransfer.dropEffect='move'; }
  });
  chart.addEventListener('drop', event => {
    const target=event.target.closest('.task-label[data-template-select]');
    if (!sourceKey || !target) return;
    event.preventDefault();
    const key=sourceKey; sourceKey=null;
    if (key===target.dataset.templateSelect) return;
    syncDraftFromEditor();
    const tasks=state.draft.tasks, from=tasks.findIndex(task=>task.key===key);
    if (from<0) return;
    const [task]=tasks.splice(from,1), at=tasks.findIndex(task=>task.key===target.dataset.templateSelect);
    const rect=target.getBoundingClientRect();
    tasks.splice(at+(event.clientY>rect.top+rect.height/2?1:0),0,task);
    tasks.forEach((item,index)=>{item.sort_order=index;});
    state.templateTaskKey=key; state.templateTaskCollapsed=false;
    renderTemplateEditor(); queueTemplateSave();
  });
  chart.addEventListener('dragend',()=>{sourceKey=null;});
}
function templateTaskProperties(task, index, tasks) {
  return `<section class="template-properties-card inspector-form"><div class="property-grid" data-template-days="${esc(task.key)}">${templateTaskRow(task,index,tasks)}</div><div class="inspector-actions"><button class="button delete-button remove-task" data-index="${index}" type="button">${t("task.delete")}</button><button id="save-template-task" class="button save-button" type="button">${t("task.save")}</button></div></section>`;
}
function attachTemplateDayFields() {
  $$('[data-template-days]').forEach(fields => {
    const task=state.draft.tasks.find(t=>t.key===fields.dataset.templateDays);
    const startField=$('.template-start-day',fields), endField=$('.template-end-day',fields);
    for (const input of [startField,endField]) input.addEventListener('input',()=>{
      if (!startField.value || !endField.value) return;
      const start=Number(startField.value)+1,end=Number(endField.value)+1;
      if (!Number.isInteger(start)||!Number.isInteger(end)||start<1||start>10000||end<start) return;
      try { updateTemplateSchedule(task.key, {start_day:start,duration_value:end-start+1,duration_unit:'days'}); }
      catch (error) { toast(error.message); renderTemplateGantt(); return; }
      const card=fields.closest('.template-properties-card');
      $('.template-task-duration',card).value=task.duration_value;renderTemplateGantt();
    });
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
    $('#template-editor').innerHTML = `<div class="no-template">${t("template.create_a_template_or_select_one")}</div>`;
    return;
  }
  const selectedTask = draft.tasks.find(t => t.key === state.templateTaskKey) || draft.tasks[0];
  const projectSelected = state.templateTaskKey === '__project__' || !selectedTask;
  const projectOpen = projectSelected && !state.templateProjectCollapsed;
  const taskOpen = !projectSelected && !state.templateTaskCollapsed;
  if (!projectSelected) state.templateTaskKey = selectedTask.key;
  $('#template-editor').innerHTML = `
    <div class="timeline-layout">
      <div class="timeline-main"><div class="schedule-card">
        <div class="toolbar"><div class="toolbar-left"><input id="template-title" class="template-chart-title text-input" aria-label="${t("template.template_title")}" value="${esc(draft.name)}" placeholder="${t("template.template_title")}"></div><div class="toolbar-right"><label class="cascade-toggle"><input id="template-cascade-setting" data-cascade-dependents type="checkbox" ${state.cascadeDependents ? 'checked' : ''}><span class="cascade-label-full">${t("template.move_successors")}</span><span class="cascade-label-short">${t("template.successors")}</span></label><label class="zoom-slider-control">${t("template.zoom")} <input id="template-zoom" type="range" min="12" max="62" value="${state.templateZoom || 46}" aria-label="${t("template.template_zoom")}"><output>${Math.round((state.templateZoom || 46)/46*100)}%</output></label><span class="info-tip mobile-only mobile-chart-info"><button type="button" class="info-tip-button" aria-label="${t("template.template_chart_legend")}" aria-describedby="mobile-template-tooltip">i</button><span id="mobile-template-tooltip" class="info-tip-text" role="tooltip"><b class="tooltip-legend-heading"><svg class="dependency-legend" width="22" height="12" viewBox="0 0 22 12" aria-hidden="true"><path d="M0 0 H9 V3 C9 7 13 8 22 8 V12 H13 V9 C13 5 9 4 0 4 Z"/></svg>${t("timeline.predecessor_successor_legend")}</b><br>${t("template.connections_lead_from_predecessors_to_successors")}<br><br>${t("template.d_is_the_project_s_first")}</span></span></div></div>
        <div class="schedule-legend"><span>${t("timeline.predecessor_successor_legend")}</span><span class="legend-date-range" id="template-range"></span><span class="info-tip schedule-info"><button type="button" class="info-tip-button" aria-label="${t("template.template_calendar_help")}" aria-describedby="template-rules">i</button><span id="template-rules" class="info-tip-text" role="tooltip">${t("template.d_is_the_project_s_first_2")}</span></span></div>
        <div id="template-gantt" class="gantt-wrap template-gantt"></div>
      </div></div>
      <aside id="template-inspector" class="inspector" aria-label="${t("template.template_properties")}" ${mobileLayout() && !document.body.classList.contains('inspector-open') ? 'inert' : ''}><div class="inspector-title"><div><span class="eyebrow">${t("template.inspector")}</span><h2>${t("template.properties")}</h2></div><span id="template-save-state" class="inspector-state" role="status" aria-live="polite">${t("inspector.auto_save")}</span><button type="button" class="mobile-only drawer-close" data-close-drawer aria-label="${t("timeline.close_properties")}">×</button></div>
        <section class="inspector-section"><button type="button" id="template-project-accordion" class="inspector-accordion" aria-expanded="${projectOpen}"><span class="accordion-chevron">${projectOpen?'⌄':'›'}</span><span>${t("template.template_properties")}</span><small class="task-color-tag" style="${paletteStyle(draft.project_color || projectColors[0], 'task-tag')}">${esc(draft.name)}</small></button><div class="inspector-content ${projectOpen?'':'hidden'}"><div class="property-grid">
          <label class="inspector-field"><span>${t("template.template_name")}</span><input id="template-name" class="text-input" value="${esc(draft.name)}"></label>
          <div class="inspector-field"><span>${t("template.color")}</span><div class="color-field"><input id="template-project-color" type="color" value="${esc(draft.project_color || projectColors[0])}" aria-label="${t("template.color")}"><code>${esc(draft.project_color || projectColors[0])}</code>${randomColorButton()}</div></div>
          <label class="inspector-field"><span>${t("inspector.start_date")}</span><input class="text-input" value="D+0" disabled></label>
          <label class="inspector-field"><span>${t("template.default_calendar")} ${formInfo("template-default-calendar-help", t("template.default_calendar"), t("template.default_calendar_help"))}</span><select id="template-inspector-calendar" class="select-input"><option value="working" ${draft.calendar_type !== 'calendar' ? 'selected' : ''}>${t("inspector.5_day_week_mon_fri")}</option><option value="calendar" ${draft.calendar_type === 'calendar' ? 'selected' : ''}>${t("inspector.7_day_week")}</option></select></label>
          <label class="inspector-field"><span>${t("inspector.group")}</span><input id="template-group" class="text-input" value="${esc(draft.group_name || '')}"></label>
          <label class="inspector-field"><span>${t("inspector.tags")}</span><input id="template-tags" class="text-input" value="${esc((draft.tags || []).join(', '))}"></label>
          <label class="inspector-field"><span>${t("template.description")}</span><textarea id="template-description" class="text-area" rows="3">${esc(draft.description || '')}</textarea></label>
        </div><div class="inspector-actions"><button id="delete-template" type="button" class="button delete-button">${t("template.delete")}</button><button id="save-template" type="button" class="button save-button">${t("template.save")}</button></div></div></section>
        <section class="inspector-section"><button type="button" id="template-task-accordion" class="inspector-accordion" aria-expanded="${taskOpen}"><span class="accordion-chevron">${taskOpen?'⌄':'›'}</span><span>${t("template.task_properties")}</span><small class="${!projectSelected ? 'task-color-tag' : ''}" style="${paletteStyle(selectedTask?.color || taskColors[0], 'task-tag')}">${esc(projectSelected ? t("inspector.not_selected") : selectedTask?.name || t("inspector.not_selected"))}</small></button><div id="template-tasks" class="inspector-content ${taskOpen?'':'hidden'}">${selectedTask ? templateTaskProperties(selectedTask,draft.tasks.indexOf(selectedTask),draft.tasks) : `<p>${t("template.add_a_task")}</p>`}</div></section>
      </aside>
    </div>`;
  $('#template-editor').oninput = () => {
    const projectBadge = $('#template-project-accordion small');
    projectBadge.textContent = draft.name;
    applyPalette(projectBadge, draft.project_color || projectColors[0]);
    const taskBadge = $('#template-task-accordion small');
    taskBadge.classList.toggle('task-color-tag', !projectSelected);
    taskBadge.textContent = projectSelected ? t('inspector.not_selected') : selectedTask?.name || t('inspector.not_selected');
    applyPalette(taskBadge, selectedTask?.color || taskColors[0]);
  };
  $('#template-project-accordion').addEventListener('click', () => { syncDraftFromEditor(); queueTemplateSave(); state.templateProjectCollapsed = state.templateTaskKey === '__project__' && !state.templateProjectCollapsed; state.templateTaskKey='__project__'; renderTemplateEditor(); });
  $('#template-task-accordion').addEventListener('click', () => { syncDraftFromEditor(); queueTemplateSave(); state.templateTaskCollapsed = taskOpen; state.templateTaskKey=selectedTask?.key; renderTemplateEditor(); });
  $('#template-zoom').addEventListener('input', event => { state.templateZoom=Number(event.target.value); persistUi(); event.target.nextElementSibling.textContent=`${Math.round(state.templateZoom/46*100)}%`; renderTemplateGantt(); });
  $('#template-cascade-setting').addEventListener('change', event => setCascadeSetting(event.target.checked));
  $('#template-inspector-calendar').addEventListener('change', event => { draft.calendar_type = event.target.value; renderTemplateGantt(); });
  renderTemplateGantt();
  attachTemplateDrag();
  attachTemplateDayFields();
  disableFieldSuggestions($('#template-tasks'));
  $('#template-title').addEventListener('input', event => { draft.name=event.target.value; $('#template-name').value=draft.name; renderTemplateGantt(); });
  $('#template-name').addEventListener('input', (event) => { draft.name = event.target.value; $('#template-title').value=draft.name; renderTemplateGantt(); });
  $('#template-description').addEventListener('input', (event) => { draft.description = event.target.value; });
  $('#template-project-color').addEventListener('input', (event) => { draft.project_color = event.target.value; event.target.nextElementSibling.textContent = event.target.value; renderTemplateGantt(); });
  $$('.template-task-name').forEach((input) => input.addEventListener('input', () => updateTemplateField(input)));
  $$('.template-task-duration').forEach((input) => input.addEventListener('input', () => updateTemplateField(input)));
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
    state.preview = null; renderTemplateEditor(); queueTemplateSave();
  }));


  $('#save-template').addEventListener('click', saveTemplate);
  $('#save-template-task')?.addEventListener('click', saveTemplate);
  $('#delete-template').addEventListener('click', deleteTemplate);
  bindTemplateAutoSave();
  bindTagColors();
  bindTemplateReordering();
}
function templateRelationSummary(task, tasks) {
  const successors = tasks.filter(other => (other.dependencies || []).includes(task.key)).length;
  return t("template.predecessors_and_successors", {p0:task.dependencies.length,p1:successors});
}
function setTemplateRelation(tasks, taskKey, otherKey, successor, checked) {
  const target = tasks.find(t => t.key === (successor ? otherKey : taskKey));
  const predecessor = successor ? taskKey : otherKey;
  const previous = target.dependencies;
  target.dependencies = checked ? [...new Set([...previous, predecessor])] : previous.filter(key => key !== predecessor);
  try { templateSchedule(tasks); }
  catch (error) { target.dependencies = previous; throw error; }
}
function templateDurationDays(task, calendar = typeof state !== 'undefined' ? state.draft?.calendar_type || 'working' : 'working') {
  return Math.max(1, Number(task.duration_value) || 1) * (task.duration_unit === 'weeks' ? calendar === 'working' ? 5 : 7 : 1);
}
function templateTaskRow(task, index, tasks) {
  const field = (label, content) => `<label class="inspector-field"><span>${label}</span>${content}</label>`;
  return `${field(t("timeline.task_name"),`<input class="text-input template-task-name" data-key="${esc(task.key)}" value="${esc(task.name)}">`)}
    <div class="inspector-field"><span>${t("inspector.task_color")}</span><div class="color-field"><input class="template-task-color" data-key="${esc(task.key)}" type="color" value="${esc(task.color || taskColors[index % taskColors.length])}" aria-label="${t("inspector.task_color")}"><code>${esc(task.color || taskColors[index % taskColors.length])}</code>${randomColorButton()}</div></div>
    ${taskDateGrid(`<div class="relative-day-input"><span aria-hidden="true">D+</span><input class="text-input template-start-day" type="number" min="0" max="9999" aria-label="${t("template.start_d")}" required></div>`, `<div class="relative-day-input"><span aria-hidden="true">D+</span><input class="text-input template-end-day" type="number" min="0" max="9999" aria-label="${t("template.finish_d")}" required></div>`, null, null)}
    <label class="inspector-field"><span>${t("template.duration_days")}</span><input class="text-input template-task-duration" data-key="${esc(task.key)}" type="number" min="1" step="1" max="3640" value="${esc(templateDurationDays(task))}" aria-label="${t("template.duration_days")}"></label>
    ${field(t("inspector.group"),`<input class="text-input template-task-group" data-key="${esc(task.key)}" value="${esc(task.group_name || '')}">`)}
    ${field(t("timeline.owner_vendor"),`<input class="text-input template-task-owner" data-key="${esc(task.key)}" value="${esc(task.owner || '')}">`)}
    <div class="inspector-field property-relations"><div class="inspector-relations"><table aria-label="${t("template.template_predecessors_and_successors")}"><thead><tr><th class="relation-heading">${t("relations.title")} <span class="info-tip relation-info"><button type="button" class="info-tip-button" aria-label="${t("inspector.predecessor_successor_help")}" aria-describedby="template-relations-help">i</button><span id="template-relations-help" class="info-tip-text" role="tooltip">${t("inspector.predecessor_before_this_task_successor_after")}<br>${t("inspector.select_multiple_tasks")}</span></span></th><th>${t("inspector.predecessors")}</th><th>${t("inspector.successors")}</th></tr></thead><tbody>${tasks.map(other=>other.key===task.key?relationPositionMarker(task.color || taskColors[index % taskColors.length]):`<tr><th><span class="relation-task-label"><span class="relation-task-dot" style="background:${colorPalette(other.color || taskColors[tasks.indexOf(other) % taskColors.length]).base}" aria-hidden="true"></span><span class="template-relation-name relation-task-name" data-key="${esc(other.key)}">${esc(other.name)}</span></span></th><td><input type="checkbox" class="template-dependency" data-task="${esc(task.key)}" data-dependency="${esc(other.key)}" aria-label="${esc(other.name)} ${t("inspector.predecessors")}" ${task.dependencies.includes(other.key)?'checked':''}></td><td><input type="checkbox" class="template-successor" data-task="${esc(task.key)}" data-dependency="${esc(other.key)}" aria-label="${esc(other.name)} ${t("inspector.successors")}" ${(other.dependencies||[]).includes(task.key)?'checked':''}></td></tr>`).join('') || `<tr><td colspan="3">${t("inspector.no_other_tasks_to_connect")}</td></tr>`}</tbody></table></div></div>
    ${field(t("inspector.tags"),`<input class="text-input template-task-tags" data-key="${esc(task.key)}" value="${esc((task.tags || []).join(', '))}">`)}
    ${field(t("inspector.notes"),`<textarea class="text-area template-task-handoff" data-key="${esc(task.key)}" rows="3">${esc(task.handoff || '')}</textarea>`)}
`;
}

function syncDraftFromEditor() {
  if (!state.draft || !$('#template-name')) return;
  state.draft.name = $('#template-name').value;
  state.draft.description = $('#template-description').value;
  state.draft.group_name = $('#template-group')?.value ?? state.draft.group_name ?? '';
  if ($('#template-tags')) state.draft.tags = mergeTagTokens([], $('#template-tags').value);
  state.draft.project_color = $('#template-project-color')?.value || state.draft.project_color || projectColors[0];
  for (const task of state.draft.tasks) {
    const byKey = (selector) => $(`${selector}[data-key="${CSS.escape(task.key)}"]`);
    task.name = byKey('.template-task-name')?.value ?? task.name;
    const durationInput=byKey('.template-task-duration');
    if(durationInput) { task.duration_value=Math.max(1,Number(durationInput.value)||templateDurationDays(task)); task.duration_unit='days'; }
    task.color = byKey('.template-task-color')?.value ?? task.color ?? taskColors[state.draft.tasks.indexOf(task) % taskColors.length];
    task.owner = byKey('.template-task-owner')?.value ?? task.owner;
    task.group_name = byKey('.template-task-group')?.value ?? task.group_name ?? '';
    if (byKey('.template-task-tags')) task.tags = mergeTagTokens([], byKey('.template-task-tags').value);
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
  try {
    if (input.classList.contains('template-task-duration')) updateTemplateSchedule(task.key, {start_day:templateSchedule(state.draft.tasks).find(row=>row.task.key===task.key).start, duration_value:Math.max(1, Number(input.value) || 1), duration_unit:'days'});
  } catch (error) { toast(error.message); renderTemplateEditor(); return; }
  if (input.classList.contains('template-task-color')) { task.color = input.value; input.nextElementSibling.textContent = input.value; }
  if (input.classList.contains('template-task-owner')) task.owner = input.value;
  if (input.classList.contains('template-task-handoff')) task.handoff = input.value;
  renderTemplateGantt();
}
let templateSaveQueue = Promise.resolve();
const templateSavedPayloads = new WeakMap();
const templatePendingPayloads = new WeakMap();
function templatePayload(draft) {
  return { name: draft.name.trim(), group_name: draft.group_name || '', tags: draft.tags || [], calendar_type: draft.calendar_type || 'working', description: draft.description || '', project_color: draft.project_color || projectColors[0], tasks: draft.tasks.map((task, index) => ({ key: task.key, name: task.name.trim(), duration_value: Number(task.duration_value), duration_unit: task.duration_unit, start_day: task.start_day ?? null, dependencies: task.dependencies, owner: task.owner || '', group_name: task.group_name || '', tags: task.tags || [], handoff: task.handoff || '', color: task.color || taskColors[index % taskColors.length], sort_order: index })) };
}
function templateSaveStatus(draft, message, failed = false) {
  if (state.draft !== draft) return;
  const status = $('#template-save-state');
  if (status) { status.textContent = message; status.classList.toggle('save-error', failed); }
}
function saveTemplate() { return queueTemplateSave(true); }
function queueTemplateSave(manual = false) {
  const draft = state.draft;
  if (!draft) return Promise.resolve();
  let payload;
  try {
    for (const fields of $$('[data-template-days]')) {
      const start=$('.template-start-day',fields), end=$('.template-end-day',fields);
      if (!start.checkValidity() || !end.checkValidity() || Number(end.value)<Number(start.value)) throw new Error(t("template.check_the_start_and_finish_d"));
    }
    syncDraftFromEditor();
    if (!draft.name.trim()) throw new Error(t("template.enter_a_template_name"));
    if (!draft.tasks.length) throw new Error(t("template.add_at_least_one_task"));
    if (draft.tasks.some(task => !String(task.name).trim())) throw new Error(t("template.enter_a_task_name"));
    templateSchedule(draft.tasks);
    payload = JSON.stringify(templatePayload(draft));
  } catch (error) {
    templateSaveStatus(draft,error.message,true);
    if (manual) toast(error.message);
    return Promise.resolve();
  }
  if (templatePendingPayloads.get(draft) === payload) return templateSaveQueue;
  if (!templatePendingPayloads.has(draft) && templateSavedPayloads.get(draft) === payload) return templateSaveQueue;
  templatePendingPayloads.set(draft,payload);
  templateSaveStatus(draft,t("inspector.saving"));
  templateSaveQueue = templateSaveQueue.then(async () => {
    try {
      const saved = await api(draft.id ? `/api/templates/${encodeURIComponent(draft.id)}` : '/api/templates', {method:draft.id?'PUT':'POST',body:payload});
      draft.id = saved.id;
      templateSavedPayloads.set(draft,payload);
      if (state.draft === draft) state.selectedTemplateId=saved.id;
      // Navigation is refreshed by the common renderer; the editor retains its draft.
      if (templatePendingPayloads.get(draft) === payload) templateSaveStatus(draft,t("inspector.saved_automatically"));
      if (manual) toast(t("template.template_saved_existing_project_schedules_are"));
    } catch (error) {
      templateSaveStatus(draft,error.message,true);
      toast(error.message);
    } finally {
      if (templatePendingPayloads.get(draft) === payload) templatePendingPayloads.delete(draft);
    }
  });
  return templateSaveQueue;
}
function bindTemplateAutoSave() {
  const editor = $('#template-editor');
  if (!templateSavedPayloads.has(state.draft) && state.draft.id) templateSavedPayloads.set(state.draft,JSON.stringify(templatePayload(state.draft)));
  if (editor.templateFocusOut) editor.removeEventListener('focusout',editor.templateFocusOut);
  editor.templateFocusOut = event => {
    if (event.target.matches('input,textarea,select') && !event.target.disabled) queueTemplateSave();
  };
  editor.addEventListener('focusout',editor.templateFocusOut);
  editor.onkeydown = event => { if (event.key === 'Escape' && event.target.matches('input,textarea,select')) { event.preventDefault(); event.target.blur(); } };
  editor.onchange = event => {
    if (event.target.matches('select,input[type="checkbox"],input[type="color"]') && !event.target.disabled) queueTemplateSave();
  };
  disableFieldSuggestions(editor);
}
async function deleteTemplate() {
  const draft = state.draft;
  if (!draft || !window.confirm(t("template.delete_confirm", {p0:draft.name}))) return;
  const button = $('#delete-template');
  button.disabled = true;
  try {
    await templateSaveQueue;
    if (draft.id) await api(`/api/templates/${encodeURIComponent(draft.id)}`, {method:'DELETE'});
    state.draft = null; state.preview = null; state.selectedTemplateId = null;
    state.templateTaskKey = '__project__';
    state.selectedTemplateId = state.data.templates[0]?.id || null;
    renderTemplates();
    toast(t("common.deleted"));
  } catch (error) { toast(error.message); }
  finally { if (button.isConnected) button.disabled = false; }
}
function createTemplate() {
  const key = `task_${ChartMutations.randomUUID().slice(0, 8)}`;
  state.selectedTemplateId = null;
  state.draft = { name: t("template.new_schedule_template"), description: '', project_color: projectColors[state.data.templates.length % projectColors.length], tasks: [{ key, name: t("template.task_1"), duration_value: 1, duration_unit: 'days', dependencies: [], owner: '', handoff: '', color: taskColors[0] }] };
  state.preview = null;
  switchView('templates');
}

function openModal(title, subtitle, body, footer, onOpen = null) {
  $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><header class="modal-head"><div><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="icon-button modal-close" aria-label="${t("template.close")}">×</button></header><div class="inline-error" id="modal-error"></div><div class="modal-body">${body}</div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}</section></div>`;
  document.removeEventListener('keydown', modalEscape, true);
  document.addEventListener('keydown', modalEscape, true);
  $('.modal-close').addEventListener('click', closeModal);
  $('.modal-backdrop').addEventListener('click', (event) => { if (event.target.classList.contains('modal-backdrop')) closeModal(); });
  if (onOpen) onOpen();
}
function modalEscape(event) {
  // Windows IMEs may report a composition key as 229 before isComposing flips.
  if (event.isComposing || event.keyCode === 229 || event.key !== 'Escape') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  closeModal();
}
function closeModal() {
  document.removeEventListener('keydown', modalEscape, true);
  $('#floating-help')?.hidePopover();
  $('#modal-root').innerHTML = '';
}
function setModalError(message) { $('#modal-error').textContent = message; }
function formInfo(id, label, text) {
  return `<span class="info-tip"><button type="button" class="info-tip-button form-info-button" aria-label="${esc(label)}" aria-describedby="${id}">i</button><span id="${id}" class="info-tip-text" role="tooltip">${esc(text)}</span></span>`;
}
function normalizeGroupName(value) { return String(value || '').normalize('NFKC').trim().replace(/\s+/g,' '); }
function groupKey(value) { return normalizeGroupName(value).toLowerCase(); }
function groupNames() {
  const names = [...state.data.projects,...(state.data.templates || []),...(state.draft ? [state.draft] : [])].flatMap(project => [project.group_name,...project.tasks.map(task => task.group_name)]).map(normalizeGroupName).filter(Boolean).sort();
  return [...new Map([...names].reverse().map(name => [groupKey(name),name])).values()].sort();
}
function canonicalGroupName(value) {
  return groupNames().find(name => groupKey(name) === groupKey(value)) || normalizeGroupName(value);
}
function ownerNames() {
  const tasks=[...state.data.projects.flatMap(project=>project.tasks),...state.data.templates.flatMap(template=>template.tasks),...(state.draft?.tasks || [])];
  const names=tasks.map(task=>normalizeGroupName(task.owner)).filter(Boolean).sort();
  return [...new Map([...names].reverse().map(name=>[groupKey(name),name])).values()].sort();
}
function matchingCategoryNames(names, value) {
  const key=groupKey(value);
  return key ? names.filter(name=>groupKey(name).includes(key)) : [];
}
function bindGroupSuggestions() {
  // A body-level popover avoids clipping by the inspector's scroll container.
  const menu=document.createElement('div');menu.className='group-suggestions';menu.setAttribute('popover','manual');document.body.append(menu);
  let active=null, selected=-1;
  const close=()=>{if(menu.matches(':popover-open')) menu.hidePopover();active=null;};
  const show=input=>{
    active=input;selected=-1;const names=isOwner(input)?ownerNames():groupNames();const matches=matchingCategoryNames(names,input.value);
    if (!matches.length) {close();return;}
    menu.innerHTML=matches.map(name=>`<button type="button">${esc(name)}</button>`).join('');
    const rect=input.getBoundingClientRect();menu.style.left=`${rect.left}px`;menu.style.top=`${rect.bottom+3}px`;menu.style.width=`${rect.width}px`;
    if(!menu.matches(':popover-open'))menu.showPopover();
  };
  const isOwner=node=>node.matches?.('#ins-task-owner,#edit-task-owner,.template-task-owner');
  const isGroup=node=>node.matches?.('#ins-project-group,#ins-task-group,#template-group,.template-task-group') || isOwner(node);
  document.addEventListener('focusin',event=>{if(isGroup(event.target))show(event.target);});
  document.addEventListener('input',event=>{if(isGroup(event.target))show(event.target);});
  menu.addEventListener('pointerdown',event=>{if(event.target.closest('button'))event.preventDefault();});
  menu.addEventListener('click',event=>{const button=event.target.closest('button');if(!button||!active)return;const input=active;input.value=button.textContent;input.dispatchEvent(new Event('input',{bubbles:true}));close();input.blur();});
  document.addEventListener('blur',event=>{if(isGroup(event.target)){const input=event.target;input.value=isOwner(input)?(ownerNames().find(name=>groupKey(name)===groupKey(input.value)) || normalizeGroupName(input.value)):canonicalGroupName(input.value);close();}},true);
  document.addEventListener('keydown',event=>{
    if(event.isComposing || event.keyCode===229)return;
    if(event.key==='Enter' && isGroup(event.target)) {
      event.preventDefault();event.stopImmediatePropagation();
      if(event.target===active && menu.matches(':popover-open') && selected>=0) {
        menu.querySelectorAll('button')[selected].click();
      } else {
        const input=event.target;close();input.blur();
      }
      return;
    }
    if(event.target!==active || !menu.matches(':popover-open'))return;
    if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();close();return;}
    const buttons=[...menu.querySelectorAll('button')];
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){
      event.preventDefault();selected=(selected+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length;
      buttons.forEach((button,index)=>button.classList.toggle('selected',index===selected));
    } else if(event.key==='Enter' && selected>=0){event.preventDefault();event.stopImmediatePropagation();buttons[selected].click();}
  },true);
  document.addEventListener('scroll',event=>{if(!menu.contains(event.target))close();},true);
}
function firstTagColor(text, colors) {
  return text.split(',').map(tag=>colors[groupKey(tag)]).find(color=>/^#[0-9a-f]{6}$/i.test(color || '')) || null;
}
function tagColorStyle(color) {
  if (!/^#[0-9a-f]{6}$/i.test(color || '')) return '';
  const palette=colorPalette(color);
  return `background-color:${palette.base};border-color:${palette.base};color:${palette.ink}`;
}
function mergeTagTokens(existing, text) {
  return [...new Map([...existing,...text.split(',')].map(tag=>[groupKey(tag),normalizeGroupName(tag)]).filter(([key])=>key)).values()];
}
function bindTagColors() {
  $('#tag-palette-popover')?.remove();
  for(const input of $$('#ins-project-tags,#ins-task-tags,#template-tags,.template-task-tags')) {
    if (input.type === 'hidden') continue;
    const row=input.closest('.inspector-field');
    const container=document.createElement('div');container.className=row.className;
    const title=document.createElement('span');title.textContent=t('inspector.tags');
    container.append(title);row.replaceWith(container);
    input.type='hidden';input.hidden=true;input.classList.remove('text-input');container.append(input);
    const editor=document.createElement('div');editor.className='tag-token-editor';
    const chips=document.createElement('div');chips.className='tag-token-list';
    const entry=document.createElement('input');entry.className='tag-entry';entry.autocomplete='off';
    entry.placeholder=t('tags.add_hint');entry.setAttribute('aria-label',t('inspector.tags'));
    editor.append(chips,entry);container.append(editor);
    let tags=mergeTagTokens([],input.value);
    const saveTags=()=>{
      input.value=tags.join(', ');
      input.dispatchEvent(new Event('input',{bubbles:true}));
      input.dispatchEvent(new Event('blur'));
      if (input.matches('#template-tags,.template-task-tags')) queueTemplateSave();
    };
    const render=()=>{
      entry.placeholder=tags.length ? '' : t('tags.add_hint');
      chips.innerHTML=tags.map(tag=>`<button type="button" class="colored-tag" data-tag="${esc(tag)}" aria-haspopup="dialog" style="${tagColorStyle(state.data.tag_colors?.[groupKey(tag)])}">${esc(tag)}</button>`).join('');
    };
    const commit=()=>{
      if(!entry.value.trim())return;
      tags=mergeTagTokens(tags,entry.value);entry.value='';render();saveTags();
    };
    entry.addEventListener('keydown',event=>{
      if(event.isComposing || event.keyCode===229)return;
      if(event.key==='Backspace' && entry.value==='' && tags.length) {
        event.preventDefault();event.stopPropagation();
        tags.pop();render();saveTags();
      } else if(event.key===',' || event.key==='Enter') {event.preventDefault();event.stopPropagation();commit();}
    });
    entry.addEventListener('input',event=>{if(!event.isComposing && entry.value.includes(','))commit();});
    entry.addEventListener('compositionend',()=>{if(entry.value.includes(','))commit();});
    entry.addEventListener('blur',commit);
    editor.addEventListener('click',event=>{
      if(event.target===editor || event.target===chips)entry.focus();
    });
    chips.addEventListener('click',event=>{
      const button=event.target.closest('button[data-tag]');if(!button)return;
      $('#tag-palette-popover')?.remove();
      const tag=button.dataset.tag;
      const popup=document.createElement('div');popup.id='tag-palette-popover';popup.className='tag-palette-popover';
      popup.setAttribute('popover','auto');popup.setAttribute('role','dialog');popup.setAttribute('aria-label',t('tags.color'));
      const current=state.data.tag_colors?.[groupKey(tag)] || '#5872d9';
      popup.innerHTML=`<div class="tag-palette-heading"><strong>${esc(tag)}</strong><button type="button" class="icon-button tag-remove-button" data-remove aria-label="${t('tags.remove')}" title="${t('tags.remove')}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div class="tag-swatches">${projectColors.map(color=>`<button type="button" data-color="${color}" style="background:${color}" aria-label="${color}"></button>`).join('')}</div><label class="tag-custom-color">${t('tags.color')}<input type="color" value="${current}" aria-label="${t('tags.color')}"></label>${randomColorButton().replace('class="random-color-button"', 'class="tag-random-button" data-random')}<small role="status"></small>`;
      document.body.append(popup);popup.showPopover();
      const rect=button.getBoundingClientRect();
      popup.style.left=`${Math.max(8,Math.min(rect.left,innerWidth-popup.offsetWidth-8))}px`;
      popup.style.top=`${Math.max(8,Math.min(rect.bottom+5,innerHeight-popup.offsetHeight-8))}px`;
      let busy=false;
      const selectColor=async color=>{
        if(busy)return;busy=true;
        const controls=[...popup.querySelectorAll('button,input')];controls.forEach(node=>node.disabled=true);
        const status=popup.querySelector('[role=status]');status.textContent=t('inspector.saving');
        try {
          const result=await api('/api/settings/tag-color',{method:'PATCH',body:JSON.stringify({tag,color})});
          for(const node of $$('button.colored-tag[data-tag]')) if(groupKey(node.dataset.tag)===result.key)node.style.cssText=tagColorStyle(result.color);
          popup.querySelector('input').value=result.color;status.textContent=t('inspector.saved_automatically');
        } catch(error) {status.textContent=error.message;}
        finally {busy=false;controls.forEach(node=>node.disabled=false);}
      };
      popup.addEventListener('click',event=>{
        const selected=event.target.closest('button');if(!selected)return;
        if(selected.hasAttribute('data-remove')) {
          tags=tags.filter(value=>groupKey(value)!==groupKey(tag));render();saveTags();popup.hidePopover();popup.remove();entry.focus();
        } else if(selected.hasAttribute('data-random')) selectColor(newProjectColor(ChartMutations.randomUUID(),[popup.querySelector('input').value]));
        else if(selected.dataset.color)selectColor(selected.dataset.color);
      });
      popup.querySelector('input').addEventListener('change',event=>selectColor(event.target.value));
    });
    render();
  }
}
// A manual choice is a stable anchor; random variants never replace it.
let manualColorAnchors = {};
try { manualColorAnchors = JSON.parse(localStorage.getItem('mygantt-manual-colors') || '{}') || {}; } catch {}
function colorAnchorKey(input) {
  if (input.id === 'ins-project-color') {
    const project=state.data.projects.find(project=>project.id===state.selection?.id || project.tasks.some(task=>task.id===state.selection?.id));
    return project ? `project:${project.id}` : null;
  }
  if (input.id === 'ins-task-color') return `task:${state.selection?.id}`;
  if (input.id === 'template-project-color') return `template:${state.draft?.id || state.selectedTemplateId || 'draft'}`;
  if (input.classList.contains('template-task-color')) return `template-task:${state.draft?.id || state.selectedTemplateId || 'draft'}:${input.dataset.key}`;
  return null;
}
function manualColorVariant(anchor, excluded, seed) {
  const rgb=[1,3,5].map(i=>parseInt(anchor.slice(i,i+2),16)/255);
  const max=Math.max(...rgb),min=Math.min(...rgb),delta=max-min,light=(max+min)/2;
  let hue=0;
  if(delta) {
    hue=max===rgb[0]?(rgb[1]-rgb[2])/delta+(rgb[1]<rgb[2]?6:0):max===rgb[1]?(rgb[2]-rgb[0])/delta+2:(rgb[0]-rgb[1])/delta+4;
    hue/=6;
  }
  const saturation=delta ? delta/(1-Math.abs(2*light-1)) : 0;
  const used=new Set([anchor.toLowerCase(),'#5872d9',...excluded.map(value=>String(value).toLowerCase())]);
  let random=2166136261;
  for(const char of seed) random=Math.imul(random^char.charCodeAt(0),16777619)>>>0;
  for(let attempt=0;attempt<4096;attempt++) {
    random=(Math.imul(random,1664525)+1013904223)>>>0;
    const h=(hue+((random%13)-6)/360+1)%1;
    const s=Math.max(0,Math.min(1,saturation+(((random>>>8)%17)-8)/100));
    const l=Math.max(.06,Math.min(.94,light+(((random>>>16)%25)-12)/100));
    const a=(delta ? s : 0)*Math.min(l,1-l);
    const channel=n=>{const k=(n+h*12)%12;return Math.round(255*(l-a*Math.max(-1,Math.min(k-3,9-k,1))));};
    const color='#'+[channel(0),channel(8),channel(4)].map(v=>v.toString(16).padStart(2,'0')).join('');
    if(!used.has(color)) return color;
  }
  return anchor;
}
function randomColorButton() {
  return `<button type="button" class="random-color-button" aria-label="${t('inspector.random_color')}" title="${t('inspector.random_color')}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7a8 8 0 0 0-14-1L3 9m0-6v6h6M4 17a8 8 0 0 0 14 1l3-3m0 6v-6h-6"/></svg></button>`;
}
function bindRandomColorButtons() {
  document.addEventListener('input', event => {
    const input=event.target;
    if(!input.matches('input[type="color"]') || input.dataset.randomizing === 'true') return;
    if(input.id==='project-color') { input.dataset.manualAnchor=input.value; return; }
    const key=colorAnchorKey(input);
    if(!key) return;
    manualColorAnchors[key]=input.value;
    try { localStorage.setItem('mygantt-manual-colors',JSON.stringify(manualColorAnchors)); } catch {}
  }, true);
  document.addEventListener('click', event => {
    const button = event.target.closest('.random-color-button');
    if (!button) return;
    const input = button.closest('.color-field').querySelector('input[type="color"]');
    const used = [input.value, ...state.data.projects.flatMap(project => project.tasks.map(task => task.color)),
      ...state.data.templates.flatMap(template => [template.project_color, ...template.tasks.map(task => task.color)]),
      ...(state.draft ? [state.draft.project_color, ...state.draft.tasks.map(task => task.color)] : [])];
    const tagsInput=input.id==='ins-task-color'?$('#ins-task-tags'):input.id==='ins-project-color'?$('#ins-project-tags'):input.id==='template-project-color'?$('#template-tags'):input.classList.contains('template-task-color')?$('.template-task-tags'):null;
    const tagAnchor=firstTagColor(tagsInput?.value || '',state.data.tag_colors || {});
    const anchor=tagAnchor || manualColorAnchors[colorAnchorKey(input)];
    input.value = /^#[0-9a-f]{6}$/i.test(anchor || '') ? manualColorVariant(anchor,used,ChartMutations.randomUUID()) : newProjectColor(ChartMutations.randomUUID(),used);
    input.nextElementSibling.textContent = input.value;
    input.dataset.randomizing='true';
    try {
      input.dispatchEvent(new Event('input', {bubbles:true}));
      input.dispatchEvent(new Event('change', {bubbles:true}));
    } finally { delete input.dataset.randomizing; }
  });
}
function newProjectColor(seed, excluded = []) {
  const used = new Set(['#5872d9', ...excluded.map(color => String(color).toLowerCase()), ...state.data.projects.map(project => colorPalette(project.color).base)]);
  for (let attempt = 0; ; attempt++) {
    let hash = 2166136261;
    for (const char of `${seed}:${attempt}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
    const color = '#' + [0,8,16].map(shift => (64 + ((hash >>> shift) & 127)).toString(16).padStart(2,'0')).join('');
    if (!used.has(color)) return color;
  }
}
function openInstantiate() { openProjectCreate(true); }
function openProjectCreate(useTemplate) {
  if (!useTemplate) return createScheduleItem('project');
  if (useTemplate && !state.data.templates.length) { toast(t("template.create_a_schedule_template_first")); switchView('templates'); return; }
  const options = state.data.templates.map((template) => `<option value="${esc(template.id)}">${esc(template.name)} · ${template.tasks.length}${t("template.tasks")}</option>`).join('');
  const requestId = ChartMutations.randomUUID();
  const initialColor = newProjectColor(`${todayInput()}:${requestId}`);
  const body = `<div class="form-grid">
    <div class="project-identity-row full">
      <label class="form-field project-color-field"><span class="field-label">${t("common.color")}</span><input id="project-color" type="color" value="${initialColor}" aria-label="${t("project.new_project_color")}"></label>
      <label class="form-field project-name-field"><span class="field-label">${t("project.project_production_batch_name")}</span><input id="project-name" type="text" class="text-input" autocomplete="off" placeholder="${t("project.name_placeholder")}"></label>
    </div>
    ${useTemplate ? `<label class="form-field full"><span class="field-label">${t("project.template_to_apply")}</span><select id="project-template" class="select-input">${options}</select></label>` : ''}
    <label class="form-field"><span class="field-label">${t("inspector.start_date")}</span><input id="project-start" type="date" class="text-input" value="${todayInput()}"></label>
    <div class="form-field"><div class="field-label"><label for="project-calendar">${t("project.scheduling_calendar")}</label>${formInfo('project-calendar-help', t("project.scheduling_calendar_help"), t("project.successors_start_on_the_workday_after"))}</div><select id="project-calendar" class="select-input"><option value="working">${t("inspector.5_day_week_mon_fri")}</option><option value="calendar">${t("inspector.7_day_week")}</option></select></div>
    ${useTemplate ? '<div class="form-field full"><div id="project-template-summary" class="project-template-summary"></div></div>' : ''}
  </div>`;
  const footer = `<button class="button" id="cancel-project">${t("timeline.cancel")}</button><div class="modal-footer-right"><button class="button button-primary" id="confirm-project">${useTemplate ? t("project.create_project_with_all_tasks") : t("project.add_title")}</button></div>`;
  openModal(useTemplate ? t("project.create_project_from_template") : t("project.add_title"), useTemplate ? '' : t("project.empty_description"), body, footer, () => {
    $('.modal').classList.add('creation-modal');
    if (useTemplate) $('.modal-head h2').insertAdjacentHTML('beforeend', formInfo('project-create-help', t("project.create_project_from_template_help"), t("project.copy_the_selected_template_s_tasks")));
    const summary = () => { const template = state.data.templates.find((item) => item.id === $('#project-template').value); $('#project-calendar').value = template.calendar_type || 'working'; $('#project-template-summary').textContent = t("project.tasks_copies_task_colors_and_dependencies", {p0:template.name,p1:template.tasks.length}); };
    if (useTemplate) { $('#project-template').addEventListener('change', summary); summary(); }
    $('#cancel-project').addEventListener('click', closeModal);
    $('#confirm-project').addEventListener('click', async () => {
      const button = $('#confirm-project'); if (button.disabled) return;
      button.disabled = true;
      try {
      const project = await api(useTemplate ? '/api/instantiate' : '/api/projects', { method: 'POST', body: JSON.stringify({ request_id: requestId, name: $('#project-name').value.trim(), template_id: $('#project-template')?.value, start_date: $('#project-start').value, calendar_type: $('#project-calendar').value, color: $('#project-color').value }) });
        const manualAnchor=$('#project-color')?.dataset.manualAnchor;
        if(manualAnchor) {
          manualColorAnchors[`project:${project.id}`]=manualAnchor;
          try { localStorage.setItem('mygantt-manual-colors',JSON.stringify(manualColorAnchors)); } catch {}
        }
        closeModal(); state.filterProject = project.id; state.selection = { type: 'project', id: project.id }; state.inspectorOpen = 'project'; persistUi(); switchView('timeline'); toast(useTemplate ? t("project.created_tasks", {p0:project.name,p1:project.tasks.length}) : t("project.empty_created"));
      } catch (error) { setModalError(error.message); button.disabled = false; }
    });
    $('#project-name').focus();
  });
}
function openTaskEditor(projectId, taskId) {
  const project = state.data.projects.find((item) => item.id === projectId);
  const task = project?.tasks.find((item) => item.id === taskId);
  if (!task || !project) return;
  const dependencies = state.data.projects.flatMap(parent=>parent.tasks).filter((item) => item.id !== task.id);
  const depMarkup = dependencies.length ? dependencies.map((item) => `<label><input type='checkbox' class='task-dep-checkbox' value='${esc(item.id)}' ${task.dependencies.includes(item.id) ? 'checked' : ''}><span>${esc(item.name)}</span></label>`).join('') : `<span class="form-help">${t("project.add_another_task_to_create_a")}</span>`;
  const body = `<div class='task-details'><div class='form-grid'>
    <label class='form-field full'><span class='field-label'>${t("timeline.task_name")}</span><input id='edit-task-name' class='text-input' value='${esc(task.name)}' required></label>
    <label class='form-field'><span class='field-label'>${t("timeline.planned_start")}</span><input id='edit-task-planned-start' type='date' class='text-input' value='${esc(task.planned_start)}' required></label>
    <label class='form-field'><span class='field-label'>${t("timeline.planned_finish")}</span><input id='edit-task-planned-finish' type='date' class='text-input' value='${esc(task.planned_finish)}' required></label>
    <label class='form-field'><span class='field-label'>${t("timeline.owner_vendor")}</span><input id='edit-task-owner' class='text-input' value='${esc(task.owner)}' placeholder='${t("inspector.owner_placeholder")}'></label>
    <label class='form-field'><span class='field-label'>${t("calendar.status")}</span><select id='edit-task-status' class='select-input'>${Object.entries(statusNames).map(([key, name]) => `<option value='${key}' ${task.status === key ? 'selected' : ''}>${name}</option>`).join('')}</select></label>
    <label class='form-field full cascade-inline'><input data-cascade-dependents type='checkbox' ${state.cascadeDependents ? 'checked' : ''}><span>${t("project.move_connected_successors")}</span></label>
    <div class='form-field full schedule-note'><span>↳</span><span>${t("project.shift_all_successor_planned_dates_by")}</span></div>
    <label class='form-field full'><span class='field-label'>${t("inspector.predecessors")} <span style='font-weight:400;color:#a2aab5'> ${t("project.all_selected_predecessors_must_finish_before")}</span></span><div class='dependency-box'>${depMarkup}</div></label>
    <label class='form-field full'><span class='field-label'>${t("inspector.stopped_waiting_reason")}</span><input id='edit-task-blocker' class='text-input' value='${esc(task.blocker)}' placeholder='${t("inspector.blocker_placeholder")}'></label>
    <div class='form-field full'><span class='field-label'>${t("inspector.actual_dates")}</span><div class='actual-grid'><label><input id='edit-task-actual-start' type='date' class='text-input' value='${esc(task.actual_start)}'><div class='form-help'>${t("inspector.actual_start")}</div></label><label><input id='edit-task-actual-finish' type='date' class='text-input' value='${esc(task.actual_finish)}'><div class='form-help'>${t("project.actual_completion_date")}</div></label></div></div>
    <label class='form-field full'><span class='field-label'>${t("inspector.notes")}</span><textarea id='edit-task-notes' class='text-area' rows='2' placeholder='${t("inspector.notes_placeholder")}'>${esc(task.notes)}</textarea></label>
  </div></div>`;
  const footer = `<button id='mark-complete' class='button complete-button'>${t("inspector.complete_today")}</button>
        <button class="button danger-button" id="ins-task-delete" type="button">${t("task.delete")}</button><div class='modal-footer-right'><button id='cancel-task' class='button'>${t("timeline.cancel")}</button><button id='save-task' class='button button-primary'>${t("project.save_changes")}</button></div>`;
  openModal(task.name, t("project.planned", {p0:project.name,p1:fmtDate(task.planned_start, true),p2:fmtDate(task.planned_finish, true)}), body, footer, () => {
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
      if (!payload.name) { setModalError(t("template.enter_a_task_name")); return; }
      if (complete) { payload.status = 'done'; payload.actual_start ||= todayInput(); payload.actual_finish ||= todayInput(); }
      saving = true;
      $('#save-task').disabled = true;
      $('#mark-complete').disabled = true;
      try {
        await api(`/api/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', body: JSON.stringify(payload) });
        closeModal();
        toast(complete ? t("project.actual_completion_date_recorded") : t("project.task_dates_and_properties_saved"));
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
  const body = `<div class="form-grid"><label class="form-field full"><span class="field-label">${t("inspector.project_name")}</span><input id="edit-project-name" class="text-input" autocomplete="off" value="${esc(project.is_unassigned ? t("inspector.no_project") : project.name)}"></label><label class="form-field"><span class="field-label">${t("inspector.start_date")}</span><input id="edit-project-start" type="date" class="text-input" value="${esc(project.start_date)}"></label><label class="form-field"><span class="field-label">${t("project.scheduling_calendar")}</span><select id="edit-project-calendar" class="select-input"><option value="working" ${project.calendar_type === 'working' ? 'selected' : ''}>${t("inspector.5_day_week_mon_fri")}</option><option value="calendar" ${project.calendar_type === 'calendar' ? 'selected' : ''}>${t("inspector.7_day_week")}</option></select></label><div class="form-field full"><div class="form-help">${t("project.changing_the_start_date_or_calendar")}</div></div></div>`;
  const footer = `<button id="cancel-project-edit" class="button">${t("timeline.cancel")}</button><div class="modal-footer-right"><button id="save-project-edit" class="button button-primary">${t("project.save_project_info")}</button></div>`;
  openModal(t("project.project_settings"), t("project.tasks", {p0:project.tasks.length,p1:project.template_name}), body, footer, () => {
    $('#cancel-project-edit').addEventListener('click', closeModal);
    $('#save-project-edit').addEventListener('click', async () => {
      try { await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: 'PATCH', body: JSON.stringify({ name: $('#edit-project-name').value.trim(), start_date: $('#edit-project-start').value, calendar_type: $('#edit-project-calendar').value }) }); closeModal(); toast(t("project.project_info_saved_task_dates_are")); }
      catch (error) { setModalError(error.message); }
    });
  });
}
function taskInsertionOrder(tasks, taskId, anchorId, after) {
  const ids = [...tasks].sort((a,b)=>a.sort_order-b.sort_order).map(task=>task.id);
  if (!ids.includes(taskId) || !ids.includes(anchorId) || taskId === anchorId) return ids;
  ids.splice(ids.indexOf(taskId),1);
  ids.splice(ids.indexOf(anchorId)+(after?1:0),0,taskId);
  return ids;
}
function taskDropPlacement(dragged, target, manual) {
  if (!target || target.taskId === dragged.id) return null;
  if (target.taskId && target.projectId === dragged.projectId && !manual) return null;
  return {project_id:target.projectId === '__unassigned__' ? null : target.projectId,
    ...(target.taskId && manual ? {anchor_id:target.taskId, after:target.after} : {})};
}
function bindTaskReordering() {
  const chart = $('#gantt');
  let dragged = null, insertion = null;
  function clearPreview() {
    $$('.task-insert-before, .task-insert-after, .directory-drop-target',chart).forEach(row=>{
      row.classList.remove('task-insert-before','task-insert-after','directory-drop-target');
      row.querySelector('.gantt-left')?.removeAttribute('data-preview');
    });
    insertion = null;
  }
  function stop() { clearPreview(); $$('.task-order-dragging',chart).forEach(row=>row.classList.remove('task-order-dragging')); dragged = null; }
  chart.addEventListener('dragstart',event=>{
    const projectLabel = event.target.closest('.project-select[data-collapse]');
    if (projectLabel && $('#sort-select').value === 'manual') {
      dragged = {id:projectLabel.dataset.collapse,type:'project'};
      event.dataTransfer.effectAllowed='move';
      event.dataTransfer.setData('text/plain',dragged.id);
      projectLabel.closest('.project-row').classList.add('task-order-dragging');
      return;
    }
    const label = event.target.closest('.task-label[data-task-select]');
    if (!label) {event.preventDefault();return;}
    dragged = {id:label.dataset.taskSelect,projectId:label.dataset.project};
    event.dataTransfer.effectAllowed='move';
    event.dataTransfer.setData('text/plain',dragged.id);
    label.closest('.task-row').classList.add('task-order-dragging');
  });
  chart.addEventListener('dragover',event=>{
    if (!dragged) return;
    clearPreview();
    const cell = event.target.closest('.gantt-left');
    const label = cell?.querySelector('.task-label[data-task-select]');
    const folderId = cell?.dataset.dropProject;
    const row = cell?.closest('.gantt-row');
    const rect = row?.getBoundingClientRect();
    const target = label ? {projectId:label.dataset.project,taskId:label.dataset.taskSelect,after:event.clientY > rect.top+rect.height/2} : folderId ? {projectId:folderId} : null;
    const manual = $('#sort-select').value === 'manual';
    if (dragged.type === 'project') {
      if (!manual || !folderId || folderId === dragged.id || folderId === '__unassigned__') return;
      insertion = {anchor_id:folderId,after:event.clientY > rect.top+rect.height/2};
      event.preventDefault(); event.dataTransfer.dropEffect='move';
      row.classList.add(insertion.after?'task-insert-after':'task-insert-before');
      const wrap=$('#gantt-wrap'), bounds=wrap.getBoundingClientRect();
      if(event.clientY>bounds.bottom-45) wrap.scrollTop+=15;
      else if(event.clientY<bounds.top+90) wrap.scrollTop-=15;
      return;
    }
    insertion = taskDropPlacement(dragged,target,manual);
    if (!insertion) {event.dataTransfer.dropEffect='none';return;}
    event.preventDefault();event.dataTransfer.dropEffect='move';
    if (insertion.anchor_id) row.classList.add(insertion.after?'task-insert-after':'task-insert-before');
    else row.classList.add('directory-drop-target');
    const name = target.projectId === '__unassigned__' ? t("directory.root_name") : state.data.projects.find(p=>p.id===target.projectId)?.name;
    cell.dataset.preview = t("directory.move_into", {p0:name});
    const wrap=$('#gantt-wrap'), bounds=wrap.getBoundingClientRect();
    if(event.clientY>bounds.bottom-45) wrap.scrollTop+=15;
    else if(event.clientY<bounds.top+90) wrap.scrollTop-=15;
  });
  chart.addEventListener('dragleave',event=>{if(!chart.contains(event.relatedTarget)) clearPreview();});
  chart.addEventListener('dragend',stop);
  chart.addEventListener('drop',async event=>{
    if (!dragged || !insertion) {stop();return;}
    event.preventDefault();
    const taskId=dragged.id, fields=insertion, isProject=dragged.type === 'project';
    stop();
    const request=(async()=>{
      if (isProject) {
        await api(`/api/projects/${encodeURIComponent(taskId)}/order`,{method:'PATCH',body:JSON.stringify(fields)});
        return;
      }
      const {project_id, ...position}=fields;
      state.selection={type:'task',id:taskId}; state.inspectorOpen='task';
      const request=api(`/api/tasks/${encodeURIComponent(taskId)}/placement`,{method:'PATCH',body:JSON.stringify({directory_id:project_id ? `project:${project_id}` : 'root',...position})});
      persistUi();
      const project=await request;
      toast(t("inspector.task_moved_to", {p0:project.is_unassigned ? t("inspector.no_project") : project.name}));
    })();
    try {await request;} catch(error) {toast(error.message);}
  });
  $('#sort-select').addEventListener('change',stop);
}

// A top-layer popover avoids clipping by the sticky Gantt header and scroll containers.
function bindFloatingHelp() {
  const overlay = document.createElement('div');
  overlay.id = 'floating-help';
  overlay.className = 'floating-help';
  overlay.setAttribute('popover', 'manual');
  overlay.setAttribute('role', 'tooltip');
  document.body.append(overlay);
  let active = null, hoverTimer = null, pending = null;
  const cancelHover = () => { clearTimeout(hoverTimer); hoverTimer = null; pending = null; };
  const targetFor = node => node instanceof Element ? node.closest('.info-tip, [data-hover-help]') : null;
  function hide() { cancelHover(); overlay.hidePopover(); active = null; }
  function show(target) {
    cancelHover();
    if (!target || !target.isConnected || active === target) return;
    active = target;
    const content = target.querySelector('.info-tip-text');
    overlay.replaceChildren();
    if (content) for (const child of content.childNodes) overlay.append(child.cloneNode(true));
    else overlay.textContent = target.dataset.hoverHelp;
    overlay.showPopover();
    const rect = target.getBoundingClientRect();
    const width = overlay.offsetWidth, height = overlay.offsetHeight;
    overlay.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`;
    const top = rect.bottom + 8 + height <= innerHeight - 8 ? rect.bottom + 8 : rect.top - height - 8;
    overlay.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
  }
  document.addEventListener('pointerover', event => {
    const target = targetFor(event.target);
    if (!target || target.contains(event.relatedTarget)) return;
    if (event.pointerType === 'touch' || event.buttons || active === target || pending === target) return;
    cancelHover();
    pending = target;
    hoverTimer = setTimeout(() => show(target), 3000);
  });
  document.addEventListener('pointerout', event => {
    const target = targetFor(event.target);
    if (target && !target.contains(event.relatedTarget) && !overlay.contains(event.relatedTarget)) hide();
  });
  overlay.addEventListener('pointerleave', hide);
  document.addEventListener('pointerdown', event => {
    if (targetFor(event.target)?.matches('.task-status-help') && !event.target.closest('.status-help-trigger')) hide();
  });
  document.addEventListener('focusout', event => { if (targetFor(event.target)) hide(); });
  document.addEventListener('click', event => {
    const target = targetFor(event.target);
    if (target?.matches('.info-tip') || event.target.closest('.status-help-trigger')) show(target);
    else if (!target && !overlay.contains(event.target)) hide();
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') hide(); });
  document.addEventListener('scroll', event => { if (!overlay.contains(event.target)) hide(); }, true);
  window.addEventListener('resize', hide);
}

function bindCascadeHelp() {
  const control = $('#cascade-setting').closest('.cascade-toggle');
  const overlay = $('#cascade-help');
  let timer = null, origin = null, suppressClick = false;
  function cancel() { clearTimeout(timer); timer = null; origin = null; }
  function show() {
    cancel();
    suppressClick = true;
    const rect = control.getBoundingClientRect();
    overlay.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - 332))}px`;
    overlay.style.top = `${rect.bottom + 8}px`;
    overlay.showPopover();
  }
  control.addEventListener('pointerdown', event => {
    cancel();
    suppressClick = false;
    if (!event.isPrimary || event.button !== 0) return;
    origin = {x:event.clientX, y:event.clientY};
    timer = setTimeout(show, 500);
  });
  document.addEventListener('pointermove', event => {
    if (origin && Math.hypot(event.clientX-origin.x, event.clientY-origin.y) > 8) cancel();
  });
  document.addEventListener('pointerup', cancel);
  document.addEventListener('pointercancel', cancel);
  window.addEventListener('blur', cancel);
  control.addEventListener('click', event => {
    if (!suppressClick) return;
    event.preventDefault();
    event.stopPropagation();
    suppressClick = false;
  }, true);
  control.addEventListener('contextmenu', event => { event.preventDefault(); show(); });
  control.addEventListener('keydown', event => {
    if (event.key === 'F1') { event.preventDefault(); show(); }
  });
}

function bindMobileSearch() {
  const dialog = $('#mobile-search-dialog'), input = $('#mobile-search-input');
  const button = $('#mobile-search-button'), search = $('#search-filter');
  function sync() {
    search.value = input.value;
    button.classList.toggle('search-active', Boolean(input.value.trim()));
    renderTimeline();
  }
  button.addEventListener('click', () => { input.value = search.value; dialog.showModal(); input.focus(); });
  input.addEventListener('input', sync);
  $('#mobile-search-clear').addEventListener('click', () => { input.value = ''; sync(); input.focus(); });
  // Capture Escape before a search input can consume it to clear its value.
  dialog.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    dialog.close();
  }, true);
  dialog.addEventListener('cancel', event => { event.preventDefault(); dialog.close(); });
  dialog.addEventListener('pointerdown', event => {
    const rect = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) {
      event.preventDefault();
      dialog.close();
    }
  });
  dialog.addEventListener('close', () => button.focus());
  window.matchMedia('(max-width: 760px)').addEventListener('change', event => { if (!event.matches && dialog.open) dialog.close(); });
}
function scrollTimelineToToday() {
  const wrap = $('#gantt-wrap');
  if (state.layout !== 'gantt' || wrap.classList.contains('hidden')) return;
  const offset = dayDiff(timelineCalendarRange().start,clockParts(timelineReferenceTime).date);
  // The sticky label column occupies the same width in the content and viewport.
  wrap.scrollLeft = Math.max(0, offset * state.zoom);
  bindTimelineCalendarScroll();
}
function rowRenameKey(device = navigator) {
  const platform = device.userAgentData?.platform || device.platform || '';
  if (/mac/i.test(platform)) return 'Enter';
  if (/win/i.test(platform)) return 'F2';
  const agent = device.userAgent || '';
  if (/Macintosh|Mac OS X/i.test(agent)) return 'Enter';
  if (/Windows/i.test(agent)) return 'F2';
  return /Safari/i.test(agent) && !/Chrome|Chromium|CriOS|Edg|OPR|FxiOS|Android/i.test(agent) ? 'Enter' : 'F2';
}
let inlineNameEditor = null;
const rowNameDrafts = ChartEditing.createDrafts();
function startInlineRowRename(selection) {
  if (inlineNameEditor) return;
  const project = state.data.projects.find(project => selection.type === 'project' ? project.id === selection.id : project.tasks.some(task => task.id === selection.id));
  const item = selection.type === 'project' ? project : project?.tasks.find(task => task.id === selection.id);
  if (!item) return;
  const selector = selection.type === 'project' ? `.project-select[data-collapse="${CSS.escape(selection.id)}"]` : `.task-label[data-task-select="${CSS.escape(selection.id)}"]`;
  const button = $(selector, $('#gantt'));
  if (!button) return;
  const cell = button.closest('.gantt-left'), input = document.createElement('input');
  input.type='text';input.className='inline-row-name';input.value=item.name;
  input.setAttribute('aria-label',t(selection.type === 'project' ? 'project.project_production_batch_name' : 'timeline.task_name'));
  input.autocomplete='off';
  button.hidden=true;cell.append(input);inlineNameEditor=input;
  const draftKey = `${selection.type}:${selection.id}`;
  const retained = rowNameDrafts.get(draftKey);
  if (retained) input.value=retained.value;
  if (retained?.error) input.setAttribute('aria-invalid','true');
  let submitted = false;
  const save = async () => {
    if (submitted) return;
    const name=input.value.trim();
    if (!name) { input.setAttribute('aria-invalid','true');return; }
    submitted=true;
    const draft=rowNameDrafts.set(draftKey,name);
    // Release the editor before publishing the local change; never steal focus on response.
    inlineNameEditor=null;input.remove();button.hidden=false;
    document.dispatchEvent(new Event('chart-data-changed'));
    try {
      if (name !== item.name || retained?.error) {
        if(selection.type==='project') await saveProjectField(selection.id,{name});
        else await saveTaskFields(selection.id,{name});
      }
      rowNameDrafts.settle(draftKey,draft);
    } catch(error) {
      rowNameDrafts.settle(draftKey,draft,error);
      toast(error.message);
    }
  };
  input.addEventListener('keydown',event=>{
    event.stopPropagation();
    if((event.key==='Enter'||event.key==='Escape')&&!event.isComposing){event.preventDefault();save();}
  });
  input.addEventListener('input',()=>{
    input.removeAttribute('aria-invalid');
    rowNameDrafts.set(draftKey,input.value);
    const field=selection.type==='project'?$('#ins-project-name'):$('#ins-task-name');
    if(field) field.value=input.value;
    const heading=selection.type==='project'?$('#project-context-label'):$('#task-context-label');
    if(heading){heading.textContent=input.value;heading.title=input.value;}
  });
  input.addEventListener('blur',save);
  input.addEventListener('click',event=>event.stopPropagation());
  input.addEventListener('pointerdown',event=>event.stopPropagation());
  input.focus({preventScroll:true});input.select();
}
function bindRowClipboard() {
  const editable = event => event.target.closest('input,textarea,select,[contenteditable],.modal,[role="dialog"]');
  document.addEventListener('copy', event => {
    if (editable(event) || state.view !== 'timeline' || !state.selection || !event.clipboardData) return;
    if (window.getSelection()?.toString()) return;
    const {type, id} = state.selection;
    if (!['project','task'].includes(type) || id === '__unassigned__') return;
    event.clipboardData.setData('text/plain', JSON.stringify({myganttRow:1, kind:type, source_id:id}));
    event.preventDefault();
    toast(t("clipboard.copied"));
  });
  let pasting = false;
  document.addEventListener('paste', async event => {
    if (editable(event) || state.view !== 'timeline' || !event.clipboardData) return;
    let row;
    try { row = JSON.parse(event.clipboardData.getData('text/plain')); } catch { return; }
    if (row?.myganttRow !== 1 || !['project','task'].includes(row.kind) || typeof row.source_id !== 'string') return;
    event.preventDefault();
    if (pasting) return;
    pasting = true;
    const selection = state.selection ? {...state.selection} : null;
    try {
      const payload = {kind:row.kind, source_id:row.source_id};
      if (row.kind === 'task' && selection) {
        const target = state.data.projects.find(p=>selection.type === 'project' ? p.id === selection.id : p.tasks.some(task=>task.id === selection.id));
        if (target) {
          payload.project_id = target.id;
          if (selection.type === 'task') payload.anchor_id = selection.id;
        }
      }
      $('#sort-select').value = 'manual';
      const request = api('/api/duplicate', {method:'POST',body:JSON.stringify(payload)});
      persistUi();
      await request;
      toast(t("clipboard.pasted"));
    } catch(error) { toast(error.message); }
    finally { pasting = false; }
  });
}

function bindRowRenameShortcut() {
  let selectedRow = null;
  document.addEventListener('click', event => {
    const row = event.target.closest('#gantt .task-label, #gantt .project-select');
    selectedRow = row ? {type:row.dataset.taskSelect ? 'task' : 'project',id:row.dataset.taskSelect || row.dataset.collapse} : null;
  }, true); // Capture before the chart click handler replaces the selected row DOM.
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.key !== rowRenameKey()) return;
    if (event.target.closest('input,textarea,select,[contenteditable="true"],.modal')) return;
    if (state.view !== 'timeline' || state.layout !== 'gantt') return;
    const row = event.target.closest('#gantt .task-label, #gantt .project-select');
    const selection = row ? {type:row.dataset.taskSelect ? 'task' : 'project',id:row.dataset.taskSelect || row.dataset.collapse} : selectedRow;
    if (!selection?.id) return;
    event.preventDefault(); event.stopImmediatePropagation();
    state.selection = selection; state.inspectorOpen = selection.type;
    persistUi(); renderInspector();
    setMobileDrawer(null);
    startInlineRowRename(selection);
    selectedRow = null;
  }, true);
}
function syncLayoutToggle() {
  const button = $('#mobile-layout-toggle');
  button.dataset.currentLayout = state.layout;
  const label = state.layout === 'gantt' ? t("common.switch_to_list_view") : t("common.switch_to_gantt_view");
  button.setAttribute('aria-label', label);
  button.title = label;
  $$('[data-layout]').forEach(item => item.classList.toggle('selected', item.dataset.layout === state.layout));
}
function mobileLayout() { return window.matchMedia('(max-width: 760px)').matches; }
function activeMobileInspector() { return state.view === 'templates' ? $('#template-inspector') : $('#mobile-inspector'); }
let mobileDrawerReturnFocus = null;
function setMobileDrawer(panel) {
  if (!mobileLayout()) panel = null;
  if (panel) mobileDrawerReturnFocus = document.activeElement;
  // The template inspector is recreated on selection. Commit its offscreen
  // position before opening so its first appearance also slides in.
  if (panel === 'inspector' && !document.body.classList.contains('inspector-open')) {
    activeMobileInspector()?.getBoundingClientRect();
  }
  document.body.classList.toggle('menu-open', panel === 'menu');
  document.body.classList.toggle('inspector-open', panel === 'inspector');
  $('#mobile-menu-toggle').setAttribute('aria-expanded', String(mobileLayout() ? panel === 'menu' : !document.body.classList.contains('sidebar-collapsed')));
  $('#drawer-backdrop').hidden = !panel;
  const sidebar = $('.sidebar'), inspector = activeMobileInspector();
  sidebar.inert = mobileLayout() ? panel !== 'menu' : document.body.classList.contains('sidebar-collapsed');
  for (const item of $$('#mobile-inspector, #template-inspector')) item.inert = mobileLayout() && (panel !== 'inspector' || item !== inspector);
  if (panel) (panel === 'menu' ? sidebar : inspector)?.querySelector('[data-close-drawer]')?.focus();
  else if (mobileDrawerReturnFocus?.isConnected) { mobileDrawerReturnFocus.focus(); mobileDrawerReturnFocus = null; }
}
function bindMobileMenuSwipe() {
  let swipe = null;
  const options = { passive: false, capture: true };
  document.addEventListener('touchstart', event => {
    swipe = null;
    if (!mobileLayout() || event.touches.length !== 1 ||
        document.body.classList.contains('menu-open') || document.body.classList.contains('inspector-open') ||
        event.target.closest('.modal-overlay')) return;
    const touch = event.touches[0];
    if (touch.clientX > 20) return;
    // Safari's history gesture must be cancelled at the edge touchstart,
    // before it takes ownership; cancelling only touchmove is too late.
    if (event.cancelable) event.preventDefault();
    swipe = { id: touch.identifier, x: touch.clientX, y: touch.clientY, dx: 0, dy: 0, target: event.target };
  }, options);
  document.addEventListener('touchmove', event => {
    if (!swipe) return;
    if (event.touches.length !== 1) { swipe = null; return; }
    const touch = [...event.touches].find(t => t.identifier === swipe.id);
    if (!touch) return;
    swipe.dx = touch.clientX - swipe.x;
    swipe.dy = touch.clientY - swipe.y;
    if (event.cancelable) event.preventDefault();
  }, options);
  document.addEventListener('touchend', event => {
    if (!swipe) return;
    const current = swipe;
    swipe = null;
    const touch = [...event.changedTouches].find(t => t.identifier === current.id);
    if (!touch) return;
    const dx = touch.clientX - current.x, dy = touch.clientY - current.y;
    if (event.cancelable) event.preventDefault();
    if (dx >= 48 && dx > Math.abs(dy) * 1.5) setMobileDrawer('menu');
    // Preserve ordinary taps on buttons near the reserved edge.
    else if (Math.hypot(dx, dy) < 8 && Math.hypot(current.dx, current.dy) < 8) current.target.closest('button, a[href]')?.click();
  }, options);
  document.addEventListener('touchcancel', () => { swipe = null; }, options);
}
let sidebarMotion = null;
function toggleDesktopSidebar() {
  const elements = [$('.sidebar'),$('.topbar'),...$$('.view-panel:not(.hidden) .timeline-main, .view-panel:not(.hidden) .inspector')].filter(Boolean);
  const before = elements.map(el=>el.getBoundingClientRect());
  sidebarMotion?.();
  document.body.style.setProperty('--sidebar-width', `${before[0].width}px`);
  document.body.classList.toggle('sidebar-collapsed');
  setMobileDrawer(null);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const after = elements.map(el=>el.getBoundingClientRect());
  const sidebar=elements[0], visibility=sidebar.style.visibility;
  sidebar.style.visibility='visible';
  const animations=elements.map((el,i)=>el.animate([
    {transform:`translate(${before[i].left-after[i].left}px,${before[i].top-after[i].top}px)`},
    {transform:'translate(0px,0px)'}
  ],{duration:180,easing:'linear',fill:'both'}));
  const cleanup=()=>{animations.forEach(a=>a.cancel());sidebar.style.visibility=visibility;if(sidebarMotion===cleanup)sidebarMotion=null;};
  sidebarMotion=cleanup;
  Promise.all(animations.map(a=>a.finished)).then(()=>{if(sidebarMotion===cleanup)cleanup();},()=>{});
}
function bindMobileDrawers() {
  bindMobileMenuSwipe();
  $('#mobile-menu-toggle').addEventListener('click', () => {
    if(mobileLayout()) setMobileDrawer(document.body.classList.contains('menu-open') ? null : 'menu');
    else {
      toggleDesktopSidebar();
    }
  });
  $('#drawer-backdrop').addEventListener('click', () => setMobileDrawer(null));
  document.addEventListener('click', event => { if (event.target.closest('[data-close-drawer]')) setMobileDrawer(null); });
  $('.sidebar').addEventListener('click', event => {
    if (event.target.closest('.nav-item, .side-project, .template-card')) setMobileDrawer(null);
  });
  document.addEventListener('keydown', event => {
    if (!mobileLayout()) return;
    const panel = document.body.classList.contains('menu-open') ? $('.sidebar') : document.body.classList.contains('inspector-open') ? activeMobileInspector() : null;
    if (!panel) return;
    if (event.key === 'Escape') { event.preventDefault(); setMobileDrawer(null); }
    if (event.key === 'Tab') {
      const items = [...panel.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')].filter(el => !el.disabled && el.getClientRects().length);
      const first=items[0], last=items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  window.matchMedia('(max-width: 760px)').addEventListener('change', () => { setMobileDrawer(null); renderTimeline(); if (state.draft) renderTemplateEditor(); });
  setMobileDrawer(null);
}

function focusCreatedName() {
  const target = state.pendingNameFocus;
  if (!target) return;
  state.pendingNameFocus = null;
  if (state.selection?.type !== target.type || state.selection.id !== chartMutations.resolveId(target.id)) return;
  if (document.activeElement?.closest('input,textarea,select,[contenteditable]')) return;
  if (mobileLayout()) setMobileDrawer('inspector');
  const input = target.type === 'project' ? $('#ins-project-name') : $('#ins-task-name');
  input?.focus();input?.select();
}
function bindChartAutoRefresh() {
  const renderer = ChartEditing.createRenderer({
    frame:callback=>requestAnimationFrame(callback),
    blocked:()=>Boolean(state.drag || inlineNameEditor?.isConnected),
    render() {
      if (state.view === 'timeline') {
        syncInspectorProjection();
        renderSidebar();
        renderTimeline({preserveInspector:true});
        focusCreatedName();
      } else if (state.view === 'templates') renderTemplateList();
    },
  });
  document.addEventListener('chart-data-changed', renderer.request);
}
function attachEvents() {
  bindGroupSuggestions();
  bindRandomColorButtons();
  bindRowRenameShortcut();
  bindRowClipboard();
  $('#holiday-country-select').addEventListener('change', async event => {
    const select = event.target;
    const previous = state.data.holiday_country || 'KR';
    select.disabled = true;
    try {
      await api('/api/settings/holiday-calendar', {method:'PATCH', body:JSON.stringify({holiday_country:select.value})});
      await loadState();
    } catch (error) {
      select.value = previous;
      toast(error.message);
    } finally { select.disabled = false; }
  });
  $('#language-select').value = I18n.language;
  $('#language-select').addEventListener('change', async event => {
      I18n.setLanguage(event.target.value);
    I18n.apply(document);
    $('#breadcrumb-title').textContent = t({timeline:'navigation.all_schedules',templates:'navigation.schedule_templates',settings:'navigation.settings'}[state.view]);
    $('#page-description').textContent = t({timeline:'navigation.view_each_project_s_daily_schedule',templates:'navigation.define_a_workflow_once_and_apply',settings:'navigation.view_the_app_version_and_public'}[state.view]);
    syncLayoutToggle();
    renderAll();
  });
  bindMobileSearch();
  bindCascadeHelp();
  bindChartAutoRefresh();
  bindMobileDrawers();
  bindTaskReordering();
  const cascadeSetting = $('#cascade-setting');
  cascadeSetting.checked = state.cascadeDependents;
  cascadeSetting.addEventListener('change', () => setCascadeSetting(cascadeSetting.checked));
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  $('#new-project').addEventListener('click', openInstantiate);
  $('#new-project-side').addEventListener('click', openInstantiate);
  $('#create-template').addEventListener('click', createTemplate);
  $('#import-project-template').addEventListener('click', openProjectTemplateImport);
  $('#export-calendar').addEventListener('click', () => { window.location.href = '/api/export/calendar.ics'; });
  $('#search-filter').addEventListener('input', renderTimeline);
  $('#status-filter').addEventListener('change', renderTimeline);
  $('#sort-select').addEventListener('change', () => { renderSidebar(); renderTimeline(); });
  $$('[data-layout]').forEach((button) => button.addEventListener('click', () => {
    state.layout = button.dataset.layout;
    syncLayoutToggle();
    renderTimeline();
    scrollTimelineToToday();
  }));
  $('#mobile-layout-toggle').addEventListener('click', () => {
    state.layout = state.layout === 'gantt' ? 'list' : 'gantt';
    syncLayoutToggle();
    renderTimeline();
    scrollTimelineToToday();
  });
  syncLayoutToggle();
  const zoomSlider = $('#zoom-slider');
  zoomSlider.value = state.zoom;
  const initialZoomLabel = `${Math.round(state.zoom / 46 * 100)}%`;
  $('#zoom-value').textContent = initialZoomLabel;
  zoomSlider.setAttribute('aria-valuetext', initialZoomLabel);
  let zoomFrame = null;
  zoomSlider.addEventListener('input', () => {
    const value = Math.max(24, Math.min(62, Number(zoomSlider.value)));
    const label = `${Math.round(value / 46 * 100)}%`;
    $('#zoom-value').textContent = label;
    zoomSlider.setAttribute('aria-valuetext', label);
    if (zoomFrame !== null) cancelAnimationFrame(zoomFrame);
    zoomFrame = requestAnimationFrame(() => {
      zoomFrame = null;
      const wrap = $('#gantt-wrap');
      const oldLeft = wrap.scrollLeft, oldTop = wrap.scrollTop;
      const halfVisible = Math.max(0, wrap.clientWidth - ($('.gantt-head-left', $('#gantt'))?.getBoundingClientRect().width || 254)) / 2;
      const centerDay = (oldLeft + halfVisible) / state.zoom;
      state.zoom = value;
      persistUi();
      renderTimeline({ preserveInspector: true });
      wrap.scrollLeft = oldLeft === 0 ? 0 : centerDay * value - halfVisible;
      wrap.scrollTop = oldTop;
    });
  });
  $('#today-button').addEventListener('click', scrollTimelineToToday);
  $('#gantt').addEventListener('pointerdown', (event) => {
    const handle = event.target.closest('.resize-handle');
    const bar = handle?.closest('.task-bar, .actual-task-bar') || event.target.closest('.task-bar, .actual-task-bar');
    if (!bar || !event.isPrimary || event.button !== 0) return;
    event.preventDefault();
    const edge = handle?.dataset.resizeEdge || 'move';
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
      handle: handle || bar,
      startX: event.clientX,
      startY: event.clientY,
      active: edge !== 'move',
      pxPerDay,
      left: Number.parseFloat(bar.style.left) || 0,
      width: Number.parseFloat(bar.style.width) || pxPerDay,
      period,
      originalStart,
      originalFinish,
      displayStart: period === 'actual' ? actualTaskRange(task).start : originalStart || originalFinish,
      previewFields: {},
      delta: 0,
      valid: true,
    };
    if (edge === 'move') {
      const pending = state.drag;
      pending.holdTimer = setTimeout(() => {
        if (state.drag !== pending || !bar.isConnected) return;
        pending.active = true;
        bar.classList.add('is-resizing');
      }, 450);
    } else bar.classList.add('is-resizing');
    (handle || bar).setPointerCapture(event.pointerId);
  });
  $('#gantt').addEventListener('pointermove', (event) => {
    const drag = state.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!drag.active) {
      if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > 8) {
        clearTimeout(drag.holdTimer);
        state.drag = null;
      }
      return;
    }
    const delta = Math.round((event.clientX - drag.startX) / drag.pxPerDay);
    const candidate = draggedDateChange(drag, delta);
    drag.delta = delta;
    drag.valid = candidate.valid;
    drag.handle.classList.toggle('resize-invalid', !drag.valid);
    if (!drag.valid) return;
    drag.previewFields = candidate.fields;
    const original = state.data.projects.find(p => p.id === drag.projectId)?.tasks.find(t => t.id === drag.taskId);
    const display = drag.period === 'actual' ? actualTaskRange({...original, ...candidate.fields}) : candidate;
    const displayWidth = (dayDiff(display.start, display.finish) + 1) * drag.pxPerDay;
    drag.bar.style.left = `${drag.left + dayDiff(drag.displayStart, display.start) * drag.pxPerDay}px`;
    drag.bar.style.width = `${displayWidth}px`;
    if (drag.period === 'actual' && display.openSide) {
      const shape = actualOpenStyle(display, displayWidth).match(/clip-path:([^;]+);/);
      drag.bar.style.clipPath = shape[1];
    }
    renderDependencyLinks();
    drag.bar.title = `${drag.period === 'actual' ? t("timeline.actual") : t("status.planned")} · ${fmtDate(candidate.start, true)}–${fmtDate(candidate.finish, true)}`;
  });
  $('#gantt').addEventListener('pointerup', async (event) => {
    const drag = state.drag;
    if (!drag || event.pointerId !== drag.pointerId) return;
    clearTimeout(drag.holdTimer);
    event.preventDefault();
    drag.bar.classList.remove('is-resizing');
    drag.handle.classList.remove('resize-invalid');
    state.drag = null;
    if (!drag.delta && drag.edge === 'move') {
      // Preserve the button for the ensuing click selection.
      drag.bar.style.left = `${drag.left}px`;
      drag.bar.style.width = `${drag.width}px`;
      renderDependencyLinks();
      return;
    }
    if (!drag.valid || !drag.delta) { renderTimeline(); return; }
    const candidate = draggedDateChange(drag, drag.delta);
    try {
      await saveDraggedTaskDates(drag.taskId, candidate.fields, drag.period);
    } catch (error) {
      toast(error.message);
    }
  });
  $('#gantt').addEventListener('pointercancel', (event) => {
    if (!state.drag || event.pointerId !== state.drag.pointerId) return;
    clearTimeout(state.drag.holdTimer);
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
      if (!mobileLayout()) {
        state.selection = { type: 'project', id: projectId };
        state.inspectorOpen = 'project';
        persistUi();
        renderInspector();
      }
      projectMotion.toggle(projectId);
      return;
    }
    if (event.target.closest('.resize-handle')) { event.preventDefault(); return; }
    const selectedProject = event.target.closest('[data-project-select]');
    if (selectedProject) { selectItem('project', selectedProject.dataset.projectSelect); return; }
    const selectedTask = event.target.closest('[data-task-select]');
    if (selectedTask) { selectItem('task', selectedTask.dataset.taskSelect); return; }
    // Blank chart cells and the date axis clear selection; controls retain
    // their own actions (including add, help, and inline name editing).
    if (event.target.closest('button,input,textarea,select,[contenteditable],[role="button"]') || state.drag || !state.selection) return;
    state.selection = null;
    state.inspectorOpen = '';
    persistUi();
    renderSidebar();
    renderTimeline();
    setMobileDrawer(null);
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

const projectMotion = createProjectMotion({getState:()=>state, render:()=>{renderSidebar();renderTimeline({preserveInspector:true});}, persist:persistUi});
I18n.apply(document);
bindFloatingHelp();
bindTextCellSelection(document);
attachEvents();
loadState().catch((error) => { toast(t("common.cannot_connect_to_the_local_backend", {p0:error.message})); $('#gantt').innerHTML = `<div class="empty-state"><strong>${t("common.check_that_the_server_is_running")}</strong><span>python3 -m mygantt.server --port 8765</span></div>`; });

});
