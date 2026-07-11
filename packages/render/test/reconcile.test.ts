import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import type { SceneDoc } from "@hitreg/core";
import { buildScene } from "../src/scene-builder.js";
import { reconcileScene } from "../src/reconcile.js";

/** Expanded-doc fixture: reconcile consumes docs AFTER prefab expansion, so
 * tests write fully-populated component data (no registry defaults here). */
function doc(entities: SceneDoc["entities"]): SceneDoc {
  return { version: 1, name: "test", entities };
}

const IDENTITY = {
  position: [0, 0, 0] as [number, number, number],
  rotation: [0, 0, 0, 1] as [number, number, number, number],
  scale: [1, 1, 1] as [number, number, number],
};

function boxEntity(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: "Box",
    parent: null,
    tags: [],
    components: {
      transform: { ...IDENTITY },
      mesh: {
        source: { kind: "primitive", shape: "box", size: [1, 1, 1] },
        castShadow: true,
        receiveShadow: true,
      },
      ...overrides,
    },
  };
}

function moved(entity: ReturnType<typeof boxEntity>, position: [number, number, number]) {
  return structuredClone({
    ...entity,
    components: {
      ...entity.components,
      transform: { ...IDENTITY, position },
    },
  });
}

describe("reconcileScene", () => {
  it("applies a transform-only change without touching visuals", () => {
    const prev = doc({ box: boxEntity() });
    const next = doc({ box: moved(boxEntity(), [3, 2, 1]) });
    const built = buildScene(prev);
    const group = built.objects.get("box")!;
    const meshBefore = group.children[0];

    expect(reconcileScene(built, prev, next, ["box"], {})).toBe(true);
    expect(group.position.toArray()).toEqual([3, 2, 1]);
    expect(group.children[0]).toBe(meshBefore); // same mesh object — no rebuild
    expect(built.objects.get("box")).toBe(group); // group identity survives
  });

  it("resets to identity when the transform component is removed", () => {
    const prev = doc({ box: moved(boxEntity(), [5, 5, 5]) });
    const entity = boxEntity();
    delete (entity.components as Record<string, unknown>)["transform"];
    const next = doc({ box: entity });
    const built = buildScene(prev);

    expect(reconcileScene(built, prev, next, ["box"], {})).toBe(true);
    expect(built.objects.get("box")!.position.toArray()).toEqual([0, 0, 0]);
  });

  it("renames the group on a name-only change", () => {
    const prev = doc({ box: boxEntity() });
    const next = doc({ box: { ...boxEntity(), name: "Crate" } });
    const built = buildScene(prev);
    expect(reconcileScene(built, prev, next, ["box"], {})).toBe(true);
    expect(built.objects.get("box")!.name).toBe("Crate");
  });

  it("rebuilds visuals in place on a mesh change, keeping the group", () => {
    const prev = doc({ box: boxEntity() });
    const next = structuredClone(prev);
    (next.entities["box"]!.components["mesh"] as { source: { size: number[] } }).source.size = [
      2, 2, 2,
    ];
    const built = buildScene(prev);
    const group = built.objects.get("box")!;
    const meshBefore = group.children[0] as THREE.Mesh;
    const resets: string[] = [];

    expect(
      reconcileScene(built, prev, next, ["box"], {}, { onEntityReset: (id) => resets.push(id) }),
    ).toBe(true);
    expect(resets).toEqual(["box"]);
    expect(built.objects.get("box")).toBe(group);
    const meshAfter = group.children[0] as THREE.Mesh;
    expect(meshAfter).not.toBe(meshBefore);
    const size = new THREE.Box3().setFromObject(meshAfter).getSize(new THREE.Vector3());
    expect(size.x).toBeCloseTo(2);
  });

  it("keeps child entity groups when rebuilding a parent's visuals", () => {
    const prev = doc({
      parent: boxEntity(),
      child: { ...boxEntity(), name: "Child", parent: "parent" },
    });
    const next = structuredClone(prev);
    (next.entities["parent"]!.components["mesh"] as { castShadow: boolean }).castShadow = false;
    const built = buildScene(prev);
    const childGroup = built.objects.get("child")!;

    expect(reconcileScene(built, prev, next, ["parent"], {})).toBe(true);
    expect(childGroup.parent).toBe(built.objects.get("parent"));
  });

  it("refuses scene-level components (sky, camera, postfx)", () => {
    for (const component of ["sky", "camera", "postfx"]) {
      const prev = doc({ e: boxEntity({ [component]: { a: 1 } }) });
      const next = doc({ e: boxEntity({ [component]: { a: 2 } }) });
      const built = buildScene(prev);
      expect(reconcileScene(built, prev, next, ["e"], {})).toBe(false);
    }
  });

  it("refuses structural changes (reparent, missing entity)", () => {
    const prev = doc({ a: boxEntity(), b: boxEntity() });
    const reparented = structuredClone(prev);
    reparented.entities["b"]!.parent = "a";
    const built = buildScene(prev);
    expect(reconcileScene(built, prev, reparented, ["b"], {})).toBe(false);
    expect(reconcileScene(built, prev, doc({ a: boxEntity() }), ["b"], {})).toBe(false);
  });

  it("treats dataOnlyComponents as invisible: no visual rebuild, no reset", () => {
    const prev = doc({ box: boxEntity({ script: { name: "spinner", params: { speed: 1 } } }) });
    const next = doc({ box: boxEntity({ script: { name: "spinner", params: { speed: 9 } } }) });
    const built = buildScene(prev);
    const meshBefore = built.objects.get("box")!.children[0];
    const resets: string[] = [];

    const ok = reconcileScene(built, prev, next, ["box"], {}, {
      onEntityReset: (id) => resets.push(id),
      dataOnlyComponents: new Set(["script"]),
    });
    expect(ok).toBe(true);
    expect(resets).toEqual([]);
    expect(built.objects.get("box")!.children[0]).toBe(meshBefore);
  });

  it("allowVisualRebuild veto refuses BEFORE any mutation", () => {
    const prev = doc({
      a: boxEntity(),
      b: boxEntity(),
    });
    const next = structuredClone(prev);
    // a: transform change (fine), b: mesh change (vetoed)
    (next.entities["a"]!.components["transform"] as { position: number[] }).position = [9, 9, 9];
    (next.entities["b"]!.components["mesh"] as { castShadow: boolean }).castShadow = false;
    const built = buildScene(prev);

    const ok = reconcileScene(built, prev, next, ["a", "b"], {}, {
      allowVisualRebuild: () => false,
    });
    expect(ok).toBe(false);
    // the passable change must NOT have been applied — all-or-nothing
    expect(built.objects.get("a")!.position.toArray()).toEqual([0, 0, 0]);
  });
});
