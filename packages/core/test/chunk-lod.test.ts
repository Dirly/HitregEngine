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

  it("resolves rings when set (clamped non-decreasing) and falls back to radius", () => {
    // out-of-order rings clamp so simulation <= fullRender <= hlod <= farTerrain
    const messy = resolveChunkRings(streamer({ rings: { simulation: 5, fullRender: 2, hlod: 3, farTerrain: 1 } }));
    expect(messy).toMatchObject({ simulation: 5, fullRender: 5, hlod: 5, farTerrain: 5 });
    // no rings → every ring collapses to `radius` (legacy binary behavior)
    const legacy = resolveChunkRings(streamer({ radius: 4 }));
    expect(legacy).toMatchObject({ simulation: 4, fullRender: 4, hlod: 4, farTerrain: 4 });
  });

  it("assigns each cell the representation of the ring it sits in", () => {
    const config = streamer({ rings: { simulation: 1, fullRender: 2, hlod: 4, farTerrain: 6 } });
    const states = computeChunkStates({ x: 0, z: 0 }, config, empty);
    expect(states.get("0_0")).toBe("simulation"); // d=0
    expect(states.get("1_0")).toBe("simulation"); // d=1 ≤ sim
    expect(states.get("2_0")).toBe("fullRender"); // d=2 ≤ fullRender
    expect(states.get("3_0")).toBe("hlod"); // d=3 ≤ hlod(4)
    expect(states.get("5_0")).toBe("far"); // d=5 ≤ far(6)
    expect(states.has("7_0")).toBe(false); // d=7 > far → unloaded (absent)
  });

  it("upgrades immediately on approach but holds detail until beyond ring+padding (hysteresis)", () => {
    const config = streamer({ rings: { simulation: 1, fullRender: 2, hlod: 4, farTerrain: 6 }, keepPadding: 1 });
    // cell (2,0) starts as simulation because the focus was on it
    let states = computeChunkStates({ x: 2, z: 0 }, config, empty);
    expect(states.get("2_0")).toBe("simulation");

    // focus at 0: cell (2,0) is d=2, just past simulation(1) but within its
    // pad (1+1=2) → it must HOLD simulation, not drop to fullRender
    states = computeChunkStates({ x: 0, z: 0 }, config, states);
    expect(states.get("2_0")).toBe("simulation");

    // focus at -1: cell (2,0) is d=3 > sim(1)+pad(1)=2 → now it drops. It
    // settles at fullRender (padded fullRender boundary 2+1=3 still includes it)
    states = computeChunkStates({ x: -1, z: 0 }, config, states);
    expect(states.get("2_0")).toBe("fullRender");
  });

  it("does not flicker when the focus dithers across a boundary", () => {
    const config = streamer({ rings: { simulation: 2, fullRender: 3, hlod: 5, farTerrain: 8 }, keepPadding: 1 });
    let states = computeChunkStates({ x: 0, z: 0 }, config, empty);
    const seen = new Set<ChunkRep | "unloaded">();
    // jitter the focus by a fraction of a cell around a spot that keeps cell
    // (2,0) hovering right at the simulation boundary (d≈2)
    for (const x of [0, 0.4, -0.3, 0.2, -0.4, 0.1, 0]) {
      states = computeChunkStates({ x, z: 0 }, config, states);
      seen.add(states.get("2_0") ?? "unloaded");
    }
    expect(seen.size).toBe(1); // never changed representation
    expect([...seen][0]).toBe("simulation");
  });

  it("legacy config (no rings) reproduces binary load/unload with keep-padding", () => {
    const config = streamer({ radius: 2, keepPadding: 1 }); // no rings
    let states = computeChunkStates({ x: 0, z: 0 }, config, empty);
    // within radius → simulation; beyond radius but within pad holds; past → gone
    expect(states.get("2_0")).toBe("simulation"); // d=2 ≤ radius
    expect(states.has("3_0")).toBe(false); // d=3 > radius, never loaded → stays unloaded

    // a cell that WAS loaded holds through the pad, then unloads past it
    states = computeChunkStates({ x: 4, z: 0 }, config, empty); // load around x=4 (cell 4)
    expect(states.get("2_0")).toBe("simulation"); // d=2 from cell 4
    states = computeChunkStates({ x: 3, z: 0 }, config, states); // cell 3 focus; (2,0) d=1
    states = computeChunkStates({ x: 0, z: 0 }, config, states); // focus 0; (2,0) d=2 ≤ radius still sim
    expect(states.get("2_0")).toBe("simulation");
    states = computeChunkStates({ x: -2, z: 0 }, config, states); // (2,0) d=4 > radius(2)+pad(1)=3
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
