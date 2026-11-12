import assert from "node:assert/strict";
import { test } from "node:test";
import { mergePins } from "../src/pin-merge.js";

const pin = (id: string, text: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({ id, text, createdAt: "2026-11-11T10:00:00.000Z", updatedAt, resolved: false, ...extra });

test("an agent posting an old copy does not erase notes written since", () => {
  const file = [pin("a", "first", "2026-11-11T10:00:00.000Z"), pin("b", "written after the agent read", "2026-11-11T10:05:00.000Z")];
  const agent = [pin("a", "first", "2026-11-11T10:00:00.000Z", { resolved: true, reply: "done" })];
  const out = mergePins(file, agent);
  assert.deepEqual(out.map((p) => p.id), ["a", "b"]);
  assert.equal((out[0] as any).resolved, true); assert.equal((out[0] as any).reply, "done");
});
test("the tab's later edit beats an agent's stale copy, but the agent's reply is kept", () => {
  const file = [pin("a", "edited by the human", "2026-11-11T10:09:00.000Z")];
  const agent = [pin("a", "old words", "2026-11-11T10:00:00.000Z", { resolved: true, reply: "moved it" })];
  const m = mergePins(file, agent)[0] as any; assert.equal(m.text, "edited by the human"); assert.equal(m.resolved, false); assert.equal(m.reply, "moved it");
});
test("the tab saving a copy from before the agent answered does not un-resolve the note", () => {
  const file = [pin("a", "x", "2026-11-11T10:02:00.000Z", { resolved: true, reply: "done" })];
  const tab = [pin("a", "x", "2026-11-11T10:00:00.000Z"), pin("c", "new", "2026-11-11T10:03:00.000Z")];
  const out = mergePins(file, tab);
  assert.equal((out[0] as any).resolved, true); assert.equal((out[0] as any).reply, "done");
  assert.equal(out[1]!.id, "c");
});
test("a note leaves only when it is named in deleted", () => {
  const file = [pin("a", "x", "2026-11-11T10:00:00.000Z"), pin("b", "y", "2026-11-11T10:00:00.000Z")];
  assert.equal(mergePins(file, [], []).length, 2);
  assert.deepEqual(mergePins(file, [file[0]!], ["b"]).map((p) => p.id), ["a"]);
});
