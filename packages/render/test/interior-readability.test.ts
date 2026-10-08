import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import type { SceneDoc } from "@hitreg/core";
import { buildScene } from "../src/scene-builder.js";
import { applyCullingProfile, cullRootsOf, cullingProfileOf } from "../src/culling.js";

const T = { position: [0, 0, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
const entity = (components: Record<string, unknown>, parent: string | null = null) => ({ name: "e", parent, tags: [], components: { transform: T, ...components } });

describe("interior readability floor: hemisphere fill", () => {
  it("an ambient light with groundColor builds a hemisphere (colour above, ground below)", () => {
    const doc: SceneDoc = { version: 1, name: "fill", entities: { fill: entity({ light: { kind: "ambient", color: "#c8d0e0", groundColor: "#4a4038", intensity: 1.6, range: 10, angle: 0.5, castShadow: false } }) } };
    const built = buildScene(doc);
    const lights: THREE.Light[] = [];
    built.scene.traverse((o) => { if ((o as THREE.Light).isLight) lights.push(o as THREE.Light); });
    const hemi = lights.find((l) => (l as THREE.HemisphereLight).isHemisphereLight) as THREE.HemisphereLight | undefined;
    expect(hemi).toBeDefined();
    expect(hemi!.intensity).toBe(1.6);
    expect("#" + hemi!.color.getHexString()).not.toBe("#" + hemi!.groundColor.getHexString());
    expect(lights.some((l) => (l as THREE.AmbientLight).isAmbientLight)).toBe(false);
  });

  it("an ambient light without groundColor stays a flat AmbientLight", () => {
    const doc: SceneDoc = { version: 1, name: "flat", entities: { fill: entity({ light: { kind: "ambient", color: "#ffffff", intensity: 1, range: 10, angle: 0.5, castShadow: false } }) } };
    let ambient = 0;
    buildScene(doc).scene.traverse((o) => { if ((o as THREE.AmbientLight).isAmbientLight) ambient++; });
    expect(ambient).toBe(1);
  });
});

describe("cullingProfile: interior scenes' own distances", () => {
  const scene = (profile?: Record<string, unknown>): SceneDoc => ({
    version: 1,
    name: "dungeon",
    entities: {
      root: entity(profile ? { cullingProfile: profile } : {}),
      hall: entity({ culling: { occlusion: true, minScreenPx: 6, interior: true, reveal: 12 } }, "root"),
      clutter: entity({ culling: { occlusion: true, minScreenPx: 8, interior: false, reveal: 12 } }, "root"),
    },
  });

  it("without a profile the units keep their own settings", () => {
    const roots = cullRootsOf(scene());
    expect(roots.find((r) => r.id === "hall")!.settings.reveal).toBe(12);
    expect(cullingProfileOf(scene())).toBeNull();
  });

  it("raises interior reveal to the floor, caps size culling, turns occlusion off", () => {
    const roots = cullRootsOf(scene({ interiorReveal: 60, maxMinScreenPx: 0, occlusion: false }));
    const hall = roots.find((r) => r.id === "hall")!.settings;
    const clutter = roots.find((r) => r.id === "clutter")!.settings;
    expect(hall).toMatchObject({ reveal: 60, minScreenPx: 0, occlusion: false, interior: true });
    // reveal only matters for interiors; a non-interior unit keeps it, but loses size culling
    expect(clutter).toMatchObject({ reveal: 12, minScreenPx: 0, occlusion: false, interior: false });
  });

  it("never lowers a reveal that is already larger", () => {
    expect(applyCullingProfile({ occlusion: true, minScreenPx: 0, interior: true, reveal: 90 }, { interiorReveal: 60 }).reveal).toBe(90);
  });
});
