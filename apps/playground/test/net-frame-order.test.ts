import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Gear (late scripts -> moving batches) and the contact patch copy a body's root when they run; a skinned body reads
// it at the draw. A network sample taken after them draws every worn piece one frame behind its own body.
test("the editor host samples the network before anything reads a body", () => {
  const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
  const at = (text: string): number => {
    const i = main.indexOf(text);
    assert.ok(i >= 0, text);
    return i;
  };
  const net = at("netPresence?.update(dt); // remote bodies");
  for (const reader of [
    "animations.update(dt, animationCamera",
    "scripts?.lateUpdate(dt)",
    "movingInstances.update(); // held weapons",
    "updateCharacterGrounding(animations.roots()",
  ]) assert.ok(net < at(reader), reader);
});
