import * as THREE from "three/webgpu";
import {
  frameToUv,
  gridFrameRect,
  nearestFrameName,
  resolveSpriteFrame,
  type SpritesheetDoc,
} from "@hitreg/core";

/** Validated `billboard` component data (schema lives in @hitreg/core). */
export interface BillboardData {
  kind: "bar" | "text" | "sprite";
  offset: [number, number, number];
  size: [number, number];
  fill: number;
  color: string;
  background: string;
  backgroundOpacity: number;
  text: string;
  texture?: string;
  /** Spritesheet data-asset id + frame name (wins over texture). */
  sheet?: string;
  frame?: string;
  /** Play the sheet grid's `row` as an animation instead of one static frame. */
  flipbook?: FlipbookData;
  visible: boolean;
}

/** Validated `billboard.flipbook` block (schema lives in @hitreg/core). */
export interface FlipbookData {
  row: number;
  fps: number;
  loop: boolean;
  playing: boolean;
  blending: "normal" | "additive";
  hideOnEnd: boolean;
  /** Multiplied over the frame — a hue control over a white source row. */
  tint: string;
}

/** Resolvers a host injects; sheet lookups come from the AssetLibrary. */
export interface BillboardResolvers {
  texture?: (assetId: string) => string | undefined;
  sheet?: (assetId: string) => SpritesheetDoc | undefined;
}

/** Runtime-only mutations scripts may apply (never written to the document). */
export interface BillboardValue {
  fill?: number;
  text?: string;
  visible?: boolean;
  /** Flipbook only: restart from frame 0 (and unhide). This is how a pooled
   * one-shot effect is re-fired without rebuilding anything. */
  play?: boolean;
  /** Flipbook only: switch colour-variant row. */
  row?: number;
  /** Flipbook only: multiply colour. With a white source row this is free hue. */
  tint?: string;
}

// World-space UI is part of the scene, so geometry in front of it occludes it
// — unlike debug overlays (skeleton/physics), which draw through everything
// with depthTest off.
const DEPTH_TEST = true;

// Canvas resolution: pixels per world unit of billboard extent, clamped so a
// tiny bar still rasterizes cleanly and a huge banner doesn't eat VRAM.
const PX_PER_UNIT = 256;
const MIN_PX = 32;
const MAX_PX = 1024;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function canvasPx(units: number): number {
  return Math.round(Math.min(MAX_PX, Math.max(MIN_PX, units * PX_PER_UNIT)));
}

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

/**
 * One camera-facing element: a THREE.Sprite (auto-faces the camera on both
 * the WebGPU and WebGL backends — same recipe as the skeleton-debug labels).
 * bar/text render into a shared canvas texture; sprite maps the resolved
 * texture asset directly.
 */
class Billboard {
  private readonly sprite: THREE.Sprite;
  private readonly material: THREE.SpriteMaterial;
  private canvas: HTMLCanvasElement | null = null;
  private texture: THREE.CanvasTexture | null = null;
  private fill: number;
  private text: string;
  // last drawn state — the canvas repaints ONLY when fill/text change
  private drawnFill: number | null = null;
  private drawnText: string | null = null;
  /** Flipbook playback: null until a sheet with a grid resolves. */
  private flip: {
    grid: { cols: number; rows: number };
    sheet: SpritesheetDoc;
    imageW: number;
    imageH: number;
    row: number;
    frame: number;
    time: number;
    playing: boolean;
  } | null = null;

  constructor(
    group: THREE.Object3D,
    private readonly data: BillboardData,
    resolvers: BillboardResolvers,
    private readonly diagnose: (message: string) => void,
  ) {
    this.fill = clamp01(data.fill);
    this.text = data.text;
    this.material = new THREE.SpriteMaterial({ transparent: true, depthTest: DEPTH_TEST });

    if (data.kind === "sprite") {
      this.initSprite(resolvers);
    } else if (typeof document !== "undefined") {
      // bar/text: canvas-backed texture (headless Node: untextured sprite)
      this.canvas = document.createElement("canvas");
      this.canvas.width = canvasPx(data.size[0]);
      this.canvas.height = canvasPx(data.size[1]);
      this.texture = new THREE.CanvasTexture(this.canvas);
      this.texture.colorSpace = THREE.SRGBColorSpace;
      this.material.map = this.texture;
      this.redraw();
    }

    this.sprite = new THREE.Sprite(this.material);
    this.sprite.position.fromArray(data.offset);
    this.sprite.scale.set(data.size[0], data.size[1], 1);
    this.sprite.visible = data.visible;
    this.sprite.userData["billboard"] = true;
    this.sprite.raycast = () => {}; // never click-selectable
    group.add(this.sprite);
  }

  /**
   * Sprite kind: a spritesheet frame (sheet+frame) or a whole texture.
   * Missing sheets/frames are a DIAGNOSED condition — magenta placeholder in
   * the scene, structured message to the host (context bridge) — so
   * re-spliced or renamed sheets surface immediately instead of silently.
   */
  private initSprite(resolvers: BillboardResolvers): void {
    const { data } = this;
    if (data.flipbook) {
      this.initFlipbook(resolvers);
      return;
    }
    if (data.sheet !== undefined || data.frame !== undefined) {
      if (!data.sheet || !data.frame) {
        this.diagnose(`billboard: sheet/frame must both be set (sheet="${data.sheet ?? ""}", frame="${data.frame ?? ""}")`);
        this.placeholder(data.frame ?? "?");
        return;
      }
      const sheet = resolvers.sheet?.(data.sheet);
      if (!sheet) {
        this.diagnose(`billboard: spritesheet "${data.sheet}" not found`);
        this.placeholder(data.sheet);
        return;
      }
      const rect = resolveSpriteFrame(sheet, data.frame);
      if (!rect) {
        const near = nearestFrameName(sheet, data.frame);
        this.diagnose(
          `billboard: frame "${data.frame}" missing in sheet "${data.sheet}"` +
            (near ? ` (did you mean "${near}"?)` : ""),
        );
        this.placeholder(data.frame);
        return;
      }
      const url = resolvers.texture?.(sheet.texture);
      if (!url) {
        this.diagnose(`billboard: sheet "${data.sheet}" texture "${sheet.texture}" not found`);
        this.placeholder(sheet.texture);
        return;
      }
      new THREE.TextureLoader().load(
        url,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          const image = texture.image as { width: number; height: number };
          const uv = frameToUv(rect, image.width, image.height);
          texture.offset.set(uv.offsetX, uv.offsetY);
          texture.repeat.set(uv.repeatX, uv.repeatY);
          texture.magFilter = THREE.NearestFilter; // sheets are usually pixel art
          this.material.map = texture;
          this.material.needsUpdate = true;
        },
        undefined,
        (error) => console.warn(`[billboard] sheet texture failed to load: ${url}`, error),
      );
      return;
    }
    const url = data.texture ? resolvers.texture?.(data.texture) : undefined;
    if (url) {
      // swap in async — WebGPU crashes on textures whose image is still null
      new THREE.TextureLoader().load(
        url,
        (texture) => {
          texture.colorSpace = THREE.SRGBColorSpace;
          this.material.map = texture;
          this.material.needsUpdate = true;
        },
        undefined,
        (error) => console.warn(`[billboard] texture failed to load: ${url}`, error),
      );
    } else {
      this.diagnose(`billboard: sprite kind with no resolvable texture "${data.texture ?? ""}"`);
      this.placeholder(data.texture ?? "?");
    }
  }

  /**
   * Flipbook: the sheet's grid IS the timeline — one row of cells played left
   * to right. Only the texture offset moves per frame, so an effect costs one
   * sprite and one texture no matter how many frames it has.
   */
  private initFlipbook(resolvers: BillboardResolvers): void {
    const { data } = this;
    const book = data.flipbook!;
    if (!data.sheet) {
      this.diagnose("billboard: flipbook needs a `sheet`");
      this.placeholder("no sheet");
      return;
    }
    const sheet = resolvers.sheet?.(data.sheet);
    if (!sheet) {
      this.diagnose(`billboard: spritesheet "${data.sheet}" not found`);
      this.placeholder(data.sheet);
      return;
    }
    if (!sheet.grid) {
      this.diagnose(`billboard: flipbook needs sheet "${data.sheet}" to declare a grid`);
      this.placeholder(data.sheet);
      return;
    }
    if (book.row >= sheet.grid.rows) {
      this.diagnose(
        `billboard: flipbook row ${book.row} out of range for sheet "${data.sheet}" (${sheet.grid.rows} rows)`,
      );
      this.placeholder(`row ${book.row}`);
      return;
    }
    const url = resolvers.texture?.(sheet.texture);
    if (!url) {
      this.diagnose(`billboard: sheet "${data.sheet}" texture "${sheet.texture}" not found`);
      this.placeholder(sheet.texture);
      return;
    }
    if (book.blending === "additive") {
      this.material.blending = THREE.AdditiveBlending;
      this.material.depthWrite = false;
    }
    if (book.tint) this.material.color.set(book.tint);
    new THREE.TextureLoader().load(
      url,
      (texture) => {
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.magFilter = THREE.LinearFilter;
        const image = texture.image as { width: number; height: number };
        this.material.map = texture;
        this.material.needsUpdate = true;
        this.flip = {
          grid: { cols: sheet.grid!.cols, rows: sheet.grid!.rows },
          sheet,
          imageW: image.width,
          imageH: image.height,
          row: book.row,
          frame: 0,
          time: 0,
          playing: book.playing,
        };
        this.applyFlipFrame();
      },
      undefined,
      (error) => console.warn(`[billboard] flipbook texture failed to load: ${url}`, error),
    );
  }

  /** Point the material's UV window at the current (row, frame) cell. */
  private applyFlipFrame(): void {
    const flip = this.flip;
    const map = this.material.map;
    if (!flip || !map || !flip.sheet.grid) return;
    const rect = gridFrameRect(flip.sheet.grid, flip.row * flip.grid.cols + flip.frame);
    if (!rect) return;
    const uv = frameToUv(rect, flip.imageW, flip.imageH);
    map.offset.set(uv.offsetX, uv.offsetY);
    map.repeat.set(uv.repeatX, uv.repeatY);
  }

  /** Advance a playing flipbook. No-op for bar/text/static sprites. */
  update(dt: number): void {
    const flip = this.flip;
    const book = this.data.flipbook;
    if (!flip || !book || !flip.playing) return;
    flip.time += dt;
    const next = Math.floor(flip.time * book.fps);
    if (next === flip.frame) return;
    if (next >= flip.grid.cols) {
      if (book.loop) {
        flip.frame = next % flip.grid.cols;
        flip.time %= flip.grid.cols / book.fps;
      } else {
        flip.frame = flip.grid.cols - 1;
        flip.playing = false;
        if (book.hideOnEnd) this.sprite.visible = false;
        return;
      }
    } else {
      flip.frame = next;
    }
    this.applyFlipFrame();
  }

  /** Unmissable magenta stand-in for unresolvable sprite content. */
  private placeholder(label: string): void {
    if (typeof document === "undefined") return;
    this.canvas = document.createElement("canvas");
    this.canvas.width = 128;
    this.canvas.height = 128;
    const ctx = this.canvas.getContext("2d")!;
    ctx.fillStyle = "#ff00ff";
    ctx.fillRect(0, 0, 128, 128);
    ctx.fillStyle = "#000000";
    ctx.font = "600 18px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("?", 64, 48);
    ctx.font = "500 12px system-ui, sans-serif";
    ctx.fillText(label.slice(0, 18), 64, 80);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material.map = this.texture;
    this.material.needsUpdate = true;
  }

  private redraw(): void {
    if (!this.canvas || !this.texture) return;
    if (this.fill === this.drawnFill && this.text === this.drawnText) return;
    this.drawnFill = this.fill;
    this.drawnText = this.text;

    const ctx = this.canvas.getContext("2d")!;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const radius = Math.min(w, h) * 0.25;
    ctx.globalAlpha = this.data.backgroundOpacity;
    ctx.fillStyle = this.data.background;
    roundedRect(ctx, 0, 0, w, h, radius);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (this.data.kind === "bar") {
      const inset = Math.max(1, h * 0.12);
      const trackW = w - inset * 2;
      const trackH = h - inset * 2;
      if (trackW * this.fill >= 0.5) {
        ctx.save();
        // fill rect clipped to the rounded track so partial fills keep corners
        roundedRect(ctx, inset, inset, trackW, trackH, Math.max(0, radius - inset));
        ctx.clip();
        ctx.fillStyle = this.data.color;
        ctx.fillRect(inset, inset, trackW * this.fill, trackH);
        ctx.restore();
      }
    } else {
      ctx.fillStyle = this.data.color;
      ctx.font = `600 ${Math.floor(h * 0.6)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(this.text, w / 2, h / 2);
    }
    this.texture.needsUpdate = true;
  }

  setValue(opts: BillboardValue): void {
    if (opts.fill !== undefined) this.fill = clamp01(opts.fill);
    if (opts.text !== undefined) this.text = opts.text;
    if (opts.visible !== undefined) this.sprite.visible = opts.visible;
    if (this.flip) {
      if (opts.row !== undefined && opts.row < this.flip.grid.rows) this.flip.row = opts.row;
      if (opts.tint) this.material.color.set(opts.tint);
      if (opts.play) {
        this.flip.frame = 0;
        this.flip.time = 0;
        this.flip.playing = true;
        this.sprite.visible = opts.visible ?? true;
      }
      if (opts.row !== undefined || opts.play) this.applyFlipFrame();
    }
    this.redraw(); // no-op when nothing drawn changed
  }

  dispose(): void {
    this.sprite.removeFromParent();
    this.material.map?.dispose();
    this.material.dispose();
    this.texture = null;
    this.canvas = null;
  }
}

/**
 * Data-driven world-space billboard host (HP bars, name labels, icon sprites),
 * shaped like ParticleSystem: entities register during buildScene (via
 * BuildOptions.onBillboard); scripts mutate at runtime through setValue.
 * Sprites face the camera by construction; the only per-frame work is
 * advancing flipbook effects, so `update` is free when none are registered.
 */
export class BillboardSystem {
  private readonly billboards = new Map<string, Billboard>();
  /** Resolution problems (missing sheets/frames/textures) since the last clear —
   * hosts surface these to the context bridge so AI sessions see what to fix. */
  private readonly issues: string[] = [];

  register(
    entityId: string,
    group: THREE.Object3D,
    data: BillboardData,
    resolvers: BillboardResolvers = {},
  ): void {
    this.billboards.get(entityId)?.dispose();
    this.billboards.set(
      entityId,
      new Billboard(group, data, resolvers, (message) => {
        const entry = `${entityId}: ${message}`;
        this.issues.push(entry);
        console.warn(`[billboard] ${entry}`);
      }),
    );
  }

  /** Runtime-only mutation for scripts: fill clamped to 0..1; redraws only on change. */
  setValue(entityId: string, opts: BillboardValue): void {
    this.billboards.get(entityId)?.setValue(opts);
  }

  /** Advance flipbook playback. Call once per rendered frame. */
  update(dt: number): void {
    for (const billboard of this.billboards.values()) billboard.update(dt);
  }

  diagnostics(): readonly string[] {
    return this.issues;
  }

  /** Dispose one entity's billboard (its visuals were rebuilt or removed). */
  unregister(entityId: string): void {
    this.billboards.get(entityId)?.dispose();
    this.billboards.delete(entityId);
  }

  clear(): void {
    for (const billboard of this.billboards.values()) billboard.dispose();
    this.billboards.clear();
    this.issues.length = 0;
  }
}
