import { defineConfig } from "vitest/config";

// Every file here boots real servers over sockets (main + layers, a
// headless world each); under `pnpm test` they run alongside every other
// package, and a 5 s default is a flake, not a bug — the field test timed
// out once at 9 s under full load while passing alone in 2 s.
export default defineConfig({
  test: {
    testTimeout: 20_000,
    // one file at a time: each boots its own world and socket server, and run side by side their
    // waits (combat windows, spawns, persistence) time out under the combined load — the same
    // tests pass alone every time (2026-10-09: defence, x2-corpse, l2-persist, spawn-areas)
    fileParallelism: false,
    pool: "forks",
    hookTimeout: 30_000,
  },
});
