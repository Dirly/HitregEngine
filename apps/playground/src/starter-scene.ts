import {
  applyOps,
  createScene,
  type ComponentRegistry,
  type Op,
  type SceneDoc,
} from "@hitreg/core";

/** Minimal starter for a new scene: ground, sun, ambient. Used for the
 *  "+ new scene" button and as the playground's fallback boot document. */
export function buildStarterDoc(name: string, registry: ComponentRegistry): SceneDoc {
  const ops: Op[] = [
    {
      op: "add-entity",
      id: "ground",
      entity: {
        name: "Ground",
        parent: null,
        tags: ["static"],
        components: {
          transform: {},
          mesh: { source: { kind: "primitive", shape: "plane", size: [40, 1, 40] }, castShadow: false, static: true },
          collider: { shape: "box", size: [40, 0.2, 40], offset: [0, -0.1, 0] },
        },
      },
    },
    {
      op: "add-entity",
      id: "sun",
      entity: {
        name: "Sun",
        parent: null,
        tags: [],
        components: {
          transform: { position: [20, 30, 10] },
          light: { kind: "directional", color: "#fff5e0", intensity: 1, castShadow: true },
        },
      },
    },
    {
      op: "add-entity",
      id: "sky",
      entity: {
        name: "Ambient",
        parent: null,
        tags: [],
        components: { light: { kind: "ambient", color: "#334455", intensity: 0.6 } },
      },
    },
  ];
  const { doc } = applyOps(createScene(name), ops, registry);
  return doc;
}
