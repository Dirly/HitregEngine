import * as THREE from "three/webgpu";
import { abs, attribute, clamp, dFdx, dFdy, fract, mix, step, texture, uniform, uv, vec2, vec3, vec4 } from "three/tsl";
import { materialSourceOf, wiredColorMapOf } from "./material-maps.js";
import type { MaterialData } from "./scene-builder.js";

/**
 * Runtime prop atlas: the static batcher's way past "one batch per texture page".
 *
 * Catalogued props are painted onto many separate atlas pages (house-furniture, house-interior, poi-props, strand,
 * rural, pottery, per-prop painted pages, ...). The batcher merges by material, so a crate and a barrel on two pages
 * never merge: Bell Strand drew a dozen-plus page batches per 32 m cell per hide bucket, again in every shadow
 * cascade (docs/performance-lessons.md 2026-11-04). Repacking the shared catalogue per town would fight it being
 * shared, so the packing happens here, at runtime, the first time the batcher meets a page:
 *
 * - each eligible page is drawn once onto a SHEET canvas (shelf-packed, edge-extended gutter so mips and filtering
 *   stay inside the tile). Sheets are keyed by texture sampling ONLY (filters, anisotropy): memory is the cost of
 *   this whole scheme, so everything else a merge must not change (side, cutout, specular, vertex colours) is a
 *   cheap MATERIAL over the same texture, and a sheet starts as tall as its first page and grows in SHEET_GROW steps.
 *   (Keyed by look at a fixed 4096², ten sheets a quarter full cost ~850 MB of GPU memory for 24 pages.)
 * - a material samples `rect.xy + fract(uv) * rect.zw` (clamped instead of wrapped for a clamp-to-edge page), the
 *   rect riding per vertex in TEXELS as SHEET_RECT_ATTRIBUTE so a sheet can grow without touching merged geometry,
 *   gradients from the unwrapped uv so mip selection matches the page's (the town atlas trick, town-atlas.ts);
 * - the batcher re-buckets an eligible mesh under its sheet's material, so props on different pages merge.
 *
 * Eligible = what the sheet material reproduces exactly: an opaque, white-tinted, matte-ish base-colour map with no
 * other maps, no emissive, no vertex colours, no uv transform and no custom shader (wind, atlas, glow...). Anything
 * else keeps its own material and merges as before. The source meshes keep their own materials; only the merged
 * copies sample the sheet, so `dispose()` restores everything. Exceptions Derek named (murals, paintings, glass,
 * mirrors, light shafts) are excluded by the same rule: they carry emissive, alpha, gloss or their own shaders.
 */

/** Per-vertex (x, y, w, h) in texels of the source page on its sheet; w < 0 = clamp instead of wrap. */
export const SHEET_RECT_ATTRIBUTE = "sheetRect";
/** Per-vertex linear RGB multiplier: the source material's `color` (a tinted page shares its untinted sheet). */
export const SHEET_TINT_ATTRIBUTE = "sheetTint";

export interface SheetPlacement {
  material: THREE.Material;
  /** x, y, w, h in texels (w negative: the page clamps rather than repeats). */
  rect: readonly [number, number, number, number];
  /** The source material's colour (linear), multiplied per vertex. */
  tint: readonly [number, number, number];
}

interface SheetCanvas {
  width: number;
  height: number;
  getContext(kind: "2d"): SheetContext | null;
}
interface SheetContext {
  drawImage(image: unknown, ...args: number[]): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
}

export interface PropSheetOptions {
  /** Sheet width and tallest height in pixels (default 4096). */
  size?: number;
  /** Edge-extended gutter around each page, pixels (default 8). */
  gutter?: number;
  /** Most sheets per sampling key (default 2); past it pages keep their own material. */
  maxSheets?: number;
  /** Canvas factory (tests); default OffscreenCanvas. */
  createCanvas?: (width: number, height: number) => SheetCanvas | null;
}

interface Sheet {
  id: number;
  canvas: SheetCanvas;
  ctx: SheetContext;
  texture: THREE.Texture;
  /** One texture node per material, repointed when the sheet grows. */
  nodes: { value: THREE.Texture }[];
  materials: Map<string, THREE.Material>;
  /** 1 / (width, height): rects are texels, so growing touches only this. */
  inverse: { value: THREE.Vector2 };
  x: number;
  y: number;
  shelf: number;
  dirty: boolean;
}

/** A sheet's height grows in steps of this, so a town's pages cost a few reallocations rather than one each. */
const SHEET_GROW = 512;

const MATTE_ROUGHNESS = 0.85;
const WHITE = new THREE.Color(1, 1, 1);

/** What a sheet's one material must match in every page it holds. */
interface SheetLook {
  side: THREE.Side;
  specular: number;
  alphaTest: number;
  vertexColors: boolean;
}

/** The page a material samples, when the sheet material can reproduce it exactly; else null. */
/** Why the last sheetPageOf call said no (PropSheets.stats.why): the cheap way to see what keeps pages off sheets. */
let lastRefusal = "";
const no = (why: string): null => {
  lastRefusal = why;
  return null;
};

export function sheetPageOf(material: THREE.Material): THREE.Texture | null {
  lastRefusal = "";
  if (Array.isArray(material)) return no("array");
  const m = material as THREE.MeshStandardMaterial & THREE.MeshPhysicalMaterial & {
    isNodeMaterial?: boolean; positionNode?: unknown; colorNode?: unknown; emissiveNode?: unknown; normalNode?: unknown;
    roughnessNode?: unknown; metalnessNode?: unknown; opacityNode?: unknown; aoNode?: unknown; outputNode?: unknown;
    fragmentNode?: unknown; vertexNode?: unknown; castShadowNode?: unknown; maskNode?: unknown;
  };
  // node materials do not extend their classic namesakes: a MeshStandardNodeMaterial is not isMeshStandardMaterial
  const node = m as unknown as { isMeshStandardNodeMaterial?: boolean; isMeshPhysicalNodeMaterial?: boolean };
  const physical = m.isMeshPhysicalMaterial === true || node.isMeshPhysicalNodeMaterial === true;
  if (!m.isMeshStandardMaterial && !node.isMeshStandardNodeMaterial && !physical) return no("not-standard");
  // a cutout (alphaTest: Blockbench exports every material as MASK) and baked vertex shading are kept: the sheet key
  // carries both, and the sheet material reproduces them
  if (m.transparent || m.opacity < 1 || m.alphaHash || m.flatShading || m.wireframe) return no("alpha/vcolor/flat");
  if (m.onBeforeCompile !== THREE.Material.prototype.onBeforeCompile) return no("onBeforeCompile");
  if (m.positionNode || m.vertexNode || m.fragmentNode || m.outputNode || m.castShadowNode || m.maskNode) return no("custom-shader");
  let page: THREE.Texture | null | undefined;
  if (m.isNodeMaterial) {
    // a material ASSET: its colour node is `color * map` when its data asks for nothing else (material-maps.ts)
    const data = materialSourceOf(m) as MaterialData | undefined;
    if (!data || !plainAssetData(data)) return no("asset-data");
    if (m.emissiveNode || m.normalNode || m.roughnessNode || m.metalnessNode || m.opacityNode || m.aoNode) return no("asset-nodes");
    page = wiredColorMapOf(m);
  } else {
    if (Object.keys(m.userData).length > 0) return no("gltf-userData");
    if (m.normalMap || m.roughnessMap || m.metalnessMap || m.aoMap || m.emissiveMap || m.alphaMap || m.lightMap ||
        m.bumpMap || m.displacementMap || m.envMap) return no("gltf-extra-maps");
    if (physical && (m.clearcoat > 0 || m.transmission > 0 || m.sheen > 0 || m.iridescence > 0)) return no("gltf-physical-extras");
    if (m.emissive && m.emissive.getHex() !== 0 && m.emissiveIntensity > 0) return no("gltf-emissive");
    page = m.map;
  }
  if (!page || !drawable(page)) return no("no-page");
  if (m.roughness < MATTE_ROUGHNESS || m.metalness > 0.05) return no("glossy/metal");
  if (page.channel !== 0 || page.repeat.x !== 1 || page.repeat.y !== 1 || page.offset.x !== 0 || page.offset.y !== 0 ||
      page.rotation !== 0) return no("uv-transform");
  if (page.colorSpace !== THREE.SRGBColorSpace) return no("not-srgb");
  return page;
}

function plainAssetData(data: MaterialData): boolean {
  if (data.shader !== "standard" || !data.map || data.triplanar) return false;
  if (data.normalMap || data.roughnessMap || data.metalnessMap || data.aoMap || data.ormMap || data.detailNormalMap ||
      data.alphaMap || data.emissiveMap || data.overlay || (data.nightGlow ?? 0) > 0) return false;
  if (data.transparent || (data.opacity ?? 1) < 1 || data.alphaHash) return false;
  if ((data.envMapIntensity ?? 1) !== 1) return false;
  if (data.emissive && data.emissive.toLowerCase() !== "#000000" && (data.emissiveIntensity ?? 1) > 0) return false;
  const [rx, ry] = data.repeat ?? [1, 1];
  const [ox, oy] = data.uvOffset ?? [0, 0];
  if (rx !== 1 || ry !== 1 || ox !== 0 || oy !== 0) return false;
  if ((data as { uvRotation?: number }).uvRotation) return false;
  return true;
}

function drawable(page: THREE.Texture): boolean {
  const image = page.image as { width?: number; height?: number } | null | undefined;
  if (!image || !(image.width! > 0) || !(image.height! > 0)) return false;
  if ((page as THREE.CompressedTexture).isCompressedTexture || (page as THREE.DataTexture).isDataTexture) return false;
  const ok = (type: string): boolean => typeof (globalThis as Record<string, unknown>)[type] === "function" &&
    image instanceof ((globalThis as Record<string, unknown>)[type] as new () => object);
  return ok("ImageBitmap") || ok("HTMLImageElement") || ok("HTMLCanvasElement") || ok("OffscreenCanvas") ||
    (image as { isSheetTestImage?: boolean }).isSheetTestImage === true;
}

function defaultCanvas(width: number, height: number): SheetCanvas | null {
  const Offscreen = (globalThis as { OffscreenCanvas?: new (w: number, h: number) => SheetCanvas }).OffscreenCanvas;
  return Offscreen ? new Offscreen(width, height) : null;
}

export class PropSheets {
  readonly size: number;
  readonly gutter: number;
  readonly maxSheets: number;
  private readonly createCanvas: (width: number, height: number) => SheetCanvas | null;
  private readonly sheets = new Map<string, Sheet[]>();
  /** page (by source: shared pages are one source) + sampling -> its sheet and rect (null: did not fit). */
  private readonly placed = new Map<string, { sheet: Sheet; rect: SheetPlacement["rect"] } | null>();
  readonly stats = { sheets: 0, pages: 0, refused: 0, why: {} as Record<string, number> };

  constructor(options: PropSheetOptions = {}) {
    this.size = options.size ?? 4096;
    this.gutter = options.gutter ?? 8;
    this.maxSheets = options.maxSheets ?? 2;
    this.createCanvas = options.createCanvas ?? defaultCanvas;
  }

  /** Where this material's page sits on a sheet, packing it on first sight; null = keep the material's own. */
  placementFor(material: THREE.Material): SheetPlacement | null {
    const page = sheetPageOf(material);
    if (!page) {
      this.stats.why[lastRefusal] = (this.stats.why[lastRefusal] ?? 0) + 1;
      return null;
    }
    const m = material as THREE.MeshStandardMaterial & THREE.MeshPhysicalMaterial;
    const physical = m.isMeshPhysicalMaterial === true || (m as { isMeshPhysicalNodeMaterial?: boolean }).isMeshPhysicalNodeMaterial === true;
    const look: SheetLook = {
      side: m.side,
      specular: physical ? +(m.specularIntensity ?? 1).toFixed(3) : 1,
      alphaTest: +m.alphaTest.toFixed(3),
      vertexColors: m.vertexColors === true,
    };
    const sampling = [page.magFilter, page.minFilter, page.anisotropy].join("|");
    const pageKey = `${page.source.uuid}|${page.flipY ? 1 : 0}|${page.wrapS}|${sampling}`;
    let spot = this.placed.get(pageKey);
    if (spot === undefined) {
      spot = this.pack(page, sampling);
      this.placed.set(pageKey, spot);
      if (spot) this.stats.pages++;
      else this.stats.refused++;
    }
    if (!spot) return null;
    const c = m.color ?? WHITE;
    return { material: this.materialOf(spot.sheet, look), rect: spot.rect, tint: [c.r, c.g, c.b] };
  }

  /** Upload what changed since the last call: one upload per sheet per batch pass, not per page. */
  flush(): void {
    for (const list of this.sheets.values()) for (const sheet of list) {
      if (!sheet.dirty) continue;
      sheet.texture.needsUpdate = true;
      sheet.dirty = false;
    }
  }

  /** What the sheets hold: each sheet's size, plus total bytes on the GPU (with mips) and behind the canvases. */
  usage(): { sheets: { width: number; height: number; materials: number }[]; gpuMB: number; canvasMB: number } {
    const sheets: { width: number; height: number; materials: number }[] = [];
    let gpu = 0, canvas = 0;
    for (const list of this.sheets.values()) for (const s of list) {
      sheets.push({ width: s.canvas.width, height: s.canvas.height, materials: s.materials.size });
      const bytes = s.canvas.width * s.canvas.height * 4;
      canvas += bytes;
      gpu += s.texture.generateMipmaps ? bytes * 4 / 3 : bytes;
    }
    return { sheets, gpuMB: Math.round(gpu / 1048576), canvasMB: Math.round(canvas / 1048576) };
  }

  private pack(page: THREE.Texture, sampling: string): { sheet: Sheet; rect: SheetPlacement["rect"] } | null {
    const image = page.image as { width: number; height: number };
    const g = this.gutter;
    const w = image.width, h = image.height;
    const cellW = w + 2 * g, cellH = h + 2 * g;
    if (cellW > this.size || cellH > this.size) return null;
    let list = this.sheets.get(sampling);
    if (!list) this.sheets.set(sampling, (list = []));
    let sheet = list.find((s) => this.fits(s, cellW, cellH));
    if (!sheet) {
      if (list.length >= this.maxSheets) return null;
      const made = this.makeSheet(page, cellH);
      if (!made) return null;
      list.push(made);
      sheet = made;
    }
    // shelf packing: next to the last page, else a new shelf under the tallest of this row
    if (sheet.x + cellW > this.size) {
      sheet.y += sheet.shelf;
      sheet.x = 0;
      sheet.shelf = 0;
    }
    if (sheet.y + cellH > sheet.canvas.height && !this.grow(sheet, sheet.y + cellH)) return null;
    const x = sheet.x + g, y = sheet.y + g;
    sheet.x += cellW;
    sheet.shelf = Math.max(sheet.shelf, cellH);
    try {
      this.draw(sheet, page, x, y, w, h);
    } catch {
      return null; // a closed or tainted image: the page keeps its own material (its slot stays empty)
    }
    sheet.dirty = true;
    const clampPage = page.wrapS === THREE.ClampToEdgeWrapping && page.wrapT === THREE.ClampToEdgeWrapping;
    return { sheet, rect: [x, y, clampPage ? -w : w, h] };
  }

  private fits(sheet: Sheet, w: number, h: number): boolean {
    if (sheet.x + w <= this.size) return sheet.y + Math.max(sheet.shelf, h) <= this.size;
    return sheet.y + sheet.shelf + h <= this.size;
  }

  private draw(sheet: Sheet, page: THREE.Texture, x: number, y: number, w: number, h: number): void {
    const { ctx } = sheet;
    const g = this.gutter;
    // the sheet uploads with flipY false: a flipY page is drawn upside down so its uv lands on the same texel
    if (page.flipY) {
      ctx.save();
      ctx.translate(0, y + h);
      ctx.scale(1, -1);
      ctx.drawImage(page.image, x, 0, w, h);
      ctx.restore();
    } else ctx.drawImage(page.image, x, y, w, h);
    // edge-extended gutter: mips and filter taps near a tile edge read the page's own border, not a neighbour
    const c = sheet.canvas;
    ctx.drawImage(c, x, y, 1, h, x - g, y, g, h);
    ctx.drawImage(c, x + w - 1, y, 1, h, x + w, y, g, h);
    ctx.drawImage(c, x - g, y, w + 2 * g, 1, x - g, y - g, w + 2 * g, g);
    ctx.drawImage(c, x - g, y + h - 1, w + 2 * g, 1, x - g, y + h, w + 2 * g, g);
  }

  private heightFor(need: number): number {
    return Math.min(this.size, Math.ceil(need / SHEET_GROW) * SHEET_GROW);
  }

  private textureOf(canvas: SheetCanvas, id: number, like: THREE.Texture): THREE.Texture {
    const map = new THREE.Texture(canvas as unknown as HTMLCanvasElement);
    map.name = `prop-sheet:${id}`;
    map.colorSpace = THREE.SRGBColorSpace;
    map.flipY = false;
    map.wrapS = map.wrapT = THREE.ClampToEdgeWrapping;
    map.magFilter = like.magFilter;
    map.minFilter = like.minFilter;
    map.anisotropy = like.anisotropy;
    map.generateMipmaps = like.minFilter !== THREE.NearestFilter && like.minFilter !== THREE.LinearFilter;
    return map;
  }

  /** Taller canvas and texture, old pixels copied; merged geometry is untouched (rects are texels). */
  private grow(sheet: Sheet, need: number): boolean {
    const canvas = this.createCanvas(this.size, this.heightFor(need));
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return false;
    ctx.drawImage(sheet.canvas, 0, 0);
    const old = sheet.texture;
    sheet.canvas = canvas;
    sheet.ctx = ctx;
    sheet.texture = this.textureOf(canvas, sheet.id, old);
    sheet.inverse.value.set(1 / canvas.width, 1 / canvas.height);
    for (const node of sheet.nodes) node.value = sheet.texture;
    for (const material of sheet.materials.values()) (material as THREE.MeshStandardNodeMaterial).map = sheet.texture;
    old.dispose();
    sheet.dirty = true;
    return true;
  }

  private makeSheet(page: THREE.Texture, height: number): Sheet | null {
    const canvas = this.createCanvas(this.size, this.heightFor(height));
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return null;
    const id = this.stats.sheets++;
    const inverse = uniform(new THREE.Vector2(1 / canvas.width, 1 / canvas.height));
    return {
      id, canvas, ctx, texture: this.textureOf(canvas, id, page), nodes: [], materials: new Map(),
      inverse: inverse as unknown as Sheet["inverse"], x: 0, y: 0, shelf: 0, dirty: true,
    };
  }

  /** One material per look on a sheet: they share its texture, so a new look costs a shader, not memory. */
  private materialOf(sheet: Sheet, { side, specular, alphaTest, vertexColors }: SheetLook): THREE.Material {
    const key = [side, specular, alphaTest, vertexColors ? 1 : 0].join("|");
    const known = sheet.materials.get(key);
    if (known) return known;
    const material = specular !== 1
      ? new THREE.MeshPhysicalNodeMaterial({ roughness: 1, metalness: 0, side, specularIntensity: specular })
      : new THREE.MeshStandardNodeMaterial({ roughness: 1, metalness: 0, side });
    material.name = sheet.texture.name;
    material.alphaTest = alphaTest;
    material.vertexColors = vertexColors;
    // keep `map` set: per-asset tooling reaches the page through it (as the town atlas does)
    (material as THREE.MeshStandardNodeMaterial).map = sheet.texture;
    const rect = vec4(attribute<"vec4">(SHEET_RECT_ATTRIBUTE, "vec4"));
    const inverse = sheet.inverse as unknown as ReturnType<typeof vec2>;
    const tiled = uv();
    const size = vec2(abs(rect.z), rect.w).mul(inverse);
    // w < 0: a clamp-to-edge page clamps; otherwise the page repeats like its own wrap did
    const local = mix(fract(tiled), clamp(tiled, 0, 0.99999), step(rect.z, 0));
    const inTile = rect.xy.mul(inverse).add(local.mul(size));
    const gradUv = tiled.mul(size);
    const node = texture(sheet.texture, inTile);
    sheet.nodes.push(node as unknown as { value: THREE.Texture });
    // nearest on both filters: no mips to choose, and three binds no sampler for such a texture while its grad() still
    // names one, which fails the shader. Plain sampling reads the same texels.
    const unfiltered = sheet.texture.minFilter === THREE.NearestFilter && sheet.texture.magFilter === THREE.NearestFilter;
    const sampled = unfiltered ? node : node.grad(dFdx(gradUv), dFdy(gradUv));
    const tint = vec3(attribute<"vec3">(SHEET_TINT_ATTRIBUTE, "vec3"));
    (material as THREE.MeshStandardNodeMaterial).colorNode = vec4(sampled.rgb.mul(tint), sampled.a);
    sheet.materials.set(key, material);
    return material;
  }
}
