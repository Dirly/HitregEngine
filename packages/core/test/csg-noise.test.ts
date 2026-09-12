import {it,expect} from 'vitest';
import {createVolume,buildVolumeMesh,volumeDocSchema} from '../src/index.js';

it('meshes deterministic local cave noise and leaves unconfigured masonry unchanged',()=>{
  const node={id:'rock',shape:'sphere',radius:5};
  const plain=volumeDocSchema.parse({voxelSize:.5,nodes:[node]});
  const noisy=volumeDocSchema.parse({...plain,nodes:[{...node,noise:{amount:.8,scale:2.5,seed:83}}]});
  const a=createVolume(plain),b=createVolume(noisy),again=createVolume(noisy);
  let difference=0;
  for(let i=0;i<20;i++){const x=i*.31-3,y=2.3,z=3.1;expect(b.density(x,y,z)).toBe(again.density(x,y,z));difference+=Math.abs(a.density(x,y,z)-b.density(x,y,z));}
  expect(difference).toBeGreaterThan(.1);
  const mesh=buildVolumeMesh(b);expect(mesh.triangleCount).toBeGreaterThan(1000);expect([...mesh.positions].every(Number.isFinite)).toBe(true);
  expect(createVolume(plain).density(1,2,3)).toBe(a.density(1,2,3));
});
