import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

interface Change { project: string | null; file: string; content: string | null }

/** Filter before WebSocket serialization: an unrelated world save can be 17 MB. */
export function scopedAssetChange(change: Change, scope: ReadonlySet<string> | null | undefined): Change | null {
  if (scope == null || change.project === null || scope.has(change.project)) return change;
  return change.file.startsWith("scenes/") ? { ...change, content: null } : null;
}

export function assetSourceProject(projectsRoot: string, assetsDir: string): string | null {
  const relative = path.relative(path.resolve(projectsRoot), path.resolve(assetsDir)).split(path.sep);
  return relative.length === 2 && relative[0] !== ".." && relative[1] === "assets" ? relative[0]! : null;
}

/** Windows can report the same save repeatedly; publish one complete changed file. */
export function assetChangePublisher(publish: (root: string, file: string, content: string) => void) {
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const fingerprints = new Map<string, string>();
  let closed = false;
  return {
    enqueue(root: string, file: string): void {
      if (closed) return;
      const full = path.join(root, file);
      clearTimeout(pending.get(full));
      pending.set(full, setTimeout(() => {
        pending.delete(full);
        void fs.promises.readFile(full, "utf8").then((content) => {
          if (closed) return;
          const hash = createHash("sha256").update(content).digest("hex");
          if (fingerprints.get(full) === hash) return;
          fingerprints.set(full, hash);
          publish(root, file, content);
        }).catch(() => { /* Deleted or still being written; another event can retry. */ });
      }, 40));
    },
    close(): void {
      closed = true;
      for (const timer of pending.values()) clearTimeout(timer);
      pending.clear();
    },
  };
}
