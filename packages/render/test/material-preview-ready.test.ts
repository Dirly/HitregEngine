import {afterEach,describe,expect,it,vi} from 'vitest';
import * as THREE from 'three/webgpu';
import {materialSchema} from '@hitreg/core';
import {materialForId} from '../src/scene-builder.js';
import {waitForMaterialMaps} from '../src/material-maps.js';

afterEach(()=>vi.restoreAllMocks());

describe('textured one-shot previews',()=>{
  it('waits for the texture node graph even while .map is null',async()=>{
    let deliver!:(texture:THREE.Texture)=>void;
    vi.spyOn(THREE.TextureLoader.prototype,'loadAsync').mockImplementation(()=>new Promise(resolve=>{deliver=resolve;}));
    const material=materialForId('preview/late',{resolveMaterial:()=>materialSchema.parse({map:'late.png'}),resolveTexture:()=>'/preview/late.png'},new Map()) as THREE.MeshStandardNodeMaterial;
    expect(material.map??null).toBeNull();expect(material.colorNode??null).toBeNull();
    let captured=false;const capture=waitForMaterialMaps([material]).then(()=>{captured=true;});
    await new Promise(resolve=>setTimeout(resolve,0));expect(captured).toBe(false);
    deliver(new THREE.DataTexture(new Uint8Array([180,80,40,255]),1,1));
    await capture;expect(material.colorNode).toBeTruthy();expect(captured).toBe(true);
  });
  it('rejects missing textures rather than saving a flat thumbnail',async()=>{
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    const material=materialForId('preview/missing',{resolveMaterial:()=>materialSchema.parse({map:'missing.png'}),resolveTexture:()=>undefined},new Map());
    await expect(waitForMaterialMaps([material])).rejects.toThrow('missing.png');
  });
  it('rejects failed texture downloads and loading timeouts',async()=>{
    vi.spyOn(console,'warn').mockImplementation(()=>{});
    const loader=vi.spyOn(THREE.TextureLoader.prototype,'loadAsync').mockRejectedValue(Error('404'));
    const options=(name:string)=>({resolveMaterial:()=>materialSchema.parse({map:name}),resolveTexture:()=>'/preview/'+name});
    const failed=materialForId('preview/failed',options('failed.png'),new Map());
    await expect(waitForMaterialMaps([failed])).rejects.toThrow('failed.png');
    let deliver!:(texture:THREE.Texture)=>void;loader.mockImplementation(()=>new Promise(resolve=>{deliver=resolve;}));
    const slow=materialForId('preview/slow',options('slow.png'),new Map());
    await expect(waitForMaterialMaps([slow],1)).rejects.toThrow('did not finish');
    deliver(new THREE.DataTexture(new Uint8Array([1,2,3,255]),1,1));await waitForMaterialMaps([slow]);
  });
});
