import * as THREE from "three";

/**
 * Locomotion generated from an animal's own proportions, instead of borrowed.
 *
 * WHY. `autorig` borrows a donor's clips, and for most of a creature that is a
 * bargain. Gait is where it stops being one, because gait is anatomy. A dog
 * trots — diagonal pairs, half a cycle apart — and gallops with its legs in a
 * rotary sequence. A rat BOUNDS: both hind feet leave and land together, the
 * spine folding and snapping open to do most of the work, the forefeet catching
 * a stride later. No amount of retiming a dog's Run produces that, because the
 * footfall pattern is different, not the timing of the same pattern. It is the
 * one part of a borrowed library you cannot patch on the way through.
 *
 * So: pick a footfall pattern, put each foot on a trajectory, and let IK find
 * the joint angles. Everything else — how fast the gait travels, how long the
 * stride is, how high the feet lift, how much the body rises — is derived from
 * the animal being animated rather than authored, so the same three gaits fit a
 * rat, a wolf and a bear without a number being retyped.
 *
 * HOW SPEED IS DERIVED. Animals of different sizes move alike at equal FROUDE
 * number, v²/(g·h) with h the hip height: that is why a mouse's scurry and an
 * elephant's amble are the same gait, and why scaling a dog's walk to rat size
 * by pure geometry gives a rat that minces. Each gait here carries a Froude
 * coefficient, and its speed falls out of the hip height the skeleton was
 * actually fitted to. Stride length comes from leg length the same way. The
 * result is that the clip's depicted speed is a MEASUREMENT of something
 * derived, not a number anyone chose — and autorig's own clip-speed check reads
 * it back afterwards, which is a real test that this is self-consistent.
 *
 * WHAT IT DOES NOT DO. This produces cycles and a resting idle. It does not
 * produce acting — a bite, a death, a flinch have intent in them and belong to
 * an animator or a donor. Generate the locomotion, borrow the performance.
 */

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const G = 9.81;

/**
 * Footfall patterns, as phase within the cycle. A gait IS this table; the rest
 * is consequence.
 *
 *  - `phases`   when each foot touches down, 0..1 through the cycle.
 *  - `duty`     fraction of the cycle a foot spends on the ground. Above 0.5
 *               some foot is always down and the animal is walking; below it,
 *               there is a moment with nothing on the ground.
 *  - `froude`   speed coefficient: v = froude · √(g·hipHeight).
 *  - `stride`   stride length in leg-lengths.
 *  - `lift`     swing-foot clearance, in leg-lengths.
 *  - `bob`      vertical travel of the body, in leg-lengths.
 *  - `bobRate`  body rises this many times per cycle. Two for gaits that step
 *               in alternation; ONE for a bound, which is a single leap.
 *  - `flex`     total sagittal spine bend, radians. A bound is mostly spine —
 *               this is the difference between a rat and a small dog.
 *  - `pitch`    how much the body rotates nose-up into the leap.
 */
export const GAITS = {
  walk: {
    // Lateral sequence — hind, then the fore on the same side. The tetrapod
    // walk, near-universal at low speed.
    phases: { BL: 0, FL: 0.25, BR: 0.5, FR: 0.75 },
    duty: 0.65,
    froude: 0.35,
    stride: 1.5,
    lift: 0.16,
    bob: 0.035,
    bobRate: 2,
    flex: 0.07,
    pitch: 0.02,
  },
  trot: {
    // Diagonal pairs. What a dog does at speed, and what a rat does only in a
    // narrow band before it starts bounding.
    phases: { BL: 0, FR: 0, BR: 0.5, FL: 0.5 },
    duty: 0.45,
    froude: 0.95,
    stride: 2.0,
    lift: 0.26,
    bob: 0.055,
    bobRate: 2,
    flex: 0.1,
    pitch: 0.03,
  },
  bound: {
    // Both hinds together, both fores together. The rodent gallop: the spine
    // is the engine and the legs are the landing gear.
    phases: { BL: 0, BR: 0.02, FL: 0.42, FR: 0.44 },
    duty: 0.32,
    froude: 1.7,
    stride: 2.9,
    lift: 0.42,
    bob: 0.16,
    bobRate: 1,
    flex: 0.5,
    pitch: 0.12,
  },
  gallop: {
    // Rotary gallop — the four feet spread around the cycle. A dog's run.
    phases: { BL: 0, BR: 0.12, FL: 0.5, FR: 0.62 },
    duty: 0.3,
    froude: 1.9,
    stride: 3.1,
    lift: 0.4,
    bob: 0.12,
    bobRate: 1,
    flex: 0.3,
    pitch: 0.08,
  },
};

/** Idle is not a gait: nothing leaves the ground, and breathing is the motion. */
export const IDLE = { period: 2.6, breath: 0.012, flex: 0.03, sway: 0.02, headSway: 0.05 };

/** Deterministic per-creature jitter. Same seed, same rat, every time. */
function rng(seed) {
  let s = (seed | 0) || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

// ---------------------------------------------------------------- anatomy

/**
 * Find the four legs without being told which bones they are.
 *
 * A leg is a chain ending at a bone near the ground; its ROOT is the highest
 * ancestor that leads to exactly one such ending. That definition is what makes
 * this structural rather than a list of names: it finds the shoulder and the
 * pelvis on any rig, because the bone above them is the one the other legs also
 * hang from.
 */
export function discoverLimbs(nodes, T, exclude = new Set()) {
  const height = T.topY - T.groundY;
  const isLeaf = (n) => !nodes.some((c) => c.parent === n);
  const feet = nodes.filter(
    (n) => isLeaf(n) && !exclude.has(n.name) && n.worldPos.y < T.groundY + 0.3 * height,
  );
  if (feet.length < 4) return null;

  // How many ground-endings hang below each bone.
  const below = new Map(nodes.map((n) => [n, 0]));
  for (const f of feet) {
    for (let a = f; a; a = a.parent) below.set(a, below.get(a) + 1);
  }

  const limbs = [];
  for (const foot of feet) {
    let root = foot;
    while (root.parent && below.get(root.parent) === 1) root = root.parent;
    const chain = [];
    for (let n = foot; n; n = n.parent) {
      chain.unshift(n);
      if (n === root) break;
    }
    if (chain.length >= 3) limbs.push({ root, foot, chain });
  }
  if (limbs.length !== 4) return null;

  // Front from back by how far along the travel axis the leg hangs; left from
  // right by which side of the body it is on. The mesh has already been turned
  // to face +Z by this point, so those are just the signs of z and x.
  const midZ = limbs.reduce((s, l) => s + l.root.worldPos.z, 0) / 4;
  for (const l of limbs) {
    l.key = (l.root.worldPos.z > midZ ? "F" : "B") + (l.root.worldPos.x < 0 ? "L" : "R");
    l.neutral = V3(l.foot.worldPos.x, T.groundY, l.foot.worldPos.z);
    l.reach = 0;
    for (let i = 1; i < l.chain.length; i++) {
      l.reach += l.chain[i].worldPos.distanceTo(l.chain[i - 1].worldPos);
    }
    l.length = l.root.worldPos.y - T.groundY;
  }
  if (new Set(limbs.map((l) => l.key)).size !== 4) return null;
  return limbs;
}

/** Hips to nose, minus the head itself: the bones a bound folds and snaps. */
export function discoverSpine(nodes, hip, limbSet, exclude = new Set()) {
  const isLeaf = (n) => !nodes.some((c) => c.parent === n);
  const heads = nodes.filter((n) => isLeaf(n) && !limbSet.has(n) && !exclude.has(n.name));
  if (!heads.length) return { spine: [], head: null };
  const nose = heads.reduce((a, b) => (b.worldPos.z > a.worldPos.z ? b : a));
  const path = [];
  for (let n = nose; n; n = n.parent) {
    path.unshift(n);
    if (n === hip) break;
  }
  if (path[0] !== hip) return { spine: [], head: null };
  // Drop the hip (it carries the body, not the bend) and the last two, which
  // are the nose and its tip on every rig that has them.
  const body = path.slice(1, Math.max(1, path.length - 2));
  return { spine: body.slice(0, -1), head: body[body.length - 1] ?? null };
}

// ---------------------------------------------------------------- IK

/**
 * Damped CCD, started from the rest pose every frame.
 *
 * Starting from rest is what keeps the answer sane without joint limits: a leg
 * bends the way it is already bent, because the first iteration has nowhere
 * else to go. Damping each step keeps it from snapping straight through the
 * knee on a target near the limit of reach. The toe bones are held rigid and
 * simply extend the chain — a foot is a lever, not a joint, for this purpose.
 */
function solveIK(bones, target, iterations = 10, damp = 0.65) {
  const effector = bones[bones.length - 1];
  const driven = bones.slice(0, -1);
  const bp = V3();
  const ep = V3();
  const pq = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  for (let it = 0; it < iterations; it++) {
    for (let i = driven.length - 1; i >= 0; i--) {
      const bone = driven[i];
      bone.getWorldPosition(bp);
      effector.getWorldPosition(ep);
      const toE = ep.sub(bp);
      const toT = target.clone().sub(bp);
      if (toE.lengthSq() < 1e-10 || toT.lengthSq() < 1e-10) continue;
      q.setFromUnitVectors(toE.normalize(), toT.normalize());
      // Partial step, in world space, about this bone's own origin.
      q.slerp(new THREE.Quaternion(), 1 - damp);
      bone.parent.getWorldQuaternion(pq);
      const local = pq.clone().invert().multiply(q).multiply(pq);
      bone.quaternion.premultiply(local);
      bone.updateMatrixWorld(true);
    }
  }
}

// ---------------------------------------------------------------- the cycle

/**
 * Where a foot is, at this point in its own cycle.
 *
 * `excursion` is how far the foot travels backward RELATIVE TO THE BODY during
 * stance, and it is not the stride length — it is stride × duty. The body
 * covers a whole stride per cycle, but the foot is only down for part of it, so
 * a foot dragged the full stride depicts a speed inflated by 1/duty: 1.5× on a
 * walk, over 3× on a gallop. The clip-speed measurement catches this if it is
 * ever got wrong again, which is most of the reason to derive speed rather than
 * type it.
 */
function footAt(phase, gait, excursion, lift, neutral) {
  const p = ((phase % 1) + 1) % 1;
  const out = neutral.clone();
  if (p < gait.duty) {
    // Stance: planted, and the ground slides past. The whole depicted speed of
    // the clip lives in this line.
    const s = p / gait.duty;
    out.z += excursion * (0.5 - s);
    return out;
  }
  // Swing: forward and over, with the ease that keeps the foot from snapping
  // off the ground and slamming back onto it.
  const s = (p - gait.duty) / (1 - gait.duty);
  const e = s * s * (3 - 2 * s);
  out.z += excursion * (-0.5 + e);
  out.y += lift * Math.sin(Math.PI * s);
  return out;
}

/**
 * Build one locomotion clip.
 *
 * @returns {{ clip: THREE.AnimationClip, speed: number, cycle: number }} speed
 *   in metres per second, as depicted — the caller can check it against what
 *   the finished clip measures.
 */
export function buildGaitClip(ctx, name, gaitName, opts = {}) {
  const { mesh, skeleton, limbs, spine, head, hip, rest, T, modelScale } = ctx;
  const gait = GAITS[gaitName];
  if (!gait) return null;
  const jitter = opts.jitter ?? (() => 0.5);
  const vary = (base, spread) => base * (1 + (jitter() - 0.5) * 2 * spread);

  const legLength = limbs.reduce((s, l) => s + l.length, 0) / limbs.length;
  const hipHeightM = (hip.worldPos.y - T.groundY) * modelScale;
  const speed = opts.speed ?? vary(gait.froude * Math.sqrt(G * Math.max(hipHeightM, 1e-3)), 0.04);
  const strideUnits = vary(gait.stride, 0.08) * legLength;
  const cycle = Math.max(0.2, strideUnits * modelScale / Math.max(speed, 1e-3));
  const duty0 = Math.min(0.9, vary(gait.duty, 0.05));
  // Stride is what the BODY covers per cycle; the foot only travels the part of
  // it that it is on the ground for.
  const excursion = strideUnits * duty0;
  const lift = vary(gait.lift, 0.15) * legLength;
  const bob = vary(gait.bob, 0.12) * legLength;
  const flex = vary(gait.flex, 0.12);
  const duty = { ...gait, duty: duty0 };

  const frames = Math.max(4, Math.round(cycle * (opts.fps ?? 30)));
  const times = [];
  const quats = new Map(skeleton.bones.map((b) => [b.name, []]));
  const hipPos = [];

  for (let f = 0; f <= frames; f++) {
    const phase = (f % frames) / frames;
    times.push((f / frames) * cycle);

    skeleton.pose();

    // Body: rise and fall, and pitch into the stride.
    const rise = Math.sin(2 * Math.PI * gait.bobRate * phase);
    const hipBone = hip.bone;
    hipBone.position.copy(rest.get(hip.name).position);
    hipBone.position.y += bob * rise;
    hipBone.quaternion.copy(rest.get(hip.name).quaternion);
    hipBone.rotateX(vary(gait.pitch, 0.2) * Math.cos(2 * Math.PI * gait.bobRate * phase) * -1);

    // Spine: the fold and snap, spread over however many bones there are.
    const bend = (flex / Math.max(1, spine.length)) * Math.sin(2 * Math.PI * gait.bobRate * phase + Math.PI / 2);
    for (const s of spine) {
      s.bone.quaternion.copy(rest.get(s.name).quaternion);
      s.bone.rotateX(bend);
    }
    if (head) {
      // The head is the one thing an animal holds still while the rest of it
      // heaves; counter-rotating it is most of what reads as an animal rather
      // than a puppet.
      head.bone.quaternion.copy(rest.get(head.name).quaternion);
      head.bone.rotateX(-bend * spine.length * 0.6);
    }

    mesh.updateMatrixWorld(true);

    for (const limb of limbs) {
      const target = footAt(phase + (gait.phases[limb.key] ?? 0), duty, excursion, lift, limb.neutral);
      // Never ask for more than the leg has. A target past full reach is where
      // CCD produces a straight, quivering limb.
      const rootP = limb.chain[0].bone.getWorldPosition(V3());
      const d = target.clone().sub(rootP);
      if (d.length() > limb.reach * 0.98) target.copy(rootP).add(d.setLength(limb.reach * 0.98));
      solveIK(limb.chain.map((n) => n.bone), target);
    }

    for (const b of skeleton.bones) {
      const q = quats.get(b.name);
      q.push(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    }
    hipPos.push(hipBone.position.x, hipBone.position.y, hipBone.position.z);
  }

  const tracks = [];
  for (const b of skeleton.bones) {
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, quats.get(b.name)));
  }
  tracks.push(new THREE.VectorKeyframeTrack(`${hip.name}.position`, times, hipPos));

  skeleton.pose();
  mesh.updateMatrixWorld(true);

  const clip = new THREE.AnimationClip(name, cycle, tracks);
  // The last key repeats the first, so the loop is already closed and the
  // loop-fix pass has nothing to do.
  clip.userData = { generated: gaitName, speed, cycle };
  return { clip, speed, cycle };
}

/**
 * A standing idle: feet planted, body breathing, legs quietly compensating.
 * The IK is what makes it read — the knees soften as the chest rises, which is
 * a thing legs do and a sine wave on the hips is not.
 */
export function buildIdleClip(ctx, name, opts = {}) {
  const { mesh, skeleton, limbs, spine, head, hip, rest, T, modelScale } = ctx;
  const jitter = opts.jitter ?? (() => 0.5);
  const vary = (base, spread) => base * (1 + (jitter() - 0.5) * 2 * spread);
  const legLength = limbs.reduce((s, l) => s + l.length, 0) / limbs.length;

  const period = vary(IDLE.period, 0.15);
  const frames = Math.max(8, Math.round(period * (opts.fps ?? 30)));
  const times = [];
  const quats = new Map(skeleton.bones.map((b) => [b.name, []]));
  const hipPos = [];

  for (let f = 0; f <= frames; f++) {
    const phase = (f % frames) / frames;
    times.push((f / frames) * period);
    skeleton.pose();

    const breath = Math.sin(2 * Math.PI * phase);
    const hipBone = hip.bone;
    hipBone.position.copy(rest.get(hip.name).position);
    hipBone.position.y += IDLE.breath * legLength * breath;
    hipBone.quaternion.copy(rest.get(hip.name).quaternion);
    // A slow weight shift side to side, at half the breathing rate, so the two
    // never line up into an obvious pulse.
    hipBone.rotateZ(IDLE.sway * Math.sin(Math.PI * phase * 2 + 1.1) * 0.5);

    const bend = (IDLE.flex / Math.max(1, spine.length)) * breath;
    for (const s of spine) {
      s.bone.quaternion.copy(rest.get(s.name).quaternion);
      s.bone.rotateX(bend);
    }
    if (head) {
      head.bone.quaternion.copy(rest.get(head.name).quaternion);
      head.bone.rotateX(-bend * spine.length * 0.5);
      head.bone.rotateY(IDLE.headSway * Math.sin(2 * Math.PI * phase * 0.5 + 2.2));
    }
    mesh.updateMatrixWorld(true);

    for (const limb of limbs) {
      solveIK(limb.chain.map((n) => n.bone), limb.neutral.clone());
    }

    for (const b of skeleton.bones) {
      const q = quats.get(b.name);
      q.push(b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w);
    }
    hipPos.push(hipBone.position.x, hipBone.position.y, hipBone.position.z);
  }

  const tracks = [];
  for (const b of skeleton.bones) {
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, quats.get(b.name)));
  }
  tracks.push(new THREE.VectorKeyframeTrack(`${hip.name}.position`, times, hipPos));
  skeleton.pose();
  mesh.updateMatrixWorld(true);

  const clip = new THREE.AnimationClip(name, period, tracks);
  clip.userData = { generated: "idle", speed: 0, cycle: period };
  return { clip, speed: 0, cycle: period };
}

export { rng };
