// Agent test config: the playground config with source-file watching turned
// off, so a concurrent editing session can't reload the page mid-test.
// Untracked scratch file — safe to delete.
import base from "./vite.config.js";
import { mergeConfig } from "vite";

export default mergeConfig(base, {
  server: {
    watch: { ignored: ["**/src/**", "**/packages/**", "**/*.ts", "**/*.tsx"] },
  },
});
