import * as THREE from "three";

/**
 * How far a clip turns the body, and a way to take the turn back out.
 *
 * Mixamo's weapon packs cut their attacks out of spinning sequences: a combo
 * step that opens with the character facing 140 degrees away and swings round
 * to the front, a "slash" that is a 300 degree pirouette, a guard held with the
 * chest square to one SIDE. On a body the controller keeps facing its target
 * that is a torso doing a 360 in place, and while moving (the swing rides the
 * upper-body layer, its torso anchored to the clip's own hips) a torso
 * pirouetting over legs that keep walking. Derek, 2026-09-29: "some swings make
 * the torso do a 360 which looks very very odd … especially while moving".
 *
 * The torso's facing is read off the SHOULDER line (clavicle roots, else the
 * upper arms) and the hips' off the thighs: a forward axis flips when the
 * chest pitches past vertical, a line across the body does not. Yaw is in degrees about world up, 0 = the model's
 * own forward (+Z, the way its gaits face), unwrapped across the clip so a spin
 * reads as 360, not 0.
 *
 * The correction turns the HIP bone about world up, per key — the whole body
 * turns with it, so the arms keep exactly what they do relative to the chest
 * and only the body's facing changes:
 *
 *   - a SPIN (the chest ends 150+ degrees from where it started) becomes a
 *     sweep across 60% of +-limit in the same direction, following the
 *     original's progress, so the swing keeps its wind-up and its acceleration
 *     into the hit;
 *   - anything else is soft-clamped to +-limit: unchanged up to 60% of it, then
 *     easing into the limit, so a turned guard comes round to face forward and
 *     a normal swing keeps its twist.
 *
 * `arms` keeps the arms where the clip had them while the torso squares up:
 * the clavicles take half the counter-turn and the upper arms the rest, so the
 * hands (and whatever they hold) point where they did and the SHOULDERS do the
 * reaching, and the neck keeps its facing so the head still looks forward.
 * For a held pose, not a swing — Derek on the two-handed parry,
 * 2026-09-29: "the torso doesnt twist to go into position and its moreso the
 * shoulders".
 */

const DEG = 180 / Math.PI;
const UP = new THREE.Vector3(0, 1, 0);

/** Bones the measurement needs, on the CC rig and the Quaternius/UE mannequin alike. */
const PAIRS = {
  chest: [/^(CC_Base_)?L_Upperarm$|^upperarm_l$/i, /^(CC_Base_)?R_Upperarm$|^upperarm_r$/i],
  hips: [/^(CC_Base_)?L_Thigh$|^thigh_l$/i, /^(CC_Base_)?R_Thigh$|^thigh_r$/i],
};
const CLAVICLES = [/^(CC_Base_)?L_Clavicle$|^clavicle_l$/i, /^(CC_Base_)?R_Clavicle$|^clavicle_r$/i];

function find(root, re) {
  let hit = null;
  root.traverse((o) => {
    if (!hit && re.test(o.name)) hit = o;
  });
  return hit;
}

export function yawBones(root, hipName) {
  const hip = find(root, new RegExp(`^${hipName}$`));
  const [cl, cr] = PAIRS.chest.map((re) => find(root, re));
  const [hl, hr] = PAIRS.hips.map((re) => find(root, re));
  if (!hip || !cl || !cr || !hl || !hr) return null;
  const clavicles = CLAVICLES.map((re) => find(root, re));
  // each arm as clavicle -> upper arm, when the rig has clavicles right above them
  const arms = clavicles.every((c, i) => c && [cl, cr][i].parent === c)
    ? clavicles.map((c, i) => ({ clavicle: c, upper: [cl, cr][i] }))
    : null;
  // the neck bone on the clavicles' parent: kept pointing where it did, or the
  // head inherits the chest's turn and looks off to the side
  const neck = arms?.[0].clavicle.parent?.children.find((c) => /neck/i.test(c.name)) ?? null;
  // The chest is read off the clavicle ROOTS where there are clavicles: they
  // sit on the top spine bone, so an `arms` pass (which turns the clavicles)
  // does not move the reading and a second pass changes nothing.
  const chest = arms ? arms.map((a) => a.clavicle) : [cl, cr];
  return { hip, chest, hips: [hl, hr], arms, neck };
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _f = new THREE.Vector3();

/** Facing of a left/right bone pair, degrees: (left − right) × up is forward. */
function pairYaw([left, right]) {
  left.getWorldPosition(_a);
  right.getWorldPosition(_b);
  _f.subVectors(_a, _b).cross(UP);
  return Math.atan2(_f.x, _f.z) * DEG;
}

const unwrapTo = (prev, a) => {
  let d = a - prev;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return prev + d;
};

const wrap180 = (a) => ((((a + 180) % 360) + 360) % 360) - 180;

/**
 * Sample a clip's chest and hip yaw at `times` (default: its hip rotation
 * track's own keys), and the world rotation of each `record` bone and its
 * parent. Leaves every bone as it found it.
 */
export function measureYaw(root, clip, bones, times, record = []) {
  const track = hipTrack(clip, bones.hip.name);
  const at = times ?? (track ? Array.from(track.times) : [0, clip.duration]);
  const saved = [];
  root.traverse((o) => saved.push([o, o.position.clone(), o.quaternion.clone(), o.scale.clone()]));
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  const chest = [];
  const hips = [];
  const worlds = record.map(() => ({ own: [], parent: [] }));
  for (const t of at) {
    mixer.setTime(t);
    root.updateMatrixWorld(true);
    record.forEach((b, k) => {
      worlds[k].own.push(b.getWorldQuaternion(new THREE.Quaternion()));
      worlds[k].parent.push(b.parent.getWorldQuaternion(new THREE.Quaternion()));
    });
    const c = pairYaw(bones.chest);
    const h = pairYaw(bones.hips);
    chest.push(chest.length ? unwrapTo(chest[chest.length - 1], c) : c);
    hips.push(hips.length ? unwrapTo(hips[hips.length - 1], h) : h);
  }
  action.stop();
  mixer.uncacheClip(clip);
  for (const [o, p, q, s] of saved) {
    o.position.copy(p);
    o.quaternion.copy(q);
    o.scale.copy(s);
  }
  root.updateMatrixWorld(true);
  return { times: at, chest, hips, worlds };
}

export function rotationTrack(clip, name) {
  const want = THREE.PropertyBinding.sanitizeNodeName(name);
  return clip.tracks.find((t) => {
    const p = THREE.PropertyBinding.parseTrackName(t.name);
    return p.nodeName === want && p.propertyName === "quaternion";
  });
}

export const hipTrack = rotationTrack;

/** A chest that ends this far from where it started is a spin, not a swing. */
const SPIN = 150;
/** Fraction of the limit passed through untouched before the soft clamp bends. */
const KNEE = 0.6;

/** One line of numbers per clip: how far it turns, and whether it spins. */
export function yawSummary(m) {
  const c = m.chest;
  const net = c[c.length - 1] - c[0];
  const lo = Math.min(...c);
  const hi = Math.max(...c);
  const twist = Math.max(...c.map((v, i) => Math.abs(v - m.hips[i])));
  return { net, lo, hi, twist, spin: Math.abs(net) >= SPIN };
}

function soft(x, limit) {
  const k = KNEE * limit;
  const ax = Math.abs(x);
  if (ax <= k) return x;
  return Math.sign(x) * (k + (limit - k) * Math.tanh((ax - k) / (limit - k)));
}

/** The chest yaw the clip should have at each sample, for a turn limit in degrees. */
export function targetYaw(chest, limit) {
  const c0 = chest[0];
  const net = chest[chest.length - 1] - c0;
  if (Math.abs(net) >= SPIN) {
    // progress through the spin, paced as the original paced it
    const dir = Math.sign(net);
    return chest.map((c) => soft(dir * KNEE * limit * (2 * ((c - c0) / net) - 1), limit));
  }
  // not a spin: whole turns at either end come off (a clip cut mid-spin can
  // start at 400), then the soft clamp
  const d0 = c0 - wrap180(c0);
  const d1 = chest[chest.length - 1] - wrap180(chest[chest.length - 1]);
  const n = Math.max(1, chest.length - 1);
  return chest.map((c, i) => soft(c - (d0 + ((d1 - d0) * i) / n), limit));
}

/**
 * Turn the clip's hip keys so the chest follows `targetYaw` (and, with `arms`,
 * the clavicle and upper-arm keys back so the arms hold their world pose).
 * Mutates those tracks' values in place (same key count, same times) and
 * returns the names of the bones it changed and the per-key turn in degrees.
 */
export function conditionYaw(root, clip, bones, limit, { arms = false } = {}) {
  const track = hipTrack(clip, bones.hip.name);
  if (!track) return null;
  const armBones = arms && bones.arms ? bones.arms.flatMap((a) => [a.clavicle, a.upper]) : [];
  const armTracks = armBones.map((b) => rotationTrack(clip, b.name));
  const keepArms = armBones.length > 0 && armTracks.every((t) => t && t.times.length === track.times.length);
  if (arms && !keepArms) console.warn(`  ${clip.name}: no clavicle/upper-arm keys on the hip's times — arms not kept`);
  const neckTrack = keepArms && bones.neck ? rotationTrack(clip, bones.neck.name) : null;
  const keepNeck = !!neckTrack && neckTrack.times.length === track.times.length;
  const record = keepArms ? [...armBones, ...(keepNeck ? [bones.neck] : [])] : [];
  const m = measureYaw(root, clip, bones, undefined, record);
  const want = targetYaw(m.chest, limit);
  const parent = new THREE.Quaternion();
  bones.hip.parent?.getWorldQuaternion(parent);
  const parentInv = parent.clone().invert();
  const turn = new THREE.Quaternion();
  const half = new THREE.Quaternion();
  const q = new THREE.Quaternion();
  const delta = [];
  for (let i = 0; i < track.times.length; i++) {
    const d = want[i] - m.chest[i];
    delta.push(d);
    turn.setFromAxisAngle(UP, d / DEG);
    q.fromArray(track.values, i * 4);
    // local' = P⁻¹ · turn · P · local: the turn applied in world space
    q.premultiply(parent).premultiply(turn).premultiply(parentInv).normalize();
    q.toArray(track.values, i * 4);
    if (!keepArms) continue;
    // Everything above the hip now sits `turn` further round. The clavicle
    // keeps half of that (the shoulder girdle follows the chest part way), the
    // upper arm none of it: local' = (new parent world)⁻¹ · wanted world.
    half.setFromAxisAngle(UP, d / 2 / DEG);
    for (let a = 0; a < armBones.length; a += 2) {
      const cl = m.worlds[a];
      const up = m.worlds[a + 1];
      const clWant = cl.own[i].clone().premultiply(half);
      q.copy(cl.parent[i]).premultiply(turn).invert().multiply(clWant).normalize();
      q.toArray(armTracks[a].values, i * 4);
      q.copy(clWant).invert().multiply(up.own[i]).normalize();
      q.toArray(armTracks[a + 1].values, i * 4);
    }
    if (keepNeck) {
      const nk = m.worlds[armBones.length];
      q.copy(nk.parent[i]).premultiply(turn).invert().multiply(nk.own[i]).normalize();
      q.toArray(neckTrack.values, i * 4);
    }
  }
  const changed = keepArms ? [...armBones, ...(keepNeck ? [bones.neck] : [])] : [];
  return { before: m, want, delta, bones: [bones.hip.name, ...changed.map((b) => b.name)] };
}
