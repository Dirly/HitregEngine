import {test} from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {propReuseSchema,readReusePolicy,reuseFaults,assertDesignReuse} from '../tools/_prop-reuse.mts';
import {runJob} from '../tools/prop-codex/run.mts';
const policy=propReuseSchema.parse({version:1,families:[{name:'books',words:['book','books','grimoire'],prefabs:['props/book'],note:'Reuse the cover mesh.'},{name:'skulls',words:['skull','skulls'],prefabs:['props/skull'],note:'Use the owner model.'}]});
const json=(f:string,d:unknown)=>{fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(d));};
function fixture(){const d=fs.mkdtempSync(path.join(os.tmpdir(),'hitreg-reuse-test-'));json(path.join(d,'authoring/prop-reuse.json'),policy);for(const id of ['book','skull'])json(path.join(d,`assets/prefabs/props/${id}.json`),{});return d;}
function clean(d:string){assert.equal(path.dirname(path.resolve(d)),path.resolve(os.tmpdir()));assert.ok(path.basename(d).startsWith('hitreg-reuse-test-'));fs.rmSync(d,{recursive:true,force:true});}
test('reuse catches components inside new props and renamed requests without treating bookshelves as books',()=>{
 assert.equal(reuseFaults({name:'crypt-altar',parts:[{part:'hero skull crest'},{part:'bound grimoire'}]},policy).length,2);
 assert.equal(reuseFaults({name:'bookcase',parts:[{part:'bookshelf side board'}]},policy).length,0);
 assert.equal(reuseFaults({name:'unrelated-name skull'},policy).length,1);
});
test('protected request stops before generation or staging writes',async()=>{
 const d=fixture();try{let calls=0;const r=await runJob({id:'crypt/new-object',name:'skull',culture:'crypt',scale:'human',for:'altar',why:'reuse',status:'open',project:'test'} as any,{name:'unrelated-name',scale:{id:'human',height:1.8},scales:[],worldKit:d,jobRoot:path.join(d,'jobs'),runner:async()=>{calls++;throw Error('must not generate');}});assert.equal(r.status,'fail');assert.equal(r.attempts,0);assert.equal(calls,0);assert.equal(fs.existsSync(path.join(d,'jobs')),false);assert.match(r.gate,/props\/skull/);}finally{clean(d);}
});
test('install preflight permits unchanged legacy rebuild, blocks changed geometry and source, and rejects missing preferred parts',()=>{
 const d=fixture();try{const design=path.join(d,'legacy.py');fs.writeFileSync(design,'legacy design');const rec={name:'crypt-altar',parts:[{part:'skull'}]};assert.throws(()=>assertDesignReuse(d,design,rec),/Reuse skulls/);
 json(path.join(d,'authoring/codex-craft/catalog.json'),{props:[{id:'codex-craft/crypt-altar',sourceSha256:crypto.createHash('sha256').update('legacy design').digest('hex'),parts:rec.parts}]});json(path.join(d,'assets/prefabs/codex-craft/crypt-altar.json'),{});
 assert.doesNotThrow(()=>assertDesignReuse(d,design,rec));assert.throws(()=>assertDesignReuse(d,design,{...rec,parts:[{part:'two skulls'}]}),/Reuse skulls/);
 fs.appendFileSync(design,' changed');assert.throws(()=>assertDesignReuse(d,design,rec),/Reuse skulls/);
 fs.rmSync(path.join(d,'assets/prefabs/props/skull.json'));assert.throws(()=>readReusePolicy(d),/source missing/);
 assert.throws(()=>propReuseSchema.parse({version:1,families:[{...policy.families[0],prefabs:['../escape']}]}));
 }finally{clean(d);}
});
