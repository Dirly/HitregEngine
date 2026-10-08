/**
 * The ops that hang a walk-through portal's veil and apply its stated trigger box. Shared by tools/portal-veil.mts
 * (run after every scene rebuild) and tools/portal-cover.mts --fit (which measures the opening and writes the stated
 * sizes), so a rebuild re-applies exactly what the fit measured.
 *
 * Stated data, <project>/authoring/portal-veils.json (metres, the portal entity's local space; local z is the way through):
 *   { "<scene id>": { "<portal id>": {
 *       "size": [w, h], "at": [x, y, z],                              the veil (a picture only)
 *       "trigger": { "halfExtents": [x, y, z], "offset": [x, y, z] },  the walk-through box (portal-cover --fit writes it)
 *       "fit": { ... }                                                what portal-cover measured (read by nobody else)
 *   } } }
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Op, SceneDoc } from "@hitreg/core";

export const VEIL_MATERIAL = "hollow-bastion/zone-boundary";
/** A default veil is this much larger than its trigger box's opening, so the passage walls cut it to size. */
export const VEIL_OVERSIZE = 1.25;

export type V3 = [number, number, number];
export interface StatedPortal {
  size?: [number, number];
  at?: V3;
  trigger?: { halfExtents: V3; offset: V3 };
  fit?: Record<string, unknown>;
}
export type StatedFile = Record<string, Record<string, StatedPortal>>;

export const statedFileOf = (pg: string, project: string): string => path.join(pg, "projects", project, "authoring", "portal-veils.json");
export function readStated(file: string): StatedFile {
  return (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {}) as StatedFile;
}

const vec = (v: unknown, d: number[]): V3 => (Array.isArray(v) && v.length === 3 ? (v as V3) : (d as V3));
type Script = { name?: string; params?: Record<string, unknown> };

/** Walk-through portals of a scene: entity id -> its script params. */
export function walkThroughPortals(doc: SceneDoc): [string, Record<string, unknown>][] {
  const out: [string, Record<string, unknown>][] = [];
  for (const [id, e] of Object.entries(doc.entities)) {
    const sc = e.components["script"] as Script | undefined;
    if (sc?.name === "portal" && sc.params?.["mode"] === "trigger") out.push([id, sc.params]);
  }
  return out;
}

/** The trigger box a portal has now (its params, or the builtin's defaults). */
export function triggerOf(params: Record<string, unknown>): { halfExtents: V3; offset: V3 } {
  return { halfExtents: vec(params["halfExtents"], [1.2, 1.3, 0.75]), offset: vec(params["offset"], [0, 1.3, 0]) };
}

/** The veil a portal gets: stated, else on the trigger box's centre plane, 25% larger than its opening. */
export function veilOf(params: Record<string, unknown>, stated?: StatedPortal): { size: [number, number]; at: V3; stated: boolean } {
  const { halfExtents: half, offset } = stated?.trigger ?? triggerOf(params);
  const size = stated?.size ?? [+(2 * half[0] * VEIL_OVERSIZE).toFixed(2), +(2 * half[1] * VEIL_OVERSIZE).toFixed(2)];
  return { size, at: stated?.at ?? offset, stated: !!stated?.size };
}

/**
 * Ops for one scene: every old veil taken down; for each walk-through portal (unless `remove`) its stated trigger set
 * (when one is stated and differs) and its veil hung. `only` limits the work to some portal ids.
 */
export function portalVeilOps(doc: SceneDoc, sceneId: string, stated: StatedFile, opts: { remove?: boolean; only?: Set<string> } = {}): { ops: Op[]; lines: string[]; hung: number } {
  const ops: Op[] = [];
  const lines: string[] = [];
  let hung = 0;
  for (const [id, e] of Object.entries(doc.entities)) {
    if (opts.only && !opts.only.has(id)) continue;
    const veil = `${id}-veil`;
    const sc = e.components["script"] as Script | undefined;
    const walk = sc?.name === "portal" && sc.params?.["mode"] === "trigger";
    // replaced when the portal still stands; taken down when it does not (a sealed passage) or on remove
    if (doc.entities[veil] && (doc.entities[veil].tags ?? []).includes("zone-boundary")) ops.push({ op: "remove-entity", id: veil });
    if (!walk || opts.remove) continue;
    const s = stated[sceneId]?.[id];
    if (s?.trigger) {
      const cur = triggerOf(sc!.params!);
      if (JSON.stringify(cur) !== JSON.stringify(s.trigger)) {
        ops.push({ op: "set-component", id, component: "script", data: { ...sc, params: { ...sc!.params, halfExtents: s.trigger.halfExtents, offset: s.trigger.offset } } } as Op);
        lines.push(`  ${id}: trigger ${s.trigger.halfExtents.map((v) => +(2 * v).toFixed(2)).join(" x ")} m at [${s.trigger.offset.join(", ")}] (stated)`);
      }
    }
    const v = veilOf(sc!.params!, s);
    ops.push({
      op: "add-entity", id: veil,
      entity: {
        name: `Instance boundary veil (${id})`, parent: id, tags: ["zone-boundary", "visual-only"],
        components: {
          // a plane lies flat; a quarter turn about x stands it across the passage (local z is the way through)
          transform: { position: v.at, rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], scale: [1, 1, 1] },
          mesh: { source: { kind: "primitive", shape: "plane", size: [v.size[0], 1, v.size[1]], segments: [1, 1] }, material: VEIL_MATERIAL, castShadow: false, receiveShadow: false, static: false },
        },
      },
    } as Op);
    hung++;
    lines.push(`  ${id}: veil ${v.size[0]} x ${v.size[1]} m at [${v.at.join(", ")}]${v.stated ? " (stated)" : ""}`);
  }
  return { ops, lines, hung };
}

/** Digest of what decides a portal's coverage: its parent, transform and script, and its veil. portal-cover stores it per
 *  portal; a status row compares it with the scene now (any other edit to a live scene leaves the check current). */
export function portalDigest(d: SceneDoc, id: string): string {
  const e = d.entities[id], v = d.entities[`${id}-veil`];
  return createHash("sha256").update(JSON.stringify([e?.parent, e?.components["transform"], e?.components["script"], v?.components["transform"], v?.components["mesh"]])).digest("hex").slice(0, 16);
}
