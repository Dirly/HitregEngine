// Worker-thread entry. Node strips types from a `.ts` worker on its own, but
// it does not resolve `@hitreg/core`'s `.js`-suffixed imports back to their
// `.ts` sources — tsx does. Registering it here, before the worker module
// loads, is what lets the thread import the engine the same way the main
// thread does (under `tsx` and under vitest alike).
import { register } from "tsx/esm/api";
register();
await import("./voxel-worker.ts");
