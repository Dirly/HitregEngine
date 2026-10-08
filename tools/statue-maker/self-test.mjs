import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {buildStatue, smoothNormals, loadModel, poseModel, validatePedestal, validatePedestalPrefab, T} from './statue.mjs';
import {humanRecipe} from './human.mjs';
import {run} from './run.mjs';
import {GltfBuilder} from '../wfc-3d/gltf.mjs';
const require=createRequire(new URL('../../apps/playground/package.json',import.meta.url));
const {tsImport}=await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
const {ToolRegistry,toolResultSchema}=await tsImport('../../packages/core/src/tools.ts',import.meta.url);
function source(){
 const b=new GltfBuilder('test'); const p=new Float32Array([0,0,0, 1,0,0, 0,2,0, 0,0,0, 0,2,0, 0,0,1]);
 b.pushMesh({primitives:[{attributes:{POSITION:b.pushAccessor(p,'VEC3',{minMax:true})}}]});b.pushNode({mesh:0},true);
 return Buffer.from(JSON.stringify(b.finish()));
}
const recipe=()=>({version:1,name:'test/statue',height:6,materialId:'stone',body:{model:'fixture.gltf'},pose:{kind:'rest'}});
test('pedestal checks real support geometry, height, and overhangs',()=>{
 const tri=(p,group='body')=>({group,p:p.map(v=>new T.Vector3(...v))});
 const base=[tri([[-2,1,-2],[2,1,-2],[2,1,2]]),tri([[-2,1,-2],[2,1,2],[-2,1,2]]),tri([[-2,0,-2],[2,0,-2],[2,0,2]])];
 const sculpture=[tri([[-.5,0,0],[.5,0,0],[0,3,0]])];
 const result=validatePedestal(sculpture,base,1);assert.equal(result.bearings.length,2);assert.equal(result.bearings[0].gap,0);
 assert.throws(()=>validatePedestal(sculpture,base,2),/bounds disagree/);
 assert.throws(()=>validatePedestal([tri([[3,0,0],[3.1,0,0],[3,3,0]])],base,1),/bearing failed/);
});
test('bakes exact static bounds and anchored collision prefab through engine validation',async()=>{
 const out=await buildStatue(recipe(),()=>source());
 assert.equal(out.report.height,6);assert.equal(out.report.triangles,2);assert.equal(out.model.skins,undefined);assert.equal(out.model.animations,undefined);
 assert.equal(out.prefab.entities.anchor.components.mesh,undefined);
 assert.equal(out.prefab.entities.sculpture.components.collider.shape,'trimesh');
 assert.equal(out.prefab.entities.sculpture.components.mesh.material,'stone');
 assert.deepEqual(out.report.bounds,[[0,0,0],[3,6,3]]);
 const repeat=await buildStatue(recipe(),()=>source());assert.deepEqual(out.model,repeat.model);
});
test('pedestal prefab must match its supplied model and use identity transforms',async()=>{
 const out=await buildStatue(recipe(),()=>source()),contract={prefabId:'base',model:'test/statue.gltf'};
 assert.ok(validatePedestalPrefab(out.prefab,contract).prefabSha256.length===64);
 assert.throws(()=>validatePedestalPrefab(out.prefab,{...contract,model:'other.gltf'}),/does not match/);
 const moved=structuredClone(out.prefab);moved.entities.sculpture.components.transform.position=[0,1,0];
 assert.throws(()=>validatePedestalPrefab(moved,contract),/identity/);
});
test('welds normals without changing geometry, preserving source boundaries',()=>{
 const a={group:'body',p:[[0,0,0],[1,0,0],[0,1,0]].map(p=>new T.Vector3(...p))};
 const b={group:'body',p:[[0,0,0],[0,1,0],[0,0,1]].map(p=>new T.Vector3(...p))};
 const before=JSON.stringify([a,b]),n=smoothNormals([a,b]);assert.equal(JSON.stringify([a,b]),before);
 assert.ok(Math.abs(n[0]-Math.SQRT1_2)<1e-6);assert.ok(Math.abs(n[2]-Math.SQRT1_2)<1e-6);
 b.group='sword';const isolated=smoothNormals([a,b]);assert.deepEqual(isolated.slice(0,3),[0,0,1]);
});
test('opposite coincident thin faces never cancel each other during smoothing',()=>{
 const p=[[0,0,0],[1,0,0],[0,1,0]].map(v=>new T.Vector3(...v));
 const normals=smoothNormals([{group:'blade',p},{group:'blade',p:[p[2],p[1],p[0]]}]);
 assert.deepEqual(normals.slice(0,3),[0,0,1]);assert.deepEqual(normals.slice(9,12),[0,0,-1]);
});
test('refuses missing parts, unsafe names, unreachable rigs, and missing clips',async()=>{
 await assert.rejects(buildStatue({...recipe(),name:'../oops'},()=>source()),/Unsafe/);
 await assert.rejects(buildStatue({...recipe(),height:NaN},()=>source()),/positive/);
 await assert.rejects(buildStatue({...recipe(),body:{model:'fixture.gltf',parts:['Missing']}},()=>source()),/parts table/);
 const model=await loadModel(source());assert.throws(()=>poseModel(model,{kind:'clip',clip:'Walk',time:0}),/Unknown animation/);
 assert.throws(()=>poseModel(model,{kind:'sword-rest'}),/explicit bones/);
});
test('freezes an actual skin and clip; output vertices follow posed joint',async()=>{
 const b=new GltfBuilder('animated fixture');
 const attributes={POSITION:b.pushAccessor(new Float32Array([0,0,0,1,0,0,0,1,0]),'VEC3',{minMax:true}),JOINTS_0:b.pushAccessor(new Uint16Array(12),'VEC4'),WEIGHTS_0:b.pushAccessor(new Float32Array([1,0,0,0,1,0,0,0,1,0,0,0]),'VEC4')};
 b.pushMesh({primitives:[{attributes}]}); b.doc.nodes=[{children:[1,2]},{name:'joint'},{mesh:0,skin:0}]; b.doc.scenes[0].nodes=[0];
 b.doc.skins=[{joints:[1]}]; b.doc.animations=[{name:'Rise',channels:[{sampler:0,target:{node:1,path:'translation'}}],samplers:[{input:b.pushAccessor(new Float32Array([0,1]),'SCALAR',{minMax:true}),output:b.pushAccessor(new Float32Array([0,0,0,2,0,0]),'VEC3'),interpolation:'LINEAR'}]}];
 const bytes=Buffer.from(JSON.stringify(b.finish()));
 const out=await buildStatue({...recipe(),height:1,pose:{kind:'clip',clip:'Rise',time:.5}},()=>bytes);
 assert.deepEqual(out.report.bounds,[[1,0,0],[2,1,0]]);assert.equal(out.model.skins,undefined);assert.equal(out.model.animations,undefined);
});
test('freezes morph animation into positions without exporting morph targets',async()=>{
 const b=new GltfBuilder('morph fixture');
 const position=b.pushAccessor(new Float32Array([0,0,0,1,0,0,0,1,0]),'VEC3',{minMax:true});
 const delta=b.pushAccessor(new Float32Array([0,0,2,0,0,2,0,0,2]),'VEC3',{minMax:true});
 b.pushMesh({weights:[0],primitives:[{attributes:{POSITION:position},targets:[{POSITION:delta}]}]});b.pushNode({mesh:0},true);
 b.doc.animations=[{name:'Morph',channels:[{sampler:0,target:{node:0,path:'weights'}}],samplers:[{input:b.pushAccessor(new Float32Array([0,1]),'SCALAR',{minMax:true}),output:b.pushAccessor(new Float32Array([0,1]),'SCALAR'),interpolation:'LINEAR'}]}];
 const bytes=Buffer.from(JSON.stringify(b.finish()));
 const out=await buildStatue({...recipe(),height:1,pose:{kind:'clip',clip:'Morph',time:.5}},()=>bytes);
 assert.deepEqual(out.report.bounds,[[0,0,1],[1,1,1]]);
 assert.equal(out.model.meshes[0].primitives[0].targets,undefined);assert.equal(out.model.animations,undefined);
});
test('human profiles select actual sex geometry and suppress hair beneath hood',()=>{
 const catalog={appearance:[{id:'sex',options:[{id:'male',model:'body',parts:['male']},{id:'female',model:'body',parts:['female']}]},{id:'face',options:[{model:'head',parts:['m'],requires:{sex:['male']}},{model:'head',parts:['f'],requires:{sex:['female']}}]}],mounts:[{model:'head'},{model:'kit/human-hair.glb'},{model:'kit/human-helm.glb'},{model:'kit/human-shoulder.glb',requires:{sex:['female']}}]};
 const out=humanRecipe(catalog,{sex:'female',hood:true,robe:true,shoulders:'simple'});
 assert.ok(out.body.parts.includes('F_RobesFront'));assert.ok(out.body.parts.includes('female'));assert.equal(out.attachments.length,3);
 assert.ok(out.attachments.every(a=>!a.model.includes('hair')));assert.deepEqual(out.attachments[2].parts,['ShoulderBase1']);
 assert.throws(()=>humanRecipe(catalog,{shoulders:'ornate'}),/shoulders/);
});
test('registered tool validates manifest/result and refuses overwrite before any writes',async t=>{
 const registry=new ToolRegistry(); registry.register(JSON.parse(fs.readFileSync(new URL('./tool.json',import.meta.url))));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'statue-tool-test-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const input={bundle:{name:'statue.json',mediaType:'application/json',data:Buffer.from(JSON.stringify({recipe:recipe(),models:{'fixture.gltf':source().toString('base64')}})).toString('base64')}};
 const written=[];
 const ctx={runDir:dir,assetExists:file=>file==='materials/stone.json',writeAsset:(file)=>{written.push(file);return file;}};
 const out=await run(ctx,input);toolResultSchema.parse(out);assert.equal(written.length,2);
 written.length=0;await assert.rejects(run({...ctx,assetExists:()=>true},input),/Output exists/);assert.equal(written.length,0);
});
