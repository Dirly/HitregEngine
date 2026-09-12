import {describe,it,expect} from 'vitest';
import {createVolume,buildVolumeMesh,volumeDocSchema,volumePaintSchema,registerVolume,csgMesh} from '../src/index.js';

describe('persistent volume paint',()=>{
  const plain=()=>volumeDocSchema.parse({voxelSize:.5,palette:['rock','moss'],nodes:[{id:'rock',shape:'box',size:[4,4,4]}]});
  it('survives JSON and remeshing without changing geometry or collision',()=>{
    const doc=plain();doc.paint.push(volumePaintSchema.parse({id:'stroke',center:[0,2,0],radius:3,strength:1,layer:1}));
    const a=buildVolumeMesh(createVolume(plain()));const b=buildVolumeMesh(createVolume(JSON.parse(JSON.stringify(doc))));
    expect(b.positions).toEqual(a.positions);expect(b.indices).toEqual(a.indices);expect(b.normals).toEqual(a.normals);
    expect(b.splat.some((w,i)=>i%2===1&&w>.5)).toBe(true);
    for(let i=0;i<b.vertexCount;i++)expect(b.splat[i*2]!+b.splat[i*2+1]!).toBeCloseTo(1,5);
  });
  it('blends in stroke order, respects radius, and restores unpainted weights',()=>{
    const doc=plain();doc.paint=[{id:'moss',center:[0,2,0],radius:2,strength:1,layer:1},{id:'rock',center:[0,2,0],radius:2,strength:.25,layer:0}].map(v=>volumePaintSchema.parse(v));
    const weights=new Float32Array(5);createVolume(doc).surfaceAt(0,2,0,1,weights,0);expect(Array.from(weights.slice(0,2))).toEqual([.25,.75]);
    createVolume(doc).surfaceAt(10,2,0,1,weights,0);expect(weights[1]).toBe(0);
    createVolume({...doc,paint:[]}).surfaceAt(0,2,0,1,weights,0);expect(weights[1]).toBe(0);
  });
  it('rejects unsafe brush values',()=>{
    expect(volumePaintSchema.safeParse({id:'bad',center:[NaN,0,0],radius:0,strength:2,layer:-1}).success).toBe(false);
  });
  it('retains the geometry cache when only paint changes',()=>{
    const doc=plain(),source={kind:'csg' as const,volume:'paint-cache-test'};
    registerVolume(source.volume,doc);const mesh=csgMesh(source),indices=mesh.indices,positions=mesh.positions;
    doc.paint=[volumePaintSchema.parse({id:'fill',center:[0,2,0],radius:10,strength:1,layer:1,fill:true})];
    registerVolume(source.volume,doc);expect(csgMesh(source)).toBe(mesh);expect(mesh.positions).toBe(positions);expect(mesh.indices).toBe(indices);
    expect(mesh.splat[1]).toBe(1);
  });
  it('fills the chosen facing angle without bleeding onto perpendicular or opposite faces',()=>{
    const doc=plain();doc.paint=[volumePaintSchema.parse({id:'fill',center:[0,2,0],radius:10,strength:1,layer:1,normal:[0,1,0],maxAngle:35,fill:true})];
    const v=createVolume(doc),w=new Float32Array(5);
    v.surfaceAt(1.8,2,0,1,w,0,0,0);expect(w[1]).toBe(1);
    v.surfaceAt(2,1,0,0,w,0,1,0);expect(w[1]).toBe(0);
    v.surfaceAt(0,-2,0,-1,w,0,0,0);expect(w[1]).toBe(0);
    v.surfaceAt(12,2,0,1,w,0,0,0);expect(w[1]).toBe(0);
  });
});
