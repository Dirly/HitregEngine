/**
 * The in-game world map (M key): the overview PNG `worldgen map` wrote into
 * the project's `assets/maps/`, drawn full-screen with the recipe's towns,
 * peaks and waterfalls labelled, a legend, a scale bar and the player's
 * position and heading. It is the same picture an agent looks at, put in
 * front of the person walking the world, so "the river north of the second
 * town" means the same thing to both.
 *
 * Wheel zooms about the cursor, drag pans, a click (without a drag) asks the
 * host to TRAVEL there — a dev-mode fast-travel, because a 21 km world is
 * not walkable while you are checking it. Nothing here touches the scene:
 * the recipe JSON and the PNG come through the dev server's asset-file
 * endpoint, the overlay is plain DOM, and travel is the host's decision
 * (the callback may decline, and says why in the status line).
 */

interface WorldMapRecipe {
  name: string;
  bounds?: { limit?: number };
  features: {
    towns: { id: string; center: [number, number]; tags: string[] }[];
    pois: { id: string; kind: string; position: [number, number, number] }[];
    lakes: { id: string; center: [number, number] }[];
  };
}

export interface WorldMapOverlayOptions {
  /** World recipe id (the scene's `voxelWorld.world`), or null when the scene has none. */
  world: () => string | null;
  /** Where the player (or, in the editor, the camera focus) is, and which way it faces in radians about +Y. */
  position: () => { x: number; z: number; yaw: number } | null;
  /**
   * Take the player (or the editor camera) to a world point. Return a short
   * message to refuse — it is shown on the map instead of closing it. Omit
   * and clicking does nothing.
   */
  travel?: (x: number, z: number) => string | void;
}

const LEGEND: [string, string][] = [
  ["#f03c3c", "town"],
  ["#ffeb5a", "peak (trail up)"],
  ["#78dcff", "waterfall"],
  ["#4696eb", "river / lake"],
  ["#ebd7a0", "road"],
  ["#c8aa6e", "trail"],
  ["#785436", "canyon"],
  ["#c82828", "world limit"],
  ["#ffffff", "you"],
];

const MIN_ZOOM = 1;
const MAX_ZOOM = 32;
/** Pointer travel below this, press to release, is a click; above it, a drag. */
const CLICK_SLOP_PX = 4;

export function createWorldMapOverlay(options: WorldMapOverlayOptions): { toggle(): void; visible(): boolean } {
  const root = document.createElement("div");
  root.style.cssText =
    "position:fixed;inset:0;z-index:100000;display:none;background:rgba(8,10,14,0.88);color:#e6e9ef;" +
    "font:12px/1.4 ui-monospace,Menlo,Consolas,monospace;user-select:none;";
  const canvas = document.createElement("canvas");
  canvas.style.cssText =
    "position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border:1px solid #2a2f3a;cursor:crosshair;touch-action:none;";
  const legend = document.createElement("div");
  legend.style.cssText = "position:absolute;left:16px;top:16px;background:rgba(14,16,22,0.9);border:1px solid #2a2f3a;padding:10px 12px;border-radius:4px;";
  const status = document.createElement("div");
  status.style.cssText = "position:absolute;right:16px;top:16px;background:rgba(14,16,22,0.9);border:1px solid #2a2f3a;padding:10px 12px;border-radius:4px;max-width:360px;";
  root.append(canvas, legend, status);
  document.body.appendChild(root);

  let image: HTMLImageElement | null = null;
  let recipe: WorldMapRecipe | null = null;
  let loadedFor: string | null = null;
  let raf = 0;
  /** A refusal or an error, shown until the next successful action. */
  let notice = "";

  // -- view: zoom about a pan offset, in canvas pixels ------------------------
  let zoom = 1;
  let panX = 0;
  let panY = 0;
  let size = 0;
  /** Canvas-pixel position of the cursor, or null when it is off the map. */
  let cursor: { px: number; py: number } | null = null;
  let drag: { startX: number; startY: number; panX: number; panY: number; moved: boolean } | null = null;

  const clampPan = (): void => {
    // the image may not leave the canvas: pan is in [size - size*zoom, 0]
    const min = size - size * zoom;
    panX = Math.min(0, Math.max(min, panX));
    panY = Math.min(0, Math.max(min, panY));
  };
  const resetView = (): void => {
    zoom = 1;
    panX = 0;
    panY = 0;
  };
  /** Canvas pixel -> world XZ, given the current extent. */
  const toWorld = (px: number, py: number, extent: number): [number, number] => [
    ((px - panX) / (size * zoom)) * 2 * extent - extent,
    ((py - panY) / (size * zoom)) * 2 * extent - extent,
  ];

  const canvasPoint = (e: PointerEvent | WheelEvent): { px: number; py: number } => {
    const r = canvas.getBoundingClientRect();
    return { px: ((e.clientX - r.left) / r.width) * canvas.width, py: ((e.clientY - r.top) / r.height) * canvas.height };
  };

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const { px, py } = canvasPoint(e);
      const factor = Math.exp(-e.deltaY * 0.0015);
      const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom * factor));
      // keep the world point under the cursor where it is
      const k = next / zoom;
      panX = px - (px - panX) * k;
      panY = py - (py - panY) * k;
      zoom = next;
      clampPan();
    },
    { passive: false },
  );
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const { px, py } = canvasPoint(e);
    drag = { startX: px, startY: py, panX, panY, moved: false };
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener("pointermove", (e) => {
    const p = canvasPoint(e);
    cursor = p;
    if (!drag) return;
    const dx = p.px - drag.startX;
    const dy = p.py - drag.startY;
    if (Math.hypot(dx, dy) > CLICK_SLOP_PX) drag.moved = true;
    if (drag.moved) {
      panX = drag.panX + dx;
      panY = drag.panY + dy;
      clampPan();
    }
  });
  canvas.addEventListener("pointerleave", () => {
    cursor = null;
  });
  canvas.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const wasClick = !drag.moved;
    drag = null;
    canvas.releasePointerCapture(e.pointerId);
    if (!wasClick || !recipe) return;
    if (!options.travel) return;
    const { px, py } = canvasPoint(e);
    const [x, z] = toWorld(px, py, extentOf(recipe));
    const refused = options.travel(x, z);
    if (refused) {
      notice = refused;
      return;
    }
    notice = "";
    hide();
  });

  legend.innerHTML =
    `<div style="font-weight:600;margin-bottom:6px">world map · <span style="opacity:.7">M closes</span></div>` +
    LEGEND.map(
      ([colour, label]) =>
        `<div style="display:flex;align-items:center;gap:8px;margin:2px 0"><span style="display:inline-block;width:10px;height:10px;background:${colour};border-radius:2px"></span>${label}</div>`,
    ).join("") +
    `<div style="margin-top:8px;opacity:.7">wheel zoom · drag pan · 0 reset` +
    (options.travel ? `<br>click: travel there` : "") +
    `</div>`;

  /** The map spans the world limit plus a margin, exactly as `worldgen map` does with no --extent. */
  function extentOf(r: WorldMapRecipe): number {
    const limit = r.bounds?.limit;
    return limit ? Math.ceil((limit + 200) / 100) * 100 : 3000;
  }

  async function load(world: string): Promise<void> {
    loadedFor = world;
    status.textContent = `loading ${world}…`;
    try {
      const [recipeResponse, png] = await Promise.all([
        fetch(`/__hitreg/asset-file?file=${encodeURIComponent(`worlds/${world}.json`)}`),
        fetch(`/__hitreg/asset-file?file=${encodeURIComponent(`maps/${world}.png`)}`),
      ]);
      if (!recipeResponse.ok) throw new Error(`no recipe for "${world}"`);
      recipe = (await recipeResponse.json()) as WorldMapRecipe;
      if (!png.ok) throw new Error(`no map image — run: pnpm -F playground worldgen map ${world}`);
      const blob = await png.blob();
      const img = new Image();
      img.src = URL.createObjectURL(blob);
      await img.decode();
      image = img;
      status.textContent = "";
    } catch (error) {
      image = null;
      status.textContent = String((error as Error).message ?? error);
    }
  }

  function draw(): void {
    if (root.style.display === "none") return;
    raf = requestAnimationFrame(draw);
    const world = options.world();
    if (!world) {
      status.textContent = "this scene has no voxelWorld";
      return;
    }
    if (world !== loadedFor) void load(world);
    if (!image || !recipe) return;
    const wanted = Math.min(window.innerWidth - 40, window.innerHeight - 40);
    if (canvas.width !== wanted) {
      // keep the same world window across a resize: pan scales with the canvas
      if (size > 0) {
        const k = wanted / size;
        panX *= k;
        panY *= k;
      }
      canvas.width = wanted;
      canvas.height = wanted;
      size = wanted;
      clampPan();
    }
    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = zoom < 4; // let the pixels show once the picture is stretched past its own resolution
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(image, panX, panY, size * zoom, size * zoom);
    const limit = recipe.bounds?.limit ?? 3000;
    const extent = extentOf(recipe);
    const toPx = (x: number, z: number): [number, number] => [
      ((x + extent) / (2 * extent)) * size * zoom + panX,
      ((z + extent) / (2 * extent)) * size * zoom + panY,
    ];
    const dot = (x: number, z: number, colour: string, r: number): void => {
      const [px, pz] = toPx(x, z);
      if (px < -r || pz < -r || px > size + r || pz > size + r) return;
      ctx.beginPath();
      ctx.arc(px, pz, r, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.stroke();
    };
    const label = (x: number, z: number, text: string, colour: string): void => {
      const [px, pz] = toPx(x, z);
      if (px < -80 || pz < -20 || px > size + 20 || pz > size + 20) return;
      ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillText(text, px + 7, pz + 4);
      ctx.fillStyle = colour;
      ctx.fillText(text, px + 6, pz + 3);
    };
    for (const poi of recipe.features.pois) {
      if (poi.kind === "peak") dot(poi.position[0], poi.position[2], "#ffeb5a", 3);
      else if (poi.kind === "falls") dot(poi.position[0], poi.position[2], "#78dcff", 3);
      else dot(poi.position[0], poi.position[2], "#ffb45a", 3);
      // zoomed in far enough, every POI can carry its name without a pile-up
      if (zoom >= 8) label(poi.position[0], poi.position[2], poi.id, "#ffe8c8");
    }
    for (const town of recipe.features.towns) {
      dot(town.center[0], town.center[1], "#f03c3c", town.tags.includes("capital") ? 6 : 4);
      label(town.center[0], town.center[1], town.id, "#ffd2d2");
    }
    const here = options.position();
    if (here) {
      const [px, pz] = toPx(here.x, here.z);
      ctx.save();
      ctx.translate(px, pz);
      ctx.rotate(-here.yaw);
      ctx.beginPath();
      ctx.moveTo(0, -9);
      ctx.lineTo(6, 7);
      ctx.lineTo(0, 4);
      ctx.lineTo(-6, 7);
      ctx.closePath();
      ctx.fillStyle = "#ffffff";
      ctx.fill();
      ctx.strokeStyle = "#000";
      ctx.stroke();
      ctx.restore();
    }
    // status: where you are, where the cursor is, and any refusal
    const lines: string[] = [];
    if (here) {
      const nearest = recipe.features.towns
        .map((t) => ({ t, d: Math.hypot(t.center[0] - here.x, t.center[1] - here.z) }))
        .sort((a, b) => a.d - b.d)[0];
      lines.push(
        `you: ${here.x.toFixed(0)}, ${here.z.toFixed(0)}` +
          (nearest ? `  ·  ${nearest.t.id} ${(nearest.d / 1000).toFixed(2)} km away` : ""),
      );
    }
    if (cursor) {
      const [cx, cz] = toWorld(cursor.px, cursor.py, extent);
      lines.push(`cursor: ${cx.toFixed(0)}, ${cz.toFixed(0)}` + (here ? `  ·  ${(Math.hypot(cx - here.x, cz - here.z) / 1000).toFixed(2)} km from you` : ""));
    }
    lines.push(
      `${recipe.features.towns.length} towns, ${recipe.features.pois.length} POIs, world ${((limit * 2) / 1000).toFixed(1)} km across` +
        (zoom > 1 ? `  ·  ${zoom.toFixed(1)}x` : ""),
    );
    if (notice) lines.push(`⚠ ${notice}`);
    status.textContent = lines.join("\n");
    status.style.whiteSpace = "pre";
    // scale bar: 1 km, or 100 m once a kilometre would not fit
    let metres = 1000;
    let bar = (metres / (2 * extent)) * size * zoom;
    if (bar > size * 0.6) {
      metres = 100;
      bar = (metres / (2 * extent)) * size * zoom;
    }
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillRect(size - bar - 24, size - 30, bar + 8, 20);
    ctx.fillStyle = "#fff";
    ctx.fillRect(size - bar - 20, size - 22, bar, 3);
    ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
    ctx.fillText(metres === 1000 ? "1 km" : "100 m", size - bar - 20, size - 26);
  }

  function hide(): void {
    root.style.display = "none";
    cancelAnimationFrame(raf);
    drag = null;
    cursor = null;
  }

  window.addEventListener("keydown", (e) => {
    if (root.style.display === "none") return;
    if (e.code === "Digit0" || e.code === "Numpad0") {
      resetView();
      e.preventDefault();
    }
  });

  return {
    toggle(): void {
      const show = root.style.display === "none";
      if (show) {
        root.style.display = "block";
        notice = "";
        draw();
      } else {
        hide();
      }
    },
    visible: () => root.style.display !== "none",
  };
}
