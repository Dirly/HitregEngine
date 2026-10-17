/** Node character loading, retaining embedded image bytes when exporting GLB. */
import { ShimImage, addTextureSearchRoot } from './node-dom-shim.mjs';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import fs from 'node:fs';
import path from 'node:path';
import { sanitizeFbx } from './_fbx.mjs';

export async function loadCharacter(file) {
  const abs = path.resolve(file), bytes = fs.readFileSync(abs);
  addTextureSearchRoot(path.dirname(abs));
  const warn = console.warn;
  console.warn = () => {};
  try {
    if (/\.fbx$/i.test(abs)) return new FBXLoader().parse(sanitizeFbx(bytes), path.dirname(abs) + path.sep);
    if (!/\.glb$/i.test(abs)) throw Error('Character input must be FBX or GLB: ' + abs);
    const jsonLength = bytes.readUInt32LE(12), json = JSON.parse(bytes.subarray(20,20+jsonLength));
    const binary = bytes.subarray(28+jsonLength);
    const filter = {9728:THREE.NearestFilter,9729:THREE.LinearFilter,9984:THREE.NearestMipmapNearestFilter,9985:THREE.LinearMipmapNearestFilter,9986:THREE.NearestMipmapLinearFilter,9987:THREE.LinearMipmapLinearFilter};
    const wrap = {33071:THREE.ClampToEdgeWrapping,33648:THREE.MirroredRepeatWrapping,10497:THREE.RepeatWrapping};
    const loader = new GLTFLoader().register(parser => ({
      name:'HITREG_embedded_images',
      loadTexture(index) {
        const def=json.textures[index], source=json.images[def.source];
        if (source.bufferView === undefined) throw Error('GLB image must be embedded: '+abs);
        const view=json.bufferViews[source.bufferView], image=new ShimImage();
        image.bytes=Buffer.from(binary.subarray(view.byteOffset??0,(view.byteOffset??0)+view.byteLength));
        image.mime=source.mimeType;
        if (image.mime!=='image/png') throw Error('Lossless Node GLB export currently requires PNG images: '+abs);
        image.width=image.bytes.readUInt32BE(16); image.height=image.bytes.readUInt32BE(20);
        const texture=new THREE.Texture(image), sampler=json.samplers?.[def.sampler]??{};
        texture.name=def.name??source.name??''; texture.flipY=false;
        texture.wrapS=wrap[sampler.wrapS??10497]; texture.wrapT=wrap[sampler.wrapT??10497];
        texture.magFilter=filter[sampler.magFilter??9729]; texture.minFilter=filter[sampler.minFilter??9987];
        texture.needsUpdate=true; parser.associations.set(texture,{textures:index});
        return Promise.resolve(texture);
      },
    }));
    const gltf=await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),'');
    gltf.scene.animations=gltf.animations;
    return gltf.scene;
  } finally { console.warn=warn; }
}
