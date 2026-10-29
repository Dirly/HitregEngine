import { test } from "node:test";
import assert from "node:assert/strict";
import { changedShare, showVerdict } from "../tools/_shot-shows.mts";
import { veilFacesBack, portalVeilOps, VEIL_TURN, VEIL_TURN_BACK } from "../tools/_portal-veil-ops.mts";

test("changedShare counts pixels past the delta", () => {
  const a = new Uint8Array([10, 10, 10, 50, 50, 50]), b = new Uint8Array([11, 10, 10, 90, 50, 50]);
  assert.equal(changedShare(a, b, 3), 0.5);
});

test("showVerdict: out of frame, unchanged and shown", () => {
  assert.equal(showVerdict("v", null, 0).ok, false);
  assert.equal(showVerdict("v", { x0: 0, y0: 0, x1: 10, y1: 10, share: 0.3 }, 0.9).ok, false);
  assert.match(showVerdict("v", { x0: 0, y0: 0, x1: 10, y1: 10, share: 1 }, 0.05).why, /facing away/);
  assert.equal(showVerdict("v", { x0: 0, y0: 0, x1: 10, y1: 10, share: 1 }, 0.6).ok, true);
});

const doc = (rot: number[], anchorZ: number) => ({ version: 1, name: "t", entities: {
  door: { name: "door", parent: "root", tags: [], components: { transform: { position: [0, 3, -5], rotation: rot, scale: [1, 1, 1] }, script: { name: "portal", params: { mode: "trigger", returnAnchor: "back", halfExtents: [2, 3, 0.75], offset: [0, 3, 0] } } } },
  back: { name: "back", parent: "root", tags: [], components: { transform: { position: [0, 3, anchorZ], rotation: [0, 0, 0, 1], scale: [1, 1, 1] } } },
} }) as any;

test("the veil faces the way-out side (the return anchor)", () => {
  // the Wristgate door: yawed 180, return anchor 3.5 m in front of the door (landmark +z) = portal-local -z
  assert.equal(veilFacesBack(doc([0, 1, 0, 0], -1.5), "door", doc([0, 1, 0, 0], -1.5).entities.door.components.script.params), true);
  assert.equal(veilFacesBack(doc([0, 0, 0, 1], -1.5), "door", doc([0, 0, 0, 1], -1.5).entities.door.components.script.params), false);
  const d = doc([0, 1, 0, 0], -1.5), add = portalVeilOps(d, "t", {}).ops.find((o: any) => o.op === "add-entity") as any;
  assert.deepEqual(add.entity.components.transform.rotation, VEIL_TURN_BACK);
  const d2 = doc([0, 0, 0, 1], -1.5), add2 = portalVeilOps(d2, "t", {}).ops.find((o: any) => o.op === "add-entity") as any;
  assert.deepEqual(add2.entity.components.transform.rotation, VEIL_TURN);
});

test("a return portal never falls back to a lab scene or one outside the closure", async () => {
  const { returnSceneFault } = await import("../tools/_portal-veil-ops.mts");
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const pg = fs.mkdtempSync(path.join(os.tmpdir(), "ret-"));
  const mk = (p: string, deps: string[], scene: string, extra: object = {}) => {
    fs.mkdirSync(path.join(pg, "projects", p, "assets", "scenes"), { recursive: true });
    fs.writeFileSync(path.join(pg, "projects", p, "project.json"), JSON.stringify({ name: p, dependsOn: deps, ...extra }));
    fs.writeFileSync(path.join(pg, "projects", p, "assets", "scenes", `${scene}.scene.json`), "{}");
  };
  mk("world", [], "world"); mk("pb-lab", ["world", "halls"], "pblab"); mk("halls", ["world"], "halls"); mk("other", [], "other");
  assert.match(returnSceneFault(pg, "halls", "pblab")!, /lab/);
  assert.match(returnSceneFault(pg, "halls", "other")!, /closure/);
  assert.equal(returnSceneFault(pg, "halls", "world"), null);
  fs.rmSync(pg, { recursive: true, force: true });
});
