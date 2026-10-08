/* Shared optimistic state for every chart write. No DOM or transport dependencies. */
(function(root) {
  'use strict';
  // LAN HTTP pages do not expose randomUUID in Safari. getRandomValues
  // remains available there and supplies the same random UUID v4 bytes.
  function randomUUID() {
    if (typeof root.crypto.randomUUID === 'function') return root.crypto.randomUUID();
    const bytes = root.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  }
  const copy = value => structuredClone(value);
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const shift = (value, days) => {
    if (!value) return value;
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const difference = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const ordered = rows => [...rows].sort((a,b) => (a.sort_order || 0) - (b.sort_order || 0));
  const normalize = rows => rows.forEach((row,index) => { row.sort_order = index + 1; });
  const tags = value => [...new Set((Array.isArray(value) ? value : String(value || '').split(',')).map(v => v.normalize('NFKC').trim()).filter(Boolean))];
  const groupKey = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
  function fieldsInto(target, fields) {
    for (const [key,value] of Object.entries(fields)) {
      if (['cascade_dependents','successors','sort_order'].includes(key)) continue;
      target[key] = key === 'tags' ? tags(value) : copy(value);
    }
  }
  function reorder(rows, id, fields) {
    const result = ordered(rows), index = result.findIndex(row => row.id === id);
    if (index < 0 || fields.anchor_id === id) return result;
    const [row] = result.splice(index, 1);
    const position = own(fields,'sort_order') ? fields.sort_order - 1 : fields.anchor_id ? result.findIndex(item => item.id === fields.anchor_id) + Number(!!fields.after) : result.length;
    result.splice(Math.max(0, position), 0, row); normalize(result); return result;
  }
  function summarize(data) {
    for (const project of data.projects) {
      const mean = project.tasks.length ? project.tasks.reduce((sum,task) => sum + (task.progress || 0), 0) / project.tasks.length : 0;
      // Match Python's round-to-even project aggregate.
      project.progress = mean % 1 === 0.5 ? Math.round(mean / 2) * 2 : Math.round(mean);
      let start = '', finish = '';
      for (const task of project.tasks) {
        if (task.planned_start && (!start || task.planned_start < start)) start = task.planned_start;
        if (task.planned_finish && (!finish || task.planned_finish > finish)) finish = task.planned_finish;
      }
      project.planned_start = start || project.start_date;
      project.planned_finish = finish || project.start_date;
    }
    data.projects = data.projects.filter(p=>!p.is_unassigned || p.tasks.length);
    return data;
  }
  function blankProject(id, fields = {}) {
    return {id, name:'', start_date:'', calendar_type:'working', color:'#5872d9', group_name:'', tags:[], tasks:[], progress:0, template_name:'', ...fields};
  }
  function blankTask(id, project, fields) {
    return {id, project_id:project.id, name:'', dependencies:[], owner:'', handoff:'', blocker:'', notes:'', actual_start:'', actual_finish:'', status:'todo', progress:0, group_name:'', tags:[], color:'#5872d9', sort_order:project.tasks.length + 1, ...fields};
  }
  function destination(data, id, date) {
    let project = data.projects.find(p => p.id === id);
    if (!project && id === '__unassigned__') {
      project = blankProject(id, {name:'프로젝트 없음',is_unassigned:true,start_date:date,calendar_type:'calendar',color:'#94a3b8'});
      data.projects.push(project);
    }
    return project;
  }
  // Same calendar-day descendant shift as update_schedule_dates (including joins once).
  function patchTask(project, task, fields) {
    const before = [task.planned_finish, task.actual_finish].filter(Boolean).sort().at(-1);
    fieldsInto(task, fields);
    if (own(fields,'progress') && fields.status !== 'blocked') task.status = fields.progress === 0 ? 'todo' : fields.progress === 100 ? 'done' : 'doing';
    else if (own(fields,'status') && !own(fields,'progress')) task.progress = fields.status === 'todo' ? 0 : fields.status === 'done' ? 100 : fields.status === 'doing' ? Math.max(10,Math.min(90,task.progress || 0)) : task.progress;
    if (fields.successors) for (const other of project.tasks) if (other.id !== task.id) {
      other.dependencies = (other.dependencies || []).filter(id => id !== task.id);
      if (fields.successors.includes(other.id)) other.dependencies.push(task.id);
    }
    const after = [task.planned_finish,task.actual_finish].filter(Boolean).sort().at(-1);
    const delta = before && after ? difference(before,after) : 0;
    if (fields.cascade_dependents && delta) {
      const reached = new Set([task.id]);
      for (const id of reached) for (const child of project.tasks) if ((child.dependencies || []).includes(id)) reached.add(child.id);
      for (const child of project.tasks) if (child.id !== task.id && reached.has(child.id)) {
        child.planned_start = shift(child.planned_start,delta); child.planned_finish = shift(child.planned_finish,delta);
      }
    }
  }
  function instantiate(template, project, op) {
    const calendar = project.calendar_type, holidays = new Set(op.holidays || []);
    const eligible = day => calendar === 'calendar' || (![0,6].includes(new Date(`${day}T00:00:00Z`).getUTCDay()) && !holidays.has(day));
    const roll = day => { while (!eligible(day)) day = shift(day,1); return day; };
    const advance = (day,count) => { for(let i=0;i<count;i++) day=roll(shift(day,1)); return day; };
    const start = roll(project.start_date), result = new Map(), visiting = new Set();
    const source = new Map(template.tasks.flatMap(task => [[task.id,task],[task.key,task]]));
    function visit(task) {
      if (result.has(task.key)) return result.get(task.key);
      if (visiting.has(task.key)) throw Error('Cyclic template dependencies');
      visiting.add(task.key);
      const deps = (task.dependencies || []).map(id => source.get(id)).filter(Boolean).map(visit);
      const earliest = [start,...deps.map(dep => roll(shift(dep.planned_finish,1)))].sort().at(-1);
      const planned_start = task.start_day != null ? advance(start,task.start_day - 1) : earliest;
      const duration = Math.max(1,Number(task.duration_value) || 1) * (task.duration_unit === 'weeks' ? calendar === 'working' ? 5 : 7 : 1);
      let planned_finish = advance(planned_start,duration-1);
      if (calendar === 'working' && new Date(`${planned_finish}T00:00:00Z`).getUTCDay() === 5) planned_finish = shift(planned_finish,2);
      const row = blankTask(`${op.tempId}:${task.key}`,project,{...copy(task),id:`${op.tempId}:${task.key}`,template_task_key:task.key,dependencies:deps.map(d=>d.id),planned_start,planned_finish});
      visiting.delete(task.key); result.set(task.key,row); return row;
    }
    project.tasks = template.tasks.map(visit);
  }
  function apply(data, op) {
    const {path,method,fields:f,tempId} = op;
    const parts = path.split('/').map(decodeURIComponent), kind = parts[2], id = parts[3], action = parts[4];
    const project = data.projects.find(p => p.id === (kind === 'projects' ? id : f.project_id));
    const parent = data.projects.find(p => p.tasks.some(t => t.id === id));
    const task = parent?.tasks.find(t => t.id === id);
    if (kind === 'tasks' && task) {
      if (method === 'DELETE') {
        parent.tasks = parent.tasks.filter(t => t.id !== id);
        for (const other of data.projects.flatMap(p=>p.tasks)) other.dependencies = (other.dependencies || []).filter(dep=>dep!==id);
        normalize(ordered(parent.tasks));
      } else if (action === 'order') parent.tasks = reorder(parent.tasks,id,f);
      else if (action === 'project' || action === 'placement') {
        const targetId = action === 'placement' ? (f.directory_id === 'root' ? '__unassigned__' : f.directory_id.replace(/^project:/,'')) : f.project_id || '__unassigned__';
        const target = destination(data,targetId,task.planned_start);
        if (target && target !== parent) {
          parent.tasks = parent.tasks.filter(t=>t.id!==id); normalize(ordered(parent.tasks));
          task.project_id=target.id; target.tasks.push(task);
        }
        if (target && (target !== parent || f.anchor_id)) target.tasks = reorder(target.tasks,id,f);
      } else patchTask({tasks:data.projects.flatMap(p=>p.tasks)},task,f);
    } else if (kind === 'projects' && id && action === 'tasks' && method === 'POST') {
      const target = destination(data,id,f.planned_start);
      if (target) target.tasks.push(blankTask(tempId,target,f));
    } else if (kind === 'projects' && project) {
      if(method === 'DELETE') {
        const removed=new Set(project.tasks.map(t=>t.id));
        data.projects=data.projects.filter(p=>p.id!==id);
        for(const other of data.projects.flatMap(p=>p.tasks)) other.dependencies=(other.dependencies||[]).filter(dep=>!removed.has(dep));
        normalize(ordered(data.projects.filter(p=>!p.is_unassigned)));
      }
      else if(action === 'complete') project.tasks.forEach(t=>{t.status='done';t.progress=100;});
      else if(action === 'order') {
        const rows = reorder(data.projects.filter(p=>!p.is_unassigned),id,f); data.projects=[...rows,...data.projects.filter(p=>p.is_unassigned)];
      } else {
        fieldsInto(project,f);
        if(own(f,'sort_order')) normalize(reorder(data.projects.filter(p=>!p.is_unassigned),id,f));
      }
    } else if ((kind === 'projects' || kind === 'instantiate') && method === 'POST') {
      const template = data.templates.find(t=>t.id===f.template_id);
      const created = blankProject(tempId,{...f,sort_order:data.projects.length+1,group_name:template?.group_name || '',tags:copy(template?.tags || [])});
      if(kind === 'instantiate' && template) {created.template_name=template.name; instantiate(template,created,op);}
      data.projects.push(created);
    } else if (kind === 'templates') {
      if(method === 'DELETE') data.templates=data.templates.filter(t=>t.id!==id);
      else {
        const template={...copy(f),id:id || tempId};
        const index=data.templates.findIndex(t=>t.id===template.id);
        if(index<0)data.templates.push(template);else data.templates[index]=template;
      }
    } else if (kind === 'duplicate') {
      const sourceProject=data.projects.find(p=>p.id===f.source_id);
      if(f.kind === 'project' && sourceProject) {
        const created=copy(sourceProject);created.id=tempId;
        const ids=new Map(created.tasks.map(t=>[t.id,`${tempId}:${t.id}`]));
        created.tasks.forEach(t=>{t.id=ids.get(t.id);t.project_id=tempId;t.dependencies=(t.dependencies||[]).map(id=>ids.get(id)).filter(Boolean);});
        data.projects.push(created);
      } else {
        const source=data.projects.flatMap(p=>p.tasks).find(t=>t.id===f.source_id);
        const target=data.projects.find(p=>p.id===(f.project_id || source?.project_id));
        if(source && target) {
          const row={...copy(source),id:tempId,project_id:target.id,dependencies:source.project_id===target.id?copy(source.dependencies):[]};
          target.tasks.push(row); target.tasks=reorder(target.tasks,tempId,{anchor_id:f.anchor_id,after:true});
        }
      }
    } else if(kind === 'settings' && id === 'tag-color') data.tag_colors={...data.tag_colors,[groupKey(f.tag)]:f.color};
    else if(kind === 'settings' && id === 'holiday-calendar') data.holiday_country=f.holiday_country;
    return summarize(data);
  }
  function create({initial,send,publish,context=()=>({})}) {
    let base=copy(initial), pending=[], tail=Promise.resolve(), revision=0;
    const aliases=new Map(), failedIds=new Set(), undoTokens=[];
    const resolveId=id=>aliases.get(id)||id;
    const resolveValue=value=>Array.isArray(value)?value.map(resolveValue):value && typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolveValue(v)])):typeof value==='string'?(value.startsWith('project:')?'project:'+resolveId(value.slice(8)):resolveId(value)):value;
    const resolved=op=>({...op,path:op.path.split('/').map(part=>encodeURIComponent(resolveId(decodeURIComponent(part)))).join('/'),fields:resolveValue(op.fields)});
    const projectView=()=>pending.reduce((data,op)=>apply(data,resolved(op)),copy(base));
    const emit=(event={})=>{const data=projectView();publish(data,event);return data;};
    function commit(op,result) {
      const predicted=apply(copy(base),resolved(op));
      const entity=result?.project || result;
      if(entity?.id && Array.isArray(entity.tasks)) {
        const templates=op.path.startsWith('/api/templates');
        const rows=templates?predicted.templates:predicted.projects;
        let index=rows.findIndex(row=>row.id===entity.id);
        if(index<0)index=rows.findIndex(row=>row.id===op.tempId);
        if(index>=0) {
          const prior=rows[index];
          if(prior.id===op.tempId) {
            aliases.set(op.tempId,entity.id);
            prior.tasks.forEach((task,i)=>{if(task.id?.startsWith(op.tempId+':') && entity.tasks[i])aliases.set(task.id,entity.tasks[i].id);});
          }
          // New task endpoint returns its parent; map its provisional task as well.
          const provisional=prior.tasks.find(t=>t.id===op.tempId);
          if(provisional) {
            const added=entity.tasks.find(t=>!prior.tasks.some(p=>p.id===t.id));
            if(added)aliases.set(op.tempId,added.id);
          }
          rows[index]=copy(entity);
        } else rows.push(copy(entity));
      }
      for(const affected of result?.affected_projects || []) {
        const index=predicted.projects.findIndex(p=>p.id===affected.id);
        if(index>=0)predicted.projects[index]=copy(affected);
      }
      if(result?.key && own(result,'color')) predicted.tag_colors={...predicted.tag_colors,[result.key]:result.color};
      base=predicted;
    }
    function mutate(path,options={}) {
      const op={path,method:(options.method || 'POST').toUpperCase(),fields:JSON.parse(options.body || '{}'),tempId:`pending:${randomUUID()}`,...context()};
      pending.push(op);revision++;
      try { emit({phase:'optimistic',operation:op}); } catch(error) { pending=pending.filter(item=>item!==op);emit();return Promise.reject(error); }
      const request=tail.catch(()=>{}).then(async()=>{
        try {
          const current=resolved(op);
          if([...failedIds].some(id=>current.path.includes(encodeURIComponent(id)) || JSON.stringify(current.fields).includes(id))) throw Error('The item could not be created. Please retry.');
          const result=await send(current.path,{...options,body:options.body == null?undefined:JSON.stringify(current.fields)});
          if(result?._undo_token) { undoTokens.push(result._undo_token); if(undoTokens.length>100)undoTokens.shift(); }
          commit(op,result);pending=pending.filter(item=>item!==op);revision++;emit({phase:'confirmed',operation:op,result});return result;
        } catch(error) {
          pending=pending.filter(item=>item!==op);failedIds.add(op.tempId);revision++;emit({phase:'rejected',operation:op});throw error;
        }
      });
      tail=request.catch(()=>{});return request;
    }
    async function refresh() {
      for(;;) {
        await tail;
        const version=revision;
        const fresh=await send('/api/state');
        if(version!==revision || pending.length)continue;
        base=copy(fresh);revision++;return emit();
      }
    }
    function undo() {
      const request=tail.catch(()=>{}).then(async()=>{
        const token=undoTokens.at(-1);
        if(!token)return false;
        await send('/api/undo',{method:'POST',body:JSON.stringify({token})});
        undoTokens.pop();
        base=copy(await send('/api/state'));revision++;emit({phase:'undone'});
        return true;
      });
      tail=request.catch(()=>{});return request;
    }
    return {mutate,refresh,undo,resolveId,whenIdle:()=>tail,get pendingCount(){return pending.length;}};
  }
  const api={create,apply,randomUUID};
  if(typeof module!=='undefined' && module.exports)module.exports=api;
  else root.ChartMutations=api;
})(globalThis);
