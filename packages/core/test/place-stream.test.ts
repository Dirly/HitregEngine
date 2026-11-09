import { describe, expect, it } from "vitest";
import { placeDoc, placeStreamOf, placeStreamSchema, placeWanted, planPlaceStreaming, worldTransforms, type SceneDoc } from "../src/index.js";

const t = (x: number, z: number) => ({ transform: { position: [x, 0, z], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
const doc = {
  version: 1,
  name: "w",
  entities: {
    world: { name: "world", parent: null, tags: ["world"], components: {} },
    player: { name: "p", parent: null, tags: ["player"], components: t(0, 0) },
    "poi-a": { name: "a", parent: null, tags: ["poi"], components: t(1000, 0) },
    "a-hut": { name: "hut", parent: "poi-a", components: t(10, 0) },
    "a-gate": { name: "gate", parent: "poi-a", components: { ...t(-10, 0), landmark: {} } },
    "a-door": { name: "door", parent: "a-gate", components: t(0, 1) },
    // a dressing root sits at the origin; its footprint is its children
    "dress-a": { name: "d", parent: null, tags: ["dressing", "poi:a"], components: t(0, 0) },
    "dress-a-crate": { name: "c", parent: "dress-a", components: t(1005, 3) },
    town: { name: "town", parent: null, tags: ["town:t"], components: { ...t(0, 500), placeStream: { distance: 50 } } },
    kept: { name: "k", parent: null, tags: ["poi"], components: { ...t(0, -500), placeStream: { mode: "always" } } },
    npc: { name: "n", parent: null, tags: ["npc", "poi"], components: t(5, 5) },
  },
} as unknown as SceneDoc;

describe("planPlaceStreaming", () => {
  const plan = planPlaceStreaming(doc);
  it("streams poi / poi:<id> / town:<id> roots, never players, npcs, world or mode always", () => {
    expect(plan.places.map((p) => p.id).sort()).toEqual(["dress-a", "poi-a", "town"]);
    expect(plan.base.entities["kept"]).toBeDefined();
    expect(plan.base.entities["npc"]).toBeDefined();
    expect(plan.base.entities["player"]).toBeDefined();
  });
  it("keeps landmark subtrees resident, re-rooted at their world transform", () => {
    const a = plan.places.find((p) => p.id === "poi-a")!;
    expect(a.ids).toEqual(["poi-a", "a-hut"]);
    expect(a.resident).toEqual(["a-gate", "a-door"]);
    expect(plan.base.entities["poi-a"]).toBeUndefined();
    expect(plan.base.entities["a-gate"]!.parent).toBeNull();
    expect((plan.base.entities["a-gate"]!.components["transform"] as { position: number[] }).position).toEqual([990, 0, 0]);
    expect(plan.base.entities["a-door"]!.parent).toBe("a-gate");
  });
  it("measures a footprint from children, not a dressing root's origin", () => {
    const d = plan.places.find((p) => p.id === "dress-a")!;
    expect(d.center).toEqual([1005, 3]);
    expect(d.radius).toBeLessThan(20);
  });
  it("reads distance from placeStream and builds a place doc with the ids unchanged", () => {
    expect(plan.places.find((p) => p.id === "town")!.distance).toBe(50);
    expect(Object.keys(placeDoc(doc, plan.places.find((p) => p.id === "poi-a")!).entities)).toEqual(["poi-a", "a-hut"]);
  });
  it("hysteresis: builds inside distance, frees only past distance + keepPadding", () => {
    const a = plan.places.find((p) => p.id === "poi-a")!; // distance 300, keepPadding 100
    const edge = a.center[0] + a.radius;
    expect(placeWanted(a, false, edge + 299, 0)).toBe(true);
    expect(placeWanted(a, false, edge + 301, 0)).toBe(false);
    expect(placeWanted(a, true, edge + 390, 0)).toBe(true);
    expect(placeWanted(a, true, edge + 410, 0)).toBe(false);
  });
  it("returns the same doc when nothing streams", () => {
    const flat = { version: 1, name: "x", entities: { a: { name: "a", parent: null, components: {} } } } as unknown as SceneDoc;
    expect(planPlaceStreaming(flat).base).toBe(flat);
    expect(planPlaceStreaming(flat).render).toBe(flat);
  });
  it("preserves render identity when no nested boundary or resident landmark needs detachment", () => {
    const source = { ...doc, entities: {
      town: doc.entities["town"]!,
      prop: { ...doc.entities["a-hut"]!, parent: "town" },
    } };
    expect(planPlaceStreaming(source).render).toBe(source);
  });
  it("keeps resident landmark world transforms identical in base and full render docs after parent motion", () => {
    const s = Math.SQRT1_2;
    const source = { version: 1, name: "landmark", entities: {
      town: { name: "Town", parent: null, tags: ["town:t"], components: {
        transform: { position: [100, 0, 0], rotation: [0, s, 0, s], scale: [2, 3, 4] },
      } },
      gate: { name: "Gate", parent: "town", components: { landmark: {},
        transform: { position: [20, 2, 3], rotation: [0, s, 0, s], scale: [.5, 2, .25] },
      } },
      door: { name: "Door", parent: "gate", components: t(1, 0) },
    } } as unknown as SceneDoc;
    const original = JSON.stringify(source), first = planPlaceStreaming(source);
    const moved = structuredClone(source);
    (moved.entities["town"]!.components["transform"] as { position: number[] }).position = [140, 10, 30];
    const second = planPlaceStreaming(moved);
    for (const [plan, position] of [[first, [112, 6, -40]], [second, [152, 16, -10]]] as const) {
      expect(plan.render).not.toBe(source);
      expect(plan.render.entities["gate"]!.parent).toBeNull();
      expect(plan.base.entities["gate"]).toBe(plan.render.entities["gate"]);
      const transform = plan.render.entities["gate"]!.components["transform"] as { position: number[]; rotation: number[]; scale: number[] };
      transform.position.forEach((n, i) => expect(n).toBeCloseTo(position[i]!));
      expect(transform.rotation[1]).toBeCloseTo(1);
      expect(transform.rotation[3]).toBeCloseTo(0);
      expect(transform.scale).toEqual([1, 6, 1]);
      expect(plan.render.entities["door"]!.parent).toBe("gate");
      const world = worldTransforms(plan.render), baseWorld = worldTransforms(plan.base);
      expect(world.get("door")).toEqual(baseWorld.get("door"));
    }
    expect(JSON.stringify(source)).toBe(original);
    expect(source.entities["gate"]!.parent).toBe("town");
    expect(first.render.entities["gate"]).not.toEqual(second.render.entities["gate"]);
  });
});

describe("explicit nested place boundaries", () => {
  const nested = () => ({ version: 1, name: "rooms", entities: {
    town: { name: "Town", parent: null, tags: ["town:t"], components: t(100, 200) },
    house: { name: "House", parent: "town", components: t(5, 2) },
    implicit: { name: "Tagged room", parent: "house", tags: ["poi:r"], components: t(2, 0) },
    implicitProp: { name: "Table", parent: "implicit", components: t(0, 0) },
    room: { name: "Room", parent: "house", components: { ...t(3, 4), placeStream: { distance: 12, footprintPadding: 1.5 } } },
    prop: { name: "Bed", parent: "room", components: t(1, 0) },
    inner: { name: "Inner room", parent: "room", components: { ...t(2, 0), placeStream: { distance: 6, footprintPadding: 0 } } },
    innerProp: { name: "Book", parent: "inner", components: t(0, 1) },
    inherit: { name: "Room detail", parent: "room", tags: ["town:detail"], components: { ...t(0, 0), placeStream: { mode: "always" } } },
    inheritProp: { name: "Chair", parent: "inherit", components: t(0, 0) },
    kept: { name: "Resident", parent: null, tags: ["poi"], components: { ...t(0, 0), placeStream: { mode: "always" } } },
  } } as unknown as SceneDoc);

  const expectClosedHierarchy = (slice: SceneDoc) => {
    for (const entity of Object.values(slice.entities)) {
      expect(entity.parent === null || entity.parent in slice.entities).toBe(true);
    }
  };

  it("opts in nested roots only explicitly and assigns every streamed entity to exactly one place", () => {
    const source = nested(), original = JSON.stringify(source), plan = planPlaceStreaming(source);
    expect(plan.places.map((p) => p.id)).toEqual(["town", "room", "inner"]);
    expect(placeStreamOf(source.entities["implicit"]!)).toBeNull();
    expect(plan.placeOf.get("implicitProp")).toBe("town");
    expect(plan.placeOf.get("prop")).toBe("room");
    expect(plan.placeOf.get("inheritProp")).toBe("room");
    expect(plan.placeOf.get("innerProp")).toBe("inner");
    const assigned = plan.places.flatMap((p) => p.ids);
    expect(new Set(assigned).size).toBe(assigned.length);
    expect(plan.placeOf.size).toBe(assigned.length);
    expect(plan.base.entities["kept"]).toBeDefined();
    expect(Object.keys(plan.render.entities)).toEqual(Object.keys(source.entities));
    expect(JSON.stringify(source)).toBe(original);
    expectClosedHierarchy(plan.base);
    for (const spec of plan.places) {
      const slice = placeDoc(plan.render, spec);
      expect(Object.keys(slice.entities).length).toBeGreaterThan(0);
      expect(slice.entities[spec.id]!.parent).toBeNull();
      expectClosedHierarchy(slice);
    }
  });

  it("detaches at world position, rotation and scale while preserving descendant world transforms", () => {
    const source = nested(), s = Math.SQRT1_2;
    source.entities["town"]!.components["transform"] = { position: [100, 10, 200], rotation: [0, s, 0, s], scale: [2, 3, 4] };
    source.entities["house"]!.components["transform"] = { position: [5, 1, 2], rotation: [0, s, 0, s], scale: [.5, 2, .25] };
    source.entities["room"]!.components["transform"] = { position: [3, 2, 4], rotation: [0, 0, 0, 1], scale: [2, .5, 3] };
    const plan = planPlaceStreaming(source), room = plan.render.entities["room"]!;
    const transform = room.components["transform"] as { position: number[]; rotation: number[]; scale: number[] };
    expect(room.parent).toBeNull();
    expect(transform.position[0]).toBeCloseTo(105);
    expect(transform.position[1]).toBeCloseTo(25);
    expect(transform.position[2]).toBeCloseTo(186);
    expect(transform.rotation[1]).toBeCloseTo(1);
    expect(transform.rotation[3]).toBeCloseTo(0);
    expect(transform.scale).toEqual([2, 3, 3]);
    const before = worldTransforms(source), after = worldTransforms(plan.render);
    for (const id of Object.keys(source.entities)) {
      for (const key of ["position", "rotation", "scale"] as const) {
        after.get(id)![key].forEach((n, i) => expect(n).toBeCloseTo(before.get(id)![key][i]!));
      }
    }
    expect(source.entities["room"]!.parent).toBe("house");
    expect(plan.render.entities["prop"]).toBe(source.entities["prop"]);
  });

  it("cuts room boundaries even below resident landmarks without creating empty or orphaned slices", () => {
    const source = nested();
    source.entities["house"]!.components["landmark"] = {};
    source.entities["prop"]!.components["landmark"] = {};
    const plan = planPlaceStreaming(source), town = plan.places.find((p) => p.id === "town")!;
    expect(town.resident).toEqual(["house", "implicit", "implicitProp"]);
    expect(town.ids).toEqual(["town"]);
    expect(plan.placeOf.get("room")).toBe("room");
    expect(plan.placeOf.get("innerProp")).toBe("inner");
    expect(plan.places.find((p) => p.id === "room")!.resident).toEqual(["prop"]);
    expect(plan.base.entities["house"]!.parent).toBeNull();
    expect(plan.base.entities["prop"]!.parent).toBeNull();
    expect(plan.base.entities["room"]).toBeUndefined();
    expectClosedHierarchy(plan.base);
    for (const spec of plan.places) expectClosedHierarchy(placeDoc(plan.render, spec));
    const all = [...Object.keys(plan.base.entities), ...plan.places.flatMap((p) => p.ids)];
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBe(Object.keys(source.entities).length);
  });

  it("refreshes detached room transforms when an authored ancestor moves", () => {
    const source = nested(), first = planPlaceStreaming(source), moved = structuredClone(source);
    moved.entities["town"]!.components["transform"] = { ...t(130, 220).transform };
    const second = planPlaceStreaming(moved);
    expect(worldTransforms(second.render).get("prop")!.position).toEqual([139, 0, 226]);
    expect(worldTransforms(first.render).get("prop")!.position).toEqual([109, 0, 206]);
    expect(first.render.entities["room"]).not.toEqual(second.render.entities["room"]);
    expect(second.render.entities["prop"]).toBe(moved.entities["prop"]);
    expect(source.entities["town"]!.components["transform"]).toEqual(t(100, 200).transform);
  });

  it("preserves inherited hidden state on detached rooms and resident landmarks without mutating source", () => {
    const source = nested();
    source.entities["house"]!.components["visibility"] = { visible: false };
    source.entities["implicit"]!.components["landmark"] = {};
    source.entities["room"]!.components["visibility"] = { visible: true };
    source.entities["inner"]!.components["visibility"] = { visible: true };
    const original = JSON.stringify(source);
    const hidden = planPlaceStreaming(source);
    for (const id of ["room", "inner", "implicit"]) {
      expect(hidden.render.entities[id]!.parent).toBeNull();
      expect(hidden.render.entities[id]!.components["visibility"]).toEqual({ visible: false });
    }
    expect(hidden.base.entities["implicit"]).toBe(hidden.render.entities["implicit"]);
    expect(JSON.stringify(source)).toBe(original);

    const revealed = structuredClone(source);
    delete revealed.entities["house"]!.components["visibility"];
    revealed.entities["inner"]!.components["visibility"] = { visible: false };
    const shown = planPlaceStreaming(revealed);
    expect(shown.render.entities["room"]!.components["visibility"]).toEqual({ visible: true });
    expect(shown.render.entities["inner"]!.components["visibility"]).toEqual({ visible: false });
    expect(shown.render.entities["implicit"]!.components["visibility"]).toBeUndefined();
    expect(hidden.render.entities["room"]!.components["visibility"]).toEqual({ visible: false });
  });

  it("honours declared footprint padding and retains the legacy 16 metre default", () => {
    const plan = planPlaceStreaming(nested());
    expect(placeStreamSchema.parse({}).footprintPadding).toBe(16);
    expect(placeStreamSchema.safeParse({ footprintPadding: -1 }).success).toBe(false);
    const room = plan.places.find((p) => p.id === "room")!;
    expect(room.radius).toBe(2);
    expect(plan.places.find((p) => p.id === "inner")!.radius).toBe(0);
    expect(plan.places.find((p) => p.id === "town")!.radius).toBe(17);
  });

  it("allows an explicit nested room beneath an always-built root, retaining all parentless safety exclusions", () => {
    const source = nested();
    source.entities["town"]!.components["placeStream"] = { mode: "always" };
    for (const tag of ["player", "spawn", "npc", "world", "water"]) {
      source.entities[`never-${tag}`] = { name: tag, parent: null, tags: [tag, "poi"], components: { placeStream: {} } };
    }
    for (const component of ["voxelWorld", "chunkStreamer", "subscene", "sky", "postfx", "camera", "netObject"]) {
      source.entities[`never-${component}`] = { name: component, parent: null, tags: ["poi"], components: { [component]: {}, placeStream: {} } };
    }
    const plan = planPlaceStreaming(source);
    expect(plan.places.map((p) => p.id)).toEqual(["room", "inner"]);
    expect(plan.base.entities["town"]).toBeDefined();
    expect(plan.base.entities["house"]!.parent).toBe("town");
    for (const id of Object.keys(source.entities).filter((id) => id.startsWith("never-"))) {
      expect(plan.base.entities[id]).toBe(source.entities[id]);
    }
    expectClosedHierarchy(plan.base);
  });
});

import { propHideDistance, propHideIndex } from "../src/index.js";
describe("props hide by size", () => {
  it("derives a bucketed distance from size and category; big props and 'never' never hide", () => {
    expect(propHideDistance({ size: [0.3, 0.4, 0.3], category: "decor" })).toBe(30);
    expect(propHideDistance({ size: [0.8, 1.2, 0.8], category: "light" })).toBe(60);
    expect(propHideDistance({ size: [1.5, 3, 2.5], category: "trade" })).toBe(160);
    expect(propHideDistance({ size: [6, 4, 3], category: "street" })).toBeNull();
    expect(propHideDistance({ size: [0.3, 0.3, 0.3], hideDistance: "never" })).toBeNull();
    expect(propHideDistance({ size: [0.3, 0.3, 0.3], hideDistance: 75 })).toBe(75);
  });
  it("indexes a prop's subtree; its own culling or a landmark above overrides, a room's culling does not", () => {
    const d = { version: 1, name: "x", entities: {
      room: { name: "r", parent: null, components: { culling: { minScreenPx: 6 } } },
      vase: { name: "v", parent: "room", components: { dressing: { size: [0.3, 0.4, 0.3] } } },
      "vase-mesh": { name: "m", parent: "vase", components: {} },
      own: { name: "o", parent: "room", components: { dressing: { size: [0.3, 0.4, 0.3] }, culling: {} } },
      gate: { name: "g", parent: null, components: { landmark: {} } },
      urn: { name: "u", parent: "gate", components: { dressing: { size: [0.3, 0.4, 0.3] } } },
    } } as unknown as SceneDoc;
    const index = propHideIndex(d);
    expect(index.get("vase")).toBe(30);
    expect(index.get("vase-mesh")).toBe(30);
    expect(index.has("own")).toBe(false);
    expect(index.has("urn")).toBe(false);
    expect(index.has("room")).toBe(false);
  });
});

import { OUTDOOR_PROP_MIN_REVEAL, propRevealIndex, shadowlessEntities } from "../src/index.js";
describe("prop reveal", () => {
  const entity = (parent: string | null, components: Record<string, unknown> = {}) => ({ name: "e", parent, tags: [], components });
  const doc = { version: 1, name: "t", entities: {
    room: entity(null, { culling: { interior: true, reveal: 12 } }),
    cupIn: entity("room", { dressing: { size: [0.1, 0.1, 0.1] } }),
    stool: entity(null, { dressing: { size: [0.4, 0.5, 0.4] } }),
    pinned: entity(null, { dressing: { size: [0.4, 0.5, 0.4], hideDistance: 45 } }),
  } } as never;
  it("raises what stands out of doors, leaves rooms and an author's distance alone, and keeps its shadow rule", () => {
    const reveal = propRevealIndex(doc);
    expect(reveal.get("stool")).toBe(OUTDOOR_PROP_MIN_REVEAL);
    expect(reveal.get("cupIn")).toBe(30);
    expect(reveal.get("pinned")).toBe(45);
    expect(shadowlessEntities(doc).has("stool")).toBe(propHideDistance({ size: [0.4, 0.5, 0.4] })! <= 30);
  });
});

describe("shadow casters", () => {
  const entity = (parent: string | null, components: Record<string, unknown> = {}) => ({ name: "e", parent, tags: [], components });
  it("drops interior furnishings and small props, keeps the rest", () => {
    const doc = { version: 1, name: "t", entities: {
      house: entity(null),
      room: entity("house", { culling: { interior: true, reveal: 12 } }),
      bed: entity("room"),
      cup: entity(null, { dressing: { size: [0.2, 0.2, 0.2] } }),
      crate: entity(null, { dressing: { size: [1, 1, 1] } }),
    } } as unknown as SceneDoc;
    const out = shadowlessEntities(doc);
    expect([...out].sort()).toEqual(["bed", "cup", "room"]);
  });
  it("keeps interior shadows in an interior scene (cullingProfile)", () => {
    const doc = { version: 1, name: "t", entities: {
      cfg: entity(null, { cullingProfile: { interiorReveal: 80 } }),
      room: entity(null, { culling: { interior: true } }),
      bed: entity("room"),
    } } as unknown as SceneDoc;
    expect(shadowlessEntities(doc).size).toBe(0);
  });
});
