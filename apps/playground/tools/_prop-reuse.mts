/** Preferred existing parts for prop authoring. This guards generation, not placement policy. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {z} from 'zod';

const id=z.string().regex(/^[a-z0-9_-]+(?:\/[a-z0-9_-]+)+$/i);
export const propReuseSchema=z.object({
  version:z.literal(1),
  families:z.array(z.object({
    name:z.string().min(1),
    words:z.array(z.string().regex(/^[a-z0-9]+(?: [a-z0-9]+)*$/)).min(1),
    prefabs:z.array(id).min(1),
    note:z.string().min(1),
  }).strict()).superRefine((rows,ctx)=>{
    if(new Set(rows.map(r=>r.name)).size!==rows.length)ctx.addIssue({code:'custom',message:'Reuse family names must be unique'});
  }),
}).strict();
export type ReusePolicy=z.infer<typeof propReuseSchema>;
export function readReusePolicy(worldKit:string):ReusePolicy {
  const file=path.join(worldKit,'authoring/prop-reuse.json');
  const policy=fs.existsSync(file)?propReuseSchema.parse(JSON.parse(fs.readFileSync(file,'utf8'))):{version:1 as const,families:[]};
  // A missing preferred source is a repair request, never permission to invent a replacement.
  for(const family of policy.families)for(const prefab of family.prefabs)
    if(!fs.existsSync(path.join(worldKit,'assets/prefabs',prefab+'.json')))throw Error(`Preferred ${family.name} source missing: ${prefab}`);
  return policy;
}
const words=(text:string)=>' '+text.toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()+' ';
export function reuseFaults(record:{name:string;parts?:{part:string}[]},policy:ReusePolicy):string[] {
  // Inspect named geometry parts too: an altar must not hide a freshly modelled skull or candle.
  const subjects=[record.name,...(record.parts??[]).map(p=>p.part)].map(words);
  return policy.families.filter(f=>f.words.some(w=>subjects.some(s=>s.includes(' '+w+' '))))
    .map(f=>`Reuse ${f.name}: ${f.prefabs.join(', ')}. ${f.note} Compose existing prefabs; do not regenerate these parts or rename them to bypass reuse.`);
}
export function reuseBrief(policy:ReusePolicy):string {
  return policy.families.map(f=>`- ${f.name}: ${f.prefabs.join(', ')}. ${f.note}`).join('\n');
}
/** Rebuilding unchanged installed legacy content is allowed; new/edited designs are checked. */
export function assertDesignReuse(worldKit:string,design:string,record:{name:string;parts?:{part:string}[]},policy=readReusePolicy(worldKit)):void {
  const file=path.join(worldKit,'authoring/codex-craft/catalog.json');
  const row=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')).props?.find((r:any)=>r.id==='codex-craft/'+record.name):undefined;
  const current=crypto.createHash('sha256').update(fs.readFileSync(design)).digest('hex');
  if(row?.sourceSha256===current&&JSON.stringify(row.parts)===JSON.stringify(record.parts)&&fs.existsSync(path.join(worldKit,'assets/prefabs',row.id+'.json')))return;
  const faults=reuseFaults(record,policy);
  if(faults.length)throw Error(`${record.name}: ${faults.join('\n')}`);
}
