/**
 * Runnable demo of the document pipeline: ops -> scene doc -> prefab
 * expansion -> undo. Run with: pnpm -F @hitreg/core demo
 */
import {
  applyOps,
  AssetLibrary,
  childrenOf,
  ComponentRegistry,
  createScene,
  expandScene,
  registerCoreComponents,
  type Op,
  type SceneDoc,
} from "../src/index.js";

const registry = new ComponentRegistry();
registerCoreComponents(registry);
const assets = new AssetLibrary();

// -- 1. define a prefab (the React-component analogue) -----------------------

assets.addPrefab("prefab-streetlight", {
  version: 1,
  name: "Streetlight",
  root: "pole",
  entities: {
    pole: {
      name: "Pole",
      parent: null,
      tags: ["streetlight"],
      components: {
        transform: {},
        mesh: { source: { kind: "primitive", shape: "cylinder", size: [0.2, 4, 0.2] } },
      },
    },
    lamp: {
      name: "Lamp",
      parent: "pole",
      tags: [],
      components: {
        transform: { position: [0, 4, 0], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
        light: { kind: "point" },
      },
    },
  },
  props: {
    lightColor: { default: "#ffcc88", bindings: ["lamp/components/light/color"] },
  },
});

// -- 2. build the scene with one atomic ops batch -----------------------------
// (this is exactly what an AI apply_ops tool call will look like)

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
        mesh: { source: { kind: "primitive", shape: "plane", size: [40, 1, 8] }, static: true },
      },
    },
  },
  ...[-10, 0, 10].map((x, i): Op => ({
    op: "add-entity",
    id: `light-${i}`,
    entity: {
      name: `Streetlight ${i + 1}`,
      parent: "ground",
      tags: [],
      components: {
        transform: { position: [x, 0, 3] },
        prefab: {
          prefabId: "prefab-streetlight",
          ...(i === 1
            ? { props: { lightColor: "#ff3300" }, overrides: [{ path: "lamp/components/light/intensity", value: 3 }] }
            : {}),
        },
      },
    },
  })),
];

const t0 = performance.now();
const { doc, inverse } = applyOps(createScene("street"), ops, registry);
const expanded = expandScene(doc, assets, registry);
const ms = (performance.now() - t0).toFixed(2);

// -- 3. show the results ------------------------------------------------------

function printTree(scene: SceneDoc, parent: string | null = null, depth = 0): void {
  for (const id of childrenOf(scene, parent)) {
    const e = scene.entities[id]!;
    const light = e.components["light"] as { color?: string; intensity?: number } | undefined;
    const detail = light ? `  (light ${light.color}, intensity ${light.intensity})` : "";
    console.log(`${"  ".repeat(depth)}- ${e.name} [${id}]${detail}`);
    printTree(scene, id, depth + 1);
  }
}

console.log(`\nCollapsed source doc: ${Object.keys(doc.entities).length} entities (what the AI reads/writes)`);
printTree(doc);

console.log(`\nExpanded runtime scene: ${Object.keys(expanded.entities).length} entities (what the renderer will draw)`);
printTree(expanded);

console.log(`\napplyOps + expandScene took ${ms}ms (budget: <50ms)`);

// -- 4. undo is free: the inverse batch restores the empty scene ---------------

const { doc: undone } = applyOps(doc, inverse, registry);
console.log(`After undo: ${Object.keys(undone.entities).length} entities\n`);
