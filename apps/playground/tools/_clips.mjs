import * as THREE from "three";

/**
 * Loop hygiene for a borrowed clip.
 *
 * Exporters routinely write a cycle's keys starting at frame ONE — times
 * running 0.0333 … 0.4667 for a 14-frame gallop — and leave the clip's
 * duration at the last key. Nothing is wrong with the animation, but played on
 * a loop it is wrong twice:
 *
 *   - Nothing is keyed below the first key, so `t` from 0 to one frame holds
 *     the opening pose. Every cycle opens on a held frame. On a 14-frame run
 *     that is 7% of the stride spent stopped, once per stride, which reads as
 *     a hitch — and it is a very common answer to "the run looks rough".
 *   - The last key sits exactly AT the duration, so the wrap from the final
 *     pose back to the first happens in no time at all rather than over a
 *     frame. That is a pop of one frame's motion.
 *
 * The fix is the same one every animation package applies by hand: slide the
 * keys down so the first sits at zero, and — only for a cycle — append the
 * opening pose one frame past the last key so the wrap has a frame to happen
 * in. A cycle's duration comes out unchanged; a one-shot just loses the dead
 * frame at its head.
 *
 * WHAT MAKES IT A CYCLE. Measured, not declared, and measured in units of the
 * clip's OWN frames: a cycle's first and last poses are a frame apart by
 * construction, so any absolute threshold calls every fast gait a one-shot.
 * Appending the opening pose to something that is not a cycle would snap a
 * death animation back upright at the end, so this test decides real damage in
 * both directions.
 */

/** Distance between two keys of one track, in whatever units that track uses. */
function keyDistance(track, i, j) {
  const v = track.values;
  const n = track.getValueSize();
  if (track instanceof THREE.QuaternionKeyframeTrack || n === 4) {
    const a = new THREE.Quaternion(v[i * n], v[i * n + 1], v[i * n + 2], v[i * n + 3]);
    const b = new THREE.Quaternion(v[j * n], v[j * n + 1], v[j * n + 2], v[j * n + 3]);
    return a.angleTo(b);
  }
  let sum = 0;
  for (let c = 0; c < n; c++) {
    const d = v[i * n + c] - v[j * n + c];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

const median = (xs) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/**
 * Is this clip a cycle? Every track votes with its own seam-to-frame ratio and
 * the median decides, so one noisy bone cannot swing the verdict.
 *
 * @returns {{ loops: boolean, ratio: number }} ratio is in frames: 1 means the
 *   clip's ends are exactly one frame apart, which is what a cycle looks like.
 */
export function classifyCycle(clip) {
  const ratios = [];
  for (const track of clip.tracks) {
    const keys = track.times.length;
    if (keys < 3) continue;
    const steps = [];
    for (let i = 1; i < keys; i++) steps.push(keyDistance(track, i - 1, i));
    const typical = median(steps);
    if (typical < 1e-7) continue; // a track that never moves has no opinion
    ratios.push(keyDistance(track, keys - 1, 0) / typical);
  }
  const ratio = ratios.length ? median(ratios) : Infinity;
  // Three cases, not two. "closed" is a cycle whose last key is already a copy
  // of its first — the other authoring convention — and appending another copy
  // there would add a frame of hold at the wrap, which is the very thing this
  // pass exists to remove.
  const kind = ratio < 0.5 ? "closed" : ratio <= 1.6 ? "open" : "once";
  return { kind, loops: kind !== "once", ratio };
}

/**
 * Slide a clip's keys to start at zero, and close the loop if it is one.
 *
 * @returns {{ clip: THREE.AnimationClip, loops: boolean, ratio: number, shifted: number }}
 */
export function normalizeLoop(clip) {
  const { kind, loops, ratio } = classifyCycle(clip);
  const starts = clip.tracks.map((t) => t.times[0]).filter((t) => Number.isFinite(t));
  const shift = starts.length ? Math.min(...starts) : 0;

  // One frame, taken from the densest track — the clip's own frame rate, not
  // an assumed 30.
  const dense = clip.tracks.reduce((a, t) => (t.times.length > (a?.times.length ?? 0) ? t : a), null);
  const steps = [];
  if (dense) for (let i = 1; i < dense.times.length; i++) steps.push(dense.times[i] - dense.times[i - 1]);
  const interval = median(steps);

  let end = 0;
  const tracks = clip.tracks.map((track) => {
    const times = Array.from(track.times, (t) => t - shift);
    const values = Array.from(track.values);
    const n = track.getValueSize();
    if (kind === "open" && interval > 0) {
      // The opening pose, one frame past the end: the wrap now has a frame to
      // happen in instead of being instantaneous.
      times.push(times[times.length - 1] + interval);
      for (let c = 0; c < n; c++) values.push(values[c]);
    }
    end = Math.max(end, times[times.length - 1]);
    return new track.constructor(track.name, times, values);
  });

  const out = new THREE.AnimationClip(clip.name, end, tracks);
  out.userData = { ...(clip.userData ?? {}) };
  return { clip: out, kind, loops, ratio, shifted: shift };
}
