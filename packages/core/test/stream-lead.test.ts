import { describe, expect, it } from "vitest";
import {
  cellLoadPriority,
  chunkStreamerSchema,
  computeChunkStates,
  computeLeadChunkStates,
  DEFAULT_STREAM_LEAD,
  FocusVelocity,
  streamLeadPoint,
  type ChunkRep,
  type ChunkStreamerData,
} from "../src/index.js";

const streamer = (over: Partial<ChunkStreamerData> = {}): ChunkStreamerData =>
  chunkStreamerSchema.parse({ source: "w", cellSize: 48, keepPadding: 1, rings: { simulation: 2, fullRender: 3, hlod: 7, farTerrain: 18 }, ...over });
const empty = new Map<string, ChunkRep>();

describe("velocity-led streaming", () => {
  it("estimates a sprint's velocity from focus samples and restarts on a teleport", () => {
    const v = new FocusVelocity();
    // 9.5 m/s east, sampled at 60 Hz for 2 s
    for (let i = 0; i <= 120; i++) v.sample(100 + 9.5 * (i / 60), 50, i * (1000 / 60));
    expect(v.vx).toBeCloseTo(9.5, 1);
    expect(v.vz).toBeCloseTo(0, 3);
    v.sample(5000, 50, 2100); // fast travel
    expect(v.speed).toBe(0);
  });

  it("one long frame does not fling the estimate", () => {
    const v = new FocusVelocity();
    for (let i = 0; i <= 60; i++) v.sample(9.5 * (i / 60), 0, i * (1000 / 60));
    // a 400 ms stall: the body moved its 3.8 m, the speed reading stays a sprint
    v.sample(9.5 + 3.8, 0, 1000 + 400);
    expect(v.speed).toBeGreaterThan(8);
    expect(v.speed).toBeLessThan(11);
  });

  it("projects the lead point lookahead seconds ahead, capped, and none when standing", () => {
    const lead = streamLeadPoint(0, 0, 9.5, 0);
    expect(lead.x).toBeCloseTo(9.5 * DEFAULT_STREAM_LEAD.lookaheadSeconds);
    expect(lead.z).toBe(0);
    expect(lead.x).toBeGreaterThanOrEqual(2 * 9.5); // at least 2 s at sprint speed
    expect(streamLeadPoint(10, 20, 0.5, 0)).toEqual({ x: 10, z: 20 });
    const fast = streamLeadPoint(0, 0, 0, -200);
    expect(fast.z).toBeCloseTo(-DEFAULT_STREAM_LEAD.maxLead);
  });

  it("the lead ring promotes cells ahead and keeps everything the player's own ring wants", () => {
    const cfg = streamer();
    const focus = { x: 24, z: 24 };
    const lead = { x: 24 + 96, z: 24 }; // two cells east
    const here = computeChunkStates(focus, cfg, empty);
    const both = computeLeadChunkStates(focus, lead, cfg, empty);
    const level: Record<ChunkRep, number> = { far: 1, hlod: 2, fullRender: 3, simulation: 4 };
    here.forEach((rep, key) => expect(level[both.get(key)!]).toBeGreaterThanOrEqual(level[rep]));
    // three cells east of the player is fullRender from where they stand, simulation from the lead point
    expect(here.get("3_0")).toBe("fullRender");
    expect(both.get("3_0")).toBe("simulation");
    // a standing player gets exactly the plain rings
    expect(computeLeadChunkStates(focus, focus, cfg, empty)).toEqual(here);
  });

  it("orders loads: simulation first, then nearest the lead point (cell centres)", () => {
    const lead = { x: 150, z: 24 }; // running east
    const cells: Array<[number, number, ChunkRep]> = [
      [-3, 0, "fullRender"], // behind
      [3, 0, "fullRender"], // ahead
      [0, 3, "fullRender"], // beside
      [1, 0, "simulation"],
    ];
    const order = [...cells].sort((a, b) => cellLoadPriority(a[0], a[1], a[2], lead, 48) - cellLoadPriority(b[0], b[1], b[2], lead, 48));
    expect(order.map((c) => `${c[0]}_${c[1]}`)).toEqual(["1_0", "3_0", "0_3", "-3_0"]);
    // running WEST mirrors it — the old queue's raster order favoured one direction
    const west = { x: -150, z: 24 };
    const order2 = [...cells].sort((a, b) => cellLoadPriority(a[0], a[1], a[2], west, 48) - cellLoadPriority(b[0], b[1], b[2], west, 48));
    expect(order2.map((c) => `${c[0]}_${c[1]}`)).toEqual(["1_0", "-3_0", "0_3", "3_0"]);
  });
});
