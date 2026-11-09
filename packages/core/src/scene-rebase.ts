import type { ComponentRegistry } from "./components/registry.js";
import { diffSceneDocs } from "./diff.js";
import { applyOps, OpError, type Op } from "./ops.js";
import type { SceneDoc } from "./scene.js";

/**
 * A short tag of a file's text: what a client last read or wrote of a scene, sent with its next write so the dev
 * server can tell whether anyone else wrote the file since (POST /__hitreg/write-asset `base`). Not cryptographic:
 * it only has to tell two versions of one file apart. Same result in Node and the browser (cyrb53 over UTF-16 code
 * units, plus the length).
 */
export function contentTag(text: string): string {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}-${text.length}`;
}

export interface RebaseResult {
  /** `theirs` with this client's own edits (base -> mine) applied on top. */
  doc: SceneDoc;
  /** The edits that applied. Empty: nothing of this client's is missing from `theirs`. */
  applied: Op[];
  /** Edits that no longer fit (an entity the other writer removed, a parent gone): reported, never forced. */
  skipped: { op: Op; reason: string }[];
}

/**
 * Three-way scene merge: carry the edits a client made since `base` (what it last knew of the file) onto `theirs`
 * (the file as it is now, after another writer). Used when a scene write is refused as stale (409) and by live-sync
 * when the file changes under unsaved edits, so neither side's work is lost:
 *  - the client's own edits are `diffSceneDocs(base, mine)`, applied to `theirs` (on the same component, the client's
 *    value wins: it is the newer intent);
 *  - an edit that no longer applies (its entity was removed by the other writer) is skipped and reported;
 *  - removing an entity is skipped when the other writer added children under it (that would delete their work);
 *  - with no `base` (unknown), nothing of `theirs` is removed: only additions and changes from `mine` apply.
 * Pure; `theirs` is never mutated.
 */
export function rebaseSceneEdits(
  base: SceneDoc | null,
  mine: SceneDoc,
  theirs: SceneDoc,
  registry: ComponentRegistry,
): RebaseResult {
  let pending = base
    ? diffSceneDocs(base, mine)
    : diffSceneDocs(theirs, mine).filter((op) => op.op !== "remove-entity" && op.op !== "remove-component");
  const skipped: { op: Op; reason: string }[] = [];
  if (base) {
    pending = pending.filter((op) => {
      if (op.op !== "remove-entity") return true;
      const added = theirsAddedUnder(op.id, base, theirs);
      if (!added) return true;
      skipped.push({ op, reason: `kept: another writer added ${added} under it` });
      return false;
    });
  }
  // one applyOps per attempt (it clones the doc): drop the op that failed and retry; failures are rare
  let ops = pending;
  for (;;) {
    if (ops.length === 0) return { doc: { ...structuredClone(theirs), name: mine.name }, applied: [], skipped };
    try {
      const doc = applyOps(theirs, ops, registry).doc;
      return { doc: { ...doc, name: mine.name }, applied: ops, skipped };
    } catch (error) {
      if (!(error instanceof OpError) || error.opIndex == null) throw error;
      const i = error.opIndex;
      skipped.push({ op: ops[i]!, reason: error.message });
      ops = ops.filter((_, k) => k !== i);
    }
  }
}

/** An id the other writer added somewhere under `root` (in `theirs`, absent from `base`), or null. */
function theirsAddedUnder(root: string, base: SceneDoc, theirs: SceneDoc): string | null {
  const under = (id: string): boolean => {
    for (let p = theirs.entities[id]?.parent ?? null, n = 0; p !== null && n < 4096; p = theirs.entities[p]?.parent ?? null, n++) {
      if (p === root) return true;
    }
    return false;
  };
  for (const id of Object.keys(theirs.entities)) if (!(id in base.entities) && under(id)) return id;
  return null;
}
