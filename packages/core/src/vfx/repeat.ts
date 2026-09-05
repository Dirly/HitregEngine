import type { VfxModule } from "./modules.js";

/**
 * `repeat` expansion — the STEPPING mechanism.
 *
 * A module with `repeat.count > 1` is one document entry but `count` plays:
 * copy i starts `every * i` seconds after the first, sits `step * i` metres on
 * in the spell frame (turned `turn * i` degrees around the anchor's up axis),
 * is scaled by `scale ^ i`, and — when `alternate` — turns the other way on
 * odd copies. Nothing interpolates between copies: each appears whole, which
 * is what makes spikes ERUPT along a strike instead of sliding, and a column
 * of circles read as a stack rather than a tween.
 *
 * Both the sequencer in @hitreg/render and the audit call this, so what is
 * drawn and what is budgeted are the same list.
 */

export function repeatCount(m: VfxModule): number {
  return Math.max(1, m.repeat.count);
}

/** Deterministic -1..1 scatter for copy `i` — the same every play. */
function scatter(i: number, salt: number): number {
  const h = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return (h - Math.floor(h)) * 2 - 1;
}

/** Copy `i` of a module, or the module itself for i = 0 with no repeat. */
export function repeatCopy<M extends VfxModule>(m: M, i: number): M {
  const r = m.repeat;
  if (i === 0 && r.count <= 1) return m;
  const theta = (r.turn * i * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const [sx, sy, sz] = r.step;
  // the walk so far, turned around the anchor's up axis
  let x = sx * i;
  const y = sy * i;
  let z = sz * i;
  const orbiting = m.kind === "sprite" && m.orbit > 0;
  if (!orbiting) {
    const rx = x * cos + z * sin;
    const rz = -x * sin + z * cos;
    x = rx;
    z = rz;
  }
  if (r.jitter > 0) {
    x += scatter(i, 1) * r.jitter;
    z += scatter(i, 2) * r.jitter;
  }
  const [ox, oy, oz] = m.anchor.offset;
  const size = Math.pow(r.scale, i);
  const flip = r.alternate && i % 2 === 1 ? -1 : 1;
  const copy: VfxModule = {
    ...m,
    anchor: { ...m.anchor, offset: [ox + x, oy + y, oz + z] },
    delay: m.delay + r.every * i,
    repeat: { ...r, count: 1 },
  };
  switch (copy.kind) {
    case "sprite":
      copy.size *= size;
      copy.spin *= flip;
      copy.orbitSpeed *= flip;
      if (orbiting) copy.orbitPhase += theta;
      break;
    case "ring":
      copy.radius *= size;
      copy.spin *= flip;
      break;
    case "shell":
      copy.radius *= size;
      copy.spin *= flip;
      break;
    case "column":
      copy.radius *= size;
      copy.height *= size;
      copy.spin *= flip;
      break;
    case "mesh":
      copy.size *= size;
      copy.spin *= flip;
      break;
    case "slash":
      copy.radius *= size;
      copy.tilt *= flip;
      if (flip < 0) copy.reverse = !copy.reverse;
      break;
    case "light":
      copy.range *= size;
      break;
    default:
      break;
  }
  return copy as M;
}

/** Every copy of a module, in play order. */
export function expandRepeat(m: VfxModule): VfxModule[] {
  const n = repeatCount(m);
  if (n <= 1) return [m];
  const out: VfxModule[] = [];
  for (let i = 0; i < n; i++) out.push(repeatCopy(m, i));
  return out;
}
