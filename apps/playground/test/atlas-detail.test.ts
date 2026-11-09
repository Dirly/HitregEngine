import{test}from'node:test';import assert from'node:assert/strict';
// @ts-expect-error Shared CLI utility is plain JavaScript.
import{selectiveAtlasDetail}from'../tools/_atlas-detail.mjs';
// @ts-expect-error Shared CLI utility is plain JavaScript.
import{layoutQuadFringe}from'../tools/_quad-fringe.mjs';
// @ts-expect-error Shared CLI utility is plain JavaScript.
import{resampleOrnament}from'../tools/_ornament-pixels.mjs';
test('fresh selected-island detail preserves all other base RGBA at integer nearest scale',()=>{
 const base={width:2,height:2,data:new Uint8Array([1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16])},fresh={width:4,height:4,data:new Uint8Array(64).fill(77)},key={width:2,height:2,data:new Uint8Array([255,0,0,255,0,255,0,255,0,255,0,255,0,255,0,255])};
 const out=selectiveAtlasDetail(base,fresh,key,{size:4,hexes:['#ff0000']});
 for(let y=0;y<4;y++)for(let x=0;x<4;x++)assert.deepEqual([...out.data.slice((y*4+x)*4,(y*4+x+1)*4)],x===0&&y===0?[77,77,77,77]:[...base.data.slice((Math.floor(y/2)*2+Math.floor(x/2))*4,(Math.floor(y/2)*2+Math.floor(x/2)+1)*4)]);
});
test('quad fringe retains card count and maps paired triangle corners to matching positions',()=>{
 const uv=Array.from({length:12},()=>[[0,0],[1,0],[1,1],[0,0],[1,1],[0,1]]).flat(),pos=uv.map(()=>[0,0,0]),out=layoutQuadFringe(pos,uv,{width:3,height:4,path:[[0,0,0],[12,0,0]]});
 assert.equal(out.length,72);for(let q=0;q<12;q++){assert.deepEqual(out[q*6],out[q*6+3]);assert.deepEqual(out[q*6+2],out[q*6+4]);assert.equal((out[q*6][0]+out[q*6+1][0])/2,q+.5);}
});

test('regional density reduction preserves current colours, transparent rays and every unselected RGBA pixel',()=>{
 const S=8,data=new Uint8Array(S*S*4),k=new Uint8Array(S*S*4);for(let y=0;y<S;y++)for(let x=0;x<S;x++){const i=(y*S+x)*4;data.set(x===2?[170,90,30,255]:[20,30,40,0],i);k.set(x<4?[255,0,0,255]:[0,255,0,255],i);}const source={width:S,height:S,data},key={width:S,height:S,data:k},r=resampleOrnament(source,key,['#ff0000'],3,{coverage:true});
 for(let y=0;y<S;y++)for(let x=4;x<S;x++){const i=(y*S+x)*4;assert.deepEqual(r.image.data.slice(i,i+4),data.slice(i,i+4));}for(let y=0;y<S;y++)assert.ok([0,1,2,3].some(x=>r.image.data[(y*S+x)*4+3]===255));for(let i=0;i<data.length;i+=4)if(r.image.data[i+3])assert.deepEqual(r.image.data.slice(i,i+4),new Uint8Array([170,90,30,255]));
});

test('shared refinement applies logical Crown cap after fresh import without changing non-Crown base pixels',()=>{
 const base={width:2,height:2,data:new Uint8Array(16).fill(12)},fresh={width:4,height:4,data:Uint8Array.from({length:64},(_,i)=>i)},key={width:4,height:4,data:new Uint8Array(64)};for(let y=0;y<4;y++)for(let x=0;x<4;x++)key.data.set(x<2?[255,0,0,255]:[0,255,0,255],(y*4+x)*4);
 const out=selectiveAtlasDetail(base,fresh,key,{size:4,hexes:['#ff0000'],logicalRegions:[{hexes:['#ff0000'],size:2}]});for(let y=0;y<4;y++)for(let x=2;x<4;x++)assert.deepEqual(out.data.slice((y*4+x)*4,(y*4+x+1)*4),new Uint8Array([12,12,12,12]));assert.deepEqual(out.data.slice(0,4),fresh.data.slice(20,24));
});
