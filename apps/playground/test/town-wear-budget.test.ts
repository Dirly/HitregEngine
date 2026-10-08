import { test } from "node:test";
import assert from "node:assert/strict";
import { skinnedFinding, wearFindings, SKINNED_BUDGET } from "../tools/zonegen/commands/town.mts";

const styles: Record<string, number> = { "run-down-port": 3, "gothic-ruin": 3, "gothic-stone": 0 };
const wearOf = (s: string): number | null => styles[s] ?? null;

test("an inhabited building refuses ruin-grade wear; a ruin or an empty one may have it", () => {
  const residents = [{ id: "fisher", home: "net-loft" }, { id: "smith", work: "forge" }];
  const found = wearFindings(
    [
      { id: "net-loft", style: "run-down-port" },
      { id: "forge", request: { style: "gothic-stone", wear: 3 } },
      { id: "old-chapel", style: "gothic-ruin" },
      { id: "squat", style: "run-down-port", abandoned: true },
      { id: "hall", style: "gothic-stone" },
    ],
    residents,
    wearOf,
  );
  assert.equal(found.length, 2);
  assert.match(found[0]!, /^net-loft: wear 3 \(style run-down-port\)/);
  assert.match(found[1]!, /^forge: wear 3 on an inhabited/);
});

test("skinned residents against the tier budget, or the plan's bodyCap", () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}` }));
  assert.equal(skinnedFinding("capital", many), SKINNED_BUDGET.capital >= 30 ? null : skinnedFinding("capital", many));
  assert.match(skinnedFinding("capital", many, 25)!, /30 skinned residents.*budget 25, the plan's bodyCap/);
  const ambient = many.map((r, i) => (i < 10 ? { ...r, body: "ambient" } : r));
  assert.equal(skinnedFinding("capital", ambient, 25), null);
  assert.ok(skinnedFinding("hamlet", many));
});
