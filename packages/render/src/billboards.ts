import * as THREE from "three/webgpu";
import {
  frameToUv,
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
  visible: boolean;
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
 * Sprites face the camera by construction, so there is no per-frame update.
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

  diagnostics(): readonly string[] {
    return this.issues;
  }

  clear(): void {
    for (const billboard of this.billboards.values()) billboard.dispose();
    this.billboards.clear();
    this.issues.length = 0;
  }
}
