import "./node-dom-shim.mjs";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import fs from "node:fs";
const b = fs.readFileSync("projects/voxel-demo/assets/models/mmo/human.glb");
const gltf = await new Promise((r,j)=>new GLTFLoader().parse(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),"",r,j));
const s = gltf.scene; s.updateMatrixWorld(true);
let sk=null; s.traverse(o=>{ if(o.isSkinnedMesh&&!sk) sk=o; });
const pos=sk.geometry.attributes.position, si=sk.geometry.attributes.skinIndex, sw=sk.geometry.attributes.skinWeight;
const bones=sk.skeleton.bones;
const bonePos = bones.map(bn => bn.getWorldPosition(new THREE.Vector3()));
const box = new THREE.Box3().setFromObject(s);
const height = box.max.y - box.min.y;
const v = new THREE.Vector3();
const buckets = new Map();
for (let i=0;i<pos.count;i++){
  let best=0, bi=si.getX(i);
  for (const c of ["X","Y","Z","W"]) { const w=sw["get"+c](i); if(w>best){best=w; bi=si["get"+c](i);} }
  v.fromBufferAttribute(pos,i); sk.localToWorld(v);
  const drop = (bonePos[bi].y - v.y) / height;   // how far this vertex hangs below its driving bone
  const name = bones[bi]?.name ?? "?";
  const e = buckets.get(name) ?? { n:0, dropMax:-Infinity, dropSum:0 };
  e.n++; e.dropSum += drop; e.dropMax = Math.max(e.dropMax, drop);
  buckets.set(name, e);
}
const rows=[...buckets.entries()].map(([n,e])=>({n, count:e.n, avg:e.dropSum/e.n, max:e.dropMax}))
  .sort((a,b)=>b.max-a.max);
console.log("bone".padEnd(26), "verts  avgDrop  maxDrop   (drop = fraction of body height a vert hangs below its bone)");
for (const r of rows.slice(0,12)) console.log(`${r.n.padEnd(26)} ${String(r.count).padStart(4)}   ${r.avg.toFixed(3)}   ${r.max.toFixed(3)}`);
for (const t of [0.10, 0.14, 0.18, 0.22]) {
  let cloth=0, legs=0;
  for (let i=0;i<pos.count;i++){
    let best=0, bi=si.getX(i);
    for (const c of ["X","Y","Z","W"]) { const w=sw["get"+c](i); if(w>best){best=w; bi=si["get"+c](i);} }
    v.fromBufferAttribute(pos,i); sk.localToWorld(v);
    const drop=(bonePos[bi].y - v.y)/height;
    if (drop <= t) continue;
    if (/Thigh|Calf|Knee|Foot|Toe/i.test(bones[bi].name)) legs++; else cloth++;
  }
  console.log(`threshold ${t}: ${cloth} cloth verts, ${legs} LEG verts caught (want 0)`);
}
