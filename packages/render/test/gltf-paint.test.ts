import {afterEach, describe, expect, it, vi} from 'vitest';
import * as THREE from 'three/webgpu';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {buildScene, loadGltf} from '../src/scene-builder.js';
import {materialSchema} from '@hitreg/core';

afterEach(() => vi.restoreAllMocks());
describe('painted glTF assets', () => {
  it('restores all four custom paint semantics and overrides only the placed material', async () => {
    const geometry = new THREE.BoxGeometry();
    for (const suffix of ['', '2', '3', '4']) geometry.setAttribute('_splatweight'+suffix, new THREE.Float32BufferAttribute(new Float32Array(geometry.attributes.position!.count*4),4));
    const original = new THREE.MeshStandardNodeMaterial();
    const source = new THREE.Group(); source.add(new THREE.Mesh(geometry, original));
    vi.spyOn(GLTFLoader.prototype,'loadAsync').mockResolvedValue({scene:source,animations:[]} as never);
    const url='test:painted-gltf';
    await loadGltf(url);
    for (const suffix of ['', '2', '3', '4']) expect(geometry.getAttribute('splatWeight'+suffix)).toBe(geometry.getAttribute('_splatweight'+suffix));
    let complete!: (root:THREE.Object3D)=>void;
    const loaded = new Promise<THREE.Object3D>(resolve=>{complete=resolve;});
    buildScene({version:1,name:'paint',entities:{rock:{name:'rock',parent:null,tags:[],components:{mesh:{source:{kind:'asset',assetId:'rock'},material:'paint'}}}}},{resolveModel:()=>url,resolveMaterial:()=>materialSchema.parse({shader:'unlit',color:'#ff0000'}),onModelLoaded:(_id,root)=>complete(root)});
    const placed=await loaded;let material:THREE.Material|THREE.Material[]|undefined;
    placed.traverse(node=>{if((node as THREE.Mesh).isMesh)material=(node as THREE.Mesh).material;});
    expect(material).not.toBe(original);
    expect((material as THREE.MeshBasicNodeMaterial).color.getHexString()).toBe('ff0000');
    expect((source.children[0] as THREE.Mesh).material).toBe(original);
  });
});
