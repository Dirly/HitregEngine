import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Plain shared JS authoring helper.
import { iconPartGlow, iconLitChannel } from '../tools/_item-icon-glow.mjs';

test('icon emissive affects only selected native parts, including high part bits',()=>{
 const parts={Hood:2,SpiritEyesMale:21},glow={color:'#bedfff',intensity:5,parts:['SpiritEyesMale']};
 assert.equal(iconPartGlow(glow,parts,2),null);
 const eye=iconPartGlow(glow,parts,21);
 assert.ok(eye[0]>0&&eye[0]<eye[1]&&eye[1]<eye[2]);
 assert.ok(iconLitChannel(0,eye[2])>200,'An opaque black eye quad visibly emits');
 assert.equal(iconPartGlow({...glow,parts:['Missing']},parts,21),null);
 assert.equal(iconPartGlow({...glow,intensity:0},parts,21),null);
 assert.ok(iconPartGlow({color:'#bedfff',intensity:1},parts,2),'Omitted selection emits on the whole shown item');
});

test('ordinary icon lighting remains exact and emission respects authored intensity',()=>{
 for(const value of[0,.5,14.2,100,254.9,280]){
  assert.equal(iconLitChannel(value,undefined),Math.min(255,value));
  assert.equal(iconLitChannel(value,0),Math.min(255,value));
 }
 assert.ok(iconLitChannel(0,.1)<iconLitChannel(0,1));
 assert.ok(iconLitChannel(0,1)<iconLitChannel(0,5));
});
