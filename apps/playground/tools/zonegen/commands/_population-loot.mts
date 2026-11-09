import fs from 'node:fs';import path from 'node:path';import {z} from 'zod';
export const populationLootSchema=z.object({
 version:z.literal(1),
 creatures:z.record(z.string().min(1),z.array(z.object({
  itemId:z.string().min(1).describe('Item asset id in the project dependency closure.'),
  qty:z.number().int().positive().default(1).describe('Quantity awarded when this independent roll succeeds.'),
  chance:z.number().min(0).max(1).describe('Independent per-kill probability; 1 is guaranteed. Does not change rare spawn chance.'),
 })).min(1)).describe('Specific creature/rare ids take precedence over the base creature id; quest drops are retained.'),
});
export const populationLootFile=(project:string,world:string,zone:string)=>path.join(project,'authoring/zonegen',world,'zones',zone,'loot.json');
export function loadPopulationLoot(file:string):Map<string,string>{if(!fs.existsSync(file))return new Map();const d=populationLootSchema.parse(JSON.parse(fs.readFileSync(file,'utf8')));return new Map(Object.entries(d.creatures).map(([id,rows])=>[id,rows.map(r=>`${r.itemId}:${r.qty}:${r.chance}`).join(',')]));}
export function mergePopulationLoot(authored:string|undefined,quest:string|undefined):string{return [...new Set([...(authored??'').split(','),...(quest??'').split(',')].filter(Boolean))].join(',');}
