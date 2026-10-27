import { test } from "node:test";
import assert from "node:assert/strict";
import { materialFamilyFinding, meshMaterials, STONE_NAME, type PrefabLike } from "../tools/_material-family.mts";

const docs: Record<string, PrefabLike> = {
  "ruin-props/column-octagonal": { props: { material: { default: "ruin-props/carved-stone", bindings: ["piece/components/mesh/material"] } }, entities: { root: {}, piece: { components: { mesh: { material: "ruin-props/carved-stone" } } } } },
  "ruin-props/column-toppled": { props: { material: { default: "ruin-props/carved-stone", bindings: ["art/components/prefab/props/material"] } }, entities: { root: {}, art: { components: { prefab: { prefabId: "ruin-props/column-octagonal" } } } } },
  "old/stone-urn": { entities: { root: {}, a: { components: { mesh: { material: "old/urn-stone" } } } } },
  "house-interior/coffin": { entities: { root: {}, a: { components: { mesh: { material: "house-interior/wood" } } } } },
};
const load = (id: string) => docs[id] ?? null;
const isStone = (m: string) => STONE_NAME.test(m);

test("material-family: nested prefabs are followed to their mesh materials", () => {
  assert.deepEqual(meshMaterials("ruin-props/column-toppled", load), ["ruin-props/carved-stone"]);
});

test("material-family: foreign stone without a swap is a violation naming the palette", () => {
  const v = materialFamilyFinding({ id: "col", prop: "ruin-props/column-toppled" }, load, isStone, "weep-hole/", "weep-hole/dc-palette");
  assert.equal(v?.code, "material-family");
  assert.match(v!.message, /weep-hole\/dc-palette/);
});

test("material-family: the instance swap to the dungeon's palette passes; a swap to another family does not", () => {
  assert.equal(materialFamilyFinding({ id: "col", prop: "ruin-props/column-toppled", props: { material: "weep-hole/dc-palette" } }, load, isStone, "weep-hole/", "weep-hole/dc-palette"), null);
  assert.ok(materialFamilyFinding({ id: "col", prop: "ruin-props/column-toppled", props: { material: "tipped-kirk/dc-palette" } }, load, isStone, "weep-hole/", "weep-hole/dc-palette"));
});

test("material-family: a stone prop with no material prop says so; non-stone props are left alone", () => {
  assert.match(materialFamilyFinding({ id: "u", prop: "old/stone-urn" }, load, isStone, "weep-hole/", "weep-hole/dc-palette")!.message, /declares no "material" prop/);
  assert.equal(materialFamilyFinding({ id: "c", prop: "house-interior/coffin" }, load, isStone, "weep-hole/", "weep-hole/dc-palette"), null);
});
