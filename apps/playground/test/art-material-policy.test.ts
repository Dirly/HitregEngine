import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildWall,wallMaterials,compileLandmarkSpec} from '@hitreg/core';
import {architecturalBindings,artFaults,artThresholdsSchema,varietyDiagnostics,type ArtMaterial,type ArtInput} from '../tools/_art-check.mts';
const material=(id:string,picture=id,area=100):ArtMaterial=>({id,area,texels:40,projected:false,natural:false,lstar:35,colours:64,px:[128,128],course:null,map:picture+'.png',mapHash:picture});
const input=(materials:ArtMaterial[],slots:Record<string,string>,used=Object.keys(slots)):ArtInput=>({tier:'large',culture:'human',groundL:34,terrain:{p:{texels:32,steep:null,lstar:34}},props:{p:40},pieces:[{id:'p',kind:'landmark',at:[0,0],materials,architecture:architecturalBindings(slots,used)}],openings:[],dungeon:null,portals:[],doors:[],forms:{}});

test('default policy accepts one continuous wall and puts large repeat counts in diagnostics',()=>{
 const inp=input([material('wall','wall',15000)],{face:'wall'}),t=artThresholdsSchema.parse({});
 assert.equal(t.variety.mode,'architecture');assert.deepEqual(artFaults(inp),[]);
 assert.deepEqual(varietyDiagnostics(inp,t).map(f=>f.what),['distinct materials','wall']);
 assert.equal(artFaults(inp,artThresholdsSchema.parse({variety:{mode:'counts'}})).length,2);
});

test('wall, supports and trim follow their purpose; supports and trim may share dressed stone',()=>{
 const inp=input([material('wall','wall',15000),material('support','dressed'),material('trim','dressed')],{face:'wall',column:'support',cap:'trim'});
 assert.deepEqual(artFaults(inp),[]);
 // A differently named/copied picture cannot pretend to be a distinct stone for the columns.
 inp.pieces[0]!.materials[1]={...material('support','wall'),map:'copied-wall.png'};
 const faults=artFaults(inp);assert.deepEqual(faults.map(f=>f.what),['architectural contrast']);assert.match(faults[0]!.detail,/wall .*support/);
});

test('extra materials across one wall fail instead of satisfying variety; explicit authored patterns can opt in',()=>{
 const inp=input([material('a'),material('b'),material('c')],{face:'a','face~2':'b','face~3':'c'});
 assert.deepEqual(artFaults(inp).map(f=>f.what),['material cycling']);
 assert.deepEqual(artFaults(inp,artThresholdsSchema.parse({variety:{allowPatterns:true}})),[]);
});

test('tiers of the same bridge pier stay coherent while independent piers may use separate stone',()=>{
 const good=input([material('a'),material('b')],{'pier-low-1':'a','pier-mid-1':'a','pier-top-1':'a','pier-low-2':'b'});
 assert.deepEqual(artFaults(good),[]);
 const bad=input([material('a'),material('b')],{'pier-low-1':'a','pier-mid-1':'b'});
 assert.deepEqual(artFaults(bad).map(f=>f.what),['material cycling']);assert.match(artFaults(bad)[0]!.detail,/pier-1/);
});

test('actual wall generator roles include fallback supports and ignore unused slots',()=>{
 const materials={face:'wall',cap:'trim',footing:'trim',roof:'unused-support'};
 const reader={height:()=>0,density:(_x:number,y:number)=>y,voxelSize:2,seaLevel:0,seed:1};
 const built=buildWall({points:[[0,0],[30,0]],height:8,buttresses:{every:8},materials},reader,{id:'policy-wall'});
 const used=compileLandmarkSpec(built.spec,{voxel:.5,skipThin:true}).roles;
 const assignments=architecturalBindings(wallMaterials({materials}),used);
 assert.ok(assignments.some(a=>a.purpose==='support'&&a.material==='wall'));assert.ok(!assignments.some(a=>a.sourceRole==='roof'));
 const inp=input([material('wall'),material('trim'),material('unused-support')],{});inp.pieces[0]!.architecture=assignments;
 assert.deepEqual(artFaults(inp).map(f=>f.what),['architectural contrast']);
});

test('buried roles do not require visible contrast; stale source assignments fail and colour/texel gates remain',()=>{
 const missing=input([material('wall')],{face:'wall',footing:'trimmed-under-ground'});assert.deepEqual(artFaults(missing),[]);
 missing.pieces[0]!.architectureBakeMatchesSource=false;assert.deepEqual(artFaults(missing).map(f=>f.what),['stale architectural bake']);
 const bad=input([{...material('wall'),texels:80,colours:10}],{face:'wall'});
 assert.ok(artFaults(bad).some(f=>f.rule==='texel'));assert.ok(artFaults(bad).some(f=>f.rule==='variety'&&f.detail.includes('colours')));
});
