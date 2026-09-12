import {expect,it} from 'vitest';
import {createVolume,buildVolumeMesh} from '../src/index.js';

const outline=[[-3,-3],[3,-3],[3,-1],[-1,-1],[-1,3],[-3,3]];
it('carves a concave map outline without filling its notch, with separate floor material',()=>{
 const v=createVolume({palette:['rock','wall','floor'],nodes:[{shape:'box',size:[12,12,12]},{op:'sub',shape:'prism',polygon:outline,height:4,surface:{wall:1,ceiling:1,floor:2}}]});
 expect(v.density(-2,0,2)).toBeGreaterThan(0);
 expect(v.density(2,0,2)).toBeLessThan(0);
 expect(v.density(-2,-3,2)).toBeLessThan(0);
 const out=new Float32Array(6);v.surfaceAt(-2,-2,0,1,out,0);expect(out[2]).toBe(1);
});
it('preserves winding independence and rotated sampler bounds',()=>{
 const make=(polygon:number[][])=>createVolume({nodes:[{shape:'prism',polygon,height:3,position:[4,2,-1],rotation:[0,.7,0],round:.2}]});
 const a=make(outline),b=make([...outline].reverse()),sample=a.sampler([0,-1,-5],[8,5,4]);
 for(let x=0;x<=8;x++)for(let z=-5;z<=4;z++){expect(a.density(x,2,z)).toBeCloseTo(b.density(x,2,z),8);expect(sample(x,2,z)).toBeCloseTo(a.density(x,2,z),8);}
});
it('meshes an extruded footprint with finite vertices',()=>{
 const m=buildVolumeMesh(createVolume({voxelSize:.3,nodes:[{shape:'prism',polygon:[[-2,-2],[2,-2],[3,0],[2,2],[-2,2]],height:3}]}));
 expect(m.triangleCount).toBeGreaterThan(0);expect([...m.positions].every(Number.isFinite)).toBe(true);
});
