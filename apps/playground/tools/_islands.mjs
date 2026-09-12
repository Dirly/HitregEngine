import "./node-dom-shim.mjs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import fs from "node:fs";
const b = fs.readFileSync("projects/voxel-demo/assets/models/mmo/human.glb");
const gltf = await new Promise((r,j)=>new GLTFLoader().parse(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),"",r,j));
const s=gltf.scene; s.updateMatrixWorld(true);
let sk=null; s.traverse(o=>{ if(o.isSkinnedMesh&&!sk) sk=o; });
const pos=sk.geometry.attributes.position;
const n=pos.count, tris=n/3;
// weld by quantised position
const key=(i)=>`${Math.round(pos.getX(i)*1e4)},${Math.round(pos.getY(i)*1e4)},${Math.round(pos.getZ(i)*1e4)}`;
const map=new Map(); const rep=new Int32Array(n);
for(let i=0;i<n;i++){ const k=key(i); let r=map.get(k); if(r===undefined){r=i;map.set(k,r);} rep[i]=r; }
const parent=new Map(); const find=(x)=>{ while(parent.get(x)!==x){ parent.set(x,parent.get(parent.get(x))); x=parent.get(x);} return x; };
for(const r of map.values()) parent.set(r,r);
const uni=(a,b)=>{ a=find(rep[a]); b=find(rep[b]); if(a!==b) parent.set(a,b); };
for(let t=0;t<tris;t++){ const i=t*3; uni(i,i+1); uni(i+1,i+2); }
const comp=new Map();
for(let i=0;i<n;i++){ const r=find(rep[i]); const e=comp.get(r)??{n:0,box:new THREE.Box3()}; e.n++; const v=new THREE.Vector3().fromBufferAttribute(pos,i); sk.localToWorld(v); e.box.expandByPoint(v); comp.set(r,e); }
const rows=[...comp.values()].sort((a,b)=>b.n-a.n);
console.log(`verts ${n}, tris ${tris}, islands ${rows.length}`);
console.log("island  verts   worldY range      worldX span  worldZ span");
for(const e of rows.slice(0,12)){
  const sz=e.box.getSize(new THREE.Vector3());
  console.log(`        ${String(e.n).padStart(5)}   ${e.box.min.y.toFixed(2)}..${e.box.max.y.toFixed(2)}      ${sz.x.toFixed(2)}        ${sz.z.toFixed(2)}`);
}
