I18n.ready.then(()=>{
  const t=(id,params)=>I18n.t(`shortcuts.${id}`,params);
  let recording=null,returnFocus=null;
  const dialog=document.createElement('dialog');dialog.className='shortcuts-dialog';
  dialog.setAttribute('aria-labelledby','shortcut-dialog-title');document.body.append(dialog);
  const actionName=id=>t(`action.${id}`);
  function render() {
    dialog.replaceChildren();
    const header=document.createElement('header'),title=document.createElement('h2'),close=document.createElement('button');
    title.id='shortcut-dialog-title';title.textContent=t('title');close.type='button';close.className='icon-button';close.textContent='×';close.setAttribute('aria-label',t('close'));
    close.onclick=()=>dialog.close();header.append(title,close);dialog.append(header);
    const help=document.createElement('p');help.textContent=t('description');dialog.append(help);
    const warning=document.createElement('p');warning.className='shortcuts-hint';warning.textContent=t('system_note');dialog.append(warning);
    const status=document.createElement('p');status.id='shortcut-status';status.setAttribute('role','status');dialog.append(status);
    for(const category of ['navigation','editing','input','progress']) {
      const section=document.createElement('section'),heading=document.createElement('h3');heading.textContent=t(`category.${category}`);section.append(heading);
      for(const action of Shortcuts.definitions.filter(d=>d.category===category)) {
        const row=document.createElement('div');row.className='shortcut-row';row.dataset.shortcut=action.id;
        const label=document.createElement('span');label.textContent=actionName(action.id);row.append(label);
        const controls=document.createElement('div');controls.className='shortcut-keys';
        Shortcuts.keys(action.id).forEach((key,index)=>{
          const group=document.createElement('span');group.className='shortcut-key';
          const change=document.createElement('button');change.type='button';change.textContent=Shortcuts.label(key);change.setAttribute('aria-label',`${actionName(action.id)}: ${Shortcuts.label(key)}`);
          change.onclick=()=>start(action.id,index,change);
          const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.setAttribute('aria-label',`${actionName(action.id)} ${Shortcuts.label(key)} ${t('remove')}`);
          remove.onclick=()=>save(action.id,Shortcuts.keys(action.id).filter((_,i)=>i!==index));
          group.append(change,remove);controls.append(group);
        });
        const add=document.createElement('button');add.type='button';add.className='button button-small';add.textContent=t('add');add.setAttribute('aria-label',`${actionName(action.id)} ${t('add')}`);add.onclick=()=>start(action.id,Shortcuts.keys(action.id).length,add);controls.append(add);
        if(!Shortcuts.keys(action.id).length){const off=document.createElement('small');off.textContent=t('disabled');controls.append(off);}
        row.append(controls);section.append(row);
      }
      dialog.append(section);
    }
    const footer=document.createElement('footer'),reset=document.createElement('button'),cancel=document.createElement('button');
    reset.type=cancel.type='button';reset.className=cancel.className='button';reset.textContent=t('reset');cancel.textContent=t('cancel_recording');cancel.hidden=true;cancel.id='shortcut-cancel-recording';
    cancel.onclick=()=>{const id=recording?.id;recording=null;render();focusAction(id);};reset.onclick=()=>{try{Shortcuts.reset();recording=null;render();dialog.querySelector('footer button').focus({preventScroll:true});statusMessage(t('saved'));}catch{statusMessage(t('save_error'));}};
    status.after(cancel);footer.append(reset);dialog.append(footer);
  }
  function focusAction(id){dialog.querySelector(`[data-shortcut="${id}"] button`)?.focus({preventScroll:true});}
  function statusMessage(text){dialog.querySelector('#shortcut-status').textContent=text;}
  function start(id,index,button){recording={id,index};statusMessage(t('press_key',{p0:actionName(id)}));dialog.querySelector('#shortcut-cancel-recording').hidden=false;button.focus();}
  function save(id,keys){
    try{Shortcuts.set(id,keys);recording=null;render();focusAction(id);statusMessage(t('saved'));}
    catch(error){statusMessage(error.conflicts?t('conflict',{p0:error.conflicts.map(d=>actionName(d.id)).join(', ')}):t('save_error'));}
  }
  // Capture before application and modal handlers; recording never executes an action.
  window.addEventListener('keydown',event=>{
    if(!dialog.open)return;
    if(recording){
      event.preventDefault();event.stopImmediatePropagation();
      if(event.repeat)return;
      const key=Shortcuts.chord(event);if(!key)return;
      const keys=[...Shortcuts.keys(recording.id)];keys[recording.index]=key;save(recording.id,keys);return;
    }
    if(Shortcuts.matches(event,'close')){event.preventDefault();event.stopImmediatePropagation();dialog.close();}
  },true);
  dialog.addEventListener('cancel',event=>event.preventDefault());
  dialog.addEventListener('close',()=>{recording=null;returnFocus?.focus();});
  dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();});
  document.querySelector('#show-shortcuts').addEventListener('click',()=>{returnFocus=document.activeElement;recording=null;render();dialog.showModal();dialog.querySelector('header button').focus();});
});
