/**
 * owner-seat — the SEAT rule (packages/core voxel/seat.ts, via tools/float.mts) for ONE prop the owner is placing in
 * the editor: the same solid `dress apply` seats props on (DC floors, decks, colliders, the voxel field), measured
 * from the scene file with that prop's transform replaced by the editor's. The editor's "Drop to surface" calls it
 * through POST /__hitreg/owner-edit?seat=1 when no physics world is running (edit mode).
 *
 *   node node_modules/tsx/dist/cli.mjs tools/owner-seat.mts <request.json>
 *     request: { project, scene, entity, transform: { position, rotation, scale }, entityDoc? }
 *     entityDoc: the editor's live entity (a fresh duplicate is not in the saved scene yet); its parent must be saved
 *     prints ONE line of JSON: { ok: true, position: [x, y, z], dy } | { ok: false, why }
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seatPlaced } from "./float.mts";

const PLAYGROUND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const req = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8")) as { project: string; scene: string; entity: string; transform: { position: number[] }; entityDoc?: { components?: Record<string, unknown> } };
const out = (v: unknown): never => {
  console.log(JSON.stringify(v));
  process.exit(0);
};
const sceneFile = path.join(PLAYGROUND, "projects", req.project, "assets", "scenes", `${req.scene}.scene.json`);
if (!fs.existsSync(sceneFile)) out({ ok: false, why: `no scene ${req.scene} in ${req.project}` });
const doc = JSON.parse(fs.readFileSync(sceneFile, "utf8"));
if (req.entityDoc?.components) doc.entities[req.entity] = structuredClone(req.entityDoc);
const e = doc.entities?.[req.entity];
if (!e) out({ ok: false, why: "the prop is not saved in the scene yet" });
e.components.transform = { ...e.components.transform, ...req.transform };
// reachUp "height": a prop sunk into the floor (by the owner's drag or an old placement) is lifted out, not pushed down
const seat = seatPlaced(req.project, doc, new Set([req.entity]), 0.05, { reachUp: "height" });
const row = seat.rows.find((r) => (r as { id?: string }).id === req.entity) as { status?: string; reason?: string } | undefined;
if (seat.unsupported.length) out({ ok: false, why: `nothing to stand on (${row?.reason ?? "unsupported"})` });
const op = seat.ops.find((o: { id?: string; component?: string }) => o.id === req.entity && o.component === "transform") as { data?: { position?: number[] } } | undefined;
if (!op?.data?.position) out({ ok: true, position: req.transform.position, dy: 0 });
out({ ok: true, position: op!.data!.position, dy: +(op!.data!.position![1]! - req.transform.position[1]!).toFixed(4) });
