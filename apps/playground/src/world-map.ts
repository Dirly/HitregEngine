/**
 * The in-game world map (M key) and the minimap service, for whatever world
 * the scene streams (`voxelWorld.world`).
 *
 * The picture is `assets/maps/<world>.base.png` (terrain + water, written by
 * `worldgen map <world> --base`), and over it the vector layers of
 * map-layers.ts.
 *
 * WHAT A PLAYER SEES (the owner's ruling: the map is for towns): the terrain,
 * zone borders and names, roads, towns by name, the player, and the player's
 * own markers (pins). Named places, dungeon entrances and quest givers are
 * found by exploring. Those layers, and the DEV layer (spawn areas, packs,
 * reservations, generator sites), exist only when the host passes
 * `devLayers: true` — the editor does (D toggles them); the published runtime
 * (play.ts) does not, so a published client cannot show them however its
 * storage is edited, and it never fetches `maps/<world>.layers.json` (the
 * authoring bundle `zonegen map` writes; export-game.mjs does not ship it).
 * `zonegen map` — the review PNG for agents — keeps every layer.
 *
 * PLAYER MARKERS: right-click (or "Add marker", then click) drops a pin; the
 * pin editor names it (optional, short) and picks one of a few SHAPES — the
 * shape carries the meaning, all pins share one colour. Drag a pin to move
 * it, click it to rename/reshape/delete. The minimap draws pins too, with
 * off-screen ones on its edge. Pins are client-side UI state, kept per
 * character + world (map-pins.ts); never gameplay, never replicated.
 *
 * Wheel zooms about the cursor, drag pans. In the editor a click (without a
 * drag) asks the host to TRAVEL there (dev fast-travel; the callback may
 * refuse); a published host passes no travel. Nothing here touches the scene.
 *
 * A HUD script draws its minimap through the same layers without importing
 * engine code: it dispatches `hitreg:minimap-draw` on window with
 * `{ canvas, x, z, heading, radius }` (heading = compass bearing in degrees,
 * radius = metres from centre to edge) and gets `handled` and `place`
 * (`{ zone, town }` names at x/z) set on the detail. `hitreg:world-map-toggle`
 * opens/closes the full map, so a project HUD has one M map, not its own;
 * `hitreg:map-mark-here` drops a pin where the player stands and opens its editor.
 * Project HUD skins supply the --map-* CSS tokens; canvas marker colours and
 * label fonts inherit the same skin as the panels.
 */
import {
  collectMapData,
  drawMapLayers,
  drawPinGlyph,
  layerCounts,
  LAYERS,
  legendSwatch,
  mapExtent,
  PIN_LABEL_MAX,
  PIN_SHAPES,
  PLAYER_LAYERS,
  zoneAt,
  type LayerId,
  type MapData,
  type MapExtras,
  type MapMarker,
  type MapPin,
  type PinShape,
  type SceneLike,
} from "./map-layers.js";
import { cleanLabel, loadPins, newPinId, PIN_LIMIT, savePins } from "./map-pins.js";

type RecipeLike = Parameters<typeof collectMapData>[0];

export interface WorldMapOverlayOptions {
  /** World recipe id (the scene's `voxelWorld.world`), or null when the scene has none. */
  world: () => string | null;
  /** The live recipe of that world (the voxel field's), when it is loaded. */
  recipe?: () => RecipeLike | null;
  /** The current (expanded) scene doc: portals, quest givers, spawn areas and built places come from it. */
  scene?: () => SceneLike | null;
  /** Where the player (or, in the editor, the camera focus) is, and which way it faces in radians about +Y. */
  position: () => { x: number; z: number; yaw: number } | null;
  /**
   * Take the player (or the editor camera) to a world point. Return a short
   * message to refuse — it is shown on the map instead of closing it. Omit
   * and clicking does nothing (a published game omits it).
   */
  travel?: (x: number, z: number) => string | void;
  /**
   * May the layers players do not get (named places, dungeon entrances, quest
   * givers, the DEV layer) be shown at all? The editor: true. A published
   * runtime: false (the default), and nothing at runtime can change it.
   */
  devLayers?: boolean;
  /** URL of an asset file (`maps/x.base.png`, `worlds/x.json`). Default: the dev server's asset bridge. */
  fileUrl?: (path: string) => string;
  /** Who owns the markers: the playing character's id, or null (one local set, "local"). */
  owner?: () => string | null;
}

export interface MinimapRequest {
  canvas: HTMLCanvasElement;
  x: number;
  z: number;
  /** Compass bearing in degrees (0 = north, 90 = east). */
  heading: number;
  /** Metres from the centre to the canvas edge (horizontally). */
  radius: number;
  font?: string;
  /** Set by the map: true once drawn. */
  handled?: boolean;
  /** Set by the map: names of the zone and town zone at x/z. */
  place?: { zone: string | null; town: string | null };
}

const MIN_SCALE = 0.02;
const MAX_SCALE = 8;
/** Pointer travel below this, press to release, is a click; above it, a drag. */
const CLICK_SLOP_PX = 4;
/** v2: v1 sets saved the old everything-on default; the player default is now towns/roads/zones only. */
const STORAGE_KEY = "hitreg-world-map-layers-v2";
const PIN_SIZE = 7;
const PANEL_CSS = "background:var(--map-surface-background,var(--map-panel,rgba(13,17,23,0.94)));border:1px solid var(--map-border,#30363d);padding:var(--map-panel-padding,10px 12px);border-radius:3px;";
const BUTTON_CSS =
  "font:inherit;color:var(--map-heading,#e6edf3);background:var(--map-button,#21262d);border:1px solid var(--map-border,#30363d);border-radius:3px;padding:3px 8px;cursor:pointer;";

export function createWorldMapOverlay(options: WorldMapOverlayOptions): { toggle(): void; visible(): boolean } {
  const dev = options.devLayers === true;
  const fileUrl = options.fileUrl ?? ((f: string): string => `/__hitreg/asset-file?file=${encodeURIComponent(f)}`);
  /** Layers this host may draw at all. */
  const allowed: ReadonlySet<LayerId> = dev ? new Set(LAYERS.map((l) => l.id)) : PLAYER_LAYERS;
  /** Layers in the "dev" group of the panel: everything a player does not get. */
  const devOnly = LAYERS.filter((l) => !PLAYER_LAYERS.has(l.id));

  // Custom project maps use the same host travel policy and streamed-ground hold.
  // This is a local UI request, never a replicated gameplay command.
  window.addEventListener("hitreg:world-map-travel", (event) => {
    const request = (event as CustomEvent<{ x: number; z: number; reply?: (reason?: string) => void }>).detail;
    if (!request || !Number.isFinite(request.x) || !Number.isFinite(request.z)) return;
    const reason = options.travel ? options.travel(request.x, request.z) : "Map travel is unavailable";
    request.reply?.(reason || undefined);
  });

  const root = document.createElement("div");
  root.className = "hitreg-world-map";
  root.style.cssText =
    "position:fixed;inset:0;z-index:100000;display:none;background:var(--map-backdrop,rgba(8,10,14,0.9));color:var(--map-text,#c9d1d9);" +
    "font:var(--map-font,12px/1.4 ui-sans-serif,system-ui,'Segoe UI',sans-serif);user-select:none;";
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "World map");
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:absolute;inset:0;width:100%;height:100%;cursor:crosshair;touch-action:none;";
  canvas.setAttribute("aria-label", "World map: wheel to zoom, drag to pan, right-click to add a marker");
  const panel = document.createElement("div");
  panel.className = "map-panel map-surface";
  panel.style.cssText = `position:absolute;left:var(--map-panel-gap,16px);top:var(--map-panel-gap,16px);${PANEL_CSS}min-width:var(--map-panel-min-width,230px);max-width:var(--map-panel-max-width,280px);`;
  const status = document.createElement("div");
  status.className = "map-status map-surface";
  status.setAttribute("role", "status");
  status.style.cssText = `position:absolute;right:var(--map-panel-gap,16px);top:var(--map-status-top,16px);bottom:var(--map-status-bottom,auto);${PANEL_CSS}max-width:var(--map-status-width,380px);white-space:pre-wrap;font-variant-numeric:tabular-nums;`;
  const editor = document.createElement("div");
  editor.className = "map-marker-editor map-surface";
  editor.style.cssText = `position:absolute;display:none;${PANEL_CSS}width:var(--map-editor-width,236px);user-select:text;`;
  const controlStyle = document.createElement("style");
  controlStyle.textContent = `.hitreg-world-map button:focus-visible,.hitreg-world-map input:focus-visible,.hitreg-world-map summary:focus-visible{outline:2px solid var(--map-accent,#79c0ff);outline-offset:2px}.hitreg-world-map .map-panel{max-height:calc(100dvh - var(--map-panel-height-gap,32px));overflow:auto}.hitreg-world-map button:hover{filter:brightness(1.2)}.hitreg-world-map .map-controls{display:flex;gap:4px;flex-wrap:wrap;margin:8px 0}.hitreg-world-map .map-controls button{min-height:28px}.hitreg-world-map .map-marker-types button{min-height:32px}.hitreg-world-map .map-close{font:inherit;cursor:pointer}.hitreg-world-map [hidden]{display:none}`;
  root.append(controlStyle, canvas, panel, status, editor);
  document.body.appendChild(root);
  // Game skins inherit these CSS tokens from their own HUD stylesheet. Cache
  // canvas values until that skin changes instead of reading styles every frame.
  let themeKey: string | null = null;
  let editorGap = 8;
  let ink = { backgroundColor: "#0d1a26", pinColor: "#8fe6ff", pinLabelColor: "#d9f6ff", font: "ui-sans-serif,system-ui,sans-serif" };
  function mapInk(): typeof ink {
    const key = document.body.className + document.body.style.cssText;
    if (key !== themeKey) {
      themeKey = key;
      const skin = getComputedStyle(root);
      editorGap = Math.max(8, Number.parseFloat(skin.getPropertyValue("--map-editor-gap")) || 8);
      ink = { backgroundColor: skin.getPropertyValue("--map-canvas").trim() || "#0d1a26", pinColor: skin.getPropertyValue("--map-marker").trim() || "#8fe6ff", pinLabelColor: skin.getPropertyValue("--map-marker-label").trim() || "#d9f6ff", font: skin.getPropertyValue("--map-label-font").trim() || "ui-sans-serif,system-ui,sans-serif" };
    }
    return ink;
  }

  // -- layers: what is on, remembered per browser (only within what this host allows) --
  const layers = new Set<LayerId>(PLAYER_LAYERS);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as LayerId[] | null;
    if (Array.isArray(saved)) {
      layers.clear();
      for (const id of saved) if (allowed.has(id)) layers.add(id);
    }
  } catch {
    /* storage blocked: defaults */
  }
  const saveLayers = (): void => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...layers]));
    } catch {
      /* ignore */
    }
  };
  /** What is drawn: on AND allowed. The intersection is the guarantee, not the panel. */
  const shown = (): Set<LayerId> => new Set([...layers].filter((l) => allowed.has(l)));

  // -- data, per world -------------------------------------------------------
  let base: { image: HTMLImageElement; width: number; height: number; extent: number } | null = null;
  let baseIsPlain = true;
  let extras: MapExtras | null = null;
  let loadedFor: string | null = null;
  let loadNote = "";
  let data: MapData | null = null;
  let dataKey: [unknown, unknown, unknown] = [null, null, null];

  async function load(world: string): Promise<void> {
    loadedFor = world;
    base = null;
    extras = null;
    data = null;
    loadNote = "";
    const none = Promise.resolve(null);
    try {
      const [plain, layered, extra, recipeResponse] = await Promise.all([
        fetch(fileUrl(`maps/${world}.base.png`)),
        // the legacy picture with markers baked in, and the authoring bundle: dev only
        dev ? fetch(fileUrl(`maps/${world}.png`)) : none,
        dev ? fetch(fileUrl(`maps/${world}.layers.json`)) : none,
        options.recipe?.() ? none : fetch(fileUrl(`worlds/${world}.json`)),
      ]);
      if (recipeResponse?.ok) fallbackRecipe = { world, recipe: (await recipeResponse.json()) as RecipeLike };
      extras = extra?.ok ? ((await extra.json()) as MapExtras) : null;
      const png = plain.ok ? plain : layered?.ok ? layered : null;
      baseIsPlain = plain.ok;
      if (dev) {
        if (!plain.ok) loadNote = `no terrain picture maps/${world}.base.png — run: npx tsx tools/zonegen.mts map ${world} --project <p>`;
        else if (!extra?.ok) loadNote = `no maps/${world}.layers.json (quest places, reservations, packs) — run zonegen map`;
      } else if (!plain.ok) loadNote = "no terrain picture for this world";
      if (png) {
        const img = new Image();
        img.src = URL.createObjectURL(await png.blob());
        await img.decode();
        if (loadedFor !== world) return;
        const r = recipe();
        base = { image: img, width: img.naturalWidth, height: img.naturalHeight, extent: r ? mapExtent(r) : 3000 };
      }
    } catch (error) {
      loadNote = String((error as Error).message ?? error);
    }
    dirty = true;
  }
  let fallbackRecipe: { world: string; recipe: RecipeLike } | null = null;
  const recipe = (): RecipeLike | null => options.recipe?.() ?? (fallbackRecipe?.world === loadedFor ? fallbackRecipe.recipe : null);

  /** The world's map data, rebuilt only when the recipe, scene or extras object changes. */
  function current(): MapData | null {
    const world = options.world();
    if (!world) return null;
    if (world !== loadedFor) void load(world);
    const r = recipe();
    if (!r) return null;
    // a published client builds no place/dungeon/quest-giver data at all: it reads the recipe alone
    const scene = dev ? (options.scene?.() ?? null) : null;
    if (!data || dataKey[0] !== r || dataKey[1] !== scene || dataKey[2] !== extras) {
      data = collectMapData(r, scene, extras, world);
      if (!dev) data = { ...data, markers: data.markers.filter((m) => m.kind === "town") };
      dataKey = [r, scene, extras];
      counts = layerCounts(data);
      buildPanel();
    }
    return data;
  }
  let counts: Partial<Record<LayerId, number>> = {};

  // -- player markers --------------------------------------------------------
  let pinStore: { owner: string; world: string; pins: MapPin[] } | null = null;
  let panelStale = false;
  let devToolsOpen = false;
  let lastShape: PinShape = "pin";
  let selected: string | null = null;
  let placing = false;
  /** This character's pins in the current world (loaded when either changes). */
  function pins(): MapPin[] {
    const world = options.world();
    if (!world) return [];
    const owner = options.owner?.() ?? "local";
    if (!pinStore || pinStore.owner !== owner || pinStore.world !== world) {
      pinStore = { owner, world, pins: loadPins(owner, world) };
      selected = null;
      panelStale = true; // the open panel lists the new owner's pins on the next frame
    }
    return pinStore.pins;
  }
  const persist = (): void => {
    if (pinStore) savePins(pinStore.owner, pinStore.world, pinStore.pins);
    dirty = true;
  };
  function addPin(x: number, z: number): MapPin | null {
    const list = pins();
    if (!options.world()) return null;
    if (list.length >= PIN_LIMIT) {
      notice = `marker limit reached (${PIN_LIMIT}) — delete one first`;
      dirty = true;
      return null;
    }
    const pin: MapPin = { id: newPinId(), x, z, shape: lastShape, label: "" };
    list.push(pin);
    persist();
    return pin;
  }
  const pinById = (id: string | null): MapPin | undefined => (id ? pins().find((p) => p.id === id) : undefined);

  // -- minimap service --------------------------------------------------------
  window.addEventListener("hitreg:minimap-draw", (event) => {
    const req = (event as CustomEvent<MinimapRequest>).detail;
    if (!req?.canvas) return;
    const d = current();
    if (!d) return;
    const ctx = req.canvas.getContext("2d");
    if (!ctx) return;
    const width = req.canvas.width;
    const height = req.canvas.height;
    const minimapLayers = new Set<LayerId>([...shown()].filter((l) => l !== "reservations" && l !== "sites"));
    drawMapLayers(ctx, d, { cx: req.x, cz: req.z, scale: width / (2 * req.radius), width, height }, {
      layers: minimapLayers,
      base: baseIsPlain ? base : null,
      player: { x: req.x, z: req.z, yaw: (-req.heading * Math.PI) / 180 },
      compact: true,
      ...mapInk(),
      font: req.font ?? mapInk().font,
      pins: pins(),
    });
    req.handled = true;
    req.place = zoneAt(d, req.x, req.z);
  });
  window.addEventListener("hitreg:world-map-toggle", () => toggle());
  window.addEventListener("hitreg:map-mark-here", (event) => {
    const here = options.position();
    if (!here) return;
    const pin = addPin(here.x, here.z);
    const detail = (event as CustomEvent<{ id?: string } | null>).detail;
    if (pin && detail && typeof detail === "object") detail.id = pin.id;
    if (pin) {
      if (root.style.display === "none") toggle();
      select(pin.id, true);
    }
  });

  // -- view -------------------------------------------------------------------
  let view = { cx: 0, cz: 0, scale: 0.1 };
  let fitted: string | null = null;
  let dirty = true;
  let raf = 0;
  let notice = "";
  let cursor: { px: number; py: number } | null = null;
  let drag: { startX: number; startY: number; cx: number; cz: number; moved: boolean; pin: string | null } | null = null;
  let lastPlayer = "";
  let lastDraw = 0;

  const fit = (d: MapData): void => {
    const pts = d.zones.length ? d.zones.flatMap((z) => z.polygon) : d.markers.filter((m) => m.kind === "town").map((m) => [m.x, m.z] as [number, number]);
    const e = d.extent;
    const box = pts.length
      ? [Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1]))]
      : [-e, -e, e, e];
    const span = Math.max(box[2]! - box[0]!, box[3]! - box[1]!) * 1.08 + 100;
    view = { cx: (box[0]! + box[2]!) / 2, cz: (box[1]! + box[3]!) / 2, scale: Math.min(canvas.width, canvas.height) / span };
    dirty = true;
  };
  const toWorld = (px: number, py: number): [number, number] => [view.cx + (px - canvas.width / 2) / view.scale, view.cz + (py - canvas.height / 2) / view.scale];
  const toScreen = (x: number, z: number): [number, number] => [(x - view.cx) * view.scale + canvas.width / 2, (z - view.cz) * view.scale + canvas.height / 2];
  const canvasPoint = (e: PointerEvent | WheelEvent | MouseEvent): { px: number; py: number } => {
    const r = canvas.getBoundingClientRect();
    return { px: ((e.clientX - r.left) / r.width) * canvas.width, py: ((e.clientY - r.top) / r.height) * canvas.height };
  };
  const zoomAbout = (px: number, py: number, factor: number): void => {
    const [wx, wz] = toWorld(px, py);
    view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    view.cx = wx - (px - canvas.width / 2) / view.scale;
    view.cz = wz - (py - canvas.height / 2) / view.scale;
    dirty = true;
    placeEditor();
  };
  /** The pin under a canvas point (its glyph, which stands above the marked spot for pin/flag). */
  const pinAt = (px: number, py: number): MapPin | null => {
    let best: MapPin | null = null;
    let bestD = PIN_SIZE + 7;
    for (const p of pins()) {
      const [sx, sy] = toScreen(p.x, p.z);
      const lift = p.shape === "pin" || p.shape === "flag" ? PIN_SIZE : 0;
      const dist = Math.hypot(sx - px, sy - lift - py);
      if (dist < bestD) {
        bestD = dist;
        best = p;
      }
    }
    return best;
  };

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const { px, py } = canvasPoint(e);
      zoomAbout(px, py, Math.exp(-e.deltaY * 0.0015));
    },
    { passive: false },
  );
  canvas.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const { px, py } = canvasPoint(e);
    const hit = pinAt(px, py);
    if (hit) return select(hit.id, true);
    const [x, z] = toWorld(px, py);
    const pin = addPin(x, z);
    if (pin) select(pin.id, true);
  });
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const { px, py } = canvasPoint(e);
    if (placing) {
      placing = false;
      const [x, z] = toWorld(px, py);
      const pin = addPin(x, z);
      if (pin) select(pin.id, true);
      buildPanel();
      return;
    }
    const hit = pinAt(px, py);
    drag = { startX: px, startY: py, cx: view.cx, cz: view.cz, moved: false, pin: hit?.id ?? null };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = canvasPoint(e);
    cursor = p;
    dirty = true;
    if (!drag) {
      canvas.style.cursor = placing ? "copy" : pinAt(p.px, p.py) ? "grab" : "crosshair";
      return;
    }
    const dx = p.px - drag.startX;
    const dy = p.py - drag.startY;
    if (Math.hypot(dx, dy) > CLICK_SLOP_PX) drag.moved = true;
    if (!drag.moved) return;
    const pin = pinById(drag.pin);
    if (pin) {
      // the pin follows the pointer; its marked spot sits where the press landed relative to it
      [pin.x, pin.z] = toWorld(p.px, p.py + (pin.shape === "pin" || pin.shape === "flag" ? PIN_SIZE : 0));
      canvas.style.cursor = "grabbing";
      placeEditor();
    } else {
      view.cx = drag.cx - dx / view.scale;
      view.cz = drag.cz - dy / view.scale;
      placeEditor();
    }
  });
  canvas.addEventListener("pointerleave", () => {
    cursor = null;
    dirty = true;
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const { moved, pin } = drag;
    drag = null;
    canvas.releasePointerCapture(e.pointerId);
    if (pin) {
      if (!moved) return select(pin, true);
      persist();
      placeEditor();
      return;
    }
    if (moved) return;
    if (selected) return select(null);
    if (!options.travel) return;
    const { px, py } = canvasPoint(e);
    const [x, z] = toWorld(px, py);
    const refused = options.travel(x, z);
    if (refused) {
      notice = refused;
      dirty = true;
      return;
    }
    notice = "";
    hide();
  });

  // -- the pin editor: label, shape, delete -----------------------------------
  function select(id: string | null, open = false): void {
    const was = selected;
    selected = id && pinById(id) ? id : null;
    dirty = true;
    if (was !== selected) buildPanel();
    if (selected && open) buildEditor();
    else if (!selected) editor.style.display = "none";
    else placeEditor();
  }
  function placeEditor(): void {
    const pin = pinById(selected);
    if (!pin || editor.style.display === "none") return;
    const r = canvas.getBoundingClientRect();
    const [sx, sy] = toScreen(pin.x, pin.z);
    const x = (sx / canvas.width) * r.width;
    const y = (sy / canvas.height) * r.height;
    const w = editor.offsetWidth || 260;
    const h = editor.offsetHeight || 150;
    mapInk();
    editor.style.left = `${Math.max(editorGap, Math.min(r.width - w - editorGap, x + 18))}px`;
    editor.style.top = `${Math.max(editorGap, Math.min(r.height - h - editorGap, y - h / 2))}px`;
  }
  function buildEditor(focusLabel = true): void {
    const pin = pinById(selected);
    if (!pin) return;
    editor.replaceChildren();
    editor.style.display = "block";
    const title = document.createElement("div");
    title.style.cssText = "font-weight:600;color:var(--map-heading,#e6edf3);margin-bottom:6px";
    title.className = "map-heading";
    title.textContent = "Map inscription";
    const input = document.createElement("input");
    input.type = "text";
    input.maxLength = PIN_LABEL_MAX;
    input.placeholder = "Name this location…";
    input.value = pin.label;
    input.setAttribute("aria-label", "Marker label");
    input.style.cssText =
      "box-sizing:border-box;width:100%;font:inherit;color:var(--map-heading,#e6edf3);background:var(--map-input,#161b22);border:1px solid var(--map-border,#30363d);border-radius:3px;padding:4px 6px;";
    input.addEventListener("input", () => {
      pin.label = cleanLabel(input.value);
      persist();
      buildPanel();
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        select(null);
      }
    });
    const shapes = document.createElement("div");
    shapes.setAttribute("role", "radiogroup");
    shapes.className = "map-marker-types";
    shapes.setAttribute("aria-label", "Marker type");
    shapes.style.cssText = "display:grid;grid-template-columns:1fr 1fr;gap:4px;margin:8px 0";
    for (const s of PIN_SHAPES) {
      const b = document.createElement("button");
      b.type = "button";
      b.setAttribute("role", "radio");
      const on = pin.shape === s.id;
      b.setAttribute("aria-checked", String(on));
      b.style.cssText = `${BUTTON_CSS}display:flex;align-items:center;gap:6px;text-align:left;${on ? "background:var(--map-selected,#1f3a5f);border-color:var(--map-accent,#79c0ff);" : ""}`;
      b.append(glyphCanvas(s.id), Object.assign(document.createElement("span"), { textContent: s.label }));
      b.addEventListener("click", () => {
        pin.shape = s.id;
        lastShape = s.id;
        persist();
        buildEditor(false);
        buildPanel();
        editor.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
      });
      b.addEventListener("keydown", (e) => {
        const delta = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!delta) return;
        e.preventDefault();
        const choices = [...shapes.querySelectorAll<HTMLButtonElement>("button")];
        choices[(choices.indexOf(b) + delta + choices.length) % choices.length]?.click();
      });
      shapes.append(b);
    }
    const row = document.createElement("div");
    row.style.cssText = "display:flex;justify-content:space-between;gap:6px";
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "Delete";
    del.style.cssText = BUTTON_CSS;
    del.addEventListener("click", () => {
      const list = pins();
      const i = list.findIndex((p) => p.id === pin.id);
      if (i >= 0) list.splice(i, 1);
      persist();
      select(null);
      buildPanel();
    });
    const done = document.createElement("button");
    done.type = "button";
    done.textContent = "Done";
    done.style.cssText = BUTTON_CSS;
    done.addEventListener("click", () => select(null));
    row.append(del, done);
    const hint = document.createElement("div");
    hint.style.cssText = "margin-top:6px;color:var(--map-muted,#8b949e);font-size:11px";
    hint.textContent = "Drag the marker to move it. Only you see it.";
    editor.append(title, input, shapes, row, hint);
    placeEditor();
    if (focusLabel) input.focus();
  }
  const glyphCanvas = (shape: PinShape): HTMLCanvasElement => {
    const c = document.createElement("canvas");
    c.width = 18;
    c.height = 18;
    c.style.cssText = "width:18px;height:18px;flex:none";
    c.setAttribute("aria-hidden", "true");
    const lift = shape === "pin" || shape === "flag" ? 16 : 9;
    drawPinGlyph(c.getContext("2d")!, shape, 9, lift, 6, mapInk().pinColor);
    return c;
  };

  // -- the panel: layer legend + toggles, then the player's markers ------------
  function buildPanel(): void {
    const list = pins();
    panelStale = false;
    panel.replaceChildren();
    const head = document.createElement("div");
    head.style.cssText = "font-weight:600;color:var(--map-heading,#e6edf3);margin-bottom:6px;display:flex;justify-content:space-between;gap:12px";
    const name = document.createElement("span");
    name.className = "map-title";
    name.textContent = "World map";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "map-close";
    close.setAttribute("aria-label", "Close world map");
    close.addEventListener("click", hide);
    close.style.cssText = "color:var(--map-muted,#8b949e);font-weight:400";
    close.textContent = "Close · M";
    head.append(name, close);
    panel.append(head);
    const controls = document.createElement("div");
    controls.className = "map-controls";
    for (const [label, action] of [["−", () => zoomAbout(canvas.width / 2, canvas.height / 2, 1 / 1.4)], ["+", () => zoomAbout(canvas.width / 2, canvas.height / 2, 1.4)], ["Fit world", () => { if (data) fit(data); }], ["Find me", () => { const at = options.position(); if (at) { view = { ...view, cx: at.x, cz: at.z, scale: Math.max(view.scale, 0.5) }; dirty = true; placeEditor(); } }]] as const) {
      const b = document.createElement("button"); b.type = "button"; b.textContent = label; b.style.cssText = BUTTON_CSS; b.setAttribute("aria-label", label === "+" ? "Zoom in" : label === "−" ? "Zoom out" : label); b.addEventListener("click", action); controls.append(b);
    }
    panel.append(controls);
    const row = (id: LayerId | "dev", label: string, key: string, checked: boolean, swatch?: (typeof LAYERS)[number], parent: HTMLElement = panel): void => {
      const line = document.createElement("label");
      line.style.cssText = "display:flex;align-items:center;gap:8px;margin:2px 0;cursor:pointer";
      const box = document.createElement("input");
      box.type = "checkbox";
      box.checked = checked;
      box.style.margin = "0";
      box.addEventListener("change", () => setLayer(id, box.checked));
      const sw = document.createElement("canvas");
      sw.width = 18;
      sw.height = 14;
      sw.style.cssText = "width:18px;height:14px;flex:none";
      if (swatch) legendSwatch(sw.getContext("2d")!, swatch, 9, 7);
      const text = document.createElement("span");
      text.style.flex = "1";
      const n = id !== "dev" && id !== "labels" ? counts[id] : undefined;
      text.textContent = label + (n !== undefined ? `  (${n})` : "");
      const k = document.createElement("kbd");
      k.textContent = key;
      k.style.cssText = "color:var(--map-muted,#8b949e);font:11px ui-monospace,Consolas,monospace";
      line.append(box, sw, text, k);
      parent.append(line);
    };
    for (const l of LAYERS.filter((l) => PLAYER_LAYERS.has(l.id))) row(l.id, l.label, l.key, layers.has(l.id), l);
    if (dev) {
      const devOn = devOnly.some((l) => layers.has(l.id));
      panel.append(rule());
      const tools = document.createElement("details");
      tools.className = "map-dev-tools";
      tools.open = devToolsOpen;
      const summary = document.createElement("summary");
      summary.textContent = "Developer tools";
      tools.append(summary);
      tools.addEventListener("toggle", () => { if (tools.isConnected) devToolsOpen = tools.open; });
      row("dev", "Developer overlays", "D", devOn, undefined, tools);
      if (devOn) for (const l of devOnly) row(l.id, l.label, l.key, layers.has(l.id), l, tools);
      panel.append(tools);
    }

    // markers
    panel.append(rule());
    const mh = document.createElement("div");
    mh.style.cssText = "display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px";
    const mt = document.createElement("span");
    mt.style.cssText = "font-weight:600;color:var(--map-heading,#e6edf3)";
    mt.className = "map-heading";
    mt.textContent = `My landmarks · ${list.length}`;
    mh.append(mt);
    panel.append(mh);
    const buttons = document.createElement("div");
    buttons.style.cssText = "display:flex;gap:6px;margin-bottom:4px";
    const add = document.createElement("button");
    add.type = "button";
    add.textContent = placing ? "Click the map…" : "Add marker";
    add.setAttribute("aria-pressed", String(placing));
    add.style.cssText = BUTTON_CSS + (placing ? "background:var(--map-selected,#1f3a5f);border-color:var(--map-accent,#79c0ff);" : "");
    add.addEventListener("click", () => {
      placing = !placing;
      select(null);
      buildPanel();
    });
    const here = document.createElement("button");
    here.type = "button";
    here.textContent = "Mark my spot";
    here.style.cssText = BUTTON_CSS;
    here.addEventListener("click", () => {
      const at = options.position();
      const pin = at ? addPin(at.x, at.z) : null;
      if (pin) select(pin.id, true);
      buildPanel();
    });
    buttons.append(add, here);
    panel.append(buttons);
    const scroller = document.createElement("div");
    scroller.style.cssText = "max-height:150px;overflow:auto";
    for (const p of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.style.cssText = `${BUTTON_CSS}display:flex;align-items:center;gap:6px;width:100%;margin:2px 0;text-align:left;background:${p.id === selected ? "var(--map-selected,#1f3a5f)" : "transparent"};border-color:transparent;`;
      const shape = PIN_SHAPES.find((s) => s.id === p.shape)!;
      const t = document.createElement("span");
      t.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
      t.textContent = p.label || shape.label;
      const sl = document.createElement("span");
      sl.style.cssText = "color:var(--map-muted,#8b949e);font-size:11px";
      sl.textContent = shape.label;
      b.append(glyphCanvas(p.shape), t, sl);
      b.addEventListener("click", () => {
        view = { ...view, cx: p.x, cz: p.z, scale: Math.max(view.scale, 0.4) };
        select(p.id, true);
        buildPanel();
      });
      scroller.append(b);
    }
    panel.append(scroller);
    if (!list.length) {
      const empty = document.createElement("p"); empty.className = "map-empty"; empty.textContent = "Keep a record of what you find. Add a marker, choose its symbol, and give the place a name."; panel.append(empty);
    }
    const help = document.createElement("div");
    help.style.cssText = "margin-top:8px;color:var(--map-muted,#8b949e)";
    help.textContent = `wheel zoom · drag pan · right-click mark · 0 fit · C centre on me${options.travel ? " · click travel" : ""}`;
    panel.append(help);
  }
  const rule = (): HTMLElement => {
    const sep = document.createElement("div");
    sep.style.cssText = "border-top:1px solid var(--map-border,#30363d);margin:6px 0 4px";
    return sep;
  };
  function setLayer(id: LayerId | "dev", on: boolean): void {
    if (id === "dev") {
      if (!dev) return;
      // the DEV switch: places, dungeons, quest givers, spawns, packs, reservations on (sites stay opt-in), or all off
      for (const l of devOnly) layers.delete(l.id);
      if (on) for (const l of devOnly) if (l.id !== "sites") layers.add(l.id);
    } else if (!allowed.has(id)) return;
    else if (on) layers.add(id);
    else layers.delete(id);
    saveLayers();
    buildPanel();
    dirty = true;
  }

  // -- drawing ------------------------------------------------------------------
  function hovered(d: MapData): MapMarker | null {
    if (!cursor) return null;
    const on = shown();
    let best: MapMarker | null = null;
    let bestD = 10;
    const layerOf: Record<MapMarker["kind"], LayerId> = { town: "towns", place: "places", dungeon: "dungeons", quest: "quests", spawn: "spawns", pack: "packs", mob: "packs", reservation: "reservations", site: "sites" };
    for (const m of d.markers) {
      if (!on.has(layerOf[m.kind])) continue;
      const [px, py] = toScreen(m.x, m.z);
      const dist = Math.hypot(px - cursor.px, py - cursor.py);
      if (dist < bestD) {
        bestD = dist;
        best = m;
      }
    }
    return best;
  }

  function draw(now: number): void {
    if (root.style.display === "none") return;
    raf = requestAnimationFrame(draw);
    const world = options.world();
    if (!world) {
      status.textContent = dev ? "this scene has no voxelWorld" : "no map here";
      return;
    }
    const d = current();
    const w = Math.max(1, Math.round(root.clientWidth));
    const h = Math.max(1, Math.round(root.clientHeight));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      dirty = true;
    }
    if (!d) {
      status.textContent = loadNote || "loading map…";
      return;
    }
    if (fitted !== world) {
      fitted = world;
      fit(d);
    }
    pins();
    if (panelStale) buildPanel();
    const here = options.position();
    const playerKey = here ? `${here.x.toFixed(1)},${here.z.toFixed(1)},${here.yaw.toFixed(2)}` : "";
    if (playerKey !== lastPlayer && now - lastDraw > 100) {
      lastPlayer = playerKey;
      dirty = true;
    }
    if (!dirty) return;
    dirty = false;
    lastDraw = now;
    const ctx = canvas.getContext("2d")!;
    const box = (el: HTMLElement): [number, number, number, number] => [el.offsetLeft - 4, el.offsetTop - 4, el.offsetWidth + 8, el.offsetHeight + 8];
    drawMapLayers(ctx, d, { ...view, width: w, height: h }, {
      ...mapInk(),
      layers: shown(),
      base: baseIsPlain ? base : null,
      player: here,
      avoid: [box(panel), box(status)],
      pins: pins(),
      selectedPin: selected,
    });
    if (!baseIsPlain && base) {
      // legacy picture with its own markers baked in (dev only): draw it underneath at its native framing
      ctx.save();
      ctx.globalCompositeOperation = "destination-over";
      const e = base.extent;
      ctx.drawImage(base.image, (-e - view.cx) * view.scale + w / 2, (-e - view.cz) * view.scale + h / 2, 2 * e * view.scale, 2 * e * view.scale);
      ctx.restore();
    }

    const lines: string[] = [];
    if (here) {
      const at = zoneAt(d, here.x, here.z);
      lines.push(`you  ${here.x.toFixed(0)}, ${here.z.toFixed(0)}  ·  ${[at.town, at.zone].filter(Boolean).join(", ") || "outside every zone"}`);
    }
    if (cursor) {
      const [cx, cz] = toWorld(cursor.px, cursor.py);
      const at = zoneAt(d, cx, cz);
      lines.push(
        `cursor  ${cx.toFixed(0)}, ${cz.toFixed(0)}` +
          (here ? `  ·  ${(Math.hypot(cx - here.x, cz - here.z) / 1000).toFixed(2)} km` : "") +
          `\n        ${[at.town, at.zone].filter(Boolean).join(", ") || "no zone"}`,
      );
      const pin = pinAt(cursor.px, cursor.py);
      const m = pin ? null : hovered(d);
      if (pin) lines.push(`▸ your marker: ${pin.label || "(no label)"}  (${PIN_SHAPES.find((s) => s.id === pin.shape)!.label})`);
      else if (m && dev) {
        lines.push(
          `▸ ${m.name}  (${m.kind}${m.level !== undefined ? `, level ${m.level}` : ""}${m.radius ? `, r ${Math.round(m.radius)} m` : ""})` +
            `${m.detail ? `\n  ${m.detail}` : ""}\n  ${m.id} @ ${m.x.toFixed(0)}, ${m.z.toFixed(0)}`,
        );
      } else if (m) lines.push(`▸ ${m.name}`);
    }
    if (dev) lines.push(`${(1 / view.scale).toFixed(1)} m/px`);
    if (placing) lines.push("click the map to place a marker");
    if (loadNote) lines.push(`⚠ ${loadNote}`);
    if (notice) lines.push(`⚠ ${notice}`);
    status.textContent = lines.join("\n");
    placeEditor();
  }

  function hide(): void {
    root.style.display = "none";
    cancelAnimationFrame(raf);
    drag = null;
    cursor = null;
    placing = false;
    select(null);
  }
  function toggle(): void {
    if (root.style.display === "none") {
      root.style.display = "block";
      notice = "";
      dirty = true;
      if (document.pointerLockElement) document.exitPointerLock();
      buildPanel();
      raf = requestAnimationFrame(draw);
    } else hide();
  }

  window.addEventListener(
    "keydown",
    (e) => {
      if (root.style.display === "none" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target instanceof HTMLInputElement && e.target.type !== "checkbox") return;
      const d = data;
      let used = true;
      if (e.code === "Digit0" || e.code === "Numpad0") {
        if (d) fit(d);
      } else if (e.code === "KeyD" && dev) setLayer("dev", !devOnly.some((l) => layers.has(l.id)));
      else if (e.code === "KeyC") {
        const here = options.position();
        if (here) {
          view = { cx: here.x, cz: here.z, scale: Math.max(view.scale, 0.5) };
          dirty = true;
          placeEditor();
        }
      } else if (e.code === "Equal" || e.code === "NumpadAdd") zoomAbout(canvas.width / 2, canvas.height / 2, 1.4);
      else if (e.code === "Minus" || e.code === "NumpadSubtract") zoomAbout(canvas.width / 2, canvas.height / 2, 1 / 1.4);
      else if ((e.code === "Delete" || e.code === "Backspace") && selected) {
        const list = pins();
        const i = list.findIndex((p) => p.id === selected);
        if (i >= 0) list.splice(i, 1);
        persist();
        select(null);
        buildPanel();
      } else if (e.code === "Escape") {
        if (selected || placing) {
          placing = false;
          select(null);
          buildPanel();
        } else hide();
      } else {
        const key = e.code.startsWith("Digit") ? e.code.slice(5) : e.code.startsWith("Key") ? e.code.slice(3) : "";
        const layer = LAYERS.find((l) => l.key === key && allowed.has(l.id));
        if (layer) setLayer(layer.id, !layers.has(layer.id));
        else used = false;
      }
      if (used) {
        e.preventDefault();
        // keep a game's own hotkeys (hotbar digits, Escape menus) from firing under the open map
        e.stopImmediatePropagation();
      }
    },
    true,
  );

  return { toggle, visible: () => root.style.display !== "none" };
}
