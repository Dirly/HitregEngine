// dress apply / dress retag: which POI a dressing plan dresses, and the set-tags ops for dressing installed untagged.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyOps, ComponentRegistry, registerCoreComponents } from "@hitreg/core";
import { dressPoiId, poiJobIds, retagOps } from "../tools/_dress-poi.mts";

test("dressPoiId: --poi, then the site socket source's job, then the longest <poi>-<area> plan id prefix", () => {
  const jobIds = ["crone-beads", "fen-isle", "fen-isle-s", "weep-hole-door"];
  assert.equal(dressPoiId({ planId: "crone-beads-lantern-head", jobIds }), "crone-beads");
  assert.equal(dressPoiId({ planId: "fen-isle-s-tf-north", jobIds }), "fen-isle-s"); // longest match, not fen-isle
  assert.equal(dressPoiId({ planId: "weep-hole-door", jobIds }), "weep-hole-door");
  assert.equal(dressPoiId({ planId: "yard-a", mapSource: "projects/x/authoring/zonegen/w/zones/z/pois/fen-isle handoff (site yard, measured on scene w)", jobIds }), "fen-isle");
  assert.equal(dressPoiId({ planId: "yard-a", mapSource: "C:/scratch/cb/crone-beads handoff (site yard, measured on scene h1beads)", jobIds }), "crone-beads");
  assert.equal(dressPoiId({ planId: "crone-beads-x", flag: "other", jobIds }), "other");
  assert.equal(dressPoiId({ planId: "tavern-cellar", jobIds }), null);
  assert.equal(dressPoiId({ planId: "crone-beadsX", jobIds }), null); // a prefix must end at a dash
});

test("poiJobIds lists zonegen job dirs; retagOps tags a plan's entities once and never steals another poi's", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dress-poi-"));
  for (const j of ["w/zones/a/pois/crone-beads", "w/zones/b/pois/fen-isle-s"]) fs.mkdirSync(path.join(dir, "authoring", "zonegen", j), { recursive: true });
  assert.deepEqual(poiJobIds(dir), ["crone-beads", "fen-isle-s"]);
  const ents = {
    g: { parent: null, tags: ["dressing", "dress:crone-beads-yard"], components: { transform: {} } },
    i: { parent: "g", tags: ["dressing", "dress:crone-beads-yard"], components: { transform: {} } },
    done: { parent: "g", tags: ["dressing", "dress:crone-beads-yard", "poi:crone-beads"], components: { transform: {} } },
    stolen: { parent: null, tags: ["dressing", "dress:crone-beads-yard", "poi:elsewhere"], components: { transform: {} } },
    other: { parent: null, tags: ["dressing", "dress:fen-isle-s-tf"], components: { transform: {} } },
  };
  const r = retagOps(ents, "crone-beads-yard", "crone-beads");
  assert.deepEqual(r.ops.map((o) => o.id), ["g", "i"]);
  assert.deepEqual(r.conflicts, ["stolen"]);
  const reg = new ComponentRegistry(); registerCoreComponents(reg);
  const { doc, inverse } = applyOps({ version: 1, entities: ents } as never, r.ops, reg);
  const out = (doc as unknown as { entities: typeof ents }).entities;
  assert.deepEqual(out.i.tags, ["dressing", "dress:crone-beads-yard", "poi:crone-beads"]);
  assert.equal(retagOps(out, "crone-beads-yard", "crone-beads").ops.length, 0); // idempotent
  assert.equal(inverse.length, 2);
});
