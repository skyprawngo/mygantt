// Only endpoint artwork owned by the folding project fades in its header.
function isProjectHeaderConnection(dataset, projectId) {
  return dataset.boundaryProject===projectId || dataset.connectionSource===projectId || dataset.connectionTarget===projectId;
}
function projectTextFrames(isFoldingProject, followsProject, height, expandedColor, foldedColor) {
  return {
    folded:{transform:`translateY(${followsProject?-height:0}px)`,color:isFoldingProject?foldedColor:expandedColor,opacity:1},
    expanded:{transform:'translateY(0px)',color:expandedColor,opacity:1},
  };
}
/* Presentation-only transitions. Task dates and records are never changed here. */
function createProjectMotion({getState, render, persist}) {
  const completed = new Map(), running = new Set();
  let queue = Promise.resolve();
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const rowFor = id => [...document.querySelectorAll('#gantt [data-collapse]')].find(el => el.dataset.collapse === id)?.closest('.project-row');
  const taskRows = id => [...document.querySelectorAll('#gantt .task-row')].filter(row => row.querySelector('[data-project]')?.dataset.project === id);
  const emit = (phase, projectId, action) => document.dispatchEvent(new CustomEvent(`project-animation-${phase}`, {detail:{projectId, action}}));
  async function animate(el, frames, duration) {
    if (!el || reduced()) return;
    const animation = el.animate(frames, {duration, easing:'cubic-bezier(.33,0,.67,1)', fill:'forwards'});
    try { await animation.finished; } catch {} finally { animation.cancel(); }
  }
  let snapshotId = 0;
  function cloneLayer(layer) {
    const clone = layer.cloneNode(true), ids = new Map();
    for (const node of [clone,...clone.querySelectorAll('[id]')]) {
      if (node.id) { const id = `${node.id}-motion-${++snapshotId}`; ids.set(node.id,id); node.id=id; }
    }
    for (const node of [clone,...clone.querySelectorAll('*')]) for (const attr of [...node.attributes]) {
      let value = attr.value.replace(/url\(#([^)]*)\)/g,(match,id)=>ids.has(id)?`url(#${ids.get(id)})`:match);
      if (value.startsWith('#') && ids.has(value.slice(1))) value=`#${ids.get(value.slice(1))}`;
      if (value!==attr.value) node.setAttribute(attr.name,value);
    }
    clone.setAttribute('aria-hidden','true');
    layer.after(clone);
    return clone;
  }
  async function animateRows(id, collapse) {
    if (reduced()) return;
    const rows = taskRows(id);
    if (!rows.length) return;
    const body = rows[0].parentElement, origin = body.getBoundingClientRect().top;
    const geometry = rows.map(row=>({row,rect:row.getBoundingClientRect()}));
    const top = geometry[0].rect.top-origin, bottom = geometry.at(-1).rect.bottom-origin;
    const height = bottom-top;
    if (height<=0) return;
    const bands = [...body.querySelectorAll('.project-duration-band')];
    const band = bands.find(el=>el.dataset.projectBand===id);
    const bandHeight = band ? parseFloat(band.style.height) : 0;
    const projectRow = rowFor(id);
    const summary = projectRow?.querySelector('.project-summary-bar');
    const headerTop = top-(projectRow?.getBoundingClientRect?.().height || 38);
    const summaryTop = summary?.offsetTop ?? 7, summaryHeight = summary?.offsetHeight ?? 23;
    const layers = [...body.querySelectorAll('.dependency-layer, .dependency-hidden-layer, .task-selection-layer')]
      .map(layer=>({layer,height:layer.getBoundingClientRect().height}));
    // Read geometry and copy computed styles before any animation/DOM writes.
    const followingRows = [...body.querySelectorAll(':scope > .gantt-row')]
      .filter(row=>row.offsetTop>=bottom-.5 && !rows.includes(row));
    const bodyRect=body.getBoundingClientRect();
    const labels=[...body.querySelectorAll('.project-summary-bar')].flatMap(bar=>{
      const text=bar.querySelector('span');
      if (!text) return [];
      const rect=text.getBoundingClientRect(), barRect=bar.getBoundingClientRect();
      const own=bar===summary, follows=barRect.top-origin>=bottom-.5;
      if (!own && !follows) return [];
      const style=getComputedStyle(text), barStyle=getComputedStyle(bar);
      return [{text,rect,barRect,own,follows,font:style.font,lineHeight:style.lineHeight,
        letterSpacing:style.letterSpacing,color:style.color,
        foldedColor:barStyle.getPropertyValue('--bar-ink').trim() || style.color}];
    });
    const saved = new Map(), animations = [], snapshots = [], effects = [];
    const remember = el => {if (!saved.has(el)) saved.set(el,el.style.cssText);};
    const motion = (el,folded,expanded) => {
      remember(el);
      effects.push({el,frames:collapse?[expanded,folded]:[folded,expanded]});
    };
    try {
      // Keep layout fixed during the compositor animation. Translate individual
      // paint elements rather than their parent, preserving SVG/text stacking.
      body.classList.add('project-fold-animating');
      // Sticky summary labels get their own paint layer, above the changing
      // project fill and SVG. Preserve the text until the final DOM replaces it.
      for (const {text,rect,barRect,own,follows,font,lineHeight,letterSpacing,color,foldedColor} of labels) {
        const copy=document.createElement('span');
        copy.className='project-motion-text';copy.textContent=text.textContent;
        copy.setAttribute('aria-hidden','true');
        Object.assign(copy.style,{left:`${rect.left-bodyRect.left}px`,top:`${rect.top-origin}px`,
          width:`${Math.max(0,Math.min(rect.right,barRect.right)-rect.left)}px`,height:`${rect.height}px`,
          font,lineHeight,letterSpacing,color});
        body.append(copy);snapshots.push(copy);
        const frames=projectTextFrames(own,follows,height,color,foldedColor);
        motion(copy,frames.folded,frames.expanded);
        remember(text);text.style.visibility='hidden';
      }

      for (const {row,rect} of geometry) {
        const offset=rect.top-origin-top;
        for (const cell of row.children) {
          const elements=cell.classList.contains('gantt-left')?[cell]:[...cell.children];
          for (const element of elements) {
            remember(element);element.style.transformOrigin='0 0';
            motion(element,{transform:`translateY(${-offset}px) scaleY(0)`},{transform:'translateY(0px) scaleY(1)'});
          }
        }
      }
      for (const row of followingRows) {
        for (const cell of row.children) for (const element of cell.classList.contains('gantt-left')?[cell]:[...cell.children])
          motion(element,{transform:`translateY(${-height}px)`},{transform:'translateY(0px)'});
      }
      for (const later of bands.filter(el=>parseFloat(el.style.top)>=bottom-0.5 && el!==band)) {
        motion(later,{transform:`translateY(${-height}px)`},{transform:'translateY(0px)'});
      }
      if (band) {
        remember(band);band.style.transformOrigin='0 0';
        const folded={transform:`translateY(${summaryTop}px) scaleY(${summaryHeight/bandHeight})`};
        const expanded={transform:'translateY(0px) scaleY(1)'};
        motion(band,folded,expanded);
        const cover=band.cloneNode(false);cover.removeAttribute('data-project-band');
        cover.classList.add('project-morph-cover');band.after(cover);snapshots.push(cover);
        motion(cover,{...folded,opacity:1},{...expanded,opacity:0});
      }
      // Three vector regions share the rows' native timing. Labels retain
      // their sticky opaque surface; the SVG stays behind the HTML handles.
      for (const {layer,height:layerHeight} of layers) {
        remember(layer);
        const middle=cloneLayer(layer),after=cloneLayer(layer);snapshots.push(middle,after);
        const owned=[...layer.querySelectorAll('[data-connection-source], .dependency-boundary-marker')]
          .some(node=>isProjectHeaderConnection(node.dataset,id));
        if (owned) {
          // The project header is outside the collapsing task rows. Give that
          // strip its own effect so endpoint tails do not linger until render().
          const header=cloneLayer(layer);snapshots.push(header);
          header.style.clipPath=`inset(${Math.max(0,headerTop)}px 0 ${Math.max(0,layerHeight-top)}px 0)`;
          layer.style.clipPath=`inset(0 0 ${Math.max(0,layerHeight-headerTop)}px 0)`;
          for (const node of header.querySelectorAll('[data-connection-source], .dependency-boundary-marker')) {
            if (!isProjectHeaderConnection(node.dataset,id)) continue;
            if (node.classList.contains('dependency-boundary-marker')) {
              remember(node);node.style.transformOrigin=`0 ${node.dataset.boundaryY}px`;
              motion(node,{transform:'scaleY(0)',opacity:0},{transform:'scaleY(1)',opacity:1});
            } else motion(node,{opacity:0},{opacity:1});
          }
        } else layer.style.clipPath=`inset(0 0 ${Math.max(0,layerHeight-top)}px 0)`;
        middle.style.clipPath=`inset(${top}px 0 ${Math.max(0,layerHeight-bottom)}px 0)`;
        after.style.clipPath=`inset(${bottom}px 0 0 0)`;
        middle.style.transformOrigin=after.style.transformOrigin='0 0';
        const x=Number(layer.dataset.columnOffset || 0);
        motion(middle,{transform:`translate(${x}px,${top}px) scaleY(0)`,opacity:0},{transform:`translate(${x}px,0px) scaleY(1)`,opacity:1});
        motion(after,{transform:`translate(${x}px,${-height}px)`},{transform:`translate(${x}px,0px)`});
      }
      // Install the initial pose without advancing its clock. Allow it to paint
      // once, then start every effect on the same document timeline timestamp.
      // SVG preparation must never consume the first part of the 200ms effect.
      for (const {el,frames} of effects) {
        const animation=el.animate(frames,{duration:200,easing:'linear',fill:'both'});
        animation.pause();animation.currentTime=0;
        animations.push(animation);
      }
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      const startTime=document.timeline.currentTime;
      for (const animation of animations) {
        animation.play();animation.startTime=startTime;
      }
      await Promise.all(animations.map(a=>a.finished));
    } catch(error) {
      if (error?.name!=='AbortError') throw error;
    } finally {
      for(const animation of animations) animation.cancel();
      for(const [el,cssText] of saved) el.style.cssText=cssText;
      for(const snapshot of snapshots) snapshot.remove();
      body.classList.remove('project-fold-animating');
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
