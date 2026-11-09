import {after,test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {compileProjectPaint} from '../tools/_paint-compiler.mjs';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'hitreg-paint-compiler-'));
after(()=>{if(path.dirname(path.resolve(root))!==path.resolve(os.tmpdir())||!path.basename(root).startsWith('hitreg-paint-compiler-'))throw Error('Unexpected test scratch path');fs.rmSync(root,{recursive:true,force:true});});
const image=()=>({width:2,height:2,data:new Uint8Array(16).fill(100)});
function moduleFile(name:string,body:string){fs.writeFileSync(path.join(root,name+'.mjs'),'export function compile(image,theme,recipe){'+body+'}');return{module:name+'.mjs',export:'compile'};}

test('applies a theme compiler after import while retaining source and protected pixels',async()=>{
  const compiler=moduleFile('scoped',"if(theme!=='new'||recipe!=='helm')throw Error('wrong context');image.data[4]=25;return{image,mask:new Uint8Array([0,1,0,0]),regions:['crest']};"),input=image();
  input.data=Buffer.from(input.data);
  const out=await compileProjectPaint(input,'new','helm',compiler,root);
  assert.equal(out.image.data[4],25);assert.equal(input.data[4],100);
  assert.deepEqual([...out.image.data.slice(8)],[...input.data.slice(8)]);
});
test('rejects an undeclared paint edit',async()=>{
  const compiler=moduleFile('unscoped',"image.data[0]=0;return{image,mask:new Uint8Array(4)};");
  await assert.rejects(compileProjectPaint(image(),'new','helm',compiler,root),/protected pixel/);
});
test('rejects resized artwork before packing a page',async()=>{
  const compiler=moduleFile('resized',"image.width=3;return{image,mask:new Uint8Array(4)};");
  await assert.rejects(compileProjectPaint(image(),'new','helm',compiler,root),/preserve atlas dimensions/);
});
