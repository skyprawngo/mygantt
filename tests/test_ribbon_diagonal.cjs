const withI18n = require('./i18n_context.cjs');
const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync('web/app.js','utf8'),c={};withI18n(vm.createContext(c));
vm.runInContext(source.slice(source.indexOf('function dependencyRibbon('),source.indexOf('function dependencySourceKind(')),c);
for(const kind of ['gap','surface']) for(const dy of [-180,40,180]) test(`${kind} ${dy}: smooth endpoint-driven contour without a straight waist`,()=>{
 const from={kind,x:100,surfaceX:100,y:200,centerY:200,height:22,width:70};
 const to={x:300,surfaceX:160,y:200+dy,centerY:200+dy,height:20,width:50};
 const path=c.dependencyRibbon(from,to);
 assert.equal((path.match(/ L /g)||[]).length,1,'only target attachment edge is straight');
 const curves=[...path.matchAll(/C\s*([^CLMZ]+)/g)].map(m=>m[1].trim().split(/[ ,]+/).map(Number));
 assert.equal(curves.length,32);
 for(const start of [0,16]) for(let i=start+1;i<start+16;i++) {
  const a=curves[i-1],b=curves[i];
  for(const axis of [0,1]) assert.ok(Math.abs((a[4+axis]-a[2+axis])-(b[axis]-a[4+axis]))<1e-8,'continuous tangent');
 }
 // Both sides narrow smoothly, never cross, and retain forward date/row travel.
 const upper=curves.slice(0,16).map(a=>a.slice(4));
 const lower=curves.slice(16).map(a=>a.slice(4)).reverse();
 const axis=kind==='gap'?1:0;
 for(let i=0;i<15;i++) assert.ok(lower[i+1][axis]>upper[i][axis]);
 assert.doesNotMatch(path,/NaN|Infinity/);
});

for(const dx of [-200,0,200]) for(const dy of [-40,40]) test(`surface flares face inward without reversed endpoint tangents: ${dx},${dy}`,()=>{
 const path=c.dependencyRibbon({kind:'surface',surfaceX:300,y:200,width:30},{surfaceX:300+dx,y:200+dy,width:30});
 const curves=[...path.matchAll(/C\s*([^CLMZ]+)/g)].map(m=>m[1].trim().split(/[ ,]+/).map(Number));
 assert(curves[0][0]>285,'left source boundary narrows toward the ribbon');
 assert.equal(curves[0][1],200);
 assert(curves[15][2]>300+dx-15,'left target boundary expands toward the bar');
 assert.equal(curves[15][3],200+dy);
 assert(curves[16][0]<300+dx+15,'right target boundary narrows away from the bar');
 assert(curves[31][2]<315,'right source boundary expands toward the bar');
});

for(const kind of ['gap','surface']) test(`${kind}: only visually thin waists gain thickness`,()=>{
 function width(dx,dy){
  const path=c.dependencyRibbon({kind,x:0,surfaceX:0,y:0,centerY:0,height:22,width:30},{x:dx,surfaceX:dx,y:dy,centerY:dy,height:22,width:30});
  const curves=[...path.matchAll(/C\s*([^CLMZ]+)/g)].map(m=>m[1].trim().split(/[ ,]+/).map(Number));
  const axis=kind==='gap'?5:4;
  return curves[23][axis]-curves[7][axis];
 }
 const w=kind==='gap'?.109375:.03125, half=kind==='gap'?11:15;
 const original=2*(2+(half-2)*2*w);
 assert.ok(Math.abs(width(100,100)-original)<1e-8,'adequate thickness remains unchanged');
 const dx=kind==='gap'?40:180,dy=kind==='gap'?180:40;
 const projection=Math.abs(kind==='gap'?dx:dy)/Math.hypot(dx,dy*(kind==='gap'?1.25:1));
 assert.ok(width(dx,dy)>original,'thin waist is enlarged');
 assert.ok(Math.abs(width(dx,dy)*projection-3)<1e-8,'visible waist reaches 3px');
});
