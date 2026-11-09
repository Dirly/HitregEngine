/**
 * Base-scene content that no culling root covers, for the "over unloaded ground" gate (docs/culling.md).
 *
 * Every `poi`-tagged entity and every `culling` entity is a culling unit and is gated by the host already. A root that
 * is neither — a town's root (`town:<id>`, its buildings, walls, foundations and corner dressing below it) — left its
 * unmerged meshes (a glTF that landed after the static batch, a building's lit-window mesh) drawing at any distance
 * over cells that had not streamed in. This returns the entities to gate in its place: each direct child of such a
 * root that is not itself a culling root (a child's own subtree is one unit), or the root itself when it has no
 * children. Only STILL subtrees (`still`): a unit's bounds are measured once, so anything that moves is left alone, as
 * is the player, a placed creature (gated by its own rule), the spawn, and the world / sky / ocean / camera entities.
 */
export interface GateDoc {
  entities: Record<string, { parent?: string | null; tags?: string[]; components?: Record<string, unknown> }>;
}

// "water": the ocean plane is wider than any cell and stands on no one cell's ground (the batch's "wide" rule)
const SKIP_TAGS = ["player", "npc", "spawn", "water"];
const SKIP_COMPONENTS = ["voxelWorld", "sky", "water", "camera", "light", "chunkStreamer"];

export function ungatedBaseUnits(doc: GateDoc | null | undefined, cullRootOf: ReadonlyMap<string, string>, still: (id: string) => boolean): string[] {
  if (!doc) return [];
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  for (const [id, entity] of Object.entries(doc.entities)) {
    if (!entity.parent) roots.push(id);
    else {
      const list = children.get(entity.parent);
      if (list) list.push(id);
      else children.set(entity.parent, [id]);
    }
  }
  const skipped = (id: string): boolean => {
    const entity = doc.entities[id]!;
    if (cullRootOf.has(id)) return true;
    if (entity.tags?.some((t) => SKIP_TAGS.includes(t))) return true;
    const components = entity.components ?? {};
    return SKIP_COMPONENTS.some((c) => c in components);
  };
  const out: string[] = [];
  for (const root of roots) {
    if (skipped(root)) continue;
    const kids = children.get(root) ?? [];
    if (kids.length === 0) {
      const components = doc.entities[root]!.components ?? {};
      if (("mesh" in components || "prefab" in components) && still(root)) out.push(root);
      continue;
    }
    for (const kid of kids) if (!skipped(kid) && still(kid)) out.push(kid);
  }
  return out;
}
