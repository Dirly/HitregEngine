/** Dev-server POST endpoints that only READ (a browser test that stubs every other POST so nothing reaches disk must
 *  let these through). L (place-build shots 2026-10-20): the asset loader moved library reads to a batched
 *  POST /__hitreg/asset-json; the stub answered it {"ok":true}, no prefab loaded ("prefab characters/player not
 *  found") and every shot run timed out waiting for the dev app. test/readonly-posts.test.ts keeps this list in step
 *  with vite.config's endpoint table (every POST whose purpose starts "Read"). */
export const READ_ONLY_POSTS = /\/__hitreg\/(log|asset-json)\b/;
/** Playwright route handler for /__hitreg/: every write is answered {"ok":true} and dropped; reads pass. */
export const dropWrites = (route) => {
  const r = route.request();
  if (r.method() !== "GET" && !READ_ONLY_POSTS.test(r.url())) return route.fulfill({ status: 200, contentType: "application/json", body: "{\"ok\":true}" });
  return route.continue();
};
