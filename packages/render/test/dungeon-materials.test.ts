import {describe,it,expect} from 'vitest';
import {materialSchema} from '@hitreg/core';
import {MeshBasicNodeMaterial,MeshStandardNodeMaterial} from 'three/webgpu';
import {makeMaterial} from '../src/scene-builder.js';

describe('opt-in dungeon material rendering',()=>{
 it('builds the persistent portal as an unlit procedural material without a texture',()=>{
  const portal=makeMaterial(materialSchema.parse({shader:'portal',color:'#63bfff',opacity:.96})) as MeshBasicNodeMaterial;
  expect(portal).toBeInstanceOf(MeshBasicNodeMaterial);
  expect(portal.map).toBeNull();expect(portal.colorNode).toBeTruthy();expect(portal.opacityNode).toBeTruthy();
  expect(portal.depthWrite).toBe(false);portal.dispose();
 });
 it('preserves lit water by default and supports unlit animated water',()=>{
  const lit=makeMaterial(materialSchema.parse({shader:'water',water:{}}));
  const unlit=makeMaterial(materialSchema.parse({shader:'water',water:{lighting:false,textureTint:'#66ff22'}}));
  expect(lit).toBeInstanceOf(MeshStandardNodeMaterial);
  expect(unlit).toBeInstanceOf(MeshBasicNodeMaterial);
  const water=unlit as MeshBasicNodeMaterial;
  expect(water.positionNode).toBeTruthy();
  expect(water.colorNode).toBeTruthy();
  expect(water.opacityNode).toBeTruthy();
  lit.dispose();unlit.dispose();
 });
 it('uses face normals only for opted-in splat materials',()=>{
  const build=(flatShading?:boolean)=>makeMaterial(materialSchema.parse({shader:'terrain-splat',splat:{flatShading,layers:[{color:'#445544'},{color:'#334433'}]}})) as MeshStandardNodeMaterial;
  const organic=build(),masonry=build(true);
  expect(organic.flatShading).toBe(false);expect(masonry.flatShading).toBe(true);
  organic.dispose();masonry.dispose();
 });
});
