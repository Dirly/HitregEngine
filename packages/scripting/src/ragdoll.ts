import * as THREE from "three";
import { Script, type SimRagdollSpec } from "./script.js";

/**
 * RAGDOLL DEATHS (opt-in per prefab; voxel-demo mobs carry it by default, see
 * docs/mob-ai.md "Death: ragdoll or clip"). A cosmetic, per-client fall: the server
 * still decides the death and the loot; every tab turns its OWN animated pose
 * into a few capsule bodies at the moment of death, lets them drop onto the
 * real ground, and freezes the result. Nothing is replicated, so two players
 * may see the same wolf land slightly differently — the price of zero
 * bandwidth and zero authority cost.
 *
 * Two halves:
 * - {@link planRagdoll} (pure, rig-agnostic): which bones get a body, how long
 *   and thick each is, what each joint may do. Driven by the skeleton's own
 *   shape, not by bone-name tables, so a CC_Base human, a Quaternius
 *   quadruped and a bear all plan from the same code. Planned ONCE per
 *   model, in the bind pose, and cached.
 * - {@link RagdollScript} (`ragdoll` builtin): watches for the death, plays a
 *   short animated lead-in, builds the bodies from the pose at that instant
 *   (with the pose's own motion plus the killing blow), drives the bones from
 *   the bodies, and once the bodies come to rest removes them and leaves the
 *   pose where it fell — a settled corpse costs no physics and no mixer.
 */

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export type V3 = [number, number, number];

export interface RagdollBoneInput {
  name: string;
  /** Index of the parent bone in the same array, -1 for a root. */
  parent: number;
  /** World (or any one consistent space) position of the bone's head. */
  position: V3;
}

export type RagdollRole = "core" | "limb" | "head" | "tail";

export interface RagdollPlanBody {
  /** The bone whose head is this body's origin and whose transform it drives. */
  bone: number;
  /** Plan index of the body this one is jointed to, -1 for the root body. */
  parent: number;
  /** The capsule runs from `bone`'s head toward the mean of these bones' heads ... */
  endBones: number[];
  /**
   * ... or, for a chain end with nothing below it, this far along the incoming
   * direction (a fraction of the plan size). 0 when `endBones` is used.
   */
  extend: number;
  /** Capsule radius in plan units. */
  radius: number;
  role: RagdollRole;
}

export interface RagdollPlan {
  bodies: RagdollPlanBody[];
  /** Largest extent of the skeleton, in plan units. */
  size: number;
  /** Bone count the plan was made for (a sanity check against another skeleton). */
  boneCount: number;
  /**
   * How the trunk lies in the bind pose: "upright" (a biped: hips below the
   * chest) or "horizontal" (a quadruped: hips behind the chest). Picks the
   * joint-limit preset (RAGDOLL_PRESETS).
   */
  posture: RagdollPosture;
}

export type RagdollPosture = "upright" | "horizontal";

export interface RagdollPlanOptions {
  /** Shortest segment that gets its own body, as a fraction of `size` (default 0.09). */
  minSegment?: number;
  /** Per-bone girth hints (plan units), e.g. measured from the skin. */
  radii?: ReadonlyArray<number | undefined>;
  /**
   * Shortest TRUNK body (the unbranched spine between the hips and the chest),
   * as a fraction of `size` (default 0.2). A quadruped's spine is four or five
   * short bones; one body each is a twisting noodle, two is a back.
   */
  trunkSegment?: number;
  /**
   * World up expressed in the bones' space (default +Y). A GLB whose mesh node
   * turns a Z-up armature upright has its bind pose lying on its back.
   */
  up?: V3;
}

/** Fingers, toes, faces, twist/share helpers, tips, ears, bellies: never a body. */
export function ragdollIgnores(name: string): boolean {
  const n = name.toLowerCase();
  if (/twist/.test(n) && !/neck/.test(n)) return true;
  return /finger|thumb|index|middle|ring|pinky|toe|eye|jaw|tongue|teeth|tooth|lid|brow|lip|cheek|nose|chin|breast|facial|share|tip$|tip_|_tip|nub|_end$|\.end$|stomach|belly|jiggle|(^|[_\s.:-])ear/.test(n);
}

/** Shoulder blades and side hips: folded into the trunk they hang from. */
export function ragdollMerges(name: string): boolean {
  return /clavicle|collar|scapula|shoulder|pelvis/i.test(name);
}

/** L/R side from a bone name, or null for a midline bone. */
export function boneSide(name: string): "L" | "R" | null {
  const m = /(?:^|[^a-z])(l|left|r|right)(?:[^a-z]|$)/i.exec(name);
  if (!m) return null;
  return m[1]!.toLowerCase().startsWith("l") ? "L" : "R";
}

const dist = (a: V3, b: V3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Turn a skeleton into ragdoll bodies.
 *
 * - The ragdoll ROOT is the first bone, walking down from the top, where the
 *   skeleton branches into two or more chains of real length (the hips).
 * - A body starts at a bone and swallows every following bone that is closer
 *   to its start than `minSegment` (a CC_Base waist + spine01, a foot + toe).
 * - Where the chain branches, the body ends at the one MIDLINE child with the
 *   longest reach (hips -> spine, chest -> neck); paired L/R children each
 *   start a limb.
 * - A chain end ends at its farthest descendant, ignored ones included (the
 *   head reaches its head-top bone, a hand its fingertips).
 * - Shoulder blades/clavicles/side pelvis bones fold into the trunk.
 */
export function planRagdoll(bones: ReadonlyArray<RagdollBoneInput>, opts: RagdollPlanOptions = {}): RagdollPlan | null {
  const n = bones.length;
  if (n === 0) return null;
  const ignored = new Array<boolean>(n).fill(false);
  const kids: number[][] = bones.map(() => []);
  const allKids: number[][] = bones.map(() => []);
  // parents may come after children in a skin's joint list: resolve in topological order
  const order = topoOrder(bones);
  for (const i of order) {
    const p = bones[i]!.parent;
    ignored[i] = ragdollIgnores(bones[i]!.name) || (p >= 0 && ignored[p]!);
    if (p >= 0) {
      allKids[p]!.push(i);
      if (!ignored[i]) kids[p]!.push(i);
    }
  }
  // size: extent of the bones that matter
  const lo: V3 = [Infinity, Infinity, Infinity];
  const hi: V3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    if (ignored[i]) continue;
    const p = bones[i]!.position;
    for (let k = 0; k < 3; k++) {
      lo[k] = Math.min(lo[k]!, p[k]!);
      hi[k] = Math.max(hi[k]!, p[k]!);
    }
  }
  const size = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  if (!(size > 0)) return null;
  const minLen = (opts.minSegment ?? 0.09) * size;

  // reach: farthest non-ignored descendant from each bone
  const reach = new Array<number>(n).fill(0);
  const farAny = new Array<number>(n).fill(-1); // farthest descendant of any kind
  for (let o = order.length - 1; o >= 0; o--) {
    const i = order[o]!;
    let best = 0;
    for (const c of kids[i]!) best = Math.max(best, dist(bones[i]!.position, bones[c]!.position) + reach[c]!);
    reach[i] = best;
  }
  const farthest = (i: number): number => {
    if (farAny[i]! >= 0) return farAny[i]!;
    let best = -1;
    let bestD = 0;
    // farthest ALONG the way the chain was going (a head reaches its nose, not an ear tip)
    const at = bones[i]!.position;
    const up = bones[i]!.parent >= 0 ? bones[bones[i]!.parent]!.position : null;
    const inDir = up ? [at[0] - up[0], at[1] - up[1], at[2] - up[2]] : null;
    const inLen = inDir ? Math.hypot(inDir[0]!, inDir[1]!, inDir[2]!) : 0;
    const walk = (b: number): void => {
      for (const c of allKids[b]!) {
        const p = bones[c]!.position;
        const d =
          inDir && inLen > 1e-6
            ? ((p[0] - at[0]) * inDir[0]! + (p[1] - at[1]) * inDir[1]! + (p[2] - at[2]) * inDir[2]!) / inLen
            : dist(at, p);
        if (d > bestD) {
          bestD = d;
          best = c;
        }
        walk(c);
      }
    };
    walk(i);
    farAny[i] = best;
    return best;
  };
  const significant = (p: number, c: number): boolean => reach[c]! + dist(bones[p]!.position, bones[c]!.position) >= minLen;
  /** Children that continue the skeleton, with shoulder blades etc. flattened away. */
  const effective = (b: number): number[] => {
    const out: number[] = [];
    for (const c of kids[b]!) {
      if (!significant(b, c)) continue;
      if (ragdollMerges(bones[c]!.name)) out.push(...effective(c));
      else out.push(c);
    }
    return out;
  };

  // the root: first real branch from the top
  const tops = order.filter((i) => bones[i]!.parent < 0 && !ignored[i]);
  if (tops.length === 0) return null;
  let root = tops.reduce((a, b) => (reach[b]! > reach[a]! ? b : a));
  for (let guard = 0; guard < n; guard++) {
    const sig = kids[root]!.filter((c) => significant(root, c));
    if (sig.length !== 1) break;
    root = sig[0]!;
  }

  // the trunk path: the midline run from the root to the chest (the next real branch)
  const mainOf = (next: number[]): number => {
    const mid = next.filter((c) => boneSide(bones[c]!.name) === null && !/tail/i.test(bones[c]!.name));
    const pool = mid.length > 0 ? mid : next.filter((c) => !/tail/i.test(bones[c]!.name));
    return (pool.length > 0 ? pool : next).reduce((a, b) => (reach[b]! > reach[a]! ? b : a));
  };
  const trunk = new Set<number>();
  let chest = root;
  {
    const first = effective(root);
    if (first.length > 0) {
      let b = mainOf(first);
      for (let guard = 0; guard < n; guard++) {
        const nx = effective(b);
        if (nx.length !== 1) break;
        trunk.add(b);
        b = nx[0]!;
      }
      chest = b;
    }
  }
  const trunkLen = (opts.trunkSegment ?? 0.2) * size;
  // posture: where the chest sits relative to the hips in the bind pose
  const rp = bones[root]!.position;
  const cp = bones[chest]!.position;
  const up = norm(opts.up ?? [0, 1, 0]);
  const tv: V3 = [cp[0] - rp[0], cp[1] - rp[1], cp[2] - rp[2]];
  const along = tv[0] * up[0] + tv[1] * up[1] + tv[2] * up[2];
  const across = Math.hypot(tv[0] - along * up[0], tv[1] - along * up[1], tv[2] - along * up[2]);
  const posture: RagdollPosture = Math.abs(along) >= across ? "upright" : "horizontal";

  const bodies: RagdollPlanBody[] = [];
  const radiusFor = (start: number, len: number, role: RagdollRole): number => {
    const hint = opts.radii?.[start];
    const fallback = role === "core" ? 0.09 * size : role === "head" ? 0.07 * size : Math.max(0.2 * len, 0.025 * size);
    const r = hint !== undefined && hint > 0 ? hint : fallback;
    return Math.min(Math.max(r, 0.015 * size), 0.22 * size);
  };
  const make = (start: number, parent: number): void => {
    let cur = start;
    let next = effective(cur);
    const swallow = trunk.has(start) ? Math.max(minLen, trunkLen) : minLen;
    while (next.length === 1 && trunk.has(next[0]!) === trunk.has(start) && dist(bones[start]!.position, bones[next[0]!]!.position) < swallow) {
      cur = next[0]!;
      next = effective(cur);
    }
    const index = bodies.length;
    const name = bones[start]!.name;
    let role: RagdollRole = /tail/i.test(name) ? "tail" : /head|neck|skull/i.test(name) ? "head" : "limb";
    let endBones: number[] = [];
    let extend = 0;
    if (next.length === 0) {
      const far = farthest(cur);
      if (far >= 0 && dist(bones[start]!.position, bones[far]!.position) >= 0.3 * minLen) endBones = [far];
      else if (cur !== start) endBones = [cur];
      else extend = (0.6 * minLen) / size;
    } else if (next.length === 1) {
      endBones = [next[0]!];
    } else {
      endBones = [mainOf(next)];
      role = "core";
    }
    if (start === root) role = "core";
    const endPos = endBones.length ? bones[endBones[0]!]!.position : bones[start]!.position;
    const len = extend > 0 ? extend * size : dist(bones[start]!.position, endPos);
    // a stub at a chain end (a quadruped's little foot) rides its parent instead of costing a body
    if (next.length === 0 && parent >= 0 && len < minLen) return;
    bodies.push({ bone: start, parent, endBones, extend, radius: 0, role });
    lengths.push(len);
    for (const c of next) make(c, index);
  };
  const lengths: number[] = [];
  make(root, -1);

  // the trunk: every ancestor of a branching body is core too (hips -> waist -> chest)
  for (const b of bodies) {
    if (b.role !== "core") continue;
    for (let p = b.parent; p >= 0; p = bodies[p]!.parent) if (bodies[p]!.role !== "tail") bodies[p]!.role = "core";
  }
  // the midline chain off the trunk is a neck (a quadruped's long one included), and so is what it carries
  for (const b of bodies) {
    if (b.role !== "limb" || b.parent < 0 || boneSide(bones[b.bone]!.name) !== null) continue;
    const pr = bodies[b.parent]!.role;
    if (pr === "core" || pr === "head") b.role = "head";
  }
  bodies.forEach((b, i) => (b.radius = radiusFor(b.bone, lengths[i]!, b.role)));
  return { bodies, size, boneCount: n, posture };
}

function topoOrder(bones: ReadonlyArray<RagdollBoneInput>): number[] {
  const out: number[] = [];
  const seen = new Uint8Array(bones.length);
  const visit = (i: number): void => {
    if (seen[i]) return;
    seen[i] = 1;
    const p = bones[i]!.parent;
    if (p >= 0 && p < bones.length) visit(p);
    out.push(i);
  };
  for (let i = 0; i < bones.length; i++) visit(i);
  return out;
}

// ---------------------------------------------------------------------------
// Plan -> physics spec
// ---------------------------------------------------------------------------

export interface RagdollTuning {
  /** Joint motor stiffness toward the spawn pose (1/s², mass-independent). */
  stiffness: number;
  /** Multiplies every joint's angular limit. */
  limitScale: number;
  linearDamping: number;
  angularDamping: number;
  /** Seconds over which the joint motors fade out; 0 = they hold. */
  relax?: number;
  /**
   * The creature's frame at death (x = its right, y = world up, z = its
   * forward): every body spawns with this rotation, so the per-axis limits
   * of {@link RAGDOLL_PRESETS} are about the creature's own axes. Default identity.
   */
  frame?: [number, number, number, number];
  /** Per-axis limits per role; default the plan's posture preset. */
  limits?: Record<RagdollRole, V3>;
  /** Capsules meet each other and other ragdolls' (see @hitreg/physics ragdoll.ts). */
  selfCollide?: boolean;
  /** Damping every body steps up to once the motors are slack: [linear, angular]. */
  restDamping?: [number, number];
  /** Root-up height below which a further roll is damped (see @hitreg/physics RagdollSpec.rollGuard). */
  rollGuard?: number;
}

/**
 * Joint limits (radians) per posture and role, about the creature's frame:
 * [x = pitch (about its right), y = yaw (about up), z = roll (about its forward)].
 *
 * - upright (a biped): the spine twists about Y, so Y is the tight one.
 * - horizontal (a quadruped): the spine runs along Z, so ROLL is the tight
 *   one — a back that rolls freely is the visible corkscrew of a bear's spine,
 *   and the start of a wolf rolling onto its back.
 * - limbs hang along Y in both: they swing fore-aft (X) freely, spread (Z)
 *   less and twist (Y) little — which also keeps a shin from folding back
 *   through the belly.
 */
export const RAGDOLL_PRESETS: Record<RagdollPosture, Record<RagdollRole, V3>> = {
  upright: { core: [0.35, 0.15, 0.3], head: [0.6, 0.45, 0.45], limb: [0.9, 0.4, 0.6], tail: [0.8, 0.8, 0.8] },
  horizontal: { core: [0.22, 0.2, 0.05], head: [0.5, 0.45, 0.12], limb: [0.9, 0.3, 0.4], tail: [0.8, 0.8, 0.3] },
};

/** @deprecated one angle per role (the prototype's); see {@link RAGDOLL_PRESETS}. */
export const RAGDOLL_LIMITS: Record<RagdollRole, number> = { core: 0.35, head: 0.6, limb: 0.9, tail: 0.8 };

/**
 * Build the physics spec from a plan and the CURRENT pose.
 *
 * `positions` are the bones' current world heads (index = bone), `scale` the
 * world size of one plan unit, `velocity(bone)` each bone's current motion.
 * Every body spawns with the same rotation, `tuning.frame` (see
 * @hitreg/physics ragdoll.ts); the capsule's orientation lives on its collider.
 */
export function ragdollSpec(
  plan: RagdollPlan,
  positions: ReadonlyArray<V3>,
  scale: number,
  tuning: RagdollTuning,
  velocity?: (bone: number) => V3,
): SimRagdollSpec {
  const bodies: SimRagdollSpec["bodies"] = [];
  const joints: SimRagdollSpec["joints"] = [];
  const frame = tuning.frame ?? ([0, 0, 0, 1] as [number, number, number, number]);
  const inv: [number, number, number, number] = [-frame[0], -frame[1], -frame[2], frame[3]];
  const limits = tuning.limits ?? RAGDOLL_PRESETS[plan.posture ?? "upright"];
  const ls = tuning.limitScale;
  for (let i = 0; i < plan.bodies.length; i++) {
    const b = plan.bodies[i]!;
    const start = positions[b.bone]!;
    let end: V3;
    if (b.endBones.length > 0) {
      end = [0, 0, 0];
      for (const e of b.endBones) for (let k = 0; k < 3; k++) end[k] = end[k]! + positions[e]![k]! / b.endBones.length;
    } else {
      // a bare chain end: carry on the way its parent body pointed
      const pb = b.parent >= 0 ? positions[plan.bodies[b.parent]!.bone]! : ([start[0], start[1] - 1, start[2]] as V3);
      const d = norm([start[0] - pb[0], start[1] - pb[1], start[2] - pb[2]]);
      const l = b.extend * plan.size * scale;
      end = [start[0] + d[0] * l, start[1] + d[1] * l, start[2] + d[2] * l];
    }
    // the segment in the bodies' shared frame
    const seg = rotateV(inv, [end[0] - start[0], end[1] - start[1], end[2] - start[2]]);
    const len = Math.hypot(seg[0], seg[1], seg[2]);
    const radius = Math.max(0.01, b.radius * scale);
    bodies.push({
      position: [start[0], start[1], start[2]],
      ...(tuning.frame ? { rotation: [frame[0], frame[1], frame[2], frame[3]] as [number, number, number, number] } : {}),
      collider: {
        center: [seg[0] / 2, seg[1] / 2, seg[2] / 2],
        rotation: len > 1e-6 ? quatFromY(seg[0] / len, seg[1] / len, seg[2] / len) : [0, 0, 0, 1],
        halfHeight: Math.max(0, len / 2 - radius * 0.5),
        radius,
      },
      ...(velocity ? { linvel: velocity(b.bone) } : {}),
    });
    if (b.parent >= 0) {
      const l = limits[b.role];
      joints.push({ parent: b.parent, child: i, anchor: [start[0], start[1], start[2]], limit: [l[0] * ls, l[1] * ls, l[2] * ls] });
    }
  }
  return {
    bodies,
    joints,
    stiffness: tuning.stiffness,
    ...(tuning.relax ? { relax: tuning.relax } : {}),
    linearDamping: tuning.linearDamping,
    angularDamping: tuning.angularDamping,
    ...(tuning.selfCollide ? { selfCollide: true } : {}),
    ...(tuning.rollGuard !== undefined ? { rollGuard: tuning.rollGuard } : {}),
    ...(tuning.restDamping
      ? { settle: { after: tuning.relax ?? 0, linearDamping: tuning.restDamping[0], angularDamping: tuning.restDamping[1] } }
      : {}),
  };
}

/** v rotated by the unit quaternion q. */
function rotateV(q: readonly number[], v: V3): V3 {
  const [x, y, z] = v;
  const qx = q[0]!, qy = q[1]!, qz = q[2]!, qw = q[3]!;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  return [ix * qw + iw * -qx + iy * -qz - iz * -qy, iy * qw + iw * -qy + iz * -qx - ix * -qz, iz * qw + iw * -qz + ix * -qy - iy * -qx];
}

function norm(v: V3): V3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-9 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 1, 0];
}

/** Shortest rotation taking +Y onto the unit vector (x, y, z). */
export function quatFromY(x: number, y: number, z: number): [number, number, number, number] {
  // axis = Y × d = (z, 0, -x); half-angle form
  if (y < -0.999999) return [1, 0, 0, 0];
  const w = 1 + y;
  const l = Math.hypot(z, -x, w);
  return [z / l, 0, -x / l, w / l];
}

// ---------------------------------------------------------------------------
// Skin girth, measured once per geometry
// ---------------------------------------------------------------------------

interface SkinSample {
  /** Bind-space vertex positions, xyz. */
  pos: Float32Array;
  /** Dominant joint per vertex. */
  joint: Uint16Array;
}
const skinSamples = new WeakMap<THREE.BufferGeometry, SkinSample | null>();

function sampleSkin(mesh: THREE.SkinnedMesh): SkinSample | null {
  const geo = mesh.geometry;
  if (skinSamples.has(geo)) return skinSamples.get(geo)!;
  const p = geo.getAttribute("position");
  const si = geo.getAttribute("skinIndex");
  const sw = geo.getAttribute("skinWeight");
  if (!p || !si || !sw) {
    skinSamples.set(geo, null);
    return null;
  }
  // at most ~6000 vertices: girth is a statistic, not a mesh
  const step = Math.max(1, Math.floor(p.count / 6000));
  const count = Math.floor(p.count / step);
  const pos = new Float32Array(count * 3);
  const joint = new Uint16Array(count);
  const v = new THREE.Vector3();
  for (let k = 0, i = 0; k < count; k++, i += step) {
    v.fromBufferAttribute(p, i).applyMatrix4(mesh.bindMatrix);
    pos[k * 3] = v.x;
    pos[k * 3 + 1] = v.y;
    pos[k * 3 + 2] = v.z;
    let best = 0;
    let bw = -1;
    for (let c = 0; c < 4; c++) {
      const w = sw.getComponent(i, c);
      if (w > bw) {
        bw = w;
        best = si.getComponent(i, c);
      }
    }
    joint[k] = best;
  }
  const s = { pos, joint };
  skinSamples.set(geo, s);
  return s;
}

/** A plan per skeleton (bind pose, skin radii), shared by every mob of that model. */
const plans = new WeakMap<THREE.Skeleton | THREE.BufferGeometry, { plan: RagdollPlan; key: string } | null>();

/** `minSegment` per posture when the caller passes 0 (auto): a quadruped's ankles and toes are stubs. */
export const RAGDOLL_MIN_SEGMENT: Record<RagdollPosture, number> = { upright: 0.09, horizontal: 0.12 };

/**
 * Plan a skinned mesh in its bind pose, radii from the skin around each body.
 * `minSegment` 0 = by posture ({@link RAGDOLL_MIN_SEGMENT}).
 */
export function planSkinnedRagdoll(mesh: THREE.SkinnedMesh, minSegment = 0, trunkSegment = 0.2): RagdollPlan | null {
  // keyed by geometry: clones of one model share it (their skeletons are per instance)
  const key = mesh.geometry;
  const opts = `${minSegment}/${trunkSegment}`;
  const cached = plans.get(key);
  if (cached !== undefined && (cached === null || cached.key === opts)) return cached?.plan ?? null;
  const sk = mesh.skeleton;
  const index = new Map<THREE.Object3D, number>(sk.bones.map((b, i) => [b, i]));
  const m = new THREE.Matrix4();
  const tmp = new THREE.Vector3();
  const bind: V3[] = sk.boneInverses.map((inv) => {
    tmp.setFromMatrixPosition(m.copy(inv).invert());
    return [tmp.x, tmp.y, tmp.z];
  });
  const input: RagdollBoneInput[] = sk.bones.map((b, i) => ({
    name: b.name,
    parent: b.parent && index.has(b.parent) ? index.get(b.parent)! : -1,
    position: bind[i]!,
  }));
  // world up in bind space: the mesh's own world rotation undone (a yaw leaves up alone)
  mesh.updateWorldMatrix(true, false);
  const mq = new THREE.Quaternion();
  mesh.matrixWorld.decompose(tmp.clone(), mq, tmp.clone());
  const upB = new THREE.Vector3(0, 1, 0).applyQuaternion(mq.invert());
  const up: V3 = [upB.x, upB.y, upB.z];
  let rough = planRagdoll(input, { minSegment: minSegment > 0 ? minSegment : RAGDOLL_MIN_SEGMENT.upright, trunkSegment, up });
  if (rough && !(minSegment > 0) && rough.posture === "horizontal") rough = planRagdoll(input, { minSegment: RAGDOLL_MIN_SEGMENT.horizontal, trunkSegment, up });
  const seg = rough ? (minSegment > 0 ? minSegment : RAGDOLL_MIN_SEGMENT[rough.posture]) : minSegment;
  if (!rough) {
    plans.set(key, null);
    return null;
  }
  // girth: distance of each body's vertices from its own segment, 70th percentile
  const skin = sampleSkin(mesh);
  if (skin) {
    const owner = new Int32Array(sk.bones.length).fill(-1);
    const bodyOfBone = new Map(rough.bodies.map((b, i) => [b.bone, i]));
    const ownerOf = (j: number): number => {
      if (owner[j]! >= 0) return owner[j]!;
      let o = -1;
      for (let b = j; b >= 0 && o < 0; b = input[b]!.parent) o = bodyOfBone.get(b) ?? -1;
      owner[j] = o;
      return o;
    };
    const ds: number[][] = rough.bodies.map(() => []);
    // perpendicular offsets' second moments per body (xx yy zz xy xz yz), for the thin axis of a trunk
    const mom: Float64Array[] = rough.bodies.map(() => new Float64Array(6));
    const segs = rough.bodies.map((b) => {
      const a = bind[b.bone]!;
      const e = b.endBones.length ? bind[b.endBones[0]!]! : a;
      return [a, e] as const;
    });
    for (let k = 0; k < skin.joint.length; k++) {
      const o = ownerOf(skin.joint[k]!);
      if (o < 0) continue;
      const [a, e] = segs[o]!;
      const x = skin.pos[k * 3]!, y = skin.pos[k * 3 + 1]!, z = skin.pos[k * 3 + 2]!;
      ds[o]!.push(segDist(x, y, z, a, e));
      const off = segOffset(x, y, z, a, e);
      const M = mom[o]!;
      M[0]! += off[0] * off[0];
      M[1]! += off[1] * off[1];
      M[2]! += off[2] * off[2];
      M[3]! += off[0] * off[1];
      M[4]! += off[0] * off[2];
      M[5]! += off[1] * off[2];
    }
    const radii: Array<number | undefined> = new Array(sk.bones.length);
    rough.bodies.forEach((b, i) => {
      const d = ds[i]!;
      if (d.length < 8) return;
      d.sort((x, y) => x - y);
      let r = d[Math.floor(d.length * 0.7)]! * 0.9;
      // a trunk or neck is an ellipse, not a tube: a capsule as wide as the hips
      // holds a body lying on its back a hand's breadth off the ground. Cap it
      // at the THIN semi-axis (sqrt2 x the smaller principal spread, + 10%).
      if (b.role === "core" || b.role === "head") {
        const thin = Math.SQRT2 * Math.sqrt(minorVariance(mom[i]!, d.length)) * 1.1;
        if (thin > 0) r = Math.min(r, thin);
      }
      radii[b.bone] = r;
    });
    const plan = planRagdoll(input, { minSegment: seg, trunkSegment, up, radii });
    plans.set(key, plan ? { plan, key: opts } : null);
    return plan;
  }
  plans.set(key, { plan: rough, key: opts });
  return rough;
}

/** Offset of a point from its closest point on segment ab. */
function segOffset(x: number, y: number, z: number, a: V3, b: V3): V3 {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((x - a[0]) * abx + (y - a[1]) * aby + (z - a[2]) * abz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return [x - (a[0] + abx * t), y - (a[1] + aby * t), z - (a[2] + abz * t)];
}

/**
 * The smaller non-zero principal variance of offsets that lie (mostly) in a
 * plane: total minus the largest (power iteration on the 3x3 moment matrix;
 * the third eigenvalue, along the segment, is ~0 by construction).
 */
function minorVariance(M: Float64Array, count: number): number {
  if (count < 1) return 0;
  const xx = M[0]! / count, yy = M[1]! / count, zz = M[2]! / count;
  const xy = M[3]! / count, xz = M[4]! / count, yz = M[5]! / count;
  let vx = 0.57, vy = 0.61, vz = 0.55;
  for (let k = 0; k < 24; k++) {
    const nx = xx * vx + xy * vy + xz * vz;
    const ny = xy * vx + yy * vy + yz * vz;
    const nz = xz * vx + yz * vy + zz * vz;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-12) return 0;
    vx = nx / l;
    vy = ny / l;
    vz = nz / l;
  }
  const major = vx * (xx * vx + xy * vy + xz * vz) + vy * (xy * vx + yy * vy + yz * vz) + vz * (xz * vx + yz * vy + zz * vz);
  return Math.max(0, xx + yy + zz - major);
}

function segDist(x: number, y: number, z: number, a: V3, b: V3): number {
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2];
  const l2 = abx * abx + aby * aby + abz * abz;
  let t = l2 > 0 ? ((x - a[0]) * abx + (y - a[1]) * aby + (z - a[2]) * abz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(x - (a[0] + abx * t), y - (a[1] + aby * t), z - (a[2] + abz * t));
}

// ---------------------------------------------------------------------------
// The builtin
// ---------------------------------------------------------------------------

/** What a death script may stamp on the BODY's userData to start (and aim) a ragdoll. */
export interface RagdollKick {
  /** Any value that changes per death (a time stamp). */
  at: number;
  /** World direction the blow travelled (from killer to victim); y is allowed. */
  dir?: V3;
  /** Multiplies the script's `impulse` (a heavy blow: 1.5). */
  strength?: number;
}

type Phase = "idle" | "leadIn" | "active" | "frozen" | "skipped";

/** Marks the root body: its parent matrix comes from an ordinary upward walk. */
const ROOT_CHAIN: THREE.Object3D[] = [];

export class RagdollScript extends Script {
  static override scriptName = "ragdoll";
  /** Draws what the replicated death says; changes nothing anyone reads. Runs on every tab's copy of the body. */
  static override presentation = true;
  /** Nothing to fall on a dedicated server: no skeleton, nobody looking. */
  static clientOnly = true;
  static override params = {
    enabled: { default: true, description: "false = always the plain death clip (an A/B switch)" },
    actor: { default: "", description: "the body entity that dies; empty = this entity's parent" },
    deathClip: {
      default: "Death",
      description:
        "the controller's death action clip: the body's `actionClip` equal to this while it is `frozen` starts the fall (the authority / single-player path). Empty = only `deadKey` or a `userData.ragdollKick` stamp start it",
    },
    deadKey: {
      default: "",
      description:
        "netState key whose truthy value means dead, `{actor}` replaced by the actor id (voxel-demo: `combat/{actor}.dead`) — how a tab that does not simulate the body learns of the death",
    },
    leadIn: { default: 0.35, min: 0, max: 2, description: "seconds of the animated death clip before the bodies take over" },
    impulse: { default: 2.5, min: 0, max: 20, description: "m/s added along the killing blow (the kick's dir, else away from the local player, else backwards)" },
    lift: { default: 0.6, min: 0, max: 10, description: "m/s of upward pop added with the impulse" },
    stiffness: { default: 30, min: 0, max: 500, description: "joint motors pulling back to the death pose: higher = a heavier, stiffer fall; 0 = limp within the limits" },
    relax: { default: 1.2, min: 0, max: 10, description: "seconds over which those motors fade to nothing: stiff at the blow, slack once down so the body can lie still (0 = they hold)" },
    rig: {
      default: "auto",
      description:
        "joint-limit preset (RAGDOLL_PRESETS): `upright` (a biped: the spine may bend, hardly twist), `horizontal` (a quadruped: the back hardly rolls, the neck is stiff, legs swing fore-aft) or `auto` (from the bind pose: chest above the hips = upright)",
    },
    limitScale: { default: 1, min: 0.1, max: 3, description: "multiplies every joint's angle limit (the preset's per-role, per-axis angles)" },
    tip: {
      default: 1.2,
      min: 0,
      max: 10,
      description:
        "horizontal rigs only: rad/s of roll toward one flank at the handover (the way the death clip already leans, else the blow's side, else a stable per-body pick), so a four-legged body drops onto its side instead of standing on stiff legs. Past ~2 it rolls on over onto its back. 0 = none",
    },
    selfCollide: {
      default: true,
      description: "capsules meet each other (a hand cannot sink into the chest, a shin into the belly) and other falling corpses; pairs already touching at the handover are exempt",
    },
    restDamping: {
      default: 20,
      min: 0,
      max: 60,
      description: "spin damping every body ramps to once the motors have relaxed (drift damping gets a third of it): stops a tail or hoof creeping so the pose can freeze early. 0 = keep angularDamping",
    },
    maxDistance: {
      default: 30,
      min: 0,
      max: 500,
      description: "metres from the local camera beyond which a death just plays its clip (nobody can tell a far ragdoll from a clip, and the cap stays free for near ones). 0 = no limit",
    },
    angularDamping: { default: 3, min: 0, max: 50, description: "body spin damping (heavy, not floppy)" },
    linearDamping: { default: 0.3, min: 0, max: 50, description: "body drift damping" },
    settleSeconds: { default: 0.5, min: 0.05, max: 5, description: "how long every body must be still before the pose freezes and the bodies go" },
    maxSeconds: { default: 5, min: 0.5, max: 30, description: "freeze regardless after this long" },
    maxActive: { default: 8, min: 0, max: 64, description: "simultaneous ragdolls this tab may simulate; a death past the cap keeps the plain death clip" },
    spawnsPerFrame: { default: 4, min: 0, max: 64, description: "ragdolls built per sim tick across the whole tab (a pack dying at once is spread over frames; 0 = no limit)" },
    minSegment: { default: 0, min: 0, max: 0.3, description: "shortest bone run that gets its own body, as a fraction of the skeleton's size (bigger = fewer, chunkier bodies); 0 = by posture (upright 0.09, horizontal 0.12: a quadruped's ankles and toes ride the shin)" },
    trunkSegment: {
      default: 0.2,
      min: 0.05,
      max: 0.6,
      description: "shortest TRUNK body (the spine between hips and chest), as a fraction of the skeleton's size: a quadruped's five spine bones become two stiff bodies instead of a twisting chain",
    },
  };

  private phase: Phase = "idle";
  private body: THREE.Object3D | null = null;
  private mesh: THREE.SkinnedMesh | null = null;
  private plan: RagdollPlan | null = null;
  private handle = 0;
  private t = 0;
  private stillFor = 0;
  /** Body positions at the start of the current quiet window, and when it began. */
  private anchor = new Float32Array(0);
  private quietFrom = 0;
  /** Largest body displacement (m) that still counts as lying still (from the creature's size). */
  private quietTol = 0.03;
  private kickAt: unknown = undefined;
  private poses = new Float32Array(0);
  /** Per plan body: the bone's world rotation at spawn (bodies spawn at identity). */
  private boneRot: THREE.Quaternion[] = [];
  private boneScale: THREE.Vector3[] = [];
  private chains: THREE.Object3D[][] = [];
  /** Bone local transforms before the ragdoll touched them, for a respawn. */
  private saved: Array<{ bone: THREE.Bone; p: THREE.Vector3; q: THREE.Quaternion; s: THREE.Vector3 }> = [];
  /** Head positions last frame and this, for the lead-in's velocity. */
  private prev: V3[] = [];
  private prevDt = 0;
  private readonly m = new THREE.Matrix4();
  private readonly m2 = new THREE.Matrix4();
  private readonly v = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();
  /** Measurements a probe reads (`userData.ragdoll` on the body). */
  private stats = { spawned: 0, settleMs: 0, bodies: 0, skippedCap: 0, skippedFar: 0, skippedNoGround: 0, fellThrough: 0, spawnMs: 0, rig: "" };
  /** The lowest bone head at the handover (world y): the fall-through guard's reference. */
  private floor = 0;
  /** The bodies' shared spawn rotation (the creature's frame), for bone rotations relative to it. */
  private frame = new THREE.Quaternion();

  override onStart(): void {
    const actor = this.param<string>("actor");
    this.body = (actor ? this.ctx.getObject(actor) : null) ?? this.object.parent ?? this.object;
  }

  private isDead(ud: Record<string, unknown>): boolean {
    if (ud["ragdollKick"]) return true;
    const clip = this.param<string>("deathClip");
    if (clip && ud["frozen"] === true && ud["actionClip"] === clip) return true;
    const key = this.param<string>("deadKey");
    if (!key) return false;
    // resolved once per (key, actor): a string built per mob per frame is garbage the GC has to chase
    const actor = this.param<string>("actor") || this.actorBodyId();
    if (key !== this.keyFrom || actor !== this.keyActor) {
      this.keyFrom = key;
      this.keyActor = actor;
      this.keyResolved = key.replace("{actor}", actor);
    }
    return !!this.ctx.netState?.get(this.keyResolved);
  }
  private keyFrom = "";
  private keyActor = "";
  private keyResolved = "";
  /** Seen alive at least once: a body already dead when this tab first sees it (a late join) keeps its clip. */
  private seenAlive = false;

  /** The body's entity id: the parent entity of this script's entity. */
  private actorBodyId(): string {
    const doc = this.ctx.getEntity(this.ctx.entityId);
    return doc?.parent ?? this.ctx.entityId;
  }

  private findMesh(): THREE.SkinnedMesh | null {
    if (this.mesh?.parent) return this.mesh;
    let best: THREE.SkinnedMesh | null = null;
    this.body?.traverse((o) => {
      const s = o as THREE.SkinnedMesh;
      if (s.isSkinnedMesh && s.skeleton && (!best || s.skeleton.bones.length > best.skeleton.bones.length)) best = s;
    });
    this.mesh = best;
    return best;
  }

  override onLateUpdate(dt: number): void {
    const body = this.body;
    if (!body) return;
    const ud = body.userData;
    const dead = this.isDead(ud);
    if (!dead) {
      this.seenAlive = true;
      if (this.phase !== "idle") this.reset();
      return;
    }
    if (!this.seenAlive) return; // dead before we ever saw it move: the replicated corpse stays as it is
    // a second kick (a new death after a respawn we never saw) restarts it
    if (ud["ragdollKick"] && (ud["ragdollKick"] as RagdollKick).at !== this.kickAt && this.phase !== "idle") this.reset();
    switch (this.phase) {
      case "idle":
        this.begin(ud);
        return;
      case "leadIn":
        this.t += dt;
        if (this.t >= this.param<number>("leadIn") && takeSpawnSlot(this.ctx.sim, this.ctx.now(), this.param<number>("spawnsPerFrame"))) this.spawn(ud);
        else this.track(dt);
        return;
      case "active":
        this.follow(dt);
        return;
      default:
        return; // frozen / skipped: nothing, every frame
    }
  }

  private begin(ud: Record<string, unknown>): void {
    this.kickAt = (ud["ragdollKick"] as RagdollKick | undefined)?.at;
    const sim = this.ctx.sim;
    const mesh = this.findMesh();
    if (!this.param<boolean>("enabled") || !sim?.addRagdoll || !mesh) {
      this.phase = "skipped";
      return;
    }
    const far = this.param<number>("maxDistance");
    const eye = far > 0 ? this.ctx.viewOrigin?.() : undefined;
    if (eye && this.body) {
      const at = body3(this.body);
      if (Math.hypot(at[0] - eye[0], at[1] - eye[1], at[2] - eye[2]) > far) {
        this.phase = "skipped"; // too far to tell: the plain death clip
        this.stats.skippedFar++;
        this.publish();
        return;
      }
    }
    const cap = this.param<number>("maxActive");
    if ((sim.ragdollStats?.().active ?? 0) >= cap) {
      this.phase = "skipped"; // the plain death clip keeps playing
      this.stats.skippedCap++;
      this.publish();
      return;
    }
    this.plan = planSkinnedRagdoll(mesh, this.param<number>("minSegment"), this.param<number>("trunkSegment"));
    if (!this.plan) {
      this.phase = "skipped";
      return;
    }
    this.phase = "leadIn";
    this.t = 0;
    this.prev = [];
    this.track(0);
  }

  /** Remember where the bones are, for the handover velocity. */
  private track(dt: number): void {
    const heads = this.heads();
    if (!heads) return;
    this.prev = heads;
    this.prevDt = dt;
  }

  private heads(): V3[] | null {
    const mesh = this.mesh;
    if (!mesh) return null;
    mesh.skeleton.bones[0]?.parent?.updateWorldMatrix(true, true);
    return mesh.skeleton.bones.map((b) => {
      this.v.setFromMatrixPosition(b.matrixWorld);
      return [this.v.x, this.v.y, this.v.z] as V3;
    });
  }

  private spawn(ud: Record<string, unknown>): void {
    const started = performance.now();
    const sim = this.ctx.sim;
    const mesh = this.mesh;
    const plan = this.plan;
    const heads = this.heads();
    if (!sim?.addRagdoll || !mesh || !plan || !heads) {
      this.phase = "skipped";
      return;
    }
    // re-check the cap at handover: another death may have taken the slot
    if ((sim.ragdollStats?.().active ?? 0) >= this.param<number>("maxActive")) {
      this.phase = "skipped";
      this.stats.skippedCap++;
      this.publish();
      return;
    }
    // ground under it: terrain only collides inside the simulation ring around the
    // players, and a body that falls where no collider was ever built falls forever.
    // No floor within reach of the feet = the plain death clip.
    let lowest = Infinity;
    for (const b of plan.bodies) lowest = Math.min(lowest, heads[b.bone]![1]);
    const r0 = heads[plan.bodies[0]!.bone]!;
    if (sim.raycast && !sim.raycast([r0[0], r0[1], r0[2]], [0, -1, 0], r0[1] - lowest + GROUND_REACH, { layers: GROUND_LAYERS })) {
      this.phase = "skipped";
      this.stats.skippedNoGround++;
      this.publish();
      return;
    }
    this.floor = lowest;
    const bones = mesh.skeleton.bones;
    // one plan unit in world metres: bind-pose lengths vs posed lengths, over every segment
    let bindSum = 0;
    let worldSum = 0;
    const tmp = new THREE.Vector3();
    const bindPos = (i: number): THREE.Vector3 => tmp.setFromMatrixPosition(this.m.copy(mesh.skeleton.boneInverses[i]!).invert());
    for (const b of plan.bodies) {
      if (!b.endBones.length) continue;
      const a = bindPos(b.bone).clone();
      const e = bindPos(b.endBones[0]!);
      bindSum += a.distanceTo(e);
      const ha = heads[b.bone]!;
      const he = heads[b.endBones[0]!]!;
      worldSum += Math.hypot(ha[0] - he[0], ha[1] - he[1], ha[2] - he[2]);
    }
    const scale = bindSum > 0 ? worldSum / bindSum : 1;
    // the blow: the kick's direction, else away from the local player, else backwards
    const kick = ud["ragdollKick"] as RagdollKick | undefined;
    let dir: V3 | null = kick?.dir ? kick.dir : null;
    if (!dir) {
      const me = this.ctx.localPlayer?.();
      const mo = me ? this.ctx.getObject(me) : undefined;
      const here = body3(this.body!);
      if (mo) {
        const there = body3(mo);
        dir = [here[0] - there[0], 0, here[2] - there[2]];
      } else {
        const f = new THREE.Vector3(0, 0, 1).applyQuaternion(this.body!.getWorldQuaternion(this.q));
        dir = [-f.x, 0, -f.z];
      }
    }
    const dl = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const strength = this.param<number>("impulse") * (kick?.strength ?? 1);
    const lift = this.param<number>("lift");
    const prev = this.prev;
    const pdt = this.prevDt > 1e-4 ? this.prevDt : 1 / 60;
    const root = heads[plan.bodies[0]!.bone]!;
    const coreHeight = root[1];
    // the creature's frame: y up, z its forward — a quadruped's from its own back
    // (hips -> chest, whatever the clip did to the heading), a biped's from the body's facing
    const rigParam = this.param<string>("rig");
    const posture: RagdollPosture = rigParam === "upright" || rigParam === "horizontal" ? rigParam : plan.posture;
    let fx: number, fz: number;
    const chestBody = plan.bodies.find((b, i) => i > 0 && b.role === "core" && !plan.bodies.some((c) => c.parent === i && c.role === "core"));
    const chest = chestBody ? heads[chestBody.endBones[0] ?? chestBody.bone]! : null;
    if (posture === "horizontal" && chest && Math.hypot(chest[0] - root[0], chest[2] - root[2]) > 1e-3) {
      fx = chest[0] - root[0];
      fz = chest[2] - root[2];
    } else {
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(this.body!.getWorldQuaternion(this.q));
      fx = f.x;
      fz = f.z;
    }
    const fl = Math.hypot(fx, fz) || 1;
    fx /= fl;
    fz /= fl;
    this.frame.setFromAxisAngle(this.v.set(0, 1, 0), Math.atan2(fx, fz));
    // a four-legged body tips onto a flank: the blow's side, else a stable pick per body
    let tipAxis: V3 | null = null;
    /** The creature's right (unit, horizontal). */
    const flankX = -fz, flankZ = fx;
    const tip = posture === "horizontal" ? this.param<number>("tip") : 0;
    if (tip > 0) {
      // right = forward x up ... the flank the top of the body falls toward
      const rx = -fz, rz = fx;
      // the lean the clip already has: the trunk's offset across the feet (a clip that
      // rolls the body one way is never fought), else the blow's side, else a stable pick
      let fx2 = 0, fz2 = 0, fy2 = 0, nFeet = 0;
      plan.bodies.forEach((b, i) => {
        if (b.role !== "limb" || plan.bodies.some((c) => c.parent === i)) return;
        const h = heads[b.bone]!;
        fx2 += h[0];
        fy2 += h[1];
        fz2 += h[2];
        nFeet++;
      });
      let lean = 0;
      if (nFeet > 0 && chest) {
        const tx = (root[0] + chest[0]) / 2 - fx2 / nFeet;
        const ty = (root[1] + chest[1]) / 2 - fy2 / nFeet;
        const tz = (root[2] + chest[2]) / 2 - fz2 / nFeet;
        lean = (tx * rx + tz * rz) / (Math.hypot(tx, ty, tz) || 1);
      }
      const side = (dir[0] * rx + dir[2] * rz) / dl;
      const sign = Math.abs(lean) > 0.17 ? Math.sign(lean) : Math.abs(side) > 0.2 ? Math.sign(side) : hashSign(this.ctx.entityId);
      const sx = rx * sign, sz = rz * sign;
      // the same topple SPEED at the back whatever the height: a horse turning at a
      // wolf's rate carries twice the speed over its side and on onto its back
      let low = Infinity;
      for (const b of plan.bodies) low = Math.min(low, heads[b.bone]![1]);
      const w = tip * Math.min(1, TIP_HEIGHT / Math.max(0.05, root[1] - low));
      // omega = up x side: turns the up direction toward the side
      tipAxis = [sz * w, 0, -sx * w];
    }
    // the pivot of the tip: the ground under the root, roughly (the lowest bone head)
    let low = Infinity;
    for (const b of plan.bodies) low = Math.min(low, heads[b.bone]![1]);
    const pivot: V3 = [root[0], low, root[2]];
    const restDamping = this.param<number>("restDamping");
    const spec = ragdollSpec(
      plan,
      heads,
      scale,
      {
        stiffness: this.param<number>("stiffness"),
        limitScale: this.param<number>("limitScale"),
        linearDamping: this.param<number>("linearDamping"),
        angularDamping: this.param<number>("angularDamping"),
        relax: this.param<number>("relax"),
        frame: [this.frame.x, this.frame.y, this.frame.z, this.frame.w],
        limits: RAGDOLL_PRESETS[posture],
        selfCollide: this.param<boolean>("selfCollide"),
        ...(restDamping > 0 ? { restDamping: [restDamping * REST_LINEAR, restDamping] as [number, number] } : {}),
        // a four-legged body lies on its side, not its back
        ...(posture === "horizontal" ? { rollGuard: -0.3 } : {}),
      },
      (bone) => {
        const h = heads[bone]!;
        const p = prev[bone] ?? h;
        // the clip's own motion (capped: a pose-LOD jump is not a velocity)
        let vx = (h[0] - p[0]) / pdt, vy = (h[1] - p[1]) / pdt, vz = (h[2] - p[2]) / pdt;
        const sp = Math.hypot(vx, vy, vz);
        if (sp > 6) { vx *= 6 / sp; vy *= 6 / sp; vz *= 6 / sp; }
        // the blow lands high: the upper body takes more of it, which is what topples a
        // biped. A four-legged body takes it evenly and only a quarter of it across
        // its flank: the roll is the tip's job, and a shove high on a flank on top
        // of the tip sends it on over onto its back
        let bx = dir![0] / dl, bz = dir![2] / dl;
        let k = strength;
        if (tipAxis) {
          const across = bx * flankX + bz * flankZ;
          bx -= across * flankX * 0.75;
          bz -= across * flankZ * 0.75;
          k *= 0.8;
        } else if (h[1] < coreHeight) k *= 0.5;
        vx += bx * k;
        vy += (dir![1] / dl) * k + lift;
        vz += bz * k;
        if (tipAxis) {
          // the whole body turning about the pivot: v += omega x (p - pivot)
          const px = h[0] - pivot[0], py = h[1] - pivot[1], pz = h[2] - pivot[2];
          vx += tipAxis[1] * pz - tipAxis[2] * py;
          vy += tipAxis[2] * px - tipAxis[0] * pz;
          vz += tipAxis[0] * py - tipAxis[1] * px;
        }
        return [vx, vy, vz];
      },
    );
    if (tipAxis) for (const b of spec.bodies) b.angvel = [tipAxis[0], tipAxis[1], tipAxis[2]];
    this.handle = sim.addRagdoll(spec);
    this.stats.rig = posture;
    // each body drives its bone: remember the bone's rotation/scale at spawn (the body's identity)
    this.boneRot = [];
    this.boneScale = [];
    this.saved = [];
    const pos = new THREE.Vector3();
    for (const b of plan.bodies) {
      const bone = bones[b.bone]!;
      const q = new THREE.Quaternion();
      const s = new THREE.Vector3();
      bone.matrixWorld.decompose(pos, q, s);
      // the body starts at the frame rotation: the bone's rotation relative to it
      q.premultiply(this.q.copy(this.frame).invert());
      this.boneRot.push(q);
      this.boneScale.push(s);
      this.saved.push({ bone, p: bone.position.clone(), q: bone.quaternion.clone(), s: bone.scale.clone() });
    }
    this.poses = new Float32Array(plan.bodies.length * 7);
    this.anchor = new Float32Array(plan.bodies.length * 7);
    for (let i = 0; i < spec.bodies.length; i++) this.anchor.set(spec.bodies[i]!.position, i * 7);
    this.quietFrom = 0;
    // "still": no body travels more than ~1.5% of the creature's size (2 cm at least) in a settle window
    this.quietTol = Math.max(0.02, 0.015 * plan.size * scale);
    this.buildChains();
    // the mixer stops here: the bodies own the pose from now on (AnimationSystem's pose hold)
    ud["poseHoldUntil"] = Infinity;
    this.phase = "active";
    this.t = 0;
    this.stillFor = 0;
    this.stats.spawned++;
    this.stats.bodies = plan.bodies.length;
    this.stats.spawnMs = +(performance.now() - started).toFixed(2);
    this.publish();
  }

  private follow(dt: number): void {
    const sim = this.ctx.sim;
    const plan = this.plan;
    if (!sim?.ragdollPoses || !plan) return;
    const count = sim.ragdollPoses(this.handle, this.poses);
    const p = this.poses;
    if (count === 0) {
      this.phase = "frozen"; // the sim went away under us (a scene switch): keep what we have
      return;
    }
    this.apply();
    this.t += dt;
    // fell THROUGH (a terrain cell released under it, a hole in a mesh) rather than
    // off something: well below where it died AND ground above it. Give the body
    // back to its death clip rather than let it drop out of the world. (A fall off
    // a ledge has sky above and carries on until the time cap.)
    if (
      p[1]! < this.floor - Math.max(2, this.quietTol * 60) &&
      sim.raycast?.([p[0]!, p[1]!, p[2]!], [0, 1, 0], 40, { layers: GROUND_LAYERS })
    ) {
      this.stats.fellThrough++;
      const kicked = this.kickAt;
      this.reset();
      this.kickAt = kicked; // the same death: not a new kick to restart on
      this.phase = "skipped";
      this.publish();
      return;
    }
    const still = sim.ragdollSettled?.(this.handle) ?? false;
    this.stillFor = still ? this.stillFor + dt : 0;
    // ... or no body has moved more than a hair since the window began: a hoof
    // or tail tip trembling in place on the ground is still, to anyone looking
    let moved = 0;
    for (let i = 0; i < count; i++) {
      const o = i * 7;
      moved = Math.max(moved, Math.hypot(p[o]! - this.anchor[o]!, p[o + 1]! - this.anchor[o + 1]!, p[o + 2]! - this.anchor[o + 2]!));
    }
    if (moved > this.quietTol) {
      this.anchor.set(p.subarray(0, count * 7));
      this.quietFrom = this.t;
    }
    const settle = this.param<number>("settleSeconds");
    if (this.stillFor >= settle || this.t - this.quietFrom >= settle || this.t >= this.param<number>("maxSeconds")) {
      // FREEZE: the bones keep the last pose, the bodies go
      sim.removeRagdoll?.(this.handle);
      this.handle = 0;
      this.phase = "frozen";
      this.stats.settleMs = Math.round(this.t * 1000);
      this.publish();
    }
  }

  /**
   * Bones from bodies, parents first (plan order is depth-first). Each body
   * bone's parent matrix is brought up to date by walking only the bones
   * between it and the body above it (a spine bone the trunk swallowed, a
   * clavicle) — never the whole skeleton per body.
   */
  private apply(): void {
    const plan = this.plan!;
    const bones = this.mesh!.skeleton.bones;
    const p = this.poses;
    for (let i = 0; i < plan.bodies.length; i++) {
      const bone = bones[plan.bodies[i]!.bone]!;
      const o = i * 7;
      this.v.set(p[o]!, p[o + 1]!, p[o + 2]!);
      this.q.set(p[o + 3]!, p[o + 4]!, p[o + 5]!, p[o + 6]!).multiply(this.boneRot[i]!);
      this.m.compose(this.v, this.q, this.boneScale[i]!);
      const parent = bone.parent;
      if (parent) {
        const chain = this.chains[i]!;
        if (chain === ROOT_CHAIN) parent.updateWorldMatrix(true, false);
        else for (const b of chain) b.matrixWorld.multiplyMatrices(b.parent!.matrixWorld, b.matrix);
        bone.matrixWorld.copy(this.m);
        this.m.premultiply(this.m2.copy(parent.matrixWorld).invert());
      } else bone.matrixWorld.copy(this.m);
      bone.matrix.copy(this.m);
      this.m.decompose(bone.position, bone.quaternion, bone.scale);
    }
  }

  /** Per body: the bones between it and the body above it, top-down (see apply). */
  private buildChains(): void {
    const plan = this.plan!;
    const bones = this.mesh!.skeleton.bones;
    const bodyBones = new Set(plan.bodies.map((b) => bones[b.bone]!));
    this.chains = plan.bodies.map((b) => {
      if (b.parent < 0) return ROOT_CHAIN;
      const chain: THREE.Object3D[] = [];
      for (let o = bones[b.bone]!.parent; o && !bodyBones.has(o as THREE.Bone); o = o.parent) {
        o.updateMatrix();
        chain.unshift(o);
      }
      return chain;
    });
  }

  private reset(): void {
    if (this.handle) this.ctx.sim?.removeRagdoll?.(this.handle);
    this.handle = 0;
    for (const s of this.saved) {
      s.bone.position.copy(s.p);
      s.bone.quaternion.copy(s.q);
      s.bone.scale.copy(s.s);
    }
    this.saved = [];
    if (this.body) delete this.body.userData["poseHoldUntil"];
    this.phase = "idle";
    this.kickAt = undefined;
  }

  private publish(): void {
    if (this.body) this.body.userData["ragdoll"] = { phase: this.phase, ...this.stats };
  }

  override onDispose(): void {
    if (this.handle) this.ctx.sim?.removeRagdoll?.(this.handle);
    this.handle = 0;
  }
}

/** WORLD | TERRAIN (@hitreg/physics Layers): what a ragdoll can land on. */
const GROUND_LAYERS = 0b11;
/** Metres below the lowest bone the ground may be and still count as under the body. */
const GROUND_REACH = 1.5;

/** Back height (m) at which `tip` is the full roll rate; a taller back turns proportionally slower. */
const TIP_HEIGHT = 0.6;

/** Drift damping at rest as a share of `restDamping` (spin). */
const REST_LINEAR = 1 / 3;

/** A stable +-1 per id (which flank a body falls on when the blow does not say). */
function hashSign(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return h & 1 ? 1 : -1;
}

function body3(o: THREE.Object3D): V3 {
  const e = o.matrixWorld.elements;
  return [e[12]!, e[13]!, e[14]!];
}

/**
 * Spread a burst of deaths over frames: at most `perFrame` ragdolls are built
 * per sim tick (an AoE killing a pack would otherwise build every body in one
 * frame). A death that misses a slot holds its death clip a frame longer.
 */
const spawnSlots = new WeakMap<object, { stamp: number; used: number }>();
function takeSpawnSlot(sim: object | null, stamp: number, perFrame: number): boolean {
  if (!sim || !(perFrame > 0)) return true;
  let s = spawnSlots.get(sim);
  if (!s) spawnSlots.set(sim, (s = { stamp, used: 0 }));
  if (s.stamp !== stamp) {
    s.stamp = stamp;
    s.used = 0;
  }
  if (s.used >= perFrame) return false;
  s.used++;
  return true;
}
