// -- velocity-led streaming ---------------------------------------------------
//
// A chunk ring centred on the player is centred on where the player WAS. At a
// sprint (9.5 m/s) a 48 m cell is crossed every five seconds, and every cell
// load is a worker round-trip plus a frame-budgeted publish — so a ring that
// only reacts to the player's own cell spends its whole lead catching up, and
// a long straight sprint runs into cells that are still loading (owner report,
// 2026-10-22: "geometry doesn't load for chunks I run into").
//
// The pure half of the fix lives here: estimate the focus velocity from the
// positions the streamer is fed (no physics dependency — the editor fly-cam and
// a remote ghost stream the same way), project a LEAD point that many seconds
// ahead, keep every cell either point wants (the trailing side is not dropped
// early) and order loads by distance to the lead point, so the cells the player
// is running into come first instead of whatever raster order the ring walk
// produced.

import { computeChunkStates, type ChunkRep, type ChunkStreamerData } from "./chunks.js";

const REP_LEVEL: Record<ChunkRep, number> = { far: 1, hlod: 2, fullRender: 3, simulation: 4 };

export interface StreamLeadOptions {
  /** Seconds of travel the lead point is projected ahead. */
  lookaheadSeconds: number;
  /** The lead never runs further ahead than this (world units) — a vehicle or a fly-cam at speed. */
  maxLead: number;
  /** Below this speed (units/s) there is no lead: standing, turning on the spot, idling. */
  minSpeed: number;
  /** A jump bigger than this between two samples is a teleport: the estimate restarts. */
  teleportDistance: number;
  /** Smoothing time constant (seconds) of the velocity estimate. */
  smoothingSeconds: number;
}

export const DEFAULT_STREAM_LEAD: StreamLeadOptions = {
  // 3 s at a 9.5 m/s sprint is ~29 m: the cell ahead is requested while the
  // body is still a cell short of it (the brief asks for at least 2 s).
  lookaheadSeconds: 3,
  maxLead: 96,
  minSpeed: 1.5,
  teleportDistance: 60,
  smoothingSeconds: 0.35,
};

/**
 * Focus velocity from the positions fed to the streamer, exponentially
 * smoothed so one long frame (a stall is exactly when this matters) does not
 * fling the lead point. Not tied to physics: it sees only (x, z, time).
 */
export class FocusVelocity {
  vx = 0;
  vz = 0;
  private lastX = 0;
  private lastZ = 0;
  private lastT = -1;

  constructor(private readonly options: StreamLeadOptions = DEFAULT_STREAM_LEAD) {}

  /** Feed a focus position at time `tMs` (monotonic milliseconds). */
  sample(x: number, z: number, tMs: number): void {
    if (this.lastT < 0) return this.restart(x, z, tMs);
    const dt = (tMs - this.lastT) / 1000;
    if (!(dt > 0)) return;
    const dx = x - this.lastX;
    const dz = z - this.lastZ;
    if (Math.hypot(dx, dz) > this.options.teleportDistance || dt > 2) return this.restart(x, z, tMs);
    const a = 1 - Math.exp(-dt / Math.max(1e-3, this.options.smoothingSeconds));
    this.vx += (dx / dt - this.vx) * a;
    this.vz += (dz / dt - this.vz) * a;
    this.lastX = x;
    this.lastZ = z;
    this.lastT = tMs;
  }

  /** Forget the motion (a teleport, a scene switch, a reconfigured streamer). */
  restart(x: number, z: number, tMs: number): void {
    this.vx = 0;
    this.vz = 0;
    this.lastX = x;
    this.lastZ = z;
    this.lastT = tMs;
  }

  get speed(): number {
    return Math.hypot(this.vx, this.vz);
  }
}

/** The point streaming leads toward: `pos + v * lookahead`, capped at `maxLead`, none below `minSpeed`. */
export function streamLeadPoint(
  x: number,
  z: number,
  vx: number,
  vz: number,
  options: StreamLeadOptions = DEFAULT_STREAM_LEAD,
): { x: number; z: number } {
  const speed = Math.hypot(vx, vz);
  if (!(speed >= options.minSpeed)) return { x, z };
  const lead = Math.min(speed * options.lookaheadSeconds, options.maxLead);
  return { x: x + (vx / speed) * lead, z: z + (vz / speed) * lead };
}

/**
 * Ring residency for a moving focus: every cell at the HIGHER of the level the
 * player's own position asks for and the level the lead point asks for. The
 * player's ring still holds what is around and behind them (nothing trailing
 * is dropped early); the lead ring promotes what they are running into.
 * Hysteresis is computeChunkStates' own, applied to each centre.
 */
export function computeLeadChunkStates(
  focus: { x: number; z: number },
  lead: { x: number; z: number },
  config: ChunkStreamerData,
  prev: ReadonlyMap<string, ChunkRep>,
): Map<string, ChunkRep> {
  const here = computeChunkStates(focus, config, prev);
  if (focus.x === lead.x && focus.z === lead.z) return here;
  const ahead = computeChunkStates(lead, config, prev);
  ahead.forEach((rep, key) => {
    const cur = here.get(key);
    if (!cur || REP_LEVEL[rep] > REP_LEVEL[cur]) here.set(key, rep);
  });
  return here;
}

/**
 * Load priority of a cell (lower loads first): simulation cells — ground and
 * collider the body may stand on — before render-only ones, then by distance
 * from the lead point to the cell's CENTRE (keys name the cell's min corner).
 */
export function cellLoadPriority(
  cx: number,
  cz: number,
  rep: ChunkRep | undefined,
  lead: { x: number; z: number },
  cellSize: number,
): number {
  const dx = (cx + 0.5) * cellSize - lead.x;
  const dz = (cz + 0.5) * cellSize - lead.z;
  const d = Math.hypot(dx, dz);
  return rep === "simulation" ? d : d + 1e6;
}
