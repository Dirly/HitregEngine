import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CONCEPT_TOOL, groundFingerprint, movedParts, ownership, restampManifest, stampOf } from "../../../tools/poi-review/concept-site.mjs";

// L o-gates 2026-10-30: NOT_GROUND gained the plant/paint keys and every stamp hashed with the old key set could never
// match again. restamp rewrites a stamp with the current function (logging a dated ruling), and new stamps carry parts.
function site(recipe: unknown, fingerprint: string | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "concept-restamp-"));
  fs.writeFileSync(path.join(dir, "world.json"), JSON.stringify(recipe));
  const reservation = { center: [0, 0], radius: 40, terrainRadius: 60 };
  const file = path.join(dir, "gate.site.json");
  fs.writeFileSync(file, JSON.stringify({ tool: CONCEPT_TOOL, version: 1, poi: "gate", project: "p", reservation, worldFile: "world.json", ownership: ownership("gate"), fingerprint, renderedAt: "2026-10-30T18:00:00Z", renders: {} }));
  return { dir, file, reservation };
}
const recipe = { seed: 1, scatter: [{ id: "grass" }], features: { blobs: [{ id: "near", center: [10, 0, 10], radius: 5 }, { id: "far", center: [900, 0, 900], radius: 5 }] } };

test("TOOLS-CONCEPT-RESTAMP: a stamp from an old key set is rewritten with the ruling logged, never re-rendered", () => {
  const { dir, file, reservation } = site(recipe, "an-old-key-set-hash");
  assert.throws(() => restampManifest(file, "ground unchanged", dir), /dated ruling/);
  const r = restampManifest(file, "2026-10-30 coordinator: NOT_GROUND gained plant/paint keys", dir, new Date("2026-10-30T22:00:00Z"));
  assert.equal(r.changed, true);
  const m = JSON.parse(fs.readFileSync(file, "utf8")), fp = groundFingerprint(recipe, { center: reservation.center as [number, number], radius: 60 }, ownership("gate"));
  assert.equal(m.fingerprint, fp.hash);
  assert.deepEqual(m.fingerprintParts, fp.parts);
  assert.deepEqual(m.restamps, [{ at: "2026-10-30T22:00:00.000Z", ruling: "2026-10-30 coordinator: NOT_GROUND gained plant/paint keys", old: "an-old-key-set-hash", new: fp.hash }]);
  assert.deepEqual(m.renders, {}, "the renders are untouched");
  // a second restamp on a current stamp writes nothing
  assert.equal(restampManifest(file, "2026-10-30 coordinator: again", dir).changed, false);
});

test("TOOLS-CONCEPT-RESTAMP: per-part hashes name what moved; plants and paint never move the stamp", () => {
  const center: [number, number] = [0, 0], fp = groundFingerprint(recipe, { center, radius: 60 }, ownership("gate"));
  const m = stampOf(fp);
  // a plant write (scatter) is not ground
  assert.equal(groundFingerprint({ ...recipe, scatter: [] }, { center, radius: 60 }, ownership("gate")).hash, fp.hash);
  // a feature far away is not under the reservation
  const far = { ...recipe, features: { blobs: [recipe.features.blobs[0], { id: "far", center: [900, 0, 900], radius: 9 }] } };
  assert.equal(groundFingerprint(far, { center, radius: 60 }, ownership("gate")).hash, fp.hash);
  // a feature under it moves the near part only; a global ground field moves the global part only
  const near = { ...recipe, features: { blobs: [{ id: "near", center: [10, 0, 10], radius: 8 }, recipe.features.blobs[1]] } };
  assert.deepEqual(movedParts(m, groundFingerprint(near, { center, radius: 60 }, ownership("gate"))), ["the features under the reservation"]);
  assert.deepEqual(movedParts(m, groundFingerprint({ ...recipe, seed: 2 }, { center, radius: 60 }, ownership("gate"))), ["the global ground fields"]);
  // an old stamp without parts names nothing
  assert.deepEqual(movedParts({ fingerprint: "x" }, fp), []);
});

test("TOOLS-CONCEPT-RESTAMP: world order hashes a site manifest without its stamp, so a restamp never stales bare-renders", async () => {
  const { evidenceSha } = await import("../tools/world-order.mts");
  const { dir, file } = site(recipe, "an-old-key-set-hash");
  const before = evidenceSha(file);
  restampManifest(file, "2026-10-30 coordinator: key-set change", dir);
  assert.equal(evidenceSha(file), before);
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...m, renders: { approach: { file: "a.site.png", sha256: "x" } } }));
  assert.notEqual(evidenceSha(file), before, "a changed render still stales it");
});
