const {test}=require('node:test'), assert=require('node:assert/strict'),fs=require('node:fs');
const {createI18n}=require('../web/i18n.js');
const rows=require('../web/translations.json');
test('catalog IDs are unique, all languages complete, and placeholders agree',()=>{
 assert.equal(new Set(rows.map(r=>r.textID)).size,rows.length);
 for(const row of rows){assert.deepEqual(Object.keys(row).sort(),['JP','KR','US','textID']);assert(row.KR&&row.US&&row.JP,row.textID); for (const lang of ['US','JP'])assert.deepEqual([...row.KR.matchAll(/\{\w+\}/g)].map(m=>m[0]).sort(),[...row[lang].matchAll(/\{\w+\}/g)].map(m=>m[0]).sort(),row.textID);}
});
test('all source textIDs resolve; app logic has no hardcoded Korean UI strings',()=>{
 const ids=new Set(rows.map(r=>r.textID)),js=fs.readFileSync('web/app.js','utf8'),html=fs.readFileSync('web/index.html','utf8');
 for(const m of js.matchAll(/t\("([^"]+)"/g))assert(ids.has(m[1]),m[1]);
 for(const m of html.matchAll(/data-i18n="([^"]+)"/g))assert(ids.has(m[1]),m[1]);
 for(const m of html.matchAll(/data-i18n-attrs="([^"]+)"/g))for(const binding of m[1].split(';'))assert(ids.has(binding.split(':')[1]),binding);
 assert.doesNotMatch(js,/[가-힣]/);
});
test('language persists, invalid values fall back safely, and text params remain untouched',()=>{
 let saved='invalid';const storage={getItem:()=>saved,setItem:(_,v)=>saved=v};const i=createI18n(rows,storage);
 assert.equal(i.language,'KR');assert.equal(i.setLanguage('US'),true);assert.equal(saved,'US');
 assert.equal(createI18n(rows,storage).language,'US');assert.equal(i.setLanguage('invalid'),false);
 const row=rows.find(r=>r.KR==='{p0}(으)로 작업을 이동했습니다.');
 assert.equal(i.t(row.textID,{p0:'사용자 <프로젝트> {p1}'}),'Task moved to 사용자 <프로젝트> {p1}.');
 assert.equal(i.systemText('내 작업명','holiday.'),'내 작업명');
});
test('API errors use keys and preserve dynamic values with legacy compatibility',()=>{
 const i=createI18n(rows);i.setLanguage('US');const row=rows.find(r=>r.KR==='알 수 없는 선행 작업: {p0}');
 assert.equal(i.serverError({textID:row.textID,params:{p0:'고객 작업'}}),'Unknown predecessor: 고객 작업');
 assert.equal(i.serverError({error:'알 수 없는 선행 작업: 고객 작업'}),'Unknown predecessor: 고객 작업');
 assert.equal(i.serverError({error:'unrecognized'}),i.t('error.unknown'));
});
test('weekday Sunday is distinct from duration days',()=>{
 const i=createI18n(rows);i.setLanguage('US');assert.equal(i.t('weekday.sun'),'Sun');
 assert.equal(i.t(rows.find(r=>r.US==='days').textID),'days');
});

test('Japanese language persists and translates UI and API messages',()=>{
 let saved='JP'; const storage={getItem:()=>saved,setItem:(_,v)=>saved=v}; const i=createI18n(rows,storage);
 assert.equal(i.language,'JP'); assert.equal(i.locale,'ja-JP'); assert.equal(i.t('settings.language'),'言語');
 assert.equal(i.setLanguage('US'),true); assert.equal(i.setLanguage('JP'),true); assert.equal(saved,'JP');
 assert.equal(i.serverError({error:'アルファ'}),i.t('error.unknown'));
 assert.equal(i.systemText('顧客の作業','holiday.'),'顧客の作業');
});
