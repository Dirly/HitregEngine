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
        tags: ["prop", "spin"],
        components: {
          transform: { position: [i * 4 - 8, 0.5, -3] },
          mesh: { source: { kind: "primitive", shape: "box", size: [1, 1, 1] } },
        },
      },
    })),
  ];

  const { doc } = applyOps(createScene("street"), ops, registry);
  return doc;
}
