// A dungeon door's veil must read as the way in, never as sky (portal-cover check 4, the First King's Door).
import { test } from "node:test";
import assert from "node:assert/strict";
import { veilFinish } from "../tools/_portal-veil-ops.mts";

test("an unresolved veil material fails: it draws as a grey card that reads as sky", () => {
  const r = veilFinish("hollow-bastion/zone-boundary", null);
  assert.equal(r.pass, false);
  assert.match(r.why, /closure/);
});
test("the portal swirl and a painted dark card pass", () => {
  assert.equal(veilFinish("x", { shader: "portal", color: "#63bfff" }).pass, true);
  assert.equal(veilFinish("skelmorrow/portal-dark-depth", { shader: "unlit", color: "#ffffff", map: "skelmorrow/portal-dark-depth.png" }).pass, true);
});
test("a light plain panel fails, a dark one passes", () => {
  assert.equal(veilFinish("x", { color: "#9aa0a8" }).pass, false);
  assert.equal(veilFinish("x", { color: "#141010" }).pass, true);
  assert.equal(veilFinish("x", { map: "sky/clouds.png" }).pass, false);
});
