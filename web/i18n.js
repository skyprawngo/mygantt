/* Fixed UI text only. Never pass user content through the translation catalog. */
(function (root) {
  function createI18n(rows, storage) {
    const table = new Map(rows.map(row => [row.textID, Object.freeze({...row})]));
    let language = 'KR';
    try { if (['KR','US','JP'].includes(storage?.getItem('mygantt-language'))) language = storage.getItem('mygantt-language'); } catch {}
    function t(textID, params = {}) {
      const row = table.get(textID);
      if (!row) throw new Error(`Unknown textID: ${textID}`);
      return (row[language] || row.KR).replace(/\{(\w+)\}/g, (match, key) => Object.hasOwn(params,key) ? String(params[key] ?? '') : match);
    }
    function setLanguage(value) {
      if (!['KR','US','JP'].includes(value)) return false;
      language=value;
      try { storage?.setItem('mygantt-language',value); } catch {}
      return true;
    }
    function apply(scope) {
      for (const node of scope.querySelectorAll('[data-i18n]')) node.textContent=t(node.dataset.i18n);
      for (const node of scope.querySelectorAll('[data-i18n-attrs]')) {
        for (const binding of node.dataset.i18nAttrs.split(';')) {
          const [attribute, textID]=binding.split(':'); node.setAttribute(attribute,t(textID));
        }
      }
      for (const template of scope.querySelectorAll('template')) apply(template.content);
      if (scope.documentElement) {
        scope.documentElement.lang=({KR:'ko-KR',US:'en-US',JP:'ja-JP'})[language];
        scope.querySelector('link[rel=manifest]')?.setAttribute('href','/manifest.webmanifest?language='+language);
      }
    }
    // Compatibility boundary for server-owned messages only, never DOM content.
    const patterns=rows.map(row=>{
      const keys=[];
      const pattern=row.KR.split(/(\{\w+\})/).map(part=>{
        if (/^\{\w+\}$/.test(part)) {keys.push(part.slice(1,-1));return '([\\s\\S]*?)';}
        return part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      }).join('');
      return {textID:row.textID,keys,re:new RegExp('^'+pattern+'$')};
    });
    function serverError(data) {
      if (table.has(data?.textID)) return t(data.textID,data.params);
      for(const item of patterns){const match=item.re.exec(data?.error||'');if(match)return t(item.textID,Object.fromEntries(item.keys.map((key,i)=>[key,match[i+1]])));}
      return t('error.unknown');
    }
    function systemText(value, prefix) {
      const row=rows.find(row=>row.textID.startsWith(prefix)&&row.KR===value);
      return row?t(row.textID):value;
    }
    return {t,setLanguage,apply,serverError,systemText,get language(){return language;},get locale(){return ({KR:'ko-KR',US:'en-US',JP:'ja-JP'})[language];}};
  }
  if (typeof module === 'object' && module.exports) module.exports = {createI18n};
  else {
    root.I18n = {ready:fetch('/translations.json').then(response=>{
      if(!response.ok) throw new Error('Translation catalog unavailable');
      return response.json();
    }).then(rows=>{Object.defineProperties(root.I18n,Object.getOwnPropertyDescriptors(createI18n(rows,root.localStorage)));return root.I18n;})};
  }
})(globalThis);
