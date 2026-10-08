/* UI editing policy. Persistence belongs to ChartMutations, DOM layout to app.js. */
(function(root) {
  'use strict';
  const read = input => input.type === 'checkbox' ? input.checked : input.value;
  const write = (input, value) => {
    if (input.type === 'checkbox') input.checked = Boolean(value);
    else input.value = Array.isArray(value) ? value.join(', ') : String(value ?? '');
  };

  function createFields({inputs, valueFor, focused=()=>false, changed=()=>{}, errorText=error=>error.message}) {
    const saved = new Map(inputs.map(input=>[input,read(input)]));
    const queued = new Map(), errors = new Map();
    let pending = 0;
    function clearError(input) { errors.delete(input); input.removeAttribute('aria-invalid'); }
    function invalid(input,message) { errors.set(input,message);input.setAttribute('aria-invalid','true');changed(); }
    function sync() {
      for (const input of inputs) {
        const value = valueFor(input);
        if (value === undefined || queued.has(input) || errors.has(input)) continue;
        const next = input.type === 'checkbox' ? Boolean(value) : Array.isArray(value) ? value.join(', ') : String(value ?? '');
        // Another editor may have submitted this exact draft (for example row rename).
        if (read(input) === next) {saved.set(input,next);continue;}
        if (focused(input) || read(input) !== saved.get(input)) continue;
        write(input,value); saved.set(input,read(input));
      }
      changed();
    }
    async function save(affected, send) {
      const ticket = {};
      const snapshot = affected.map(input=>[input,read(input)]);
      for (const [input,value] of snapshot) { queued.set(input,{ticket,value});clearError(input); }
      pending++;changed();
      let succeeded = false;
      try {
        const result = await send();
        succeeded = true;
        for (const [input,value] of snapshot) saved.set(input,value);
        return result;
      } catch (error) {
        for (const [input,value] of snapshot) {
          if (queued.get(input)?.ticket === ticket) invalid(input,errorText(error));
        }
        throw error;
      } finally {
        for (const [input] of snapshot) if (queued.get(input)?.ticket === ticket) queued.delete(input);
        pending--;
        if (succeeded) sync();
        changed();
      }
    }
    return {save,sync,invalid,errors,
      edit(input) {clearError(input);changed();},
      needsSave(input) {return errors.has(input) || read(input) !== (queued.has(input) ? queued.get(input).value : saved.get(input));},
      get dirty() {return inputs.some(input=>read(input)!==saved.get(input));},
      get pending() {return pending;},
    };
  }

  // Only identical actions share a request. Editing and navigation remain enabled.
  function createActions() {
    const active = new Map();
    return {run(key, send) {
      if (active.has(key)) return active.get(key);
      const request = (async()=>send())();
      active.set(key,request);
      const clear = () => {if(active.get(key)===request)active.delete(key);};
      request.then(clear,clear);
      return request;
    }};
  }

  // Failed drafts outlive a detached editor; an old response cannot clear a newer draft.
  function createDrafts() {
    const drafts = new Map();
    return {
      get:key=>drafts.get(key),
      set(key,value) {const draft={value};drafts.set(key,draft);return draft;},
      settle(key,draft,error) {
        if(drafts.get(key)!==draft)return;
        if(error)draft.error=error;else drafts.delete(key);
      },
    };
  }

  function createRenderer({frame,blocked=()=>false,render}) {
    let scheduled = false, dirty = false;
    function flush() {
      scheduled=false;
      if (!dirty) return;
      if (blocked()) { schedule();return; }
      dirty=false;render();
    }
    function schedule() {if(!scheduled){scheduled=true;frame(flush);}}
    return {request(){dirty=true;schedule();}};
  }
  const api={createFields,createActions,createDrafts,createRenderer};
  if(typeof module!=='undefined' && module.exports)module.exports=api;
  else root.ChartEditing=api;
})(globalThis);
