import { test } from "node:test";
import assert from "node:assert/strict";
import { compositeFaults } from "../tools/_prop-composite-guard.mts";

const vocab = {
  scales: [{ id: "any" }, { id: "human" }, { id: "giant" }],
  cultures: [{ id: "any" }, { id: "civic", accepts: ["rural"] }, { id: "rural" }, { id: "crypt" }, { id: "goblin" }],
};
const decl: Record<string, { scale?: string; cultures?: string[] }> = {
  "kit/cart": { scale: "human", cultures: ["rural"] },
  "kit/lantern": { scale: "human", cultures: ["civic"] },
  "kit/urn": { scale: "human", cultures: ["crypt"] },
  "kit/log-bench": { scale: "giant", cultures: ["any"] },
  "kit/rock": { scale: "any", cultures: ["any"] },
};
const of = (id: string) => decl[id];

test("a composite of one culture and scale passes", () => {
  assert.deepEqual(compositeFaults({ parts: [{ prefab: "kit/cart" }, { prefab: "kit/lantern" }, { prefab: "kit/rock" }, {}] }, of, vocab), []);
});

test("mixing cultures or scales, or resizing a prop to stand in, is refused", () => {
  assert.match(compositeFaults({ parts: [{ prefab: "kit/cart" }, { prefab: "kit/urn" }] }, of, vocab).join(), /different cultures/);
  assert.match(compositeFaults({ parts: [{ prefab: "kit/cart" }, { prefab: "kit/log-bench" }] }, of, vocab).join(), /mix scale classes/);
  assert.match(compositeFaults({ parts: [{ prefab: "kit/cart", scale: 2 }] }, of, vocab).join(), /resized x2 to stand in/);
  assert.match(compositeFaults({ declare: { cultures: ["goblin"] }, parts: [{ prefab: "kit/lantern" }] }, of, vocab).join(), /the composite is goblin/);
  assert.match(compositeFaults({ declare: { scale: "giant" }, parts: [{ prefab: "kit/cart" }] }, of, vocab).join(), /the composite is giant-scale/);
});
