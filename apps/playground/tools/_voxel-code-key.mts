import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

/** Re-read generation sources: a running dev server must never reuse stale terrain after an engine edit. */
export function voxelCodeKey(engineRoot: string): string {
  const hash = crypto.createHash("sha256").update("hitreg-browser-terrain-1");
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".ts")) hash.update(path.relative(engineRoot, file)).update(fs.readFileSync(file));
    }
  };
  walk(path.join(engineRoot, "packages/core/src"));
  for (const name of ["voxel-worker.ts", "voxel-world.ts", "voxel-disk-cache.ts"]) {
    hash.update(name).update(fs.readFileSync(path.join(engineRoot, "apps/playground/src", name)));
  }
  return hash.digest("hex");
}
