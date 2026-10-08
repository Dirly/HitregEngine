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
 *     in the hand to be placed;
 *   - with the "holstered" toggle on, EVERY slot shows its first fitting
 *     item: the back and hips are laid out as a whole, so each holster has
 *     to be on show to be placed against the others.
 *
 * A selected held item (not holstered) also hides the other items of its
 * slot, and asks for its STANCE: `stanceClips` names the `<Stance>_Idle`
 * clips its character should stand in (main-hand stance + off-hand suffix
 * first, as weapon-stance combines them), so a two-handed grip is placed in
 * the pose that grips it rather than in the plain idle.
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
  item(itemId: string): { slots?: string[]; stance?: string[]; appearance?: { model?: string; parts?: string[]; texture?: string } } | undefined;
  setLook(entityId: string, look: ModelLook): void;
}

interface SocketEntity {
  id: string;
  parent: string;
  /** The `equipment-look` child that styles this socket's model, if any. */
  lookId: string | null;
  lookParams: Record<string, unknown>;
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
  /** actor -> its character-sheet params, from the same pass as `sockets`. */
  let sheets = new Map<unknown, Record<string, unknown>>();
  // Looks depend only on the doc and the selection. Recomputing them every
  // frame scanned the whole expanded doc (every streamed entity) twice per
  // socket — a top allocation source while chunks stream in.
  let looksFor: string | null | undefined;
  let looksHolstered: boolean | undefined;
  /** actor entity -> the stance idle clips to try, while one of its held items is selected. */
  let stance = new Map<string, string[]>();

  const scriptOf = (e: SceneDoc["entities"][string]) =>
    e.components["script"] as { name?: string; params?: Record<string, unknown> } | undefined;

  function index(doc: SceneDoc): SocketEntity[] {
    const out: SocketEntity[] = [];
    const looks = new Map<string, { id: string; params: Record<string, unknown> }>(); // socket id -> first look child
    sheets = new Map();
    for (const id in doc.entities) {
      const e = doc.entities[id]!;
      const s = scriptOf(e);
      if (s?.name === "equipment-look" && e.parent && !looks.has(e.parent)) looks.set(e.parent, { id, params: s.params ?? {} });
      if (s?.name === "character-sheet" && !sheets.has(s.params?.["actor"])) sheets.set(s.params?.["actor"], s.params ?? {});
      if (s?.name !== "bone-socket" || !e.parent) continue;
      const mesh = e.components["mesh"] as { source?: { kind?: string; assetId?: string } } | undefined;
      out.push({
        id,
        parent: e.parent,
        lookId: null,
        lookParams: {},
        params: (s.params ?? {}) as SocketEntity["params"],
        model: mesh?.source?.kind === "asset" ? (mesh.source.assetId ?? null) : null,
      });
    }
    for (const socket of out) {
      const look = looks.get(socket.id);
      socket.lookId = look?.id ?? null;
      socket.lookParams = look?.params ?? {};
    }
    return out;
  }

  const slotOf = (socket: SocketEntity): string => (socket.lookParams["slot"] as string | undefined) ?? "primary";
  const isSelected = (socket: SocketEntity, selected: string | null): boolean =>
    selected !== null && (selected === socket.id || selected === socket.lookId);
  function startingOf(socket: SocketEntity) {
    const sheet = sheets.get(socket.lookParams["actor"]);
    return ((sheet?.["startingItems"] as Array<{ itemId: string; equip?: boolean }>) ?? [])
      .filter(Boolean)
      .map((s) => ({ ...s, item: deps.item(s.itemId) }));
  }

  /** The item a socket shows: see the header. */
  function itemFor(socket: SocketEntity, selected: string | null, holstered: boolean) {
    if (!socket.model) return undefined;
    const slot = slotOf(socket);
    const fits = startingOf(socket).filter((s) => s.item?.appearance?.model === socket.model && (s.item.slots ?? []).includes(slot));
    const chosen = isSelected(socket, selected);
    // a held item being placed has its hand to itself
    if (!chosen && !holstered && sockets.some((o) => o !== socket && o.parent === socket.parent && slotOf(o) === slot && isSelected(o, selected))) return undefined;
    return (fits.find((s) => s.equip) ?? (chosen || holstered ? fits[0] : undefined))?.item;
  }

  function lookFor(socket: SocketEntity, selected: string | null, holstered: boolean): ModelLook {
    const appearance = itemFor(socket, selected, holstered)?.appearance;
    if (!appearance) return HIDE;
    return { parts: appearance.parts ?? [], texture: appearance.texture ?? null, glow: null, effects: [] };
  }

  /** actor -> stance idle clips for its selected held item (see the header). */
  function stanceFor(selected: string | null, holstered: boolean): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (holstered) return out;
    const socket = sockets.find((s) => isSelected(s, selected));
    const item = socket && itemFor(socket, selected, holstered);
    if (!socket || !item?.stance?.length) return out;
    let names = item.stance;
    if (slotOf(socket) === "offhand") {
      const main = startingOf(socket).find((s) => s.equip && (s.item?.slots ?? []).includes("primary"))?.item?.stance ?? [];
      names = [...main.flatMap((m) => item.stance!.map((o) => m + o)), ...item.stance];
    }
    out.set(socket.parent, names.map((n) => `${n}_Idle`));
    return out;
  }

  return {
    /** Once per frame in edit mode. */
    update(): void {
      const doc = deps.doc();
      let fresh = false;
      if (doc !== cachedDoc) {
        cachedDoc = doc;
        sockets = index(doc);
        fresh = true;
      }
      const dragging = deps.dragging();
      const selected = deps.selected();
      const holstered = deps.showAlt();
      const relook = fresh || selected !== looksFor || holstered !== looksHolstered;
      looksFor = selected;
      looksHolstered = holstered;
      if (relook) stance = stanceFor(selected, holstered);
      for (const socket of sockets) {
        if (relook) {
          const look = lookFor(socket, selected, holstered);
          const key = JSON.stringify(look);
          if (shown.get(socket.id) !== key) {
            shown.set(socket.id, key);
            deps.setLook(socket.id, look);
          }
        }
        if (dragging.includes(socket.id)) continue;
        const object = deps.objectOf(socket.id);
        const parent = object?.parent;
        const p = socket.params;
        const alt = holstered && p.altOffset?.length === 3 && p.altRotationDeg?.length === 3;
        const boneName = alt ? p.altBone || p.bone : p.bone;
        const bone = parent && boneName ? findSocketBone(parent, boneName) : null;
        if (!object || !parent || !bone) continue;
        // the gizmo edits whichever pose is on show; holstered with no second
        // pose yet, it sits in the hand and the first drag makes one
        object.userData["socketPose"] = holstered ? "alt" : "main";
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
    /** actor entity -> the `<Stance>_Idle` clips to stand it in, best first; empty = its own clip. */
    stanceClips(): ReadonlyMap<string, readonly string[]> {
      return stance;
    },
    /** Leaving edit mode (the scripts own it now), or a rebuild: forget what was sent. */
    reset(): void {
      shown.clear();
      cachedDoc = null;
      looksFor = undefined;
      looksHolstered = undefined;
      stance = new Map();
    },
  };
}
