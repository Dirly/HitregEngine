/**
 * What a baked locomotion clip DEPICTS, read back off its own skeleton: the
 * ground speed it was authored at (`clipSpeeds`) and the moments each foot
 * touches down (`clipFootfalls`) — and, for one-shots that step, how far the
 * ground goes by under them (`clipAdvance`). Shared by `retarget` (after a
 * bake, and in `--measure` mode against an already-baked GLB).
 *
 * Both numbers exist because a controller cannot guess them. Without the
 * speed, a clip plays at whatever rate its gait is tuned to and the feet skate
 * by the ratio. Without the footfalls, footstep sounds come off a distance
 * counter that knows nothing about the legs — a fixed beat that drifts across
 * the stride and lands mid-swing.
 */
import * as THREE from "three";

/**
 * Sample every clip once and hand each measurement the same tracks.
 * @returns {Map<string, { dt: number, hips: THREE.Vector3[], feet: { toe: THREE.Vector3[], ankle: THREE.Vector3[] | null }[] }>}
 */
function sampleClips(root, bones, clips, rigMap, N) {
  const hip = bones.get(rigMap.hip);
  const toes = (rigMap.contacts ?? []).map((n) => bones.get(n)).filter(Boolean);
  const out = new Map();
  if (!hip || toes.length === 0) return out;
  // The toe's parent is the ankle. A walk lands HEEL first — a toe-only
  // detector hears the step a tenth of a second late, which is exactly the
  // gap an ear picks out between a footstep and the foot.
  const ankles = toes.map((t) => (t.parent?.isBone ? t.parent : null));
  const mixer = new THREE.AnimationMixer(root);
  for (const clip of clips) {
    const dt = clip.duration / N;
    if (!(dt > 0)) continue;
    const action = mixer.clipAction(clip);
    action.play();
    const hips = [];
    const feet = toes.map((_, k) => ({ toe: [], ankle: ankles[k] ? [] : null }));
    // [0, N): a looping clip's last key IS its first, so sampling the end as
    // well would count one pose twice and put a phantom contact at t = 1.
    for (let i = 0; i < N; i++) {
      mixer.setTime(clip.duration * (i / N));
      root.updateMatrixWorld(true);
      hips.push(hip.getWorldPosition(new THREE.Vector3()));
      toes.forEach((t, k) => {
        feet[k].toe.push(t.getWorldPosition(new THREE.Vector3()));
        feet[k].ankle?.push(ankles[k].getWorldPosition(new THREE.Vector3()));
      });
    }
    action.stop();
    mixer.uncacheClip(clip);
    out.set(clip.name, { dt, hips, feet });
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  return out;
}

/**
 * In-place clips carry no translation, but the speed is still recoverable:
 * while a foot is PLANTED it slides under the hip at exactly the speed the
 * character is meant to be travelling. So measure that slip, over frames where
 * the toe is genuinely on the ground, as a planar MAGNITUDE — a strafe's
 * ground goes past sideways, a backpedal's forwards.
 *
 * "Planted" is judged per foot, against that foot's own lowest point in the
 * clip, and that foot must reach the ground at all. An absolute line at the
 * bind pose's sole (the old test) reads a strafe wrong: a sideways run lands
 * on the edge of the foot, the toe bone rides a few centimetres off the floor
 * through much of the stance, and a fixed line keeps mostly the roll-on and
 * roll-off frames, where the foot is barely moving. A band relative to the
 * foot's own low point also cannot call a sprint's flight frames stance,
 * which is what "the lowest 25% of this foot's range" once did.
 */
function speedOf(sample, groundY, height, band = 0.02) {
  const { dt, hips, feet } = sample;
  const slips = [];
  for (const { toe } of feet) {
    let lowest = Infinity;
    for (const p of toe) lowest = Math.min(lowest, p.y);
    // a foot that never reaches the ground is not carrying anything
    if (lowest > groundY) continue;
    const planted = lowest + band * height;
    for (let i = 0; i < toe.length; i++) {
      const j = (i + 1) % toe.length;
      if (toe[i].y > planted || toe[j].y > planted) continue;
      // planted foot, measured against the hip: what is left is the ground
      // sliding past, which is the speed the clip depicts
      const d = toe[i].clone().sub(hips[i]).sub(toe[j].clone().sub(hips[j]));
      d.y = 0;
      slips.push(d.length() / dt);
    }
  }
  if (slips.length < 6) return 0;
  slips.sort((a, b) => a - b);
  return slips[Math.floor(slips.length / 2)];
}

/**
 * The normalized times (0..1 of the clip) where each foot touches down.
 *
 * A foot's height is the lower of its toe and its ankle, each measured from
 * its own lowest point in this clip — heel strike and toe strike both count,
 * whichever comes first, and a clip that lifts the whole body (a sprint's
 * flight) still finds its contacts. (The idea is autorig's per-foot stance
 * test: the bottom of the foot's OWN arc, plus a fraction of body height.)
 *
 * Height alone is not enough. A crouch-walk puts its sole down a few
 * centimetres above where the toe ends the stance, and a two-handed walk
 * lets the heel hover just off the floor while the leg still reaches forward:
 * a band alone hears the first a quarter-second late and the second early. So
 * the foot lands when it is low AND has started moving with the ground — its
 * slide under the hip has picked up the direction and most of the speed it
 * has for the rest of the stance. A foot right down on its lowest point
 * counts whatever it is doing, for the clips too slow to have a direction.
 *
 * Walking round the loop from the foot's highest point, a foot must lift
 * clear again before it can land again, so a heel-to-toe roll is one step.
 *
 * ORDER carries meaning: the LEFT foot's (first) contact leads, then the rest
 * in stride order round the loop. Footsteps do not care, but the controller's
 * stance carry lines one clip's upper body up on another's legs by the left
 * contact — aligning two lists whose first entries are different feet puts
 * the arms half a stride out.
 *
 * @param leftIndex which entry of `sample.feet` is the left foot (-1 = unknown: plain sorted)
 * @returns {number[]}
 */
function footfallsOf(sample, height, clipSpeed, leftIndex = -1) {
  const { dt, hips, feet } = sample;
  const N = hips.length;
  const band = 0.015 * height;
  const events = [];
  let leftFirst = Infinity;
  for (let k = 0; k < feet.length; k++) {
    const { toe, ankle } = feet[k];
    const low = (track) => track.reduce((m, p) => Math.min(m, p.y), Infinity);
    const toeLow = low(toe);
    const ankleLow = ankle ? low(ankle) : Infinity;
    const h = toe.map((p, i) => Math.min(p.y - toeLow, ankle ? ankle[i].y - ankleLow : Infinity));
    let lift = 0;
    let top = 0;
    h.forEach((v, i) => {
      if (v > lift) (lift = v), (top = i);
    });
    // a foot that never leaves the ground is shuffling, not stepping
    if (lift < 1.5 * band) continue;
    // the foot's slide under the hip, per sample, and which way it goes while down
    const slide = toe.map((p, i) => {
      const j = (i + 1) % N;
      const d = toe[j].clone().sub(hips[j]).sub(p.clone().sub(hips[i]));
      d.y = 0;
      return d.divideScalar(dt);
    });
    const stance = new THREE.Vector3();
    let n = 0;
    h.forEach((v, i) => {
      if (v <= band) stance.add(slide[i]), n++;
    });
    if (n > 0) stance.divideScalar(n);
    // The stance average is only trusted for its DIRECTION: a slow clip spends
    // most of its lowest frames rolling off the toe, not sliding, so how FAST
    // the ground goes by is the clip speed measured over the whole stance.
    const along = stance.length();
    const dir = along > 0 ? stance.clone().divideScalar(along) : stance;
    const moving = along > 0 && clipSpeed > 0.3;
    const rearm = Math.max(3 * band, 0.5 * lift);
    let airborne = true;
    for (let s = 1; s <= N; s++) {
      const i = (top + s) % N;
      const v = h[i];
      if (!airborne) {
        if (v >= rearm) airborne = true;
        continue;
      }
      const down =
        v <= (moving ? band / 3 : band) ||
        (moving && v <= 2 * band && slide[i].dot(dir) >= 0.5 * clipSpeed);
      if (!down) continue;
      events.push(i / N);
      if (k === leftIndex) leftFirst = Math.min(leftFirst, i / N);
      airborne = false;
    }
  }
  events.sort((a, b) => a - b);
  if (Number.isFinite(leftFirst)) {
    const from = (t) => (((t - leftFirst) % 1) + 1) % 1;
    events.sort((a, b) => from(a) - from(b));
  }
  return events.map((t) => Number(t.toFixed(3)));
}

/** Looping gaits — walks, runs, sprints, strafes, crouch-walks — not their enter/exit one-shots. */
const LOCOMOTION = /(^|_)(walk|run|sprint|jog|strafe|crouch_fwd)(_|$)(?!.*(enter|exit|start|stop|land))/i;

/**
 * @param root      the character (world transforms are metres/units as it will ship)
 * @param bones     name -> bone
 * @param clips     the clips to measure
 * @param rigMap    `{ hip, contacts }` — contact bones are the toes
 * @param groundY   the sole's height at bind, plus a little
 * @param height    stature in the same units (bands scale with it)
 * @returns {{ speeds: Record<string, number>, footfalls: Record<string, number[]> }}
 */
export function measureLocomotion(root, bones, clips, rigMap, groundY, height) {
  const samples = sampleClips(root, bones, clips, rigMap, 240);
  // which contact bone is the LEFT foot — the footfall lists lead with it
  const leftIndex = (rigMap.contacts ?? []).findIndex((n) => /(^|[^a-z])(l|left)([^a-z]|$)/i.test(n));
  const speeds = {};
  const footfalls = {};
  for (const clip of clips) {
    // A clip with no ground under it has no ground speed. Swimming measures
    // ~0.8 units/sec off legs kicking past the hip, and a controller told that
    // number plays the stroke at four times its rate — so the one case where
    // the measurement is not merely useless but actively wrong is excluded by
    // name. The controller rates a stroke against its own swim speed, and its
    // stroke sound comes off that cadence, not off feet that touch nothing.
    if (/^(swim|tread)/i.test(clip.name)) continue;
    const sample = samples.get(clip.name);
    if (!sample) continue;
    const speed = speedOf(sample, groundY, height);
    // Below walking pace it isn't locomotion — it's a turn, a landing or an
    // idle shuffle, where a planted foot pivoting reads as a trickle of slip.
    // Reporting those invites them into a controller that never plays them.
    if (!(speed > 0.5)) continue;
    speeds[clip.name] = Number(speed.toFixed(2));
    // Footfalls only for the cycles a controller steps to. A dodge or a sword
    // combo has contacts too, but nothing plays a footstep off a one-shot.
    if (!LOCOMOTION.test(clip.name)) continue;
    const falls = footfallsOf(sample, height, speed, leftIndex);
    if (falls.length > 0) footfalls[clip.name] = falls;
  }
  return { speeds, footfalls };
}

/**
 * One-shots that are not worth an advance curve: loops that stand in place,
 * turns (their feet pivot, which reads as a sideways slip), swims, and the
 * jump/leap/slide cycles whose travel the controller already owns.
 */
const NO_ADVANCE = /(^|_)(idle|turn_[lr]|swim|tread|jump_loop|leap_loop|slide_loop|channel_loop)(_|$)/i;

/** Samples per clip for the advance curve, and points kept in the baked curve (20 spans). */
const ADVANCE_SAMPLES = 120;
const ADVANCE_POINTS = 21;

/**
 * How far the GROUND goes by under a one-shot clip — a lunge, a sword combo,
 * a heavy swing that steps in — as a cumulative curve over the clip, in the
 * model's own frame (`f` along +Z, `s` along +X), metres at the scale it
 * ships in.
 *
 * `retarget` bakes clips in place (the hip's start-to-end drift is removed),
 * so a step forward is a foot that slides BACK under a body that stays put.
 * Played on a capsule that does not move, that is exactly the foot-skate and
 * snap-back you see. Read backwards, it is the advance: while a foot is
 * planted, the ground under it moves at minus that foot's velocity. So per
 * sample, the SUPPORT — the lowest foot (toe or ankle, each from its own low
 * point in the clip), plus the other one while it is within 3 cm of it — is
 * followed, and minus its horizontal velocity is the body's. Averaging both
 * feet in double support is deliberate: a lunge that spreads the stance moves
 * both feet at once, and following either one alone reports a lunge of the
 * full stride, forwards or backwards depending on which foot won.
 * A lone low foot moving faster than 4 m/s is landing, not planted, and the next
 * foot up is followed instead (both feet low and sliding apart is a lunge
 * spreading its stance, and stays averaged). Airborne
 * stretches (no foot within 20 cm of its low point) are interpolated
 * across from the support on either side. Stable to a couple of centimetres
 * across sample counts and bands on every weapon clip in human.glb.
 *
 * Only one-shots, and only where the travel is worth moving a body for
 * (>= 0.15 m of forward or sideways excursion). Walks and runs have
 * clipSpeeds; the controller drives them by velocity already.
 *
 * @returns {Record<string, { d: number, f: number[], s?: number[] }>}
 */
export function measureAdvance(root, bones, clips, rigMap) {
  const toes = (rigMap.contacts ?? []).map((n) => bones.get(n)).filter(Boolean);
  const out = {};
  if (toes.length === 0) return out;
  const ankles = toes.map((t) => (t.parent?.isBone ? t.parent : t));
  const N = ADVANCE_SAMPLES;
  const BLEND = 0.03;
  const AIR = 0.2;
  // A foot sweeping in to land is low but still travelling at swing speed
  // (5-13 m/s in the sword lunges), and taken for support it reads as the
  // ground lurching backwards. No planted foot slips this fast under a swing.
  const MAX_SLIP = 4;
  const mixer = new THREE.AnimationMixer(root);
  for (const clip of clips) {
    if (LOCOMOTION.test(clip.name) || NO_ADVANCE.test(clip.name)) continue;
    if (!(clip.duration > 0)) continue;
    const action = mixer.clipAction(clip);
    // a one-shot: sampled to its LAST frame, clamped — not wrapped back to 0
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    const toe = toes.map(() => []);
    const ankle = toes.map(() => []);
    for (let i = 0; i <= N; i++) {
      mixer.setTime(clip.duration * (i / N));
      root.updateMatrixWorld(true);
      toes.forEach((t, k) => {
        toe[k].push(t.getWorldPosition(new THREE.Vector3()));
        ankle[k].push(ankles[k].getWorldPosition(new THREE.Vector3()));
      });
    }
    action.stop();
    mixer.uncacheClip(clip);

    const dt = clip.duration / N;
    const low = (track) => track.reduce((m, p) => Math.min(m, p.y), Infinity);
    const toeLow = toe.map(low);
    const ankleLow = ankle.map(low);
    /** @type {([number, number] | null)[]} ground velocity per span, model frame (x, z) */
    const vel = new Array(N).fill(null);
    for (let i = 0; i < N; i++) {
      const feet = toes.map((_, k) => {
        const hT = Math.max(toe[k][i].y, toe[k][i + 1].y) - toeLow[k];
        const hA = Math.max(ankle[k][i].y, ankle[k][i + 1].y) - ankleLow[k];
        const P = hT <= hA ? toe[k] : ankle[k];
        return { h: Math.min(hT, hA), vx: -(P[i + 1].x - P[i].x) / dt, vz: -(P[i + 1].z - P[i].z) / dt };
      });
      // the support: the lowest foot, and the other while within BLEND of it
      let pool = feet;
      let hmin = Infinity;
      for (;;) {
        hmin = Math.min(...pool.map((f) => f.h));
        const low = pool.filter((f) => f.h - hmin < BLEND);
        // a LONE low foot at swing speed is landing, not planted: look past it
        if (low.length === 1 && pool.length > 1 && Math.hypot(low[0].vx, low[0].vz) > MAX_SLIP) {
          pool = pool.filter((f) => f !== low[0]);
          continue;
        }
        break;
      }
      if (hmin > AIR) continue;
      let W = 0;
      let vx = 0;
      let vz = 0;
      for (const f of pool) {
        const w = Math.max(0, 1 - (f.h - hmin) / BLEND);
        W += w;
        vx += w * f.vx;
        vz += w * f.vz;
      }
      vel[i] = [vx / W, vz / W];
    }
    const known = [];
    vel.forEach((v, i) => v && known.push(i));
    if (known.length === 0) continue;
    for (let i = 0; i < N; i++) {
      if (vel[i]) continue;
      let a = -1;
      let b = -1;
      for (const j of known) {
        if (j < i) a = j;
        else if (b < 0) b = j;
      }
      if (a < 0) vel[i] = vel[b].slice();
      else if (b < 0) vel[i] = vel[a].slice();
      else {
        const u = (i - a) / (b - a);
        vel[i] = [vel[a][0] * (1 - u) + vel[b][0] * u, vel[a][1] * (1 - u) + vel[b][1] * u];
      }
    }
    // cumulative, then resampled to ADVANCE_POINTS evenly over the clip
    const cumX = [0];
    const cumZ = [0];
    for (let i = 0; i < N; i++) {
      cumX.push(cumX[i] + vel[i][0] * dt);
      cumZ.push(cumZ[i] + vel[i][1] * dt);
    }
    const pick = (cum) =>
      Array.from({ length: ADVANCE_POINTS }, (_, j) => Number(cum[Math.round((j / (ADVANCE_POINTS - 1)) * N)].toFixed(2)));
    const f = pick(cumZ);
    const s = pick(cumX);
    const reach = (c) => Math.max(...c.map(Math.abs));
    if (Math.max(reach(f), reach(s)) < 0.15) continue;
    out[clip.name] = { d: Number(clip.duration.toFixed(3)), f, ...(reach(s) >= 0.15 ? { s } : {}) };
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(root);
  return out;
}

/**
 * Measure `clips` on a posed character and print both maps ready to paste into
 * the third-person-controller. `root` must be in its bind pose, in the units
 * it ships in; the ground is the bottom of its bounds.
 */
export function reportLocomotion(root, bones, clips, rigMap) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root);
  const height = box.max.y - box.min.y;
  // "reaches the ground" is generous: a sprint plants its toes a few
  // centimetres under the bind pose's sole, a strafe a few above it
  const { speeds, footfalls } = measureLocomotion(root, bones, clips, rigMap, box.min.y + 0.04 * height, height);
  if (Object.keys(speeds).length) {
    console.log("\nauthored ground speed per clip (units/sec):");
    for (const [name, v] of Object.entries(speeds)) console.log(`  ${name.padEnd(22)} ${v}`);
    console.log("\npaste into the third-person-controller's clipSpeeds param:\n  " + JSON.stringify(speeds));
  }
  if (Object.keys(footfalls).length) {
    console.log("\nfoot contacts per locomotion cycle (0..1 of the clip):");
    for (const [name, v] of Object.entries(footfalls)) console.log(`  ${name.padEnd(22)} ${v.join("  ")}`);
    console.log("\npaste into the third-person-controller's clipFootfalls param:\n  " + JSON.stringify(footfalls));
  }
  const advance = measureAdvance(root, bones, clips, rigMap);
  if (Object.keys(advance).length) {
    console.log("\nground travel per one-shot (m over the clip; forward = model +Z, side = model +X):");
    for (const [name, v] of Object.entries(advance)) {
      const fEnd = v.f[v.f.length - 1];
      const sEnd = v.s ? v.s[v.s.length - 1] : 0;
      const peak = Math.max(...v.f.map(Math.abs));
      console.log(
        `  ${name.padEnd(22)} fwd ${fEnd.toFixed(2).padStart(5)}  side ${sEnd.toFixed(2).padStart(5)}  ` +
          `(|fwd| peak ${peak.toFixed(2)}, ${v.d}s)`,
      );
    }
    console.log("\npaste into the third-person-controller's clipAdvance param:\n  " + JSON.stringify(advance));
  }
  return { speeds, footfalls, advance };
}
