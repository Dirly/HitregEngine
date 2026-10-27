/**
 * material-family — a dungeon's props carry the dungeon's own stone (one natural palette per dungeon; owner ruling
 * 2026-10-21: "pillars whose stone does not match the dungeon"). `dress check` runs it on every plan whose
 * `space.kind` is "dungeon" in a project that owns a palette material (`<project>/dc-palette`):
 *
 *   a placed prop whose meshes (nested prefabs followed) wear a STONE material from outside the dungeon's family
 *   (material id not under `<project>/`) is a `material-family` violation, unless the plan item sets the prop's
 *   declared `material` prop to a material of the family. The reskin is that material swap on the instance (the prefab
 *   declares `material`, bound down to its mesh), never a copied mesh.
 *
 * Stone = a terrain-splat material (the DC stone kits) or a material id naming stone/masonry/marble/granite/rock/brick.
 * Pure parts take loaders, so test/material-family.test.ts runs them on literals.
 */

export interface PrefabLike {
  props?: Record<string, { default?: unknown; bindings?: string[] }>;
  entities?: Record<string, { components?: { mesh?: { material?: unknown }; prefab?: { prefabId?: string } } }>;
}

export const STONE_NAME = /stone|masonry|marble|granite|rock|brick|cobble|flag/i;

/** Every material id a prefab's meshes name, nested prefabs followed (depth <= 8), defaults only. */
export function meshMaterials(id: string, load: (id: string) => PrefabLike | null, depth = 0): string[] {
  const doc = depth > 8 ? null : load(id);
  if (!doc) return [];
  const out: string[] = [];
  for (const e of Object.values(doc.entities ?? {})) {
    const m = e.components?.mesh?.material;
    if (typeof m === "string" && m) out.push(m);
    const nested = e.components?.prefab?.prefabId;
    if (nested) out.push(...meshMaterials(nested, load, depth + 1));
  }
  return [...new Set(out)];
}

export interface FamilyFinding { item: string; code: "material-family"; message: string }

/**
 * One placed item: its foreign stone materials, and whether the item's `props.material` swaps them for the family.
 * `family` is the dungeon's material prefix ("weep-hole/"), `palette` the material to name in the fix.
 */
export function materialFamilyFinding(
  item: { id: string; prop: string; props?: Record<string, unknown> },
  load: (id: string) => PrefabLike | null,
  isStone: (materialId: string) => boolean,
  family: string,
  palette: string,
): FamilyFinding | null {
  const foreign = meshMaterials(item.prop, load).filter((m) => !m.startsWith(family) && isStone(m));
  if (!foreign.length) return null;
  const declares = !!load(item.prop)?.props?.material;
  const set = item.props?.material;
  if (declares && typeof set === "string" && set.startsWith(family)) return null;
  return {
    item: item.id,
    code: "material-family",
    message: declares
      ? `${item.prop} wears ${foreign.join(", ")}, not this dungeon's stone: set the item's "props": { "material": "${palette}" } (a material swap on the instance)`
      : `${item.prop} wears ${foreign.join(", ")}, not this dungeon's stone, and declares no "material" prop to swap: give the prefab a material prop bound to its mesh (props: { material: { default, bindings } }), or choose a prop of this stone`,
  };
}
