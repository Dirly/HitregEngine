import { test } from "node:test";
import assert from "node:assert/strict";
import { ungatedBaseUnits } from "../src/ground-gate.ts";

{
  const doc = {
    entities: {
      world: { parent: null, components: { voxelWorld: {} } },
      ocean: { parent: null, tags: ["water"], components: { transform: {}, mesh: {} } },
      player: { parent: null, tags: ["player"], components: { transform: {}, prefab: {} } },
      "poi-camp": { parent: null, tags: ["poi"], components: { transform: {} } },
      "camp-tent": { parent: "poi-camp", components: { transform: {}, prefab: {} } },
      town: { parent: null, tags: ["town:t1"], components: { transform: {} } },
      chapel: { parent: "town", tags: ["town-building:t1"], components: { transform: {}, prefab: {} } },
      "chapel-roof": { parent: "chapel", components: { transform: {}, mesh: {} } },
      wall: { parent: "town", components: { transform: {}, mesh: {} } },
      interior: { parent: "town", components: { transform: {}, culling: { interior: true } } },
      cart: { parent: "town", components: { transform: {}, prefab: {}, script: {} } },
      rock: { parent: null, components: { transform: {}, mesh: {} } },
      hud: { parent: null, components: { script: {} } },
    },
  };
  // cull roots as cullRootsOf would find them: the poi and the culling entity
  const cullRootOf = new Map([["poi-camp", "poi-camp"], ["camp-tent", "poi-camp"], ["interior", "interior"]]);
  const still = (id: string) => id !== "cart" && id !== "hud";

  test("ground gate: gates each still child of a root no culling root covers, and childless still meshes", () => {
    assert.deepEqual(ungatedBaseUnits(doc, cullRootOf, still).sort(), ["chapel", "rock", "wall"]);
  });
  test("ground gate: leaves POIs (already units), moving things, the player, the ocean and the world alone", () => {
    const out = ungatedBaseUnits(doc, cullRootOf, still);
    for (const id of ["poi-camp", "camp-tent", "interior", "cart", "player", "ocean", "world", "hud", "chapel-roof"]) assert.ok(!out.includes(id), id);
  });
}
