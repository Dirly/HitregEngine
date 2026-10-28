// Agent test config: the playground config with source-file watching turned
// off, so a concurrent editing session can't reload the page mid-test.
// Untracked scratch file — safe to delete.
import base from "./vite.config.js";
import { mergeConfig } from "vite";

export default mergeConfig(base, {
  // own dependency cache: a probe's vite re-optimizing into node_modules/.vite would hand the owner's running dev
  // server (same folder) stale pre-bundles — 504 "outdated optimize dep" and a reload in HIS tab mid-session
  cacheDir: "node_modules/.vite-agent",
  server: {
    watch: { ignored: ["**/src/**", "**/packages/**", "**/*.ts", "**/*.tsx"] },
    // no client websocket: a dependency re-optimization mid-run (play mode imports modules the optimizer had not
    // seen) otherwise reloads the page under the probe — three runs in a row measured the starter scene or died
    // with "execution context was destroyed"
    hmr: false,
  },
});
