/* Notes keep their editors mounted so tab changes never discard an active draft. */
I18n.ready.then(() => {
  const t = key => I18n.t(`notes.${key}`);
  const tabs = document.querySelector('#notes-tabs');
  const panels = document.querySelector('#notes-panels');
  const bookmarks = document.querySelector('.notes-bookmarks');
  const motions = new WeakMap();
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const add = document.querySelector('#notes-add');
  const message = document.querySelector('#notes-message');
  const colors = ['#fff4c2', '#e8f3ce', '#e2f0ff', '#f4e5f5', '#ffe9d6'];
  const editors = [];
  let active = null;
  async function request(path, method = 'GET', body) {
    const response = await fetch(path, {method, headers: {'Content-Type':'application/json'},
      ...(body === undefined ? {} : {body:JSON.stringify(body)})});
    if (!response.ok) throw new Error(t('retry'));
    return response.json();
  }
  function reveal(element, visible) {
    const previous = motions.get(element);
    const from = previous ? {opacity:getComputedStyle(element).opacity, transform:getComputedStyle(element).transform} : null;
    previous?.cancel();
    motions.delete(element);
    element.inert = !visible;
    if (!visible && element.hidden) return Promise.resolve();
    element.hidden = false;
    if (reduceMotion.matches) {
      element.hidden = !visible;
      return Promise.resolve();
    }
    const shown = {opacity:1, transform:'translateY(0)'};
    const concealed = {opacity:0, transform:'translateY(18px)'};
    const animation = element.animate([from || (visible ? concealed : shown), visible ? shown : concealed],
      {duration:180, easing:'cubic-bezier(.2,.7,.2,1)', fill:'both'});
    motions.set(element, animation);
    return animation.finished.then(() => {
      if (motions.get(element) !== animation) return;
      element.hidden = !visible;
      motions.delete(element);
      animation.cancel();
    }, () => {});
  }
  function select(editor) {
    const previous = active;
    active = editor === active ? null : editor;
    const transitions = [reveal(bookmarks, !active)];
    for (const item of editors) {
      if (item === active || item === previous) transitions.push(reveal(item.panel, item === active));
      item.tab.setAttribute('aria-expanded', String(item === active));
    }
    if (active) active.panel.querySelector('input').focus({preventScroll:true});
    return Promise.all(transitions);
  }
  function mount(note) {
    const tab = document.createElement('button');
    tab.type = 'button'; tab.className = 'note-bookmark';
    tab.textContent = note.title || t('new');
    tab.setAttribute('aria-controls', `note-${note.id}`);
    tab.setAttribute('aria-expanded', 'false');
    const panel = document.createElement('section');
    panel.className = 'note-panel'; panel.id = `note-${note.id}`; panel.hidden = true;
    panel.setAttribute('aria-label', t('label'));
    for (const element of [panel,tab]) element.style.setProperty('--note-color', colors[note.color] || colors[0]);
    const header = document.createElement('div'); header.className = 'note-heading';
    const title = document.createElement('input');
    title.value = note.title; title.maxLength = 200; title.placeholder = t('title');
    title.setAttribute('aria-label', t('title'));
    const status = document.createElement('button'); status.type = 'button';
    status.className = 'note-save'; status.setAttribute('aria-live','polite');
    const close = document.createElement('button'); close.type = 'button';
    close.className = 'note-delete'; close.textContent = '×';
    close.setAttribute('aria-label', t('delete')); close.title = t('delete');
    const content = document.createElement('textarea');
    content.value = note.content; content.maxLength = 100000;
    content.placeholder = t('content'); content.setAttribute('aria-label', t('label'));
    header.append(title, status, close); panel.append(header, content);
    tabs.append(tab); panels.append(panel);
    let timer, deleting = false, queue = Promise.resolve();
    const fields = ChartEditing.createFields({inputs:[title,content], valueFor:() => undefined,
      changed:() => {
        status.textContent = t(fields.errors.size ? 'retry' : fields.pending ? 'saving' : fields.dirty ? 'dirty' : 'saved');
        status.disabled = !fields.errors.size && !fields.dirty;
      }});
    function save() {
      clearTimeout(timer);
      if (deleting) return;
      const affected = [title,content].filter(input => fields.needsSave(input));
      if (!affected.length) return;
      const payload = {};
      if (affected.includes(title)) payload.title = title.value;
      if (affected.includes(content)) payload.content = content.value;
      // Capture now, serialize writes, and never put an older response into the editor.
      fields.save(affected, () => {
        const next = queue.then(() => request(`/api/notes/${note.id}`, 'PATCH', payload));
        queue = next.catch(() => {});
        return next;
      }).catch(() => {});
    }
    const editor = {tab,panel,fields,save}; editors.push(editor);
    for (const input of [title,content]) {
      input.addEventListener('input', () => {
        fields.edit(input); tab.textContent = title.value || t('new');
        clearTimeout(timer); timer = setTimeout(save, 500);
      });
      input.addEventListener('blur', save);
    }
    status.addEventListener('click', save);
    tab.addEventListener('click', () => { active?.save(); select(editor); });
    close.addEventListener('click', async () => {
      if (deleting) return;
      deleting = true; clearTimeout(timer); close.disabled = true;
      title.disabled = content.disabled = true;
      message.textContent = '';
      try {
        // Let in-flight autosaves finish before deletion; no timer may recreate a write.
        await queue;
        await request(`/api/notes/${note.id}`, 'DELETE');
        if (active === editor) await select(editor);
        editors.splice(editors.indexOf(editor), 1);
        panel.remove(); tab.remove(); add.focus();
      } catch {
        deleting = false; close.disabled = false;
        title.disabled = content.disabled = false;
        message.textContent = t('delete_failed');
        status.textContent = t('delete_failed');
      }
    });
    panel.addEventListener('keydown', event => {
      if (Shortcuts.matches(event,'close') && !event.isComposing) { event.stopPropagation(); save(); select(editor); tab.focus({preventScroll:true}); }
    });
    fields.sync();
    return editor;
  }
  document.addEventListener('pointerdown', event => {
    if (active && !active.panel.contains(event.target) && !event.target.closest('.note-bookmark')) {
      active.save(); select(active);
    }
  });
  add.addEventListener('click', async () => {
    add.disabled = true; message.textContent = '';
    try {
      const note = await request('/api/notes', 'POST', {title:t('new')});
      const editor = mount(note); select(editor);
      editor.panel.querySelector('input').focus(); editor.panel.querySelector('input').select();
    } catch { message.textContent = t('retry'); }
    finally { add.disabled = false; }
  });
  async function load() {
    add.disabled = true; message.replaceChildren();
    try { (await request('/api/notes')).forEach(mount); add.disabled = false; }
    catch {
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = t('load');
      retry.addEventListener('click', load); message.append(retry);
    }
  }
  window.addEventListener('beforeunload', event => {
    if (editors.some(editor => editor.fields.dirty || editor.fields.pending)) {
      event.preventDefault(); event.returnValue = '';
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) editors.forEach(editor => editor.save());
  });
  reveal(bookmarks, true);
  load();
});
