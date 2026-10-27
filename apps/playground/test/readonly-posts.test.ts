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
