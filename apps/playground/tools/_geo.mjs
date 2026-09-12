import "./node-dom-shim.mjs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import fs from "node:fs";
const b = fs.readFileSync("projects/voxel-demo/assets/models/mmo/human.glb");
const gltf = await new Promise((r,j)=>new GLTFLoader().parse(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),"",r,j));
let sk=null; gltf.scene.traverse(o=>{ if(o.isSkinnedMesh&&!sk) sk=o; });
const pos = sk.geometry.attributes.position;
sk.geometry.computeBoundingBox();
console.log("geometry bbox:", JSON.stringify(sk.geometry.boundingBox.min), JSON.stringify(sk.geometry.boundingBox.max));
console.log("attr count", pos.count, "itemSize", pos.itemSize, "type", pos.array.constructor.name);
let lo=Infinity, hi=-Infinity;
for (let i=0;i<pos.count;i++){ const y=pos.getY(i); if(y<lo)lo=y; if(y>hi)hi=y; }
console.log("manual Y range", lo.toFixed(3), hi.toFixed(3));
console.log("sk.position", JSON.stringify(sk.position), "parent chain scale", JSON.stringify(sk.parent?.scale));
