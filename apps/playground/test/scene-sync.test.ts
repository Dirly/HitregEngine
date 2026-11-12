import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { editScene, releaseEdits, stableId, syncScene } from "../tools/_scene-sync.mts";
import { recordOwnerEdits } from "../tools/_owner-edit-bridge.mts";

// activity heartbeats of these tests go to a temp folder, never the dev server's
process.env["HITREG_ACTIVITY_DIR"] = fs.mkdtempSync(path.join(os.tmpdir(), "agent-activity-"));
/** A projects root with project `t` (project.json) and an empty scene folder. */
function fixture(): { root: string; scene: string; record: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "scene-sync-"));
  fs.mkdirSync(path.join(root, "t", "assets", "scenes"), { recursive: true });
  fs.writeFileSync(path.join(root, "t", "project.json"), JSON.stringify({ name: "t" }));
  return { root, scene: path.join(root, "t", "assets", "scenes", "s.scene.json"), record: path.join(root, "t", "authoring", "owner-overrides", "s.json") };
}
const tf = (p: number[]) => ({ position: p, rotation: [0, 0, 0, 1], scale: [1, 1, 1] });
const ops = (crateX = 1) => [
  { op: "add-entity", id: "hall", entity: { name: "hall", parent: null, tags: [], components: { transform: tf([0, 0, 0]) } } },
  { op: "add-entity", id: stableId("hall", "crate", 1), entity: { name: "crate", parent: "hall", tags: [], components: { transform: tf([crateX, 0, 0]), mesh: { source: { kind: "primitive", shape: "box", size: [1, 1, 1] } } } } },
  { op: "add-entity", id: stableId("hall", "lamp"), entity: { name: "lamp", parent: "hall", tags: [], components: { transform: tf([0, 3, 0]), light: { kind: "point", color: "#ffaa55", intensity: 4, range: 8 } } } },
] as never[];
const read = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"));

test("syncScene: creates, re-runs with zero ops and no write, a one-prop change is one op, inverse saved", () => {
  const { root, scene } = fixture();
  const first = syncScene({ scene, builder: "build", target: ops(), print: false });
  assert.equal(first.counts.add, 3);
  assert.ok(first.written);
  const mtime = fs.statSync(scene).mtimeMs;
  const again = syncScene({ scene, builder: "build", target: ops(), print: false });
  assert.equal(again.ops.length, 0);
  assert.equal(again.written, false);
  assert.equal(fs.statSync(scene).mtimeMs, mtime);
  const one = syncScene({ scene, builder: "build", target: ops(2), print: false });
  assert.equal(one.ops.length, 1);
  assert.ok(fs.existsSync(path.join(root, "t", "authoring", "scene-sync", "s--build.inverse.json")));
  assert.ok(!fs.existsSync(scene + ".lock"));
});

/** The owner moves the crate in the editor: the editor writes the scene, then POSTs the edit. */
function ownerMovesCrate(root: string, scene: string, to: [number, number, number]): void {
  const crateId = stableId("hall", "crate", 1);
  const doc = read(scene);
  const before = doc.entities[crateId].components.transform.position;
  doc.entities[crateId].components.transform.position = to;
  fs.writeFileSync(scene, JSON.stringify(doc, null, 2));
  recordOwnerEdits(root, { scene: "s", edits: [{ entity: crateId, tags: doc.entities[crateId].tags, name: "crate", parent: "hall", kind: ["mesh", "transform"], before: { pos: before, yaw: 0, scale: 1, components: {} }, after: { pos: to, yaw: 0, scale: 1, components: {} } }] });
}

test("owner > agent > generator: a rebuild keeps both; an agent edit of what the owner set is refused unless it names the note; his next edit wins again", () => {
  const { root, scene, record } = fixture();
  syncScene({ scene, builder: "build", target: ops(), print: false });
  const lampId = stableId("hall", "lamp"), crateId = stableId("hall", "crate", 1);
  ownerMovesCrate(root, scene, [1, 0, 5]);
  // an agent answers a note: the lamp is blue, and a rug is added (nobody generates it)
  const light = { ...read(scene).entities[lampId].components.light, color: "#3366ff" };
  const res = editScene({ scene, note: "pin 12: make it cold", ops: [
    { op: "set-component", id: lampId, component: "light", data: light },
    { op: "add-entity", id: "hall-rug", entity: { name: "rug", parent: "hall", tags: [], components: { transform: tf([2, 0, 2]), mesh: { source: { kind: "primitive", shape: "box", size: [2, 0.05, 1] } } } } },
  ] as never });
  assert.equal(res.recorded, 2);
  assert.deepEqual(res.overrodeOwner, []);
  const rec = () => read(record).overrides as { item: string; by: string; added: boolean; builder?: string; ownerProps?: string[]; overrodeOwner?: string[] }[];
  assert.deepEqual(rec().map((r) => [r.item, r.by, r.added, r.builder ?? null, r.ownerProps ?? null]), [[crateId, "owner", false, "build", ["pos"]], [lampId, "agent", false, "build", null], ["hall-rug", "agent", true, null, null]]);
  // the generator re-runs, and itself moved the crate and changed the lamp: neither edit is undone
  assert.equal(syncScene({ scene, builder: "build", target: ops(3), print: false }).ops.length, 0);
  const now = read(scene);
  assert.deepEqual(now.entities[crateId].components.transform.position, [1, 0, 5]);
  assert.equal(now.entities[lampId].components.light.color, "#3366ff");
  // the agent moves what the OWNER moved, without naming his note: refused, nothing written
  const text = fs.readFileSync(scene, "utf8");
  const moveTo = (p: number[]) => [{ op: "set-component", id: crateId, component: "transform", data: { ...read(scene).entities[crateId].components.transform, position: p } }] as never;
  assert.throws(() => editScene({ scene, ops: moveTo([1, 0, 6]) }), /REFUSED.*hall--crate-1: pos \(owner/);
  assert.equal(fs.readFileSync(scene, "utf8"), text);
  // ...but it may turn it (a property he did not set), and his move still holds
  const turn = [{ op: "set-component", id: crateId, component: "transform", data: { ...read(scene).entities[crateId].components.transform, rotation: [0, 0.7071, 0, 0.7071] } }] as never;
  assert.deepEqual(editScene({ scene, ops: turn }).overrodeOwner, []);
  assert.deepEqual(rec().find((r) => r.item === crateId)!.ownerProps, ["pos"]);
  // naming the note he left: applied, and reported as overriding his move
  const over = editScene({ scene, ops: moveTo([1, 0, 6]), answers: "pin-mwcm8v59: move it to the wall", print: false });
  assert.deepEqual(over.overrodeOwner, [{ entity: crateId, props: ["pos"] }]);
  let r = rec().find((x) => x.item === crateId)!;
  assert.deepEqual([r.by, r.ownerProps ?? null, r.overrodeOwner], ["agent", null, ["pos"]]);
  assert.equal(syncScene({ scene, builder: "build", target: ops(3), print: false }).ops.length, 0);
  // he moves it again: his edit wins again, and the agent is refused again
  ownerMovesCrate(root, scene, [2, 0, 2]);
  r = rec().find((x) => x.item === crateId)!;
  assert.deepEqual([r.by, r.ownerProps], ["owner", ["pos"]]);
  assert.throws(() => editScene({ scene, ops: moveTo([9, 0, 9]) }), /REFUSED/);
  // handing his edit back to the generator is an override too; the agent's own records are free to hand back
  assert.throws(() => releaseEdits({ scene, ids: [crateId] }), /REFUSED/);
  assert.equal(releaseEdits({ scene, ids: [lampId] }), 1);
  assert.equal(releaseEdits({ scene, ids: [crateId], answers: "pin-x: put it back where the builder had it" }), 1);
  syncScene({ scene, builder: "build", target: ops(3), print: false });
  assert.deepEqual(read(scene).entities[crateId].components.transform.position, [3, 0, 0]);
  assert.equal(read(scene).entities[lampId].components.light.color, "#ffaa55");
  assert.ok(read(scene).entities["hall-rug"]); // an added entity: nobody generates it, it stays
});

test("agent activity: a declared heartbeat shows, lapses by itself, and a sync or edit declares itself only while it runs", async () => {
  const { activeAgents, declareActivity } = await import("../tools/_agent-activity.mts");
  const { scene } = fixture();
  const a = declareActivity({ scene: "s", agent: "claude", what: "answering notes", ttlMs: 60_000, session: true });
  assert.deepEqual(activeAgents("s").map((x) => [x.agent, x.what, x.source]), [["claude", "answering notes", "declared"]]);
  assert.equal(activeAgents("s", null, Date.now() + 61_000).length, 0); // a crashed agent's warning lapses
  declareActivity({ scene: "s", agent: "claude", what: "answering notes", ttlMs: 60_000, session: true });
  a.done();
  assert.equal(activeAgents("s").length, 0);
  // a tool holding the scene lock counts while it holds it; the owner's own save does not
  fs.writeFileSync(scene, JSON.stringify({ name: "s", entities: {} }));
  fs.writeFileSync(scene + ".lock", JSON.stringify({ pid: process.pid, host: os.hostname(), label: "rustgut build", at: new Date().toISOString() }));
  assert.deepEqual(activeAgents("s", scene).map((x) => [x.agent, x.source]), [["rustgut build", "lock"]]);
  fs.writeFileSync(scene + ".lock", JSON.stringify({ pid: process.pid, host: os.hostname(), label: "dev-server write-asset", at: new Date().toISOString() }));
  assert.equal(activeAgents("s", scene).length, 0);
  fs.rmSync(scene + ".lock");
  syncScene({ scene, builder: "build", target: ops(), print: false });
  assert.equal(activeAgents("s", scene).length, 0); // done when the sync is done
  assert.equal(fs.readdirSync(process.env["HITREG_ACTIVITY_DIR"]!).length, 0);
});

test("notes are never touched: a sync, an edit, a release and a rekey leave every pins file byte-identical", () => {
  const { root, scene } = fixture();
  const pinFiles = [path.join(root, ".hitreg", "pins", "s.json"), path.join(root, "t", ".hitreg", "pins", "s.json"), path.join(path.dirname(scene), ".hitreg", "pins", "s.json")];
  const pins = JSON.stringify([{ id: "pin-1", point: [1, 0, 0], entityId: "crate-17", text: "move this", resolved: false, author: "human" }], null, 1);
  for (const f of pinFiles) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, pins); }
  syncScene({ scene, builder: "build", target: ops(), print: false });
  ownerMovesCrate(root, scene, [1, 0, 4]);
  editScene({ scene, ops: [{ op: "remove-entity", id: stableId("hall", "lamp") }] as never });
  syncScene({ scene, builder: "build", target: ops(2), print: false });
  releaseEdits({ scene, ids: [stableId("hall", "lamp")] });
  for (const f of pinFiles) assert.equal(fs.readFileSync(f, "utf8"), pins, f);
  // and none of the machinery can: no reference to the notes store at all
  for (const m of ["../tools/_scene-sync.mts", "../tools/_owner-edit-bridge.mts", "../tools/_agent-activity.mts", "../../../packages/core/src/scene-sync.ts"]) {
    const src = fs.readFileSync(new URL(m, import.meta.url), "utf8");
    assert.ok(!/\bpins?\b/i.test(src), `${m} mentions pins`);
  }
});

test("an owner delete holds; a whole-file rewrite that lost a hand-added entity gets it back", () => {
  const { root, scene } = fixture();
  syncScene({ scene, builder: "build", target: ops(), print: false });
  const crateId = stableId("hall", "crate", 1);
  editScene({ scene, by: "owner", ops: [{ op: "remove-entity", id: crateId }, { op: "add-entity", id: "my-box", entity: { name: "box", parent: "hall", tags: [], components: { transform: tf([4, 0, 4]), mesh: { source: { kind: "primitive", shape: "box", size: [1, 1, 1] } } } } }] as never });
  const doc = read(scene);
  delete doc.entities["my-box"]; // someone rewrote the file without it
  fs.writeFileSync(scene, JSON.stringify(doc));
  const r = syncScene({ scene, builder: "build", target: ops(), print: false });
  assert.deepEqual(r.edits.deleted, [crateId]);
  assert.deepEqual(r.edits.restored, ["my-box"]);
  const now = read(scene);
  assert.equal(now.entities[crateId], undefined);
  assert.deepEqual(now.entities["my-box"].components.transform.position, [4, 0, 4]);
  void root;
});
