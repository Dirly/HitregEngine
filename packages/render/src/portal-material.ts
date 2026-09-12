import * as THREE from 'three/webgpu';
import { color, float, time, uv, vec2, vec3, texture, cos, sin, mix, smoothstep } from 'three/tsl';
import { ringBand, ringEnergy, quantize, posterize, type N } from './vfx/shaders.js';
import type { TextureResolver } from './material-maps.js';

/** Persistent copy of FX Lab linger.gate spiral, with one uniform hue.
 * Uses local 0..1 UVs on a facing quad. It is visual only: geometry/zone
 * triggers must independently seal and implement the instance boundary. */
export function buildPortalMaterial(data: {color: string; opacity: number; map?: string; portal?: {aperture?: 'disc'|'opening'}}, options?: TextureResolver): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({transparent:true, depthWrite:false, side:THREE.DoubleSide});
  const q: N = quantize(uv(), float(128));
  const p: N = q.sub(vec2(.5,.5)).mul(2);
  const r: N = p.length(), angle: N = p.y.atan(p.x);
  const energy: N = ringEnergy(q,r,angle,float(1.4),time,float(2.5),float(.6));
  const boundary: N = data.portal?.aperture === 'opening'
    ? smoothstep(float(0),float(.012),q.x.min(q.y).min(float(1).sub(q.x)).min(float(1).sub(q.y)))
    : ringBand(float(0),float(.55),r);
  const face: N = boundary.mul(energy);
  let painted: N = float(1);
  const url = data.map && options?.resolveTexture?.(data.map);
  if (url) {
    const map = new THREE.Texture();
    map.colorSpace = THREE.SRGBColorSpace;
    map.minFilter = THREE.NearestFilter; map.magFilter = THREE.NearestFilter;
    map.generateMipmaps = false;
    const a: N = time.mul(-.12), c: N = cos(a), s: N = sin(a);
    const rotated: N = vec2(p.x.mul(c).sub(p.y.mul(s)),p.x.mul(s).add(p.y.mul(c))).mul(.5).add(.5);
    const detail: N = texture(map,rotated).rgb.dot(vec3(.2126,.7152,.0722));
    painted = mix(float(1),detail.mul(3.5).add(.3).clamp(.3,1.3),float(.85));
    let disposed = false;
    material.addEventListener('dispose',()=>{disposed=true;map.dispose();});
    void new THREE.TextureLoader().loadAsync(url).then(loaded=>{
      if(!disposed){map.image=loaded.image;map.needsUpdate=true;}
      loaded.dispose();
    }).catch(error=>console.warn(`[render] portal texture failed to load: ${url}`,error));
  }
  material.colorNode = (color(data.color) as N).mul(energy.mul(.4).add(.6)).mul(painted);
  material.opacityNode = posterize(face.min(1),float(4)).mul(data.opacity);
  return material;
}
