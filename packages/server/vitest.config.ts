import { defineConfig } from "vitest/config";

// Every file here boots real servers over sockets (main + layers, a
// headless world each); under `pnpm test` they run alongside every other
// package, and a 5 s default is a flake, not a bug — the field test timed
// out once at 9 s under full load while passing alone in 2 s.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
