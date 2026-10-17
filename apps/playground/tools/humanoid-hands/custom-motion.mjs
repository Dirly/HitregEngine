/** Project-owned motion takes precedence over a shared-library rebake. */
import fs from 'node:fs';
import path from 'node:path';
import {loadCharacter} from '../_load-character.mjs';

export function motionRegistry(project) {
 const file=path.join(project,'authoring/character-motion-manifest.json');
 return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).actors:{};
}

export async function captureMotion(project,asset) {
 const entry=motionRegistry(project)[asset];
 if(!entry?.preserve?.length)return null;
 const root=await loadCharacter(path.join(project,'assets/models/mmo/mobs',asset+'.glb'));
 const bones=new Map();root.traverse(o=>{if(o.isBone)bones.set(o.name,o)});
 const clips=entry.preserve.map(name=>{
  const clip=root.animations.find(c=>c.name===name);
  if(!clip)throw Error(`${asset}: registered production clip ${name} is missing; restore it before rebaking`);
  return clip.clone();
 });
 return {clips,bones};
}

export function restoreMotion(target,saved,asset) {
 if(!saved)return [];
 const bones=new Map();target.traverse(o=>{if(o.isBone)bones.set(o.name,o)});
 for(const clip of saved.clips)for(const track of clip.tracks){
  const name=track.name.slice(0,track.name.lastIndexOf('.')),a=saved.bones.get(name),b=bones.get(name);
  if(!a||!b)throw Error(`${asset}: custom motion references missing bone ${name}`);
  const qa=a.quaternion.clone().normalize(),qb=b.quaternion.clone().normalize();
  if((a.parent?.isBone?a.parent.name:null)!==(b.parent?.isBone?b.parent.name:null)||a.position.distanceTo(b.position)>1e-5||a.scale.distanceTo(b.scale)>1e-5||qa.angleTo(qb)>1e-5)
   throw Error(`${asset}: bind changed at ${name}; revalidate production motion before rebaking`);
 }
 const names=new Set(saved.clips.map(c=>c.name));
 target.animations=[...target.animations.filter(c=>!names.has(c.name)),...saved.clips];
 return [...names];
}
