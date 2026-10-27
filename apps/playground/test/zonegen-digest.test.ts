import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { digest, digestMatches, DIGEST_VERSION } from "../tools/zonegen/lib.mts";

/** A world bestiary + cast + zone bestiary on disk, and the Paths digest() reads. */
function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "zg-digest-"));
  const p = {
    projectDir: dir, recipe: path.join(dir, "recipe.json"), bestiary: path.join(dir, "bestiary.json"), cast: path.join(dir, "cast.json"),
    zoneBestiary: (z: string) => path.join(dir, `${z}-bestiary.json`), reservations: (z: string) => path.join(dir, `${z}-res.json`),
  } as never as Parameters<typeof digest>[0];
  const wolf = { id: "wolf", name: "Wolf", family: "wolf", kind: "wildlife", body: { model: "", status: "needs-install", source: "x/wolf.glb" }, themes: [{ id: "grey", atlas: "", status: "needs-art", source: "" }], roles: ["melee"], abilities: [], habitats: ["forest"], level: [1, 5], template: "", notes: "" };
  const best = { version: 1, creatures: [wolf], factions: [] as unknown[] };
  fs.writeFileSync(path.join(dir, "cast.json"), JSON.stringify({ world: "w", rules: {}, rows: [{ zone: "z", main: "" }] }));
  fs.writeFileSync(path.join(dir, "z-bestiary.json"), JSON.stringify({ groups: [{ creature: "wolf", theme: "grey" }] }));
  const put = () => fs.writeFileSync(p.bestiary as unknown as string, JSON.stringify(best));
  put();
  return { p, best, wolf, put, file: path.join(dir, "bestiary.json") };
}

test("zonegen digest v3: art landing in the bestiary never un-freezes a plan; planning edits still do", () => {
  const { p, wolf, put, file } = world();
  const zone0 = digest(p, file, "z"), world0 = digest(p, file, ""), v2 = digest(p, file, "z", 2);
  assert.equal(DIGEST_VERSION, 3);
  // MOB-2: the body installed, the theme painted (atlas row), a new painted theme no plan names, a template built
  wolf.body = { model: "creatures/wolf.glb", status: "ready", source: "" };
  wolf.themes = [{ id: "grey", atlas: "wolf-grey", status: "ready", source: "" }, { id: "ash", atlas: "wolf-ash", status: "ready", source: "" }];
  wolf.template = "mobs/wolf"; wolf.notes = "painted 10-21";
  put();
  assert.equal(digest(p, file, "z"), zone0, "zone plan: art only");
  assert.equal(digest(p, file, ""), world0, "world gates: art only");
  assert.equal(digestMatches(p, file, "z", zone0, 3), true);
  assert.equal(digestMatches(p, file, "z", v2, 2), false, "a v2 record counted art (why this changed)");
  // planning: the creature's level band or roles
  wolf.level = [3, 8];
  put();
  assert.notEqual(digest(p, file, "z"), zone0);
  assert.notEqual(digest(p, file, ""), world0);
});

test("zonegen digest: a v2 record still matches while the file is unchanged (no forced re-freeze)", () => {
  const { p, file } = world();
  const v2 = digest(p, file, "z", 2);
  assert.equal(digestMatches(p, file, "z", v2, 2), true);
  assert.equal(digestMatches(p, file, "z", v2), true, "no version recorded: any version still read");
  assert.equal(digestMatches(p, file, "z", v2, 1), false);
});
