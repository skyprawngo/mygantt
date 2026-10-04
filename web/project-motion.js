/* Presentation-only transitions. Task dates and records are never changed here. */
function createProjectMotion({getState, render, persist, redraw = () => {}}) {
  const completed = new Map(), running = new Set();
  let queue = Promise.resolve();
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rowFor = id => [...document.querySelectorAll('#gantt [data-collapse]')].find(el => el.dataset.collapse === id)?.closest('.project-row');
  const taskRows = id => [...document.querySelectorAll('#gantt .task-row')].filter(row => row.querySelector('[data-project]')?.dataset.project === id);
  const emit = (phase, projectId, action) => document.dispatchEvent(new CustomEvent(`project-animation-${phase}`, {detail:{projectId, action}}));
  async function animate(el, frames, duration) {
    if (!el || reduced()) return;
    const animation = el.animate(frames, {duration, easing:'cubic-bezier(.22,.7,.25,1)', fill:'forwards'});
    try { await animation.finished; } catch {} finally { animation.cancel(); }
  }
  async function animateRows(id, collapse) {
    if (reduced()) return;
    const rows = taskRows(id).map(row => {
      const cells = [...row.children];
      const left = cells.find(cell => cell.classList.contains('gantt-left'));
      // Keep the sticky, opaque surface above every timeline layer. Only its
      // contents may fade/scale; fading the cell exposes the morphing band.
      const animated = cells.flatMap(cell => cell === left ? [...cell.children] : [cell]);
      return {row, height:row.getBoundingClientRect().height, left, animated};
    });
    if (!rows.length) return;
    const band = [...document.querySelectorAll('#gantt .project-duration-band')].find(el => el.dataset.projectBand === id);
    const projectRow = rowFor(id);
    const summary = projectRow?.querySelector('.project-summary-bar');
    const bandTop = band ? parseFloat(band.style.top) : 0;
    const bandHeight = band ? parseFloat(band.style.height) : 0;
    const summaryTop = summary ? summary.offsetTop : 7;
    const summaryHeight = summary ? summary.offsetHeight : 23;
    const laterBands = band ? [...document.querySelectorAll('#gantt .project-duration-band')]
      .filter(el => parseFloat(el.style.top) > bandTop)
      .map(el => ({el,top:parseFloat(el.style.top)})) : [];
    const totalHeight = rows.reduce((sum,item)=>sum+item.height,0);
    // Keep the real surface below the calendar throughout the transition.
    // A separate solid cover fades away, so removing it cannot reveal grid lines
    // abruptly on the final frame.
    const cover = band?.cloneNode(false);
    if (cover) {
      cover.removeAttribute('data-project-band');
      cover.classList.add('project-morph-cover');
      band.after(cover);
    }
    if (band) band.classList.add('project-band-morphing');
    projectRow?.classList.add('project-row-morphing');
    // Never transform/fade the row itself: that creates a stacking context above
    // the sticky label column. Paint SVG bars from the same geometry each frame.
    const apply = fraction => {
      for (const {row,height,left,animated} of rows) {
        row.style.height = `${height*fraction}px`;
        row.style.minHeight = '0';
        left?.classList.add('project-motion-label');
        for (const cell of animated) {
          cell.style.transformOrigin = 'top';
          cell.style.transform = `scaleY(${fraction})`;
          cell.style.opacity = String(fraction);
          cell.style.borderBottomColor = `rgba(233,237,242,${fraction})`;
        }
      }
      if (band) {
        band.style.top = `${bandTop+summaryTop*(1-fraction)}px`;
        band.style.height = `${summaryHeight+(bandHeight-summaryHeight)*fraction}px`;
        band.style.background = `color-mix(in srgb, var(--bar-color) ${100*(1-fraction)}%, var(--bar-surface))`;
        band.style.setProperty('--morph-progress-color', `color-mix(in srgb, var(--bar-dark) ${100*(1-fraction)}%, var(--bar-light))`);
        if (cover) {
          cover.style.top = band.style.top;
          cover.style.height = band.style.height;
          cover.style.opacity = String(1-fraction);
          cover.style.visibility = fraction === 0 ? 'hidden' : '';
        }
        for (const {el,top} of laterBands) el.style.top = `${top-totalHeight*(1-fraction)}px`;
      }
      if (summary) {
        summary.style.color = `color-mix(in srgb, var(--bar-ink) ${100*(1-fraction)}%, var(--bar-dark))`;
        summary.style.borderLeftColor = `color-mix(in srgb, transparent ${100*(1-fraction)}%, var(--bar-color))`;
      }
      // Use the real collapsed bar at the endpoint, including its progress fill,
      // padding, border and text styling. Do not substitute a background-band copy.
      if (summary) {
        summary.classList.toggle('expanded-project-label', fraction > 0);
        if (fraction === 0) {
          summary.style.removeProperty('color');
          summary.style.removeProperty('border-left-color');
        }
      }
      if (band) band.style.visibility = fraction === 0 ? 'hidden' : '';
      redraw();
    };
    apply(collapse ? 1 : 0);
    try {
      await new Promise(resolve => {
        const start = performance.now();
        function frame(now) {
          const t = Math.min(1,(now-start)/320), eased = 1-Math.pow(1-t,3);
          apply(collapse ? 1-eased : eased);
          if (t < 1) requestAnimationFrame(frame); else resolve();
        }
        requestAnimationFrame(frame);
      });
    } finally {
      cover?.remove();
      // Collapsing immediately replaces these nodes in fold(). Preserve the last
      // frame until that replacement instead of restoring the expanded geometry.
      if (!collapse) {
        projectRow?.classList.remove('project-row-morphing');
        if (band) {
          band.style.removeProperty('visibility');
          band.classList.remove('project-band-morphing');
          band.style.top = `${bandTop}px`; band.style.height = `${bandHeight}px`;
          band.style.removeProperty('background'); band.style.removeProperty('--morph-progress-color');
          for (const {el,top} of laterBands) el.style.top = `${top}px`;
        }
        if (summary) {summary.style.removeProperty('color');summary.style.removeProperty('border-left-color');}
        for (const {row,left,animated} of rows) {
          row.style.removeProperty('height'); row.style.removeProperty('min-height');
          left?.classList.remove('project-motion-label');
          for (const cell of animated) for (const property of ['transform-origin','transform','opacity','border-bottom-color']) cell.style.removeProperty(property);
        }
      }
    }
  }
  async function fold(id, collapse) {
    const state = getState();
    emit('start', id, collapse ? 'collapse' : 'expand');
    try {
      if (collapse) {
        await animateRows(id,true);
        state.collapsedProjects.add(id);
        render();
      } else {
        state.collapsedProjects.delete(id);
        render();
        await animateRows(id,false);
        redraw();
      }
      persist();
    } finally { emit('end', id, collapse ? 'collapse' : 'expand'); }
  }
  async function finish(id) {
    const state = getState();
    const project = state.data.projects.find(p => p.id === id);
    if (!project || !project.tasks.length || !project.tasks.every(t => t.progress === 100) || state.hiddenProjects.has(id)) return;
    emit('start',id,'complete');
    try {
      await fold(id,true);
      // Let the collapsed DOM paint before measuring and starting the flight.
      if (!reduced()) await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const source = rowFor(id);
      const destination = [...document.querySelectorAll('.side-project')].find(el => el.dataset.project === id);
      if (source && destination && !reduced()) {
        const from = source.getBoundingClientRect(), to = destination.getBoundingClientRect();
        // A mobile drawer may be off-screen; use the menu button as its visible destination.
        const menu = document.querySelector('#mobile-menu-toggle');
        const target = to.right > 0 && to.left < innerWidth ? to : menu?.getBoundingClientRect();
        if (target && from.bottom > 0 && from.top < innerHeight) {
          const ghost = document.createElement('div');
          ghost.className = 'project-completion-ghost';
          ghost.setAttribute('aria-hidden','true');
          const chart = source.closest('#gantt').getBoundingClientRect();
          const left = Math.max(0,from.left,chart.left);
          const right = Math.min(innerWidth,from.right,chart.right);
          Object.assign(ghost.style,{left:`${left}px`,top:`${from.top}px`,width:`${Math.max(1,right-left)}px`,height:`${from.height}px`});
          // Carry the actual collapsed row, not a newly styled replacement card.
          const snapshot = source.cloneNode(true);
          snapshot.style.cssText = source.style.cssText;
          Object.assign(snapshot.style,{position:'absolute',left:'0',top:'0',width:`${from.width}px`,height:`${from.height}px`,margin:'0'});
          [...source.children].forEach((cell,index) => {
            const rect = cell.getBoundingClientRect();
            Object.assign(snapshot.children[index].style,{position:'absolute',left:`${rect.left-left}px`,top:`${rect.top-from.top}px`,width:`${rect.width}px`,height:`${rect.height}px`});
          });
          ghost.append(snapshot);
          document.body.append(ghost);
          source.style.opacity='0';
          emit('start',id,'transfer');
          try {
            await animate(ghost,[{transform:'translate(0,0) scale(1)',opacity:1},{transform:`translate(${target.left-left}px,${target.top-from.top}px) scale(${Math.min(1,target.width/ghost.offsetWidth)},${Math.min(1,target.height/from.height)})`,opacity:.3}],560);
          } finally {ghost.remove();emit('end',id,'transfer');}
          // Keep the original invisible until the final render removes it.
          // Restoring it here would flash the row back into the chart.
        }
      }
      // Recheck after animation: an intervening edit may have reopened the project.
      const current = state.data.projects.find(p => p.id === id);
      if (current?.tasks.length && current.tasks.every(t => t.progress === 100)) {
        state.hiddenProjects.add(id);
        persist();
        render();
      } else if (source) {
        source.style.opacity='';
      }
    } finally {emit('end',id,'complete');}
  }
  function enqueue(id, action) {
    if (running.has(id)) return;
    running.add(id);
    queue = queue.catch(()=>{}).then(action).finally(()=>running.delete(id));
    return queue;
  }
  return {
    observe() {
      for (const project of getState().data.projects) {
        const done = project.tasks.length > 0 && project.tasks.every(task => task.progress === 100);
        if (!project.is_unassigned && done && completed.get(project.id) === false) enqueue(project.id,()=>finish(project.id));
        completed.set(project.id,done);
      }
    },
    toggle(id) { return enqueue(id,()=>fold(id,!getState().collapsedProjects.has(id))); },
  };
}
