import type * as THREE from "three/webgpu";
import {
  paletteFor,
  spellPalette,
  spellSchema,
  vfxEffectSchema,
  type AssetLibrary,
  type Phase,
  type SpellDoc,
  type SpritesheetDoc,
  type VfxEffect,
} from "@hitreg/core";
import { AmbientVfx, VfxSystem, loadGltf, type LightBudgetSystem, type VfxFrame } from "@hitreg/render";
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
 * VfxSystem.warmup). Picks any PSX mask and every spritesheet and decal page
 * the project has so the textured variants compile too; awaiting is optional.
 */
export function warmVfx(
  vfx: VfxSystem,
  assets: AssetLibrary,
  precompile: (group: THREE.Object3D) => Promise<void>,
  camera?: THREE.Camera,
): Promise<void> {
  const mask = assets.textureIds().find((id) => id.startsWith("fx/masks/"));
  const all = assets.dataAssetsOfType("spritesheet");
  // decal pages (fx.mjs decals) are data textures drawn by the decal module, not sprites
  const isDecal = (d: (typeof all)[number]): boolean => String((d.data as { texture?: unknown }).texture ?? "").startsWith("fx/decals/");
  const sheets = all.filter((d) => !isDecal(d)).map((d) => d.id);
  const decals = all.filter(isDecal).map((d) => d.id);
  const sheet = sheets[0];
  // then every look the project's spells draw (VfxSystem.warmSpells): the
  // first cast of each spell compiles nothing
  const spells: SpellDoc[] = [];
  for (const doc of assets.dataAssetsOfType("spell")) {
    const parsed = spellSchema.safeParse(doc.data);
    if (parsed.success) spells.push(parsed.data);
  }
  // ...and the standalone effects a game plays itself (`vfx` assets)
  const effects: VfxEffect[] = [];
  for (const doc of assets.dataAssetsOfType("vfx")) {
    const parsed = vfxEffectSchema.safeParse(doc.data);
    if (parsed.success) effects.push(parsed.data);
  }
  return vfx
    .warmup(precompile, { ...(mask ? { mask } : {}), ...(sheet ? { sheet } : {}), sheets, decals, ...(camera ? { camera } : {}) })
    .then(() => vfx.warmSpells(spells, precompile, camera, effects))
    .then(() => undefined);
}

/**
 * Standing effects (the `vfx` component) over the app's VfxSystem: effect and
 * material ids resolve through the asset library, and each owned light joins
 * the scene's point-light budget like any authored light. Shared by the editor
 * and the published runtime for the same reason `createVfx` is.
 */
export function createAmbientVfx(vfx: VfxSystem, assets: AssetLibrary, lightBudget: LightBudgetSystem): AmbientVfx {
  return new AmbientVfx(vfx, {
    resolveEffect: (id) => {
      const doc = assets.getDataAsset(id);
      return doc?.type === "vfx" ? doc.data : undefined;
    },
    resolveMaterial: (id) => assets.getDataAsset(id)?.data,
    onLight: (light) => lightBudget.register(light),
  });
}

const NEUTRAL = paletteFor("water");

export function makeVfxHost(vfx: VfxSystem): RuntimeVfxHost {
  const validated = new WeakMap<object, ReturnType<typeof spellSchema.safeParse>>();
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
      // a script hands the same (fitted, cached) document on every cast:
      // validate it once, not per cast (a big spell is ~1 ms of Zod)
      const known = typeof spell === "object" && spell !== null ? validated.get(spell) : undefined;
      const parsed = known ?? spellSchema.safeParse(spell);
      if (!known && typeof spell === "object" && spell !== null) validated.set(spell, parsed);
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
