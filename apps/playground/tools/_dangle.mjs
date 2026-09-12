import * as THREE from "three";

/**
 * Secondary motion for a hanging bone chain, solved once and baked into the
 * clips.
 *
 * WHY THIS EXISTS. `autorig` copies a donor's clips unchanged, which is what
 * makes borrowing a whole animation library sound — but it also copies the
 * donor's ANATOMY of motion, and that does not always transfer. A dog carries
 * its tail: it is short, muscular, held up, and keyed as deliberately as a
 * limb. A rat's tail is long, limp and heavy — it hangs, it drags on the
 * ground, and it arrives wherever the body left it a moment ago. Play a dog's
 * tail on a rat and every clip is subtly wrong in the same way, because a
 * carried tail is a pose and a hung tail is a consequence.
 *
 * So the chain stops being keyed and starts being SIMULATED: a Verlet rope
 * hung off the body, pulled down by gravity and back toward the pose the rig
 * carries, with the ground as a floor. The clips keep the donor's body and get
 * the target's tail.
 *
 * WHY BAKED, NOT LIVE. `clothSway` in the renderer argues the opposite way for
 * cloth, and the difference is worth stating: cloth needs to answer to what the
 * player is doing this instant, so it pays a per-character cost forever. A
 * tail's motion is almost entirely a function of the clip playing — a running
 * rat's tail does the same thing every stride — so solving it once at bake time
 * gets the look for nothing at runtime, on every client, and on a headless
 * server that never runs a renderer at all. What it cannot do is react to a
 * turn the animation does not contain. If that turns out to matter, this stays
 * as the resting shape and a live spring layers on top; it does not become
 * wasted work.
 *
 * The one rule this shares with the rest of autorig: it rewrites CLIPS, never
 * the rest pose. A rest rotation is the thing every clip is measured against,
 * and moving one silently rewrites every frame from that bone down.
 */

const V3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const ONE = V3(1, 1, 1);

export const DANGLE_DEFAULTS = {
  /** Downward pull, in chain-lengths per second². Scale-free on purpose. */
  gravity: 6,
  /** How hard the chain returns to the pose the rig carries. 0 = pure rope. */
  stiffness: 7,
  /** Velocity bled off per step, 0..1. This is the lag. */
  damping: 0.12,
  /** Recorded keys per second. */
  fps: 30,
  /** Simulation substeps per recorded frame. */
  sub: 4,
  /** Seconds held on frame 0 before recording, so a clip opens settled. */
  warm: 1,
};

/**
 * The chain from `rootName` down, following single children. A fork ends it —
 * a bone with two children is a shoulder, not a link in a rope.
 */
export function resolveChain(bones, rootName) {
  const want = rootName.toLowerCase();
  let b = bones.find((x) => x.name === rootName) ?? bones.find((x) => x.name.toLowerCase() === want);
  if (!b) return null;
  const chain = [b];
  for (;;) {
    const kids = b.children.filter((c) => c.isBone);
    if (kids.length !== 1) break;
    b = kids[0];
    chain.push(b);
  }
  return chain;
}

/**
 * Does the pose at the end of the clip match the pose at the start? A cycle
 * has to be simulated for a whole extra pass before it is recorded or the
 * seam carries whatever the rope was doing when it started; a one-shot must
 * NOT be, or a death animation opens with its tail already limp on the floor.
 */
function clipLoops(mesh, mixer, clip, bones, parent) {
  const inv = new THREE.Matrix4();
  const sample = (t) => {
    // Never exactly the duration: the action loops, so that time wraps to zero
    // and every clip in the world would test as a perfect cycle.
    mixer.setTime(Math.min(t, clip.duration * 0.9995));
    mesh.updateMatrixWorld(true);
    // Measured in the chain's own parent frame, not the world. A gait that
    // carries the body forward — or just bobs the hips — is still a cycle, and
    // comparing world positions would call every one of them a one-shot.
    inv.copy(parent.matrixWorld).invert();
    return bones.map((b) => b.getWorldPosition(V3()).applyMatrix4(inv));
  };
  const spread = (x, y) => {
    let d = 0;
    for (let i = 0; i < x.length; i++) d = Math.max(d, x[i].distanceTo(y[i]));
    return d;
  };

  // The seam is measured against ONE FRAME OF THIS CLIP, not against zero.
  // Cycles are conventionally authored so the last key is the frame *before*
  // the repeat, not a copy of the first — so a fast gallop's first and last
  // poses are a whole stride-frame apart and an absolute threshold calls it a
  // one-shot. A frame of separation is a cycle; a death animation's ending is
  // many frames from its beginning.
  const keys = Math.max(2, ...clip.tracks.map((t) => t.times.length));
  const interval = clip.duration / (keys - 1);
  const poses = [];
  for (let t = 0; t < clip.duration - 1e-6; t += interval) poses.push(sample(t));
  const last = sample(clip.duration);
  const steps = [];
  for (let i = 1; i < poses.length; i++) steps.push(spread(poses[i - 1], poses[i]));
  steps.push(spread(poses[poses.length - 1], last));
  steps.sort((x, y) => x - y);
  const typical = steps[Math.floor(steps.length / 2)] || 1e-6;

  const worst = spread(poses[0], last);
  let reach = 1e-6;
  for (const p of poses[0]) reach = Math.max(reach, p.length());
  return { loops: worst < Math.max(1.6 * typical, 0.02 * reach), worst, reach };
}

/**
 * Replace a chain's rotation tracks in `clip` with a solved hang.
 *
 * `restQuat` / `restPos` are the chain's own bind-pose locals, captured before
 * any mixer has touched the skeleton — they are the "carried" pose the spring
 * pulls back toward, and the frame every emitted rotation is measured against.
 *
 * @returns {THREE.AnimationClip} a new clip; the input is left alone.
 */
export function bakeDangle(mesh, mixer, clip, chain, restQuat, restPos, opts = {}) {
  const o = { ...DANGLE_DEFAULTS, ...opts };
  const m = chain.length;
  if (m < 2) return clip;

  const parent = chain[0].parent ?? mesh;
  const segLen = [];
  for (let i = 1; i < m; i++) segLen.push(restPos[i].length());
  const total = segLen.reduce((a, b) => a + b, 0);
  if (!(total > 0) || !(clip.duration > 0)) return clip;

  const floorY = typeof o.floorY === "number" ? o.floorY : null;
  const gravity = V3(0, -o.gravity * total, 0);

  const action = mixer.clipAction(clip);
  action.reset();
  action.play();
  const cycle = clipLoops(mesh, mixer, clip, chain, parent);
  const loops = cycle.loops;

  // Where each joint would be if the chain just rode the body rigidly, in the
  // pose the rig carries. This is both the spring's target and the frame the
  // emitted rotations are measured against.
  const restFollow = [];
  const scratch = new THREE.Matrix4();
  const readRest = (t) => {
    mixer.setTime(Math.min(t, clip.duration * 0.9995));
    mesh.updateMatrixWorld(true);
    const W = parent.matrixWorld.clone();
    restFollow.length = 0;
    for (let i = 0; i < m; i++) {
      W.multiply(scratch.compose(restPos[i], restQuat[i], ONE));
      restFollow.push(V3().setFromMatrixPosition(W));
    }
    return W;
  };

  const P = [];
  const prev = [];
  readRest(0);
  for (let i = 0; i < m; i++) {
    P.push(restFollow[i].clone());
    prev.push(restFollow[i].clone());
  }

  const step = (dt) => {
    P[0].copy(restFollow[0]);
    prev[0].copy(restFollow[0]);
    for (let i = 1; i < m; i++) {
      const vel = P[i].clone().sub(prev[i]).multiplyScalar(1 - o.damping);
      const next = P[i].clone().add(vel).add(gravity.clone().multiplyScalar(dt * dt));
      next.lerp(restFollow[i], Math.min(1, o.stiffness * dt));
      // Length first, then the floor, twice: one pass alone leaves the chain
      // either stretched or sunk, and which one depends on the frame.
      for (let k = 0; k < 2; k++) {
        const d = next.clone().sub(P[i - 1]);
        const len = d.length() || 1;
        next.copy(P[i - 1]).add(d.multiplyScalar(segLen[i - 1] / len));
        if (floorY !== null && next.y < floorY) next.y = floorY;
      }
      prev[i].copy(P[i]);
      P[i].copy(next);
    }
  };

  const frames = Math.max(2, Math.round(clip.duration * o.fps));
  const substeps = frames * o.sub;
  const dtWarm = 1 / (o.fps * o.sub);
  const dtPass = clip.duration / substeps;

  readRest(0);
  for (let i = 0; i < Math.round(o.warm * o.fps * o.sub); i++) step(dtWarm);

  const runPass = (record) => {
    const keys = [];
    for (let s = 0; s <= substeps; s++) {
      // The body advances every substep, not every recorded frame: driving the
      // rope off a staircase leaves a little of that jolt in every key.
      const t = (s / substeps) * clip.duration;
      readRest(t);
      if (s > 0) step(dtPass);
      if (record && s % o.sub === 0) {
        keys.push({ t, world: P.map((p) => p.clone()), parentW: parent.matrixWorld.clone() });
      }
    }
    return keys;
  };
  if (loops) runPass(false);
  const keys = runPass(true);
  action.stop();
  mixer.uncacheClip(clip);

  // ---- world positions back to local rotations
  const times = keys.map((k) => k.t);
  const values = chain.map(() => []);
  const pq = new THREE.Quaternion();
  for (const key of keys) {
    let parentQ = new THREE.Quaternion();
    key.parentW.decompose(V3(), parentQ, V3());
    for (let i = 0; i < m - 1; i++) {
      const restWorld = parentQ.clone().multiply(restQuat[i]);
      const dRest = restPos[i + 1].clone().applyQuaternion(restWorld).normalize();
      const dWant = key.world[i + 1].clone().sub(key.world[i]);
      if (dWant.lengthSq() < 1e-12) dWant.copy(dRest);
      else dWant.normalize();
      const worldQ = pq.setFromUnitVectors(dRest, dWant).clone().multiply(restWorld);
      const local = parentQ.clone().invert().multiply(worldQ);
      values[i].push(local.x, local.y, local.z, local.w);
      parentQ = worldQ;
    }
    // The tip drives vertices but nothing below it. Hold it at rest rather
    // than leave the donor's keyed wag disagreeing with the solved chain.
    const tip = restQuat[m - 1];
    values[m - 1].push(tip.x, tip.y, tip.z, tip.w);
  }

  if (loops) {
    // Close the seam exactly. The extra pass makes the two ends agree to
    // within rounding; this makes them identical.
    for (const v of values) for (let c = 0; c < 4; c++) v[v.length - 4 + c] = v[c];
  }

  const owned = new Set(chain.map((b) => `${b.name}.quaternion`));
  const tracks = clip.tracks.filter((t) => !owned.has(t.name));
  chain.forEach((b, i) => {
    tracks.push(new THREE.QuaternionKeyframeTrack(`${b.name}.quaternion`, times, values[i]));
  });
  const out = new THREE.AnimationClip(clip.name, clip.duration, tracks);
  out.userData = {
    ...(clip.userData ?? {}),
    dangled: chain[0].name,
    looped: loops,
    seam: cycle.worst / cycle.reach,
  };
  return out;
}
