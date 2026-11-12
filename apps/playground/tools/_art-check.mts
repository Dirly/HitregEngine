/**
 * ART CHECK rules (QA-C art audit, 2026-10-18): what a place's surfaces look like beside the ground they stand on,
 * measured, never judged by eye. Pure: the CLI (tools/art-check.mts) gathers an `ArtInput` from a POI job (its
 * landmark bakes and specs, paint ops, scene props, the terrain around it, the world scene's portals) and these rules
 * turn it into faults. Every threshold is data (`artThresholdsSchema`, each `.describe()`d); tests: test/art-check.test.ts.
 *
 *   texel   every surface's effective texels/m (UV, triplanar, terrain-splat) against its neighbours: natural rock
 *           against the terrain's own stone around it, built surfaces against the town standard and the props near it
 *   value   mean L* (texture x tint, + emissive lift) inside the zone ground's band; nothing near-black
 *   variety materials follow architectural parts; continuous parts stay coherent and supports/trim/paving contrast
 *           with wall faces. Raw texture counts/repeats are optional diagnostics, never a reason to stripe a wall.
 *   portal  every cut opening deeper than the threshold and the place's dungeon door has a portal (veil + travel
 *           target) or is declared sealed (handoff.json `doors`) — and a sealed door is not cut open
 *   form    landmark-spec lint: identical hero parts repeated, chains of butted raw boxes, a mostly-unbevelled-box
 *           landmark, and the scale cue (stone course height against the culture: giant work needs giant blocks)
 *   measure a job whose delivered art yields no measured surface at all fails: "nothing measured" is never an ok
 *
 * Pieces are landmark bakes and paint ops (world ops) and the POI's OWNED scene entities (job scene ops + world-scene
 * entities tagged `poi:<id>`): added meshes and structure-sized prefabs are `mesh` pieces judged like built work,
 * smaller prefab instances are `prop` pieces (catalogued: value + natural texel only, no built-target texel).
 */
import { z } from "zod";

/** Size tiers (tools/poi-review/size-tiers.mjs SIZE_NAMES). */
const TIERS = ["pinpoint", "small", "medium", "large"] as const;
const MATERIAL_PURPOSES = ["wall", "support", "trim", "arch", "foundation", "paving", "roof", "timber", "metal", "glazing", "other"] as const;
const materialPurposeSchema = z.enum(MATERIAL_PURPOSES);
export type MaterialPurpose = z.infer<typeof materialPurposeSchema>;
const range = (lo: number, hi: number, what: string) => z.tuple([z.number().positive(), z.number().positive()]).default([lo, hi]).describe(what);

export const artThresholdsSchema = z.object({
  texel: z.object({
    radius: z.number().positive().default(30).describe("Metres around each piece in which terrain is sampled and catalogued props count as its neighbours."),
    minArea: z.number().min(0).default(4).describe("Surfaces smaller than this (m²) are not judged: trims, ropes, small hand-made detail."),
    naturalRatio: range(0.6, 1.6, "Natural rock (triplanar / splat / natural-role) texels/m over the terrain's stone around it (its steep samples; all samples when none are steep): outside this window the rock reads as a different scale of art than the mountain behind it."),
    builtTarget: z.number().positive().default(40).describe("Town texel standard for built surfaces (texels/m)."),
    setInMax: z.number().min(1).default(1.15).describe("A built piece SET INTO the ground or a cliff (layout `bedded`, placeRule seat `set-in`): its surfaces' texels/m over the terrain's stone around it (steep samples) may not exceed this. A piece set into a 20 tx/m cliff cannot be 40 (coordinator 2026-10-30, the Weeping Sun face)."),
    setInContrast: z.number().min(1).default(1.5).describe("FINDING (not a fault): a set-in piece's picture contrast (luma sd) over the terrain stone's around it above this reads crisper/finer than the rock (the Weeping Sun face: 2x the cliff's on screen, at the same 40 tx/m)."),
    builtTolerance: z.number().min(0).default(8).describe("Allowed deviation of a built surface from builtTarget (texels/m)."),
    stretch: z.number().min(1).default(1.3).describe("A UV-laid triangle whose texels are longer one way than the other by more than this (the ratio of its world-to-UV map's singular values) is STRETCHED: a sheared coping, a squashed bevel. The area median hides it (a shear keeps the texel area)."),
    stretchShare: z.number().min(0).max(1).default(0.05).describe("Largest share of a built surface's UV-laid area that may be stretched (every face counted, tops and caps included)."),
    propRatio: range(0.6, 1.6, "Built surface texels/m over the area-weighted median of the catalogued props within radius (when there are any)."),
    groundRatio: range(0.6, 1.6, "The job's OWN terrain (height-patch tops, passage walls and ceilings: the splat the terrain draws there) over the built surfaces beside it, both AS SEEN (texels/m over the texture's detailScale): outside this window the ground reads as a coarser (or finer) scale of art than the timber and stone set into it."),
  }).prefault({}),
  value: z.object({
    minArea: z.number().min(0).default(4).describe("Surfaces smaller than this (m²) are not judged for value."),
    maxDelta: z.number().positive().default(12).describe("Largest |mean L* - zone ground L*| a surface may have: brighter reads white in sun, darker reads as a hole."),
    accentExtra: z.number().min(0).default(20).describe("An accent material (zone palette builtStone.accent) may stand this many L* brighter than the band (maxDelta) over the ground..."),
    accentShare: z.number().min(0).max(1).default(0.15).describe("...while it covers at most this share of the piece's measured area."),
    minL: z.number().min(0).default(15).describe("Mean L* floor for any judged surface: under it a dark grain mask needs a light tint plus an emissive lift (proving: white-ish tint, emissiveMap = the same mask at 0.15-0.75)."),
  }).prefault({}),
  variety: z.object({
    mode: z.enum(["architecture", "counts"]).default("architecture").describe("architecture: gate coherent architectural parts and their material contrasts; numeric tile/count/repeat limits are diagnostics. counts: explicitly opt into the older numeric variety gate. Neither mode adds textures or changes geometry."),
    contrastPairs: z.array(z.tuple([materialPurposeSchema, materialPurposeSchema])).default([["wall", "support"], ["wall", "trim"], ["wall", "arch"], ["wall", "paving"]]).describe("Architectural purposes that should use different source pictures when both occur on a piece. Supports and trim may share dressed stone. Compared by texture hash/path, not material IDs or tints. Only roles actually emitted by the source geometry participate."),
    allowPatterns: z.boolean().default(false).describe("Allow multiple materials across one continuous source part (explicitly authored alternation). Default false: a face variant list or differently textured tiers of one pier fail instead of satisfying texture-variety targets."),
    minDistinct: z.object({ pinpoint: z.number().int().min(0).default(1), small: z.number().int().min(0).default(1), medium: z.number().int().min(0).default(2), large: z.number().int().min(0).default(3) })
      .prefault({}).describe("Legacy distinct-picture target by size tier. Diagnostic in architecture mode; enforced only in counts mode. A large continuous wall does not need arbitrary extra textures."),
    maxTileArea: z.number().positive().default(2500).describe("Legacy per-picture area limit (m²). Diagnostic in architecture mode; enforced only in counts mode. Never satisfy it by adding arbitrary bands to a continuous part."),
    maxRepeats: z.number().positive().default(250).describe("Legacy per-picture repeat limit, over at least repeatMinArea. Diagnostic in architecture mode; enforced only in counts mode. Repetition alone does not establish an architectural material fault."),
    repeatMinArea: z.number().min(0).default(1000).describe("A tile is judged for repeats only when it covers at least this many m² (a rope or trim band repeats by nature)."),
    houseTiles: z.array(z.string()).default(["town-roles/"]).describe("Texture path prefixes of the house's own role tiles (low colour count by design, PSX): never judged as a recoloured mask."),
    minColours: z.number().int().positive().default(32).describe("Distinct colours (5-bit quantised) a built texture on a large surface must have: fewer is a recoloured mask that reads as a flat field."),
    colourMinArea: z.number().min(0).default(25).describe("A texture is judged for colour count only when it covers at least this many m²."),
  }).prefault({}),
  portal: z.object({
    reach: z.number().positive().default(15).describe("Metres (plan distance) from an opening or dungeon door within which its portal must stand; at least the opening's width."),
    minDepth: z.number().min(0).default(0.5).describe("Cut openings at least this deep are doors: a portal or a sealed declaration is required."),
  }).prefault({}),
  form: z.object({
    heroSize: z.number().positive().default(2).describe("Parts whose largest side is at least this (m) are hero parts for the form lint; smaller parts are detail."),
    maxIdentical: z.number().int().min(2).default(4).describe("Identical copies of one spec part or group (same shape, sizes, roles and children; only position/rotation/name differ) in one landmark: at this count they read as copies (spires, hull pairs, block pairs, chained treads). Counted at the outermost repeated level."),
    nearCopy: z.number().min(0).max(1).default(0.25).describe("Two parts of one shape, role and outline whose every bounds side is within this fraction of each other are near-copies (four hull slabs 16-21 m tall, eight spire cores)."),
    rhythmCv: z.number().min(0).default(0.15).describe("Copies standing evenly spaced on one straight line (spacing coefficient of variation under this, within 1 m of the line) are a RHYTHM — vault ribs, a colonnade — not copies; stacked treads are judged by the butted-box rule instead."),
    copySize: z.number().positive().default(6).describe("A part or group is judged for copies only when its largest side is at least this (m): bale rolls, posts and pegs are modules by nature."),
    maxButted: z.number().int().min(2).default(6).describe("Unbevelled hero boxes butted together (touching within buttGap) in one chain: at this count the structure reads as stacked cubes."),
    buttGap: z.number().min(0).default(0.3).describe("Metres between two boxes' bounds that still counts as butted."),
    maxRawBoxShare: z.number().min(0).max(1).default(0.6).describe("Largest share of a built landmark's surface that may be unbevelled hero boxes (give them `bevel`, or use kit parts)."),
  }).prefault({}),
  scale: z.object({
    minPeriodicity: z.number().min(0).max(1).default(0.35).describe("Row autocorrelation peak above which a texture is read as coursed masonry (its course height is then judged)."),
    giantMinCourse: z.number().positive().default(1).describe("Giant culture: smallest course height (m) of a coursed stone surface; a 30 cm course on a giants' wall reads as a human retaining wall."),
    humanMaxCourse: z.number().positive().default(1.2).describe("Human-scale culture: largest course height (m) of a coursed stone surface."),
    stoneMaterials: z.string().default("stone|quarry|ashlar|masonry|brick|block|cut|wall|paving|flag").describe("Case-insensitive regex on a material id: only these are read as coursed stone for the scale cue (bales, thatch, bone have no courses)."),
  }).prefault({}),
  measure: z.object({
    structureSize: z.number().positive().default(6).describe("An owned prefab instance whose largest side (x its scale) is at least this (m) is a structure (`mesh` piece: built texel target, variety, form) rather than a catalogued prop."),
  }).prefault({}),
}).describe("art-check thresholds (tools/art-check.mts). Defaults are the house rule; a project may override in authoring/art-check.json.");
export type ArtThresholds = z.infer<typeof artThresholdsSchema>;

/** A door the job declares (handoff.json `doors`): `name` = "<landmark op id>/<opening name>", or "dungeon" for the place's dungeon door. */
export const artDoorSchema = z.object({
  name: z.string().min(1).describe('"<landmark op id>/<opening name>", or "dungeon" for the place\'s dungeon door (zone brief places[].dungeon).'),
  sealed: z.boolean().describe("true: the door is shut on purpose (no dungeon behind it yet, or never): no opening may be cut there; its leaves read closed (barred, chained, rubble)."),
  why: z.string().min(3).optional().describe("Why it is sealed."),
  at: z.tuple([z.number(), z.number()]).optional().describe('World [x, z] of the dungeon door (name "dungeon" only), when it is not the first landmark opening or a landmark named door/mouth/gate/entrance.'),
}).strict();
export type ArtDoor = z.infer<typeof artDoorSchema>;

export type CultureScale = "giant" | "human";

/** One surface (material) of a piece, measured. */
export interface ArtMaterial {
  id: string;
  /** m² it covers. */
  area: number;
  /** Area-weighted median effective texels per metre. */
  texels: number;
  /** World-projected (triplanar / splat / terrain paint) rather than UV-mapped. */
  projected: boolean;
  /** The terrain's own stone (natural role / DC rock / terrain paint): judged against the terrain, never a built tile. */
  natural: boolean;
  /** Mean L* (texture x tint + emissive lift), null when unknown. */
  lstar: number | null;
  /** Distinct colours of its texture (5-bit), null when unknown. */
  colours: number | null;
  /** Its picture's luma sd (contrast, 0-255; the whole picture), when known. */
  lumaSd?: number | null;
  /** Texture pixels [w, h], null for a flat colour. */
  px: [number, number] | null;
  /** Its texture path (house role tiles are exempt from the colour-count rule). */
  map?: string | null;
  /** Content hash of its texture file: the PICTURE (several material ids, tints or paths over one picture are one tile to the eye). */
  mapHash?: string | null;
  /** Course height in metres when the texture reads as coursed (row periodicity >= threshold), else null. */
  course: number | null;
  periodicity?: number;
  /** The mesh names this material but no asset of that id is in the project closure: it renders as the default. */
  missing?: boolean;
  /** Times its texture is laid down, measured from the mesh's own UVs (UV-space area, at least 1 per instance) — set for
   *  catalogued props/meshes with their own atlas: then repeats come from this, not from the tiled-area estimate. */
  uvRepeats?: number;
  /** Share of its UV-laid area laid STRETCHED (texels longer one way than the other by more than texel.stretch; uvStretchByMaterial), and its worst ratio. */
  stretch?: { share: number; worst: number };
  /** Texels/m AS SEEN: `texels` over its texture's `detailScale` (a 512 px tile whose marks span 4 px reads like a 128 px one). */
  seen?: number | null;
  /** Ground pieces (a job height patch's top): the m2 of this surface the JOB'S OWN PAINT put there (its groundPaints), over
   *  what the zone's own paint would show on the same ground. Set = only this area is judged against the built work beside
   *  it; ground wearing the zone's own paint, as the untouched land beside it does, is not art the job added (coordinator
   *  2026-10-31, Derek: built masonry matches the surrounding ROCK). Unset (passage walls / ceilings): the whole area. */
  painted?: number;
  /** Its texture is laid on triangles with NO UVs and no world projection (not triplanar): every pixel samples one texel,
   *  the picture never shows (a stamp landmark's lip/trim role on a non-triplanar material). */
  noUv?: boolean;
}
export interface ArtPiece {
  /** Landmark op id, paint op id or prefab id. */
  id: string;
  /** landmark / paint world op; `mesh` = an owned scene structure (added mesh or structure-sized prefab); `prop` = an owned catalogued prop instance;
   *  `ground` = the job's OWN terrain (a height patch's top, its passages' walls and ceilings), materials = the splat surfaces drawn there. */
  kind: "landmark" | "paint" | "mesh" | "prop" | "ground";
  at: [number, number];
  /** SET INTO the ground or a cliff (layout `bedded`, placeRule seat `set-in`): its texels may not be finer than the stone round it. */
  setIn?: boolean;
  /** Not matched to the surrounding rock (`groundBandFree`: a loose prop, a ship or boat, a tent or lean-to): the value
   *  rule's ground band does not judge it; the near-black floor still does. */
  bandFree?: boolean;
  materials: ArtMaterial[];
  /** Bindings from emitted source roles to the baked materials. Absent = source roles unavailable, reported for visual review. */
  architecture?: ArchitecturalMaterialBinding[];
  /** Compiler digest against the installed prefab identity. False means the architectural source/materials were not baked. */
  architectureBakeMatchesSource?: boolean;
}
export interface ArchitecturalMaterialBinding { sourceRole: string; part: string; purpose: MaterialPurpose; material: string }
export interface ArtOpening { landmark: string; name: string; at: [number, number]; width: number; depth: number }
export interface ArtPortal { id: string; at: [number, number]; scene: string | null; veil: boolean }
/** A compiled landmark spec, reduced to what the form lint needs (nodes in the landmark's local frame). */
export interface FormNode { name: string; role: string; natural: boolean; op: string; shape: string; dims: [number, number, number]; min: [number, number, number]; max: [number, number, number]; bevel: number; area: number }
/** One spec part or group: its signature (the part minus name/at/rot, children likewise), size and enclosing group's signature. */
export interface FormUnit { name: string; sig: string; size: number; parent: string | null; /** shape|role|outline vertex count: what must match for two units to be near-copies */ kind?: string; /** bounds sides, sorted */ dims?: number[]; /** its `at` in its parent's frame */ at?: [number, number, number] }
/** Signature units of a landmark spec's part tree; `size` = largest side of the part's compiled bounds (from `sizeOf`). */
export function specUnits(parts: unknown[], sizeOf: (part: Record<string, unknown>) => number | number[]): FormUnit[] {
  const strip = (p: Record<string, unknown>): unknown => { const { name: _n, at: _a, rot: _r, ...rest } = p; return { ...rest, ...(Array.isArray(p.parts) ? { parts: (p.parts as Record<string, unknown>[]).map(strip) } : {}) }; };
  const out: FormUnit[] = [];
  const sizes = new Map<string, number[]>();
  const walk = (list: unknown[], parent: string | null) => {
    for (const raw of list) {
      const p = raw as Record<string, unknown>;
      if (!p || typeof p !== "object" || p.op === "sub" || p.node) continue;
      const sig = JSON.stringify(strip(p));
      if (!sizes.has(sig)) { const v = sizeOf(p); sizes.set(sig, (Array.isArray(v) ? [...v] : [v]).sort((a, b) => a - b)); }
      const dims = sizes.get(sig)!;
      const kind = `${p.shape}|${p.role ?? ""}|${Array.isArray(p.polygon) ? p.polygon.length : Array.isArray(p.parts) ? p.parts.length : ""}`;
      const at = (Array.isArray(p.at) ? p.at : [0, 0, 0]) as [number, number, number];
      out.push({ name: String(p.name ?? p.shape ?? "part"), sig, size: dims[dims.length - 1] ?? 0, parent, kind, dims, at });
      if (Array.isArray(p.parts)) walk(p.parts, sig);
    }
  };
  walk(parts, null);
  return out;
}
export interface ArtInput {
  tier: (typeof TIERS)[number] | null;
  culture: CultureScale;
  /** Zone ground mean L* around the place (flat terrain samples). */
  groundL: number | null;
  /** Accent material ids (every zone palette's builtStone.accent): judged by value.accentExtra / accentShare. */
  accent?: string[];
  /** Terrain texels/m around each piece: all samples and steep ones (null when none are steep). */
  terrain: Record<string, { texels: number; steep: number | null; lstar: number | null; steepSd?: number | null }>;
  /** Area-weighted median texels/m of the catalogued props near each piece (null when none). */
  props: Record<string, number | null>;
  pieces: ArtPiece[];
  openings: ArtOpening[];
  /** The place has a dungeon behind it (zone brief places[].dungeon). */
  dungeon: { name: string; at: [number, number] } | null;
  portals: ArtPortal[];
  doors: ArtDoor[];
  forms: Record<string, FormNode[]>;
  /** Per landmark: every spec part and group as a unit (for the copies rule). */
  units?: Record<string, FormUnit[]>;
  /** Per `ground` piece: area-weighted texels/m AS SEEN of the built surfaces beside it (null when none). */
  built?: Record<string, number | null>;
}
export interface ArtFault { rule: "texel" | "value" | "variety" | "portal" | "form" | "scale" | "measure"; piece: string; what: string; detail: string }

const r1 = (v: number) => Math.round(v * 10) / 10;
const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** FINDINGS (never faults): a set-in piece whose picture contrast is well over the terrain stone's around it reads crisper
 *  (finer) than the rock at the same texels/m (o-gates 2026-10-30: the Weeping Sun face, sd 2x the cliff's on screen). */
export function contrastFindings(inp: ArtInput, t: ArtThresholds): string[] {
  const out: string[] = [];
  for (const p of inp.pieces) {
    const ref = inp.terrain[p.id]?.steepSd; if (!p.setIn || !ref) continue;
    for (const m of p.materials) if (!m.natural && m.area >= t.texel.minArea && m.lumaSd && m.lumaSd / ref > t.texel.setInContrast)
      out.push(`${p.id} ${m.id}: picture contrast (luma sd) ${r1(m.lumaSd)} vs the stone it is set into ${r1(ref)} (${r1(m.lumaSd / ref)}x > ${t.texel.setInContrast}x): reads crisper than the rock; calm it`);
  }
  return out;
}
/** Prefab instances that are NOT "the props around" a built piece (texel propRatio): landmarks (built pieces), creatures
 *  (mobs/*: a ghost knight at 100 texels/m beside a gate is not the prop scale) and characters (characters/*: the player a
 *  lab spawns at the place, NPCs; r-found 2026-10-31, the lab-spawned player at 11.9 tx/m was the only prop within 30 m of
 *  Red Dial's west compound and failed its stone 3.4x). */
export const NOT_PROPS_RE = /^(landmarks|mobs|characters)\//;
export function texelFaults(inp: ArtInput, t: ArtThresholds): ArtFault[] {
  const out: ArtFault[] = [];
  for (const p of inp.pieces) {
    if (p.kind === "ground") continue; // groundFaults
    const ter = inp.terrain[p.id], props = inp.props[p.id] ?? null;
    for (const m of p.materials) {
      if (m.noUv && m.px && m.area >= t.texel.minArea) {
        out.push({ rule: "texel", piece: p.id, what: m.id, detail: `${r1(m.area)} m² laid with no UVs and no world projection: its ${m.px.join("x")} picture samples ONE texel (a flat colour). Make the material triplanar (triplanarScale = pixels / 40) or bake the part with UVs` });
        continue;
      }
      if (m.area < t.texel.minArea || !Number.isFinite(m.texels) || m.texels <= 0) continue;
      // owner walk kirk-knowe 2026-10-21: "the top of the wall, its texture is stretched" passed at 40 tx/m (a shear keeps the area)
      if (!m.natural && !m.projected && p.kind !== "prop" && m.stretch && m.stretch.share > t.texel.stretchShare)
        out.push({ rule: "texel", piece: p.id, what: m.id, detail: `${Math.round(m.stretch.share * 100)}% of its UV-laid area is stretched (texels up to ${r1(m.stretch.worst)}:1, allowed ${t.texel.stretch}:1 on ${Math.round(t.texel.stretchShare * 100)}%): lay every face, tops and caps included, planar in its own plane (re-bake)` });
      if (m.natural) {
        const ref = ter ? ter.steep ?? ter.texels : null;
        if (!ref) continue;
        const r = m.texels / ref;
        if (r < t.texel.naturalRatio[0] || r > t.texel.naturalRatio[1])
          out.push({ rule: "texel", piece: p.id, what: m.id, detail: `natural surface ${r1(m.texels)} texels/m vs the terrain's stone ${r1(ref)} around it (${r1(r)}x, allowed ${t.texel.naturalRatio.join("-")}x)${m.projected ? ": a triplanar copy at its own scale (landmark.mts now takes the surface's uvScale: re-bake)" : ""}` });
      } else if (p.kind !== "prop") {
        const stone = ter ? ter.steep ?? ter.texels : null;
        if (p.setIn && stone && Number.isFinite(stone) && m.texels > stone * t.texel.setInMax)
          out.push({ rule: "texel", piece: p.id, what: m.id, detail: `set into the ground: ${r1(m.texels)} texels/m vs the stone it is set into ${r1(stone)} (${r1(m.texels / stone)}x, allowed ${t.texel.setInMax}x): finer than the rock round it` });
        if (Math.abs(m.texels - t.texel.builtTarget) > t.texel.builtTolerance)
          out.push({ rule: "texel", piece: p.id, what: m.id, detail: `built surface ${r1(m.texels)} texels/m, standard ${t.texel.builtTarget} +- ${t.texel.builtTolerance}` });
        else if (props && (m.texels / props < t.texel.propRatio[0] || m.texels / props > t.texel.propRatio[1]))
          out.push({ rule: "texel", piece: p.id, what: m.id, detail: `built surface ${r1(m.texels)} texels/m vs the props around it ${r1(props)} (${r1(m.texels / props)}x)` });
      }
    }
  }
  return out;
}

/** The job's OWN terrain (height-patch tops, passage walls/ceilings) against the built work set into it, both as seen: a
 *  stair lined in 40 tx/m boards inside rock drawn by a 512 px cliff tile whose marks span 4 px (~7 tx/m as seen) reads
 *  as two scales of art side by side even though the nominal texels (28) look close. */
/** The ground samples of one job passage (a recipe `passages` feature): its two walls at half height and its ceiling (the
 *  floor is under treads/decks or walked rock), each with the area it stands for. A sample over the ground's top surface
 *  (`height(x, z)`, the solid top of the column) is skipped: an OPEN carve (a cut up through the surface) has no ceiling
 *  there and its walls end at the lip, so the point is in the air and the splat there is no surface anyone sees. */
export function passageGroundSamples(ft: { start: number[]; axis?: string; direction?: number; length: number; width: number; height: number }, height: (x: number, z: number) => number): { x: number; y: number; z: number; ny: number; area: number }[] {
  const [sx, sy, sz] = ft.start as [number, number, number], dir = ft.direction ?? 1, L = ft.length, W = ft.width, H = ft.height;
  const along = (d: number, across: number): [number, number] => (ft.axis === "x" ? [sx + dir * d, sz + across] : [sx + across, sz + dir * d]);
  const out: { x: number; y: number; z: number; ny: number; area: number }[] = [];
  for (const s of [-1, 1]) { const [x, z] = along(L / 2, (s * W) / 2); out.push({ x, y: sy + H / 2, z, ny: 0, area: L * H }); }
  { const [x, z] = along(L / 2, 0); out.push({ x, y: sy + H, z, ny: -1, area: L * W }); }
  return out.filter((p) => !(height(p.x, p.z) < p.y - 0.5));
}

export function groundFaults(inp: ArtInput, t: ArtThresholds): ArtFault[] {
  const out: ArtFault[] = [];
  for (const p of inp.pieces) {
    if (p.kind !== "ground") continue;
    const ref = inp.built?.[p.id] ?? null;
    if (!ref) continue;
    for (const m of p.materials) {
      // only what the job painted: the zone's own paint on a raised pad is the land around it, not a second scale of art
      const judged = m.painted ?? m.area;
      if (judged < t.texel.minArea || m.seen == null || !(m.seen > 0)) continue;
      const r = m.seen / ref;
      if (r < t.texel.groundRatio[0] || r > t.texel.groundRatio[1])
        out.push({ rule: "texel", piece: p.id, what: m.id, detail: `the job's own ground ${r1(m.seen)} texels/m as seen (${r1(m.texels)} nominal) vs the built work beside it ${r1(ref)} as seen (${r1(r)}x, allowed ${t.texel.groundRatio.join("-")}x) over ${Math.round(judged)} m2${m.painted != null ? " of its own paint" : ""}: paint it with a palette surface that reads like the built work (paint operator, faces: true for walls), or leave the zone's own paint, or line it` });
    }
  }
  return out;
}

/** L (careening-strand 2026-10-31, coordinator ruling): the value rule's GROUND BAND is Derek's "match the surrounding
 *  rock" ruling, so it judges masonry and rock-matched work (landmarks, paint, owned meshes, structure-sized prefabs), not
 *  what is meant to stand out against the ground: a loose catalogued prop (kind `prop`), a ship, boat or wreck hull (a
 *  tarred cutter hauled out on pale sand read L* 26 vs 51), or a shelter (catalogue dressing `shelter`: a hide tent on
 *  sand read 35 vs 50). The near-black floor (`value.minL`) still judges every piece. A band-free piece is also never the
 *  "built work beside it" a ground pad's texels are matched against (art-check.mts built reference). */
export const BAND_FREE_PREFAB_RE = /^seagoing-ships\/|(^|[/-])(boat|boats|ship|hull|wreck)([/-]|$)/i;
export function groundBandFree(kind: ArtPiece["kind"], prefabId?: string | null, dressing?: { shelter?: boolean } | null): boolean {
  if (kind === "prop") return true;
  if (kind !== "mesh" || !prefabId) return false;
  return BAND_FREE_PREFAB_RE.test(prefabId) || dressing?.shelter === true;
}

export function valueFaults(inp: ArtInput, t: ArtThresholds): ArtFault[] {
  const out: ArtFault[] = [];
  for (const p of inp.pieces) {
    const g = inp.terrain[p.id]?.lstar ?? inp.groundL;
    const total = p.materials.reduce((a, m) => a + m.area, 0);
    for (const m of p.materials) {
      if (m.area < t.value.minArea || m.lstar == null) continue;
      // an ACCENT (zone palette builtStone.accent: pale arch rings, courses, coping) may stand brighter than the band by
      // up to accentExtra L* while it covers at most accentShare of the piece (HERO-BRIDGE 2026-10-22: the rings are the read)
      const share = total > 0 ? m.area / total : 1;
      const accentOk = (inp.accent ?? []).includes(m.id) && g != null && m.lstar > g && m.lstar - g <= t.value.maxDelta + t.value.accentExtra && share <= t.value.accentShare;
      if (m.lstar < t.value.minL) out.push({ rule: "value", piece: p.id, what: m.id, detail: `mean L* ${r1(m.lstar)} over ${Math.round(m.area)} m2 is near-black (floor ${t.value.minL}): lighten the tint and add an emissive lift (emissiveMap = the same texture, 0.15-0.75), never a darker mask` });
      else if (accentOk) continue;
      else if ((inp.accent ?? []).includes(m.id) && g != null && m.lstar > g && share > t.value.accentShare) out.push({ rule: "value", piece: p.id, what: m.id, detail: `accent ${m.id} at L* ${r1(m.lstar)} (ground ${r1(g)}) covers ${Math.round(share * 100)}% of ${p.id}, an accent may cover <= ${Math.round(t.value.accentShare * 100)}%: use it on rings / courses / coping only` });
      else if (!p.bandFree && g != null && Math.abs(m.lstar - g) > t.value.maxDelta) out.push({ rule: "value", piece: p.id, what: m.id, detail: `mean L* ${r1(m.lstar)} vs the zone ground ${r1(g)} (|delta| ${r1(Math.abs(m.lstar - g))} > ${t.value.maxDelta}): ${m.lstar > g ? "pull the tint down into the ground band" : "lift it (lighter tint + emissive)"}` });
    }
  }
  return out;
}

/** Source role names express construction; material filenames cannot tell whether a surface is a column or wall. */
export function architecturalRole(sourceRole: string): { part: string; purpose: MaterialPurpose } {
  const role = sourceRole.toLowerCase().replace(/~\d+$/, "");
  const part = role.replace(/^pier-(?:low|mid|top)-(\d+)$/, "pier-$1");
  const groups: [MaterialPurpose, RegExp][] = [
    ["wall", /^(face|wall|body|parapet|facade|shell)(?:[-_]|$)/],
    ["support", /^(pier|pillar|column|buttress|post|beam|rafter|joist)(?:[-_]|$)/],
    ["trim", /^(cap|coping|cornice|runner|band|trim|kerb|merlon|lintel|impost|capital)(?:[-_]|$)/],
    ["arch", /^(arch|archivolt|voussoir|keystone|ring)(?:[-_]|$)/],
    ["foundation", /^(footing|foundation|plinth|base)(?:[-_]|$)/],
    ["paving", /^(deck|floor|paving|tread|stair|landing)(?:[-_]|$)/],
    ["roof", /^(roof|slate|shingle|thatch)(?:[-_]|$)/],
    ["timber", /^(timber|wood)(?:[-_]|$)/], ["metal", /^(metal|iron|bronze)(?:[-_]|$)/],
    ["glazing", /^(glass|glazing|window)(?:[-_]|$)/],
  ];
  return { part, purpose: groups.find(([, re]) => re.test(role))?.[0] ?? "other" };
}

/** Only emitted geometry roles count: unused material slots cannot satisfy a required architectural distinction. */
export function architecturalBindings(materials: Record<string, string>, usedRoles: string[]): ArchitecturalMaterialBinding[] {
  return [...new Set(usedRoles)].flatMap((sourceRole) => {
    const material = materials[sourceRole];
    return typeof material === "string" ? [{ sourceRole, ...architecturalRole(sourceRole), material }] : [];
  });
}
const pictureKey = (m: ArtMaterial) => m.mapHash ? `#${m.mapHash}` : m.map ? `map:${m.map}` : `material:${m.id}`;

export function architecturalMaterialFaults(inp: ArtInput, t: ArtThresholds): ArtFault[] {
  const out: ArtFault[] = [];
  for (const p of inp.pieces) {
    if (!p.architecture || p.kind === "prop" || p.kind === "ground" || p.kind === "paint") continue;
    if (p.architectureBakeMatchesSource === false) out.push({ rule: "variety", piece: p.id, what: "stale architectural bake", detail: "the delivered prefab identity does not match the compiled architectural source and materials; bake and install the current source before reviewing its role assignments" });
    const mats = new Map(p.materials.map((m) => [m.id, m]));
    const parts = new Map<string, { bindings: ArchitecturalMaterialBinding[]; pictures: Set<string> }>();
    const purposes = new Map<MaterialPurpose, Map<string, Set<string>>>();
    for (const binding of p.architecture) {
      const m = mats.get(binding.material);
      // Buried/internal roles may be trimmed from the bake or its visible measurement. They must not create
      // contrast requirements. Source-vs-bake identity is checked independently, so missing visible roles cannot
      // hide a stale material assignment.
      if (!m) continue;
      if (m.natural || m.area < t.texel.minArea) continue;
      const key = pictureKey(m), part = parts.get(binding.part) ?? { bindings: [], pictures: new Set<string>() };
      part.bindings.push(binding); part.pictures.add(key); parts.set(binding.part, part);
      const purpose = purposes.get(binding.purpose) ?? new Map<string, Set<string>>();
      const names = purpose.get(key) ?? new Set<string>(); names.add(binding.part); purpose.set(key, names); purposes.set(binding.purpose, purpose);
    }
    if (!t.variety.allowPatterns) for (const [part, value] of parts) if (value.pictures.size > 1)
      out.push({ rule: "variety", piece: p.id, what: "material cycling", detail: `${part} uses ${value.pictures.size} pictures across one continuous part (${value.bindings.map((b) => `${b.sourceRole}=${b.material}`).join(", ")}); keep the part coherent and put variation on real supports, trim or paving` });
    for (const [a, b] of t.variety.contrastPairs) {
      const aa = purposes.get(a), bb = purposes.get(b); if (!aa || !bb || a === b) continue;
      const shared = [...aa.keys()].filter((key) => bb.has(key));
      if (shared.length) out.push({ rule: "variety", piece: p.id, what: "architectural contrast", detail: `${a} [${shared.flatMap((key) => [...aa.get(key)!]).join(", ")}] and ${b} [${shared.flatMap((key) => [...bb.get(key)!]).join(", ")}] share the same source picture; assign an appropriate distinct finish to these existing architectural parts. Renamed copies or tints of one image do not establish a different stone texture` });
    }
  }
  return out;
}

export function varietyFaults(inp: ArtInput, t: ArtThresholds, diagnosticsOnly = false): ArtFault[] {
  const numeric = diagnosticsOnly || t.variety.mode === "counts";
  const out: ArtFault[] = numeric ? [] : architecturalMaterialFaults(inp, t);
  // counted per underlying PICTURE (texture hash, else path, else the material id): material ids that only re-tint one
  // picture are one tile to the eye (four ids over one Stone.png were 3,800 m2 of one stone the per-id count never saw)
  const built = new Map<string, ArtMaterial & { pieces: Set<string>; ids: Set<string> }>();
  for (const p of inp.pieces) for (const m of p.materials) {
    if (m.natural || p.kind === "prop") continue;
    const key = pictureKey(m), fresh = !built.has(key);
    const e = built.get(key) ?? { ...m, area: 0, uvRepeats: undefined, pieces: new Set<string>(), ids: new Set<string>() };
    // UV-measured repeats add up only while every piece using the material has them (else the tiled estimate judges)
    e.uvRepeats = m.uvRepeats != null && (fresh || e.uvRepeats != null) ? (e.uvRepeats ?? 0) + m.uvRepeats : undefined;
    e.area += m.area; e.pieces.add(p.id); e.ids.add(m.id); built.set(key, e);
  }
  const need = inp.tier ? t.variety.minDistinct[inp.tier] : 0;
  const distinct = [...built.values()].filter((m) => m.area >= t.texel.minArea).length;
  if (numeric && built.size && distinct < need) out.push({ rule: "variety", piece: "(place)", what: "distinct materials", detail: `${distinct} distinct built picture(s) [${[...built.values()].map((m) => [...m.ids].join("/")).join(", ")}] for a ${inp.tier} place (legacy target ${need}); review architectural roles rather than adding arbitrary textures` });
  for (const m of built.values()) {
    // an atlas laid by the mesh's own UVs (a catalogued prop) repeats as often as its UVs say, however big it is
    const atlas = m.uvRepeats != null;
    const repeats = atlas ? m.uvRepeats! : m.px ? (m.area * m.texels * m.texels) / (m.px[0] * m.px[1]) : null;
    if (numeric && ((!atlas && m.area > t.variety.maxTileArea) || (repeats != null && m.area >= t.variety.repeatMinArea && repeats > t.variety.maxRepeats)))
      out.push({ rule: "variety", piece: [...m.pieces].join("+"), what: [...m.ids].join("+"), detail: `one ${m.ids.size > 1 ? `picture (${m.map ?? "?"}) under ${m.ids.size} material ids` : "tile"} over ${Math.round(m.area)} m2${repeats != null ? ` (${Math.round(repeats)} repeats)` : ""}: legacy limit ${t.variety.maxTileArea} m2 / ${t.variety.maxRepeats} repeats; inspect the architectural assignments, never stripe one continuous wall to meet the numbers` });
    if (!diagnosticsOnly && m.colours != null && m.area >= t.variety.colourMinArea && m.colours < t.variety.minColours && !t.variety.houseTiles.some((p) => (m.map ?? "").startsWith(p)))
      out.push({ rule: "variety", piece: [...m.pieces].join("+"), what: m.id, detail: `texture has ${m.colours} colours (min ${t.variety.minColours}) over ${Math.round(m.area)} m2: a recoloured mask reads as a flat field` });
  }
  return out;
}

/** Numeric repetition is retained as review information under the architectural policy. */
export function varietyDiagnostics(inp: ArtInput, t: ArtThresholds): ArtFault[] {
  return t.variety.mode === "architecture" ? varietyFaults(inp, t, true) : [];
}

export function portalFaults(inp: ArtInput, t: ArtThresholds): ArtFault[] {
  const out: ArtFault[] = [];
  const near = (at: [number, number], reach: number) => inp.portals.filter((p) => dist(p.at, at) <= reach);
  const judge = (piece: string, name: string, at: [number, number], reach: number, cut: boolean) => {
    const door = inp.doors.find((d) => d.name === name);
    if (door?.sealed) {
      if (cut) out.push({ rule: "portal", piece, what: name, detail: "declared sealed but an opening is cut there: a sealed door shows closed leaves (barred, chained, rubble), no pocket" });
      return;
    }
    const ps = near(at, reach);
    if (!ps.length) { out.push({ rule: "portal", piece, what: name, detail: `no portal within ${reach} m and not declared sealed: install the anchor + portal-veil + portal-cover --fit, or add handoff.json doors [{ name: "${name}", sealed: true }] and shut it` }); return; }
    const good = ps.find((p) => p.veil && p.scene);
    if (!good) out.push({ rule: "portal", piece, what: name, detail: `portal ${ps.map((p) => p.id).join(", ")} has ${ps.every((p) => !p.scene) ? "no travel target (params.scene)" : "no veil (tools/portal-veil.mts)"}` });
  };
  for (const o of inp.openings) if (o.depth >= t.portal.minDepth) judge(o.landmark, `${o.landmark}/${o.name}`, o.at, Math.max(t.portal.reach, o.width), true);
  if (inp.dungeon) {
    const covered = inp.openings.some((o) => o.depth >= t.portal.minDepth && !inp.doors.find((d) => d.name === `${o.landmark}/${o.name}`)?.sealed && near(o.at, Math.max(t.portal.reach, o.width)).some((p) => p.veil && p.scene));
    if (!covered) {
      const d = inp.doors.find((x) => x.name === "dungeon");
      if (!d?.sealed && !inp.portals.some((p) => p.veil && p.scene && dist(p.at, inp.dungeon!.at) <= Math.max(t.portal.reach * 6, 90)))
        out.push({ rule: "portal", piece: "(place)", what: "dungeon", detail: `the zone brief puts a dungeon (${inp.dungeon.name}) behind this place but no portal with a veil and travel target stands at it: install its door portal, or declare handoff.json doors [{ name: "dungeon", sealed: true, why }] and show the door shut` });
    }
  }
  return out;
}

/** Evenly spaced along one straight line (same parent frame): a rhythm, not scattered copies. */
export function isRhythm(list: FormUnit[], cv: number): boolean {
  if (list.some((u) => !u.at || u.parent !== list[0]!.parent)) return false;
  const P = list.map((u) => u.at!);
  let best: [number, number] = [0, 0];
  for (const a of P) for (const b of P) { const d = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]); if (d > Math.hypot(...[0, 1, 2].map((k) => P[best[1]]![k]! - P[best[0]]![k]!))) best = [P.indexOf(a), P.indexOf(b)]; }
  const A = P[best[0]]!, B = P[best[1]]!, L = Math.hypot(B[0] - A[0], B[1] - A[1], B[2] - A[2]);
  if (L < 1e-6) return false;
  const dir = [0, 1, 2].map((k) => (B[k]! - A[k]!) / L);
  const ts: number[] = [];
  for (const p of P) {
    const v = [0, 1, 2].map((k) => p[k]! - A[k]!), t = v[0]! * dir[0]! + v[1]! * dir[1]! + v[2]! * dir[2]!;
    if (Math.hypot(...v.map((x, k) => x - t * dir[k]!)) > 1) return false;
    ts.push(t);
  }
  ts.sort((a, b) => a - b);
  const gaps = ts.slice(1).map((v, i) => v - ts[i]!), m = gaps.reduce((a, g) => a + g, 0) / gaps.length;
  const sd = Math.sqrt(gaps.reduce((a, g) => a + (g - m) ** 2, 0) / gaps.length);
  return m > 0 && sd / m < cv;
}

/** Bounds overlap/touch within `gap`. */
const touches = (a: FormNode, b: FormNode, gap: number) => [0, 1, 2].every((k) => a.min[k]! <= b.max[k]! + gap && b.min[k]! <= a.max[k]! + gap);

export function formFaults(inp: ArtInput, t: ArtThresholds): ArtFault[] {
  const out: ArtFault[] = [];
  for (const [id, nodes] of Object.entries(inp.forms)) {
    const hero = nodes.filter((n) => !n.natural && n.op !== "sub" && Math.max(...n.dims) >= t.form.heroSize);
    // identical copies, at the outermost repeated level (8 spires, not 8 x every vertebra of a spire)
    const units = inp.units?.[id] ?? [];
    // clusters: same kind, every sorted bounds side within nearCopy of the cluster's first member
    const clusters: FormUnit[][] = [];
    for (const u of units) {
      if (u.size < t.form.copySize) continue;
      const c = clusters.find((l) => l[0]!.kind === u.kind && l[0]!.dims!.length === u.dims!.length && l[0]!.dims!.every((d, k) => Math.abs(d - u.dims![k]!) <= t.form.nearCopy * Math.max(d, u.dims![k]!, 1e-6)));
      if (c) c.push(u); else clusters.push([u]);
    }
    const flagged = clusters.filter((l) => l.length >= t.form.maxIdentical);
    const flaggedSigs = new Set(flagged.flatMap((l) => l.map((u) => u.sig)));
    const insideFlagged = (u: FormUnit) => { for (let p = u.parent; p; p = units.find((x) => x.sig === p)?.parent ?? null) if (flaggedSigs.has(p)) return true; return false; };
    // one fault per landmark, naming its repeated sets (largest first)
    const sets = flagged.filter((list) => !list.every(insideFlagged) && !isRhythm(list, t.form.rhythmCv)).sort((x, y) => y.length - x.length);
    if (sets.length) out.push({ rule: "form", piece: id, what: `${sets.length} repeated set(s)`, detail: sets.slice(0, 4).map((list) => {
      const shape = list[0]!.kind!.split("|")[0]!, exact = list.every((u) => u.sig === list[0]!.sig);
      return `${list.length} ${exact ? "identical" : "near-identical"} ${shape === "group" ? "groups" : shape === "box" ? "boxes" : `${shape}s`} ${Math.round(list[0]!.size * 10) / 10} m (${list.slice(0, 3).map((u) => u.name).join(", ")}${list.length > 3 ? ", ..." : ""})`;
    }).join("; ") + `${sets.length > 4 ? "; ..." : ""} — read as copies (max ${t.form.maxIdentical - 1} per set, sides within ${Math.round(t.form.nearCopy * 100)}% count): vary height / lean / proportion / detail per copy` });
    // butted raw boxes: connected chains
    const boxes = hero.filter((n) => n.shape === "box" && n.bevel <= 0);
    const seen = new Set<number>();
    for (let i = 0; i < boxes.length; i++) {
      if (seen.has(i)) continue;
      const comp = [i]; seen.add(i);
      for (let q = 0; q < comp.length; q++) for (let j = 0; j < boxes.length; j++) if (!seen.has(j) && touches(boxes[comp[q]!]!, boxes[j]!, t.form.buttGap)) { seen.add(j); comp.push(j); }
      if (comp.length >= t.form.maxButted)
        out.push({ rule: "form", piece: id, what: `${comp.length} butted boxes`, detail: `a chain of ${comp.length} unbevelled boxes (${comp.slice(0, 4).map((k) => boxes[k]!.name).join(", ")}, ...) reads as stacked cubes: one swept wall / ribbon, bevelled blocks with course breaks, or kit parts (max ${t.form.maxButted - 1})` });
    }
    // raw box share
    const builtArea = nodes.filter((n) => !n.natural && n.op !== "sub").reduce((a, n) => a + n.area, 0);
    const raw = boxes.reduce((a, n) => a + n.area, 0);
    if (builtArea > 0 && raw / builtArea > t.form.maxRawBoxShare)
      out.push({ rule: "form", piece: id, what: "unbevelled boxes", detail: `${Math.round((100 * raw) / builtArea)}% of its built surface is raw unbevelled boxes (max ${Math.round(t.form.maxRawBoxShare * 100)}%): give blocks a \`bevel\` (0.1-0.25 m; giant work more) or use kit parts` });
  }
  return out;
}

export function scaleFaults(inp: ArtInput, t: ArtThresholds): ArtFault[] {
  const out: ArtFault[] = [];
  for (const p of inp.pieces) for (const m of p.materials) {
    if (m.natural || m.course == null || m.area < t.variety.colourMinArea || !new RegExp(t.scale.stoneMaterials, "i").test(m.id)) continue;
    if (inp.culture === "giant" && m.course < t.scale.giantMinCourse)
      out.push({ rule: "scale", piece: p.id, what: m.id, detail: `${Math.round(m.course * 100)} cm stone courses on giant work (min ${t.scale.giantMinCourse} m): giant-scale blocks need a tile drawn at giant scale (built-textures: 1.2-2 m blocks)` });
    else if (inp.culture === "human" && m.course > t.scale.humanMaxCourse)
      out.push({ rule: "scale", piece: p.id, what: m.id, detail: `${r1(m.course)} m stone courses on human work (max ${t.scale.humanMaxCourse} m)` });
  }
  return out;
}

/**
 * Ids of the scene entities a POI owns: the job's own scene-op entities (`jobIds`), every entity tagged `poi:<poiId>`,
 * and every descendant of either (a child is local to an owned root even when it carries no tag).
 */
export function ownedEntityIds(ents: Record<string, { parent?: string | null; tags?: unknown } | undefined>, poiId: string, jobIds: Iterable<string> = []): Set<string> {
  const tag = `poi:${poiId}`, seed = new Set(jobIds);
  for (const [id, e] of Object.entries(ents)) if (Array.isArray(e?.tags) && e.tags.includes(tag)) seed.add(id);
  const out = new Set<string>(), memo = new Map<string, boolean>();
  const owned = (id: string, depth = 0): boolean => {
    const hit = memo.get(id); if (hit != null) return hit;
    const p = ents[id]?.parent;
    const v = seed.has(id) || (!!p && depth < 64 && !!ents[p] && owned(p, depth + 1));
    memo.set(id, v); return v;
  };
  for (const id of Object.keys(ents)) if (owned(id)) out.add(id);
  for (const id of seed) if (ents[id]) out.add(id);
  return out;
}

/** Nothing measured is a fault, never an ok: no piece carries a measured surface (no landmark bake, paint, owned mesh or prefab). */
export function measureFaults(inp: ArtInput): ArtFault[] {
  const missing = new Map<string, string[]>();
  for (const p of inp.pieces) for (const m of p.materials) if (m.missing) missing.set(m.id, [...(missing.get(m.id) ?? []), p.id]);
  const out: ArtFault[] = [...missing].map(([id, ps]) => ({ rule: "measure" as const, piece: ps.slice(0, 3).join("+") + (ps.length > 3 ? "+..." : ""), what: id, detail: `material asset ${id} is neither in the job's materials/ nor in the project closure (assets/materials/${id}.json): ${ps.length} mesh(es) draw the default material — deliver it in the job's materials/ (its installer copies it into the world project)` }));
  const area = inp.pieces.filter((p) => p.kind !== "ground").reduce((a, p) => a + p.materials.reduce((b, m) => b + (Number.isFinite(m.area) ? m.area : 0), 0), 0);
  if (area > 0) return out;
  return [...out, { rule: "measure", piece: "(place)", what: "nothing measured", detail: `${inp.pieces.length} piece(s), 0 m2 of measured surface: no landmark/paint world op baked into the recipe and no owned scene entity (job scene ops, or world-scene entities tagged poi:<id>) with a mesh or prefab whose surfaces resolve — install the job (worldgen op --apply / its installer), tag its roots poi:<id> (dress retag for dressing), or fix the missing prefab/model/material` }];
}

export function artFaults(inp: ArtInput, thresholds: Partial<ArtThresholds> = {}): ArtFault[] {
  const t = artThresholdsSchema.parse(thresholds);
  return [...measureFaults(inp), ...texelFaults(inp, t), ...groundFaults(inp, t), ...valueFaults(inp, t), ...varietyFaults(inp, t), ...portalFaults(inp, t), ...formFaults(inp, t), ...scaleFaults(inp, t)];
}

// ------------------------------------------------------------------------------------------------ measurements ----
const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
/** CIE L* of a relative luminance Y (0..1). */
export const lstarOf = (Y: number) => (Y > 216 / 24389 ? 116 * Math.cbrt(Y) - 16 : (24389 / 27) * Y);
export const hexLinear = (hex: string | undefined): [number, number, number] => {
  const h = /^#?([0-9a-f]{6})$/i.exec(hex ?? "")?.[1] ?? "ffffff";
  return [0, 2, 4].map((i) => lin(parseInt(h.slice(i, i + 2), 16))) as [number, number, number];
};
export interface TextureStats { width: number; height: number; mean: [number, number, number]; colours: number; periodPx: number | null; periodicity: number; /** sRGB luma standard deviation of the opaque pixels (0-255): the picture's contrast */ lumaSd?: number }
/** Mean linear colour of the opaque pixels, distinct 5-bit colours, and the strongest row period (coursed masonry). */
export function textureStats(img: { width: number; height: number; data: Uint8Array }): TextureStats {
  const { width: w, height: h, data } = img;
  const mean = [0, 0, 0]; let n = 0;
  const q = new Set<number>(), rows = new Float64Array(h), rowN = new Float64Array(h);
  let ls = 0, ls2 = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (data[i + 3]! < 128) continue;
    { const y8 = 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!; ls += y8; ls2 += y8 * y8; }
    const l = [lin(data[i]!), lin(data[i + 1]!), lin(data[i + 2]!)];
    mean[0] += l[0]!; mean[1] += l[1]!; mean[2] += l[2]!; n++;
    q.add((data[i]! >> 3) * 1024 + (data[i + 1]! >> 3) * 32 + (data[i + 2]! >> 3));
    rows[y] += 0.2126 * l[0]! + 0.7152 * l[1]! + 0.0722 * l[2]!; rowN[y]++;
  }
  const m = n ? (mean.map((v) => v / n) as [number, number, number]) : ([0, 0, 0] as [number, number, number]);
  // row-mean autocorrelation (cyclic: a tiling texture), lags 3 .. h/2
  const r = Array.from(rows, (v, y) => (rowN[y] ? v / rowN[y]! : 0)), mu = r.reduce((a, v) => a + v, 0) / (h || 1);
  const d = r.map((v) => v - mu), var0 = d.reduce((a, v) => a + v * v, 0);
  // the course is a PEAK of the autocorrelation once it has crossed zero: a texture of big smooth blocks correlates most at
  // the smallest lag simply because neighbouring rows look alike (it read as 7 cm courses on giant blocks)
  let best = 0, period: number | null = null;
  if (var0 > 1e-9) {
    const ac = (lag: number) => { let s = 0; for (let y = 0; y < h; y++) s += d[y]! * d[(y + lag) % h]!; return s / var0; };
    const c = Array.from({ length: Math.floor(h / 2) + 2 }, (_, lag) => (lag ? ac(lag) : 1));
    let lag = 1; while (lag + 1 < c.length && c[lag]! > 0) lag++; // past the first zero crossing (a ripple on the decay is no course)
    for (lag = Math.max(lag, 3); lag <= h / 2; lag++) if (c[lag]! > best && c[lag]! >= c[lag - 1]! && c[lag]! >= (c[lag + 1] ?? -Infinity)) { best = c[lag]!; period = lag; }
  }
  return { width: w, height: h, mean: m, colours: q.size, periodPx: period, periodicity: best, lumaSd: n ? Math.sqrt(Math.max(0, ls2 / n - (ls / n) ** 2)) : 0 };
}
/** How many texture pixels one visible mark spans: the box-downsample factor k (1..16, interpolated in log2 k) at which
 *  half of the luminance variance is gone. Pixel noise ~1.5-2; a 512 px tile painted with 4 px marks ~4 (it reads like
 *  128 px). Effective (as seen) texels/m = texels/m / detailScale. */
function pictureDetailLoss(img: { width: number; height: number; data: Uint8Array }): { variance: number; loss: number[] } {
  const { width: w, height: h, data } = img, ch = data.length / (w * h);
  const L = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = 0.2126 * data[i * ch]! + 0.7152 * data[i * ch + 1]! + 0.0722 * data[i * ch + 2]!;
  let mu = 0; for (const v of L) mu += v; mu /= L.length || 1;
  let v0 = 0; for (const v of L) v0 += (v - mu) ** 2; v0 /= L.length || 1;
  const loss: number[] = [];
  for (const k of [2, 4, 8, 16]) {
    let e = 0, n = 0;
    for (let by = 0; by + k <= h; by += k) for (let bx = 0; bx + k <= w; bx += k) {
      let s = 0; for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) s += L[(by + y) * w + bx + x]!;
      s /= k * k; for (let y = 0; y < k; y++) for (let x = 0; x < k; x++) { e += (L[(by + y) * w + bx + x]! - s) ** 2; n++; }
    }
    loss.push(n ? e / n : v0);
  }
  return { variance: v0, loss };
}
function detailFromLoss(variance: number, loss: readonly number[]): number {
  if (variance < 1e-6) return 1;
  let prevK = 1, prevR = 0;
  for (let i = 0; i < loss.length; i++) {
    const k = 2 ** (i + 1), r = loss[i]! / variance;
    if (r >= .5) return 2 ** (Math.log2(prevK) + ((.5 - prevR) / Math.max(1e-9, r - prevR)) * (Math.log2(k) - Math.log2(prevK)));
    prevK = k; prevR = r;
  }
  return 16;
}
export function detailScale(img: { width: number; height: number; data: Uint8Array }): number {
  const stats = pictureDetailLoss(img);
  return detailFromLoss(stats.variance, stats.loss);
}

/** Detail of the texels UV faces actually use. Measure variance separately per face so
 *  differences between atlas roles (dark rope beside pale stone) are not mistaken for
 *  enormous painted marks. World-area weighting preserves the visible material mix. */
export function uvFootprintDetailScale(tris: { a: number[]; b: number[]; c: number[]; uv?: [number, number][] }[], img: { width: number; height: number; data: Uint8Array }, flipY = true): number | null {
  const { width: w, height: h, data } = img, ch = data.length / (w * h);
  const loss = [0, 0, 0, 0], factors = [2, 4, 8, 16]; let variance = 0, measured = 0;
  const cache = new Map<string, { variance: number; loss: number[] } | null>();
  for (const t of tris) {
    if (!t.uv || t.uv.length < 3) continue;
    const u = t.b.map((v, i) => v - t.a[i]!), v = t.c.map((v, i) => v - t.a[i]!);
    const area = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
    if (!(area > 1e-9)) continue;
    const key = t.uv.flat().join(",");
    if (!cache.has(key)) {
      const p = t.uv.map(([x, y]) => [x * w, (flipY ? 1 - y : y) * h]);
      const x0 = Math.floor(Math.min(...p.map(q => q[0]!))), x1 = Math.ceil(Math.max(...p.map(q => q[0]!)));
      const y0 = Math.floor(Math.min(...p.map(q => q[1]!))), y1 = Math.ceil(Math.max(...p.map(q => q[1]!)));
      const bw = x1 - x0, bh = y1 - y0;
      const a = p[0]!, b = p[1]!, c = p[2]!;
      const den = (b[1]! - c[1]!) * (a[0]! - c[0]!) + (c[0]! - b[0]!) * (a[1]! - c[1]!);
      if (!Number.isFinite(den) || Math.abs(den) < 1e-9 || bw <= 0 || bh <= 0) { cache.set(key, null); continue; }
      // A face repeating the entire picture many times samples the whole picture.
      if (bw * bh > 4 * w * h) {
        cache.set(key, pictureDetailLoss(img));
      } else {
        const pixels = new Float64Array(bw * bh); pixels.fill(NaN);
        let sum = 0, square = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
          const s = ((b[1]! - c[1]!) * (x + .5 - c[0]!) + (c[0]! - b[0]!) * (y + .5 - c[1]!)) / den;
          const r = ((c[1]! - a[1]!) * (x + .5 - c[0]!) + (a[0]! - c[0]!) * (y + .5 - c[1]!)) / den;
          if (s < -1e-9 || r < -1e-9 || s + r > 1 + 1e-9) continue;
          const ix = ((x % w) + w) % w, iy = ((y % h) + h) % h, i = (iy * w + ix) * ch;
          if (ch === 4 && data[i + 3]! < 128) continue;
          const l = .2126 * data[i]! + .7152 * data[i + 1]! + .0722 * data[i + 2]!;
          pixels[(y - y0) * bw + x - x0] = l; sum += l; square += l * l; n++;
        }
        if (!n) { cache.set(key, null); continue; }
        const losses = factors.map(k => {
          let e = 0;
          for (let by = Math.floor(y0 / k) * k; by < y1; by += k) for (let bx = Math.floor(x0 / k) * k; bx < x1; bx += k) {
            let s = 0, ss = 0, count = 0;
            for (let y = Math.max(by, y0); y < Math.min(by + k, y1); y++) for (let x = Math.max(bx, x0); x < Math.min(bx + k, x1); x++) {
              const l = pixels[(y - y0) * bw + x - x0]!; if (!Number.isFinite(l)) continue;
              s += l; ss += l * l; count++;
            }
            if (count) e += Math.max(0, ss - s * s / count);
          }
          return e / n;
        });
        cache.set(key, { variance: Math.max(0, square / n - (sum / n) ** 2), loss: losses });
      }
    }
    const stats = cache.get(key); if (!stats) continue;
    measured += area; variance += area * stats.variance;
    for (let i = 0; i < loss.length; i++) loss[i]! += area * stats.loss[i]!;
  }
  if (!measured) return null;
  return detailFromLoss(variance, loss);
}

/** Compare a job's paint with the neighbouring world, excluding only its own
 *  paint features. Reusing a palette surface must not erase that surface from
 *  the reference everywhere (including pre-existing dirt beside grass). */
export function artGroundReference<T extends { features: { groundPaints?: { id: string }[] } }>(recipe: T, ops: readonly { op?: string; id?: string; edit?: string; kind?: string; feature?: { id?: string } }[]): T {
  const owned = new Set<string>();
  for (const o of ops) {
    if (o.op === "paint" && o.id) owned.add(`op:${o.id}:paint`);
    if (o.edit === "add-feature" && o.kind === "groundPaints" && o.feature?.id) owned.add(o.feature.id);
  }
  const old = recipe.features.groundPaints ?? [], kept = old.filter(p => !owned.has(p.id));
  return kept.length === old.length ? recipe : { ...recipe, features: { ...recipe.features, groundPaints: kept } };
}
/** Mean L* of a material: texture mean x colour, plus emissive x intensity (x emissiveMap mean). */
export function materialLstar(md: { color?: string; emissive?: string; emissiveIntensity?: number }, tex: TextureStats | null, emissiveTex: TextureStats | null): number {
  const c = hexLinear(md.color), t = tex?.mean ?? [1, 1, 1];
  const e = md.emissive ? hexLinear(md.emissive) : [0, 0, 0], ei = md.emissiveIntensity ?? (md.emissive ? 1 : 0), et = emissiveTex?.mean ?? [1, 1, 1];
  const rgb = [0, 1, 2].map((k) => Math.min(1, t[k]! * c[k]! + e[k]! * ei * et[k]!));
  return lstarOf(0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!);
}

/** Landmark triplanar scale for a world surface: its own uvScale (metres per repeat, what the terrain draws it at). */
export function landmarkTriplanarScale(surf: { uvScale?: number } | undefined, override?: string): number {
  if (override != null && Number(override) > 0) return Number(override);
  return surf?.uvScale && surf.uvScale > 0 ? surf.uvScale : 4.5;
}

/**
 * Which project + world a job is measured in: the job's own (projects/<p>/authoring/zonegen/<world>/...) unless a
 * preview is named (`--project <lab> --world <labWorld>`): a job built in a lab copy had its bakes and scene only
 * there, and the real world reported "landmark not in the recipe, bake not measured".
 */
export function artTarget(jobDir: string, over: { project?: string; world?: string } = {}): { project: string; world: string } {
  const parts = jobDir.split(/[\\/]/);
  const pi = parts.lastIndexOf("projects"), zi = parts.indexOf("zonegen");
  // a job COPY outside the project tree (place-build --job, a tools proof) is measured in the lab it names
  if ((pi < 0 || zi < 0) && over.project && over.world) return { project: over.project, world: over.world };
  if (pi < 0 || zi < 0) throw new Error(`${jobDir} is not a zonegen POI job (projects/<p>/authoring/zonegen/<world>/zones/<zone>/pois/<job>)`);
  return { project: over.project ?? parts[pi + 1]!, world: over.world ?? parts[zi + 1]! };
}

/**
 * The world operators judged as built pieces: `landmark` ops AND every operator that bakes to a recipe landmark
 * (`op:<id>:landmark` — `wall` in all its variants: retaining, ramp, quay…), so a wall's materials are measured like a
 * landmark's. `at` is the op's own anchor, else its baked piece's position, else the centroid of its points.
 */
export interface BuiltOpPiece { op: Record<string, any>; at: [number, number]; piece: { id: string; prefab: string; position: number[]; radius: number } | null }
export function builtOpPieces(ops: Record<string, any>[], recipeLandmarks: { id: string; prefab: string; position: number[]; radius: number }[]): BuiltOpPiece[] {
  const out: BuiltOpPiece[] = [];
  for (const o of ops) {
    // an operator only (clearings share ids with their operators but have no `op`); paints are judged as ground
    if (typeof o.op !== "string" || o.op === "paint") continue;
    const piece = recipeLandmarks.find((l) => l.id === `op:${o.id}:landmark`) ?? null;
    if (o.op !== "landmark" && o.op !== "wall" && !piece) continue;
    const pts = Array.isArray(o.points) ? (o.points as number[][]) : [];
    const at: [number, number] = Array.isArray(o.at) ? [o.at[0], o.at[1]]
      : piece ? [piece.position[0]!, piece.position[2]!]
      : pts.length ? [pts.reduce((s, p) => s + p[0]!, 0) / pts.length, pts.reduce((s, p) => s + p[1]!, 0) / pts.length] : [0, 0];
    out.push({ op: o, at, piece });
  }
  return out;
}

/** World area (m²) of every material on `tris` that `measured` (texelDensity's byMaterial) left out: a part with no
 *  UVs and no world projection (a stamp landmark's non-rock role whose material is not triplanar) or a flat colour.
 *  Every part of a piece is judged: callers describe these too, so no role of a bake goes unmeasured. */
export function unmeasuredAreas(tris: { a: number[]; b: number[]; c: number[]; material?: string; tex?: { key: string } }[], measured: Record<string, unknown>): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of tris) {
    const id = t.material ?? t.tex?.key;
    if (!id || measured[id]) continue;
    const u = [0, 1, 2].map((k) => t.b[k]! - t.a[k]!), v = [0, 1, 2].map((k) => t.c[k]! - t.a[k]!);
    const A = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
    if (A > 1e-9) out.set(id, (out.get(id) ?? 0) + A);
  }
  return out;
}

/** UV stretch of each material: the share of its UV-laid area whose triangles' world-to-UV map is anisotropic beyond
 *  `limit` (the ratio of the map's singular values: a sheared or squashed face), and the worst ratio. Materials laid by
 *  world projection (no UVs) are left out. `px(material)` gives the texture's [width, height] in pixels: the ratio is taken
 *  in TEXELS, so a correctly laid non-square picture (a 512 x 128 crown panel on a 13 x 3.2 m face, a 3:1 cornice band)
 *  is not read as squashed (rustgut-entrance 2026-11-09: every non-square role of a built bake failed at its aspect). */
export function uvStretchByMaterial(tris: { a: number[]; b: number[]; c: number[]; uv?: [number, number][]; material?: string; tex?: { key: string; repeat?: [number, number] } }[], limit = 1.3, px?: (material: string) => [number, number] | undefined): Record<string, { share: number; worst: number }> {
  const acc = new Map<string, { area: number; bad: number; worst: number }>();
  const sub = (p: number[], q: number[]) => [p[0]! - q[0]!, p[1]! - q[1]!, p[2]! - q[2]!], dot = (p: number[], q: number[]) => p[0]! * q[0]! + p[1]! * q[1]! + p[2]! * q[2]!;
  for (const t of tris) {
    if (!t.uv || t.uv.length < 3) continue;
    const e1 = sub(t.b, t.a), e2 = sub(t.c, t.a), n = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!], A = Math.hypot(...n) / 2, l1 = Math.hypot(...e1);
    if (!(A > 1e-6) || !(l1 > 1e-9)) continue;
    const ax = e1.map((v) => v / l1), ay0 = [n[1]! * ax[2]! - n[2]! * ax[1]!, n[2]! * ax[0]! - n[0]! * ax[2]!, n[0]! * ax[1]! - n[1]! * ax[0]!], ly = Math.hypot(...ay0), ay = ay0.map((v) => v / ly);
    const [rx, ry] = t.tex?.repeat ?? [1, 1], [pw, ph] = px?.(t.material ?? t.tex?.key ?? "") ?? [1, 1], uv = t.uv.map(([u, v]) => [u * rx * pw, v * ry * ph]);
    const P = [[l1, dot(e2, ax)], [0, dot(e2, ay)]], Q = [[uv[1]![0]! - uv[0]![0]!, uv[2]![0]! - uv[0]![0]!], [uv[1]![1]! - uv[0]![1]!, uv[2]![1]! - uv[0]![1]!]];
    const det = P[0]![0]! * P[1]![1]! - P[0]![1]! * P[1]![0]!;
    if (Math.abs(det) < 1e-12) continue;
    const i00 = P[1]![1]! / det, i01 = -P[0]![1]! / det, i10 = -P[1]![0]! / det, i11 = P[0]![0]! / det;
    const j00 = Q[0]![0]! * i00 + Q[0]![1]! * i10, j01 = Q[0]![0]! * i01 + Q[0]![1]! * i11, j10 = Q[1]![0]! * i00 + Q[1]![1]! * i10, j11 = Q[1]![0]! * i01 + Q[1]![1]! * i11;
    const a = j00 * j00 + j10 * j10, b = j00 * j01 + j10 * j11, c = j01 * j01 + j11 * j11, h = Math.sqrt(Math.max(0, ((a - c) / 2) ** 2 + b * b));
    const s1 = (a + c) / 2 + h, s2 = (a + c) / 2 - h;
    if (!(s1 > 1e-18)) continue; // no UV extent: one texel, judged by noUv / texel density
    const k = s2 > 1e-18 ? Math.sqrt(s1 / s2) : Infinity;
    const id = t.material ?? t.tex?.key ?? "(none)", e = acc.get(id) ?? { area: 0, bad: 0, worst: 1 };
    e.area += A;
    if (k > limit) e.bad += A;
    e.worst = Math.max(e.worst, Math.min(k, 99));
    acc.set(id, e);
  }
  return Object.fromEntries([...acc].map(([id, e]) => [id, { share: e.area ? e.bad / e.area : 0, worst: Math.round(e.worst * 100) / 100 }]));
}

/** Repeats of each material's texture from its triangles' UVs: the UV-space area they cover (a non-repeating atlas
 *  covers <= 1, counted 1). Materials with any triangle lacking UVs are left out (the tiled estimate judges them). */
export function uvRepeatsByMaterial(tris: { uv?: [number, number][]; material?: string; tex?: { key: string; repeat?: [number, number] } }[]): Record<string, number> {
  const acc = new Map<string, number>(), noUv = new Set<string>();
  for (const t of tris) {
    const id = t.material ?? t.tex?.key ?? "(none)"; // the key texelDensity's byMaterial uses
    if (!t.uv || t.uv.length < 3) { noUv.add(id); continue; }
    const [p, q, r] = t.uv as [[number, number], [number, number], [number, number]];
    const rep = t.tex?.repeat ?? [1, 1]; // a material's own repeat multiplies its UVs
    acc.set(id, (acc.get(id) ?? 0) + (Math.abs((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])) / 2) * rep[0] * rep[1]);
  }
  const out: Record<string, number> = {};
  for (const [id, a] of acc) if (!noUv.has(id)) out[id] = Math.max(1, Math.round(a * 100) / 100);
  return out;
}

/** Mean linear colour of the texels a UV-laid mesh actually SAMPLES (each triangle's world area spread over a lattice of
 *  points inside its UV triangle; opaque texels only; rows counted from the bottom when `flipY`, the TextureLoader way).
 *  L (PLACES-FIX 2026-10-21): value judged an atlas material by the whole PAGE's mean, so every poi-props piece read
 *  L* 46.1 (crate's own tiles 41, the banner's cloth 49) and a darker tile could never move it. Null when no triangle
 *  of the material has UVs or the picture is unknown. */
export function uvFootprintMean(tris: { a: number[]; b: number[]; c: number[]; uv?: [number, number][]; atlas?: { rect: [number, number, number, number]; uv: [number, number][] } }[], img: { width: number; height: number; data: Uint8Array }, flipY = true): [number, number, number] | null {
  const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const s = [0, 0, 0]; let W = 0;
  const bary: [number, number][] = [];
  for (let i = 0; i < 4; i++) for (let j = 0; i + j < 4; j++) bary.push([(i + 1 / 3) / 4, (j + 1 / 3) / 4]);
  for (const t of tris) {
    if (!t.uv || t.uv.length < 3) continue;
    const u = [t.b[0]! - t.a[0]!, t.b[1]! - t.a[1]!, t.b[2]! - t.a[2]!], v = [t.c[0]! - t.a[0]!, t.c[1]! - t.a[1]!, t.c[2]! - t.a[2]!];
    const area = Math.hypot(u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!) / 2;
    if (!(area > 1e-9)) continue;
    // a town-atlas triangle (_ATLASRECT) repeats its authored UVs INSIDE its page rectangle (rect.xy + fract(uv) * rect.zw, the
    // runtime material): wrapping the pre-multiplied UV over the whole page sampled the neighbours and the blank page (fort-keep
    // 2026-11-11: 9 tiles on a 1024 page read L* 56 for red ashlar)
    const [p, q, r] = (t.atlas?.uv ?? t.uv) as [[number, number], [number, number], [number, number]], rc = t.atlas?.rect;
    for (const [bs, br] of bary) {
      const U = p[0] * (1 - bs - br) + q[0] * bs + r[0] * br, V = p[1] * (1 - bs - br) + q[1] * bs + r[1] * br;
      const wu = ((U % 1) + 1) % 1, wv = ((V % 1) + 1) % 1;
      const fu = rc ? rc[0] + wu * rc[2] : wu, fv = rc ? rc[1] + wv * rc[3] : wv;
      const x = Math.min(img.width - 1, Math.floor(fu * img.width)), y = Math.min(img.height - 1, Math.floor((flipY ? 1 - fv : fv) * img.height));
      const ch = img.data.length / (img.width * img.height), i = (y * img.width + x) * ch;
      if (ch === 4 && img.data[i + 3]! < 128) continue;
      for (let k = 0; k < 3; k++) s[k]! += area * lin(img.data[i + k]!);
      W += area;
    }
  }
  return W > 0 ? [s[0]! / W, s[1]! / W, s[2]! / W] : null;
}

/** The entities an art check reads: the world scene plus the job's own op entities. For an INSTALLED job the scene copy
 *  wins: later tools (portals, portal-veil, re-skins) complete the installed entity (the portal script lives only there), and
 *  the op copy would hide it (the veil of a portal anchor whose op has no script was judged as a near-black built surface). */
export function mergeJobEntities<E>(sceneEnts: Record<string, E>, jobEnts: Record<string, E>, installed: boolean): Record<string, E> {
  return { ...sceneEnts, ...Object.fromEntries(Object.entries(jobEnts).filter(([id]) => !(installed && sceneEnts[id]))) };
}

/** A portal's veil (`<portal>-veil`, written by tools/portal-veil.mts): the dark mouth by design, never a built surface. */
export function isPortalVeil(id: string, ents: Record<string, { components?: Record<string, any> } | undefined>): boolean {
  return id.endsWith("-veil") && ents[id.slice(0, -"-veil".length)]?.components?.["script"]?.name === "portal";
}

/** The prop instances "around" a piece for its texel comparison: within `radius` m (plan distance) of `at`, never the job's OWN
 *  instances (a landmark's own lanterns/fittings are part of the place, not the props it must match; owned meshes are excluded the same way). */
export function nearPropInstances<T>(instances: [string, T][], owned: ReadonlySet<string>, at: [number, number], radius: number, posOf: (id: string) => readonly number[]): [string, T][] {
  return instances.filter(([id]) => { if (owned.has(id)) return false; const p = posOf(id); return Math.hypot(p[0]! - at[0], p[2]! - at[1]) <= radius; });
}

/** The triangles of a baked piece a player can SEE: a landmark is baked on its footing and its faces run on below the
 *  ground (a retaining face buried in the bank, a footing band) — those are not laid-down tile anyone looks at, so the
 *  variety / texel / value rules measure only the triangles whose centroid stands above the terrain (`sink` m of
 *  tolerance for the seam). `at` is the prefab's world origin (landmarks are placed unrotated at their position). */
export function visibleTris<T extends { a: number[]; b: number[]; c: number[] }>(tris: T[], at: readonly number[], height: (x: number, z: number) => number, sink = 0.3): T[] {
  return tris.filter((t) => {
    const x = (t.a[0]! + t.b[0]! + t.c[0]!) / 3 + at[0]!, y = (t.a[1]! + t.b[1]! + t.c[1]!) / 3 + at[1]!, z = (t.a[2]! + t.b[2]! + t.c[2]!) / 3 + at[2]!;
    return y >= height(x, z) - sink;
  });
}

/** The faces of a BUILT bake a player can see: a built landmark is a union of overlapping closed solids (a stair's
 *  treads run into each other and into the body, a coping sits on the face's top, mitred pieces share their ends), so
 *  a face buried INSIDE another solid of the same bake is not laid-down tile either. Every candidate triangle is split
 *  into pieces no longer than `edge` m; a piece is dropped when the point `eps` m off its centroid (along its normal)
 *  lies inside the bake: winding number along a vertical ray over all of `solids` (closed, consistently wound) >= 1. */
export function unburiedTris<T extends { a: number[]; b: number[]; c: number[]; uv?: [number, number][] }>(tris: T[], solids: { a: number[]; b: number[]; c: number[] }[], edge = 1.5, eps = 0.02): T[] {
  const G = 2, grid = new Map<string, number[]>();
  const S = solids.map((t) => {
    const nY = (t.b[2]! - t.a[2]!) * (t.c[0]! - t.a[0]!) - (t.b[0]! - t.a[0]!) * (t.c[2]! - t.a[2]!); // y of (b-a) x (c-a)
    return { t, sign: Math.sign(nY) };
  });
  S.forEach(({ t, sign }, i) => {
    if (!sign) return;
    const x0 = Math.floor(Math.min(t.a[0]!, t.b[0]!, t.c[0]!) / G), x1 = Math.floor(Math.max(t.a[0]!, t.b[0]!, t.c[0]!) / G);
    const z0 = Math.floor(Math.min(t.a[2]!, t.b[2]!, t.c[2]!) / G), z1 = Math.floor(Math.max(t.a[2]!, t.b[2]!, t.c[2]!) / G);
    for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) { const k = `${x},${z}`; (grid.get(k) ?? grid.set(k, []).get(k)!).push(i); }
  });
  const winding = (px: number, py: number, pz: number) => {
    px += 1.37e-4; pz += 2.71e-4; // off any shared edge
    let w = 0;
    for (const i of grid.get(`${Math.floor(px / G)},${Math.floor(pz / G)}`) ?? []) {
      const { t, sign } = S[i]!, [a, b, c] = [t.a, t.b, t.c];
      const d = (b[2]! - c[2]!) * (a[0]! - c[0]!) + (c[0]! - b[0]!) * (a[2]! - c[2]!);
      if (Math.abs(d) < 1e-12) continue;
      const l1 = ((b[2]! - c[2]!) * (px - c[0]!) + (c[0]! - b[0]!) * (pz - c[2]!)) / d, l2 = ((c[2]! - a[2]!) * (px - c[0]!) + (a[0]! - c[0]!) * (pz - c[2]!)) / d, l3 = 1 - l1 - l2;
      if (l1 < 0 || l2 < 0 || l3 < 0) continue;
      if (l1 * a[1]! + l2 * b[1]! + l3 * c[1]! > py) w += sign;
    }
    return w;
  };
  const mid = (p: number[], q: number[]) => p.map((v, k) => (v + q[k]!) / 2);
  const out: T[] = [];
  const visit = (t: T, depth: number) => {
    const L = [Math.hypot(...t.a.map((v, k) => v - t.b[k]!)), Math.hypot(...t.b.map((v, k) => v - t.c[k]!)), Math.hypot(...t.c.map((v, k) => v - t.a[k]!))];
    const m = L.indexOf(Math.max(...L));
    if (L[m]! > edge && depth < 16) {
      // split the longest edge at its middle (uvs follow)
      const P = [t.a, t.b, t.c], U = t.uv, i = m, j = (m + 1) % 3, k = (m + 2) % 3, M = mid(P[i]!, P[j]!), MU = U ? (mid(U[i]!, U[j]!) as [number, number]) : undefined;
      const mk = (p: number[][], u?: [number, number][]) => ({ ...t, a: p[0]!, b: p[1]!, c: p[2]!, ...(u ? { uv: u } : {}) }) as T;
      visit(mk([P[i]!, M, P[k]!], U ? [U[i]!, MU!, U[k]!] : undefined), depth + 1);
      visit(mk([M, P[j]!, P[k]!], U ? [MU!, U[j]!, U[k]!] : undefined), depth + 1);
      return;
    }
    const u = t.b.map((v, q) => v - t.a[q]!), w = t.c.map((v, q) => v - t.a[q]!);
    const n = [u[1]! * w[2]! - u[2]! * w[1]!, u[2]! * w[0]! - u[0]! * w[2]!, u[0]! * w[1]! - u[1]! * w[0]!], l = Math.hypot(...n);
    if (l < 1e-12) return;
    const c = [0, 1, 2].map((q) => (t.a[q]! + t.b[q]! + t.c[q]!) / 3 + (n[q]! / l) * eps);
    if (Math.abs(winding(c[0]!, c[1]!, c[2]!)) < 1) out.push(t);
  };
  for (const t of tris) visit(t, 0);
  return out;
}
