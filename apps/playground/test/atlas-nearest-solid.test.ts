import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {encodePng,decodePng} from '../tools/_png.mjs';

test('native alpha imports transparent ground and enclosed helmet openings',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hitreg-atlas-alpha-')),root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
 try{
  const W=64,key=new Uint8Array(W*W*4).fill(255),art=new Uint8Array(W*W*4);
  for(let y=8;y<56;y++)for(let x=8;x<56;x++){const i=(y*W+x)*4;key.set([255,0,0,255],i);if(!(x>=24&&x<40&&y>=24&&y<40))art.set([100,75,40,255],i);}
  fs.writeFileSync(path.join(dir,'key.png'),encodePng(W,W,key));fs.writeFileSync(path.join(dir,'art.png'),encodePng(W,W,art));
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({size:32,bleed:2,filter:'nearest',fitSearch:0,slots:{'#ff0000':{name:'helm',transparency:true,cut:true}}}));
  const out=path.join(dir,'out'),p=spawnSync(process.execPath,[path.join(root,'tools/atlas/import-atlas.mjs'),'--key',path.join(dir,'key.png'),'--art',path.join(dir,'art.png'),'--manifest',path.join(dir,'manifest.json'),'--out',out,'--no-match'],{encoding:'utf8'});
  assert.equal(p.status,0,p.stdout+p.stderr);const image=decodePng(fs.readFileSync(path.join(out,'atlas.png')));
  assert.equal(image.data[(16*32+16)*4+3],0,'enclosed native alpha must not become a black face disc');assert.equal(image.data[(8*32+8)*4+3],255,'painted shell remains solid');
 }finally{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});}
});

test('nearest atlas reduction keeps explicitly solid transparency-capable islands opaque and preserves real cutouts',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hitreg-atlas-solid-'));
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
 try{
  const W=96,S=20,key=new Uint8Array(W*W*4).fill(255),art=new Uint8Array(W*W*4).fill(255);
  for(let y=4;y<88;y++)for(let x=4;x<92;x++){
   const solid=x<44,cut=x>=56;if(!solid&&!cut)continue;
   // One centre sample misses the solid source key, although its target footprint
   // is overwhelmingly owned by the solid island (the actual body UV-edge bug).
   if(solid&&x>=21&&x<=22&&y>=21&&y<=22)continue;
   const i=(y*W+x)*4;key.set(solid?[255,0,0,255]:[0,0,255,255],i);
   art.set(cut&&x>=66&&x<82&&y>=30&&y<62?[0,255,255,255]:[65,75,95,255],i);
  }
  fs.writeFileSync(path.join(dir,'key.png'),encodePng(W,W,key));fs.writeFileSync(path.join(dir,'art.png'),encodePng(W,W,art));
  const run=(solidGround:boolean)=>{
   const manifest={size:S,bleed:2,filter:'nearest',keyColor:'#00ffff',solidGround,fitSearch:0,slots:{'#ff0000':{name:'body',transparency:true,cut:false},'#0000ff':{name:'ornament',transparency:true,cut:true}}};
   fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify(manifest));
   const out=path.join(dir,solidGround?'solid':'unfilled');
   const p=spawnSync(process.execPath,[path.join(root,'tools/atlas/import-atlas.mjs'),'--key',path.join(dir,'key.png'),'--art',path.join(dir,'art.png'),'--manifest',path.join(dir,'manifest.json'),'--out',out],{encoding:'utf8'});
   assert.equal(p.status,0,p.stdout+p.stderr);return decodePng(fs.readFileSync(path.join(out,'atlas.png')));
  };
  const unfilled=run(false),solid=run(true),edge=(4*S+4)*4+3;
  assert.equal(unfilled.data[edge],0,'fixture must reproduce a majority-owned texel whose nearest alpha seed is outside the key');
  assert.equal(solid.data[edge],255,'cut:false must remain solid after nearest reduction');
  assert.equal(solid.data[(9*S+15)*4+3],0,'a genuinely cuttable ornament must retain its authored hole');
 }finally{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});}
});

test('nearest atlas sampling phase retains a thin authored feature without changing zero-phase output',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hitreg-atlas-phase-'));
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
 try{
  const W=96,S=16,key=new Uint8Array(W*W*4).fill(255),art=new Uint8Array(W*W*4).fill(255);
  for(let y=8;y<88;y++)for(let x=8;x<88;x++){
   const o=(y*W+x)*4;key.set([255,0,0,255],o);
   art.set((y===42||y===43)&&x>=24&&x<72?[15,17,19,255]:[150,90,35,255],o);
  }
  fs.writeFileSync(path.join(dir,'key.png'),encodePng(W,W,key));fs.writeFileSync(path.join(dir,'art.png'),encodePng(W,W,art));
  fs.writeFileSync(path.join(dir,'manifest.json'),JSON.stringify({size:S,bleed:1,filter:'nearest',solidGround:true,fitSearch:0,slots:{'#ff0000':{name:'face',transparency:false,cut:false}}}));
  const run=(name:string,flags:string[]=[])=>{
   const out=path.join(dir,name),p=spawnSync(process.execPath,[path.join(root,'tools/atlas/import-atlas.mjs'),'--key',path.join(dir,'key.png'),'--art',path.join(dir,'art.png'),'--manifest',path.join(dir,'manifest.json'),'--out',out,'--no-match',...flags],{encoding:'utf8'});
   return{p,out};
  };
  const baseline=run('default'),zero=run('zero',['--sample-phase-x','0','--sample-phase-y','0']),shifted=run('shifted',['--sample-phase-y','0.5']);
  for(const r of[baseline,zero,shifted])assert.equal(r.p.status,0,r.p.stdout+r.p.stderr);
  assert.deepEqual(fs.readFileSync(path.join(baseline.out,'atlas.png')),fs.readFileSync(path.join(zero.out,'atlas.png')),'explicit zero must preserve every default output byte');
  const a=decodePng(fs.readFileSync(path.join(baseline.out,'atlas.png'))),b=decodePng(fs.readFileSync(path.join(shifted.out,'atlas.png'))),o=(6*S+6)*4;
  assert.ok(a.data[o]!>100,'centre sampling must miss the thin dark stripe in this fixture');
  assert.ok(b.data[o]!<40&&b.data[o+1]!<40&&b.data[o+2]!<40,'uniform half-texel phase must retain the real dark source stripe');
  assert.equal(b.data[o+3],255,'sampling phase must preserve solid island ownership');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(shifted.out,'report.json'),'utf8')).output.samplePhaseTexels,[0,.5]);
  const invalid=run('invalid',['--sample-phase-y','0.6']);assert.notEqual(invalid.p.status,0);assert.match(invalid.p.stderr,/finite target-texel offsets/);
  const box=run('box',['--filter','box','--sample-phase-y','0.5']);assert.notEqual(box.p.status,0);assert.match(box.p.stderr,/requires nearest filtering/);
 }finally{assert.ok(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(dir,{recursive:true,force:true});}
});
