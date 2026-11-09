import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error CLI helper is plain JavaScript.
import {writeUber,readUber,embeddedPage,appendNativeParts} from '../tools/_uber-native-parts.mjs';
// @ts-expect-error PNG utility is plain JavaScript.
import {encodePng} from '../tools/_png.mjs';

function fixture(part:string,pageSize=16){
 const data=new Uint8Array(pageSize*pageSize*4);for(let i=0;i<data.length;i+=4)data.set([32+(i%127),60,90,255],i);
 const node={mesh:0,extras:{parts:{[part]:0},tiles:{base:[1/pageSize,1/pageSize,8/pageSize]},pageGutter:1,rules:{requires:{Trim:['Base']}}}};
 const primitive={attributes:{},material:0};
 return writeUber({node,primitive,json:{asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[node],meshes:[{primitives:[primitive]}],materials:[{pbrMetallicRoughness:{baseColorTexture:{index:0}}}],textures:[{source:0}],images:[{}]},attributes:{POSITION:[[0,0,0],[1,0,0],[0,1,0]],NORMAL:[[0,0,1],[0,0,1],[0,0,1]],TEXCOORD_0:[[0,0],[1,0],[0,1]],TEXCOORD_1:[[0,0],[0,0],[0,0]]}},{width:pageSize,height:pageSize,data});
}

test('native parts retain existing geometry/tile/pixels, native UVs and stable bits on regeneration',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hitreg-native-parts-'));
 try{
  fs.mkdirSync(path.join(tmp,'models'));fs.mkdirSync(path.join(tmp,'textures'));
  fs.writeFileSync(path.join(tmp,'models/head.glb'),fixture('Face'));
  const rgba=new Uint8Array(4*4*4);for(let i=0;i<rgba.length;i+=4)rgba.set([170,90,20,255],i);
  fs.writeFileSync(path.join(tmp,'textures/mask.png'),encodePng(4,4,rgba));
  const base=fixture('Base'),old=readUber(base),extension={id:'native',gutter:1,parts:[{sourceModel:'head.glb',from:'Face',name:'Mask',normalOffset:.125}],textures:['mask.png'],rules:{requires:{Trim:['Mask']},hides:{Mask:['Beard']}}};
  const first=appendNativeParts(base,extension,tmp),d=readUber(first.bytes);
  assert.equal(d.node.extras.parts.Base,0);assert.equal(d.node.extras.parts.Mask,1);
  assert.deepEqual(d.node.extras.tiles.base,old.node.extras.tiles.base);
  for(const name of Object.keys(old.attributes))assert.deepEqual(d.attributes[name].slice(0,3),old.attributes[name]);
  assert.deepEqual(d.attributes.TEXCOORD_0.slice(3),[[0,0],[1,0],[0,1]]);
  assert.deepEqual(d.attributes.POSITION.slice(3),[[0,0,.125],[1,0,.125],[0,1,.125]]);
  assert.deepEqual(d.node.extras.rules.requires.Trim,['Base','Mask']);
  const originalPage=embeddedPage(old),page=embeddedPage(d);
  for(let y=0;y<10;y++)for(let x=0;x<10;x++){const i=(y*16+x)*4;assert.deepEqual(page.data.slice(i,i+4),originalPage.data.slice(i,i+4));}
  const second=readUber(appendNativeParts(first.bytes,extension,tmp).bytes);
  assert.deepEqual(second.attributes,d.attributes);assert.deepEqual(second.node.extras.parts,d.node.extras.parts);assert.deepEqual(second.node.extras.tiles,d.node.extras.tiles);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('repacking only selected native IDs retains existing native cap rectangles and pixels',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hitreg-native-subset-'));
 try{fs.mkdirSync(path.join(tmp,'textures'));const png=(name:string,S:number,value:number)=>fs.writeFileSync(path.join(tmp,'textures',name),encodePng(S,S,new Uint8Array(S*S*4).fill(value)));png('mask.png',12,90);png('cap.png',4,120);
  const textures=['mask.png','cap.png'],first=appendNativeParts(fixture('Base',64),{id:'subset',gutter:1,parts:[],textures},tmp),old=readUber(first.bytes),before=embeddedPage(old);png('mask.png',6,80);
  const policy={id:'subset',gutter:1,parts:[],textures,repackTextures:true,repackTextureIds:['mask.png'],pageGrowthFactors:[1]},next=readUber(appendNativeParts(first.bytes,policy,tmp).bytes),after=embeddedPage(next);
  assert.deepEqual(next.node.extras.tiles.base,old.node.extras.tiles.base);assert.deepEqual(next.node.extras.tiles['cap.png'],old.node.extras.tiles['cap.png']);const[u,v,s]=old.node.extras.tiles['cap.png'],x0=Math.round(u*64),y0=Math.round(v*64),size=Math.round(s*64);for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=((y0+y)*64+x0+x)*4;assert.deepEqual(after.data.slice(i,i+4),before.data.slice(i,i+4));}assert.equal(after.width,before.width);assert.throws(()=>appendNativeParts(first.bytes,{...policy,repackTextureIds:['base']},tmp),/Only declared native textures/);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('geometry-only source override replaces an existing low bit and preserves every unrelated attribute/page pixel',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hitreg-part-override-'));
 try{
  fs.mkdirSync(path.join(tmp,'models'));const source=fixture('Replacement'),src=readUber(source);
  for(const [key,values] of Object.entries(src.attributes) as any)src.attributes[key]=[...values,...values.map((v:number[])=>key==='POSITION'?v.map((n,c)=>n+(c===2?1:0)):v.slice())];
  fs.writeFileSync(path.join(tmp,'models/source.glb'),writeUber(src,embeddedPage(src)));
  const other=readUber(fixture('Base'));other.node.extras.parts.Other=1;for(const [key,values]of Object.entries(other.attributes)as any)other.attributes[key]=[...values,...values.map((v:number[])=>key==='TEXCOORD_1'?[1,0]:v.slice())];const oldPage=embeddedPage(other),base=writeUber(other,oldPage),d=readUber(appendNativeParts(base,{id:'fit',parts:[{sourceModel:'source.glb',from:'Replacement',name:'Base'}],textures:[]},tmp).bytes);
  assert.deepEqual(d.node.extras.parts,{Other:1,Base:0});assert.deepEqual(d.node.extras.tiles,other.node.extras.tiles);assert.deepEqual(d.node.extras.rules,other.node.extras.rules);assert.deepEqual(embeddedPage(d).data,oldPage.data);
  for(const key of Object.keys(other.attributes))assert.deepEqual(d.attributes[key].slice(0,3),other.attributes[key].slice(3));assert.deepEqual(d.attributes.POSITION.slice(3),src.attributes.POSITION);assert.deepEqual(d.attributes.TEXCOORD_1.slice(3),Array.from({length:6},()=>[0,0]));
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});

test('explicit native resize aliases identical RGBA and grows pages with exact old normalized tiles/logical pixels',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'hitreg-native-grow-'));
 try{
  fs.mkdirSync(path.join(tmp,'textures'));const save=(S:number)=>{const data=new Uint8Array(S*S*4).fill(91);for(const id of['mask.png','female.png'])fs.writeFileSync(path.join(tmp,'textures',id),encodePng(S,S,data));};save(2);
  const textures=['mask.png',{id:'female.png',aliasOf:'mask.png'}],first=appendNativeParts(fixture('Base'),{id:'grow',gutter:1,parts:[],textures},tmp),old=readUber(first.bytes),oldPage=embeddedPage(old);save(12);
  const policy={id:'grow',gutter:1,parts:[],textures,repackTextures:true,pageGrowthFactors:[1,2,4],maxPageSize:64},grown=appendNativeParts(first.bytes,policy,tmp),d=readUber(grown.bytes),page=embeddedPage(d);
  assert.equal(page.width,64);assert.equal(grown.report.pageGrowthInteger,4);assert.deepEqual(d.node.extras.tiles.base,old.node.extras.tiles.base);assert.deepEqual(d.node.extras.tiles['mask.png'],d.node.extras.tiles['female.png']);assert.equal(grown.report.placed.filter((p:any)=>!p.aliasOf).length,1);
  for(let y=0;y<40;y++)for(let x=0;x<40;x++){const i=(y*64+x)*4,j=(Math.floor(y/4)*16+Math.floor(x/4))*4;assert.deepEqual(page.data.slice(i,i+4),oldPage.data.slice(j,j+4));}
  assert.deepEqual(d.attributes,old.attributes);const again=readUber(appendNativeParts(grown.bytes,policy,tmp).bytes);assert.deepEqual(again.node.extras.tiles,d.node.extras.tiles);assert.deepEqual(embeddedPage(again).data,page.data);
  fs.writeFileSync(path.join(tmp,'textures/female.png'),encodePng(12,12,new Uint8Array(12*12*4).fill(92)));assert.throws(()=>appendNativeParts(grown.bytes,policy,tmp),/must exactly match/);
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
});
