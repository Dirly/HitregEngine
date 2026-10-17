import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { impostorMaterial, impostorPageMaterial, type ImpostorAtlas } from "../src/impostor.js";
import type { RockImpostorLook } from "../src/rock-cap.js";

/**
 * WebGPU guarantees 16 inter-stage locations (maxInterStageShaderVariables). A pipeline over it
 * fails to build, and every command buffer that sets it is dropped — the rock impostor page shipped
 * at 18 (2026-10-10). The lit material adds its own (view and world position) on top of what the
 * colour/normal/opacity graphs carry, so the impostor graphs themselves must stay well under.
 *
 * Counted on the node graph, the way three assigns them: every distinct varying the fragment
 * graphs reach is one location, and every attribute they reach outside a varying becomes one more.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any;
function fragmentLocations(material: THREE.NodeMaterial): { varyings: number; strayAttributes: string[] } {
  const varyings = new Set<unknown>();
  const stray = new Set<string>();
  const seen = new Set<unknown>();
  const visit = (node: AnyNode): void => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (node.isVaryingNode) {
      varyings.add(node.name ?? node);
      return; // computed in the vertex stage
    }
    if (typeof node._attributeName === "string") {
      // an AttributeNode (three sets no is-flag on it): read in the fragment stage, it becomes a varying
      stray.add(node._attributeName);
      return;
    }
    for (const child of node.getChildren?.() ?? []) visit(child);
  };
  visit(material.colorNode);
  visit(material.normalNode);
  visit(material.opacityNode);
  return { varyings: varyings.size, strayAttributes: [...stray] };
}

function atlas(region = false): ImpostorAtlas {
  const tex = () => new THREE.DataTexture(new Uint8Array(4), 1, 1);
  return { albedo: tex(), normal: tex(), vegetationMask: true, grid: 6, flipFrames: true, ...(region ? { region: { u: 0, v: 0, scale: 0.25 } } : {}) };
}

const rock: RockImpostorLook = {
  key: "test",
  baseRatio: [new THREE.Color(1, 1, 1), new THREE.Color(1, 0.9, 0.8)],
  capColor: [new THREE.Color(1, 1, 1), new THREE.Color(0.5, 0.6, 0.4)],
  start: 0.72,
  softness: 0.06,
};

describe("impostor shaders fit WebGPU's inter-stage limit", () => {
  const bounds = new THREE.Box3(new THREE.Vector3(-1, 0, -1), new THREE.Vector3(1, 2, 1));
  const cases: Array<[string, THREE.NodeMaterial]> = [
    ["tree page", impostorPageMaterial(atlas(true))],
    ["rock page (trees + rocks in one draw)", impostorPageMaterial(atlas(true), rock)],
    ["per-species tree", impostorMaterial(atlas(), bounds)],
    ["per-species rock", impostorMaterial(atlas(true), bounds, rock)],
  ];
  for (const [name, material] of cases) {
    it(`${name}: per-instance terms are packed, no stray attribute reaches the fragment stage`, () => {
      const { varyings, strayAttributes } = fragmentLocations(material);
      expect(strayAttributes).toEqual([]);
      // 5 packed vec4s (two frame offsets + weights, rotation, two tint/inner-uv) — the
      // lit material's own varyings bring the total to ~8 of 16
      expect(varyings).toBeLessThanOrEqual(5);
    });
  }
});
