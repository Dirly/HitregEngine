import { describe, expect, it } from "vitest";
import {
  partitionScene,
  chunkLocalToWorld,
  chunkToSceneDoc,
  registerCoreComponents,
  registerChunkComponents,
  validateScene,
  ComponentRegistry,
  type SceneDoc,
} from "../src/index.js";

function scene(entities: SceneDoc["entities"]): SceneDoc {
  return { version: 1, name: "world", entities };
}

const pos = (e: SceneDoc["entities"][string]): number[] =>
  (e.components["transform"] as { position: number[] }).position;

describe("partitionScene", () => {
  it("keeps globals in the scene and routes spatial entities to their cells", () => {
    const src = scene({
      cam: { name: "Cam", parent: null, tags: [], components: { transform: { position: [0, 5, 0] }, camera: {} } },
      sky: { name: "Sky", parent: null, tags: [], components: { sky: { top: "#fff", bottom: "#eee" } } },
      manager: { name: "Mgr", parent: null, tags: [], components: { script: { name: "spawner", params: {} } } },
      house: { name: "House", parent: null, tags: ["static"], components: { transform: { position: [200, 0, 40] } } },
      rock: { name: "Rock", parent: null, tags: [], components: { transform: { position: [-30, 0, -10] } } },
    });

    const { scene: residual, chunks, warnings } = partitionScene(src, { cellSize: 160 });
    expect(warnings).toEqual([]);

    // globals stay (camera has a transform but is global; sky/manager lack a spatial role)
    expect(Object.keys(residual.entities).sort()).toEqual(["cam", "manager", "sky"]);

    // house at x=200,z=40 → cell (round(200/160), round(40/160)) = (1, 0)
    expect(chunks.has("1_0")).toBe(true);
    // rock at x=-30,z=-10 → cell (0, 0)
    expect(chunks.has("0_0")).toBe(true);

    // rebased so world position is preserved
    const house = chunks.get("1_0")!.entities["house"]!;
    expect(chunkLocalToWorld(pos(house) as [number, number, number], 1, 0, 160)).toEqual([200, 0, 40]);
    const rock = chunks.get("0_0")!.entities["rock"]!;
    expect(chunkLocalToWorld(pos(rock) as [number, number, number], 0, 0, 160)).toEqual([-30, 0, -10]);
  });

  it("moves a spatial entity's whole subtree together, child transforms untouched", () => {
    const src = scene({
      tower: { name: "Tower", parent: null, tags: [], components: { transform: { position: [500, 0, 500] } } },
      flag: { name: "Flag", parent: "tower", tags: [], components: { transform: { position: [0, 12, 0] } } },
    });
    const { chunks } = partitionScene(src, { cellSize: 100 });
    // tower → cell (5,5)
    const cell = chunks.get("5_5")!;
    expect(Object.keys(cell.entities).sort()).toEqual(["flag", "tower"]);
    expect(cell.entities["flag"]!.parent).toBe("tower"); // parent preserved
    expect(pos(cell.entities["flag"]!)).toEqual([0, 12, 0]); // child stays local to parent
    expect(chunkLocalToWorld(pos(cell.entities["tower"]!) as [number, number, number], 5, 5, 100)).toEqual([500, 0, 500]);
  });

  it("honors a custom isGlobal classifier", () => {
    const src = scene({
      a: { name: "A", parent: null, tags: ["keep"], components: { transform: { position: [400, 0, 0] } } },
      b: { name: "B", parent: null, tags: [], components: { transform: { position: [400, 0, 0] } } },
    });
    // keep anything tagged "keep" in the scene, even though it's spatial
    const { scene: residual, chunks } = partitionScene(src, {
      cellSize: 160,
      isGlobal: (_id, e) => e.tags.includes("keep"),
    });
    expect(Object.keys(residual.entities)).toEqual(["a"]);
    expect(chunks.get("3_0")!.entities["b"]).toBeDefined(); // 400/160 rounds to 3
  });

  it("warns when a spatial entity has no position and routes it to cell 0_0", () => {
    const src = scene({
      blob: { name: "Blob", parent: null, tags: [], components: { transform: {} } },
    });
    const { chunks, warnings } = partitionScene(src, { cellSize: 160 });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("blob");
    expect(chunks.get("0_0")!.entities["blob"]).toBeDefined();
  });

  it("produces chunks that re-expand into valid scene fragments", () => {
    const src = scene({
      sky: { name: "Sky", parent: null, tags: [], components: { sky: { top: "#abc", bottom: "#def" } } },
      pillar: { name: "Pillar", parent: null, tags: ["static"], components: { transform: { position: [320, 0, -160] }, mesh: { source: { kind: "primitive", shape: "box" } } } },
    });
    const { chunks } = partitionScene(src, { cellSize: 160 });
    const registry = new ComponentRegistry();
    registerCoreComponents(registry);
    registerChunkComponents(registry);
    // pillar → cell (2,-1); re-root it and confirm the fragment validates
    const { doc } = chunkToSceneDoc("w", 2, -1, 160, chunks.get("2_-1")!);
    expect(validateScene(doc, registry)).toEqual([]);
  });
});
