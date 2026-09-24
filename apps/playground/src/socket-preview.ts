import * as THREE from "three/webgpu";
import type { SceneDoc } from "@hitreg/core";
import type { ModelLook } from "@hitreg/scripting";
import { findSocketBone, socketWorldPose } from "@hitreg/render";

/**
 * Held items in EDIT mode.
 *
 * A held item is placed by the `bone-socket` script, and scripts run only in
 * play — so in the editor every sword sat at its entity's raw transform, and
 * its model (trimmed to parts by `equipment-look`, another script) showed
 * nothing at all. Placing a weapon meant pressing play to see anything.
 *
 * This does the socket's sums every frame in edit mode (the same arithmetic —
 * @hitreg/render socket-pose) against the character standing in the first
 * frame of its idle (AnimationSystem.poseStill), and gives each held model a
 * look to show:
 *
 *   - the item the character STARTS with equipped for that slot, if it fits
 *     this model — so the scene opens looking the way it plays;
 *   - otherwise, while the slot (or its look entity) is SELECTED, the first
 *     starting item that fits — select "player staff" and the staff appears
 *     in the hand to be placed.
 *
 * Presentation only, never written to the document. Play mode hands every one
 * of these back to the scripts.
 */
export interface SocketPreviewDeps {
  doc(): SceneDoc;
  objectOf(entityId: string): THREE.Object3D | undefined;
  /** Ids the gizmo is dragging right now — left alone so the drag is not fought. */
  dragging(): readonly string[];
  /** Show the second (holstered) pose instead of the hand — the editor's "holstered" toggle. */
  showAlt(): boolean;
  selected(): string | null;
  item(itemId: string): { slots?: string[]; appearance?: { model?: string; parts?: string[]; texture?: string } } | undefined;
  setLook(entityId: string, look: ModelLook): void;
}

interface SocketEntity {
  id: string;
  parent: string;
  params: { bone?: string; offset?: number[]; rotationDeg?: number[]; altBone?: string; altOffset?: number[]; altRotationDeg?: number[] };
  model: string | null;
}

const HIDE: ModelLook = { partMask: 0, glow: null, effects: [] };

export function createSocketPreview(deps: SocketPreviewDeps) {
  const shown = new Map<string, string>(); // entity -> look key last sent
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const parentQ = new THREE.Quaternion();
  let cachedDoc: SceneDoc | null = null;
  let sockets: SocketEntity[] = [];

  const scriptOf = (e: SceneDoc["entities"][string]) =>
    e.components["script"] as { name?: string; params?: Record<string, unknown> } | undefined;

  function index(doc: SceneDoc): SocketEntity[] {
    const out: SocketEntity[] = [];
    for (const [id, e] of Object.entries(doc.entities)) {
      const s = scriptOf(e);
      if (s?.name !== "bone-socket" || !e.parent) continue;
      const mesh = e.components["mesh"] as { source?: { kind?: string; assetId?: string } } | undefined;
      out.push({
        id,
        parent: e.parent,
        params: (s.params ?? {}) as SocketEntity["params"],
        model: mesh?.source?.kind === "asset" ? (mesh.source.assetId ?? null) : null,
      });
    }
    return out;
  }

  /** What a socket should show: see the header. */
  function lookFor(doc: SceneDoc, socket: SocketEntity, selected: string | null): ModelLook {
    if (!socket.model) return HIDE;
    const lookEntry = Object.entries(doc.entities).find(([, e]) => e.parent === socket.id && scriptOf(e)?.name === "equipment-look");
    const lookParams = (lookEntry ? scriptOf(lookEntry[1])?.params : undefined) ?? {};
    const slot = (lookParams["slot"] as string | undefined) ?? "primary";
    const actor = lookParams["actor"] as string | undefined;
    const sheet = Object.values(doc.entities)
      .map((e) => scriptOf(e))
      .find((s) => s?.name === "character-sheet" && s.params?.["actor"] === actor);
    const starting = ((sheet?.params?.["startingItems"] as Array<{ itemId: string; equip?: boolean }>) ?? []).filter(Boolean);
    const fits = starting
      .map((s) => ({ ...s, item: deps.item(s.itemId) }))
      .filter((s) => s.item?.appearance?.model === socket.model && (s.item.slots ?? []).includes(slot === "offhand" ? "offhand" : slot));
    const isSelected = selected !== null && (selected === socket.id || selected === lookEntry?.[0]);
    const pick = fits.find((s) => s.equip) ?? (isSelected ? fits[0] : undefined);
    const appearance = pick?.item?.appearance;
    if (!appearance) return HIDE;
    return { parts: appearance.parts ?? [], texture: appearance.texture ?? null, glow: null, effects: [] };
  }

  return {
    /** Once per frame in edit mode. */
    update(): void {
      const doc = deps.doc();
      if (doc !== cachedDoc) {
        cachedDoc = doc;
        sockets = index(doc);
      }
      const dragging = deps.dragging();
      const selected = deps.selected();
      for (const socket of sockets) {
        const look = lookFor(doc, socket, selected);
        const key = JSON.stringify(look);
        if (shown.get(socket.id) !== key) {
          shown.set(socket.id, key);
          deps.setLook(socket.id, look);
        }
        if (dragging.includes(socket.id)) continue;
        const object = deps.objectOf(socket.id);
        const parent = object?.parent;
        const p = socket.params;
        const alt = deps.showAlt() && p.altOffset?.length === 3 && p.altRotationDeg?.length === 3;
        const boneName = alt ? p.altBone || p.bone : p.bone;
        const bone = parent && boneName ? findSocketBone(parent, boneName) : null;
        if (!object || !parent || !bone) continue;
        // the gizmo edits whichever pose is on show
        object.userData["socketPose"] = alt ? "alt" : "main";
        const o = alt ? p.altOffset : p.offset;
        const r = alt ? p.altRotationDeg : p.rotationDeg;
        socketWorldPose(
          bone,
          {
            offset: o?.length === 3 ? [o[0]!, o[1]!, o[2]!] : [0, 0, 0],
            rotationDeg: r?.length === 3 ? [r[0]!, r[1]!, r[2]!] : [0, 90, 0],
          },
          pos,
          quat,
        );
        parent.updateWorldMatrix(true, false);
        object.position.copy(parent.worldToLocal(pos));
        object.quaternion.copy(parent.getWorldQuaternion(parentQ).invert().multiply(quat));
      }
    },
    /** Leaving edit mode (the scripts own it now), or a rebuild: forget what was sent. */
    reset(): void {
      shown.clear();
      cachedDoc = null;
    },
  };
}
