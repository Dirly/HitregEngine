import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportGame } from "../tools/export-game.mjs";
import { bundleAssetReader } from "../src/bundle-reads.js";
import { assertPlayerModules } from "../tools/_player-boundary.mjs";

test("player builds reject editor code, thumbnail bakers and live authoring even through indirect imports", () => {
  for (const id of [
    "D:/Engine/packages/editor/src/mount.tsx",
    "D:\\Engine\\packages\\editor\\src\\overlay\\asset-inspector.tsx",
    "@hitreg/editor",
    "D:/Engine/apps/playground/src/main.ts",
    "D:/Engine/apps/playground/src/thumbnails.ts?import",
    "D:/Engine/apps/playground/src/thumbnail-cache.ts",
    "D:/Engine/apps/playground/src/dev-bridge.ts",
    "D:/Engine/apps/playground/src/live-sync.ts",
  ]) assert.throws(() => assertPlayerModules(["D:/Engine/apps/playground/src/play.ts", id]), /development tools/);
  assert.doesNotThrow(() => assertPlayerModules([
    "D:/Engine/apps/playground/src/play.ts", "D:/Engine/packages/render/src/scene-builder.ts",
    "D:/Engine/apps/playground/src/creation-preview.ts", "D:/Engine/apps/playground/src/impostor-bake.ts",
  ]));
});

test("published content includes transitive dependencies with owner precedence, bounded JSON packs and no unrelated project", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hitreg-export-"));
  const projects = path.join(tmp, "projects");
  const out = path.join(tmp, "game");
  const put = (file: string, data: unknown) => {
    const full = path.join(projects, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(data));
  };
  const originalFetch = globalThis.fetch;
  try {
    put("world/project.json", { dependsOn: ["kit"] });
    put("kit/project.json", { dependsOn: ["foundation"] });
    put("foundation/project.json", {});
    put("world/assets/scenes/world.scene.json", { name: "world" });
    put("world/assets/materials/shared.json", { source: "world" });
    put("kit/assets/materials/shared.json", { source: "kit" });
    put("foundation/assets/creation/player.json", { fromFoundation: true });
    put("foundation/assets/textures/player.png", "pixels");
    put("kit/assets/chunks/forest/0_0.chunk.json", { entities: {} });
    put("unrelated/assets/textures/private.png", "unrelated");
    put("world/assets/maps/world.base.png", "terrain");
    put("world/assets/maps/world.layers.json", { authoring: true });
    put("world/assets/loading/world.snapshot.png", "review");
    for (let i = 0; i < 130; i++) put(`kit/assets/prefabs/prop${i}.json`, { i });
    const result = exportGame({ projects, project: "world", entry: "world.scene.json", out });
    assert.deepEqual(result.scope, ["world", "kit", "foundation"]);
    assert.equal(result.packs, 3);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "content/materials/shared.json"), "utf8")), { source: "world" });
    assert.ok(fs.existsSync(path.join(out, "content/creation/player.json")));
    assert.ok(fs.existsSync(path.join(out, "content/chunks/forest/0_0.chunk.json")));
    assert.ok(!fs.existsSync(path.join(out, "content/textures/private.png")));
    assert.ok(!fs.existsSync(path.join(out, "content/maps/world.layers.json")));
    assert.ok(!fs.existsSync(path.join(out, "content/loading/world.snapshot.png")));
    const index = JSON.parse(fs.readFileSync(path.join(out, "assets-index.json"), "utf8"));
    let requests = 0;
    globalThis.fetch = (async (url) => { requests++; return new Response(fs.readFileSync(path.join(out, String(url)), "utf8")); }) as typeof fetch;
    const read = await bundleAssetReader(index, (p) => p);
    assert.deepEqual(await read("creation", "player.json"), { fromFoundation: true });
    assert.deepEqual(await read("prefabs", "prop129.json"), { i: 129 });
    assert.equal(requests, 3);
    // Invalid configuration must not clear the previous build or any project source.
    assert.throws(() => exportGame({ projects, project: "world", entry: "absent.scene.json", out }), /Entry scene/);
    assert.ok(fs.existsSync(path.join(out, "manifest.json")));
    assert.throws(() => exportGame({ projects, project: "world", entry: "world.scene.json", out: projects }), /Unsafe/);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("static pack loading is bounded and preserves per-file errors", async () => {
  const originalFetch = globalThis.fetch;
  let active = 0, peak = 0;
  try {
    globalThis.fetch = (async (url) => {
      peak = Math.max(peak, ++active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return new Response(JSON.stringify({ [`prefabs/${url}.json`]: url === "2" ? { error: "bad JSON" } : { data: url } }));
    }) as typeof fetch;
    const read = await bundleAssetReader({ "json-packs": Array.from({ length: 20 }, (_, i) => String(i)) }, (p) => p);
    assert.equal(peak, 4);
    assert.equal(await read("prefabs", "19.json"), "19");
    await assert.rejects(read("prefabs", "2.json"), /bad JSON/);
    await assert.rejects(read("prefabs", "missing.json"), /Missing packed asset/);
  } finally { globalThis.fetch = originalFetch; }
});
