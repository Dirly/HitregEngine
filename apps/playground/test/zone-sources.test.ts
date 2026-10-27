import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { briefStories, storiesIntoRegions, zonegenPopulated, zoneStoriesMissing } from "../tools/_zone-sources.mts";

const project = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zone-sources-"));
  const z = (id: string) => path.join(dir, "authoring/zonegen/w/zones", id);
  for (const id of ["a", "b", "c"]) fs.mkdirSync(path.join(z(id), "populate"), { recursive: true });
  fs.writeFileSync(path.join(z("a"), "populate", "installed-w.json"), "{}");
  fs.writeFileSync(path.join(z("a"), "brief.json"), JSON.stringify({ premise: "The dead climb the gorge." }));
  fs.writeFileSync(path.join(z("b"), "brief.json"), JSON.stringify({ story: "Rust and iron.", premise: "x" }));
  return dir;
};

test("spawn row: a world whose zones carry installed zonegen populations is n/a", () => {
  const dir = project();
  assert.deepEqual(zonegenPopulated(dir, "w"), ["a"]);
  assert.deepEqual(zonegenPopulated(dir, "other"), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("zone-stories row reads the recipe or the zonegen brief; zonegen stories copies them in (idempotent, inverse)", () => {
  const dir = project();
  const briefs = briefStories(dir, "w");
  assert.deepEqual([...briefs], [["a", "The dead climb the gorge."], ["b", "Rust and iron."]]);
  const regions = [{ id: "a", story: "" }, { id: "b", story: "old" }, { id: "c", story: "" }, { id: "t", story: "", within: "a" }];
  assert.equal(zoneStoriesMissing(regions, new Map()), "2 of 3 zones have no story (recipe region or zonegen brief)");
  assert.equal(zoneStoriesMissing(regions, briefs), "1 of 3 zones have no story (recipe region or zonegen brief)"); // c untold
  const r1 = storiesIntoRegions(regions, briefs);
  assert.deepEqual(r1.changed, ["a", "b"]);
  assert.deepEqual(r1.inverse, { a: "", b: "old" });
  assert.equal(regions[1]!.story, "Rust and iron.");
  assert.deepEqual(storiesIntoRegions(regions, briefs).changed, []);    // idempotent
  fs.rmSync(dir, { recursive: true, force: true });
});
