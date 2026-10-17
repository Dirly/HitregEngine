/**
 * PROP EDIT — the owner fixes placed props where he sees them, and the fix survives every re-install.
 *
 * A small panel over the viewport whenever the selection is a PLACED PROP: a dressed prop (tag `dress:<plan>`, put
 * there by `dress apply`) or a catalogued prop an installer placed (a lantern, a brazier). Works in edit mode and in
 * the paused game (`~`), so a fault seen while walking is fixed on the spot. Every action is an ordinary ops batch on
 * the scene store (undo/redo as always); the gizmo, Delete and Ctrl+D act on the same props.
 *
 * Every owner change to a placed prop — from this panel, the gizmo, the inspector, Delete, Ctrl+D, undo/redo — is ALSO
 * reported to the dev server (POST /__hitreg/owner-edit), which writes it as an OWNER OVERRIDE on what placed it
 * (packages/core dressing/owner.ts). Changes that arrive from disk (live-sync: an agent's `dress apply`) are not the
 * owner's and are never reported. Keys while a placed prop is selected: G drop to surface, [ / ] turn 15° (Shift 5°).
 */
import * as THREE from "three/webgpu";
import {
  defaultSeatContact,
  DRESSING_VOCABULARY,
  entityOwnerState,
  ownerScaleRange,
  sameOwnerTransform,
  seatObject,
  type Op,
  type OwnerTransform,
  type SceneDoc,
  type SceneStore,
  type SeatContact,
  type SolidProbe,
} from "@hitreg/core";
import type { Observable, PlayMode, Selection } from "@hitreg/editor";
import { rankSwaps, type SwapRow } from "./prop-swap-rank.js";

export interface PropEditOptions {
  store: SceneStore;
  selection: Selection;
  playMode: Observable<PlayMode>;
  /** The editor overlay is showing (edit mode, or the paused game). */
  editorVisible: Observable<boolean>;
  getObject(id: string): THREE.Object3D | undefined;
  getScene(): THREE.Scene;
  /** The project the open scene belongs to (null = the flat assets tree). */
  project(): string | null;
  /** Scenes that are editor workspaces, never content (prefab / chunk isolation). */
  isWorkspaceScene?(name: string): boolean;
  /** The editor's dock sizes: the panel sits at the bottom of the free viewport, above the assets dock. */
  dockSizes?: Observable<{ top: number; left: number; right: number; bottom: number }>;
  /**
   * A downward ray against the PHYSICS world, ignoring the prop's own colliders: the hit height, null for none, or
   * undefined when there is no physics world (edit mode) — the render meshes answer then.
   */
  raycastDown?(x: number, y: number, z: number, far: number, ownId: string): number | null | undefined;
}

interface CatalogProp {
  id: string;
  mount?: string;
  size?: [number, number, number];
  category?: string;
  scale?: string;
  cultures?: string[];
  setting?: string;
  contact?: SeatContact;
}
type Kinds = Record<string, { match: string; dim: "h" | "long" | "max"; range: [number, number] }>;
interface Info {
  owner: "plan" | "scene";
  plan?: string;
  item?: string;
  planned?: boolean;
  file?: string | null;
  space?: { scale?: string; cultures?: string[] };
  override?: { reasons: string[]; deleted?: boolean; added?: boolean } | null;
  error?: string;
}

const T = {
  canvas: "#0b0e14", surface: "#161b22", raised: "#21262d", border: "#30363d",
  text: "#c9d1d9", emphasis: "#e6edf3", muted: "#8b949e", selection: "#1f3a5f", entity: "#79c0ff", component: "#d2a8ff",
};
const FONT = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
const DROP_REACH = 6;
const isTyping = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

export function mountPropEdit(opts: PropEditOptions): { onTranslateMove(id: string, object: THREE.Object3D): void; dispose(): void } {
  const { store, selection } = opts;
  const disposers: (() => void)[] = [];

  // ---- catalogue (per project) -------------------------------------------------------------
  let catalogFor = "";
  let catalog = new Map<string, CatalogProp>();
  let kinds: Kinds = {};
  async function loadCatalog(): Promise<void> {
    const project = opts.project();
    if (!project || project === catalogFor) return;
    catalogFor = project;
    try {
      const r = await fetch(`/__hitreg/owner-edit?catalog=${encodeURIComponent(project)}`);
      const j = (await r.json()) as { props?: CatalogProp[]; kinds?: Kinds };
      catalog = new Map((j.props ?? []).map((p) => [p.id, p]));
      kinds = j.kinds ?? {};
      render();
    } catch (error) {
      console.warn("[prop-edit] catalogue:", error);
    }
  }

  const prefabOf = (e: SceneDoc["entities"][string] | undefined): string => ((e?.components["prefab"] as { prefabId?: string } | undefined)?.prefabId ?? "");
  const planOf = (e: SceneDoc["entities"][string] | undefined): string => (e?.tags ?? []).find((t) => t.startsWith("dress:"))?.slice("dress:".length) ?? "";
  /** A placed prop: dressed by a plan, or a catalogued prefab instance in a content scene. */
  function tracked(e: SceneDoc["entities"][string] | undefined): boolean {
    if (!e) return false;
    if (opts.isWorkspaceScene?.(store.doc.name)) return false;
    if (planOf(e)) return !!prefabOf(e);
    return catalog.has(prefabOf(e));
  }

  // ---- recording: owner edits -> /__hitreg/owner-edit ----------------------------------------
  let prev = store.doc;
  const queue = new Map<string, { entity: string; tags: string[]; name: string; parent: string | null; before: OwnerTransform | null; after: OwnerTransform | null }>();
  let flushTimer = 0;
  let lastSaved = "";
  disposers.push(
    store.subscribe((change) => {
      const before = prev;
      prev = store.doc;
      if (change.kind !== "ops" || change.origin) return; // replace / live-sync from disk: not the owner's
      if (before.name !== store.doc.name || opts.isWorkspaceScene?.(store.doc.name)) return;
      const r = change.result;
      for (const id of new Set([...r.changedEntities, ...r.addedEntities, ...r.removedEntities])) {
        const eb = before.entities[id], ea = store.doc.entities[id];
        if (!tracked(eb) && !tracked(ea)) continue;
        const sb = eb ? entityOwnerState(eb) : null, sa = ea ? entityOwnerState(ea) : null;
        if (sb && sa && sameOwnerTransform(sa, sb) && sa.prop === sb.prop) continue;
        const e = (ea ?? eb)!;
        const q = queue.get(id);
        queue.set(id, { entity: id, tags: e.tags ?? [], name: e.name ?? "", parent: e.parent ?? null, before: q ? q.before : sb, after: sa });
      }
      if (queue.size) {
        clearTimeout(flushTimer);
        flushTimer = window.setTimeout(flush, 400);
      }
    }),
  );
  async function flush(): Promise<void> {
    if (!queue.size) return;
    const edits = [...queue.values()];
    queue.clear();
    try {
      const r = await fetch("/__hitreg/owner-edit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scene: store.doc.name, edits }) });
      const j = (await r.json()) as { ok: boolean; error?: string; results?: { item: string; file: string; reasons: string[]; removed?: boolean }[] };
      if (!j.ok) throw new Error(j.error);
      const last = j.results?.[j.results.length - 1];
      lastSaved = last ? (last.removed ? `back to the agent's placement — override cleared (${last.file})` : `kept as owner override: ${last.reasons.join(", ") || "edited"} → ${last.file}`) : "";
      void refreshInfo();
    } catch (error) {
      lastSaved = `NOT kept: ${String(error)}`;
      console.warn("[prop-edit] owner-edit:", error);
      render();
    }
  }

  // ---- surface probe (the seat rule, against what is rendered) -------------------------------------
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const isGizmo = (o: THREE.Object3D): boolean => {
    for (let a: THREE.Object3D | null = o; a; a = a.parent) {
      const f = a as unknown as Record<string, unknown>;
      if (f["isTransformControlsGizmo"] || f["isTransformControlsPlane"] || f["isTransformControlsRoot"] || a.userData["editorHelper"]) return true;
    }
    return false;
  };
  /**
   * Meshes that can carry a prop over the plan rectangle [x0..x1]x[z0..z1] between heights lo..hi: visible, not the prop
   * itself, not editor helpers — filtered by their WORLD bounding box first, so a ray never walks the triangles of a
   * mesh on the other side of the map (a full-scene ray stalled a frame for seconds).
   */
  function surfaces(exclude: THREE.Object3D, x0: number, x1: number, z0: number, z1: number, lo: number, hi: number): THREE.Object3D[] {
    const skip = new Set<THREE.Object3D>();
    exclude.traverse((o) => skip.add(o));
    const out: THREE.Object3D[] = [];
    const box = new THREE.Box3();
    opts.getScene().traverse((o) => {
      const m = o as THREE.Mesh & { isInstancedMesh?: boolean; computeBoundingBox?: () => void; boundingBox?: THREE.Box3 | null };
      if (!m.isMesh || skip.has(o) || !m.geometry || (o as unknown as { isSprite?: boolean }).isSprite) return;
      if (m.isInstancedMesh) {
        if (!m.boundingBox) m.computeBoundingBox?.();
        if (!m.boundingBox) return;
        box.copy(m.boundingBox);
      } else {
        if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
        box.copy(m.geometry.boundingBox!);
      }
      box.applyMatrix4(m.matrixWorld);
      if (box.max.x < x0 || box.min.x > x1 || box.max.z < z0 || box.min.z > z1 || box.max.y < lo || box.min.y > hi) return;
      if (isGizmo(o)) return;
      out.push(o);
    });
    return out;
  }
  const instMat = new THREE.Matrix4();
  const instPos = new THREE.Vector3();
  /**
   * The prop's own body: a pooled prop is drawn by a shared InstancedMesh outside its entity, so a hit on an instance
   * standing inside the prop's own box is the prop itself (its bottom face would read as "already on the surface").
   */
  function ownInstance(hit: THREE.Intersection, own: THREE.Box3 | null): boolean {
    const m = hit.object as THREE.InstancedMesh & { isBatchedMesh?: boolean };
    // the editor's static batches merge the prop into a shared mesh outside its entity: anything inside the prop's own
    // box above its base is the prop itself (Drop to surface asks the physics world, which excludes the prop by id, so a
    // floor it is sunk into is found there; this render fallback serves the drag snap)
    if (own && own.containsPoint(hit.point) && hit.point.y > own.min.y + 0.08) return true;
    if (!own) return false;
    if (!m.isInstancedMesh || hit.instanceId === undefined) return false;
    m.getMatrixAt(hit.instanceId, instMat);
    instPos.setFromMatrixPosition(instMat.premultiply(m.matrixWorld));
    return own.containsPoint(instPos) && hit.point.y > own.min.y + 0.08;
  }
  function probeOf(list: THREE.Object3D[], ownId: string, own: THREE.Box3 | null = null): SolidProbe {
    return {
      floor(x, z, hi, lo) {
        // the physics world answers when there is one (the paused game): colliders, not render meshes
        const phys = opts.raycastDown?.(x, hi, z, Math.max(0, hi - lo), ownId);
        if (phys !== undefined) return phys;
        ray.set(new THREE.Vector3(x, hi, z), down);
        ray.near = 0;
        ray.far = Math.max(0, hi - lo);
        for (const hit of ray.intersectObjects(list, false)) if (!ownInstance(hit, own)) return hit.point.y;
        return null;
      },
    };
  }

  /** The seat of a placed prop on what is under it now: the y its ORIGIN should have, or why not. */
  function seatOf(id: string, object: THREE.Object3D): { dy: number } | { why: string } {
    const prop = prefabOf(store.doc.entities[id]);
    const rec = catalog.get(prop);
    const contact = defaultSeatContact(rec as never, prop);
    if (contact === "hang" || contact === "wall") return { why: `a ${contact === "hang" ? "hanging" : "wall"} prop: drop to surface is for things that stand` };
    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return { why: "not loaded yet" };
    const c = box.getCenter(new THREE.Vector3());
    const list = surfaces(object, box.min.x - 0.1, box.max.x + 0.1, box.min.z - 0.1, box.max.z + 0.1, box.min.y - DROP_REACH, box.max.y + 1);
    const res = seatObject(
      probeOf(list, id, box.clone().expandByScalar(0.05)),
      { x: c.x, z: c.z, y: box.min.y, halfX: (box.max.x - box.min.x) / 2, halfZ: (box.max.z - box.min.z) / 2, height: box.max.y - box.min.y },
      contact,
      // reachUp: a prop sunk into the floor is LIFTED onto it (the old 0.6 m look-up missed a deep sink and pushed it down)
      { reachDown: DROP_REACH, reachUp: "height" },
    );
    console.debug(`[prop-edit] seat ${id} ${contact} ${JSON.stringify({ min: box.min.toArray(), max: box.max.toArray(), surfaces: list.length, res })}`);
    if (res.y === null) return { why: `nothing to stand on within ${DROP_REACH} m (${res.reason ?? res.status})` };
    return { dy: res.y - box.min.y };
  }

  /** Move an entity's ORIGIN by a world delta, written in its parent's frame. */
  function translateOps(id: string, object: THREE.Object3D, world: THREE.Vector3): Op[] {
    const e = store.doc.entities[id]!;
    const t = (e.components["transform"] ?? {}) as { position?: number[]; rotation?: number[]; scale?: number[] };
    const wp = object.getWorldPosition(new THREE.Vector3()).add(world);
    const local = object.parent ? object.parent.worldToLocal(wp) : wp;
    return [{ op: "set-component", id, component: "transform", data: { ...t, position: local.toArray().map((v) => +v.toFixed(4)) } }];
  }

  async function drop(target?: string): Promise<void> {
    const id = target ?? selection.get();
    const object = id ? opts.getObject(id) : undefined;
    if (!id || !tracked(store.doc.entities[id])) return;
    if (opts.raycastDown?.(0, 0, 0, 0, id) === undefined) {
      // no physics world (edit mode): the dev server seats it on the same solid `dress apply` uses (DC floors, decks,
      // colliders, the field) — render meshes are batched and culled, so they are not the truth
      note("seating on the real floor…");
      const t = store.doc.entities[id]!.components["transform"] as Record<string, unknown>;
      try {
        const r = await fetch("/__hitreg/owner-edit?seat=1", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scene: store.doc.name, entity: id, transform: t, entityDoc: store.doc.entities[id] }) });
        const j = (await r.json()) as { ok: boolean; position?: number[]; dy?: number; why?: string };
        if (!j.ok || !j.position) return note(j.why ?? "could not seat it");
        if (Math.abs(j.dy ?? 0) < 0.005) return note("already on the surface");
        const cur = store.doc.entities[id]?.components["transform"] as Record<string, unknown> | undefined;
        if (!cur) return;
        store.apply([{ op: "set-component", id, component: "transform", data: { ...cur, position: j.position.map((v) => +v.toFixed(4)) } }]);
        return note(`dropped ${(j.dy ?? 0) < 0 ? "down" : "up"} ${Math.abs(j.dy ?? 0).toFixed(2)} m onto the surface`);
      } catch (error) {
        return note(`could not seat it: ${String(error)}`);
      }
    }
    if (!object) return note("not built yet: press G to drop it");
    const s = seatOf(id, object);
    if ("why" in s) return note(s.why);
    if (Math.abs(s.dy) < 0.005) return note("already on the surface");
    store.apply(translateOps(id, object, new THREE.Vector3(0, s.dy, 0)));
    note(`dropped ${s.dy < 0 ? "down" : "up"} ${Math.abs(s.dy).toFixed(2)} m onto the surface`);
  }

  // snap while dragging: the centre ray only (cheap), the full seat on G
  let snap = false;
  let dragList: { at: THREE.Vector3; list: THREE.Object3D[] } | null = null;
  function onTranslateMove(id: string, object: THREE.Object3D): void {
    if (!snap || !tracked(store.doc.entities[id])) return;
    object.updateWorldMatrix(true, true);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    if (!dragList || dragList.at.distanceTo(c) > 4) dragList = { at: c.clone(), list: surfaces(object, c.x - 5, c.x + 5, c.z - 5, c.z + 5, c.y - DROP_REACH - 5, c.y + 6) };
    const y = probeOf(dragList.list, id, box.clone().expandByScalar(0.05)).floor(c.x, c.z, box.max.y + 1.5, box.min.y - DROP_REACH);
    if (y === null) return;
    const w = object.getWorldPosition(new THREE.Vector3());
    w.y += y - box.min.y - 0.03;
    object.position.copy(object.parent ? object.parent.worldToLocal(w) : w);
  }

  function turn(deg: number): void {
    const id = selection.get();
    const e = id ? store.doc.entities[id] : undefined;
    if (!id || !tracked(e)) return;
    const t = (e!.components["transform"] ?? {}) as { rotation?: number[] };
    const q = new THREE.Quaternion().fromArray((t.rotation ?? [0, 0, 0, 1]) as number[]);
    q.premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), (deg * Math.PI) / 180));
    store.apply([{ op: "set-component", id, component: "transform", data: { ...t, rotation: q.toArray().map((v) => +v.toFixed(6)) } }]);
  }

  function scaleRange(prop: string): { min: number; max: number; kind: string | null } {
    const rec = catalog.get(prop);
    const sc = info?.space?.scale ?? rec?.scale;
    const cls = DRESSING_VOCABULARY.scales.find((s) => s.id === sc);
    const factor = cls && cls.height > 0 ? cls.height / 1.8 : 1;
    return ownerScaleRange(prop, rec?.size, kinds, factor);
  }
  function setScale(v: number): void {
    const id = selection.get();
    const e = id ? store.doc.entities[id] : undefined;
    if (!id || !tracked(e)) return;
    const r = scaleRange(prefabOf(e));
    const k = Math.min(r.max, Math.max(r.min, v));
    const t = (e!.components["transform"] ?? {}) as Record<string, unknown>;
    store.apply([{ op: "set-component", id, component: "transform", data: { ...t, scale: [k, k, k] } }]);
  }

  function swap(prop: string): void {
    const id = selection.get();
    const e = id ? store.doc.entities[id] : undefined;
    if (!id || !e || !tracked(e)) return;
    // overrides/props of the old prefab name its own parts: a swapped prop starts clean
    const ops: Op[] = [{ op: "set-component", id, component: "prefab", data: { prefabId: prop } }];
    const item = (e.name ?? "").split(": ")[0];
    if (item && (e.name ?? "").includes(": ")) ops.push({ op: "rename", id, name: `${item}: ${prop}` });
    store.apply(ops);
    picker = false;
    note(`swapped for ${prop}`);
  }

  function duplicate(): void {
    const id = selection.get();
    const e = id ? store.doc.entities[id] : undefined;
    if (!id || !e || !tracked(e)) return;
    const tag = Date.now().toString(36);
    const plan = planOf(e);
    const newId = plan ? `dress-${plan.replace(/\//g, "--")}-owner-${tag}` : `${id}-owner-${tag}`;
    const t = (e.components["transform"] ?? {}) as { position?: number[] };
    const p = t.position ?? [0, 0, 0];
    const comps = structuredClone(e.components) as Record<string, unknown>;
    comps["transform"] = { ...(comps["transform"] as object), position: [p[0]! + 0.6, p[1]!, p[2]!] };
    store.apply([{ op: "add-entity", id: newId, entity: { name: plan ? `owner-${tag}: ${prefabOf(e)}` : `${e.name ?? id} (owner copy)`, parent: e.parent ?? null, tags: [...(e.tags ?? [])], components: comps } }]);
    selection.set(newId);
    // seat the copy where it lands (0.6 m over, the ground may step): once the scene has built its object
    setTimeout(() => void drop(newId), 150);
  }

  function remove(): void {
    const id = selection.get();
    if (!id || !tracked(store.doc.entities[id])) return;
    store.apply([{ op: "remove-entity", id }]);
    selection.set(null);
  }

  // ---- panel ----------------------------------------------------------------------------
  const root = document.createElement("div");
  root.id = "hg-prop-edit";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Placed prop");
  Object.assign(root.style, {
    position: "fixed", left: "50%", bottom: "12px", transform: "translateX(-50%)", zIndex: "950", display: "none",
    background: T.canvas, border: `1px solid ${T.border}`, borderRadius: "4px", color: T.text, font: FONT,
    padding: "8px 10px", width: "min(720px, calc(100vw - 32px))", boxSizing: "border-box", pointerEvents: "auto",
  } satisfies Partial<CSSStyleDeclaration>);
  const place = (): void => {
    const d = opts.dockSizes?.get();
    const w = Math.max(320, window.innerWidth - (d ? d.left + d.right : 0) - 24);
    root.style.left = d ? `${d.left + (window.innerWidth - d.left - d.right) / 2}px` : "50%";
    root.style.bottom = `${(d?.bottom ?? 0) + 12}px`;
    root.style.width = `min(720px, ${w}px)`;
  };
  place();
  if (opts.dockSizes) disposers.push(opts.dockSizes.subscribe(place));
  window.addEventListener("resize", place);
  disposers.push(() => window.removeEventListener("resize", place));
  document.body.appendChild(root);
  disposers.push(() => root.remove());

  let info: Info | null = null;
  let infoFor = "";
  let message = "";
  let picker = false;
  let filter = "";
  function note(text: string): void {
    message = text;
    render();
  }
  async function refreshInfo(): Promise<void> {
    const id = selection.get();
    const e = id ? store.doc.entities[id] : undefined;
    if (!id || !e || !tracked(e)) {
      info = null;
      infoFor = "";
      return render();
    }
    infoFor = id;
    try {
      const q = new URLSearchParams({ scene: store.doc.name, entity: id, tags: (e.tags ?? []).join(","), name: e.name ?? "" });
      const r = await fetch(`/__hitreg/owner-edit?${q}`);
      const j = (await r.json()) as Info & { ok: boolean };
      if (infoFor === id) info = j;
    } catch {
      info = null;
    }
    render();
  }

  const button = (label: string, key: string, title: string, run: () => void, active = false): HTMLButtonElement => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = key ? `${label}  ${key}` : label;
    b.title = title;
    b.setAttribute("aria-label", title);
    if (active) b.setAttribute("aria-pressed", "true");
    Object.assign(b.style, {
      background: active ? T.selection : T.raised, border: `1px solid ${active ? T.entity : T.border}`, borderRadius: "3px",
      color: active ? T.emphasis : T.text, cursor: "pointer", font: FONT, padding: "4px 8px", whiteSpace: "nowrap",
    } satisfies Partial<CSSStyleDeclaration>);
    b.addEventListener("click", (ev) => { ev.stopPropagation(); run(); });
    return b;
  };
  const span = (text: string, color = T.text): HTMLSpanElement => {
    const s = document.createElement("span");
    s.textContent = text;
    s.style.color = color;
    return s;
  };

  function swapCandidates(current: string): SwapRow[] {
    // size first (+-50%), then category + mount, then culture (src/prop-swap-rank.ts)
    return rankSwaps(catalog.values(), current, info?.space ?? {}, filter);
  }

  function render(): void {
    const id = selection.get();
    const e = id ? store.doc.entities[id] : undefined;
    const show = opts.editorVisible.get() && !!id && tracked(e);
    root.style.display = show ? "block" : "none";
    if (!show) return;
    const prop = prefabOf(e);
    root.replaceChildren();
    // row 1: what it is and who placed it
    const head = document.createElement("div");
    Object.assign(head.style, { display: "flex", gap: "10px", alignItems: "baseline", flexWrap: "wrap", marginBottom: "6px" });
    head.append(span("◆ PLACED PROP", T.entity), span(prop, T.emphasis));
    const plan = planOf(e);
    head.append(span(plan ? `plan ${plan} · item ${info?.item ?? "…"}${info && info.planned === false ? " (owner-added)" : ""}` : "installer / scene prop", T.muted));
    const ov = info?.override;
    head.append(span(ov ? `■ owner override: ${ov.reasons.join(", ") || "kept"}` : "□ as the agent placed it", ov ? T.component : T.muted));
    root.append(head);
    // row 2: actions
    const row = document.createElement("div");
    Object.assign(row.style, { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" });
    const t = (e!.components["transform"] ?? {}) as { scale?: number[] };
    const range = scaleRange(prop);
    const scaleIn = document.createElement("input");
    scaleIn.type = "range";
    scaleIn.min = String(range.min);
    scaleIn.max = String(range.max);
    scaleIn.step = "0.01";
    scaleIn.value = String(t.scale?.[0] ?? 1);
    scaleIn.disabled = range.min === range.max;
    scaleIn.setAttribute("aria-label", `Scale, ${range.min} to ${range.max}${range.kind ? ` (real size of a ${range.kind})` : ""}`);
    scaleIn.style.width = "90px";
    scaleIn.addEventListener("change", () => setScale(+scaleIn.value));
    row.append(
      button("Drop to surface", "G", "Drop to surface (G): seat it on what is under it", () => void drop()),
      button(snap ? "Snap: on" : "Snap: off", "", "Snap to the surface while dragging with the gizmo", () => { snap = !snap; dragList = null; render(); }, snap),
      button("⟲ 15°", "[", "Turn left 15° ([; Shift = 5°)", () => turn(15)),
      button("⟳ 15°", "]", "Turn right 15° (]; Shift = 5°)", () => turn(-15)),
      span(`scale ${(t.scale?.[0] ?? 1).toFixed(2)}`, T.muted),
      scaleIn,
      span(`${range.min}–${range.max}${range.kind ? ` (${range.kind})` : ""}`, T.muted),
      button("Swap…", "", "Swap for another catalogue prop (same size, then sort and mount, then culture first)", () => { picker = !picker; render(); }, picker),
      button("Duplicate", "", "Duplicate (kept as an owner-added prop)", duplicate),
      button("Delete", "Del", "Delete (never re-added by a re-dress)", remove),
    );
    root.append(row);
    if (picker) {
      const box = document.createElement("div");
      Object.assign(box.style, { marginTop: "6px", borderTop: `1px solid ${T.border}`, paddingTop: "6px" });
      const search = document.createElement("input");
      search.type = "search";
      search.placeholder = "filter props…";
      search.value = filter;
      search.setAttribute("aria-label", "Filter swap candidates");
      Object.assign(search.style, { background: T.surface, border: `1px solid ${T.border}`, color: T.text, font: FONT, padding: "3px 6px", width: "220px" });
      search.addEventListener("input", () => { filter = search.value; renderList(); search.focus(); });
      const list = document.createElement("div");
      list.setAttribute("role", "listbox");
      Object.assign(list.style, { maxHeight: "180px", overflowY: "auto", marginTop: "4px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "2px" });
      const renderList = (): void => {
        list.replaceChildren(
          ...swapCandidates(prop).map((c) => {
            const b = button(`${c.fits && c.sizeOk ? "✓" : "·"} ${c.id}${c.why ? ` (${c.why})` : ""}`, "", c.why ? `Swap for ${c.id}: ${c.why}` : `Swap for ${c.id}: same size and sort, fits this place`, () => swap(c.id));
            b.setAttribute("role", "option");
            b.style.textAlign = "left";
            b.style.overflow = "hidden";
            b.style.textOverflow = "ellipsis";
            if (!c.fits) b.style.color = T.muted;
            return b;
          }),
        );
      };
      renderList();
      box.append(search, list);
      root.append(box);
    }
    if (message || lastSaved) {
      const foot = document.createElement("div");
      Object.assign(foot.style, { marginTop: "6px", color: T.muted });
      foot.textContent = [message, lastSaved].filter(Boolean).join("  ·  ");
      root.append(foot);
    }
  }

  const onKey = (ev: KeyboardEvent): void => {
    if (!opts.editorVisible.get() || isTyping(ev.target) || ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const id = selection.get();
    if (!id || !tracked(store.doc.entities[id])) return;
    if (ev.code === "KeyG") { void drop(); ev.preventDefault(); }
    else if (ev.code === "BracketLeft") { turn(ev.shiftKey ? 5 : 15); ev.preventDefault(); }
    else if (ev.code === "BracketRight") { turn(ev.shiftKey ? -5 : -15); ev.preventDefault(); }
  };
  window.addEventListener("keydown", onKey);
  disposers.push(() => window.removeEventListener("keydown", onKey));

  disposers.push(selection.subscribe(() => { message = ""; picker = false; void loadCatalog(); void refreshInfo(); }));
  disposers.push(opts.editorVisible.subscribe(() => render()));
  disposers.push(store.subscribe(() => { if (opts.project() !== catalogFor) void loadCatalog(); render(); }));
  void loadCatalog();

  return {
    onTranslateMove,
    dispose(): void {
      clearTimeout(flushTimer);
      void flush();
      for (const d of disposers) d();
    },
  };
}
