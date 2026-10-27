import { test } from "node:test";
import assert from "node:assert/strict";
import { characterCreationSchema, dressCharacter } from "@hitreg/core";
import { selectionEquipment } from "../src/selection-equipment.js";

test("selection dresses saved armor rather than a creation preview outfit, loading only worn items", async () => {
  const reads: string[] = [];
  const wear = await selectionEquipment({ chest: "vanguard-chest", legs: "ranger-legs", bag: "satchel" }, async (id) => {
    reads.push(id);
    return { name: id, ...(id === "satchel" ? {} : { appearance: { model: "body.glb", parts: [id.endsWith("chest") ? "chest" : "legs"], texture: `${id}.png` } }) };
  });
  assert.deepEqual(reads.sort(), ["ranger-legs", "satchel", "vanguard-chest"]);
  const creation = characterCreationSchema.parse({ model: "body.glb", archetypes: [{ id: "brawn", name: "Brawn" }], traitPicks: 0, appearance: [
    { id: "outfit", label: "Outfit", preview: true, options: [{ id: "robe", label: "Robe", model: "body.glb", parts: ["chest", "legs"], texture: "robe.png" }] },
  ] });
  const dressed = dressCharacter({ creation, appearance: { outfit: "robe" }, items: wear });
  assert.deepEqual(dressed.models.get("body.glb")?.groups, [
    { parts: ["chest"], texture: "vanguard-chest.png" },
    { parts: ["legs"], texture: "ranger-legs.png" },
  ]);
});

test("a two-handed primary excludes the offhand and the spare weapon from the selection look", async () => {
  const wear = await selectionEquipment({ primary: "greatsword", secondary: "axe", offhand: "shield" }, async (id) => ({
    name: id, twoHanded: id === "greatsword", appearance: { model: `${id}.glb`, parts: ["all"] },
  }));
  assert.deepEqual(wear, [{ model: "greatsword.glb", parts: ["all"], texture: null }]);
});

test("empty equipment draws no fake starter kit and fetches nothing", async () => {
  assert.deepEqual(await selectionEquipment({}, async () => assert.fail("nothing is worn")), []);
});
