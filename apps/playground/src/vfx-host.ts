import type * as THREE from "three/webgpu";
import {
  paletteFor,
  spellPalette,
  spellSchema,
  vfxEffectSchema,
  type AssetLibrary,
  type Phase,
  type SpritesheetDoc,
} from "@hitreg/core";
import { VfxSystem, loadGltf, type VfxFrame } from "@hitreg/render";
import type { RuntimeVfxFrame, RuntimeVfxHost } from "@hitreg/scripting";

/**
 * The app's side of `ctx.vfx`: one VfxSystem per app, fed the asset library's
 * textures/sheets/models, and an adapter that validates whatever a script
 * hands over (a raw document, a data asset) before the renderer sees it.
 * Shared by the editor (main.ts) and the published runtime (play.ts) so the
 * two cannot drift.
 */
export function createVfx(assets: AssetLibrary): VfxSystem {
  return new VfxSystem({
    texture: (id) => assets.getTexture(id)?.url,
    sheet: (id) => {
      const doc = assets.getDataAsset(id);
      return doc?.type === "spritesheet" ? (doc.data as SpritesheetDoc) : undefined;
    },
    loadModel: async (id) => {
      const url = assets.getModel(id)?.url;
      if (!url) return null;
      try {
        const gltf = await loadGltf(url);
        return gltf.scene as THREE.Object3D;
      } catch (error) {
        console.warn(`[vfx] model "${id}" failed to load`, error);
        return null;
      }
    },
  });
}

/**
 * Compile the VFX pipelines at load instead of on the first cast (see
 * VfxSystem.warmup). Picks any PSX mask and any spritesheet the project has
 * so the textured variants compile too; awaiting is optional.
 */
export function warmVfx(
  vfx: VfxSystem,
  assets: AssetLibrary,
  precompile: (group: THREE.Object3D) => Promise<void>,
  camera?: THREE.Camera,
): Promise<void> {
  const mask = assets.textureIds().find((id) => id.startsWith("fx/masks/"));
  const sheets = assets.dataAssetsOfType("spritesheet").map((d) => d.id);
  const sheet = sheets[0];
  return vfx.warmup(precompile, { ...(mask ? { mask } : {}), ...(sheet ? { sheet } : {}), sheets, ...(camera ? { camera } : {}) });
}

const NEUTRAL = paletteFor("arcane");

export function makeVfxHost(vfx: VfxSystem): RuntimeVfxHost {
  const toFrame = (f: RuntimeVfxFrame, palette: VfxFrame["palette"]): VfxFrame => ({
    origin: f.origin,
    direction: f.direction,
    ...(f.target ? { target: f.target } : {}),
    caster: f.caster ?? null,
    targetObject: f.targetObject ?? null,
    ...(f.socket ? { socket: f.socket } : {}),
    ...(f.ground ? { ground: f.ground } : {}),
    palette: f.palette ?? palette,
  });
  return {
    play: (effect, frame, opts) => {
      const parsed = vfxEffectSchema.safeParse(effect);
      if (!parsed.success) {
        console.warn("[vfx] invalid effect document", parsed.error.message);
        return { stop: () => {}, done: true };
      }
      return vfx.play(parsed.data, toFrame(frame, NEUTRAL), opts);
    },
    playSpell: (spell, frame, opts) => {
      const parsed = spellSchema.safeParse(spell);
      if (!parsed.success) {
        console.warn("[vfx] invalid spell document", parsed.error.message);
        return { stop: () => {}, done: true, time: 0, trigger: () => {}, setPath: () => {} };
      }
      const handle = vfx.playSpell(parsed.data, toFrame(frame, spellPalette(parsed.data)), {
        ...(opts?.manual ? { manual: opts.manual as Phase[] } : {}),
        ...(opts?.at !== undefined ? { at: opts.at } : {}),
      });
      return handle;
    },
    stopAll: (fade) => vfx.stopAll(fade),
    preload: (ids) => vfx.preload(ids),
  };
}
