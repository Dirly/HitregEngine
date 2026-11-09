import { describe, expect, it } from "vitest";
import {
  applyOps, ComponentRegistry, registerCoreComponents, createScene,
  candidateSpots, docOfOps, findRepeats, foundationEntity, foundationSurface, keepOutAtDoor, keepOutsFromLane, keepOutsFromMarkers, keepOutsFromOpenings,
  obbOverlap, snapToHost, solvePlacement, solvePlacements, placeRuleSchema, type HostShape, type PlaceRequest,
} from "../src/index.js";

const flat = (h = 10) => () => h;
const slope = (grade: number) => (x: number) => 10 + grade * x; // rises toward +x
const step = (x: number) => (x < 0 ? 10 : 11.2); // a 1.2 m step under the middle

const req = (o: Partial<PlaceRequest>): PlaceRequest => ({ id: "p", at: [0, 0], yaw: 0, half: [1, 1], height: 2, ...o });

describe("place solver: seat", () => {
  it("grounds a piece the agent put too high, flush on its highest ground", () => {
    const r = solvePlacement(req({ y: 14 }), { ground: flat(10) });
    expect(r.status).toBe("ok");
    expect(r.y).toBeCloseTo(9.97, 3);
  });
  it("seats on a slope: the highest sample flush, sunk by its footing so nothing floats", () => {
    // 2 m wide on a 0.25 grade: 0.5 m of fall; a 0.6 m footing covers it
    const r = solvePlacement(req({ footing: 0.6 }), { ground: slope(0.25) });
    expect(r.status).toBe("ok");
    expect(r.ground!.relief).toBeCloseTo(0.5, 3);
    expect(r.gap).toBe(0);
    expect(r.y!).toBeLessThanOrEqual(r.ground!.hi);
    expect(r.y! - 0.6).toBeLessThanOrEqual(r.ground!.lo + 1e-9);
  });
  it("without footing or foundation a piece on a fall moves to level ground or drops", () => {
    const ground = (x: number) => (x > 3 ? 10 : 10 + (3 - x) * 0.3); // level past x = 3
    const r = solvePlacement(req({ at: [2.6, 0], rule: { tolerance: { move: 1.5, gap: 0.05, slope: 0.6, yaw: 15 } } }), { ground });
    expect(r.status).toBe("moved");
    expect(r.gap!).toBeLessThanOrEqual(0.05);
    const d = solvePlacement(req({ rule: { tolerance: { move: 0, gap: 0.05, slope: 0.6, yaw: 0 } } }), { ground: slope(0.3) });
    expect(d.status).toBe("dropped");
    expect(d.reason).toMatch(/daylight/);
  });
  it("refuses ground steeper than its tolerance", () => {
    const r = solvePlacement(req({ movable: false }), { ground: slope(1.2) });
    expect(r.status).toBe("dropped");
    expect(r.reason).toMatch(/too steep/);
  });
  it("a raised floor (grade) stands clear of the highest ground: the floor never shares the terrain's plane", () => {
    const r = solvePlacement(req({ footing: 0.3, rule: { grade: 0.3 } }), { ground: flat(10) });
    expect(r.y).toBeCloseTo(10.27, 3);
  });
  it("set-in: a front cut into a cliff stands on its LOWEST ground, its back run into the rock (no lift, no slope limit)", () => {
    // a 24 x 14 m gate block whose back half is in a 72 deg face (ground rising 3 m per metre past z = 0)
    const cliff = (_x: number, z: number) => (z > 0 ? 130 : 130 + Math.min(70, -z * 3));
    const r = solvePlacement(req({ at: [0, 0], half: [12, 7], height: 38, rule: { seat: "set-in", tolerance: { move: 0, gap: 0.05, slope: 0.6, yaw: 0 } } }), { ground: cliff });
    expect(r.status).toBe("ok");
    expect(r.y!).toBeCloseTo(129.97, 2);
    expect(r.gap).toBe(0);
  });
  it("embeds a rock in its lowest ground; float-ok keeps the stated height", () => {
    expect(solvePlacement(req({ seat: "embed", height: 1 }), { ground: flat(5) }).y).toBeCloseTo(5 - 0.15, 3);
    expect(solvePlacement(req({ seat: "float-ok", y: 7.5 }), { ground: flat(5) }).y).toBe(7.5);
  });
});

describe("place solver: foundation skirt", () => {
  const rule = placeRuleSchema.parse({ foundation: { material: "built/tomb-ashlar", depth: 0.3 } });
  it("emits a skirt on a step instead of floating, down to the lowest ground + depth", () => {
    const r = solvePlacement(req({ half: [3, 2], rule, movable: false }), { ground: step });
    expect(r.status).toBe("ok");
    const f = r.foundation!;
    expect(f).toBeDefined();
    expect(f.bottom).toBeCloseTo(10 - 0.3, 3);
    // the cap goes over ALL the ground under it (6 cm over the high tread, inside the piece's base): a cap the ground
    // crosses would meet it in a line of flicker
    expect(f.top).toBeCloseTo(11.2 + 0.1, 3);
    expect(f.top).toBeLessThanOrEqual(r.y! + 0.15);
    expect(f.box.half[0]).toBeCloseTo(3 - 0.03, 3);
    expect(f.material).toBe("built/tomb-ashlar");
  });
  it("foundation cap: false leaves the skirt open on top (a pyre's ember bed covers it; r-found)", () => {
    const open = placeRuleSchema.parse({ ...rule, foundation: { ...rule.foundation, cap: false } });
    const r = solvePlacement(req({ half: [3, 2], rule: open, movable: false }), { ground: step });
    expect(r.foundation?.cap).toBe(false);
    expect(foundationSurface(r.foundation!).indices.length / 3).toBe(8);
  });
  it("holdY keeps a piece's height and only founds the daylight under it (r-found: a legacy-levelled court)", () => {
    // held at 10.6 over a 10 / 11.2 step: no move, no sink, the low side's 0.6 m covered down to 10 - 0.3
    const r = solvePlacement(req({ half: [3, 2], rule, movable: false, holdY: 10.6 }), { ground: step, obstacles: [{ id: "next", box: { c: [1, 0], half: [1, 1], yaw: 0 } }] });
    expect(r.status).toBe("ok");
    expect(r.y).toBeCloseTo(10.6, 3);
    expect(r.foundation?.bottom).toBeCloseTo(10 - 0.3, 3);
    // on ground that already holds it: no skirt
    expect(solvePlacement(req({ half: [3, 2], rule, movable: false, holdY: 10 }), { ground: flat(10) }).foundation).toBeUndefined();
  });
  it("a floored building never sinks its floor into the high ground: its foundation storey covers the fall, a skirt the rest", () => {
    // a WFC house: 3.2 m of foundation storey under its floor, floor grade 0.3
    const house = placeRuleSchema.parse({ grade: 0.3, tolerance: { slope: 8, move: 0, yaw: 0 }, foundation: { material: "built/tomb-ashlar" } });
    const r = solvePlacement(req({ half: [3, 2], footing: 3.2, height: 6, rule: house, movable: false }), { ground: step });
    expect(r.y).toBeCloseTo(11.2 - 0.03 + 0.3, 3); // grade plane flush on the HIGH side, never 2.9 m into it
    expect(r.foundation).toBeUndefined(); // 1.2 m of fall is inside its own 2.9 m foundation storey
    const deep = (x: number) => (x < 0 ? 6 : 11.2); // a 5.2 m drop: past the storey, a skirt below it
    const d = solvePlacement(req({ half: [3, 2], footing: 3.2, height: 6, rule: house, movable: false }), { ground: deep });
    expect(d.foundation!.top).toBeCloseTo(d.y! - 3.2 + 0.1, 3); // inside its foundation storey
    expect(d.foundation!.cap).toBe(false); // the floor covers it: no top face to flicker with the ground or the slab
    expect(foundationSurface(d.foundation!).indices.length).toBe(4 * 6);
    expect(d.foundation!.bottom).toBeCloseTo(6 - 0.3, 3);
  });
  it("never z-fights the terrain: an open piece's cap clears every ground height under it (Red Dial build 7: yard-4, as-h5)", () => {
    // a yard on a 1.2 m slope with a footing of 0.4: the ground under the box crosses the default cap level
    const yard = placeRuleSchema.parse({ tolerance: { slope: 1.2, move: 0, yaw: 0 }, foundation: { material: "built/tomb-ashlar" } });
    const g = (x: number) => 10 + 0.2 * x;
    const r = solvePlacement(req({ half: [3, 3], footing: 0.4, height: 3, rule: yard, movable: false }), { ground: g });
    const f = r.foundation!;
    expect(f).toBeDefined();
    // either a cap clear of every ground height, or no cap at all (never one the ground crosses)
    if (f.cap !== false) for (let x = -3; x <= 3; x += 0.25) expect(Math.abs(g(x) - f.top)).toBeGreaterThanOrEqual(0.03);
    else expect(foundationSurface(f).indices.length).toBe(4 * 6);
    expect(f.top).toBeLessThanOrEqual(r.y! + 0.15);
    // a floored piece's skirt has no top at all
    const house = placeRuleSchema.parse({ grade: 0.3, tolerance: { slope: 1.2, move: 0, yaw: 0 }, foundation: { material: "built/tomb-ashlar" } });
    expect(solvePlacement(req({ half: [3, 3], footing: 0.4, height: 6, rule: house, movable: false }), { ground: g }).foundation!.cap).toBe(false);
  });
  it("keeps a piece on its declared base: the skirt reaches up into the base band and down past the lowest ground", () => {
    const r = solvePlacement(req({ half: [3, 2], footing: 0.3, rule, movable: false }), { ground: step });
    const f = r.foundation!;
    expect(f.top).toBeGreaterThanOrEqual(r.y! - 0.3); // touches the piece at or above its footing's bottom
    expect(f.top).toBeLessThanOrEqual(r.y! + 0.15);   // never a platform over the piece
    expect(f.bottom).toBeLessThan(r.ground!.lo);       // and buried at the low side
  });
  it("is a valid static surface mesh with a collider, faces pointing out", () => {
    const r = solvePlacement(req({ half: [3, 2], rule, movable: false }), { ground: step });
    const e = foundationEntity(r.foundation!, { parent: null });
    const reg = new ComponentRegistry();
    registerCoreComponents(reg);
    const { doc } = applyOps(createScene("t"), [{ op: "add-entity", id: "skirt", entity: e as never }], reg);
    expect(doc.entities["skirt"]).toBeDefined();
    const s = foundationSurface(r.foundation!);
    // every wall's normal points away from the centre (CCW from outside)
    for (let t = 0; t < 4 * 2; t += 2) {
      const i = s.indices.slice(t * 3, t * 3 + 3), p = (k: number) => s.positions.slice(i[k]! * 3, i[k]! * 3 + 3);
      const [a, b, c] = [p(0), p(1), p(2)], e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!], e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
      const n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const mid = [(a[0]! + c[0]!) / 2, (a[2]! + c[2]!) / 2];
      expect(n[0]! * mid[0]! + n[2]! * mid[1]!).toBeGreaterThan(0);
    }
  });
  it("no skirt when the footing covers the fall", () => {
    const r = solvePlacement(req({ half: [3, 2], rule, footing: 1.5, movable: false }), { ground: step });
    expect(r.foundation).toBeUndefined();
  });
});

describe("place solver: no intersecting", () => {
  const wall = { id: "wall", box: { c: [0, 2] as [number, number], half: [5, 0.5] as [number, number], yaw: 0 }, band: [9, 13] as [number, number] };
  it("pushes a crate out of a wall along the least-penetration axis", () => {
    const r = solvePlacement(req({ at: [0, 1.2], half: [0.5, 0.5], height: 1 }), { ground: flat(10), obstacles: [wall] });
    expect(r.status).toBe("moved");
    expect(r.z!).toBeLessThanOrEqual(1.0 + 1e-6);
    expect(Math.abs(r.x!)).toBeLessThan(1e-6);
    expect(obbOverlap({ c: [r.x!, r.z!], half: [0.5, 0.5], yaw: 0 }, wall.box, 0.05)).toBeNull();
  });
  it("an open court collides by its walls only: a basin in its yard is no intersection, a wall through its wall is", () => {
    // a 10 x 10 m court whose solid cells are its 4 walls (0.5 m cells on the rim)
    const rim: [number, number][] = [];
    for (let i = -4.75; i <= 4.75; i += 0.5) rim.push([i, -4.75], [i, 4.75], [-4.75, i], [4.75, i]);
    const court = (o: Partial<PlaceRequest> = {}) => req({ id: "court", half: [5, 5], height: 4, movable: false, cells: rim, cell: 0.5, ...o });
    const basin = { id: "basin", box: { c: [1, 1] as [number, number], half: [1, 1] as [number, number], yaw: 0 }, band: [9, 12] as [number, number] };
    expect(solvePlacement(court(), { ground: flat(10), obstacles: [basin] }).status).toBe("ok");
    const wall = { id: "wall", box: { c: [4.8, 0] as [number, number], half: [0.4, 3] as [number, number], yaw: 0 }, band: [9, 12] as [number, number] };
    const r = solvePlacement(court(), { ground: flat(10), obstacles: [wall] });
    expect(r.status).toBe("dropped");
    expect(r.reason).toMatch(/intersects structure wall/);
  });
  it("drops what cannot be pushed out within its tolerance; bedded pieces may intersect", () => {
    const deep = solvePlacement(req({ at: [0, 2], half: [0.5, 0.5], height: 1, rule: { tolerance: { move: 0.3, gap: 0.05, slope: 0.6, yaw: 0 } } }), { ground: flat(10), obstacles: [wall] });
    expect(deep.status).toBe("dropped");
    expect(deep.reason).toMatch(/intersects structure wall/);
    const bed = solvePlacement(req({ at: [0, 2], half: [0.5, 0.5], height: 1, rule: { bedded: true } }), { ground: flat(10), obstacles: [wall] });
    expect(bed.status).toBe("ok");
  });
  it("a piece above a structure's band does not collide with it", () => {
    const r = solvePlacement(req({ at: [0, 2], half: [0.5, 0.5], height: 1 }), { ground: flat(20), obstacles: [wall] });
    expect(r.status).toBe("ok");
  });
  it("a batch never stacks two pieces in one spot", () => {
    const rs = solvePlacements([req({ id: "a", half: [0.5, 0.5] }), req({ id: "b", half: [0.5, 0.5] })], { ground: flat(10) });
    expect(rs[1]!.status).toBe("moved");
    expect(obbOverlap({ c: [rs[0]!.x!, rs[0]!.z!], half: [0.5, 0.5], yaw: 0 }, { c: [rs[1]!.x!, rs[1]!.z!], half: [0.5, 0.5], yaw: 0 }, 0.05)).toBeNull();
  });
});

describe("place solver: support snap", () => {
  // a 2.4 m square pillar, top at 6.8 m, a fire marker at its centre
  const host: HostShape = { w: [10, 10], ang: Math.PI / 2, y: 3, prefab: "sun-ruins/avenue-pillar", k: 1,
    top: (x, z) => (Math.abs(x) <= 1.2 && Math.abs(z) <= 1.2 ? 6.8 : null), markers: { "fire-1": { position: [0.4, 6.8, 0] } } };
  it("snaps to a named marker (read from the host, turned with it)", () => {
    const r = solvePlacement(req({ at: [0, 0], half: [0.6, 0.6], on: { host, marker: "fire-1" } }), { ground: flat(0) });
    expect(r.status).not.toBe("dropped");
    // marker x 0.4 in a host turned 90 deg: world (10 + 0.4 cos 90, 10 - 0.4 sin 90) = (10, 9.6)
    expect(r.x!).toBeCloseTo(10, 3);
    expect(r.z!).toBeCloseTo(9.6, 3);
    expect(r.y!).toBeCloseTo(3 + 6.8 - 0.1, 3);
  });
  it("with no marker, snaps to the centre of a pedestal top", () => {
    const s = snapToHost([10.5, 10.4], [0.6, 0.6], host);
    expect(s.how).toBe("face-centre");
    expect(s.w[0]).toBeCloseTo(10, 1);
    expect(s.w[1]).toBeCloseTo(10, 1);
  });
  it("drops a piece too big for its host's top (overhang)", () => {
    const r = solvePlacement(req({ half: [2, 2], on: { host, marker: "fire-1", bottom: () => 0 } }), { ground: flat(0) });
    expect(r.status).toBe("dropped");
    expect(r.reason).toMatch(/overhang/);
  });
  it("names a missing marker", () => {
    const r = solvePlacement(req({ on: { host, marker: "fire-9" } }), { ground: flat(0) });
    expect(r.status).toBe("dropped");
    expect(r.reason).toMatch(/no marker fire-9/);
  });
});

describe("place solver: keep-outs", () => {
  const markers = [{ id: "door-1", kind: "door", position: [0, 0, 4] as [number, number, number], yaw: 0, size: [1.2, 2.2, 0.3] as [number, number, number] }];
  const ko = keepOutsFromMarkers("house", { at: [0, 0], yaw: 0, y: 10 }, markers);
  it("a WFC door marker becomes a clear zone 1.5 m deep, the door's width + 0.4 m", () => {
    expect(ko).toHaveLength(1);
    expect(ko[0]!.box.half).toEqual([0.8, 1.5]);
  });
  it("a barrel dropped in a doorway is moved out, or dropped when it may not move", () => {
    const moved = solvePlacement(req({ at: [0, 5], half: [0.4, 0.4], height: 1 }), { ground: flat(10), keepOuts: ko });
    expect(moved.status).toBe("moved");
    expect(obbOverlap({ c: [moved.x!, moved.z!], half: [0.4, 0.4], yaw: moved.yaw! }, ko[0]!.box, 0.05)).toBeNull();
    const dropped = solvePlacement(req({ at: [0, 5], half: [0.4, 0.4], height: 1, movable: false }), { ground: flat(10), keepOuts: ko });
    expect(dropped.status).toBe("dropped");
    expect(dropped.reason).toMatch(/clear zone of door door-1 of house/);
  });
  it("a sign high over the door is not in the door", () => {
    const r = solvePlacement(req({ at: [0, 4.3], half: [0.4, 0.1], height: 0.5, seat: "float-ok", y: 13 }), { ground: flat(10), keepOuts: ko });
    expect(r.status).toBe("ok");
  });
  it("lanes, door sockets and prop-declared openings make keep-outs too", () => {
    expect(keepOutsFromLane("street", [[0, 0], [10, 0]], 3)[0]!.box.half).toEqual([1.5, 5]);
    expect(keepOutAtDoor("d", [0, 0], [0, 1], 1).box.half).toEqual([0.7, 1.5]);
    expect(keepOutsFromOpenings("stall", { at: [0, 0], yaw: 0, y: 0 }, [{ kind: "door", position: [0, 0, 1], yaw: 0, width: 1, depth: 2 }])[0]!.box.half).toEqual([0.7, 2]);
  });
  it("candidate spots run nearest first", () => {
    const c = candidateSpots(1, 15);
    expect(c[0]).toEqual([0, 0, 0]);
    expect(Math.hypot(c[c.length - 1]![0], c[c.length - 1]![1])).toBeCloseTo(1, 3);
  });
});

describe("repeat lint: anything repeated is one prefab", () => {
  const light = { kind: "point", color: "#ffaa55", intensity: 40, range: 12 };
  it("fails two braziers each carrying their own light values", () => {
    const f = findRepeats({ entities: {
      a: { name: "brazier light", components: { transform: { position: [0, 0, 0] }, light: { ...light, intensity: 40 } } },
      b: { name: "brazier light", components: { transform: { position: [5, 0, 0] }, light: { ...light, intensity: 55 } } },
    } });
    expect(f.map((x) => x.rule)).toEqual(["inline-role"]);
    expect(f[0]!.key).toBe("brazier");
  });
  it("fails an identical inline assembly written out twice (a stall), reporting the assembly, not its parts", () => {
    const stall = (id: string, x: number) => ({
      [id]: { name: "stall", components: { transform: { position: [x, 0, 0] } } },
      [`${id}-roof`]: { name: "roof", parent: id, components: { transform: { position: [0, 2, 0] }, mesh: { source: { kind: "asset", assetId: "m/roof.glb" } } } },
      [`${id}-post`]: { name: "post", parent: id, components: { transform: { position: [1, 0, 0] }, mesh: { source: { kind: "asset", assetId: "m/post.glb" } }, collider: { shape: "box" } } },
    });
    const f = findRepeats({ entities: { ...stall("s1", 0), ...stall("s2", 9) } });
    expect(f).toHaveLength(1);
    expect(f[0]!.rule).toBe("identical");
    expect(f[0]!.ids.sort()).toEqual(["s1", "s2"]);
  });
  it("passes prefab instances, and fails instances overriding the light differently", () => {
    const inst = (v?: number) => ({ components: { transform: {}, prefab: { prefabId: "city-fires/city-beacon", ...(v ? { overrides: [{ path: "beacon/components/light/intensity", value: v }] } : {}) } } });
    expect(findRepeats({ entities: { a: inst(), b: inst(), c: inst() } })).toEqual([]);
    const f = findRepeats({ entities: { a: inst(90), b: inst(60), c: inst() } });
    expect(f.map((x) => x.rule)).toEqual(["override-role"]);
  });
  it("lints what an ops batch is about to add", () => {
    const ops = [0, 1, 2].map((i) => ({ op: "add-entity", id: `t${i}`, entity: { name: "torch", components: { transform: { position: [i, 0, 0] }, vfx: { preset: "torch" } } } }));
    expect(findRepeats(docOfOps(ops))[0]!.rule).toBe("identical");
  });
  it("generated meshes and a single sun are not repeats", () => {
    expect(findRepeats({ entities: {
      sun: { components: { light: { kind: "directional" } } },
      w1: { components: { mesh: { source: { kind: "surface", positions: [], indices: [] } } } },
      w2: { components: { mesh: { source: { kind: "surface", positions: [], indices: [] } } } },
    } })).toEqual([]);
  });
});
