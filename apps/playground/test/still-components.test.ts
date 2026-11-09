import { test } from "node:test";
import assert from "node:assert/strict";
import { ComponentRegistry, registerCoreComponents } from "@hitreg/core";
import { MOVING_COMPONENTS, STILL_COMPONENTS } from "../src/still-components.ts";

test("still components: every registered component is classified still or moving (a new one must be decided)", () => {
  const registry = new ComponentRegistry();
  registerCoreComponents(registry);
  const unclassified = registry.names().filter((n) => !STILL_COMPONENTS.has(n) && !MOVING_COMPONENTS.has(n));
  assert.deepEqual(unclassified, [], `classify in apps/playground/src/still-components.ts: ${unclassified.join(", ")}`);
  const both = [...STILL_COMPONENTS].filter((n) => MOVING_COMPONENTS.has(n));
  assert.deepEqual(both, []);
});

test("still components: authoring-only placement metadata never makes a building unbatchable", () => {
  for (const name of ["placeRule", "placement", "dressing", "mesh", "collider", "prefab"]) assert.ok(STILL_COMPONENTS.has(name), name);
  for (const name of ["script", "rigidbody", "animator"]) assert.ok(MOVING_COMPONENTS.has(name), name);
});
