/* Independent project and grouped-row order for each compact view. */
(function(root){
  const modes=['owner','group','tags'];
  const clean=value=>String(value || '').normalize('NFKC').trim();
  function key(task,mode){
    const tags=[...new Set((task.tags || []).map(clean).filter(Boolean))].sort();
    const label=mode==='tags'?tags.join(', '):clean(mode==='owner'?task.owner:task.group_name);
    return JSON.stringify(label?['compact',mode==='tags'?tags:label]:['row',task.gantt_row_id || task.id]);
  }
  function sort(items,order=[],id=item=>item.id){
    const ranks=new Map(order.map((key,i)=>[key,i]));
    return [...items].sort((a,b)=>(ranks.get(id(a))??Infinity)-(ranks.get(id(b))??Infinity));
  }
  function move(saved,available,source,anchor,after){
    const keys=[...new Set(available)],valid=new Set(keys);
    if(!valid.has(source)||!valid.has(anchor)||source===anchor)throw Error('Invalid compact row');
    const order=[...new Set([...saved.filter(id=>valid.has(id)),...keys])].filter(id=>id!==source);
    order.splice(order.indexOf(anchor)+(after?1:0),0,source);return order;
  }
  function apply(data,f){
    if(!modes.includes(f.mode))throw Error('Invalid compact mode');
    const all=data.compact_orders || {},view=all[f.mode] || {projects:[],tasks:{}};
    const projects=data.projects.filter(p=>!p.is_unassigned).sort((a,b)=>(a.sort_order||0)-(b.sort_order||0));
    let next;
    if(f.project_id===null)next={...view,projects:move(view.projects || [],projects.map(p=>p.id),f.row_id,f.anchor_id,f.after)};
    else {
      const project=data.projects.find(p=>p.id===f.project_id);if(!project)throw Error('Missing project');
      const available=[...project.tasks].sort((a,b)=>(a.sort_order||0)-(b.sort_order||0)).map(t=>key(t,f.mode));
      next={...view,tasks:{...view.tasks,[f.project_id]:move(view.tasks?.[f.project_id] || [],available,f.row_id,f.anchor_id,f.after)}};
    }
    data.compact_orders={...all,[f.mode]:next};return data;
  }
  const api={key,sort,move,apply};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CompactOrder=api;
})(globalThis);
