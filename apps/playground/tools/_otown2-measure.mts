// o-town2 scratch: bounds + front door of every strand-town building model (model frame, front = +Z)
import fs from "node:fs";
import { glbTriangles } from "./dress-sockets.mts";
const dir = "projects/world-kit/assets/models/strand-town";
const ids = ["strand-row-house-a","strand-row-house-b","strand-row-house-c","strand-row-house-d","strand-row-filler","strand-smithy","strand-hovel","strand-shed","strand-boat-shed","strand-workshop","strand-workshop-yard","strand-inn","strand-house-s","strand-house-m","strand-house-l","strand-house-corner","strand-chapel","strand-gatehouse","strand-wall-run","strand-wall-tower","strand-wall-corner","strand-belltower","strand-barracks","strand-cot-row","strand-cot-wide","strand-cot-corner","strand-narrow-house","strand-narrow-corner"];
const out: any = {};
for (const id of ids) {
  const s = glbTriangles(`${dir}/${id}.glb`); const p = s.pos;
  let x0=1e9,x1=-1e9,y0=1e9,y1=-1e9,z0=1e9,z1=-1e9; let gx0=1e9,gx1=-1e9,gz0=1e9,gz1=-1e9;
  for (let i=0;i<p.length;i+=3){const x=p[i],y=p[i+1],z=p[i+2];x0=Math.min(x0,x);x1=Math.max(x1,x);y0=Math.min(y0,y);y1=Math.max(y1,y);z0=Math.min(z0,z);z1=Math.max(z1,z); if (y<2.5){gx0=Math.min(gx0,x);gx1=Math.max(gx1,x);gz0=Math.min(gz0,z);gz1=Math.max(gz1,z);} }
  let doors: any[] = [];
  const mf = `${dir}/${id}.markers.json`;
  if (fs.existsSync(mf)) { const m = JSON.parse(fs.readFileSync(mf,"utf8")); doors = (m.markers??[]).filter((k:any)=>k.kind==="door").map((k:any)=>({p:k.position.map((v:number)=>+v.toFixed(2)),yaw:k.yaw,ext:k.exterior})); }
  const r=(v:number)=>+v.toFixed(2);
  out[id] = { x:[r(x0),r(x1)], y:[r(y0),r(y1)], z:[r(z0),r(z1)], ground:{x:[r(gx0),r(gx1)],z:[r(gz0),r(gz1)]}, doors };
  console.log(id, JSON.stringify(out[id]));
}
fs.writeFileSync(process.argv[2]!, JSON.stringify(out,null,1));
