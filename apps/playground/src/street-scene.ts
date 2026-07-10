import {
  applyOps,
  createScene,
  type ComponentRegistry,
  type Op,
  type SceneDoc,
} from "@hitreg/core";

/**
 * The demo street, sun/sky lights included — everything is scene data.
 * The streetlight prefab now lives on disk: assets/prefabs/prefab-streetlight.json.
 * Crates carry the "spin" tag: the playground's fixedUpdate spins them in play mode.
 */
export function buildStreetDoc(registry: ComponentRegistry): SceneDoc {
  const ops: Op[] = [
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
    {
      op: "add-entity",
      id: "ground",
      entity: {
        name: "Ground",
        parent: null,
        tags: ["static"],
        components: {
          transform: {},
          mesh: {
            source: { kind: "primitive", shape: "plane", size: [60, 1, 24] },
            castShadow: false,
            static: true,
          },
          collider: { shape: "box", size: [60, 0.2, 24], offset: [0, -0.1, 0] },
        },
      },
    },
    ...[-15, -5, 5, 15].map((x, i): Op => ({
      op: "add-entity",
      id: `light-${i}`,
      entity: {
        name: `Streetlight ${i + 1}`,
        parent: "ground",
        tags: [],
        components: {
          transform: { position: [x, 0, 4] },
          prefab: {
            prefabId: "prefab-streetlight",
            ...(i === 1 ? { props: { lightColor: "#ff3300" } } : {}),
          },
        },
      },
    })),
    ...[0, 1, 2, 3, 4].map((i): Op => ({
      op: "add-entity",
      id: `crate-${i}`,
      entity: {
        name: `Crate ${i + 1}`,
        parent: "ground",
        tags: ["prop"],
        components: {
          transform: { position: [i * 4 - 8, 0.5, -3] },
          mesh: { source: { kind: "primitive", shape: "box", size: [1, 1, 1] } },
          rigidbody: {},
          collider: {},
        },
      },
    })),
  ];

  // a hinged door: static frame post + dynamic panel joined by a hinge.
  // press play and knock it around with falling crates.
  ops.push(
    {
      op: "add-entity",
      id: "door-frame",
      entity: {
        name: "Door Frame",
        parent: null,
        tags: ["door"],
        components: {
          transform: { position: [3, 1.5, -6] },
          mesh: { source: { kind: "primitive", shape: "cylinder", size: [0.15, 3, 0.15] } },
          collider: { shape: "cylinder", size: [0.15, 3, 0.15] },
        },
      },
    },
    {
      op: "add-entity",
      id: "door-panel",
      entity: {
        name: "Door Panel",
        parent: null,
        tags: ["door"],
        components: {
          transform: { position: [3.65, 1.5, -6] },
          mesh: { source: { kind: "primitive", shape: "box", size: [1.3, 2.4, 0.08] } },
          rigidbody: { angularDamping: 0.3 },
          collider: { shape: "box", size: [1.3, 2.4, 0.08], density: 0.4 },
          joint: {
            kind: "hinge",
            target: "door-frame",
            anchorA: [-0.65, 0, 0],
            anchorB: [0, 0, 0],
            axis: [0, 1, 0],
            limits: { min: -2.2, max: 2.2 },
          },
        },
      },
    },
    {
      op: "add-entity",
      id: "door-crate",
      entity: {
        name: "Door Knocker",
        parent: null,
        tags: ["prop"],
        components: {
          transform: { position: [4.1, 4.5, -5.8] },
          mesh: { source: { kind: "primitive", shape: "box", size: [1, 1, 1] } },
          rigidbody: {},
          collider: {},
        },
      },
    },
  );

  const { doc } = applyOps(createScene("street"), ops, registry);
  return doc;
}
