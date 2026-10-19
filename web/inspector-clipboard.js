/* Inspector clipboard shortcuts; native text paste retains browser undo. */
(function(root) {
  const selector='#mobile-inspector, #template-inspector';
  const isHex=input=>input.hasAttribute?.('data-color-hex');
  const normalizeHex=text=>/^#?[0-9a-f]{6}$/i.test(text) ? '#'+text.replace(/^#/,'').toLowerCase() : null;
  function field(target) {
    if (!target?.closest?.(selector) || !target.matches('input,textarea') || target.disabled) return null;
    if (target.tagName==='INPUT' && !['text','search','url','tel','email','password','number','date','color','time','datetime-local','month','week'].includes(target.type)) return null;
    return target;
  }
  function copyText(input) {
    const {value,selectionStart:start,selectionEnd:end}=input;
    return typeof start==='number' && end>start ? value.slice(start,end) : value;
  }
  function pasteText(input,text,document) {
    if (input.readOnly) return false;
    if(isHex(input)) {
      const color=normalizeHex(text);
      if(!color) return false;
      input.value=color;
      input.dispatchEvent(new root.Event('input',{bubbles:true}));
      return true;
    }
    if (typeof input.selectionStart==='number') {
      // insertText participates in the browser's native undo history.
      if (document.execCommand?.('insertText',false,text)) return true;
      input.setRangeText(text,input.selectionStart,input.selectionEnd,'end');
    } else {
      if(input.type==='color' && !/^#[0-9a-f]{6}$/i.test(text.trim())) return false;
      const candidate=input.cloneNode();candidate.value=text.trim();
      if (!candidate.value || !candidate.checkValidity()) return false;
      input.value=candidate.value;
    }
    input.dispatchEvent(new root.Event('input',{bubbles:true}));
    input.dispatchEvent(new root.Event('change',{bubbles:true}));
    return true;
  }
  function bind(document,shortcuts,clipboard,report) {
    document.addEventListener('input',event=>{
      const input=event.target;
      if(isHex(input)) {
        const value=normalizeHex(input.value);
        input.setAttribute('aria-invalid',String(!value));
        if(!value)return;
        const color=input.closest('.color-field').querySelector('input[type="color"]');
        if(color.value===value)return;
        color.value=value;
        color.dispatchEvent(new root.Event('input',{bubbles:true}));
        color.dispatchEvent(new root.Event('change',{bubbles:true}));
      } else if(input.type==='color') {
        const hex=input.closest('.color-field')?.querySelector('[data-color-hex]');
        if(hex && document.activeElement!==hex){hex.value=input.value;hex.removeAttribute('aria-invalid');}
      }
    },true);
    document.addEventListener('focusout',event=>{
      const input=event.target;
      if(!isHex(input))return;
      input.value=input.closest('.color-field').querySelector('input[type="color"]').value;
      input.removeAttribute('aria-invalid');
    });
    document.addEventListener('copy',event=>{
      const input=field(event.target);
      if (!input || event.defaultPrevented || !event.clipboardData) return;
      event.clipboardData.setData('text/plain',copyText(input));event.preventDefault();
    },true);
    document.addEventListener('paste',event=>{
      const input=field(event.target);
      if (!input || input.readOnly || event.defaultPrevented || !event.clipboardData) return;
      if (typeof input.selectionStart==='number' && !isHex(input)) return;
      event.preventDefault();pasteText(input,event.clipboardData.getData('text/plain'),document);
    },true);
    document.addEventListener('keydown',async event=>{
      const input=field(event.target);
      if (!input || event.defaultPrevented || event.isComposing || event.keyCode===229) return;
      const copy=shortcuts.matches(event,'inspectorCopy'),paste=shortcuts.matches(event,'inspectorPaste');
      const chord=shortcuts.chord(event);
      if (!copy && !paste) {
        if (['Mod+c','Mod+v'].includes(chord)) event.preventDefault();
        return;
      }
      if (paste && input.readOnly) return;
      const native=(copy && chord==='Mod+c') || (paste && chord==='Mod+v');
      if (native && typeof input.selectionStart==='number') return;
      event.preventDefault();
      if(event.repeat)return;
      // Do not apply an asynchronous clipboard result to a different selection.
      const value=input.value,start=input.selectionStart,end=input.selectionEnd;
      try {
        if(copy) await clipboard.writeText(copyText(input));
        else {
          const text=await clipboard.readText();
          if(document.activeElement===input && input.isConnected && input.value===value && input.selectionStart===start && input.selectionEnd===end) pasteText(input,text,document);
        }
      } catch(error) { report(error); }
    },true);
  }
  if(typeof module!=='undefined' && module.exports) module.exports={field,copyText,pasteText,bind,normalizeHex};
  else bind(root.document,root.Shortcuts,root.navigator.clipboard,()=>{
    let status=root.document.getElementById('inspector-clipboard-status');
    if(!status){status=root.document.createElement('p');status.id='inspector-clipboard-status';status.setAttribute('role','alert');root.document.activeElement?.closest(selector)?.append(status);}
    status.textContent=root.I18n.t('clipboard.inspector_error');
  });
})(globalThis);
