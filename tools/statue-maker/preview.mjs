import { T, loadModel } from './statue.mjs';
import { encodePng } from '../../apps/playground/tools/_png.mjs';

/** Neutral clay QA: rasterizes the exported POSITION/NORMAL attributes, not authoring triangles. */
export async function previewPng(gltf, tile = 480) {
  const loaded = await loadModel(Buffer.from(JSON.stringify(gltf))), triangles=[];
  loaded.scene.updateMatrixWorld(true);
  loaded.scene.traverse(mesh=>{
    if(!mesh.isMesh)return;
    const p=mesh.geometry.getAttribute('position'),n=mesh.geometry.getAttribute('normal'),normalMatrix=new T.Matrix3().getNormalMatrix(mesh.matrixWorld);
    for(let i=0;i<p.count;i+=3)triangles.push({p:[0,1,2].map(k=>new T.Vector3().fromBufferAttribute(p,i+k).applyMatrix4(mesh.matrixWorld)),n:[0,1,2].map(k=>new T.Vector3().fromBufferAttribute(n,i+k).applyMatrix3(normalMatrix).normalize())});
  });
  const width=tile*3,height=tile,rgba=new Uint8Array(width*height*4);
  for(let i=0;i<rgba.length;i+=4)rgba.set([39,44,49,255],i);
  const light=new T.Vector3(-.5,.8,.6).normalize();
  for(const [vi,direction] of [[0,[0,-.08,-1]],[1,[-1,-.08,0]],[2,[-.75,-.15,-1]]]){
    const f=new T.Vector3(...direction).normalize(),r=new T.Vector3().crossVectors(new T.Vector3(0,1,0),f).normalize(),u=new T.Vector3().crossVectors(f,r);
    let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity;
    for(const tri of triangles)for(const p of tri.p){const x=p.dot(r),y=p.dot(u);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
    const scale=.9*tile/Math.max(maxX-minX,maxY-minY,1e-6);
    const zbuf=new Float32Array(tile*tile).fill(Infinity);
    for(const tri of triangles){
      const [a,b,c]=tri.p.map(p=>({x:tile*.5+(p.dot(r)-(minX+maxX)*.5)*scale,y:tile*.5-(p.dot(u)-(minY+maxY)*.5)*scale,z:p.dot(f)}));
      const area=(b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y);if(Math.abs(area)<1e-9)continue;
      for(let y=Math.max(0,Math.floor(Math.min(a.y,b.y,c.y)));y<=Math.min(tile-1,Math.ceil(Math.max(a.y,b.y,c.y)));y++){
        for(let x=Math.max(0,Math.floor(Math.min(a.x,b.x,c.x)));x<=Math.min(tile-1,Math.ceil(Math.max(a.x,b.x,c.x)));x++){
          const px=x+.5,py=y+.5,wc=((b.x-a.x)*(py-a.y)-(px-a.x)*(b.y-a.y))/area,wb=((px-a.x)*(c.y-a.y)-(c.x-a.x)*(py-a.y))/area,wa=1-wb-wc;
          if(wa<0||wb<0||wc<0)continue;
          const z=wa*a.z+wb*b.z+wc*c.z,at=y*tile+x;if(z>=zbuf[at])continue;
          zbuf[at]=z;
          const normal=tri.n[0].clone().multiplyScalar(wa).addScaledVector(tri.n[1],wb).addScaledVector(tri.n[2],wc).normalize();
          const shade=.48+.63*Math.max(0,normal.dot(light)),out=(y*width+vi*tile+x)*4;
          rgba.set([Math.min(255,190*shade),Math.min(255,190*shade),Math.min(255,180*shade),255],out);
        }
      }
    }
  }
  return encodePng(width,height,rgba);
}
