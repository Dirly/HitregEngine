import * as THREE from "three/webgpu";
import { paletteFor, paletteFromMaterial, vfxEffectSchema, type Palette, type VfxEffect } from "@hitreg/core";
import type { VfxFrame } from "./base.js";
import type { VfxHandle, VfxSystem } from "./system.js";

/** Validated `vfx` component data (schema lives in @hitreg/core). */
export interface AmbientVfxData {
  effect: string;
  material?: string | undefined;
  playing: boolean;
  cullDistance: number;
  /**
   * "full" = the play takes the group's whole orientation (an item's frame:
   * emitters turn with a sword); default "yaw" = upright, facing the group's
   * heading (a torch).
   */
  orient?: "yaw" | "full";
  /**
   * Replace every particle emitter's volume half-extents (metres, in the
   * play's frame) — an item effect sized to the blade it runs along.
   */
  shapeSize?: [number, number, number];
}

export interface AmbientVfxOptions {
  /** The `vfx` data asset for an id (validated here; undefined = missing). */
  resolveEffect(assetId: string): unknown | undefined;
  /** Material asset data for an id — its colours become the palette. */
  resolveMaterial?(assetId: string): unknown | undefined;
  /**
   * Register an owned light with the host's point-light budget. Without it,
   * light modules fall back to borrowing VfxSystem's flash slots.
   */
  onLight?(light: THREE.PointLight): void;
}

interface Entry {
  group: THREE.Object3D;
  data: AmbientVfxData;
  frame: VfxFrame;
  handle: VfxHandle | null;
}

/** Hysteresis on the cull radius: start inside it, stop only past this multiple. */
const CULL_HYSTERESIS = 1.1;
const FADE_OUT = 0.5;

const tmpPos = new THREE.Vector3();
const tmpCam = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpDir = new THREE.Vector3();

function inScene(object: THREE.Object3D, scene: THREE.Object3D): boolean {
  let current: THREE.Object3D = object;
  while (current.parent) current = current.parent;
  return current === scene;
}

function hierarchyVisible(object: THREE.Object3D): boolean {
  for (let current: THREE.Object3D | null = object; current; current = current.parent) {
    if (!current.visible) return false;
  }
  return true;
}

/**
 * Standing effects — the `vfx` component. Every entity carrying one plays its
 * effect asset through the shared VfxSystem for as long as it exists: the
 * same modules, pools and particle emitters a spell uses, so a torch is
 * authored (and previewed) with exactly the tools a fireball is.
 *
 * What makes a play "standing" rather than a cast:
 *
 * - **It never ends.** The play's phase length is infinite, so every
 *   `duration: 0` module and every `stream` emitter sustains until stopped.
 * - **It follows the entity.** Anchors are forced to `follow`, and the frame's
 *   origin/direction are the entity's world pose each frame — a torch carried
 *   by a character burns where the hand is.
 * - **Its light is its own.** A `light` module gets a dedicated PointLight
 *   registered with the host's LightBudgetSystem, which (like every authored
 *   light) never enters the renderer's light set itself — so fifty torches
 *   neither steal the four flash slots nor recompile a shader.
 * - **It sleeps out of range.** Past `cullDistance` the play fades out and is
 *   released; the particles it would have simulated cost nothing.
 * - **Its colour is a material.** `material` resolves through
 *   `paletteFromMaterial`, so a module's "primary"/"glow"/"secondary" colour
 *   slots come from an ordinary material asset a human can edit.
 */
export class AmbientVfx {
  private readonly entries = new Map<string, Entry>();
  /** Parsed + follow-forced effect per asset id; null = invalid or missing. */
  private readonly effects = new Map<string, VfxEffect | null>();

  constructor(
    private readonly vfx: VfxSystem,
    private readonly options: AmbientVfxOptions,
  ) {}

  register(entityId: string, group: THREE.Object3D, data: AmbientVfxData): void {
    this.unregister(entityId);
    this.entries.set(entityId, {
      group,
      data,
      frame: {
        origin: [0, 0, 0],
        direction: [0, 0, 1],
        palette: this.paletteOf(data),
        ...(data.orient === "full" ? { basis: new THREE.Quaternion() } : {}),
      },
      handle: null,
    });
  }

  unregister(entityId: string): void {
    const entry = this.entries.get(entityId);
    if (!entry) return;
    entry.handle?.stop(0);
    this.entries.delete(entityId);
  }

  /**
   * A material changed: re-derive the palette of every effect using it (all
   * of them when `materialId` is omitted) and restart those plays, since
   * modules resolve their colours when they begin.
   */
  restyle(materialId?: string): void {
    for (const entry of this.entries.values()) {
      if (materialId !== undefined && entry.data.material !== materialId) continue;
      entry.frame.palette = this.paletteOf(entry.data);
      this.restart(entry);
    }
  }

  /** An effect asset changed: drop its cached parse and restart its plays. */
  reloadEffect(effectId?: string): void {
    if (effectId === undefined) this.effects.clear();
    else this.effects.delete(effectId);
    for (const entry of this.entries.values()) {
      if (effectId === undefined || entry.data.effect === effectId) this.restart(entry);
    }
  }

  /** Once per frame, before VfxSystem.update and before the light budget. */
  update(camera: THREE.Camera, scene: THREE.Object3D): void {
    if (this.entries.size === 0) return;
    camera.getWorldPosition(tmpCam);
    for (const [id, entry] of this.entries) {
      // A streamed cell unloaded, or the scene was rebuilt under us: the
      // group is gone, so is the effect.
      if (!inScene(entry.group, scene)) {
        entry.handle?.stop(0);
        this.entries.delete(id);
        continue;
      }
      entry.group.getWorldPosition(tmpPos);
      const { frame, data } = entry;
      frame.origin[0] = tmpPos.x;
      frame.origin[1] = tmpPos.y;
      frame.origin[2] = tmpPos.z;
      entry.group.getWorldQuaternion(tmpQuat);
      frame.basis?.copy(tmpQuat);
      tmpDir.set(0, 0, 1).applyQuaternion(tmpQuat);
      frame.direction[0] = tmpDir.x;
      frame.direction[1] = 0;
      frame.direction[2] = tmpDir.z;

      const cull = data.cullDistance;
      const reach = entry.handle ? cull * CULL_HYSTERESIS : cull;
      const inRange = cull <= 0 || tmpPos.distanceToSquared(tmpCam) <= reach * reach;
      const wanted = data.playing && inRange && hierarchyVisible(entry.group);
      if (wanted && !entry.handle) {
        entry.handle = this.start(entry);
      } else if (!wanted && entry.handle) {
        entry.handle.stop(FADE_OUT);
        entry.handle = null;
      }
    }
  }

  /** Stop every play at once (scene teardown). */
  clear(): void {
    for (const entry of this.entries.values()) entry.handle?.stop(0);
    this.entries.clear();
  }

  stats(): { registered: number; playing: number } {
    let playing = 0;
    for (const entry of this.entries.values()) if (entry.handle && !entry.handle.done) playing++;
    return { registered: this.entries.size, playing };
  }

  private restart(entry: Entry): void {
    if (!entry.handle) return;
    entry.handle.stop(0);
    entry.handle = null; // the next update starts it again if still wanted
  }

  private paletteOf(data: AmbientVfxData): Palette {
    if (!data.material) return paletteFor("fire");
    const material = this.options.resolveMaterial?.(data.material) as { color?: unknown; emissive?: unknown } | undefined;
    if (!material) console.warn(`[vfx] material "${data.material}" not found; using the fire palette`);
    return paletteFromMaterial(material);
  }

  private effectOf(id: string): VfxEffect | null {
    const cached = this.effects.get(id);
    if (cached !== undefined) return cached;
    const doc = this.options.resolveEffect(id);
    let effect: VfxEffect | null = null;
    if (doc === undefined) {
      console.warn(`[vfx] effect asset "${id}" not found`);
    } else {
      const parsed = vfxEffectSchema.safeParse(doc);
      if (parsed.success) {
        effect = {
          ...parsed.data,
          modules: parsed.data.modules.map((m) => ({ ...m, anchor: { ...m.anchor, follow: true } })),
        };
      } else {
        console.warn(`[vfx] effect asset "${id}" is invalid:`, parsed.error.message);
      }
    }
    // cached either way, so a broken asset warns once instead of every frame
    this.effects.set(id, effect);
    return effect;
  }

  private start(entry: Entry): VfxHandle | null {
    const base = this.effectOf(entry.data.effect);
    if (!base) return null;
    const size = entry.data.shapeSize;
    // sized to what it runs along: a copy with the emitters' volume replaced
    const effect: VfxEffect = size
      ? {
          ...base,
          modules: base.modules.map((m) =>
            m.kind === "particles" ? { ...m, emitter: { ...m.emitter, shapeSize: [size[0], size[1], size[2]] } } : m,
          ),
        }
      : base;
    const onLight = this.options.onLight;
    return this.vfx.play(effect, entry.frame, {
      phaseLength: Number.POSITIVE_INFINITY,
      ...(onLight
        ? {
            ownLight: () => {
              const light = new THREE.PointLight(0xffffff, 0, 8, 2);
              light.name = "vfx-standing-light";
              light.castShadow = false;
              // hidden from birth: the budget re-aims its slots at it, and a
              // visible light entering the set would recompile lit materials
              light.visible = false;
              light.userData["vfx"] = true;
              this.vfx.root.add(light);
              onLight(light);
              return light;
            },
          }
        : {}),
    });
  }
}
