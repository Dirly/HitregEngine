import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownerInfo, recordOwnerEdits } from "../tools/_owner-edit-bridge.mts";

/** A projects root with one project: a plan installed at --at 10,0,0 --yaw 90, its scene, a catalogued lantern. */
function fixture(withFrame: boolean): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "owner-edit-"));
  const p = path.join(root, "t");
  fs.mkdirSync(path.join(p, "authoring", "dressing", "plans"), { recursive: true });
  fs.mkdirSync(path.join(p, "assets", "scenes"), { recursive: true });
  const plans = path.join(p, "authoring", "dressing", "plans");
  fs.writeFileSync(path.join(plans, "yard.json"), JSON.stringify({ id: "yard", map: "yard", items: [{ id: "basket", prop: "props/basket", place: { kind: "floor", at: [1, 2] } }, { id: "crate", prop: "props/crate", place: { kind: "floor", at: [3, 0] } }] }));
  // map-local basket (1, 0.5, 2) and crate (3, 0, 0); --at 10,0,0 --yaw 90 puts them at (12, 0.5, 1) and (10, 0, -3)
  fs.writeFileSync(path.join(plans, "yard.report.json"), JSON.stringify({ plan: "yard", placements: [{ id: "basket", position: [1, 0.5, 2], yaw: 0 }, { id: "crate", position: [3, 0, 0], yaw: 0 }] }));
  if (withFrame) fs.writeFileSync(path.join(plans, "yard.inverse.json"), JSON.stringify({ plan: "yard", frame: { at: [10, 0, 0], yaw: 90 }, ops: [] }));
  const q = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  const ent = (id: string, pos: number[], prefab: string, tags: string[], name: string) => [id, { name, parent: "dress-yard-room-G-1", tags, components: { transform: { position: pos, rotation: q, scale: [1, 1, 1] }, prefab: { prefabId: prefab } } }];
  fs.writeFileSync(
    path.join(p, "assets", "scenes", "s.scene.json"),
    JSON.stringify({ name: "s", entities: Object.fromEntries([ent("dress-yard-basket", [12, 0.5, -1], "props/basket", ["dressing", "dress:yard"], "basket: props/basket"), ent("dress-yard-crate", [10, 0, -3], "props/crate", ["dressing", "dress:yard"], "crate: props/crate")]) }),
  );
  return root;
}

for (const withFrame of [true, false])
  test(`a dressed prop's edit lands on its plan in map-local metres (${withFrame ? "recorded" : "recovered"} frame)`, () => {
    const root = fixture(withFrame);
    const res = recordOwnerEdits(root, {
      scene: "s",
      edits: [
        { entity: "dress-yard-basket", tags: ["dressing", "dress:yard"], name: "basket: props/basket", parent: "dress-yard-room-G-1", before: { pos: [12, 0.5, -1], yaw: 90, scale: 1, prop: "props/basket" }, after: { pos: [12, 0, -1], yaw: 90, scale: 1, prop: "props/basket" } },
        { entity: "dress-yard-crate", tags: ["dressing", "dress:yard"], name: "crate: props/crate", parent: "dress-yard-room-G-1", before: { pos: [10, 0, -3], yaw: 90, scale: 1, prop: "props/crate" }, after: null },
        { entity: "dress-yard-owner-k1", tags: ["dressing", "dress:yard"], name: "owner-k1: props/crate", parent: "dress-yard-room-G-1", before: null, after: { pos: [10, 0, 0], yaw: 90, scale: 1, prop: "props/crate" } },
      ],
    });
    assert.deepEqual(res.map((r) => [r.item, r.reasons]), [["basket", ["floating"]], ["crate", ["deleted"]], ["owner-k1", ["added"]]]);
    const file = JSON.parse(fs.readFileSync(path.join(root, "t", "authoring", "dressing", "plans", "yard.owner.json"), "utf8"));
    const basket = file.overrides.find((o: { item: string }) => o.item === "basket");
    basket.set.pos.forEach((v: number, i: number) => assert.ok(Math.abs(v - [1, 0, 2][i]!) < 1e-3, `basket pos ${basket.set.pos}`));
    assert.ok(Math.abs(basket.set.yaw) < 1e-3);
    const added = file.overrides.find((o: { item: string }) => o.item === "owner-k1");
    assert.equal(added.entity, "dress-yard-owner-k1");
    assert.equal(added.room, "G-1");
    const info = ownerInfo(root, "s", "dress-yard-basket", ["dressing", "dress:yard"], "basket: props/basket");
    assert.equal(info.owner, "plan");
    assert.deepEqual(info.override?.reasons, ["floating"]);
  });

test("an installer's prop (no plan) lands in the scene's owner-overrides file", () => {
  const root = fixture(true);
  const [r] = recordOwnerEdits(root, { scene: "s", edits: [{ entity: "lantern-3", tags: [], before: { pos: [0, 3, 0], yaw: 0, scale: 1, prop: "fixtures/lantern" }, after: { pos: [0, 2.5, 0], yaw: 0, scale: 1, prop: "fixtures/lantern" } }] });
  assert.equal(r!.owner, "scene");
  const file = JSON.parse(fs.readFileSync(path.join(root, "t", "authoring", "owner-overrides", "s.json"), "utf8"));
  assert.equal(file.frame, "scene");
  assert.deepEqual(file.overrides[0].set.pos, [0, 2.5, 0]);
  assert.deepEqual(file.overrides[0].reasons, ["floating"]);
});
