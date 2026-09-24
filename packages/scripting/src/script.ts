import type { ItemEffect, ItemGlow } from "@hitreg/core";
import type * as THREE from "three";
import type { z } from "zod";
import type { EntityDoc, EventRegistrationOptions, PlayerDataService } from "@hitreg/core";

/** Declared tuning value — drives inspector fields and the AI-facing spec. */
/** Mirrors `LiveSkyOptions` in @hitreg/render (scripting takes no render dependency). */
export interface LiveSkyOptions {
  top?: string;
  bottom?: string;
  fog?: { color?: string; density?: number; near?: number; far?: number };
  hemisphere?: number;
  sun?: {
    /** Toward the sun — where it sits on the sky sphere. */
    direction?: [number, number, number];
    color?: string;
    intensity?: number;
    disc?: { color?: string; size?: number; intensity?: number };
  };
  moon?: { direction?: [number, number, number]; color?: string; size?: number; intensity?: number };
  stars?: { intensity?: number; density?: number; size?: number; rotation?: { axis: [number, number, number]; angle: number } };
  /** `sun`/`sunAmount` are the DIRECTIONAL dawn/dusk glow: the dome resolves them per pixel against the sun's own azimuth, so only that side of the deck burns. */
  clouds?: {
    coverage?: number;
    light?: number;
    color?: string;
    shadow?: string;
    sun?: string;
    sunAmount?: number;
    speed?: [number, number];
    scale?: number;
    softness?: number;
  };
  ambient?: { color?: string; intensity?: number };
  /** Applied on top of the day/night values: gloom 0..1 dims sun/fill/ambient/IBL, tint blends fog + horizon, wind scales foliage wind, cloudDark drives the deck itself toward storm grey, flash is lightning (a momentary wash over sky, fog and fill — no light is added). */
  weather?: { gloom?: number; tint?: string; tintAmount?: number; wind?: number; cloudDark?: number; flash?: number };
  /** How much DAYLIGHT there is, 0..1 — a day/night script publishes it so the weather tint (a LIT colour) can be dimmed to the hour instead of lighting up midnight fog. Defaults to 1. */
  daylight?: number;
  environmentIntensity?: number;
  refreshEnvironment?: boolean;
}

/** The live lens surface — see `ScriptContext.setPostFx`. */
export interface LivePostFxOptions {
  sandstorm?: {
    /** 0 = clear air, 1 = the worst this storm does. */
    amount: number;
    /** World direction the wind blows TOWARD; the renderer turns it into a screen angle. */
    wind?: [number, number, number];
    /** The grain's colour when it differs from the authored one (white = a blizzard). */
    color?: string;
  };
}

/** Mirrors `LayerOptions` in @hitreg/render (scripting takes no render dependency). */
export interface AnimationLayerOptions {
  /** Crossfade seconds into the layer, and back out of it on clear. */
  fade?: number;
  /** Loop the layer clip; the default plays it once and holds the last pose. */
  loop?: boolean;
  /** 0..1 — how much of the layer to apply. Only meaningful for additive. */
  weight?: number;
  /** Bone to mask from; defaults to the animator's `upperBody` / the first spine bone. */
  mask?: string;
  /** Add onto the base pose (aim offsets, leans) instead of replacing it. */
  additive?: boolean;
  /** Replay from frame 0 even if this clip is already the layer. */
  restart?: boolean;
  /**
   * Playback rate for the layer clip (1 = authored). The layer keeps its own
   * rate — a cast stretched to fill its cast time is not also sped up by the
   * sprint underneath it.
   */
  speed?: number;
}

/** What `ctx.biomeAt` reports: the voxel world's biome blend at a point. */
export interface BiomeAt {
  /** The winning labelled biome rule. */
  id: string;
  zone: string;
  /** Membership weight per biome rule id (0..1, blended across biome edges). */
  weights: Record<string, number>;
  ground: number;
  temperature: number;
  moisture: number;
  slope: number;
}

/**
 * What `ctx.waterAt` reports: the water standing over a point, whatever put it
 * there — an authored pool's `water` component or a procedural world's ocean,
 * lakes and rivers. One answer from both, so a swim controller written against
 * it works in a dungeon cistern and in the open sea without knowing which it
 * is in.
 */
export interface WaterAt {
  /** World Y of the surface. */
  surfaceY: number;
  /** Metres of water over the point asked about — NEGATIVE in the air above the surface. */
  depth: number;
  /** World Y the water stops at. A procedural world reports the bed it carved. */
  floorY: number;
  /** False = visual-only water: report it, but nobody swims in it. */
  swim: boolean;
  /** Drift in m/s [x, z] — a river's current, a canal's flow. */
  current: readonly [number, number];
}

/** Mirrors `LiveSkyBase` in @hitreg/render. */
export interface LiveSkyBase {
  top: string;
  bottom: string;
  fog: { color: string; density: number; near: number; far: number } | null;
  hemisphere: number;
  sun: { direction: [number, number, number]; color: string; intensity: number } | null;
  ambient: { color: string; intensity: number } | null;
  environmentIntensity: number;
  clouds: { coverage: number; softness: number } | null;
}

export interface ScriptParamSpec {
  default: unknown;
  min?: number;
  max?: number;
  description?: string;
}

/** An ubermesh look for {@link ScriptContext.setModelLook}. */
export interface ModelLook {
  /** Part names to show (the model's part table); wins over `partMask`. Every other part hides. */
  parts?: readonly string[];
  /** Raw part bit mask, for a model without a part table. */
  partMask?: number;
  /** Theme sheet texture asset id; null restores the model's own; undefined leaves it alone. */
  texture?: string | null;
  /** Emissive glow (an item's `appearance.glow`); null clears it; undefined leaves it alone. */
  glow?: ItemGlow | null;
  /** Standing effects anchored on the model (`appearance.effects`); replaces the previous set; undefined leaves it alone. */
  effects?: readonly ItemEffect[];
}

/** What scripts may touch. Deliberately narrow; grows with the engine. */
export interface ScriptContext {
  entityId: string;
  /** The entity's runtime object (play-mode state — never the document). */
  object: THREE.Object3D;
  /** Declared defaults merged with the entity's script.params. */
  params: Record<string, unknown>;
  input: InputLike;
  sim: SimLike | null;
  getEntity(id: string): EntityDoc | undefined;
  /** Runtime object of ANY entity (world queries: positions, visibility). */
  getObject(id: string): THREE.Object3D | undefined;
  /** Entity ids carrying a tag (expanded scene). */
  findByTag(tag: string): string[];
  /**
   * The entity id of THIS tab's own player, or null when there is none (a
   * headless server, a tab that has not joined). On a dedicated server every
   * joined player is a `player`-tagged body, so `findByTag("player")[0]` is
   * "somebody", not "me" — a HUD or a relevance filter asks this instead.
   */
  localPlayer?(): string | null;
  /** Milliseconds of simulated time (fixed-step accumulated, replay-safe). */
  now(): number;
  /**
   * Run `cb` once after `seconds` of SIMULATED time — fixed-step accumulated,
   * so it is replay- and multiplayer-safe (never `setTimeout`, which is
   * wall-clock and render-paced). Callbacks fire inside fixedUpdate, so
   * emitting events or mutating gameplay from them is legal. Returns a cancel
   * function; all of a script's timers are auto-cancelled when it disposes or
   * is net-suspended. A non-positive delay fires on the next tick.
   */
  after(seconds: number, cb: () => void): () => void;
  /**
   * Like {@link after} but repeats every `seconds`. Intervals shorter than one
   * sim tick fire once per tick; long intervals never fire more than once per
   * tick (no catch-up storms). Returns a cancel function.
   */
  every(seconds: number, cb: () => void): () => void;
  /** Horizontal camera forward [x, z], normalized — for camera-relative movement. */
  viewForward?(): [number, number];
  /**
   * The camera's full forward [x, y, z], normalized — the same aim including
   * its PITCH. What swimming (and flying, and a free-aim spell) needs: the
   * horizontal pair above cannot tell "looking at the bottom of the lake"
   * from "looking across it".
   */
  viewDirection?(): [number, number, number];
  /**
   * The local player just ACTED — moved, cast, attacked. A host whose camera
   * has been parked somewhere else (a free look swung round to see the
   * character's face) brings it back behind the aim. Cheap and idempotent:
   * call it every tick the player is acting. Only for the local player's own
   * actions; a host running other players' bodies must not have its camera
   * pulled by them.
   */
  recenterView?(): void;
  /** Switch the render camera to another camera-component entity (runtime-only). */
  setActiveCamera?(entityId: string | null): void;
  /**
   * Crossfade this entity's animator to a clip (Unity-style blending).
   * `loop: false` plays it once and emits "animation.completed" at the end
   * (for one-shots like attack/emote); the default loops.
   */
  setAnimation?(
    clip: string,
    fadeSeconds?: number,
    opts?: {
      loop?: boolean;
      /**
       * Play from the start even if this clip is already the current one — how
       * a one-shot (a swing, a cast) plays a SECOND time. Without it the clip
       * is already "current", clamped on its last frame, and the repeat is a
       * no-op that reads as a frozen character.
       */
      restart?: boolean;
    },
  ): void;
  /**
   * Hold two base clips at once — `from` at `1 - weight`, `to` at `weight`,
   * strides phase-matched. For a pose that follows a CONTINUOUS quantity
   * rather than a state: wading takes on the wade a little at a time as the
   * water climbs, instead of crossing a line and ducking. Weight 0 or 1 is
   * just {@link setAnimation} of whichever won, so it is safe to call every
   * tick. Declines under a masked action layer (the dominant clip plays).
   */
  setAnimationBlend?(from: string, to: string, weight: number, fadeSeconds?: number): void;
  /**
   * Clip names this entity's model actually shipped with. Lets a behavior
   * degrade instead of stalling: a locomotion script can fall back from a
   * missing "Walk" to "Run" rather than asking the animator for a clip that
   * isn't there and leaving the character frozen mid-stride.
   */
  animationClips?(): string[];
  /**
   * Authored length of one of this entity's clips, in seconds; null when the
   * model has no such clip (or has not loaded yet). What a script needs to FIT
   * a clip to a window — a three-second cast played once, slowly, rather than
   * a one-second cast played three times.
   */
  animationDuration?(clip: string): number | null;
  /**
   * Scale this entity's animation playback (1 = the authored rate). The cure
   * for foot-skate on in-place locomotion clips — see AnimationSystem.setSpeed.
   */
  setAnimationSpeed?(multiplier: number): void;
  /**
   * Play a clip on a masked LAYER over whatever the base clip is doing — cast
   * or swing while the legs keep running. The mask defaults to the upper body
   * (the animator's `upperBody` bone, else the rig's first spine bone) and the
   * layer REPLACES the base on those bones; `additive: true` adds the clip's
   * motion on top of the base instead, which is what aim offsets and leans
   * want. A one-shot holds its last pose until cleared, so pair this with
   * clearAnimationLayer or the "animation.completed" event.
   */
  setAnimationLayer?(clip: string, opts?: AnimationLayerOptions): void;
  /** Fade the animation layer out and give the base clip the whole body back. */
  clearAnimationLayer?(fadeSeconds?: number): void;
  /** Play this entity's audio component, or any sound asset id, at this entity. */
  playSound?(soundId?: string, opts?: { volume?: number; positional?: boolean; refDistance?: number; playbackRate?: number; priority?: number }): void;
  /** Material/surface name under a world point; hosts return a sensible fallback when unknown. */
  surfaceAt?(x: number, y: number, z: number): string;
  /** Keep a named script-owned loop alive; omit soundId to stop that slot. */
  setSoundLoop?(slot: string, soundId?: string, opts?: { volume?: number; positional?: boolean; refDistance?: number }): void;
  /** Mutate this entity's billboard at runtime (HP bar fill, label text) — never the document. */
  setBillboard?(opts: { fill?: number; text?: string; visible?: boolean; play?: boolean; row?: number; tint?: string }): void;
  /**
   * Start/stop, reveal, restart, burst or retint an entity's particle emitter
   * at runtime. `colorStart`/`colorEnd` move the whole ramp — that is how one
   * emitter serves every case a colour distinguishes (dust the colour of the
   * ground underfoot) instead of one authored emitter per case.
   */
  setParticles?(entityId: string, opts: {
    emitting?: boolean;
    visible?: boolean;
    restart?: boolean;
    burst?: number;
    rate?: number;
    colorStart?: string;
    colorEnd?: string;
    /**
     * Re-aim and re-speed the emitter for the particles it spawns NEXT — this
     * is wind. One rain emitter blown by whatever the weather is doing, rather
     * than an authored emitter per direction. Particles already in the air
     * keep the velocity they launched with, which is what a gust looks like.
     */
    direction?: [number, number, number];
    speed?: [number, number];
    /** Multiply the whole colour ramp — how a weather script dims its emitters after dark. */
    colorScale?: number;
  }): void;
  /** Runtime-only control for this entity's light component. */
  setLight?(entityId: string, opts: { enabled?: boolean; intensity?: number; color?: string }): void;
  /**
   * Change what an entity's UBERMESH model shows, at runtime only (the
   * document is untouched): which PARTS (by the model's own part names, or a
   * raw bit mask) and which THEME sheet (a texture asset id; null = the one
   * baked into the model). What equipping a sword or a helm looks like — see
   * the `equipment-look` builtin, which drives this from an item's
   * `appearance`. Safe to call before the model has loaded: the host keeps the
   * latest look per entity and applies it on load and after every rebuild.
   * Presentation only — absent on a dedicated server.
   */
  setModelLook?(entityId: string, look: ModelLook): void;
  /**
   * Drive the scene's sky per frame without a rebuild: gradient, fog, the
   * directional light's aim/colour/intensity, the dome's sun and moon discs,
   * ambient and IBL intensity. Every field is a uniform or a light property;
   * only `refreshEnvironment` costs anything (an IBL prefilter — use it a few
   * times per game day, never per frame). See the `day-night` builtin.
   */
  setSky?(opts: LiveSkyOptions): void;
  /** The authored sky and lights a day/night script derives its day from; null when the scene has no sky. */
  getSky?(): LiveSkyBase | null;
  /**
   * How much daylight there is right now, 0..1 — what the `day-night` script
   * last published, or 1 in a scene that has none.
   *
   * The one number that anything UNLIT needs. Particles draw with a basic
   * material, so a raindrop is as white at midnight as at noon; a weather
   * script reads this and dims its emitters by it. Also the honest way for a
   * script to ask "is it night" without owning a clock of its own.
   */
  daylight?(): number;
  /**
   * Drive the LENS per frame — what is between the camera and the world,
   * rather than what is in the world. Uniform writes only, never a rebuild;
   * the passes themselves are built from the scene's `postfx` component.
   *
   * Today: `sandstorm`, the screen-space grit a storm throws across the view.
   * Hand it a world-space wind direction and the renderer works out how that
   * crosses THIS camera — a script never needs to know where anyone is looking.
   */
  setPostFx?(opts: LivePostFxOptions): void;
  /** The procedural world's biome blend under a point (voxel worlds only); null off-world or in a scene without one. */
  biomeAt?(x: number, z: number): BiomeAt | null;
  /**
   * The water over a world point, or null where there is none. `y` is what the
   * returned `depth` is measured against — pass the body's feet and `depth` is
   * how deep you are wading.
   *
   * Cheap enough to call once per body per tick and no cheaper: it is a scan
   * of the scene's authored water plus, in a procedural world, the recipe's
   * own lake/river/sea query. Don't call it per particle.
   */
  waterAt?(x: number, y: number, z: number): WaterAt | null;
  /**
   * Composed effects and whole spells — the VFX system (`@hitreg/render`
   * VfxSystem behind it). `play` fires one effect (a module list, or a `vfx`
   * data-asset id) at a frame; `playSpell` sequences every phase of a
   * `spell` document (or asset id) on its archetype's timeline: telegraph,
   * charge, cast, travel, impact, ticks, linger, end. Presentation only —
   * absent on a dedicated server, so always optional-chain it.
   */
  vfx?: ScriptVfx;
  /** Read a data asset (ScriptableObject) by id — a spell, a loot table, a material. */
  getDataAsset?(id: string): { id: string; type: string; data: unknown } | undefined;
  /**
   * Resolve a texture asset id (assets/textures/…) to a URL the host can
   * load — for DOM UI (an inventory cell's icon), never for materials, which
   * reference textures by id on the material asset. Undefined = unknown id.
   */
  textureUrl?(id: string): string | undefined;
  /**
   * Draw a portrait of an entity (its runtime object, playing `clip` —
   * default "Idle" — on its own mixer) into a DOM canvas — the character
   * screen's model. Returns a dispose function, or null when the host cannot
   * (headless, or the entity has no runtime object yet). `spin` is a
   * turntable in rad/s.
   */
  renderPortrait?(
    entityId: string,
    canvas: HTMLCanvasElement,
    opts?: { spin?: number; clip?: string },
  ): (() => void) | null;
  /**
   * Rebuild THIS entity's `mesh.source.kind: "path"` geometry from new
   * control points (world space) — for a rope/chain/cable whose shape comes
   * from a live simulation (e.g. a joint chain's body positions) instead of
   * the authored static curve. Every other field (crossSection, width,
   * radius, ...) keeps the value authored on the entity's mesh component;
   * only `points` changes, and only at runtime — the document is untouched.
   * No-op if this entity has no path mesh.
   */
  setPathPoints?(points: Array<[number, number, number]>): void;
  /**
   * Typed gameplay events (deterministic pub/sub). `emit` queues — nothing
   * dispatches synchronously; the runtime drains the queue in FIFO order at a
   * fixed point each tick, so emit from onFixedUpdate stays replay/multiplayer
   * safe. Subscriptions made here are auto-unsubscribed when this script is
   * disposed. Registered event payloads are schema-validated on emit.
   */
  events?: ScriptEvents;
  /**
   * Replicated session state — facts every tab agrees on (enemy HP, chest
   * opened, score). Reads everywhere; writes on the authority only. Dies
   * with the room; commit durable results into ctx.playerData.
   */
  netState?: ScriptNetState;
  /**
   * Text chat (when the app mounts @hitreg/comms): read what THIS tab was
   * allowed to receive, post announcements from the authority, and react to
   * chat commands. Subscriptions auto-unsubscribe on dispose. Team/party
   * membership is plain netState (`comms.team/<peerId>`, `comms.party/<peerId>`).
   */
  chat?: ScriptChat;
  /**
   * Experience-scoped persistence for the local player (async — use from
   * onStart or fire-and-forget; never block onFixedUpdate on it):
   * `ctx.playerData?.set("primary", "wood", 42)`. Quotas, rate limits, and
   * atomic revisions are enforced by the service; category-1 platform data
   * (currency, cosmetics, entitlements) is NOT reachable from here by design.
   */
  playerData?: PlayerDataService;
}

/**
 * Where a script wants an effect to happen, in entity terms. The runtime
 * turns ids into runtime objects and bone sockets (entities tagged
 * `socket:<name>` under the body) before the renderer sees it.
 */
export interface ScriptVfxFrame {
  /** Where the spell resolves — the volume centre, the impact point. */
  origin: [number, number, number];
  /** Horizontal facing [x, z]; defaults to caster → origin. */
  direction?: [number, number];
  /** A targeted point (beams, bolts, debuffs). */
  target?: [number, number, number];
  casterId?: string;
  targetId?: string;
  /** Override the spell's element palette. */
  palette?: { primary: string; secondary: string; glow: string };
  /** Terrain height under (x, z); omitted = the runtime probes the physics world. */
  ground?(x: number, z: number, nearY: number): number | null;
}

export interface ScriptVfxHandle {
  /** Wind the effect down over `fade` seconds (a channel interrupted). */
  stop(fade?: number): void;
  readonly done: boolean;
}

export interface ScriptSpellHandle extends ScriptVfxHandle {
  /** Seconds since the cast started. */
  readonly time: number;
  /** Fire a phase now — for phases the host declared `manual`. */
  trigger(phase: string, at?: [number, number, number]): void;
  /** Drive the projectile from the real simulation (world position). */
  setPath(position: [number, number, number], velocity?: [number, number, number]): void;
}

export interface ScriptVfx {
  /** An effect document (`{ modules }`) or a `vfx` data-asset id. */
  play(effect: unknown, frame: ScriptVfxFrame, opts?: { phaseLength?: number }): ScriptVfxHandle | null;
  /** A spell document or a `spell` data-asset id. `manual` lists phases the script fires itself. */
  playSpell(spell: unknown, frame: ScriptVfxFrame, opts?: { manual?: string[]; at?: number }): ScriptSpellHandle | null;
  /** Fade every live effect out (scene end, a cutscene). */
  stopAll(fade?: number): void;
  /** Warm textures (masks, sheets) so a first play is not invisible while they load. */
  preload?(textureIds: string[]): void;
}

export interface InputLike {
  isDown(code: string): boolean;
  /**
   * Mouse movement accumulated since the last call, in pixels (x, y) —
   * consumed-and-reset semantics, like a delta poll. Only accumulates while
   * the pointer is locked AND the active follow camera's rig is NOT the
   * default free-orbit "follow" mode (that mode owns the mouse for camera
   * orbit instead) — see `camera.rig.mode: "chase"`. Absent/unimplemented
   * hosts may omit this; scripts should treat a missing method as [0, 0].
   */
  mouseDelta?(): [number, number];
  /**
   * A menu owns the keyboard. While any owner holds a capture, `isDown`
   * reports nothing to gameplay scripts (movement stops, abilities do not
   * fire) — the DOM still receives the keys, so the menu itself keeps
   * working. Reference-counted by `owner` so two open panels do not fight;
   * every capture a script holds is released when it disposes. Hosts without
   * a keyboard (a dedicated server) may omit it.
   */
  captureKeyboard?(owner: string, active: boolean): void;
}

/**
 * The event surface handed to scripts (a scoped wrapper over the session
 * EventBus). `meta.from` identifies the requesting peer when a handler runs
 * on the authority for a "to-authority" event.
 */
export interface ScriptEvents {
  emit(name: string, payload: unknown): void;
  on(name: string, cb: (payload: unknown, meta?: { from?: string }) => void): () => void;
  once(name: string, cb: (payload: unknown, meta?: { from?: string }) => void): () => void;
}

/** One chat line as scripts see it (structurally @hitreg/comms' ChatMessage). */
export interface ScriptChatMessage {
  id: string;
  channel: "proximity" | "zone" | "global" | "team" | "party" | "guild" | "system";
  /** Sending peer id, or "system". */
  from: string;
  name: string;
  text: string;
  at: number;
}

/**
 * The chat surface handed to scripts. `send` speaks AS this tab's player on
 * a channel (routed by the host like any typed message); `announce` posts a
 * system line to everyone when run on the authority (a local line on a
 * peer — the authoritative copy of the script announces for all); `system`
 * is a local-only line. Only the messages this tab may see ever arrive.
 */
export interface ScriptChat {
  send(channel: "proximity" | "zone" | "global" | "team" | "party" | "guild", text: string): boolean;
  announce(text: string): void;
  system(text: string): void;
  on(cb: (msg: ScriptChatMessage) => void): () => void;
  history(): readonly ScriptChatMessage[];
}

/**
 * Replicated session state (the NetworkVariables analog): facts every tab
 * must agree on — enemy HP, "chest opened", round score. Keys are
 * "namespace/rest". Reads work everywhere; writes only apply on the
 * session authority (peers get a warning no-op — request the change
 * through a to-authority event instead). Everything here dies with the
 * room: commit durable results into ctx.playerData explicitly.
 */
export interface ScriptNetState {
  /** True when this session may write (host or single-player). */
  isAuthority(): boolean;
  get(key: string): unknown;
  keys(prefix?: string): string[];
  /** Authority only. Returns false when refused (peer / invalid). */
  set(key: string, value: unknown): boolean;
  /** Authority only. Returns the new value, or null when refused. */
  increment(key: string, delta?: number): number | null;
  /** Authority only. */
  delete(key: string): boolean;
  /** Fires on every change, local or replicated. Auto-unsubscribed on dispose. */
  onChange(cb: (key: string, value: unknown) => void): () => void;
}

// ---------------------------------------------------------------------------
// Physics scene queries.
//
// These mirror `@hitreg/physics`'s types STRUCTURALLY on purpose: scripting
// must not depend on that package (the dependency runs the other way, and both
// core and scripting have to keep running headless with no Rapier wasm), so the
// shapes are restated here and `PhysicsSim` satisfies `SimLike` by structure.
// Any change here must be mirrored in packages/physics/src/queries.ts.
//
// The named layer constants live in `@hitreg/physics` (`Layers`,
// `SOLID_WORLD`, `VISION_BLOCKERS`, `HITTABLE`) — a game script in an app that
// already depends on that package should import them from there rather than
// spell a raw mask.
// ---------------------------------------------------------------------------

/** A convex query shape. `halfHeight` excludes the capsule's caps. */
export type SimQueryShape =
  | { kind: "ball"; radius: number }
  | { kind: "capsule"; halfHeight: number; radius: number }
  | { kind: "cuboid"; halfExtents: [number, number, number] };

/** What a query hit, where, and how far along it. */
export interface SimHit {
  entityId: string;
  /** World-space contact point. */
  point: [number, number, number];
  /** World-space surface normal of the hit collider, facing back at the query. */
  normal: [number, number, number];
  /** Metres travelled before the hit. */
  distance: number;
}

export interface SimQueryOptions {
  /** Layer mask limiting what may be hit. Defaults to everything. */
  layers?: number;
  /**
   * Entity ids the query ignores.
   *
   * **A script casting from its own body MUST exclude itself.** The ray starts
   * inside the caster's own collider, so without this the nearest hit is always
   * the caster: every line-of-sight test reads "blocked" and every weapon trace
   * hits its own wielder on the first frame. `{ exclude: [this.entityId] }`.
   */
  exclude?: readonly string[];
  /** Include trigger volumes. Off by default — a sensor is not geometry. */
  includeSensors?: boolean;
}

export interface SimRaycastOptions extends SimQueryOptions {
  /** Report a hit at distance 0 when the ray starts inside a shape (default true). */
  solid?: boolean;
  /** Result object to fill instead of allocating — for per-frame queries. */
  out?: SimHit;
}

export interface SimRaycastAllOptions extends SimQueryOptions {
  solid?: boolean;
  out?: SimHit[];
}

export interface SimShapecastOptions extends SimQueryOptions {
  rotation?: [number, number, number, number];
  /** Hit things the shape already overlaps at the start of the sweep (default true). */
  stopAtPenetration?: boolean;
  out?: SimHit;
}

export interface SimOverlapOptions extends SimQueryOptions {
  rotation?: [number, number, number, number];
  out?: string[];
}

/** Kinematic character-controller tuning. See @hitreg/physics for the defaults. */
export interface SimCharacterOptions {
  /** Skin width kept between the capsule and the world. Small, non-zero. */
  offset?: number;
  /** Steepest walkable slope, radians. Steeper counts as a wall. */
  maxSlopeClimbAngle?: number;
  /** Shallowest slope the character slides back down, radians. */
  minSlopeSlideAngle?: number;
  /** Step-up over stair lips; `null` disables. Without it stairs are walls. */
  autostep?: { maxHeight: number; minWidth: number; includeDynamicBodies?: boolean } | null;
  /** Stick to the ground when walking off a small lip; `null` disables. */
  snapToGround?: number | null;
  slide?: boolean;
  pushDynamicBodies?: boolean;
  mass?: number | null;
  up?: [number, number, number];
  layers?: number;
  /** Extra entities to pass through. The character's own entity is automatic. */
  exclude?: readonly string[];
}

export interface SimCharacterMove {
  /**
   * The translation ACTUALLY applied after sliding/stepping/snapping — never
   * the one requested. Integrate velocity against this, or the character banks
   * speed into a wall and shoots sideways when it clears the corner.
   */
  translation: [number, number, number];
  grounded: boolean;
  hitWall: boolean;
  hitCeiling: boolean;
  /** Entity ids touched, sorted (deterministic across peers). */
  collisions: string[];
}

/** The physics surface scripts may use (implemented by @hitreg/physics.PhysicsSim). */
export interface SimLike {
  getLinvel(id: string): [number, number, number] | null;
  setLinvel(id: string, v: [number, number, number]): void;
  applyImpulse(id: string, v: [number, number, number]): void;
  /** Teleport (respawns): position set, velocities zeroed. */
  setPosition?(id: string, p: [number, number, number]): void;
  /**
   * Drive a KINEMATIC body's position for the next step — NOT setPosition/
   * setTranslation. Rapier estimates a kinematic body's velocity (what a
   * dynamic body jointed to it actually feels) from this call, specifically;
   * driving a kinematic joint anchor via setPosition each tick instead reads
   * to anything attached as a fresh teleport every step — violent jitter.
   */
  setKinematicTarget?(id: string, p: [number, number, number]): void;
  takeCollisions?(): Array<[string, string]>;
  /** Collision-ended pairs since the last call (drives "trigger.exit"). */
  takeCollisionEnds?(): Array<[string, string]>;
  /** Whether the entity's collider is a sensor (isTrigger). */
  isTrigger?(id: string): boolean;

  // ---- scene queries -------------------------------------------------------
  // Immediate reads of the live physics world. Call them from onFixedUpdate:
  // gameplay queries have to run on the authority's fixed step or two peers
  // resolve the same swing differently. From a render-rate update they sample
  // a world mid-interpolation and mean nothing.

  /**
   * Nearest hit along a ray, or null. `dir` need not be normalized; distances
   * are metres either way.
   *
   * The line-of-sight primitive: eye → target torso, `layers` set to the
   * vision blockers, `exclude` naming the looker (and usually the target, so a
   * body does not occlude itself). Cheap enough to run per agent per AI tick
   * when the layer mask is narrow; supply `out` and it allocates nothing.
   */
  raycast?(
    origin: [number, number, number],
    dir: [number, number, number],
    maxDistance: number,
    opts?: SimRaycastOptions,
  ): SimHit | null;

  /** Every hit along a ray, nearest first, deterministically ordered. */
  raycastAll?(
    origin: [number, number, number],
    dir: [number, number, number],
    maxDistance: number,
    opts?: SimRaycastAllOptions,
  ): SimHit[];

  /**
   * Sweep a convex shape from `from` to `to`; first thing it touches, or null.
   *
   * This is what a weapon arc needs. A swing is a swept capsule, not a sphere
   * at the hilt: point-testing once per fixed step leaves ~17° of unchecked arc
   * between steps on a fast light attack, which a target can stand in. Sweep
   * the blade over the span covered SINCE THE LAST STEP instead — and because
   * this is a real physics query, a pillar in the way now stops the swing,
   * which a script-side capsule test cannot know about.
   */
  shapecast?(
    shape: SimQueryShape,
    from: [number, number, number],
    to: [number, number, number],
    opts?: SimShapecastOptions,
  ): SimHit | null;

  /** Sphere sweep — `shapecast` with a ball. */
  spherecast?(
    radius: number,
    from: [number, number, number],
    to: [number, number, number],
    opts?: SimShapecastOptions,
  ): SimHit | null;

  /** Capsule sweep — `shapecast` with a vertical capsule. */
  capsulecast?(
    radius: number,
    halfHeight: number,
    from: [number, number, number],
    to: [number, number, number],
    opts?: SimShapecastOptions,
  ): SimHit | null;

  /**
   * Entity ids intersecting a shape at `position`, sorted and deduplicated.
   * AoE damage, trigger volumes, "who is standing on the extraction lift".
   */
  overlapShape?(
    shape: SimQueryShape,
    position: [number, number, number],
    opts?: SimOverlapOptions,
  ): string[];

  /** Sphere overlap — `overlapShape` with a ball. */
  overlapSphere?(
    center: [number, number, number],
    radius: number,
    opts?: SimOverlapOptions,
  ): string[];

  // ---- character controller ------------------------------------------------

  /**
   * Create or retune this entity's kinematic character controller. Optional —
   * `moveCharacter` auto-configures with sane interior defaults — but this is
   * where step offset, slope limit and snap-to-ground get set, and stairs are
   * unwalkable without autostep.
   */
  configureCharacter?(id: string, opts?: SimCharacterOptions): void;

  /**
   * Move a character by `desired`, sliding along walls, stepping up stairs and
   * snapping to ground. Returns the APPLIED translation plus grounded /
   * hitWall / hitCeiling flags — see {@link SimCharacterMove.translation} for
   * why integrating the desired value instead is a bug.
   */
  moveCharacter?(
    id: string,
    desired: [number, number, number],
    out?: SimCharacterMove,
  ): SimCharacterMove;

  /** Drop a character controller (despawn, or reverting to dynamic movement). */
  removeCharacter?(id: string): void;

  /**
   * Retag an entity's colliders. Layer membership is a runtime fact as often as
   * an authored one: a body becomes an ACTOR when a character script attaches,
   * a dropped weapon moves from ACTOR to PROP, an arrow leaves PROJECTILE the
   * moment it sticks in a wall.
   */
  setLayers?(id: string, membership: number, collidesWith?: number): void;
}

/**
 * Base class for behaviors. Gameplay state may only change in onFixedUpdate
 * (multiplayer invariant). Params are declared statically so the inspector
 * and AI can read them without instantiating anything.
 */
export abstract class Script {
  static scriptName = "";
  static params: Record<string, ScriptParamSpec> = {};
  static events: ScriptEventDecl[] = [];
  /**
   * Developer-console commands this script type owns — declared here, so a
   * script that owns some world state also owns the way a human pokes at it,
   * and the console needs no table of its own. See {@link ScriptCommandDecl}
   * and {@link Script.onCommand}.
   */
  static commands: ScriptCommandDecl[] = [];
  /**
   * Data-asset types a project owns, so a project can register its own
   * ScriptableObject types without editing the shared app bootstrap — same
   * pattern as {@link Script.events}. Loading the script is enough to register
   * them; see `ScriptRegistry.register`.
   */
  static dataTypes: ScriptDataTypeDecl[] = [];

  ctx!: ScriptContext;

  get object(): THREE.Object3D {
    return this.ctx.object;
  }

  get entityId(): string {
    return this.ctx.entityId;
  }

  param<T>(key: string): T {
    return this.ctx.params[key] as T;
  }

  onStart?(): void;
  onFixedUpdate?(dt: number): void;
  /**
   * Once per RENDERED frame, after animation has posed the skeletons — for
   * scripts that attach something to a bone. On the fixed tick a bone is
   * where the previous frame left it, so anything placed there trails a
   * moving arm by a frame. Presentation only: never change gameplay state
   * here (it runs at the display rate, and not at all headless).
   */
  onLateUpdate?(dt: number): void;
  /**
   * New params were patched into this running script (an inspector edit
   * during play — see ScriptRuntime.updateParams). Optional: a script that
   * reads param() every tick needs nothing. Runs even while the game is
   * PAUSED, so a script whose params drive what is drawn (a bone socket) can
   * re-pose on the spot instead of on the next unpaused tick.
   */
  onParamsChanged?(): void;
  /**
   * Run one of this script's declared console commands. Return the line to
   * print (or null for "nothing to say"); THROW to report a bad argument —
   * the console catches it and prints the message, so a command reads as
   * straight-line code instead of a result-type ladder.
   *
   * Only ever called from the developer console, which a published build
   * normally strips (see `@hitreg/scripting/console`). Treat it as a debug
   * surface, not an API: nothing in the engine calls it.
   */
  onCommand?(name: string, args: string[]): string | null;
  onCollision?(otherId: string): void;
  /** Play session ended (stop pressed) — clean up anything external (DOM, timers). */
  onDispose?(): void;
  /**
   * What this script is thinking right now, as plain JSON — for an admin
   * endpoint, an editor inspector, or an AI agent asking why something is
   * behaving the way it is.
   *
   * Optional and read-only: nothing in the engine calls it on a schedule, so
   * it costs nothing until someone looks. It exists because the alternative is
   * replicating debug state through netState, which puts a diagnostic on the
   * wire for every client forever — and because "why is that thing chasing
   * HIM" is otherwise unanswerable on a live server without a debugger.
   *
   * Keep it cheap and allocation-light: it may be called for every entity in a
   * scene at once.
   */
  onDebug?(): unknown;
}

/** A gameplay event contract a script type owns (name, payload schema,
 * network direction) — declared on the script itself instead of hand-added
 * to the shared app bootstrap, so a project-specific script (its own
 * request/response contracts, e.g. "npc.hit") stays self-contained: loading
 * the script is enough to register its events, see `ScriptRegistry.register`. */
export interface ScriptEventDecl {
  name: string;
  schema: z.ZodType;
  options?: EventRegistrationOptions;
}

/**
 * A data-asset (ScriptableObject) type a script type owns — declared on the
 * script itself instead of hand-added to the shared app bootstrap, so a
 * project-specific asset kind (a weapon table, a loot table, an enemy archetype)
 * stays self-contained: loading the script is enough to register the type, and
 * `apps/playground/src/main.ts` stays generic across every project it serves.
 * Same contract as {@link ScriptEventDecl}; the schema drives validation, the
 * inspector, and the AI-facing spec.
 */
export interface ScriptDataTypeDecl {
  type: string;
  schema: z.ZodType;
}

/**
 * One developer-console command a script type owns ("/time", "/weather").
 *
 * Declared on the script rather than registered somewhere central, for the
 * same reason events and data types are: the script that owns the state owns
 * the command, a project's own script can add its own commands without
 * touching the app bootstrap, and `/help` is generated from these rather than
 * written twice.
 */
export interface ScriptCommandDecl {
  /** Typed without the slash: "time" is reached as "/time". */
  name: string;
  /** Argument shape for help, e.g. "[hour|dawn|dusk|+n]". Free text — the command parses its own args. */
  args?: string;
  /** One line. It is what `/help` prints, so say what it DOES, not what it is. */
  description: string;
  /**
   * True when the command changes state the AUTHORITY owns (the clock, the
   * weather). On a peer such a change is overwritten by the next sync, so the
   * console says so instead of letting a tester watch their command undo
   * itself two seconds later.
   */
  authority?: boolean;
}

export type ScriptClass = (new () => Script) & {
  scriptName: string;
  params?: Record<string, ScriptParamSpec>;
  events?: ScriptEventDecl[];
  dataTypes?: ScriptDataTypeDecl[];
  commands?: ScriptCommandDecl[];
};
