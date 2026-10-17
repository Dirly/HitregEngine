import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {loadCharacter} from '../tools/_load-character.mjs';
import {ShimImage} from '../tools/node-dom-shim.mjs';
import * as THREE from 'three';
import {GLTFExporter} from 'three/examples/jsm/exporters/GLTFExporter.js';

test('retarget accepts a GLB library and preserves an embedded PNG and one-shot motion', async()=>{
  const folder=fs.mkdtempSync(path.join(os.tmpdir(),'hitreg-glb-'));
  try {
    const group=new THREE.Group();
    const hip=new THREE.Bone(),waist=new THREE.Bone(),head=new THREE.Bone();
    hip.name='CC_Base_Hip';waist.name='CC_Base_Waist';head.name='CC_Base_Head';waist.position.y=1;head.position.y=1;hip.add(waist);waist.add(head);group.add(hip);
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));
    geometry.setAttribute('uv',new THREE.Float32BufferAttribute([0,0,1,0,0,1],2));
    geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(new Array(12).fill(0),4));
    geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute([1,0,0,0,1,0,0,0,1,0,0,0],4));
    const image=new ShimImage();image.bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a1S8AAAAASUVORK5CYII=','base64');image.width=1;image.height=1;
    const texture=new THREE.Texture(image);texture.flipY=false;texture.needsUpdate=true;
    const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshStandardMaterial({map:texture}));group.add(mesh);group.updateMatrixWorld(true);mesh.bind(new THREE.Skeleton([hip,waist,head]));
    const clip=new THREE.AnimationClip('Attack1',1,[new THREE.VectorKeyframeTrack('CC_Base_Hip.position',[0,1],[0,0,0,0,.2,0])]);
    const exporter=new GLTFExporter();
    const rig=path.join(folder,'rig.glb'),library=path.join(folder,'library.glb'),out=path.join(folder,'out.glb');
    fs.writeFileSync(rig,Buffer.from(await exporter.parseAsync(group,{binary:true})));
    fs.writeFileSync(library,Buffer.from(await new GLTFExporter().parseAsync(group,{binary:true,animations:[clip]})));
    execFileSync(process.execPath,[path.resolve('tools/retarget.mjs'),'--mesh',rig,'--anim',library,'--clips','all','--height','none','--out',out],{stdio:'pipe'});
    const loaded=await loadCharacter(out);assert.equal(loaded.animations.length,1);assert.equal(loaded.animations[0].name,'Attack1');assert.equal(loaded.animations[0].duration,1);
    let loadedMesh:any;loaded.traverse((o:any)=>{if(o.isSkinnedMesh)loadedMesh=o});
    assert.deepEqual(loadedMesh.material.map.image.bytes,image.bytes);
    assert.deepEqual(Array.from(loadedMesh.geometry.attributes.uv.array),[0,0,1,0,0,1]);
    const mixer=new THREE.AnimationMixer(loaded);const action=mixer.clipAction(loaded.animations[0]).setLoop(THREE.LoopOnce,1);action.clampWhenFinished=true;action.play();mixer.setTime(1);
    assert(Math.abs(loaded.getObjectByName('CC_Base_Hip').position.y-.2)<1e-6,'one-shot endpoint must not wrap to its opening pose');
  } finally {fs.rmSync(folder,{recursive:true,force:true});}
});
