import { describe, expect, it } from "vitest";
import {
  ComponentRegistry,
  contentTag,
  rebaseSceneEdits,
  registerCoreComponents,
  type EntityDoc,
  type SceneDoc,
} from "../src/index.js";

const registry = new ComponentRegistry();
registerCoreComponents(registry);
const e = (name: string, parent: string | null = null, x = 0): EntityDoc => ({
  name,
  parent,
  tags: [],
  components: { transform: { position: [x, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } },
});
const doc = (entities: Record<string, EntityDoc>): SceneDoc => ({ version: 1, name: "s", entities });

describe("contentTag", () => {
  it("tells versions apart and is stable", () => {
    expect(contentTag("abc")).toBe(contentTag("abc"));
    expect(contentTag("abc")).not.toBe(contentTag("abd"));
    expect(contentTag('{"a":1}')).not.toBe(contentTag('{"a":1}\n'));
  });
});

describe("rebaseSceneEdits", () => {
  const base = doc({ a: e("A"), b: e("B") });

  it("keeps the other writer's places and the client's edits", () => {
    // a tool installed a place (p + child) meanwhile; the human moved A and added H
    const theirs = doc({ ...base.entities, p: e("Place"), pc: e("PlaceChild", "p") });
    const mine = doc({ a: e("A", null, 5), b: e("B"), h: e("Human") });
    const r = rebaseSceneEdits(base, mine, theirs, registry);
    expect(Object.keys(r.doc.entities).sort()).toEqual(["a", "b", "h", "p", "pc"]);
    expect((r.doc.entities.a!.components.transform as any).position[0]).toBe(5);
    expect(r.skipped).toEqual([]);
    expect(theirs.entities.h).toBeUndefined(); // theirs untouched
  });

  it("applies nothing when the client has no edits of its own (a stale canonicalising save)", () => {
    const theirs = doc({ ...base.entities, p: e("Place") });
    const r = rebaseSceneEdits(base, structuredClone(base), theirs, registry);
    expect(r.applied).toEqual([]);
    expect(Object.keys(r.doc.entities).sort()).toEqual(["a", "b", "p"]);
  });

  it("skips an edit to an entity the other writer removed, and reports it", () => {
    const theirs = doc({ b: e("B") });
    const mine = doc({ a: e("A", null, 9), b: e("B") });
    const r = rebaseSceneEdits(base, mine, theirs, registry);
    expect(r.doc.entities.a).toBeUndefined();
    expect(r.skipped.length).toBe(1);
  });

  it("does not remove an entity the other writer added children under", () => {
    const theirs = doc({ ...base.entities, k: e("Kid", "a") });
    const mine = doc({ b: e("B") });
    const r = rebaseSceneEdits(base, mine, theirs, registry);
    expect(r.doc.entities.a).toBeDefined();
    expect(r.doc.entities.k).toBeDefined();
    expect(r.skipped[0]!.reason).toMatch(/added k/);
  });

  it("with no base, removes nothing of theirs", () => {
    const theirs = doc({ ...base.entities, p: e("Place") });
    const mine = doc({ a: e("A", null, 3), h: e("Human") });
    const r = rebaseSceneEdits(null, mine, theirs, registry);
    expect(Object.keys(r.doc.entities).sort()).toEqual(["a", "b", "h", "p"]);
    expect((r.doc.entities.a!.components.transform as any).position[0]).toBe(3);
  });
});
