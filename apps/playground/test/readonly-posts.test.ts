// Browser tests drop every dev-server POST except the read-only ones (tools/_readonly-posts.mjs): the list must cover
// every POST endpoint vite.config declares as a read, or the stubbed page loads no assets.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { READ_ONLY_POSTS, dropWrites } from "../tools/_readonly-posts.mjs";

test("every read-only POST endpoint in vite.config passes the browser tests' write stub", () => {
  const src = fs.readFileSync("vite.config.ts", "utf8");
  const posts = [...src.matchAll(/method: "POST", path: "([^"?]+)[^"]*", purpose: "([^"]*)"/g)].map((m) => ({ path: m[1]!, read: /^Read\b/.test(m[2]!) }));
  assert.ok(posts.some((p) => p.path === "/__hitreg/asset-json"), "the endpoint table lists asset-json");
  for (const p of posts) assert.equal(READ_ONLY_POSTS.test(`http://localhost:1${p.path}`), p.read || p.path === "/__hitreg/log", `${p.path} (read ${p.read})`);
});

test("the stub drops writes and lets reads through", () => {
  const seen: string[] = [];
  const route = (method: string, url: string) => ({ request: () => ({ method: () => method, url: () => url }), fulfill: () => seen.push(`drop ${url}`), continue: () => seen.push(`pass ${url}`) });
  dropWrites(route("POST", "http://x/__hitreg/asset-json?project=p"));
  dropWrites(route("POST", "http://x/__hitreg/write-asset"));
  dropWrites(route("GET", "http://x/__hitreg/asset-file?file=a"));
  assert.deepEqual(seen, ["pass http://x/__hitreg/asset-json?project=p", "drop http://x/__hitreg/write-asset", "pass http://x/__hitreg/asset-file?file=a"]);
});

// c-props2 (2026-10-29): a project shot script copied an older inline stub (`if (r.method() !== "GET") return
// route.fulfill(...)`), the batched asset-json read came back {"ok":true} and the lab boot died on "prefab
// codex-craft/... not found" although the dev server served the file. Every script that stubs dev-server writes, in
// the engine tools AND in project authoring folders (where shot scripts get copied), must go through READ_ONLY_POSTS.
test("no browser script stubs every non-GET dev-server request (the asset-json read must pass)", () => {
  const roots = ["tools", "../../tools", "projects"];
  const skip = /node_modules|[\/]\.git[\/]|[\/]assets[\/]|[\/]archive/;
  const files: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 8 || skip.test(dir + "/")) return;
    let ents: fs.Dirent[] = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(mts|mjs|ts|js)$/.test(e.name) && !skip.test(p)) files.push(p);
    }
  };
  for (const r of roots) walk(r, 0);
  const bad = files.filter((f) => {
    const src = fs.readFileSync(f, "utf8");
    if (!/__hitreg/.test(src) || !/\.route\(/.test(src)) return false;
    // a stub = a non-GET test whose branch fulfills; it must name READ_ONLY_POSTS (or use dropWrites)
    return src.split("\n").some((l) => /method\(\)\s*!==\s*["']GET["']/.test(l) && /fulfill/.test(l) && !/READ_ONLY_POSTS|dropWrites/.test(l));
  });
  assert.deepEqual(bad, [], `these scripts drop the read-only POSTs (use READ_ONLY_POSTS / dropWrites from tools/_readonly-posts.mjs): ${bad.join(", ")}`);
});
