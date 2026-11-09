import type { AssetLibrary } from "@hitreg/core";
import { assetFileUrl } from "./asset-url.js";

export interface BinaryAssetChanges { models: string[]; textures: string[] }
export interface BinaryAssetIndex { index: Record<string, string[]>; revisions: Record<string, string> }
interface Pending { kind: "models" | "textures"; id: string; revision: string; url: string }
const states = new WeakMap<AssetLibrary, { versions: Map<string, string>; held: Map<string, Pending> }>();
const stateOf = (assets: AssetLibrary) => {
  let state = states.get(assets);
  if (!state) { state = { versions: new Map(), held: new Map() }; states.set(assets, state); }
  return state;
};
export const emptyBinaryChanges = (): BinaryAssetChanges => ({ models: [], textures: [] });
export function binaryAssetIndex(value: unknown): BinaryAssetIndex {
  const data = value as BinaryAssetIndex;
  return data.index && data.revisions ? data : { index: value as Record<string, string[]>, revisions: {} };
}
function install(assets: AssetLibrary, pending: Pending): void {
  const existing = pending.kind === "models" ? assets.getModel(pending.id) : assets.getTexture(pending.id);
  // These host-owned URL documents are shared references in AssetLibrary.
  if (existing) existing.url = pending.url;
  else {
    const doc = { id: pending.id, name: pending.id.split("/").pop()!, url: pending.url };
    if (pending.kind === "models") assets.addModel(doc); else assets.addTexture(doc);
  }
}
/** Register new binaries before their JSON references arrive. Existing replacements wait with Play's structural edits. */
export function applyBinaryAssetIndex(assets: AssetLibrary, snapshot: BinaryAssetIndex, options: { stage?: boolean; seed?: boolean } = {}): BinaryAssetChanges {
  const state = stateOf(assets), changed = emptyBinaryChanges();
  for (const kind of ["models", "textures"] as const) for (const id of new Set(snapshot.index[kind] ?? [])) {
    if (!(kind === "models" ? /\.(glb|gltf)$/i : /\.(png|jpe?g|webp)$/i).test(id)) continue;
    const key = `${kind}/${id}`, revision = snapshot.revisions[key];
    const existing = kind === "models" ? assets.getModel(id) : assets.getTexture(id);
    if (existing && revision === state.versions.get(key)) { state.held.delete(key); continue; }
    if (existing && revision === undefined) continue;
    const base = assetFileUrl(key), url = revision ? `${base}${base.includes("?") ? "&" : "?"}_hitreg_rev=${encodeURIComponent(revision)}` : base;
    const pending = { kind, id, revision: revision ?? "", url };
    if (existing && options.stage && !options.seed) { state.held.set(key, pending); continue; }
    install(assets, pending); state.versions.set(key, pending.revision); state.held.delete(key);
    if (!options.seed) changed[kind].push(id);
  }
  return changed;
}
export function flushBinaryAssetIndex(assets: AssetLibrary): BinaryAssetChanges {
  const state = stateOf(assets), changed = emptyBinaryChanges();
  for (const [key, pending] of state.held) {
    install(assets, pending); state.versions.set(key, pending.revision); changed[pending.kind].push(pending.id);
  }
  state.held.clear(); return changed;
}
