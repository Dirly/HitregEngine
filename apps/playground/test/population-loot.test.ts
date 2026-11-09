import {test} from 'node:test';import assert from 'node:assert/strict';
import {populationLootSchema,mergePopulationLoot} from '../tools/zonegen/commands/_population-loot.mts';
test('authored rare rolls preserve independent probabilities and quest drops',()=>{
 const d=populationLootSchema.parse({version:1,creatures:{garnetback:[{itemId:'elytron',chance:.35}]}});
 assert.equal(d.creatures.garnetback![0]!.qty,1);
 assert.equal(mergePopulationLoot('elytron:1:0.35','quest-shell:1:0.6'),'elytron:1:0.35,quest-shell:1:0.6');
 assert.equal(mergePopulationLoot(undefined,'quest-shell:1:0.6'),'quest-shell:1:0.6');
 assert.throws(()=>populationLootSchema.parse({version:1,creatures:{bad:[{itemId:'x',chance:2}]}}));
});
