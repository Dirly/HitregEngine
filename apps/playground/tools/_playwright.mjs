// Playwright for the headless-browser harnesses (see-through, light-shots, portal-play, town-shots, town-layout,
// loading-art, town-perf, fall-site shots). It is a devDependency of apps/playground (pinned in package.json,
// browsers not downloaded: the harnesses drive the system Chrome), so `pnpm install` is all a machine needs.
//
// Overrides, in order: HITREG_PLAYWRIGHT = a playwright package DIR, PLAYWRIGHT_MODULE = its index.mjs (path or
// file:// URL). Without either, the apps/playground dependency is used — never a scratchpad install.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Where playwright would load from: { kind: "HITREG_PLAYWRIGHT" | "PLAYWRIGHT_MODULE" | "devDependency", where }. */
export function playwrightSource(env = process.env) {
  if (env.HITREG_PLAYWRIGHT) return { kind: "HITREG_PLAYWRIGHT", where: env.HITREG_PLAYWRIGHT };
  if (env.PLAYWRIGHT_MODULE) return { kind: "PLAYWRIGHT_MODULE", where: env.PLAYWRIGHT_MODULE };
  return { kind: "devDependency", where: path.join(PG, "package.json") };
}

/** The playwright module ({ chromium, ... }). Throws with the fix when it cannot be resolved. */
export async function loadPlaywright(env = process.env) {
  const src = playwrightSource(env);
  try {
    if (src.kind === "HITREG_PLAYWRIGHT") return createRequire(path.join(src.where, "package.json"))(src.where);
    if (src.kind === "PLAYWRIGHT_MODULE") return await import(/^file:/.test(src.where) ? src.where : pathToFileURL(src.where).href);
    return createRequire(src.where)("playwright");
  } catch (e) {
    throw new Error(`playwright is not resolvable from ${src.kind} (${src.where}): ${e instanceof Error ? e.message : e} — run \`pnpm install\` at the repo root (apps/playground devDependency; PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 is fine, the system Chrome is used), or set HITREG_PLAYWRIGHT=<playwright package dir>`);
  }
}
