import { describe, expect, it } from "vitest";
import {
  chunkStreamerSchema,
  computeChunkStates,
  resolveChunkRings,
  chunkKey,
  parseChunkKey,
  type ChunkRep,
  type ChunkStreamerData,
} from "../src/index.js";

/** Build a streamer config with LOD rings (all cellSize 1 → cell == world). */
function streamer(over: Partial<ChunkStreamerData> = {}): ChunkStreamerData {
  return chunkStreamerSchema.parse({ source: "w", cellSize: 1, keepPadding: 1, ...over });
}

const empty = new Map<string, ChunkRep>();

describe("chunk LOD rings", () => {
  it("chunkKey / parseChunkKey round-trip, including negatives", () => {
    for (const [cx, cz] of [[0, 0], [3, -2], [-5, -7]] as const) {
      expect(parseChunkKey(chunkKey(cx, cz))).toEqual([cx, cz]);
    }
    expect(parseChunkKey("nope")).toBeNull();
    expect(parseChunkKey("1_2_3")).toBeNull();
  });

  it("parseChunkKey accepts exactly the old /^(-?\\d+)_(-?\\d+)$/ grammar", () => {
    const regex = (key: string) => {
      const m = /^(-?\d+)_(-?\d+)$/.exec(key);
      return m ? [Number(m[1]), Number(m[2])] : null;
    };
    const cases = ["0_0", "12_-340", "-1_-1", "007_8", "", "_", "1_", "_1", "-_1", "1_-", "--1_2", "1__2", "a_1", "1_2 ", " 1_2", "1.5_2", "+1_2", "far:1_2", "99999_-99999"];
    for (const key of cases) expect(parseChunkKey(key), key).toEqual(regex(key));
  });

  it("resolves rings when set (clamped non-decreasing) and falls back to radius", () => {
    // out-of-order rings clamp so simulation <= fullRender <= hlod <= farTerrain
    const messy = resolveChunkRings(streamer({ rings: { simulation: 5, fullRender: 2, hlod: 3, farTerrain: 1 } }));
    expect(messy).toMatchObject({ simulation: 5, fullRender: 5, hlod: 5, farTerrain: 5 });
    // no rings → every ring collapses to `radius` (legacy binary behavior)
    const legacy = resolveChunkRings(streamer({ radius: 4 }));
    expect(legacy).toMatchObject({ simulation: 4, fullRender: 4, hlod: 4, farTerrain: 4 });
  });

  // Distances are from the cell CORNER nearest the focus to each cell's CENTRE, less half a cell
  // (the four cells around that corner are 0): with the focus at 0, cell 1_0 sits 1.08 out and its
  // mirror -2_0 too — the ring is symmetric about the focus.
  it("assigns each cell the representation of the ring it sits in", () => {
    const config = streamer({ rings: { simulation: 1, fullRender: 2, hlod: 4, farTerrain: 6 } });
    const states = computeChunkStates({ x: 0, z: 0 }, config, empty);
    for (const k of ["0_0", "-1_0", "0_-1", "-1_-1"]) expect(states.get(k)).toBe("simulation"); // d=0
    expect(states.get("1_0")).toBe("fullRender"); // d=1.08
    expect(states.get("1_1")).toBe("fullRender"); // d=1.62
    expect(states.get("2_0")).toBe("hlod"); // d=2.05
    expect(states.get("4_0")).toBe("far"); // d=4.03
    expect(states.has("6_0")).toBe(false); // d=6.02 > far → unloaded (absent)
  });

  it("is symmetric about the focus: a cell and its mirror through the focus corner get the same ring", () => {
    const config = streamer({ rings: { simulation: 2, fullRender: 3, hlod: 7, farTerrain: 18 } });
    for (const [fx, fz] of [[0.2, 0.3], [-0.4, 0.45], [10.1, -7.3]] as const) {
      const states = computeChunkStates({ x: fx, z: fz }, config, empty);
      const cx = Math.round(fx), cz = Math.round(fz);
      for (let dz = -20; dz <= 20; dz++) for (let dx = -20; dx <= 20; dx++) {
        const a = states.get(chunkKey(cx + dx, cz + dz));
        const b = states.get(chunkKey(cx - 1 - dx, cz - 1 - dz));
        expect(a, `${dx},${dz}`).toBe(b);
      }
    }
  });

  it("upgrades immediately on approach but holds detail until beyond ring+padding (hysteresis)", () => {
    const config = streamer({ rings: { simulation: 1, fullRender: 2, hlod: 4, farTerrain: 6 }, keepPadding: 1 });
    // cell (2,0) starts as simulation because the focus was on it
    let states = computeChunkStates({ x: 2, z: 0 }, config, empty);
    expect(states.get("2_0")).toBe("simulation");

    // focus at 0.5 (corner 1): cell (2,0) is d=1.08, past simulation(1) but within its pad (1+1) → HOLD
    states = computeChunkStates({ x: 0.5, z: 0 }, config, states);
    expect(states.get("2_0")).toBe("simulation");

    // focus at -1: (2,0) d=3.04 is past sim+pad (2) and fullRender+pad (3) → it drops to hlod
    states = computeChunkStates({ x: -1, z: 0 }, config, states);
    expect(states.get("2_0")).toBe("hlod");
    // and a fresh approach to d=1.08 upgrades at once
    states = computeChunkStates({ x: 0.5, z: 0 }, config, states);
    expect(states.get("2_0")).toBe("fullRender");
  });

  it("does not flicker when the focus dithers across a boundary", () => {
    const config = streamer({ rings: { simulation: 2, fullRender: 3, hlod: 5, farTerrain: 8 }, keepPadding: 1 });
    let states = computeChunkStates({ x: 0.6, z: 0 }, config, empty);
    const seen = new Set<ChunkRep | "unloaded">();
    // jitter the focus by a fraction of a cell (the focus corner flips between 0 and 1 and back)
    // around a spot that keeps cell (2,0) hovering near the simulation boundary
    for (const x of [0, 0.4, 0.6, -0.3, 0.7, -0.4, 0.55, 0]) {
      states = computeChunkStates({ x, z: 0 }, config, states);
      seen.add(states.get("2_0") ?? "unloaded");
    }
    expect(seen.size).toBe(1); // never changed representation
  });

  it("legacy config (no rings) reproduces binary load/unload with keep-padding", () => {
    const config = streamer({ radius: 2, keepPadding: 1 }); // no rings
    let states = computeChunkStates({ x: 0, z: 0 }, config, empty);
    // within radius → simulation; beyond radius but within pad holds; past → gone
    expect(states.get("1_0")).toBe("simulation"); // d=1.08 ≤ radius
    expect(states.get("-2_0")).toBe("simulation"); // its mirror
    expect(states.has("2_0")).toBe(false); // d=2.05 > radius, never loaded → stays unloaded

    // a cell that WAS loaded holds through the pad, then unloads past it
    states = computeChunkStates({ x: 4, z: 0 }, config, empty); // corner 4
    expect(states.get("2_0")).toBe("simulation"); // d=1.08 from corner 4
    states = computeChunkStates({ x: 0, z: 0 }, config, states); // (2,0) d=2.05 ≤ radius(2)+pad(1)
    expect(states.get("2_0")).toBe("simulation");
    states = computeChunkStates({ x: -1, z: 0 }, config, states); // (2,0) d=3.04 > 3
    expect(states.has("2_0")).toBe(false); // unloaded
  });
});

/**
 * Ring thresholds are checked in descending-detail order, so a ring set to the
 * SAME number as the ring above it can never be reached — the earlier branch
 * always claims the distance first. That is not a theoretical hazard: it is
 * how heli-island shipped (`fullRender: 2, hlod: 2`), and the effect is that
 * the HLOD proxy tier silently does not exist. Every cell inside the radius
 * stays full-detail, so the whole island sits in the scene graph at once and
 * per-frame render CPU scales with total prop count instead of with distance.
 *
 * These tests exist so that collapse shows up as a red test rather than as a
 * frame-time mystery months later.
 */
describe("ring thresholds that silently disable a tier", () => {
  const reps = (rings: Partial<NonNullable<ChunkStreamerData["rings"]>>): Set<ChunkRep> => {
    const config = streamer({ radius: 6, rings: { simulation: 1, fullRender: 2, hlod: 3, farTerrain: 4, ...rings } });
    const out = new Set<ChunkRep>();
    // sweep the focus cell outwards; `prev` stays empty so hysteresis never
    // masks which tier a given distance resolves to on its own
    for (let cx = 0; cx <= 6; cx++) {
      const state = computeChunkStates({ x: 0, z: 0 }, config, empty);
      const rep = state.get(chunkKey(cx, 0));
      if (rep) out.add(rep);
    }
    return out;
  };

  it("reaches every tier when each ring is strictly larger than the one inside it", () => {
    expect(reps({})).toEqual(new Set<ChunkRep>(["simulation", "fullRender", "hlod", "far"]));
  });

  it("never produces an hlod cell when hlod === fullRender (heli-island's bug)", () => {
    const got = reps({ hlod: 2 });
    expect(got.has("hlod")).toBe(false);
    // and the cells that should have been cheap proxies are full-detail instead
    expect(got.has("fullRender")).toBe(true);
  });

  it("never produces a fullRender cell when fullRender === simulation", () => {
    expect(reps({ fullRender: 1 }).has("fullRender")).toBe(false);
  });

  it("resolveChunkRings clamps a smaller outer ring up, which also collapses the tier", () => {
    // hlod < fullRender is clamped to fullRender — same unreachable outcome,
    // so a config that merely looks wrong and one that looks fine both fail here
    const rings = resolveChunkRings(streamer({ rings: { simulation: 1, fullRender: 3, hlod: 2, farTerrain: 4 } }));
    expect(rings.hlod).toBe(3);
    expect(reps({ fullRender: 3, hlod: 2 }).has("hlod")).toBe(false);
  });
});
