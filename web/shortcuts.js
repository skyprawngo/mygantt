/* Application keyboard contracts, persisted independently of chart/UI state. */
(function(root) {
  const definitions = [
    ['today','navigation','오늘 날짜로 이동',['Mod+h'],['global']],
    ['undo','editing','일정 실행 취소',['Mod+z'],['global']],
    ['rename','editing','선택한 행 이름 변경',null,['chart']],
    ['copy','editing','선택한 행 복사',['Mod+c'],['chart']],
    ['paste','editing','복사한 행 붙여넣기',['Mod+v'],['chart']],
    ['previous','navigation','이전 월 범위',['ArrowLeft'],['month']],
    ['next','navigation','다음 월 범위',['ArrowRight'],['month']],
    ['confirm','input','입력 확정',['Enter'],['field','inline','group']],
    ['close','input','접기 · 닫기 / 행 이름 확정',['Escape'],['dialog','note','menu','search','inline','drawer']],
    ['clearDate','input','날짜 전체 지우기',['Escape','Backspace','Delete'],['date']],
    ['tagAdd','input','태그 확정',['Enter',','],['tag']],
    ['tagRemove','input','빈 입력에서 마지막 태그 삭제',['Backspace'],['tag']],
    ['increase','progress','진행률 10% 증가',['ArrowRight','ArrowUp'],['progress']],
    ['decrease','progress','진행률 10% 감소',['ArrowLeft','ArrowDown'],['progress']],
    ['minimum','progress','진행률 0%',['Home'],['progress']],
    ['maximum','progress','진행률 100%',['End'],['progress']],
    ['stop','progress','중지 상태 전환',['Enter','Space'],['progress']],
    ['help','progress','상태 도움말',['F1'],['progress']],
    ['activate','navigation','연결선의 작업 선택',['Enter','Space'],['connection']],
    ['menuDown','navigation','메뉴 다음 항목',['ArrowDown'],['menu','group']],
    ['menuUp','navigation','메뉴 이전 항목',['ArrowUp'],['menu','group']],
    ['revealDelete','editing','사이드바 행 삭제 버튼 표시',['ArrowLeft'],['sidebarRow']],
    ['hideDelete','editing','사이드바 행 삭제 버튼 숨기기',['ArrowRight'],['sidebarRow']],
  ].map(([id,category,label,keys,scopes])=>({id,category,label,keys,scopes}));
  function create({storage,device={}}={}) {
    const mac = /mac/i.test(device.userAgentData?.platform || device.platform || device.userAgent || '');
    const defaults = Object.fromEntries(definitions.map(d=>[d.id,d.keys || [mac?'Enter':'F2']]));
    let overrides={};
    function normalize(value) {
      if(typeof value!=='string')return null;
      const parts=value.split('+');const key=parts.pop();
      if(!key || ['Control','Meta','Alt','Shift','Tab','Dead','Unidentified'].includes(key))return null;
      if(parts.some(p=>!['Mod','Alt','Shift','Ctrl','Meta'].includes(p)) || new Set(parts).size!==parts.length)return null;
      return ['Mod','Ctrl','Meta','Alt','Shift'].filter(p=>parts.includes(p)).concat(key.length===1?key.toLowerCase():key).join('+');
    }
    function chord(event) {
      if(event.isComposing || event.keyCode===229 || !event.key)return null;
      const modifiers=[];
      if(mac?event.metaKey:event.ctrlKey)modifiers.push('Mod');
      if(mac?event.ctrlKey:event.metaKey)modifiers.push(mac?'Ctrl':'Meta');
      if(event.altKey)modifiers.push('Alt');if(event.shiftKey)modifiers.push('Shift');
      return normalize([...modifiers,event.key===' '?'Space':event.key==='+'?'Plus':event.key].join('+'));
    }
    const keys = id => overrides[id] || defaults[id] || [];
    const matches = (event,id) => {const key=chord(event);return key!==null && keys(id).includes(key);};
    function conflicts(id,bindings) {
      const action=definitions.find(d=>d.id===id);
      if(!action)throw Error('Unknown shortcut');
      return definitions.filter(d=>d.id!==id && (d.scopes.includes('global') || action.scopes.includes('global') || d.scopes.some(s=>action.scopes.includes(s))) && keys(d.id).some(k=>bindings.includes(k)));
    }
    function set(id,bindings) {
      if(!Array.isArray(bindings))throw Error('Invalid shortcut');
      const next=bindings.map(normalize);
      if(next.some(k=>!k)||new Set(next).size!==next.length)throw Error('Invalid shortcut');
      const collisions=conflicts(id,next);
      if(collisions.length){const error=Error('Shortcut conflict');error.conflicts=collisions;throw error;}
      const updated={...overrides,[id]:next};
      storage?.setItem('mygantt-shortcuts',JSON.stringify(updated));overrides=updated;
    }
    function reset(){storage?.removeItem('mygantt-shortcuts');overrides={};}
    try {
      const saved=JSON.parse(storage?.getItem('mygantt-shortcuts') || '{}');
      for(const d of definitions) if(Array.isArray(saved[d.id]) && saved[d.id].every(k=>normalize(k)===k)) overrides[d.id]=saved[d.id];
    } catch {}
    function label(value){return value.split('+').map(k=>({Mod:mac?'⌘':'Ctrl',Ctrl:'Ctrl',Meta:'⌘',Alt:mac?'⌥':'Alt',Shift:mac?'⇧':'Shift',Space:'Space',Plus:'+',ArrowLeft:'←',ArrowRight:'→',ArrowUp:'↑',ArrowDown:'↓'}[k] || (k.length===1?k.toUpperCase():k))).join(mac?'':' + ');}
    return {definitions,keys,matches,chord,set,reset,conflicts,label,mac};
  }
  if(typeof module!=='undefined' && module.exports)module.exports={create,definitions};
  else {let storage;try{storage=root.localStorage;}catch{}root.Shortcuts=create({storage,device:root.navigator});}
})(globalThis);
