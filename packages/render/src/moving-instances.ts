import * as THREE from "three/webgpu";
import { InstancedProps } from "./instancing.js";
import { applyModelTextureFilter, type TextureFilter } from "./material-maps.js";
import { cachedInstancedMaterial, extractGltfSubmeshes, loadGltf, type GltfSubmesh } from "./scene-builder.js";
import { modelPartIndex, partBounds, partMaskFromNames, partSize, resolvePartAnchor, type PartAnchor } from "./ubermesh.js";

/**
 * Instanced batches whose instances MOVE — held weapons, worn helms, carried
 * lanterns (`mesh.moving` on a `renderMode: "instanced"` entity).
 *
 * The static instancing path (scene-builder's instanceGltfInto) places each
 * instance ONCE, when the scene builds, and hangs the batch off the scene
 * root. That is right for a forest and useless for a sword in a hand. Here
 * every instance keeps a pointer to its entity's group and re-reads the
 * group's world matrix every frame, so it follows whatever moves the entity (a
 * parent, a `bone-socket`, a script), while every moving instance of one
 * asset stays ONE draw call. Thirty players' swords cost what one does.
 *
 * The look is per instance and never touches a material. `partMask` picks
 * which parts of an ubermesh draw (collapsed in the vertex stage), and
 * `atlasTile` picks which tile of the packed page the model carries. So
 * equipping a different sword changes two attributes, with no texture swap,
 * no material clone and no geometry rebuild. `setLook` takes part NAMES and a
 * theme sheet id and resolves both against the model's own tables (glTF
 * extras: `parts` from unwrap-weapon, `tiles` from the page bake), so an item
 * never carries a raw mask or a UV rectangle.
 *
 * No LOD tiers: a held item is small, it is near the thing holding it, and
 * swapping it for an impostor would cost more than it saves.
 */

export interface MovingInstanceEntry {
  id: string;
  /** The entity's own group — its world matrix IS this instance's placement. */
  group: THREE.Object3D;
  atlasTile?: [number, number, number];
  partMask?: number;
  castShadow: boolean;
  receiveShadow: boolean;
  textureFilter?: TextureFilter;
}

/** A look in model terms: part names or a mask, and a theme sheet id or a raw tile. */
export interface MovingInstanceLook {
  parts?: readonly string[];
  partMask?: number;
  /** A theme sheet's texture asset id, looked up in the model's `tiles` table; null = leave the tile. */
  texture?: string | null;
  atlasTile?: [number, number, number];
  /** Emissive glow; null clears it. Parts by name; omitted parts = every shown part. */
  glow?: MovingInstanceGlow | null;
}

export interface MovingInstanceGlow {
  color: string;
  intensity: number;
  parts?: readonly string[];
  pulse?: { speed: number; min: number };
  noise?: { amount: number; scale: number; flow: number; threshold: number; churn?: number; frameRate?: number };
  /** Fade along the glowing parts' length (model +Y), 0 = base … 1 = tip. */
  fade?: { from: number; to: number };
}

/** Glow as uploaded: colour × intensity, the parts that glow, the pulse. */
interface SlotGlow {
  rgb: [number, number, number];
  mask: number;
  speed: number;
  min: number;
  amount: number;
  scale: number;
  flow: number;
  threshold: number;
  /** Model-space +Y where the fade starts / ends; equal = no fade. */
  fadeStart: number;
  fadeEnd: number;
  churn: number;
  frameRate: number;
}

const NO_GLOW: SlotGlow = {
  rgb: [0, 0, 0], mask: 0, speed: 0, min: 1, amount: 0, scale: 128, flow: 0, threshold: 0.35, fadeStart: 0, fadeEnd: 0, churn: 1, frameRate: 12,
};
const _color = new THREE.Color();

interface Slot {
  id: string;
  group: THREE.Object3D;
  tile: [number, number, number];
  mask: number;
  glow: SlotGlow;
  /** A look asked for before the model loaded (names need the model's tables). */
  pending: MovingInstanceLook | null;
  /** What the GPU holds for this slot's mask: `mask`, or 0 while hidden. */
  uploadedMask: number;
  dirty: boolean;
}

interface Batch {
  assetId: string;
  slots: Slot[];
  meshes: InstancedProps[];
  submeshes: GltfSubmesh[] | null;
  partIndex: Record<string, number> | null;
  tiles: Record<string, [number, number, number]> | null;
  castShadow: boolean;
  receiveShadow: boolean;
}

const WHOLE_MASK = 0xffffff;
const _matrix = new THREE.Matrix4();

export class MovingInstanceSystem {
  /** Add this to the scene being rendered; every batch lives under it. */
  readonly root = new THREE.Group();
  private readonly batches = new Map<string, Batch>();
  private readonly slotOf = new Map<string, { batch: Batch; slot: Slot }>();
  private readonly warned = new Set<string>();

  constructor(private readonly opts: { resolveModel: (assetId: string) => string | undefined }) {
    this.root.name = "moving-instances";
    // the batches draw in world space from their own matrices
    this.root.matrixAutoUpdate = false;
  }

  /** Register (or re-register, after an entity rebuild) one moving instance. */
  add(assetId: string, entry: MovingInstanceEntry): void {
    this.remove(entry.id);
    let batch = this.batches.get(assetId);
    if (!batch) {
      batch = {
        assetId,
        slots: [],
        meshes: [],
        submeshes: null,
        partIndex: null,
        tiles: null,
        castShadow: entry.castShadow,
        receiveShadow: entry.receiveShadow,
      };
      this.batches.set(assetId, batch);
      this.load(batch, entry.textureFilter);
    }
    const slot: Slot = {
      id: entry.id,
      group: entry.group,
      tile: entry.atlasTile ?? [0, 0, 1],
      mask: entry.partMask ?? WHOLE_MASK,
      glow: NO_GLOW,
      pending: null,
      uploadedMask: -1,
      dirty: true,
    };
    batch.slots.push(slot);
    this.slotOf.set(entry.id, { batch, slot });
  }

  has(entityId: string): boolean {
    return this.slotOf.has(entityId);
  }

  remove(entityId: string): void {
    const found = this.slotOf.get(entityId);
    if (!found) return;
    this.slotOf.delete(entityId);
    const { batch, slot } = found;
    const index = batch.slots.indexOf(slot);
    if (index < 0) return;
    // swap-remove keeps the slots dense (instanceCount draws the first N);
    // the slot moved into the hole must re-upload its look at its new index
    const last = batch.slots.pop()!;
    if (last !== slot) {
      batch.slots[index] = last;
      last.dirty = true;
    }
  }

  /** Change an instance's parts and/or theme. False when the entity is not a moving instance. */
  setLook(entityId: string, look: MovingInstanceLook): boolean {
    const found = this.slotOf.get(entityId);
    if (!found) return false;
    const { batch, slot } = found;
    if (!batch.submeshes) {
      // names resolve against the model's tables: hold the look until it loads
      slot.pending = { ...slot.pending, ...look };
      return true;
    }
    this.resolve(batch, slot, look);
    return true;
  }

  /**
   * Once per frame, after animation and before render: follow every entity,
   * drop the ones whose entity left the scene, upload changed looks.
   */
  update(): void {
    const top = topOf(this.root);
    for (const batch of this.batches.values()) {
      for (let i = batch.slots.length - 1; i >= 0; i--) {
        const slot = batch.slots[i]!;
        // a rebuilt or deleted entity's group is no longer under the scene we draw into
        if (topOf(slot.group) !== top) this.remove(slot.id);
      }
      if (!batch.submeshes || batch.meshes.length === 0) continue;
      if (batch.slots.length > batch.meshes[0]!.capacity) this.grow(batch);
      const count = batch.slots.length;
      for (let i = 0; i < count; i++) {
        const slot = batch.slots[i]!;
        const shownMask = visibleInTree(slot.group) ? slot.mask : 0;
        if (shownMask !== slot.uploadedMask) slot.dirty = true;
        slot.group.updateWorldMatrix(true, false);
        for (let s = 0; s < batch.meshes.length; s++) {
          const mesh = batch.meshes[s]!;
          _matrix.multiplyMatrices(slot.group.matrixWorld, batch.submeshes[s]!.localMatrix);
          mesh.setMatrixAt(i, _matrix);
          if (slot.dirty) {
            mesh.setUberAt(i, slot.tile[0], slot.tile[1], slot.tile[2], shownMask);
            mesh.setGlowAt(i, slot.glow);
          }
        }
        slot.uploadedMask = shownMask;
        slot.dirty = false;
      }
      for (const mesh of batch.meshes) {
        mesh.instanceCount = count;
        mesh.instanceMatrix.needsUpdate = true;
        mesh.visible = count > 0;
      }
    }
  }

  /** Batches, live instances and draw calls (one per submesh of a non-empty batch, before shadows). */
  stats(): { batches: number; instances: number; draws: number } {
    let instances = 0;
    let draws = 0;
    for (const batch of this.batches.values()) {
      instances += batch.slots.length;
      if (batch.slots.length > 0) draws += batch.meshes.length;
    }
    return { batches: this.batches.size, instances, draws };
  }

  private load(batch: Batch, filter: TextureFilter | undefined): void {
    const url = this.opts.resolveModel(batch.assetId);
    if (!url) {
      this.warnOnce(`url:${batch.assetId}`, `[moving-instances] no URL for model "${batch.assetId}"`);
      return;
    }
    loadGltf(url).then(
      (gltf) => {
        if (this.batches.get(batch.assetId) !== batch) return;
        // on the shared cached model, before any material is cloned from it
        if (filter) applyModelTextureFilter(gltf.scene, filter);
        const submeshes = extractGltfSubmeshes(gltf, undefined) ?? [];
        batch.partIndex = modelPartIndex(gltf.scene);
        batch.tiles = modelTiles(gltf.scene);
        batch.submeshes = submeshes;
        this.build(batch, Math.max(8, nextPow2(batch.slots.length)));
        for (const slot of batch.slots) {
          if (!slot.pending) continue;
          this.resolve(batch, slot, slot.pending);
          slot.pending = null;
        }
      },
      (error) => console.warn(`[moving-instances] failed to load "${batch.assetId}"`, error),
    );
  }

  private build(batch: Batch, capacity: number): void {
    for (const mesh of batch.meshes) {
      mesh.removeFromParent();
      mesh.dispose();
    }
    batch.meshes = (batch.submeshes ?? []).map((sub, index) => {
      const mesh = new InstancedProps(
        sub.geometry,
        cachedInstancedMaterial(`${batch.assetId}#moving#${index}`, sub.material, { uber: true, glow: true }),
        capacity,
      );
      // capacity is fixed per InstancedProps, so the batch is rebuilt larger
      // when it fills (see grow); the count drawn is set every frame
      mesh.instanceCount = 0;
      mesh.name = `moving:${batch.assetId}#${index}`;
      mesh.castShadow = batch.castShadow;
      mesh.receiveShadow = batch.receiveShadow;
      // every instance moves every frame; a culling volume would be stale by
      // the next one, and a handful of held items is cheaper to draw than to cull
      mesh.frustumCulled = false;
      mesh.enableUber();
      mesh.enableGlow();
      this.root.add(mesh);
      return mesh;
    });
    for (const slot of batch.slots) slot.dirty = true;
  }

  private grow(batch: Batch): void {
    this.build(batch, nextPow2(batch.slots.length * 2));
  }

  private resolve(batch: Batch, slot: Slot, look: MovingInstanceLook): void {
    if (look.parts) {
      if (!batch.partIndex) {
        this.warnOnce(`idx:${batch.assetId}`, `[moving-instances] "${batch.assetId}" has no part table — re-export it with unwrap-weapon`);
      } else {
        const { mask, missing } = partMaskFromNames(batch.partIndex, look.parts);
        if (missing.length) this.warnOnce(`miss:${batch.assetId}:${missing.join()}`, `[moving-instances] no part(s) ${missing.join(", ")} in "${batch.assetId}"`);
        slot.mask = mask;
      }
    } else if (look.partMask !== undefined) {
      slot.mask = look.partMask;
    }
    if (look.atlasTile) {
      slot.tile = look.atlasTile;
    } else if (look.texture) {
      const tile = batch.tiles?.[look.texture];
      if (tile) slot.tile = tile;
      else
        this.warnOnce(
          `tile:${batch.assetId}:${look.texture}`,
          `[moving-instances] "${look.texture}" is not on "${batch.assetId}"'s page — pack it (atlas-pack) and re-bake the model`,
        );
    }
    if (look.glow === null) {
      slot.glow = NO_GLOW;
    } else if (look.glow) {
      const g = look.glow;
      _color.set(g.color);
      let mask = WHOLE_MASK;
      if (g.parts && batch.partIndex) mask = partMaskFromNames(batch.partIndex, g.parts).mask;
      slot.glow = {
        rgb: [_color.r * g.intensity, _color.g * g.intensity, _color.b * g.intensity],
        mask,
        speed: g.pulse?.speed ?? 0,
        min: g.pulse?.min ?? 1,
        amount: g.noise?.amount ?? 0,
        scale: g.noise?.scale ?? 128,
        flow: g.noise?.flow ?? 0,
        threshold: g.noise?.threshold ?? 0.35,
        churn: g.noise?.churn ?? 1,
        frameRate: g.noise?.frameRate ?? 12,
        ...this.fadeRange(batch, mask === WHOLE_MASK ? slot.mask : mask, g.fade),
      };
    }
    slot.dirty = true;
  }

  /** The fade as a model-space +Y range over the glowing parts' box (equal ends = no fade). */
  private fadeRange(batch: Batch, mask: number, fade: MovingInstanceGlow["fade"]): { fadeStart: number; fadeEnd: number } {
    if (!fade || !batch.submeshes) return { fadeStart: 0, fadeEnd: 0 };
    const box = new THREE.Box3();
    for (const sub of batch.submeshes) {
      for (const [bit, b] of partBounds(sub.geometry)) if (mask & (1 << bit)) box.union(b);
    }
    if (box.isEmpty()) return { fadeStart: 0, fadeEnd: 0 };
    const length = box.max.y - box.min.y;
    const start = box.min.y + length * fade.from;
    let end = box.min.y + length * fade.to;
    // a zero-width fade would read as "none": give it a hair of width
    if (Math.abs(end - start) < 1e-4) end = start + 1e-3;
    return { fadeStart: start, fadeEnd: end };
  }

  /**
   * A point on this entity's item, in the ENTITY GROUP's local space (the
   * space an effect's anchor object is placed in). Null until the model has
   * loaded, or when the part is unknown.
   */
  anchorOf(entityId: string, anchor: PartAnchor): THREE.Vector3 | null {
    const found = this.slotOf.get(entityId);
    if (!found?.batch.submeshes) return null;
    const { batch, slot } = found;
    const submeshes = batch.submeshes!;
    for (const sub of submeshes) {
      if (!sub.geometry.getAttribute("uv1") && submeshes.length > 1) continue;
      const point = resolvePartAnchor(sub.geometry, batch.partIndex, anchor, slot.mask);
      if (point) return point.applyMatrix4(sub.localMatrix);
    }
    return null;
  }

  /**
   * Where a hand holds this item, in the entity GROUP's local space: the
   * centre of its grip part (a part named handle / haft / grip / shaft —
   * "GreataxeHaft", "Handle"), else the centre of everything shown (a
   * shield). The model's own origin is wherever the modeller left it, so an
   * editor rotating a held item needs this as its pivot, or the axe swings
   * round a point off the end of its head. Null until the model has loaded.
   */
  gripOf(entityId: string): THREE.Vector3 | null {
    const found = this.slotOf.get(entityId);
    if (!found?.batch.submeshes) return null;
    const grip = Object.keys(found.batch.partIndex ?? {}).find((name) => /handle|haft|grip|shaft/i.test(name));
    return this.anchorOf(entityId, grip ? { part: grip, at: "center" } : { at: "center" });
  }

  /** A part's box size in the entity GROUP's local units (every shown part when omitted); null until loaded. */
  sizeOf(entityId: string, part: string | undefined): THREE.Vector3 | null {
    const found = this.slotOf.get(entityId);
    if (!found?.batch.submeshes) return null;
    const { batch, slot } = found;
    for (const sub of batch.submeshes!) {
      const size = partSize(sub.geometry, batch.partIndex, part, slot.mask);
      if (size) return size.multiply(new THREE.Vector3().setFromMatrixScale(sub.localMatrix));
    }
    return null;
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    console.warn(message);
  }
}

function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

function topOf(object: THREE.Object3D): THREE.Object3D {
  let node = object;
  while (node.parent) node = node.parent;
  return node;
}

function visibleInTree(object: THREE.Object3D): boolean {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}

/** `{ themeSheetId: [u, v, scale] }` — the page's tile table, baked into the model's glTF extras. */
function modelTiles(root: THREE.Object3D): Record<string, [number, number, number]> | null {
  let found: Record<string, [number, number, number]> | null = null;
  root.traverse((node) => {
    if (!found && node.userData["tiles"] && typeof node.userData["tiles"] === "object") {
      found = node.userData["tiles"] as Record<string, [number, number, number]>;
    }
  });
  return found;
}
