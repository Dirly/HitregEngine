import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {planPainting,importPainting,paintingStatus,paintDir,paintPlanSchema,paintingBrief,type PaintPlan} from '../tools/prop-codex/paint.mts';
import {assertAtlasBudget,packBuiltProps,atlasFor} from '../tools/prop-codex/pack.mts';
import {BLENDER,blenderBuild,gateFaults} from '../tools/prop-codex/check.mts';
import {writeBrief} from '../tools/prop-codex/brief.mts';
import {install} from '../tools/prop-codex/install.mts';
import {packAtlas,atlasPaths} from '../../../tools/wfc-3d/kit.mjs';
import {run as registeredAtlas} from '../../../tools/atlas/run.mjs';
import {decodePng,encodePng} from '../../../tools/wfc-3d/png.mjs';
import {readGltf,accessorArray,imageBytes} from '../../../tools/wfc-3d/gltf.mjs';
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'hitreg-paint-test-'));
function clean(dir:string){const resolved=path.resolve(dir);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(resolved).startsWith('hitreg-paint-test-'));fs.rmSync(resolved,{recursive:true,force:true});}
function json(f:string,x:unknown){fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(x));}
function png(size:number,color=[83,61,42,255]){const data=new Uint8Array(size*size*4);for(let i=0;i<data.length;i+=4)data.set(color,i);return encodePng(size,size,data);}
function fixture(){const wk=temp();fs.mkdirSync(path.join(wk,'assets/textures/town-craft'),{recursive:true});fs.writeFileSync(path.join(wk,'assets/textures/town-craft/materials.png'),png(1024));json(path.join(wk,'authoring/town-craft/material-roles.json'),{roles:[{name:'wood'},{name:'iron'}]});return wk;}
const square=[[[0,0],[1,0],[1,1]],[[0,0],[1,1],[0,1]]] as [number[],number[],number[]][];
function plan():PaintPlan{return {geometrySha256:'a'.repeat(64),roles:['wood'],surfaces:[{name:'door-face',part:'body',projection:'front',detail:'Paint a carved insect and a worn border, with painted bevel shadows.',metres:[1,1],pixels:[40,40],triangles:square,faces:1}]};}
function artwork(dir:string){const key=decodePng(fs.readFileSync(path.join(dir,'key.png'))),data=new Uint8Array(key.data);for(let y=0;y<key.height;y++)for(let x=0;x<key.width;x++){const i=(y*key.width+x)*4;if([0,1,2].some(c=>key.data[i+c]!<246))data.set([45+(x%9)*9,60+(y%7)*8,95,255],i);}const f=path.join(dir,'fixture-art.png');fs.writeFileSync(f,encodePng(key.width,key.height,data));return f;}

test('paint plan preserves physical resolution, named mask shapes and disjoint shared tiles',()=>{
 const wk=fixture();try{
  const p=plan();p.surfaces.push({...p.surfaces[0]!,name:'circle',part:'seal',metres:[.6,.6],pixels:[24,24],triangles:[[[.5,0],[1,.5],[.5,1]],[[.5,0],[.5,1],[0,.5]]]});
  const layout=planPainting(wk,'paint-fixture',p),dir=paintDir(wk,'paint-fixture'),key=decodePng(fs.readFileSync(path.join(dir,'key.png'))),r=layout.surfaces.circle!;
  assert.deepEqual([layout.surfaces['door-face']!.w,layout.surfaces['door-face']!.h],[40,40]);
  assert.equal(key.data[(r.y*layout.size+r.x)*4],255,'outside shaped island stays white');
  assert.notEqual(key.data[((r.y+12)*layout.size+r.x+12)*4],255,'inside shaped island has its label colour');
  const rectangles=[...Object.values(layout.roles),...Object.values(layout.surfaces)];
  for(let a=0;a<rectangles.length;a++)for(let b=a+1;b<rectangles.length;b++){const x=rectangles[a]!,y=rectangles[b]!;assert.ok(x.x+x.w<=y.x||y.x+y.w<=x.x||x.y+x.h<=y.y||y.y+y.h<=x.y);}
  assert.match(paintingBrief(layout),/painted local form shading|painted.*shading/i);
  assert.equal(paintingStatus(wk,'paint-fixture',p).ready,false);
  assert.throws(()=>planPainting(wk,'../escape',p));
  assert.throws(()=>planPainting(wk,'too-big',{...p,surfaces:[{...p.surfaces[0],metres:[30,1],pixels:[1200,40]}]}),/exceed.*1024/);
  assert.throws(()=>paintPlanSchema.parse({...p,surfaces:[p.surfaces[0],p.surfaces[0]]}),/unique/i);
 }finally{clean(wk);}
});

test('art import uses the existing registrar, protects shared tile pixels and rejects stale or placeholder artwork',()=>{
 const wk=fixture();try{
  const p=plan(),layout=planPainting(wk,'paint-fixture',p),dir=paintDir(wk,'paint-fixture');
  assert.throws(()=>importPainting(wk,'paint-fixture',path.join(dir,'key.png')),/unpainted UV guide/);
  const f=artwork(dir);const status=importPainting(wk,'paint-fixture',f);assert.equal(status.ready,true);
  const atlas=decodePng(fs.readFileSync(path.join(dir,'atlas.png'))),r=layout.roles.wood!;
  assert.deepEqual([...atlas.data.slice(((r.y+32)*layout.size+r.x+32)*4,((r.y+32)*layout.size+r.x+32)*4+4)],[83,61,42,255]);
  assert.equal(paintingStatus(wk,'paint-fixture',{...p,geometrySha256:'b'.repeat(64)}).ready,false);
  fs.appendFileSync(path.join(dir,'art.png'),'changed');assert.equal(paintingStatus(wk,'paint-fixture',p).ready,false);
 }finally{clean(wk);}
});

test('wrong art resolution, transparent mesh pixels and atlas page overflow fail without shrinking artwork',()=>{
 const wk=fixture();try{
  planPainting(wk,'paint-fixture',plan());const dir=paintDir(wk,'paint-fixture'),bad=path.join(dir,'bad.png');
  fs.writeFileSync(bad,png(128));assert.throws(()=>importPainting(wk,'paint-fixture',bad),/match.*UV guide/);
  const f=artwork(dir),im=decodePng(fs.readFileSync(f)),key=decodePng(fs.readFileSync(path.join(dir,'key.png')));
  for(let i=0;i<key.data.length;i+=4)if(key.data[i]!<246){im.data[i+3]=0;break;}
  fs.writeFileSync(bad,encodePng(im.width,im.height,im.data));assert.throws(()=>importPainting(wk,'paint-fixture',bad),/transparent pixels/);
  const entries=[1,2].map(n=>{const file=path.join(wk,`source-${n}.gltf`);json(file,{asset:{version:'2.0'},materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0}}}],textures:[{source:0}],images:[{uri:'data:image/png;base64,'+png(1024,[n*35,40,50,255]).toString('base64')}]});return {file,out:`models/${n}.gltf`,kind:'prop'};});
  assert.throws(()=>assertAtlasBudget(null,entries,1),/budget is 1/);
  assert.doesNotThrow(()=>assertAtlasBudget(null,entries,2));
 }finally{clean(wk);}
});

test('every named island must be painted even when an untouched emblem occupies little of the sheet',()=>{
 const wk=fixture();try{
  const p=plan();p.surfaces.push({...p.surfaces[0]!,name:'small-seal',part:'seal',metres:[.2,.2],pixels:[8,8]});
  const layout=planPainting(wk,'partial-paint',p),dir=paintDir(wk,'partial-paint'),file=artwork(dir),art=decodePng(fs.readFileSync(file)),key=decodePng(fs.readFileSync(path.join(dir,'key.png'))),r=layout.surfaces['small-seal']!;
  for(let y=r.y;y<r.y+r.h;y++)for(let x=r.x;x<r.x+r.w;x++){const i=(y*layout.size+x)*4;art.data.set(key.data.subarray(i,i+4),i);}
  fs.writeFileSync(file,encodePng(art.width,art.height,art.data));assert.throws(()=>importPainting(wk,'partial-paint',file),/small-seal.*unpainted/);
 }finally{clean(wk);}
});

test('registered Atlas tool accepts named prop manifests and preserves measured size despite preset defaults',async()=>{
 const wk=fixture();try{
  const layout=planPainting(wk,'paint-fixture',plan()),dir=paintDir(wk,'paint-fixture'),art=artwork(dir),runDir=path.join(wk,'registered-run');fs.mkdirSync(runDir);
  const file=(p:string)=>({name:path.basename(p),mediaType:p.endsWith('.json')?'application/json':'image/png',data:fs.readFileSync(p).toString('base64')}),written=new Map<string,Buffer>(),ctx={runDir,writeAsset:(name:string,bytes:Buffer)=>{written.set(name,bytes);return name;}};
  await assert.rejects(()=>registeredAtlas(ctx,{sheet:'prop'}),/require.*manifest/);
  const result=await registeredAtlas(ctx,{sheet:'prop',key:file(path.join(dir,'key.png')),art:file(art),manifest:file(path.join(dir,'manifest.json')),name:'test/painted',size:64,bleed:8,filter:'box'});
  assert.equal(result.assets.length,1);assert.equal(decodePng(written.get('textures/test/painted.png')!).width,layout.size);
 }finally{clean(wk);}
});

test('brief makes paint the carrier of ornament, and painted shallow forms need no artificial extra parts',()=>{
 const b=writeBrief({request:{id:'civic/painted-seal',name:'painted-seal',culture:'civic',scale:'human',for:'test',status:'open',why:'',at:'',project:'world-kit'},name:'painted-seal',scale:{id:'human',height:1.8}});
 assert.match(b,/paint\(m, 'beetle-front'/);assert.doesNotMatch(b,/silhouette alone|never add materials, colours, images/);
 const g:any={name:'painted-seal',category:'decor',mount:'floor',setting:'outdoor',cultures:['civic'],size:[.6,.6,.1],triangles:12,texel:40,parts:[{part:'body',role:'wood',faces:6,extent:[.6,.1,.6]}],paintPlan:plan()};
 assert.deepEqual(gateFaults(g,{name:g.name,culture:'civic',scale:{id:'human',height:1.8},worldKit:''},[{id:'human',height:1.8}]),[]);
 g.paint={surfaces:[{name:'seal',texel:12}]};assert.match(gateFaults(g,{name:g.name,culture:'civic',scale:{id:'human',height:1.8},worldKit:''},[{id:'human',height:1.8}]).join(),/paint surface seal/);
});

// Synthetic fixtures only. Nothing is installed into world-kit or the visible Blender scene.
test('Blender end-to-end: panel, back, disc and wrap guides -> artwork -> one embedded material/page; stale paint blocks export', {skip:!fs.existsSync(BLENDER)}, async()=>{
 const wk=fixture();try{
  const helper=path.join(wk,'authoring/crockin-river-culture/mesh.py'),tc=path.join(wk,'authoring/town-craft/build.py');fs.mkdirSync(path.dirname(helper),{recursive:true});
  fs.writeFileSync(helper,`# grid adapter markers rid%4 rid//4 ((3-row)*128 /512
class Mesh:
 def __init__(self,name):self.name=name;self.v=[];self.f=[];self.uv=[];self.roles=[];self.parts=[];self.shift=Vector((0,0,0))
 def add(self,verts,faces,role,part,uv=None):
  off=len(self.v);self.v.extend(verts);self.f.extend([tuple(off+i for i in f) for f in faces]);self.roles.extend([role]*len(faces))
  for f in faces:
   p=[Vector(verts[i]) for i in f];n=(p[1]-p[0]).cross(p[2]-p[0]);drop=max(range(3),key=lambda k:abs(n[k]));axes=[k for k in range(3) if k!=drop];self.uv.append([(v[axes[0]],v[axes[1]]) for v in p])
  self.parts.append({'part':part,'role':role,'faces':len(faces)})
 def object(self,wall=False):
  return painted_object(self,{}, {},{'size':1024,'roles':{r:{'x':0,'y':0,'w':128,'h':128} for r in set(self.roles)}},mat,wall)
`);
  fs.writeFileSync(tc,'def block(*args,**kwargs):pass\ndef emit(*args,**kwargs):pass\n');
  fs.copyFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'fixtures/prop-paint-cleanup.py'),path.join(wk,'authoring/mesh-cleanup.py'));
  const designs=path.join(wk,'authoring/codex-craft/designs');fs.mkdirSync(designs,{recursive:true});
  const panel=path.join(designs,'paint-fixture.py'),wrap=path.join(designs,'wrap-fixture.py');
  fs.writeFileSync(panel,`m=Mesh('paint-fixture')
m.add([(-.5,-.1,0),(.5,-.1,0),(.5,.1,0),(-.5,.1,0),(-.5,-.1,1),(.5,-.1,1),(.5,.1,1),(-.5,.1,1)],[(3,2,1,0),(4,5,6,7),(0,1,5,4),(1,2,6,5),(2,3,7,6),(3,0,4,7)],'wood','body')
v=[(.3*math.cos(j*math.tau/12),.3*math.sin(j*math.tau/12),1.1) for j in range(12)]
m.add(v,[tuple(range(12))],'wood','disc')
paint(m,'front-art',part='body',projection='front',detail='Painted diagonal identification stripe')
paint(m,'back-art',part='body',projection='back',detail='Different painted back stripe')
paint(m,'round-art',part='disc',projection='top',detail='Painted round emblem')
emit(m,'Synthetic UV test fixture',category='decor',cultures=['civic'])
`);
  fs.writeFileSync(wrap,`m=Mesh('wrap-fixture')
v=[(.2*math.cos(j*math.tau/8),.2*math.sin(j*math.tau/8),z) for z in [0,.6] for j in range(8)]
m.add(v,[(j,(j+1)%8,8+(j+1)%8,8+j) for j in range(8)],'wood','shell')
paint(m,'wrapped-art',part='shell',projection='cylinder',detail='A continuous painted spiral')
emit(m,'Synthetic wrap test fixture',category='decor',cultures=['civic'])
`);
  const out=path.join(wk,'authoring/codex-craft/source'),geo=path.join(wk,'geometry.json');
  const planned=blenderBuild(wk,[panel,wrap],out,geo,{paintMode:'plan'});assert.ok(planned.every(g=>!g.error),JSON.stringify(planned));assert.equal(fs.readdirSync(out).length,0,'planning never exports placeholder GLBs');
  for(const g of planned){const layout=planPainting(wk,g.name,g.paintPlan);assert.equal(layout.plan.surfaces.length,g.name==='paint-fixture'?3:1);const dir=paintDir(wk,g.name);importPainting(wk,g.name,artwork(dir));}
  const final=blenderBuild(wk,[panel,wrap],out,geo);assert.ok(final.every(g=>!g.error),JSON.stringify(final));
  for(const g of final){assert.ok(g.paint?.ready);for(const s of g.paint!.surfaces)assert.ok(s.texel!>=32&&s.texel!<=48,JSON.stringify(s));const gltf=readGltf(path.join(out,g.name+'.glb'));assert.equal(gltf.doc.materials.length,1);assert.equal(gltf.doc.images.length,1);}
  // Check actual exported orientation, rather than merely checking the requested projection strings.
  const source=readGltf(path.join(out,'paint-fixture.glb')),prim=source.doc.meshes[0].primitives[0],pos=accessorArray(source,prim.attributes.POSITION),normal=accessorArray(source,prim.attributes.NORMAL),uv=accessorArray(source,prim.attributes.TEXCOORD_0),layout=JSON.parse(fs.readFileSync(path.join(paintDir(wk,'paint-fixture'),'layout.json'),'utf8'));
  let frontCount=0,backCount=0,discCount=0;
  for(let i=0;i<pos.length/3;i++){
   if(normal[i*3+2]!>.9||normal[i*3+2]!<-.9){
    const front=normal[i*3+2]!>.9,r=layout.surfaces[front?'front-art':'back-art'],u=front?pos[i*3]!+.5:.5-pos[i*3]!;
    assert.ok(Math.abs(uv[i*2]!-(r.x+u*r.w)/layout.size)<.00001);
    assert.ok(Math.abs(uv[i*2+1]!-(r.y+(1-pos[i*3+1]!)*r.h)/layout.size)<.00001);
    if(front)frontCount++;else backCount++;
   }
   if(pos[i*3+1]!>1.09&&normal[i*3+1]!>.9){const r=layout.surfaces['round-art'];assert.ok(Math.abs(uv[i*2]!-(r.x+(pos[i*3]!+.3)/.6*r.w)/layout.size)<.00001);assert.ok(Math.abs(uv[i*2+1]!-(r.y+(pos[i*3+2]!+.3)/.6*r.h)/layout.size)<.00001);discCount++;}
  }
  assert.ok(frontCount&&backCount&&discCount);
  const plain=path.join(designs,'plain-fixture.py');fs.writeFileSync(plain,fs.readFileSync(panel,'utf8').replaceAll('paint-fixture','plain-fixture').split('\n').filter(l=>!l.startsWith('paint(')).join('\n'));
  const plainRecord=blenderBuild(wk,[plain],out,geo)[0]!;assert.equal(plainRecord.error,undefined);
  const control=path.join(wk,'control-source.glb');fs.copyFileSync(path.join(out,'plain-fixture.glb'),control);
  packAtlas({assetsDir:path.join(wk,'assets'),atlasName:'town-craft',entries:[{file:control,out:'models/town-craft/control.gltf',kind:'prop'}],log:()=>{},warn:()=>{}});
  const controlFile=path.join(wk,'assets/models/town-craft/control.gltf'),controlBytes=fs.readFileSync(controlFile);
  packBuiltProps(wk,[...final,plainRecord]);assert.deepEqual(fs.readFileSync(controlFile),controlBytes,'unrelated town models remain byte-identical');
  const published=readGltf(path.join(wk,'assets/models/codex-craft/paint-fixture.gltf'));assert.equal(published.doc.materials.length,1);assert.equal(published.doc.meshes[0].primitives.length,1);assert.equal(decodePng(imageBytes(published,0).bytes).width,2048);
  assert.ok([...accessorArray(published,published.doc.meshes[0].primitives[0].attributes.TEXCOORD_0)].every(v=>v>=0&&v<=1));
  // Switching a prop's texture strategy transfers atlas ownership in both directions.
  // Otherwise a later unrelated town repack could overwrite the painted export.
  const plainSource=path.join(out,'plain-fixture.glb'),plainBytes=fs.readFileSync(plainSource),plainOutput='models/codex-craft/plain-fixture.gltf';
  const owners=()=>['town-craft','codex-craft-painted'].filter(name=>JSON.parse(fs.readFileSync(atlasPaths(path.join(wk,'assets'),name).layoutFile,'utf8')).sources.some((s:any)=>s.out===plainOutput));
  fs.copyFileSync(path.join(out,'paint-fixture.glb'),plainSource);
  packBuiltProps(wk,[{...plainRecord,paint:final[0]!.paint}]);assert.deepEqual(owners(),['codex-craft-painted']);
  fs.writeFileSync(plainSource,plainBytes);
  packBuiltProps(wk,[plainRecord]);assert.deepEqual(owners(),['town-craft']);assert.deepEqual(fs.readFileSync(controlFile),controlBytes);
  // c-props2: a painted LANDMARK packs onto its own atlas (the painted props' 4-page budget stays theirs), and moves back out cleanly.
  const owners3=()=>['town-craft','codex-craft-painted','codex-craft-landmark'].filter(name=>{const f=atlasPaths(path.join(wk,'assets'),name).layoutFile;return fs.existsSync(f)&&JSON.parse(fs.readFileSync(f,'utf8')).sources.some((s:any)=>s.out===plainOutput);});
  assert.equal(atlasFor(plainRecord,new Set(['plain-fixture'])),'town-craft');assert.equal(atlasFor({name:'x',paint:{}},new Set(['x'])),'codex-craft-landmark');assert.equal(atlasFor({name:'x',paint:{}}),'codex-craft-painted');
  fs.copyFileSync(path.join(out,'paint-fixture.glb'),plainSource);
  packBuiltProps(wk,[{...plainRecord,paint:final[0]!.paint}],()=>{},new Set(['plain-fixture']));assert.deepEqual(owners3(),['codex-craft-landmark']);
  fs.writeFileSync(plainSource,plainBytes);
  packBuiltProps(wk,[plainRecord]);assert.deepEqual(owners3(),['town-craft']);assert.deepEqual(fs.readFileSync(controlFile),controlBytes);
  // The normal installer must retain provenance and render clay/unlit/lit, not just export a source GLB.
  json(path.join(wk,'authoring/prop-catalogs.json'),{version:1,catalogs:[]});json(path.join(wk,'authoring/codex-craft/requests.json'),{version:1,props:Object.fromEntries([...final,plainRecord].map(g=>[g.name,{request:'test/'+g.name,project:'world-kit',for:'synthetic fixture',culture:'civic',scale:'human'}]))});
  const installed=install(wk,{cards:['paint-fixture']});assert.equal(installed.built.length,3);
  const catalog=JSON.parse(fs.readFileSync(path.join(wk,'authoring/codex-craft/catalog.json'),'utf8'));assert.equal(catalog.props.find((p:any)=>p.id.endsWith('/paint-fixture')).painting.surfaces.length,3);assert.equal(catalog.props.find((p:any)=>p.id.endsWith('/plain-fixture')).atlas,'town-craft');
  for(const pass of ['prop','clay','unlit'])assert.ok(fs.existsSync(path.join(wk,'authoring/codex-craft/reports',`${pass}-paint-fixture.png`)));
  assert.deepEqual(fs.readFileSync(controlFile),controlBytes);
  fs.appendFileSync(panel,"\n# no-op source comment should preserve the measured UV hash\n");assert.equal(blenderBuild(wk,[panel],out,geo)[0]!.error,undefined);
  fs.writeFileSync(panel,fs.readFileSync(panel,'utf8').replace(".5,-.1,1)",".55,-.1,1)"));
  const stale=blenderBuild(wk,[panel],out,geo)[0]!;assert.match(stale.error!,/guide is stale/);
  const catalogFile=path.join(wk,'authoring/codex-craft/catalog.json'),catalogBefore=fs.readFileSync(catalogFile),runtimeFile=path.join(wk,'assets/models/codex-craft/paint-fixture.gltf'),runtimeBefore=fs.readFileSync(runtimeFile);
  assert.throws(()=>install(wk,{cards:[]}),/stale/);assert.deepEqual(fs.readFileSync(catalogFile),catalogBefore);assert.deepEqual(fs.readFileSync(runtimeFile),runtimeBefore);
 }finally{clean(wk);}
});
