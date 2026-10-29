/** Named prop artwork: physical UV guide -> existing image/atlas tools -> one opaque source page. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {Atlas} from '../../../../tools/wfc-3d/atlas.mjs';
import {decodePng,encodePng} from '../../../../tools/wfc-3d/png.mjs';
const HERE=path.dirname(fileURLToPath(import.meta.url)),ENGINE=path.resolve(HERE,'../../../..');
const slug=z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const point=z.tuple([z.number().finite().min(-.00001).max(1.00001),z.number().finite().min(-.00001).max(1.00001)]);
export const paintPlanSchema=z.object({
 geometrySha256:z.string().regex(/^[a-f0-9]{64}$/).describe('Hash of geometry, metre UVs, materials and surface declarations. Changing it requires a fresh guide and artwork import.'),
 roles:z.array(z.string()).min(1).describe('Existing town-craft material roles still used by the prop.'),
 surfaces:z.array(z.object({name:slug,part:z.string().min(1),projection:z.enum(['front','back','left','right','top','bottom','cylinder']),detail:z.string().min(1).describe('What the image artist paints: identity, ornament, carved shading and wear; no added geometry.'),metres:z.tuple([z.number().positive(),z.number().positive()]),pixels:z.tuple([z.number().int().positive(),z.number().int().positive()]).describe('Measured surface span at 40 texels/m. The packer never shrinks it to fit.'),triangles:z.array(z.tuple([point,point,point])).min(1).describe('Actual projected mesh footprint, UV bottom-up. Holes and circular outlines remain white on the guide.'),faces:z.number().int().positive()})).max(32)
}).superRefine((p,c)=>{
 if(new Set(p.surfaces.map(s=>s.name)).size!==p.surfaces.length)c.addIssue({code:'custom',message:'Surface names must be unique'});
 for(const s of p.surfaces)if(s.pixels.some((v,i)=>v/s.metres[i]!<32||v/s.metres[i]!>48))c.addIssue({code:'custom',message:s.name+': measured resolution must stay within 32–48 texels/m (target 40)'});
});
export type PaintPlan=z.infer<typeof paintPlanSchema>;
const rect=z.object({x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),w:z.number().int().positive(),h:z.number().int().positive()});
export const paintLayoutSchema=z.object({version:z.literal(1),geometrySha256:z.string(),size:z.union([z.literal(256),z.literal(512),z.literal(1024)]),pad:z.literal(4),roles:z.record(z.string(),rect),surfaces:z.record(z.string(),rect.extend({color:z.string().regex(/^#[a-f0-9]{6}$/)})),plan:paintPlanSchema}).superRefine((p,c)=>{
 const fail=(message:string)=>c.addIssue({code:'custom',message});
 if(p.geometrySha256!==p.plan.geometrySha256)fail('Layout and measured geometry hashes differ');
 if(Object.keys(p.roles).sort().join('|')!==[...p.plan.roles].sort().join('|')||Object.keys(p.surfaces).sort().join('|')!==p.plan.surfaces.map(s=>s.name).sort().join('|'))fail('Layout must account for every measured role and surface');
 const rectangles=[...Object.entries(p.roles).map(([name,r])=>({...r,name,kind:'role'})),...Object.entries(p.surfaces).map(([name,r])=>({...r,name,kind:'paint'}))];
 for(const r of rectangles){
  if(r.x<p.pad||r.y<p.pad||r.x+r.w+p.pad>p.size||r.y+r.h+p.pad>p.size)fail(r.name+': region exceeds its square source page or bleed');
  if(r.kind==='role'&&(r.w!==128||r.h!==128))fail(r.name+': shared tiles must preserve 128px source resolution');
  const s=p.plan.surfaces.find(s=>s.name===r.name);if(r.kind==='paint'&&s&&(r.w!==s.pixels[0]||r.h!==s.pixels[1]))fail(r.name+': painted resolution must match its measured surface');
 }
 for(let i=0;i<rectangles.length;i++)for(let j=i+1;j<rectangles.length;j++){
  const a=rectangles[i]!,b=rectangles[j]!;
  if(a.kind===b.kind&&a.kind==='role'&&a.x===b.x&&a.y===b.y&&a.w===b.w&&a.h===b.h)continue; // pixel-identical shared tiles may deduplicate
  if(a.x-p.pad<b.x+b.w+p.pad&&b.x-p.pad<a.x+a.w+p.pad&&a.y-p.pad<b.y+b.h+p.pad&&b.y-p.pad<a.y+a.h+p.pad)fail(a.name+' overlaps '+b.name+' or its bleed');
 }
 if(new Set(Object.values(p.surfaces).map(r=>r.color)).size!==Object.keys(p.surfaces).length)fail('Every painted surface needs its own guide label colour');
});
export type PaintLayout=z.infer<typeof paintLayoutSchema>;
export const sha=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read=(f:string)=>JSON.parse(fs.readFileSync(f,'utf8'));
const write=(f:string,data:unknown)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(data,null,2)+'\n');};
export const paintDir=(wk:string,name:string)=>{slug.parse(name);return path.join(wk,'authoring/codex-craft/paint',name);};
const colors=['#d94a3c','#37a85b','#7656c9','#c99830','#257db6','#c45394','#669b23','#b3622c','#4c5dbb','#208d85','#99494a','#8c72b7'];
function color(i:number){return colors[i%colors.length]!.slice(0,5)+(16+Math.floor(i/colors.length)*16).toString(16).padStart(2,'0');}
function flat(w:number,h:number,hex:string){const rgba=new Uint8Array(w*h*4),rgb=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));for(let i=0;i<rgba.length;i+=4)rgba.set([...rgb,255],i);return {width:w,height:h,rgba};}
function pixelRect(data:Uint8Array,size:number,r:{x:number;y:number;w:number;h:number},image:{width:number;height:number;rgba:Uint8Array},pad=0){
 for(let y=-pad;y<r.h+pad;y++)for(let x=-pad;x<r.w+pad;x++){
  const xx=r.x+x,yy=r.y+y;if(xx<0||yy<0||xx>=size||yy>=size)continue;
  const sx=((x%image.width)+image.width)%image.width,sy=((y%image.height)+image.height)%image.height;
  data.set(image.rgba.subarray((sy*image.width+sx)*4,(sy*image.width+sx)*4+4),(yy*size+xx)*4);
 }
}
function raster(data:Uint8Array,size:number,r:{x:number;y:number;w:number;h:number},tri:number[][],rgb:number[]){
 const p=tri.map(([u,v])=>[r.x+u!*r.w,r.y+(1-v!)*r.h]);
 const cross=(a:number[],b:number[],x:number,y:number)=>(b[0]!-a[0]!)*(y-a[1]!)-(b[1]!-a[1]!)*(x-a[0]!);
 const orient=cross(p[0]!,p[1]!,p[2]![0]!,p[2]![1]!)>=0?1:-1;
 for(let y=Math.max(r.y,Math.floor(Math.min(...p.map(a=>a[1]!))));y<Math.min(r.y+r.h,Math.ceil(Math.max(...p.map(a=>a[1]!))));y++)
  for(let x=Math.max(r.x,Math.floor(Math.min(...p.map(a=>a[0]!))));x<Math.min(r.x+r.w,Math.ceil(Math.max(...p.map(a=>a[0]!))));x++)
   if(p.every((a,j)=>cross(a,p[(j+1)%3]!,x+.5,y+.5)*orient>=-1e-7))data.set([...rgb,255],(y*size+x)*4);
}
function roleImages(wk:string,names:string[]){
 const source=decodePng(fs.readFileSync(path.join(wk,'assets/textures/town-craft/materials.png'))),roles=read(path.join(wk,'authoring/town-craft/material-roles.json')).roles.map((r:any)=>r.name);
 if(source.width!==1024||source.height!==1024)throw Error('town-craft role sheet must be 1024 square');
 return Object.fromEntries(names.map(name=>{const index=roles.indexOf(name);if(index<0)throw Error('Unknown shared role '+name);const rgba=new Uint8Array(128*128*4);for(let y=0;y<128;y++)for(let x=0;x<128;x++){const s=(((index>>3)*128+y)*1024+(index%8)*128+x)*4;rgba.set(source.data.subarray(s,s+4),(y*128+x)*4);}return [name,{width:128,height:128,rgba}];}));
}
export function planPainting(wk:string,name:string,input:unknown):PaintLayout{
 const plan=paintPlanSchema.parse(input);if(!plan.surfaces.length)throw Error(name+': design declares no painted surfaces');
 const dir=paintDir(wk,name),images=roleImages(wk,plan.roles);let layout:PaintLayout|undefined;
 for(const size of [256,512,1024] as const){
  const atlas=new Atlas({pageSize:size,pad:4}),roles:PaintLayout['roles']={},surfaces:PaintLayout['surfaces']={};let failed=false;
  const entries=[...Object.entries(images).map(([id,image])=>({id,kind:'role',image,color:''})),...plan.surfaces.map((s,i)=>({id:s.name,kind:'paint',image:flat(s.pixels[0],s.pixels[1],color(i)),color:color(i)}))].sort((a,b)=>b.image.width*b.image.height-a.image.width*a.image.height||a.id.localeCompare(b.id));
  try{for(const e of entries){const r=atlas.add(e.image);if(r.page>0){failed=true;break;}const region={x:r.x,y:r.y,w:r.w,h:r.h};if(e.kind==='role')roles[e.id]=region;else surfaces[e.id]={...region,color:e.color};}}catch{failed=true;}
  if(!failed){layout=paintLayoutSchema.parse({version:1,geometrySha256:plan.geometrySha256,size,pad:4,roles,surfaces,plan});break;}
 }
 if(!layout)throw Error(name+': painted surfaces plus shared roles exceed one 1024px source page at 40 tx/m; split the asset or surfaces, do not shrink UVs');
 fs.mkdirSync(dir,{recursive:true});
 const key=new Uint8Array(layout.size*layout.size*4).fill(255),slots:Record<string,unknown>={};
 for(const s of plan.surfaces){const r=layout.surfaces[s.name]!,rgb=[1,3,5].map(i=>parseInt(r.color.slice(i,i+2),16));for(const tri of s.triangles)raster(key,layout.size,r,tri,rgb);slots[r.color]={name:s.name,transparency:false,cut:false,fit:'none'};}
 fs.writeFileSync(path.join(dir,'key.png'),encodePng(layout.size,layout.size,key));
 write(path.join(dir,'layout.json'),layout);write(path.join(dir,'manifest.json'),{size:layout.size,bleed:4,filter:'nearest',bgLum:236,slots});
 return layout;
}
export function paintingBrief(layout:PaintLayout){
 return ['Paint the attached UV guide for a PSX / WoW Classic / EverQuest 3D prop.','Keep every island in its exact position and footprint. Opaque hand-painted colour artwork, deliberate low-resolution brushwork, nearest-filtered pixels.','Paint convincing carved form, shell segmentation, ornamental relief, bevel shading, patina and wear. These details belong in the artwork, not modeled strands, legs, veins or rivets.','Even diffuse illumination; painted local form shading is wanted. No scene cast shadows, directional highlights, perspective, text labels, extra islands, normal maps or geometry.','White outside the colored islands. Do not reproduce the colored guide fills. Match the requested palette across islands.',...layout.plan.surfaces.map(s=>{const r=layout.surfaces[s.name]!;return `${s.name}: ${r.color}, rectangle x=${r.x}, y=${r.y}, width=${r.w}, height=${r.h}. ${s.projection} of ${s.part}, ${s.metres.map(v=>v.toFixed(3)).join(' x ')} metres. Paint: ${s.detail}`;})].join('\n');
}
export function paintingStatus(wk:string,name:string,plan?:PaintPlan){
 const dir=paintDir(wk,name),faults:string[]=[];let layout:PaintLayout|undefined,receipt:any;
 try{layout=paintLayoutSchema.parse(read(path.join(dir,'layout.json')));if(plan&&layout.geometrySha256!==plan.geometrySha256)faults.push('UV guide is stale; run props paint plan');}catch{faults.push('UV guide missing or invalid; run props paint plan');}
 try{receipt=read(path.join(dir,'receipt.json'));for(const [f,key] of [['layout.json','layoutSha256'],['art.png','artSha256'],['atlas.png','atlasSha256'],['key.png','keySha256'],['manifest.json','manifestSha256']] as const)if(!fs.existsSync(path.join(dir,f))||sha(path.join(dir,f))!==receipt[key])faults.push(f+' missing or changed; import artwork again');if(sha(path.join(wk,'assets/textures/town-craft/materials.png'))!==receipt.roleSheetSha256)faults.push('Shared role sheet changed; import artwork again');}catch{faults.push('Registered artwork missing; run props paint import');}
 return {name,ready:!faults.length,faults,layout,receipt};
}
export function importPainting(wk:string,name:string,artFile:string){
 const dir=paintDir(wk,name),layout=paintLayoutSchema.parse(read(path.join(dir,'layout.json'))),art=decodePng(fs.readFileSync(artFile));
 if(art.width!==layout.size||art.height!==layout.size)throw Error(`Artwork must match the ${layout.size}x${layout.size} UV guide`);
 const key=decodePng(fs.readFileSync(path.join(dir,'key.png')));
 for(const [name,region] of Object.entries(layout.surfaces)){
  let mask=0,unchanged=0;
  for(let y=region.y;y<region.y+region.h;y++)for(let x=region.x;x<region.x+region.w;x++){
   const i=(y*layout.size+x)*4;
   if(key.data[i]!<246||key.data[i+1]!<246||key.data[i+2]!<246){mask++;if(art.data[i+3]!<250)throw Error('Painted surfaces are opaque; artwork has transparent pixels inside a mesh island');if([0,1,2].every(c=>Math.abs(art.data[i+c]!-key.data[i+c]!)<4))unchanged++;}
  }
  if(!mask||unchanged/mask>.5)throw Error(name+': artwork still contains the unpainted UV guide');
 }
 const target=path.join(dir,'art.png');if(path.resolve(artFile)!==path.resolve(target))fs.copyFileSync(artFile,target);
 const out=path.join(dir,'registered'),r=spawnSync(process.execPath,[path.join(ENGINE,'tools/atlas/import-atlas.mjs'),'--key',path.join(dir,'key.png'),'--art',target,'--manifest',path.join(dir,'manifest.json'),'--out',out,'--filter','nearest'],{encoding:'utf8',maxBuffer:1<<26});
 if(r.status!==0)throw Error('Atlas registration failed: '+String(r.stdout)+String(r.stderr));
 const registered=decodePng(fs.readFileSync(path.join(out,'atlas.png'))),combined=new Uint8Array(layout.size*layout.size*4).fill(255);
 for(const [name,image] of Object.entries(roleImages(wk,layout.plan.roles)))pixelRect(combined,layout.size,layout.roles[name]!,image,4);
 for(const region of Object.values(layout.surfaces)){
  // Importer's bleed already follows the actual island mask; preserve it, including circular edges.
  for(let y=region.y-4;y<region.y+region.h+4;y++)for(let x=region.x-4;x<region.x+region.w+4;x++){
   if(x<0||y<0||x>=layout.size||y>=layout.size)continue;const i=(y*layout.size+x)*4;
   if(key.data[i]!<246||key.data[i+1]!<246||key.data[i+2]!<246)if(registered.data[i+3]!<250)throw Error('Registered artwork leaves an opaque mesh surface unpainted');
   combined.set([registered.data[i]!,registered.data[i+1]!,registered.data[i+2]!,255],i);
  }
 }
 fs.writeFileSync(path.join(dir,'atlas.png'),encodePng(layout.size,layout.size,combined));
 write(path.join(dir,'receipt.json'),{version:1,geometrySha256:layout.geometrySha256,layoutSha256:sha(path.join(dir,'layout.json')),keySha256:sha(path.join(dir,'key.png')),manifestSha256:sha(path.join(dir,'manifest.json')),artSha256:sha(target),atlasSha256:sha(path.join(dir,'atlas.png')),roleSheetSha256:sha(path.join(wk,'assets/textures/town-craft/materials.png')),provenance:{importedFrom:path.resolve(artFile),registration:'tools/atlas/import-atlas.mjs'},review:'provisional; inspect clay, unlit artwork and lit renders'});
 return paintingStatus(wk,name);
}
/** The design's concept frame, if its prop request carried one (`request add --concept`): codex-craft requests.json -> the request project's prop-requests.json. */
export function designConcept(wk:string,name:string,play=path.resolve(wk,'../..')):string|undefined{return requestFile(wk,name,'concept',play);}
/** The stone tile the paint must sit on (request `tint`, e.g. the zone's cliff tile): a set of carved pieces matches ONE zone stone, not each concept frame's own red. */
export function designTint(wk:string,name:string,play=path.resolve(wk,'../..')):string|undefined{return requestFile(wk,name,'tint',play);}
function requestFile(wk:string,name:string,key:'concept'|'tint',play:string):string|undefined{
 try{const o=read(path.join(wk,'authoring/codex-craft/requests.json')).props?.[name];if(!o)return;const reqs=read(path.join(wk,'..',o.project,'authoring/dressing/prop-requests.json')).requests??[];const c=reqs.find((r:any)=>r.id===o.request)?.[key];return typeof c==='string'&&fs.existsSync(path.resolve(play,c))?path.resolve(play,c):undefined;}catch{return;}
}
/** The prompt line naming each attached reference by position: UV guide, then concept frame, then tint tile. */
export function paintRefsLine(concept?:string,tint?:string):string{
 if(!concept&&!tint)return '';
 const nth=['SECOND','THIRD'];let i=0,out='\nThe FIRST attached image is the UV guide to paint;';
 if(concept)out+=` the ${nth[i++]} is the concept frame: match its${tint?'':' stone colour,'} palette, carved motifs and wear (never its perspective, backdrop or the scale figure)${tint?';':'.'}`;
 if(tint)out+=` the ${nth[i++]} is the zone's stone tile: every stone surface takes ITS hue, saturation and value (the concept's red is only a hint), so the piece sits beside the zone's cliffs and the other carved pieces of its set.`;
 return out;
}
export function generatePainting(wk:string,name:string,force=false){
 const dir=paintDir(wk,name),layout=paintLayoutSchema.parse(read(path.join(dir,'layout.json'))),play=path.resolve(wk,'../..'),concept=designConcept(wk,name,play),tint=designTint(wk,name,play);
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'hitreg-paint-prompt-')),promptFile=path.join(scratch,'prompt.txt');
 try{
  fs.writeFileSync(promptFile,paintingBrief(layout)+paintRefsLine(concept,tint));
  const r=spawnSync(process.execPath,[path.join(play,'tools/image-request.mjs'),'gen','--id',`prop-${name}-paint`,'--target',path.relative(play,path.join(dir,'art.png')),'--size',`${layout.size}x${layout.size}`,'--ref',path.join(dir,'key.png'),...(concept?['--ref',concept]:[]),...(tint?['--ref',tint]:[]),'--purpose','UV-registered hand-painted prop artwork','--prompt-file',promptFile,...(force?['--force']:[])],{encoding:'utf8',cwd:play,maxBuffer:1<<26});
  if(r.status!==0)throw Error('Image generation failed: '+r.stdout+r.stderr);
 }finally{const resolved=path.resolve(scratch);if(!resolved.startsWith(path.resolve(os.tmpdir())+path.sep)||!path.basename(resolved).startsWith('hitreg-paint-prompt-'))throw Error('Unexpected painting prompt scratch path');fs.rmSync(resolved,{recursive:true,force:true});}
 importPainting(wk,name,path.join(dir,'art.png'));
 const receipt=read(path.join(dir,'receipt.json'));receipt.provenance={...receipt.provenance,generatedBy:'tools/image-request.mjs',requestId:`prop-${name}-paint`};write(path.join(dir,'receipt.json'),receipt);
 return paintingStatus(wk,name);
}
/** One disposable build plan, with no runtime export and no generation. Safe for CLI and installer preflight. */
export async function measurePainting(wk:string,names:string[]=[]){
 const {blenderBuild}=await import('./check.mts'),dir=path.join(wk,'authoring/codex-craft/designs'),files=(names.length?names.map(n=>slug.parse(n)+'.py'):fs.readdirSync(dir).filter(f=>f.endsWith('.py'))).sort().map(f=>path.join(dir,f));
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'hitreg-prop-paint-'));
 try{return blenderBuild(wk,files,scratch,path.join(scratch,'geometry.json'),{paintMode:'plan'});}finally{const resolved=path.resolve(scratch),temp=path.resolve(os.tmpdir())+path.sep;if(!resolved.startsWith(temp)||!path.basename(resolved).startsWith('hitreg-prop-paint-'))throw Error('Unexpected painting scratch path');fs.rmSync(resolved,{recursive:true,force:true});}
}
export async function paintCommand(wk:string,action:string,names:string[],options:{art?:string;force?:boolean}={}){
 if(action==='schema')return {plan:z.toJSONSchema(paintPlanSchema),layout:z.toJSONSchema(paintLayoutSchema)};
 if(!['plan','status','gen','import'].includes(action))throw Error('props paint plan|status|gen|import <design name...> | schema');
 if(['gen','import'].includes(action)&&names.length!==1)throw Error('paint gen/import takes exactly one design name');
 const records=await measurePainting(wk,names);const results=[];
 for(const g of records){
  if(g.error)throw Error(g.name+': '+g.error);
  if(!g.paintPlan?.surfaces.length){if(names.length)throw Error(g.name+': no paint(...) declarations');continue;}
  const plan=paintPlanSchema.parse(g.paintPlan);
  if(action==='plan'){const layout=planPainting(wk,g.name,plan);results.push({name:g.name,size:layout.size,surfaces:plan.surfaces.map(s=>s.name),guide:path.join(paintDir(wk,g.name),'key.png')});}
  else {
   const status=paintingStatus(wk,g.name,plan);
   if(action==='status'){results.push({name:g.name,ready:status.ready,faults:status.faults});continue;}
   if(!status.layout||status.layout.geometrySha256!==plan.geometrySha256)throw Error(g.name+': guide missing or stale; run props paint plan first');
   const imported=action==='gen'?generatePainting(wk,g.name,options.force):importPainting(wk,g.name,options.art?path.resolve(options.art):path.join(paintDir(wk,g.name),'art.png'));
   results.push({name:g.name,ready:imported.ready,faults:imported.faults});
  }
 }
 return results;
}
