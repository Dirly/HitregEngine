import type { EventRegistry } from "@hitreg/core";
import type { ScriptRegistry } from "@hitreg/scripting";

/**
 * Owns the discovery + registration of every example/project Script class, and
 * — the reason this is its own module — hot-swaps them WITHOUT a full page
 * reload.
 *
 * The scripts are matched by an eager `import.meta.glob`, so each file is a
 * static dependency of THIS module. This module is self-accepting
 * (`import.meta.hot.accept()`), which makes it the HMR boundary: when a script
 * file changes (or one is added/removed), Vite re-executes this module instead
 * of propagating the update up to main.ts. main.ts accepts nothing, so an
 * update reaching it forces a whole-app reload — re-fetching every asset, every
 * GLB, re-baking every thumbnail, recompiling every pipeline. That cascade
 * (CLAUDE.md budgets script hot-reload at <1s; the reload path blew past it by
 * an order of magnitude) is exactly what this boundary prevents.
 *
 * Both globbed trees live outside `assets/`, so Vite's normal source watcher
 * covers them — no dev-bridge involvement, unlike scene/material/prefab files.
 */
type Deps = {
  registry: ScriptRegistry;
  events: EventRegistry;
  /** Called after a hot re-registration so main can restart a live play session. */
  onReload?: () => void;
};

const modules = import.meta.glob(["./scripts/*.ts", "../projects/*/scripts/*.ts"], {
  eager: true,
});

// Carried across HMR re-executions (which get a fresh module scope) so the
// re-run can register the new classes against the same registry/events without
// main having to re-invoke init.
let deps: Deps | null = import.meta.hot?.data.deps ?? null;

function registerAll(): void {
  if (!deps) return;
  for (const [path, mod] of Object.entries(modules)) {
    const cls = (mod as { default?: Parameters<ScriptRegistry["reregister"]>[0] }).default;
    if (!cls) continue;
    try {
      // reregister (not register) so a re-executed file overwrites its own
      // prior class instead of throwing on the duplicate name.
      deps.registry.reregister(cls, deps.events);
    } catch (error) {
      console.warn(`[scripts] failed to register ${path}:`, error);
    }
  }
}

/** Called once from main after the registry + builtin scripts are set up. */
export function initProjectScripts(d: Deps): void {
  deps = d;
  if (import.meta.hot) import.meta.hot.data.deps = d;
  registerAll();
}

if (import.meta.hot) {
  // A hot re-execution means a script file changed: `deps` was just restored
  // from hot.data and `modules` re-resolved to the fresh classes, so
  // re-register and let main hot-swap any running session. (First load has no
  // deps yet — init handles that a moment later.)
  if (deps) {
    registerAll();
    deps.onReload?.();
  }
  import.meta.hot.accept();
}
