import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import * as THREE from 'three';
import {AnimationSystem} from '../../../../packages/render/src/animation.ts';
import {loadCharacter} from '../_load-character.mjs';
import {motionRegistry} from './custom-motion.mjs';
const here=path.dirname(fileURLToPath(import.meta.url));
const folder=path.resolve(here,'../../projects/foundation/authoring/humanoid-hands-v1');
const source=await loadCharacter(path.resolve(here,'../../projects/foundation/assets/models/mmo/human-body.glb'));
const library=source.animations.map((c:any)=>c.name).sort();
const custom=motionRegistry(path.resolve(folder,'../..'));
const project=path.resolve(folder,'../..'),runtime=(asset:string)=>path.join(project,'assets/models/mmo',asset==='human-body'?'':'mobs',asset+'.glb');
const assets=['ogre','ratkin',...['crockin','frogkin'].flatMap(n=>[n,...['pads','armored','armored-pads'].map(s=>n+'-'+s)]),'anansi','human-body'].filter(a=>fs.existsSync(runtime(a)));
const reports:any[]=[];
for(const asset of assets){
 // Human and hybrid Anansi geometry are authored by their dedicated Blender
 // exporters. A mob-library rebake checks their current installed libraries;
 // it does not reinstall an old prepared copy over a newer modular model.
 const inputFile=path.join(folder,asset+'-bake-input.json'),input=fs.existsSync(inputFile)?JSON.parse(fs.readFileSync(inputFile,'utf8')):null;
 const file=['human-body','anansi'].includes(asset)&&!input?runtime(asset):path.join(folder,asset+'.glb'), root=await loadCharacter(file),bones=new Map<string,THREE.Bone>(), meshes:THREE.SkinnedMesh[]=[];
 root.traverse((o:any)=>{if(o.isBone)bones.set(o.name,o);if(o.isSkinnedMesh)meshes.push(o)});
 if(asset!=='anansi')assert.deepEqual(root.animations.map((c:any)=>c.name).sort(),[...new Set([...library,...(custom[asset]?.preserve??[])])].sort());
 else {
  const base=await loadCharacter(path.join(folder,'anansi-before-install.glb'));
  assert.deepEqual(root.animations.map((c:any)=>c.name).sort(),[...new Set([...base.animations.map((c:any)=>c.name),...(custom[asset]?.preserve??[])])].sort());
 }
 let maxWeightError=0;
 for(const mesh of meshes){
  const w=mesh.geometry.attributes.skinWeight,j=mesh.geometry.attributes.skinIndex;
  for(let i=0;i<w.count;i++){
   const ws=[w.getX(i),w.getY(i),w.getZ(i),w.getW(i)];assert(ws.every(v=>Number.isFinite(v)&&v>=0));maxWeightError=Math.max(maxWeightError,Math.abs(ws.reduce((a,b)=>a+b,0)-1));
   for(const v of [j.getX(i),j.getY(i),j.getZ(i),j.getW(i)])assert(v>=0&&v<mesh.skeleton.bones.length);
  }
 }assert(maxWeightError<1e-5);
 const mixer=new THREE.AnimationMixer(root);let samples=0;const expected:any[]=[];
 for(const clip of root.animations){
  mixer.stopAllAction();const action=mixer.clipAction(clip).setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play();
  for(const phase of [0,.25,.5,.75,1]){
   mixer.setTime(clip.duration*phase);root.updateMatrixWorld(true);
   for(const b of bones.values())assert(b.matrixWorld.elements.every(Number.isFinite),asset+' '+clip.name);
   const points:number[][]=[];const keep=[0,.5,1].includes(phase)&&['Idle','Run','Attack1','Cast_Shoot','Attack_Tripo_Punch','Cast','Walk'].includes(clip.name);
   for(const mesh of meshes){mesh.skeleton.update();for(let i=0;i<mesh.geometry.attributes.position.count;i++){const v=mesh.getVertexPosition(i,new THREE.Vector3()).applyMatrix4(mesh.matrixWorld);assert(Number.isFinite(v.x+v.y+v.z),asset+' '+clip.name);if(keep)points.push([v.x,v.y,v.z])}}samples++;
   if(keep)expected.push({clip:clip.name,phase,points});
  }
 }mixer.stopAllAction();mixer.uncacheRoot(root);
 let layer:any=null;
 if(asset!=='anansi'){
  const waist=bones.get('CC_Base_Waist')!,hip=bones.get('CC_Base_Hip')!;
  if(asset!=='human-body'){assert.equal(waist.parent?.name,hip.name);assert.equal(bones.get('CC_Base_L_Thigh')!.parent?.name,hip.name);}
  const base=await loadCharacter(file),overlay=await loadCharacter(file),baseBones=new Map<string,THREE.Bone>(),layerBones=new Map<string,THREE.Bone>();
  base.traverse((o:any)=>{if(o.isBone)baseBones.set(o.name,o)});overlay.traverse((o:any)=>{if(o.isBone)layerBones.set(o.name,o)});
  const sys=new AnimationSystem();sys.register('base',base,base.animations,{play:'Run',fade:0,speed:1});sys.register('layer',overlay,overlay.animations,{play:'Run',fade:0,speed:1});sys.setRunning(true);sys.playLayer('layer','Cast_Shoot',{fade:0,loop:false});
  let legError=0,armChange=0;
  const angle=(a:THREE.Quaternion,b:THREE.Quaternion)=>a.clone().normalize().angleTo(b.clone().normalize());
  for(let frame=0;frame<40;frame++){sys.update(1/30);for(const side of ['L','R'])for(const part of ['Thigh','Calf','Foot','ToeBase']){const n='CC_Base_'+side+'_'+part;legError=Math.max(legError,angle(baseBones.get(n)!.quaternion,layerBones.get(n)!.quaternion))}armChange=Math.max(armChange,angle(baseBones.get('CC_Base_R_Upperarm')!.quaternion,layerBones.get('CC_Base_R_Upperarm')!.quaternion))}
  assert(legError<1e-6,asset+': upper body changed legs '+legError);assert(armChange>.01,asset+': no upper action');layer={legRotationErrorRadians:legError,armChangeRadians:armChange};sys.unregister('base');sys.unregister('layer');
 } else {
  const base=await loadCharacter(file),overlay=await loadCharacter(file),baseBones=new Map<string,THREE.Bone>(),layerBones=new Map<string,THREE.Bone>();
  base.traverse((o:any)=>{if(o.isBone)baseBones.set(o.name,o)});overlay.traverse((o:any)=>{if(o.isBone)layerBones.set(o.name,o)});
  const spine=[...baseBones.values()].find(b=>/^(?:mixamorig:?)Spine$/.test(b.name))!;
  assert(spine,'Anansi requires an explicit humanoid torso mask');
  const masked=new Set<string>();spine.traverse(o=>masked.add(o.name));
  const sys=new AnimationSystem();sys.register('base',base,base.animations,{play:'Walk',fade:0,speed:1,upperBody:spine.name});sys.register('layer',overlay,overlay.animations,{play:'Walk',fade:0,speed:1,upperBody:spine.name});sys.setRunning(true);sys.playLayer('layer','Cast',{fade:0,loop:false});
  let legError=0,armChange=0;
  const angle=(a:THREE.Quaternion,b:THREE.Quaternion)=>a.clone().normalize().angleTo(b.clone().normalize());
  for(let frame=0;frame<40;frame++){sys.update(1/30);for(const [name,b] of baseBones){const delta=angle(b.quaternion,layerBones.get(name)!.quaternion);if(!masked.has(name))legError=Math.max(legError,delta);else if(/Arm/.test(name))armChange=Math.max(armChange,delta)}}
  assert(legError<1e-6,'Anansi: torso layer changed creature body '+legError);assert(armChange>.01,'Anansi: no upper action');layer={maskRoot:spine.name,legRotationErrorRadians:legError,armChangeRadians:armChange};sys.unregister('base');sys.unregister('layer');
 }
 if(expected.length)fs.writeFileSync(path.join(folder,asset+'-expected.json'),JSON.stringify(expected));
 const sha256=crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
 if(input&&input.sha256!==sha256)throw Error(asset+': candidate changed since its bake; rebake or record the reviewed Blender export input');
 const report={asset,source:file,inputRuntimeSha256:input?.inputRuntimeSha256??crypto.createHash('sha256').update(fs.readFileSync(runtime(asset))).digest('hex'),sha256,clips:root.animations.length,bones:bones.size,meshes:meshes.length,samples,maxWeightError,layer,status:'verified-playback'};reports.push(report);console.log(asset+': '+samples+' playback samples; '+(layer?'layer passed':'creature clips preserved'));
}
fs.writeFileSync(path.join(folder,'engine-compatibility-report.json'),JSON.stringify({passed:true,reports},null,2));
