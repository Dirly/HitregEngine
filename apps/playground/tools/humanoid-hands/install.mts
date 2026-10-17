/** Validated asset installation and reversible bestiary ops. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {motionRegistry} from './custom-motion.mjs';
import {applyOps,ComponentRegistry,registerCoreComponents,registerChunkComponents,type Op} from '@hitreg/core';
const here=path.dirname(fileURLToPath(import.meta.url)), project=path.resolve(here,'../../projects/foundation'),folder=path.join(project,'authoring/humanoid-hands-v1');
const report=JSON.parse(fs.readFileSync(path.join(folder,'engine-compatibility-report.json'),'utf8'));
if(!report.passed)throw Error('Verify the candidates before installation');
const hashes:any[]=[];
const priorFile=path.join(folder,'installation.json');
const prior=fs.existsSync(priorFile)?JSON.parse(fs.readFileSync(priorFile,'utf8')):null;
// Preflight the whole batch before writing any model. Retired appearances are
// deliberately absent; newer modular skins must never be recreated from an
// old report, or overwritten after their candidate was built.
const jobs=report.reports.map((r:any)=>({r,source:r.source??path.join(folder,r.asset+'.glb'),target:path.join(project,r.asset==='human-body'?'assets/models/mmo':'assets/models/mmo/mobs',r.asset+'.glb')}));
const hash=(file:string)=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
for(const {r,source,target} of jobs){
 if(!fs.existsSync(target))throw Error(r.asset+': retired or missing installed model; rebake the current canonical actor');
 if(hash(source)!==r.sha256)throw Error(r.asset+': candidate changed after verification');
 if(!r.inputRuntimeSha256)throw Error(r.asset+': report predates current-model preservation; run hands bake/check again');
 if(hash(target)!==r.inputRuntimeSha256&&hash(target)!==r.sha256)throw Error(r.asset+': installed model changed since the bake; rebake against the current skin');
}
if(process.argv.includes('--dry-run')){console.log('Installation preflight passed for '+jobs.length+' current models; no files written');process.exit(0)}
for(const {r,source,target} of jobs){
 const backup=path.join(folder,r.asset+'-before-install.glb');
 if(fs.existsSync(target)&&!fs.existsSync(backup))fs.copyFileSync(target,backup);
 if(path.resolve(source)!==path.resolve(target))fs.copyFileSync(source,target);hashes.push({asset:r.asset,target:path.relative(project,target),sha256:crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'),clips:r.clips});
}
const registry=new ComponentRegistry();registerCoreComponents(registry);registerChunkComponents(registry);
const changed:any[]=[];
for(const scene of ['bestiary-not-rigged-yet','bestiary-spectral-and-undead','bestiary-crawlers-and-fliers']){
 const file=path.join(project,'assets/scenes',scene+'.scene.json'),doc=JSON.parse(fs.readFileSync(file,'utf8')),ops:Op[]=[];
 for(const [id,e] of Object.entries(doc.entities) as any){
  const match=e.components.mesh?.source?.assetId?.match(/^mmo\/mobs\/static\/(ogre|ratkin|crockin(?:-pads|-armored|-armored-pads)?|frogkin(?:-pads|-armored|-armored-pads)?)\.glb$/);
  if(!match)continue;
  const mesh={...e.components.mesh,source:{...e.components.mesh.source,assetId:'mmo/mobs/'+match[1]+'.glb'}};
  const label=e.name.replace(/\s*\(not rigged\)/i,'');
  ops.push({op:'set-component',id,component:'mesh',data:mesh},{op:'set-component',id,component:'animator',data:{...e.components.animator,play:'Idle',upperBody:'CC_Base_Waist'}},{op:'rename',id,name:label});
  if(e.components.billboard)ops.push({op:'set-component',id,component:'billboard',data:{...e.components.billboard,text:label}});
  if(e.components.script)ops.push({op:'set-component',id,component:'script',data:{...e.components.script,params:{...e.components.script.params,label,reel:'Idle,Walk,Run,Attack1,Cast_Shoot,Hit_Chest,Death'}}});
 }
 if(scene==='bestiary-crawlers-and-fliers'){
  const id='stand-anansi',e=doc.entities[id],mask=report.reports.find((r:any)=>r.asset==='anansi').layer?.maskRoot;
  if(!mask)throw Error('Verify the Anansi upper-body mask before installation');
  const play=motionRegistry(project).anansi?.preserve?.includes('Idle')?'Idle':'Walk';
  if(e.components.animator.play!==play||e.components.animator.upperBody!==mask)ops.push({op:'set-component',id,component:'animator',data:{...e.components.animator,play,upperBody:mask}});
 }
 if(scene==='bestiary-not-rigged-yet'&&doc.entities['title-not-rigged-yet'].components.billboard.text!=='Humanoids — animation library'){
  const id='title-not-rigged-yet',e=doc.entities[id];
  ops.push({op:'rename',id,name:'Humanoids — animation library'},{op:'set-component',id,component:'billboard',data:{...e.components.billboard,text:'Humanoids — animation library'}});
 }
 if(ops.length){const result=applyOps(doc,ops,registry);fs.writeFileSync(file,JSON.stringify(result.doc,null,2)+'\n');changed.push({scene,ops,inverse:result.inverse});}
}
fs.writeFileSync(path.join(folder,'installation.json'),JSON.stringify({installed:true,assets:hashes,sceneChanges:changed,history:[...(prior?.history??[]),...(prior?[{assets:prior.assets,sceneChanges:prior.sceneChanges}]:[])]},null,2)+'\n');
console.log('Installed '+hashes.length+' models; updated '+changed.length+' bestiary scenes');
