import * as THREE from "three/webgpu";
import {
  abs,
  cameraPosition,
  distance,
  dot,
  float,
  floor,
  fract,
  min,
  length,
  max,
  mix,
  normalize,
  normalWorld,
  positionWorld,
  pow,
  saturate,
  sin,
  smoothstep,
  step,
  time,
  uv,
  vec2,
  vec3,
} from "three/tsl";
import { nightLevel } from "./daylight.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type N = any;

/**
 * Lit windows at night, made from the window kit's `WindowGlass` panes alone
 * (docs/world-standards/building-styles.md → Windows) — no authoring, no
 * lights, no new draw per building.
 *
 * At model load the glass is split into WINDOWS (coplanar panes a mullion
 * apart), and each window gets:
 *
 *  - a SEED, written into the glass UVs as a whole multiple of
 *    {@link SEED_STRIDE} (the pane texture repeats, so the picture is
 *    unchanged). The shader turns it into the window's character: lit or dark
 *    tonight, the dusk hour it comes on, candle-warm or lamp-pale, and a slow
 *    flicker. A street stops reading as a grid of identical yellow squares.
 *  - a LIGHT CARD: a soft frustum of four additive faces reaching out and
 *    down from the outside of the window (light falling into the street), and
 *    a halo quad on the window plane. All of a model's cards are one mesh on
 *    ONE shared material, carrying only position/normal/uv — so the static
 *    batcher merges every building's cards into a single draw, and instanced
 *    buildings carry them as one more submesh.
 *
 * By day everything multiplies out to black (the cards still draw, a few
 * hundred small additive quads per town). They never cast shadows
 * ({@link NO_SHADOW_FLAG}).
 */

/** UV.x offset per seed step; pane UVs must lie within ±SEED_STRIDE/2. */
export const SEED_STRIDE = 8;
const SEEDS = 16;
/** Material userData flag: meshes drawn with it never cast or receive shadows. */
export const NO_SHADOW_FLAG = "hitregNoShadow";

/** Panes within this gap (metres) of each other, coplanar and parallel, are one window. */
const PANE_GAP = 0.3;
const PLANE_TOLERANCE = 0.15;
/** Halo quad = window scaled by this on both axes. */
const HALO_SCALE = 1.7;

export interface WindowInfo {
  /** Centre on the outermost glass plane, mesh-local. */
  centre: THREE.Vector3;
  /** Outward normal. */
  normal: THREE.Vector3;
  /** In-plane horizontal and vertical unit axes. */
  across: THREE.Vector3;
  up: THREE.Vector3;
  width: number;
  height: number;
  seed: number;
  /** Vertex indices of the glass belonging to this window. */
  vertices: number[];
}

/* ---------- shader ---------- */

function hash(x: N): N {
  return fract(sin(x.mul(12.9898).add(1.7)).mul(43758.5453));
}

/** Seed and in-card UV from a seeded UV (see SEED_STRIDE). */
export function windowSeed(u: N): N {
  return floor(u.add(SEED_STRIDE / 2).div(SEED_STRIDE));
}

/**
 * The window's light colour × on-ness for this frame: dark windows stay dark,
 * lit ones come on at their own point of dusk, warm or pale, with a slow
 * candle flicker. Shared by the glass and its card so the two always agree.
 */
export function windowLight(seed: N): N {
  const lit: N = step(hash(seed), float(0.7));
  const onset: N = hash(seed.add(3.17)).mul(0.4).add(0.15);
  const on: N = smoothstep(onset, onset.add(0.2), nightLevel).mul(lit);
  const warm: N = mix(vec3(1.0, 0.5, 0.18), vec3(1.0, 0.76, 0.46), hash(seed.add(7.31)));
  const rate: N = hash(seed.add(1.9)).mul(2.3).add(1.1);
  const flicker: N = sin(time.mul(rate).add(seed.mul(2.1))).mul(0.07).add(0.93);
  return warm.mul(on.mul(flicker));
}

/** 1 on the street side of a seeded pane (see seedWindowGlass), 0 on the inside face. */
export function windowOutside(v: N): N {
  return step(SEED_STRIDE / 2, v);
}

/** Room cell the fake interior repeats in: width, storey height, depth (metres). */
const ROOM = { width: 3.2, height: 3.0, depth: 2.4 };

/**
 * A room behind the glass, by day: classic interior mapping. The view ray is
 * walked into a box (one room per storey and bay, on a world grid along the
 * wall) and whichever face it meets — back wall, side walls, floor or ceiling
 * — is shaded in dim plaster and timber tones, darker the deeper it is. No
 * texture, ~30 ALU per glass fragment, glass only.
 */
export function windowInterior(seed: N): N {
  const n: N = normalize(normalWorld);
  const across: N = normalize(vec3(n.z, 0, n.x.negate()));
  const view: N = normalize(positionWorld.sub(cameraPosition));
  const p: N = vec2(dot(positionWorld, across).div(ROOM.width), positionWorld.y.div(ROOM.height));
  const cell: N = floor(p);
  const f: N = p.sub(cell);
  // ray in cell units: x across, y up, z into the room
  const d: N = vec3(dot(view, across).div(ROOM.width), view.y.div(ROOM.height), max(dot(view, n).negate(), 0.05).div(ROOM.depth));
  const tx: N = step(0, d.x).sub(f.x).div(d.x);
  const ty: N = step(0, d.y).sub(f.y).div(d.y);
  const tz: N = float(1).div(d.z);
  const t: N = min(min(tx, ty), tz);
  const depth: N = saturate(t.mul(d.z));
  const isBack: N = step(tz, min(tx, ty));
  const isFloor: N = float(1).sub(isBack).mul(step(ty, tx)).mul(step(d.y, 0));
  const isCeiling: N = float(1).sub(isBack).mul(step(ty, tx)).mul(step(0, d.y));
  const room: N = hash(cell.x.mul(17.1).add(cell.y.mul(5.3)).add(seed));
  const plaster: N = mix(vec3(0.36, 0.3, 0.24), vec3(0.42, 0.38, 0.33), room);
  const timber: N = vec3(0.17, 0.12, 0.08);
  let c: N = plaster.mul(0.8);
  c = mix(c, plaster, isBack);
  c = mix(c, timber, isFloor);
  c = mix(c, timber.mul(0.7), isCeiling);
  return c.mul(float(1).sub(depth.mul(0.55)));
}

let cardMaterial: THREE.MeshBasicNodeMaterial | null = null;

/** The one material every building's light cards share. */
export function windowCardMaterial(): THREE.MeshBasicNodeMaterial {
  if (cardMaterial) return cardMaterial;
  const m = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    fog: false,
  });
  m.name = "window-light-cards";
  m.userData[NO_SHADOW_FLAG] = true;
  const raw: N = uv();
  const seed: N = windowSeed(raw.x);
  const isHalo: N = step(1.5, raw.y);
  const u: N = raw.x.sub(seed.mul(SEED_STRIDE));
  const v: N = raw.y.sub(isHalo.mul(2));

  // shaft: brightest at the glass, gone at the far end; soft along both long
  // edges; faces seen edge-on fade so no plane ever shows as a hard line
  const along: N = pow(float(1).sub(saturate(v)), float(2.2));
  const across: N = smoothstep(0, 0.5, u).mul(smoothstep(1, 0.5, u));
  const toCamera: N = normalize(cameraPosition.sub(positionWorld));
  const facing: N = smoothstep(0.15, 0.75, abs(dot(toCamera, normalWorld)));
  const shaft: N = along.mul(across).mul(facing).mul(0.09);

  // halo: full over the glass, falling off around it
  const q: N = abs(vec2(u, v).sub(0.5)).mul(2);
  const inner = 1 / HALO_SCALE;
  const out: N = length(max(q.sub(inner), 0)).div(1 - inner);
  const halo: N = pow(saturate(float(1).sub(out)), float(2.2)).mul(0.32);

  const far: N = float(1).sub(smoothstep(140, 240, distance(cameraPosition, positionWorld)));
  m.colorNode = windowLight(seed).mul(mix(shaft, halo, isHalo)).mul(far);
  cardMaterial = m;
  return m;
}

/* ---------- geometry ---------- */

/** Group a glass geometry's triangles into windows (mesh-local). `centre` is the model's centre in the same frame. */
export function findWindows(geometry: THREE.BufferGeometry, centre: THREE.Vector3): WindowInfo[] {
  const position = geometry.getAttribute("position");
  if (!position) return [];
  const index = geometry.index;
  const triCount = index ? index.count / 3 : position.count / 3;
  const vertexAt = (i: number): number => (index ? index.getX(i) : i);

  // weld by position, then union-find over triangles → panes
  const weld = new Map<string, number>();
  const welded = new Int32Array(position.count);
  for (let i = 0; i < position.count; i++) {
    const key = `${Math.round(position.getX(i) * 1000)},${Math.round(position.getY(i) * 1000)},${Math.round(position.getZ(i) * 1000)}`;
    let id = weld.get(key);
    if (id === undefined) weld.set(key, (id = weld.size));
    welded[i] = id;
  }
  const parent = new Int32Array(weld.size).map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  for (let t = 0; t < triCount; t++) {
    const a = find(welded[vertexAt(t * 3)]!);
    parent[find(welded[vertexAt(t * 3 + 1)]!)] = a;
    parent[find(welded[vertexAt(t * 3 + 2)]!)] = a;
  }

  interface Pane { normal: THREE.Vector3; min: THREE.Vector3; max: THREE.Vector3; vertices: Set<number> }
  const panes = new Map<number, Pane>();
  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3(), n = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const ia = vertexAt(t * 3), ib = vertexAt(t * 3 + 1), ic = vertexAt(t * 3 + 2);
    const root = find(welded[ia]!);
    let pane = panes.get(root);
    if (!pane) {
      pane = { normal: new THREE.Vector3(), min: new THREE.Vector3(Infinity, Infinity, Infinity), max: new THREE.Vector3(-Infinity, -Infinity, -Infinity), vertices: new Set() };
      panes.set(root, pane);
    }
    p0.fromBufferAttribute(position, ia);
    p1.fromBufferAttribute(position, ib);
    p2.fromBufferAttribute(position, ic);
    n.subVectors(p1, p0).cross(p2.clone().sub(p0)); // area-weighted
    pane.normal.add(n);
    for (const [i, p] of [[ia, p0], [ib, p1], [ic, p2]] as const) {
      pane.min.min(p);
      pane.max.max(p);
      pane.vertices.add(i);
    }
  }

  // panes → windows: parallel (either side of the glass), coplanar, close
  const list = [...panes.values()].filter((p) => p.normal.lengthSq() > 1e-10);
  for (const p of list) p.normal.normalize();
  const group = list.map((_, i) => i);
  const top = (x: number): number => {
    while (group[x] !== x) x = group[x] = group[group[x]!]!;
    return x;
  };
  const centreOf = (p: Pane) => p.min.clone().add(p.max).multiplyScalar(0.5);
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    const ca = centreOf(a);
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j]!;
      if (Math.abs(a.normal.dot(b.normal)) < 0.95) continue;
      if (Math.abs(centreOf(b).sub(ca).dot(a.normal)) > PLANE_TOLERANCE) continue;
      const gap = Math.max(
        a.min.x - b.max.x, b.min.x - a.max.x,
        a.min.y - b.max.y, b.min.y - a.max.y,
        a.min.z - b.max.z, b.min.z - a.max.z,
      );
      if (gap > PANE_GAP) continue;
      group[top(j)] = top(i);
    }
  }
  const windows = new Map<number, Pane[]>();
  for (let i = 0; i < list.length; i++) {
    const g = top(i);
    const members = windows.get(g);
    if (members) members.push(list[i]!);
    else windows.set(g, [list[i]!]);
  }

  const result: WindowInfo[] = [];
  const worldUp = new THREE.Vector3(0, 1, 0);
  for (const members of windows.values()) {
    const normal = members[0]!.normal.clone();
    if (Math.abs(normal.y) > 0.6) continue; // roof lights: no shaft to cast
    const min = new THREE.Vector3(Infinity, Infinity, Infinity);
    const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
    const vertices: number[] = [];
    for (const m of members) {
      min.min(m.min);
      max.max(m.max);
      for (const v of m.vertices) vertices.push(v);
    }
    const mid = min.clone().add(max).multiplyScalar(0.5);
    // outward = away from the building's middle, horizontally
    const away = mid.clone().sub(centre).setY(0);
    normal.setY(0).normalize();
    if (normal.dot(away) < 0) normal.negate();
    const across = new THREE.Vector3().crossVectors(worldUp, normal).normalize();
    const up = new THREE.Vector3().crossVectors(normal, across).normalize();
    let a0 = Infinity, a1 = -Infinity, u0 = Infinity, u1 = -Infinity, outer = -Infinity;
    for (const v of vertices) {
      p0.fromBufferAttribute(position, v);
      const a = p0.dot(across), b = p0.dot(up), o = p0.dot(normal);
      if (a < a0) a0 = a;
      if (a > a1) a1 = a;
      if (b < u0) u0 = b;
      if (b > u1) u1 = b;
      if (o > outer) outer = o;
    }
    const width = a1 - a0, height = u1 - u0;
    if (width * height < 0.12) continue;
    const centrePoint = new THREE.Vector3()
      .addScaledVector(across, (a0 + a1) / 2)
      .addScaledVector(up, (u0 + u1) / 2)
      .addScaledVector(normal, outer);
    // stable per window, independent of load order
    const h = Math.abs(Math.sin(centrePoint.x * 12.9898 + centrePoint.y * 78.233 + centrePoint.z * 37.719) * 43758.5453);
    const seed = Math.floor((h - Math.floor(h)) * SEEDS);
    result.push({ centre: centrePoint, normal, across, up, width, height, seed, vertices });
  }
  return result;
}

/**
 * Write each window's seed into the glass UVs (see SEED_STRIDE). Returns
 * false — and leaves the UVs alone — when the pane UVs do not fit the
 * encoding; the windows then all share seed 0 (lit, one colour).
 */
export function seedWindowGlass(geometry: THREE.BufferGeometry, windows: WindowInfo[]): boolean {
  const uvAttr = geometry.getAttribute("uv") as THREE.BufferAttribute | undefined;
  if (!uvAttr || uvAttr.normalized) return false;
  for (let i = 0; i < uvAttr.count; i++) {
    const x = uvAttr.getX(i), y = uvAttr.getY(i);
    if (x < -SEED_STRIDE / 2 + 0.01 || x > SEED_STRIDE / 2 - 0.01) return false;
    if (y < -SEED_STRIDE / 2 + 0.01 || y > SEED_STRIDE / 2 - 0.01) return false;
  }
  const normal = geometry.getAttribute("normal");
  const n = new THREE.Vector3();
  const done = new Set<number>();
  for (const w of windows) {
    for (const v of w.vertices) {
      if (done.has(v)) continue;
      done.add(v);
      uvAttr.setX(v, uvAttr.getX(v) + w.seed * SEED_STRIDE);
      // the street side of the glass: uv.y shifted a whole stride, so the
      // shader draws a room behind it (and never behind the inside face)
      if (normal && n.fromBufferAttribute(normal, v).dot(w.normal) > 0) uvAttr.setY(v, uvAttr.getY(v) + SEED_STRIDE);
    }
  }
  uvAttr.needsUpdate = true;
  return true;
}

/** One geometry of light cards (shafts + halos) for a model's windows. */
export function windowCardGeometry(windows: WindowInfo[]): THREE.BufferGeometry | null {
  if (windows.length === 0) return null;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const corner = (c: THREE.Vector3, across: THREE.Vector3, up: THREE.Vector3, sx: number, sy: number, hw: number, hh: number) =>
    c.clone().addScaledVector(across, sx * hw).addScaledVector(up, sy * hh);
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, seed: number, halo: boolean) => {
    // a,b along the near edge, c,d the far edge (b→c, a→d)
    const base = positions.length / 3;
    const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(d, a)).normalize();
    const vOffset = halo ? 2 : 0;
    const offset = seed * SEED_STRIDE;
    const verts: [THREE.Vector3, number, number][] = [
      [a, 0.001, 0],
      [b, 0.999, 0],
      [c, 0.999, 1],
      [d, 0.001, 1],
    ];
    for (const [p, u, v] of verts) {
      positions.push(p.x, p.y, p.z);
      normals.push(normal.x, normal.y, normal.z);
      uvs.push(offset + u, vOffset + v);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  for (const w of windows) {
    const hw = w.width / 2, hh = w.height / 2;
    const near = w.centre.clone().addScaledVector(w.normal, 0.02);
    const reach = THREE.MathUtils.clamp(1.5 + w.height * 1.2, 2, 4);
    const dir = w.normal.clone().add(new THREE.Vector3(0, -0.55, 0)).normalize();
    const farCentre = near.clone().addScaledVector(dir, reach);
    const spread = 1.45;
    const n = (sx: number, sy: number) => corner(near, w.across, w.up, sx, sy, hw, hh);
    const f = (sx: number, sy: number) => corner(farCentre, w.across, w.up, sx, sy, hw * spread, hh * spread);
    quad(n(-1, 1), n(1, 1), f(1, 1), f(-1, 1), w.seed, false); // top
    quad(n(-1, -1), n(1, -1), f(1, -1), f(-1, -1), w.seed, false); // bottom
    quad(n(-1, -1), n(-1, 1), f(-1, 1), f(-1, -1), w.seed, false); // left
    quad(n(1, -1), n(1, 1), f(1, 1), f(1, -1), w.seed, false); // right
    // halo on the wall around the glass: u across, v up
    const h = w.centre.clone().addScaledVector(w.normal, 0.03);
    const hx = hw * HALO_SCALE, hy = hh * HALO_SCALE;
    quad(
      corner(h, w.across, w.up, -1, -1, hx, hy),
      corner(h, w.across, w.up, 1, -1, hx, hy),
      corner(h, w.across, w.up, 1, 1, hx, hy),
      corner(h, w.across, w.up, -1, 1, hx, hy),
      w.seed,
      true,
    );
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}
