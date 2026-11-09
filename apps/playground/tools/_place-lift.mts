/**
 * place-build `lift`: a winch LIFT (Thunder Bluff's elevators) beside a long descent — a structure kind of the place
 * builder, planned from two landings on the measured ground and gated by a real body riding it on the dedicated
 * server's own stepping. docs/place-builder.md "Lifts".
 *
 *   node node_modules/tsx/dist/cli.mjs tools/place-build.mts lift <plan|gate|install|uninstall> <world> --zone <z> --location <poi> --lift <id>
 *     plan  --top x,z --bottom x,z [--facing deg] [--exit front|back] [--top-y y] [--bottom-y y] [--speed 2.5] [--dwell 8]
 *           writes <job>/lifts/<id>.spec.json + <id>.ops.json + <id>.plan.json (faults: shaft not clear, landings
 *           not seated, drop too short). Never writes the world or the scene.
 *     gate  [--terrain-cache]  boots the live scene the way the server does, the lift's ops applied in memory, and rides
 *           a real player body top -> bottom -> top (walk on, ride, walk off at each end) -> <id>.gate.json; exit 1 on a fault
 *     install [--dry-run]  the lift's entities into the live scene (refused without a passing gate on the current ops);
 *           whatever this lift had (tag lift:<id>) is removed first; inverse in <id>.install-inverse.json
 *     uninstall            removes only
 *
 * The lift: a static root (tags lift, lift:<id>) holding the HEADFRAME behind the top deck (on the ground, never over
 * the drop) and the LANDING FRAME at the bottom exit; the DECK (kinematic box + the `lift` builtin, the cradle and the
 * stretched rope under it) and its two RAILS (kinematic boxes, same script and clock) are roots of their own so no
 * static batching ever takes them. A plumb shaft (`run` 0) when top and bottom share XZ; an inclined winch (the deck
 * stays level and runs out along its facing) when the bottom stands out from the top — a 70 degree slope has no room
 * for a plumb shaft in front of it.
 */
import fs from "node:fs";
import path from "node:path";
import { applyOps, applyRecipeEdits, ComponentRegistry, createWorldField, registerChunkComponents, registerCoreComponents, worldRecipeSchema } from "@hitreg/core";
import { findAsset, PROJECTS } from "./_closure.mjs";
import { prefabGeometry } from "./_prop-geometry.mts";
import { walkGround } from "./_ground.mts";

type V2 = [number, number];
type V3 = [number, number, number];

export interface LiftSpec {
  id: string;
  /** Deck centre XZ at the top landing. */
  top: V2;
  /** Deck centre XZ at the bottom landing (= top for a plumb shaft). */
  bottom: V2;
  /** Degrees (0 = +Z): the deck's facing, out from the cliff toward the drop. Default: top -> bottom; required for a plumb shaft. */
  facing?: number;
  /** Which side people step off at the bottom: `front` (away from the slope) or `back` (into a cave mouth under the top). */
  exit: "front" | "back";
  /** Deck top heights; default the ground at the entry (behind the top deck) and at the bottom exit. */
  topY?: number;
  bottomY?: number;
  speed: number;
  dwell: number;
  deck: { width: number; depth: number };
  headframe: string;
  cradle: string;
  rope: string;
  landing: string;
  /**
   * Carve the SHAFT through the rock (a world `passages` box, floor at the bottom landing, out through the ground at the
   * top): the deck runs inside it and the headframe straddles it, a mine's headframe. For a plumb lift down a face too
   * rough to hang a deck in front of (cliff noise), or down into a cave. Plumb only, facing on an axis.
   */
  shaft?: boolean;
  /** Plank bridge from the cliff edge out to the top deck, laid when the deck hangs clear of the edge. */
  gangway: string;
  zone?: string;
}

export const LIFT_DEFAULTS = {
  exit: "front" as const, speed: 2.5, dwell: 8, deck: { width: 3, depth: 3 },
  headframe: "codex-craft/lift-headframe", cradle: "codex-craft/lift-cradle", rope: "codex-craft/lift-rope", landing: "codex-craft/lift-landing-frame", gangway: "codex-craft/lift-gangway",
};
/** A gangway is laid when the top deck's back edge stands further than this off the cliff edge; it spans at most GANGWAY_MAX_M (two 3 m pieces, each landing 0.4 m on the ground). */
export const GANGWAY_MIN_M = 0.15;
export const GANGWAY_MAX_M = 5.6;
/** The deck box is this thick; its top is the floor. */
export const DECK_THICK = 0.2;
/** Terrain must stay this far under the deck's underside along the whole line (inset samples of the footprint). */
export const SHAFT_CLEAR_M = 0.3;
/** A landing frame or headframe may sink this far into higher ground on its footprint (never float: y = lowest ground); a 5.9 m headframe on a hill shoulder keeps 3.9 m under its beam. */
export const SINK_MAX_M = 2;
/** Shorter than this is a stair, not a lift. */
export const DROP_MIN_M = 6;
/** Gap between the deck's back edge and the headframe's footprint. */
const HEADFRAME_GAP_M = 0.4;

export interface LiftPlan {
  spec: LiftSpec;
  yaw: number;
  f: V2;
  /** Metres from the top deck's back edge to the cliff edge behind it (the gangway's span). */
  edge: number;
  gangway: boolean;
  deckTop: V3;
  deckBottom: V3;
  drop: number;
  run: number;
  length: number;
  cycle: number;
  /** Entry (behind the top deck) and exit (beside the bottom deck): where a rider stands before and after. */
  entry: V3;
  exit: V3;
  headframe: { at: V3; sink: number; size: V3 };
  landing: { at: V3; sink: number; size: V3 };
  ropeTo: V3;
  /** Smallest gap between terrain and the deck's underside along the line (negative = the deck runs into ground). */
  shaftClear: { min: number; at: V3 | null };
  faults: string[];
  ops: any[];
  /** Recipe edits the lift needs (the carved shaft); [] for a lift that hangs in the open. */
  worldOps: any[];
  /** The first rock (true 3D field) the deck or a rider on it would pass through, or null. */
  rock: V3 | null;
  /** Scene structures (colliders) in the lift's way: "<entity> in <volume>". */
  blocked: string[];
}

/** A scene collider's world box (axis-aligned bounds of its oriented box). */
export interface Obstacle { id: string; min: V3; max: V3 }
type Quat = [number, number, number, number];
function qrot(q: Quat, v: V3): V3 {
  const [x, y, z, w] = q, [vx, vy, vz] = v;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [vx + w * tx + (y * tz - z * ty), vy + w * ty + (z * tx - x * tz), vz + w * tz + (x * ty - y * tx)];
}
const qmul = (a: Quat, b: Quat): Quat => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
/**
 * The scene's solid colliders near `near` as world boxes (walls, kerbs, flights, piers, a bell-cote), so the planner sees
 * the STRUCTURES the heightfield and the rock field cannot (kirk-stair 2026-10-21: a bell-cote wall stopped the ride gate's
 * body at the deck's edge after the plan said ok). Triggers and this lift's own entities (`lift:<id>`) are left out.
 */
export function sceneObstacles(doc: { entities: Record<string, any> }, near: V2, radius: number, liftId: string): Obstacle[] {
  const E = doc.entities, out: Obstacle[] = [];
  const xf = (id: string): { p: V3; q: Quat; s: V3 } => {
    const chain: string[] = [];
    for (let e: string | null = id; e && E[e]; e = E[e].parent ?? null) chain.unshift(e);
    let p: V3 = [0, 0, 0], q: Quat = [0, 0, 0, 1], s: V3 = [1, 1, 1];
    for (const e of chain) {
      const t = E[e].components?.transform ?? {};
      const lp: V3 = t.position ?? [0, 0, 0], lq: Quat = t.rotation ?? [0, 0, 0, 1], ls: V3 = t.scale ?? [1, 1, 1];
      const sp = qrot(q, [lp[0] * s[0], lp[1] * s[1], lp[2] * s[2]]);
      p = [p[0] + sp[0], p[1] + sp[1], p[2] + sp[2]]; q = qmul(q, lq); s = [s[0] * ls[0], s[1] * ls[1], s[2] * ls[2]];
    }
    return { p, q, s };
  };
  for (const id of Object.keys(E)) {
    const c = E[id].components?.collider;
    if (!c || c.isTrigger || (E[id].tags ?? []).includes(`lift:${liftId}`)) continue;
    const { p, q, s } = xf(id);
    if (Math.hypot(p[0] - near[0], p[2] - near[1]) > radius) continue;
    const half: V3 = c.shape === "box" ? [c.size[0] / 2, c.size[1] / 2, c.size[2] / 2]
      : c.shape === "sphere" ? [c.radius, c.radius, c.radius]
      : c.shape === "capsule" || c.shape === "cylinder" ? [c.radius, (c.height ?? 0) / 2 + (c.shape === "capsule" ? c.radius : 0), c.radius]
      : [0, 0, 0];
    if (!(half[0] > 0)) continue; // meshes / heightfields: not a simple solid
    const o = c.offset ?? [0, 0, 0];
    const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
    for (const a of [-1, 1]) for (const b of [-1, 1]) for (const d of [-1, 1]) {
      const v = qrot(q, [(o[0] + a * half[0]) * s[0], (o[1] + b * half[1]) * s[1], (o[2] + d * half[2]) * s[2]]);
      for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], p[k] + v[k]); max[k] = Math.max(max[k], p[k] + v[k]); }
    }
    out.push({ id, min, max });
  }
  return out;
}

const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r2 = (v: number) => Math.round(v * 100) / 100;

function prefabSize(project: string, id: string): { size: V3; min: V3; max: V3 } {
  const file = findAsset(project, `prefabs/${id}.json`);
  if (!file) throw Error(`lift: prefab ${id} is not in ${project}'s closure (catalogue it first: props codex)`);
  const assets = path.resolve(path.dirname(file), ...id.split("/").map(() => ".."));
  const g = prefabGeometry(assets, id);
  if (!(g.max[1] - g.min[1] > 0)) throw Error(`lift: prefab ${id} measured empty (${g.warnings.join("; ")})`);
  return { size: [g.max[0] - g.min[0], g.max[1] - g.min[1], g.max[2] - g.min[2]], min: g.min as V3, max: g.max as V3 };
}

/**
 * Overrides that make a catalogued prop's meshes FOLLOW a moving parent: catalogue props are authored static (frozen,
 * batched, placed once as instances), so the cradle and rope under the deck stayed at the top on a client while the deck
 * body went down (kirk-stair lift-play 2026-10-22: no cradle around the rider mid-shaft).
 */
export function movingOverrides(project: string, id: string): Array<{ path: string; value: unknown }> {
  const file = findAsset(project, `prefabs/${id}.json`);
  if (!file) return [];
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  const out: Array<{ path: string; value: unknown }> = [];
  for (const [local, e] of Object.entries<any>(doc.entities ?? {})) {
    if (!e.components?.mesh) continue;
    out.push({ path: `${local}/components/mesh/moving`, value: true }, { path: `${local}/components/mesh/static`, value: false }, { path: `${local}/components/mesh/hlod`, value: false });
  }
  return out;
}

/** Lowest and highest ground under a rectangle (centre, half extents along the lift's axes). */
function footprint(ground: (x: number, z: number) => number, c: V2, f: V2, halfW: number, halfD: number): { lo: number; hi: number } {
  const rx: V2 = [f[1], -f[0]];
  let lo = Infinity, hi = -Infinity;
  for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
    const a = (i / 2) * halfW, b = (j / 2) * halfD;
    const h = ground(c[0] + rx[0] * a + f[0] * b, c[1] + rx[1] * a + f[1] * b);
    lo = Math.min(lo, h); hi = Math.max(hi, h);
  }
  return { lo, hi };
}

/** Plan a lift on the ground (pure but for the prefab sizes): heights, line, clearance, both landings seated, ops. */
export function planLift(project: string, spec: LiftSpec, ground: (x: number, z: number) => number, solid?: (x: number, y: number, z: number) => boolean, obstacles: Obstacle[] = []): LiftPlan {
  const faults: string[] = [];
  const dx = spec.bottom[0] - spec.top[0], dz = spec.bottom[1] - spec.top[1], run = Math.hypot(dx, dz);
  let f: V2;
  if (spec.facing !== undefined) f = [Math.sin((spec.facing * Math.PI) / 180), Math.cos((spec.facing * Math.PI) / 180)];
  else if (run > 0.5) f = [dx / run, dz / run];
  else throw Error(`lift ${spec.id}: a plumb shaft (top = bottom) needs --facing (degrees, out from the cliff)`);
  if (run > 0.5 && (dx * f[0] + dz * f[1]) / run < 0.999) faults.push(`FACING: the bottom is not straight out along the facing (a lift runs on one line)`);
  const shaft = !!spec.shaft;
  if (shaft && (run > 0.5 || Math.abs(Math.abs(f[0]) - Math.round(Math.abs(f[0]))) > 1e-6)) faults.push("SHAFT-AXIS: a carved shaft is plumb (top = bottom) with a facing of 0, 90, 180 or 270");
  const yaw = Math.atan2(f[0], f[1]);
  const { width, depth } = spec.deck, hd = depth / 2;
  const at = (c: V2, d: number): V2 => [c[0] + f[0] * d, c[1] + f[1] * d];
  // the EDGE: the first ground behind the deck that is walkable (no ground in the 10 m behind it rises faster than 0.6 m per metre);
  // the top landing is that ground (the deck lies flush with it)
  const g = (d: number) => ground(...at(spec.top, -(hd + d)));
  let edge = 0;
  const steep = (d: number) => [1, 2, 3, 4, 5, 6, 8, 10].some((k) => g(d + k) - g(d) > 0.6 * k);
  if (!shaft) while (edge < 7 && steep(edge)) edge += 0.1;
  const topY = spec.topY ?? (shaft ? ground(spec.top[0], spec.top[1]) : g(edge + 0.3));
  edge = r2(edge);
  if (edge > GANGWAY_MAX_M) faults.push(`EDGE: the top deck's back edge stands ${edge} m off the cliff edge (a gangway spans ${GANGWAY_MAX_M} m): move the deck in`);
  // a carved shaft always gets one: the coarse voxel rim bevels down into the shaft, and a body stalls at that lip
  const gang = shaft || edge > GANGWAY_MIN_M;
  const entryXZ = at(spec.top, -(hd + edge + 1.2));
  const exitXZ = at(spec.bottom, spec.exit === "front" ? hd + 1.2 : -(hd + 1.2));
  // the bottom: the deck comes to rest on the highest ground under it (never sunk into the slope's toe), the exit beside it
  const bottomY = spec.bottomY ?? Math.max(ground(exitXZ[0], exitXZ[1]), footprint(ground, spec.bottom, f, width / 2 - 0.3, hd - 0.3).hi);
  const drop = topY - bottomY;
  if (drop < DROP_MIN_M) faults.push(`DROP: ${r2(drop)} m from top to bottom (< ${DROP_MIN_M} m: a stair, not a lift)`);
  const deckTop: V3 = [spec.top[0], topY, spec.top[1]], deckBottom: V3 = [spec.bottom[0], bottomY, spec.bottom[1]];
  const length = Math.hypot(drop, run);

  // the shaft: every inset footprint sample stays SHAFT_CLEAR_M under the deck's underside along the whole line
  let min = Infinity, minAt: V3 | null = null;
  const steps = Math.max(2, Math.ceil(length / 0.5));
  const rx: V2 = [f[1], -f[0]];
  for (let s = 0; s <= steps && !shaft; s++) {
    const t = s / steps, cx = deckTop[0] + (deckBottom[0] - deckTop[0]) * t, cz = deckTop[2] + (deckBottom[2] - deckTop[2]) * t;
    const under = topY + (bottomY - topY) * t - DECK_THICK;
    for (const a of [-0.5, 0, 0.5]) for (const b of [-0.5, 0, 0.5]) {
      const ox = a * (width - 0.6), oz = b * (depth - 0.6);
      const x = cx + rx[0] * ox + f[0] * oz, z = cz + rx[1] * ox + f[1] * oz;
      // the last metre down the deck settles onto the bottom landing: there the ground may come up to its floor
      const settling = under + DECK_THICK - bottomY < 1;
      const gap = under - ground(x, z) + (settling ? DECK_THICK + SHAFT_CLEAR_M : 0);
      if (gap < min) { min = gap; minAt = [r2(x), r2(ground(x, z)), r2(z)]; }
    }
  }
  if (shaft) min = Infinity;
  // the TRUE ground (3D: cliff noise, overhangs, carved caves): nothing solid in the deck or in a rider's body on it
  let rock: V3 | null = null;
  if (solid && !shaft) {
    for (let s = 0; s <= steps && !rock; s++) {
      const t = s / steps, cx = deckTop[0] + (deckBottom[0] - deckTop[0]) * t, cz = deckTop[2] + (deckBottom[2] - deckTop[2]) * t;
      const top = topY + (bottomY - topY) * t;
      for (const a of [-0.5, 0, 0.5]) for (const b of [-0.5, 0, 0.5]) for (const dy of [-DECK_THICK / 2, 0.5, 1.2, 1.9]) {
        if (rock) break;
        const x = cx + rx[0] * a * (width - 0.4) + f[0] * b * (depth - 0.4), z = cz + rx[1] * a * (width - 0.4) + f[1] * b * (depth - 0.4);
        if (dy < 0 && top - bottomY < 1) continue; // the settling deck may meet the landing's ground
        if (solid(x, top + dy, z)) rock = [r2(x), r2(top + dy), r2(z)];
      }
    }
    if (rock) faults.push(`ROCK: the deck (or a rider on it) passes through rock at ${JSON.stringify(rock)} (the cliff face's noise / an overhang): move the line out, or carve a shaft (--shaft)`);
  }
  if (min < SHAFT_CLEAR_M) faults.push(`SHAFT: the deck's line runs ${r2(SHAFT_CLEAR_M - min)} m too close to the ground at ${JSON.stringify(minAt)} (clear ${r2(min)} m < ${SHAFT_CLEAR_M}): move the line out from the slope or the bottom further out`);

  // headframe: on the ground BEHIND the top deck (never over the drop), seated on its lowest ground
  const hf = prefabSize(project, spec.headframe), lf = prefabSize(project, spec.landing), cr = prefabSize(project, spec.cradle);
  const hfBack = shaft ? 0 : hd + edge + HEADFRAME_GAP_M + hf.size[2] / 2; // a shaft's headframe straddles it
  const hfC = at(spec.top, -hfBack);
  const hfG = footprint(ground, hfC, f, hf.size[0] / 2, hf.size[2] / 2);
  const headframe = { at: [r3(hfC[0]), r3(hfG.lo), r3(hfC[1])] as V3, sink: r2(hfG.hi - hfG.lo), size: hf.size };
  if (headframe.sink > SINK_MAX_M) faults.push(`HEADFRAME: its ground rises ${headframe.sink} m across its footprint (> ${SINK_MAX_M}): level the top landing or move the lift`);
  if (topY - hfG.lo > 1.0 || hfG.hi - topY > SINK_MAX_M) faults.push(`HEADFRAME: its ground (${r2(hfG.lo)}..${r2(hfG.hi)}) is not at the top landing (${r2(topY)})`);
  // landing frame: at the bottom exit, on the exit side
  const lfC = at(spec.bottom, (spec.exit === "front" ? 1 : -1) * (hd + 0.3 + lf.size[2] / 2));
  const lfG = spec.bottomY !== undefined ? { lo: spec.bottomY, hi: spec.bottomY } : footprint(ground, lfC, f, lf.size[0] / 2, lf.size[2] / 2);
  const landing = { at: [r3(lfC[0]), r3(lfG.lo), r3(lfC[1])] as V3, sink: r2(lfG.hi - lfG.lo), size: lf.size };
  if (landing.sink > SINK_MAX_M) faults.push(`LANDING: its ground rises ${landing.sink} m across its footprint (> ${SINK_MAX_M})`);
  if (Math.abs(lfG.lo - bottomY) > 1.0) faults.push(`LANDING: its ground (${r2(lfG.lo)}) is not at the bottom landing (${r2(bottomY)})`);

  // the rope ends at the wheel: the headframe's top centre, in the deck's own frame from its TOP position
  const ropeTo: V3 = [0, r3(headframe.at[1] + hf.size[1] * 0.9 - topY), r3(-hfBack)];
  const cycle = 2 * (length / spec.speed + spec.dwell);
  const entry: V3 = [r3(entryXZ[0]), r3(topY), r3(entryXZ[1])], exit: V3 = [r3(exitXZ[0]), r3(bottomY), r3(exitXZ[1])];

  // the STRUCTURES: no scene collider in a rider's volume on either deck, in the swept shaft, on the walk on / off, or
  // under the headframe / landing frame (0.1 m of grace over the floor so a flush kerb or slab is not a fault)
  const blocked: string[] = [];
  const box = (c: V2, halfW: number, halfD: number, y0: number, y1: number): { min: V3; max: V3 } => {
    const ex = Math.abs(f[1]) * halfW + Math.abs(f[0]) * halfD, ez = Math.abs(f[0]) * halfW + Math.abs(f[1]) * halfD;
    return { min: [c[0] - ex, y0, c[1] - ez], max: [c[0] + ex, y1, c[1] + ez] };
  };
  const span = (a: V2, b: V2, half: number, y0: number, y1: number) => {
    const m = box(a, half, half, y0, y1), n = box(b, half, half, y0, y1);
    return { min: [Math.min(m.min[0], n.min[0]), y0, Math.min(m.min[2], n.min[2])] as V3, max: [Math.max(m.max[0], n.max[0]), y1, Math.max(m.max[2], n.max[2])] as V3 };
  };
  const vols: Array<[string, { min: V3; max: V3 }]> = [
    ["the top deck", box(spec.top, width / 2, hd, topY + 0.1, topY + 2)],
    ["the bottom deck", box(spec.bottom, width / 2, hd, bottomY + 0.1, bottomY + 2)],
    ["the walk on at the top", span(entryXZ, spec.top, 0.6, topY + 0.1, topY + 1.9)],
    ["the walk off at the bottom", span(exitXZ, spec.bottom, 0.6, bottomY + 0.1, bottomY + 1.9)],
    // the line the deck and a rider sweep, in short pieces so an inclined line's box stays tight to it
    ...Array.from({ length: 12 }, (_, k): [string, { min: V3; max: V3 }] => {
      const t0 = k / 12, t1 = (k + 1) / 12, lerp = (t: number): V2 => [spec.top[0] + (spec.bottom[0] - spec.top[0]) * t, spec.top[1] + (spec.bottom[1] - spec.top[1]) * t];
      const y0 = topY + (bottomY - topY) * t1 - DECK_THICK - 0.1, y1 = topY + (bottomY - topY) * t0 + 2;
      return ["the shaft", span(lerp(t0), lerp(t1), Math.max(width, depth) / 2, Math.max(y0, bottomY + 0.1), Math.min(y1, topY - 0.1))];
    }),
    ["the headframe", box(hfC, hf.size[0] / 2, hf.size[2] / 2, headframe.at[1] + 0.1 + headframe.sink, headframe.at[1] + hf.size[1])],
    ["the landing frame", box(lfC, lf.size[0] / 2, lf.size[2] / 2, landing.at[1] + 0.1 + landing.sink, landing.at[1] + lf.size[1])],
  ];
  for (const [name, v] of vols) for (const o of obstacles)
    if (o.min[0] < v.max[0] && o.max[0] > v.min[0] && o.min[1] < v.max[1] && o.max[1] > v.min[1] && o.min[2] < v.max[2] && o.max[2] > v.min[2]) { const m = `${o.id} in ${name}`; if (!blocked.includes(m)) blocked.push(m); }
  if (blocked.length) faults.push(`STRUCTURE: scene structures stand in the lift's way: ${blocked.slice(0, 8).join("; ")}${blocked.length > 8 ? ` (+${blocked.length - 8})` : ""}: move the lift or the structure`);

  // ---- ops ----
  const id = spec.id, tags = (...more: string[]) => ["lift", `lift:${id}`, ...(spec.zone ? [`zone:${spec.zone}`] : []), ...more];
  const q: [number, number, number, number] = [0, r3(Math.sin(yaw / 2)), 0, r3(Math.cos(yaw / 2))];
  const params = { drop: r3(drop), run: r3(run), speed: spec.speed, dwell: spec.dwell, ropeTo };
  const deckY = r3(topY - DECK_THICK / 2);
  const cradleY = r3(-DECK_THICK / 2 - cr.min[1]); // the cradle's floor bottom on the deck box's underside
  const local = (x: number, y: number, z: number): V3 => [r3(deckTop[0] + rx[0] * x + f[0] * z), r3(y), r3(deckTop[2] + rx[1] * x + f[1] * z)];
  const ops: any[] = [
    { op: "add-entity", id: `lift-${id}`, entity: { name: `Lift ${id}`, parent: null, tags: tags(), components: { transform: { position: deckTop.map(r3) } } } },
    { op: "add-entity", id: `lift-${id}-headframe`, entity: { name: "lift headframe", parent: `lift-${id}`, tags: tags(), components: { transform: { position: [r3(headframe.at[0] - deckTop[0]), r3(headframe.at[1] - topY), r3(headframe.at[2] - deckTop[2])], rotation: q }, prefab: { prefabId: spec.headframe, props: {} } } } },
    { op: "add-entity", id: `lift-${id}-landing`, entity: { name: "lift landing frame", parent: `lift-${id}`, tags: tags(), components: { transform: { position: [r3(landing.at[0] - deckTop[0]), r3(landing.at[1] - topY), r3(landing.at[2] - deckTop[2])], rotation: q }, prefab: { prefabId: spec.landing, props: {} } } } },
    { op: "add-entity", id: `lift-${id}-deck`, entity: { name: "lift deck", parent: null, tags: tags("lift-deck"), components: {
      transform: { position: [deckTop[0], deckY, deckTop[2]].map(r3), rotation: q },
      rigidbody: { kind: "kinematic" }, collider: { shape: "box", size: [width, DECK_THICK, depth] },
      script: { name: "lift", params } } } },
    { op: "add-entity", id: `lift-${id}-cradle`, entity: { name: "lift cradle", parent: `lift-${id}-deck`, tags: tags(), components: { transform: { position: [0, cradleY, 0] }, prefab: { prefabId: spec.cradle, props: {}, overrides: movingOverrides(project, spec.cradle) } } } },
    { op: "add-entity", id: `lift-${id}-rope`, entity: { name: "lift rope", parent: `lift-${id}-deck`, tags: tags("lift-rope"), components: { transform: { position: [0, r3(cradleY + cr.max[1] - 0.15), 0] }, prefab: { prefabId: spec.rope, props: {}, overrides: movingOverrides(project, spec.rope) } } } },
  ];
  if (gang) {
    // its walking surface (0.25 m over its base, the prop's contract) flush with the deck; it starts at the deck's back edge and runs back over the cliff edge onto the ground
    const gw = prefabSize(project, spec.gangway), n = Math.max(1, Math.ceil((edge + 0.4) / gw.size[2]));
    for (let k = 0; k < n; k++) {
      const c = at(spec.top, -(hd + gw.size[2] * (k + 0.5) + 0.05));
      ops.push({ op: "add-entity", id: `lift-${id}-gangway${k ? `-${k + 1}` : ""}`, entity: { name: "lift gangway", parent: `lift-${id}`, tags: tags(), components: { transform: { position: [r3(c[0] - deckTop[0]), r3(-0.25 - gw.min[1]), r3(c[1] - deckTop[2])], rotation: q }, prefab: { prefabId: spec.gangway, props: {} } } } });
    }
  }
  for (const [side, sx] of [["l", -1], ["r", 1]] as const) {
    const p = local(sx * (width / 2 - 0.06), topY + 0.55, 0);
    ops.push({ op: "add-entity", id: `lift-${id}-rail-${side}`, entity: { name: `lift rail ${side}`, parent: null, tags: tags(), components: {
      transform: { position: p, rotation: q }, rigidbody: { kind: "kinematic" }, collider: { shape: "box", size: [0.12, 1.1, depth] },
      script: { name: "lift", params } } } });
  }
  const worldOps: any[] = [];
  if (shaft) {
    // a box passage along the facing axis: floor = the bottom landing, protected height through the top ground; 0.3 m round the deck
    const L = depth + 0.6, W = width + 0.6, ax = Math.abs(f[0]) > 0.5 ? "x" : "z", dir = (ax === "x" ? f[0] : f[1]) > 0 ? 1 : -1;
    const st = at(spec.bottom, -L / 2);
    let seed = 0; for (const ch of id) seed = (seed * 31 + ch.charCodeAt(0)) % 100000;
    worldOps.push({ edit: "add-feature", kind: "passages", feature: { id: `lift-${id}-shaft`, start: [r3(st[0]), r3(bottomY), r3(st[1])], axis: ax, direction: dir, footprint: "box", length: L, width: W, height: r2(topY - bottomY + 4), wallNoise: 0, noiseDetail: 0.3, roofRise: 0, roofNoise: 0, noiseScale: 5, seed, falloff: 4, connectionBand: 0.5 } });
  }
  return { spec, yaw, f, edge, gangway: gang, worldOps, rock, blocked, deckTop, deckBottom, drop: r2(drop), run: r2(run), length: r2(length), cycle: r2(cycle), entry, exit, headframe, landing, ropeTo, shaftClear: { min: r2(min), at: minAt }, faults, ops };
}

// ---------------------------------------------------------------------------------------------------------------------
// the command (place-build.mts lift ...)

const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8").replace(/^﻿/, ""));
const write = (f: string, v: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1) + "\n"); };

export async function liftCommand(argv: string[]): Promise<void> {
  const sub = argv[0], world = argv[1] ?? "";
  const opt = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  const has = (n: string) => argv.includes(`--${n}`);
  const fail = (why: string): never => { console.error(`STOP: ${why}`); process.exit(1); };
  const project = opt("project") ?? world, zone = opt("zone") ?? "", poi = opt("location") ?? "", id = opt("lift") ?? "";
  if (!sub || !world || !zone || !poi || !id) fail("usage: place-build lift <plan|gate|install|uninstall> <world> --zone <z> --location <poi> --lift <id> ...");
  const JOB = path.join(PROJECTS, project, "authoring", "zonegen", world, "zones", zone, "pois", poi), DIR = path.join(JOB, "lifts");
  const file = (k: string) => path.join(DIR, `${id}.${k}.json`);
  const SF = path.join(PROJECTS, project, "assets", "scenes", `${world}.scene.json`), WF = path.join(PROJECTS, project, "assets", "worlds", `${world}.json`);
  const v2 = (s: string | undefined, what: string): V2 => { const p = (s ?? "").split(",").map(Number); if (p.length !== 2 || p.some((n) => !Number.isFinite(n))) fail(`--${what} x,z`); return p as V2; };

  if (sub === "plan") {
    const prev: Partial<LiftSpec> = fs.existsSync(file("spec")) ? read(file("spec")) : {};
    const num = (n: string) => (opt(n) !== undefined ? Number(opt(n)) : undefined);
    const spec: LiftSpec = {
      ...LIFT_DEFAULTS, ...prev, id, zone,
      top: opt("top") ? v2(opt("top"), "top") : (prev.top ?? fail("--top x,z")),
      bottom: opt("bottom") ? v2(opt("bottom"), "bottom") : (prev.bottom ?? fail("--bottom x,z")),
      ...(num("facing") !== undefined ? { facing: num("facing") } : {}),
      ...(opt("exit") ? { exit: opt("exit") as "front" | "back" } : {}),
      ...(num("top-y") !== undefined ? { topY: num("top-y") } : {}),
      ...(num("bottom-y") !== undefined ? { bottomY: num("bottom-y") } : {}),
      ...(num("speed") !== undefined ? { speed: num("speed")! } : {}),
      ...(num("dwell") !== undefined ? { dwell: num("dwell")! } : {}),
      ...(has("shaft") ? { shaft: true } : {}),
    };
    const field = createWorldField(worldRecipeSchema.parse(read(WF)));
    const obstacles = sceneObstacles(read(SF), spec.top, Math.hypot(spec.bottom[0] - spec.top[0], spec.bottom[1] - spec.top[1]) + 30, id);
    const plan = planLift(project, spec, walkGround(field), (x, y, z) => field.density(x, y, z) < 0, obstacles);
    write(file("spec"), spec);
    write(file("ops"), plan.ops);
    write(file("world-ops"), plan.worldOps);
    const { ops: _ops, worldOps: _w, ...report } = plan;
    write(file("plan"), { ...report, at: new Date().toISOString() });
    console.log(`lift ${id}: ${plan.drop} m down, ${plan.run} m out (${plan.length} m line, ${spec.speed} m/s, dwell ${spec.dwell} s: cycle ${plan.cycle} s)`);
    console.log(`  top deck ${JSON.stringify(plan.deckTop)}  bottom deck ${JSON.stringify(plan.deckBottom)}  entry ${JSON.stringify(plan.entry)}  exit ${JSON.stringify(plan.exit)} (${spec.exit})`);
    if (plan.worldOps.length) console.log(`  carved shaft: ${plan.worldOps.map((o: any) => `${o.feature.id} ${o.feature.width} x ${o.feature.length} m, ${o.feature.height} m tall from ${JSON.stringify(o.feature.start)}`).join("; ")}`);
    console.log(`  shaft clear ${plan.shaftClear.min} m (min ${SHAFT_CLEAR_M})  headframe ${JSON.stringify(plan.headframe.at)} sink ${plan.headframe.sink}  landing ${JSON.stringify(plan.landing.at)} sink ${plan.landing.sink}`);
    console.log(plan.faults.length ? plan.faults.map((x) => `  FAULT ${x}`).join("\n") : "  plan ok");
    process.exitCode = plan.faults.length ? 1 : 0;
    return;
  }
  if (!fs.existsSync(file("ops"))) fail(`no plan for lift ${id} (place-build lift plan ...)`);
  const ops = read(file("ops")) as any[];
  const worldOps = (fs.existsSync(file("world-ops")) ? read(file("world-ops")) : []) as any[];
  const digest = (await import("node:crypto")).createHash("sha1").update(JSON.stringify(ops) + (worldOps.length ? JSON.stringify(worldOps) : "")).digest("hex").slice(0, 10);

  if (sub === "gate") {
    const plan = read(file("plan")) as Omit<LiftPlan, "ops" | "worldOps">;
    if (plan.faults.length) fail(`the plan has faults: ${plan.faults.join("; ")}`);
    // a lift already installed (a re-gate after the ops changed): ride the NEW ops, the installed entities and shaft taken out first
    const scene = read(SF), wdoc = read(WF);
    const own = Object.keys(scene.entities).filter((e) => (scene.entities[e].tags ?? []).includes(`lift:${id}`));
    const gateOps = [...own.filter((e) => !own.includes(scene.entities[e].parent)).map((e) => ({ op: "remove-entity", id: e })), ...ops];
    const gateWorld = [
      ...Object.entries(wdoc.features ?? {}).flatMap(([kind, v]) => (Array.isArray(v) ? v : []).filter((f: any) => typeof f?.id === "string" && f.id.startsWith(`lift-${id}-`)).map((f: any) => ({ edit: "remove-feature", kind, id: f.id }))),
      ...worldOps,
    ];
    const result = await rideGate(world, project, gateOps, gateWorld, plan, has("terrain-cache") && !gateWorld.length);
    write(file("gate"), { ...result, ops: digest, at: new Date().toISOString() });
    console.log(`GATE lift ${id}: ${result.ok ? "PASS" : "FAIL"}  ${result.line}`);
    for (const x of result.faults) console.log(`  FAULT ${x}`);
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  if (sub === "install" || sub === "uninstall") {
    const remove = sub === "uninstall";
    if (!remove) {
      const gate = fs.existsSync(file("gate")) ? read(file("gate")) : null;
      if (!gate?.ok) fail(`no passing ride gate for lift ${id} (place-build lift gate ...)`);
      if (gate.ops !== digest) fail(`the ride gate (ops ${gate.ops}) is older than the ops (${digest}): gate again`);
    }
    const reg = new ComponentRegistry(); registerCoreComponents(reg); registerChunkComponents(reg);
    const { updateJsonFile } = await import("./_scene-write.mts");
    const label = `place-build lift ${sub} ${id}`;
    const removesOf = (scene: any) => {
      const own = Object.keys(scene.entities).filter((e) => (scene.entities[e].tags ?? []).includes(`lift:${id}`));
      const depth = (e: string): number => (scene.entities[e]?.parent ? 1 + depth(scene.entities[e].parent) : 0);
      return { own, removes: own.filter((e) => !own.includes(scene.entities[e].parent)).sort((a, b) => depth(b) - depth(a)).map((e) => ({ op: "remove-entity", id: e })) };
    };
    if (has("dry-run")) { console.log(`[dry-run] ${SF}: remove ${removesOf(read(SF)).removes.length} root(s) of lift ${id}${remove ? "" : `, add ${ops.length} entities, ${worldOps.length} world feature(s)`}`); return; }
    // the world: this lift's own features (ids lift-<id>-*) out, then its world ops in (validated by applyRecipeEdits); under the file lock
    const ownW = (f: any) => typeof f?.id === "string" && f.id.startsWith(`lift-${id}-`);
    let wOut = 0;
    updateJsonFile(WF, (wdoc: any) => {
      const gone: string[] = [];
      for (const [k, v] of Object.entries(wdoc.features ?? {})) if (Array.isArray(v)) { const keep = v.filter((f) => !ownW(f)); for (const f of v) if (ownW(f)) gone.push(f.id); wdoc.features[k] = keep; }
      wOut = gone.length;
      if (!remove && worldOps.length) {
        const parsed = applyRecipeEdits(worldRecipeSchema.parse(wdoc), worldOps as never);
        for (const o of worldOps) (wdoc.features[o.kind] ??= []).push((parsed.recipe.features as any)[o.kind].find((f: any) => f.id === o.feature.id));
      }
      return { doc: wdoc, removed: gone };
    }, { label });
    let removes: any[] = [];
    const res = updateJsonFile(SF, (scene: any) => {
      const r = removesOf(scene);
      removes = r.removes;
      const out = applyOps(scene, [...removes, ...(remove ? [] : ops)] as never, reg);
      return { doc: out.doc, inverse: out.inverse, removed: r.own };
    }, { label });
    write(file(remove ? "uninstall-inverse" : "install-inverse"), res.inverse);
    console.log(`${remove ? "uninstalled" : "installed"} lift ${id}: ${removes.length} root(s) + ${wOut} world feature(s) out${remove ? "" : `, ${ops.length} entities + ${worldOps.length} world feature(s) in (ops ${digest})`}; scene inverse ${file(remove ? "uninstall-inverse" : "install-inverse")}`);
    return;
  }
  fail(`unknown lift command ${sub}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// the ride gate: a real body on the server's stepping

export interface RideResult { ok: boolean; line: string; faults: string[]; trace: number[][]; legs: Array<{ leg: string; ok: boolean; rideS: number; worstGap: number; end: V3; want: V3; note: string }> }

async function rideGate(world: string, project: string, ops: any[], worldOps: any[], plan: Omit<LiftPlan, "ops" | "worldOps">, terrainCache: boolean): Promise<RideResult> {
  const { bootServerBody } = await import("./_server-boot.mts");
  const playground = path.resolve(PROJECTS, "..");
  const sb = await bootServerBody({ playground, scene: world, peer: "lift-gate", docOps: ops, recipeEdits: worldOps, terrainCache, log: (s) => console.log(s) });
  const deckId = `lift-${plan.spec.id}-deck`;
  const deckPos = (): V3 => sb.world.sim.getPosition(deckId) as V3;
  if (!deckPos()) throw Error(`the deck ${deckId} has no body in the booted world`);
  const f = plan.f, TICK = 1 / 60;
  const faults: string[] = [];
  const legs: RideResult["legs"] = [];
  /** [t, feet x, y, z, deck top y] every half second of each ride */
  const trace: number[][] = [];
  const deckTopY = () => deckPos()[1] + DECK_THICK / 2;
  const atTop = () => Math.abs(deckTopY() - plan.deckTop[1]) < 0.02;
  const atBottom = () => Math.abs(deckTopY() - plan.deckBottom[1]) < 0.02;
  const waitFor = (cond: () => boolean, maxS: number): boolean => { for (let i = 0; i < maxS * 60; i++) { if (cond()) return true; sb.stepWith([0, 0], false); } return cond(); };
  /** Walk with the stick toward (x,z) until within tol (XZ) or out of time. */
  const walkTrace: string[] = [];
  const walkTo = (x: number, z: number, tol: number, maxS: number): boolean => {
    for (let i = 0; i < maxS * 60; i++) {
      const p = sb.feet(), dx = x - p[0], dz = z - p[2], d = Math.hypot(dx, dz);
      if (d < tol) { sb.stepWith([0, 0], false); return true; }
      sb.stepWith([dx / d, dz / d], false);
      if (i % 15 === 0) walkTrace.push(sb.feet().map(r2).join(","));
    }
    return false;
  };
  sb.calibrate(plan.entry[0] - f[0] * 2, plan.entry[2] - f[1] * 2);
  sb.holdAt([plan.entry[0], plan.entry[1] + 1.2, plan.entry[2]]);
  for (let i = 0; i < 60; i++) sb.stepWith([0, 0], false);

  /** What stands between the body and (x, z): rays at shin, waist and chest height. */
  const blocker = (to: V3): string => {
    const p = sb.feet(), dx = to[0] - p[0], dz = to[2] - p[2], l = Math.hypot(dx, dz) || 1;
    return [0.3, 0.9, 1.5].map((h) => { const hit = sb.world.sim.raycast([p[0], p[1] + h, p[2]], [dx / l, 0, dz / l], 2, { exclude: [sb.bodyId] }); return hit ? `${h} m: ${hit.entityId} at ${r2(hit.distance)} m` : `${h} m: clear`; }).join(", ") + `; touching: ${(sb.world.sim.overlapSphere?.([p[0], p[1] + 0.9, p[2]], 0.6, { exclude: [sb.bodyId] }) ?? []).join(", ") || "nothing"}`;
  };
  const ride = (leg: string, from: "top" | "bottom", off: V3): void => {
    const atStart = from === "top" ? atTop : atBottom, atEnd = from === "top" ? atBottom : atTop;
    // wait for the deck to ARRIVE at this landing (a fresh dwell), then step on
    if (!atStart()) { if (!waitFor(atStart, plan.cycle + 2)) { faults.push(`${leg}: the deck never reached the ${from} landing`); return; } }
    else { waitFor(() => !atStart(), plan.cycle); waitFor(atStart, plan.cycle + 2); }
    const d = deckPos();
    if (!walkTo(d[0], d[2], 0.4, plan.spec.dwell - 1)) { faults.push(`${leg}: could not walk onto the deck in its ${plan.spec.dwell} s dwell (feet ${JSON.stringify(sb.feet().map(r2))}; in the way: ${blocker(d)}; walked ${walkTrace.slice(-10).join(" > ")})`); return; }
    let worst = 0, ticks = 0;
    trace.push([-1, ...sb.feet().map(r2), r2(deckTopY())]);
    // ride: the feet stay on the deck while it moves
    const leftStart = waitFor(() => !atStart(), plan.spec.dwell + 2);
    if (!leftStart) { faults.push(`${leg}: the deck never left`); return; }
    while (!atEnd() && ticks < (plan.length / plan.spec.speed + 4) * 60) {
      sb.stepWith([0, 0], false); ticks++;
      if (ticks % 30 === 1) trace.push([r2(ticks * TICK), ...sb.feet().map(r2), r2(deckTopY())]);
      worst = Math.max(worst, Math.abs(sb.feet()[1] - deckTopY()));
      const p = sb.feet(), dp = deckPos();
      if (Math.hypot(p[0] - dp[0], p[2] - dp[2]) > plan.spec.deck.width / 2 + 0.3) { faults.push(`${leg}: the body left the deck mid-ride at ${JSON.stringify(p.map(r2))}`); break; }
    }
    for (let i = 0; i < 20; i++) sb.stepWith([0, 0], false);
    // the body must be OFF the deck within the dwell; the rest of the walk (a long gangway to the entry) may take longer
    // (o-coast2 2026-10-31: sunwine-hold's 6.6 m gangway walk ran out of dwell 1.3 m short of the entry, on solid ground)
    const offDeck = (): boolean => {
      const p = sb.feet(), dp = deckPos(), rx = p[0] - dp[0], rz = p[2] - dp[2];
      return Math.abs(rx * f[0] + rz * f[1]) > plan.spec.deck.depth / 2 + 0.3 || Math.abs(rx * f[1] - rz * f[0]) > plan.spec.deck.width / 2 + 0.3;
    };
    const walked = walkTo(off[0], off[2], 0.6, plan.spec.dwell - 2) || (offDeck() && walkTo(off[0], off[2], 0.6, 10));
    for (let i = 0; i < 30; i++) sb.stepWith([0, 0], false);
    const end = sb.feet();
    const ok = walked && worst < 0.35 && Math.abs(end[1] - off[1]) < 0.8 && Math.hypot(end[0] - off[0], end[2] - off[2]) < 1.2;
    legs.push({ leg, ok, rideS: r2(ticks * TICK), worstGap: r2(worst), end: end.map(r2) as V3, want: off, note: walked ? "" : "did not reach the landing" });
    if (!ok) faults.push(`${leg}: ended ${JSON.stringify(end.map(r2))} for ${JSON.stringify(off)} (worst feet-to-deck ${r2(worst)} m${walked ? "" : ", never reached the landing"})`);
  };
  ride("down", "top", plan.exit);
  if (!faults.length) ride("up", "bottom", plan.entry);
  const ok = !faults.length && legs.length === 2 && legs.every((l) => l.ok);
  const line = legs.map((l) => `${l.leg} ${l.ok ? "ok" : "FAIL"} ${l.rideS} s ride, feet within ${l.worstGap} m of the deck, off at ${JSON.stringify(l.end)}`).join("; ") || "no leg ridden";
  return { ok, line, faults, legs, trace };
}
