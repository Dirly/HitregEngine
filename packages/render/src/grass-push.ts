import * as THREE from "three/webgpu";
import { float, max, normalize, saturate, uniform, vec2, vec3 } from "three/tsl";
import { readWorldPosition } from "./static-transforms.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/**
 * Grass parting around whoever walks through it: the nearest few characters
 * to the camera are handed to every grass material as a short uniform list,
 * and each blade's tip leans away from them and down. A handful of ALU ops
 * per grass vertex; no texture, no trail buffer, no draw.
 */
export const GRASS_PUSHERS = 8;
/** Radius around a character that the grass parts, metres. */
const PUSH_RADIUS = 1.1;
/** Only characters this close to the camera push (the effect is invisible further out). */
const PUSH_RANGE = 40;

const pushers = Array.from({ length: GRASS_PUSHERS }, () => uniform(new THREE.Vector4(0, -1e5, 0, 0)));

/** World offset for a grass vertex at `world`, scaled by how far up the blade it is (`bend`, 0 base .. 1 tip). */
export function grassPushOffset(world: N, bend: N): N {
  let offset: N = vec3(0, 0, 0);
  for (const p of pushers) {
    const d: N = vec2(world.x.sub(p.x), world.z.sub(p.z));
    const dist: N = max(d.length(), float(0.001));
    // only near the ground the character stands on
    const level: N = saturate(float(1.5).sub(world.y.sub(p.y).abs()));
    const near: N = saturate(float(1).sub(dist.div(max(p.w, float(0.001))))).mul(level);
    const away: N = normalize(d).mul(near.mul(0.55));
    offset = offset.add(vec3(away.x, near.mul(-0.35), away.y));
  }
  return offset.mul(bend);
}

const scratch: { position: THREE.Vector3; distSq: number }[] = [];
const camWorld = new THREE.Vector3();

/** Pick the nearest characters to the camera and hand them to the grass. Once a frame. */
export function setGrassPushers(roots: Iterable<THREE.Object3D>, camera: THREE.Camera): void {
  camera.getWorldPosition(camWorld);
  let n = 0;
  for (const root of roots) {
    if (!root.parent) continue;
    const entry = (scratch[n] ??= { position: new THREE.Vector3(), distSq: 0 });
    readWorldPosition(root, entry.position);
    entry.distSq = entry.position.distanceToSquared(camWorld);
    if (entry.distSq > PUSH_RANGE * PUSH_RANGE) continue;
    n++;
  }
  const live = scratch.slice(0, n).sort((a, b) => a.distSq - b.distSq);
  for (let i = 0; i < GRASS_PUSHERS; i++) {
    const e = live[i];
    if (e) pushers[i]!.value.set(e.position.x, e.position.y, e.position.z, PUSH_RADIUS);
    else pushers[i]!.value.set(0, -1e5, 0, 0);
  }
}
