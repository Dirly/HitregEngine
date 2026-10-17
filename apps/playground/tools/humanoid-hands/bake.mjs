/** Reuse the installed humanoid library, then apply the target's measured grip. */
import {loadCharacter} from '../_load-character.mjs';
import * as THREE from 'three';
import {GLTFExporter} from 'three/examples/jsm/exporters/GLTFExporter.js';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {captureMotion,restoreMotion} from './custom-motion.mjs';
const here=path.dirname(fileURLToPath(import.meta.url)), app=path.resolve(here,'../..');
const profileDir=path.join(app,'projects/foundation/authoring/humanoid-hands-v1');
const sourceFile=path.join(app,'projects/foundation/assets/models/mmo/human-body.glb');
const source=await loadCharacter(sourceFile), sourceBones=new Map();
source.traverse(o=>{if(o.isBone)sourceBones.set(o.name,o)});
const arg=process.argv[2]??'all';
const family=n=>[n,...['pads','armored','armored-pads'].map(s=>n+'-'+s)];
const known=['ogre','ratkin',...['crockin','frogkin'].flatMap(family)];
const runtimeFile=asset=>path.join(app,'projects/foundation/assets/models/mmo/mobs',asset+'.glb');
const hash=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const allowed=known.filter(n=>fs.existsSync(runtimeFile(n)));
const assets=arg==='all'?allowed:[...new Set(arg.split(',').flatMap(n=>['crockin','frogkin'].includes(n)?family(n).filter(a=>allowed.includes(a)):[n]))];
for(const asset of assets)if(!allowed.includes(asset))throw Error('Unknown humanoid appearance: '+asset);
for(const asset of assets){
 const saved=await captureMotion(path.join(app,'projects/foundation'),asset);
 // Registered motion belongs to the CURRENT installed skin, including new
 // ubermesh part metadata and cloth joints. An old appearance archive is not
 // a valid replacement for that skin.
 const installed=runtimeFile(asset),inputRuntimeSha256=hash(installed);
 const rig=installed,out=path.join(profileDir,asset+'.glb');
 const result=spawnSync(process.execPath,[path.join(here,'../retarget.mjs'),'--mesh',rig,'--anim',sourceFile,'--clips','all','--height','none','--out',out],{encoding:'utf8',maxBuffer:16e6});
 fs.writeFileSync(path.join(profileDir,asset+'-retarget.log'),result.stdout+result.stderr);
 if(result.status!==0)throw Error(asset+': retarget failed; see log');
 const target=await loadCharacter(out), bones=new Map();target.traverse(o=>{if(o.isBone)bones.set(o.name,o)});
 const profiles=JSON.parse(fs.readFileSync(path.join(profileDir,asset.split('-')[0]+'-hands.json'))).profiles;
 const corrected=[];
 for(const clip of target.animations){
  const original=source.animations.find(c=>c.name===clip.name);
  for(const side of ['L','R']){
   const prefix='CC_Base_'+side+'_',ref=[1,2,3].map(i=>original.tracks.find(t=>t.name===prefix+'Index'+i+'.quaternion'));
   if(ref.some(t=>!t))continue;
   const samplers=ref.map(t=>t.createInterpolant());
   // A shared grip amount keeps the broad block coherent. Source rotations
   // remain the performance input; target geometry determines its bend axes.
   const gripAt=time=>{
    const override=profiles[side].clip_grips?.[clip.name];
    if(typeof override==='number')return Math.max(0,Math.min(1,override));
    if(['Attack1','Attack2','Punch_Hook','Punch_Hook_Rec'].includes(clip.name))return 1;
    let sum=0;
    for(let i=0;i<3;i++){
     const q=new THREE.Quaternion().fromArray(samplers[i].evaluate(time));
     const delta=sourceBones.get(prefix+'Index'+(i+1)).quaternion.clone().invert().multiply(q);
     sum+=Math.min(1,delta.angleTo(new THREE.Quaternion())/THREE.MathUtils.degToRad([62,76,58][i]));
    }return sum/3;
   };
   for(const digit of ['Index','Thumb'])for(let i=1;i<=3;i++){
    const bone=bones.get(prefix+digit+i);if(!bone)continue;
    const track=clip.tracks.find(t=>t.name===bone.name+'.quaternion');if(!track)continue;
    const values=[];
    for(const time of track.times){
     const grip=gripAt(time),angles=digit==='Index'?(profiles[side].fist_degrees??[80,95,70]):(profiles[side].thumb_degrees??[45,15,10]);
     const x=THREE.MathUtils.degToRad(angles[i-1])*grip,z=digit==='Thumb'&&i===1?THREE.MathUtils.degToRad(profiles[side].thumb_opposition_degrees??40)*profiles[side].thumb_sign*grip:0;
     const q=bone.quaternion.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(x,0,z,'XYZ'))).normalize();values.push(q.x,q.y,q.z,q.w);
    }
    track.values=new Float32Array(values);corrected.push(track.name);
   }
  }
 }
 const preserved=restoreMotion(target,saved,asset);
 const glb=await new GLTFExporter().parseAsync(target,{binary:true,animations:target.animations,onlyVisible:false});fs.writeFileSync(out,Buffer.from(glb));
 fs.writeFileSync(path.join(profileDir,asset+'-bake-input.json'),JSON.stringify({inputRuntimeSha256,sha256:hash(out),rigSource:rig,preserved},null,2)+'\n');
 if(preserved.length)console.log(`${asset}: preserved production motion ${preserved.join(', ')}`);
 console.log(`${asset}: ${target.animations.length} clips; calibrated ${corrected.length} hand tracks`);
}
