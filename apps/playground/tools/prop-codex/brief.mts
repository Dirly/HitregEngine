/**
 * The Codex prop brief: one open prop request (authoring/dressing/prop-requests.json) -> the bounded design job a
 * Codex run answers with ONE design script (`<name>.py`) on the town-craft helper library. Pure: no I/O beyond
 * reading the helper library's text for the context file, so the brief writer is testable without Blender or Codex.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from 'node:url';
import type { PropRequest } from "../_prop-composite-guard.mts";
import { DEFAULT_KIND_SIZES, kindOf } from "../_prop-real-size.mts";

/** The material roles of the shared town-craft role sheet (authoring/town-craft/material-roles.json), in sheet order. */
export const ROLE_NOTES: Record<string, string> = {
  wood: "warm planed timber (posts, boards, frames, handles)",
  stone: "dressed grey stone",
  iron: "dark wrought iron (bands, hooks, blades, chain, cages)",
  cutwood: "end-grain / rough sawn wood (chopping faces, split logs, broken ends)",
  rope: "rope and cord",
  linen: "pale undyed cloth (shrouds, sheets, sacking)",
  leather: "brown leather (straps, hides, bellows)",
  brass: "brass / bronze (bells, fittings)",
  parchment: "paper / parchment",
  wicker: "woven wicker / reed / straw",
  canvas: "heavy sailcloth / tarp",
  bread: "baked crust",
  herbs: "dried herbs / kelp / weed",
  pottery: "glazed folk terracotta",
  wool: "patterned dyed wool",
  char: "soot-blackened / burnt iron and timber",
};
export const CATEGORIES = ["furniture", "storage", "bedding", "light", "tableware", "document", "tool", "decor", "trade", "sacred", "street"];
/** A design's hard limits: the check refuses anything outside them. */
export const LIMITS = { trianglesMax: 1200, partMinExtent: 0.05, texel: { target: 40, min: 32, max: 48 } };
/** A landmark request (`request add --landmark <m>`) is built at its full height: never a small prop scaled up (texel). */
export const LANDMARK_TRIANGLES = 2400, LANDMARK_MAX_M = 30;

export interface ScaleInfo { id: string; height: number }
export interface BriefInput {
  request: PropRequest & { project: string };
  name: string;
  scale: ScaleInfo;
  /** Short words the request's culture means (from the dressing vocabulary). */
  cultureNote?: string;
  /** The owner's review of an earlier design for this request (a redo). */
  reviewNote?: string;
  /** Gate text from a failed check, fed back on the retry. */
  retry?: string;
  reuseNotes?: string;
}

/** A prop name from a request id: the slug's first words, never the culture repeated, at most 5 words / 40 chars. */
export function propName(req: Pick<PropRequest, "id" | "culture">): string {
  const words = req.id.split("/").pop()!.split("-").filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (out.length >= 5 || [...out, w].join("-").length > 40) break;
    if (w === req.culture && out.length) continue;
    out.push(w);
  }
  return out.join("-");
}

/** Reference sizes for the user of a scale class (a 1.8 m human's door, seat, table, scaled by height). */
export function scaleReferences(scale: ScaleInfo): string {
  const f = scale.height / 1.8, m = (v: number) => `${(v * f).toFixed(2)} m`;
  return `user ${scale.height.toFixed(2)} m tall: a door ${m(2)}, a seat ${m(0.45)}, a table top ${m(0.75)}, a hand tool ${m(1.0)}-${m(1.5)} long, a hand-carried tub ${m(0.4)}-${m(0.6)} across, a cart ${m(1.5)}-${m(4)} long`;
}

/** The size range a kind (prop-kind-sizes.json) holds this name to, if it names one. */
export function kindRange(name: string, scale: ScaleInfo): string | null {
  const kind = kindOf(name, DEFAULT_KIND_SIZES);
  if (!kind) return null;
  const k = DEFAULT_KIND_SIZES.kinds[kind]!, f = scale.height / DEFAULT_KIND_SIZES.userHeight;
  const dim = k.dim === "h" ? "tall" : k.dim === "long" ? "long (longer horizontal side)" : "across (largest side)";
  return `the name reads as a "${kind}": it must be ${(k.range[0] * f).toFixed(2)}-${(k.range[1] * f).toFixed(2)} m ${dim}${k.note ? ` (${k.note})` : ""}`;
}

/** The design brief (markdown) for one request. */
export function writeBrief(input: BriefInput): string {
  const { request: r, name, scale } = input;
  const range = kindRange(name, scale);
  const lines = [
    `# Prop design job: \`${name}\``,
    "",
    `Open prop request \`${r.id}\` (project ${r.project}) for **${r.for}**.`,
    r.why ? `Why it is wanted: ${r.why}` : "",
    "",
    "## What to make",
    "Reuse existing models before making geometry. Books, candles, skulls and other existing components belong in prefab assemblies. A generated body must not remodel those components; leave measured attachment positions and compose the existing assets afterwards. Retexturing an existing model is preferred when its form already fits.",
    input.reuseNotes ? `Preferred reusable sources (binding):\n${input.reuseNotes}` : "",
    `ONE static prop: **${r.name.replace(/-/g, " ")}** — for the **${r.culture}** culture${input.cultureNote ? ` (${input.cultureNote})` : ""}, **${scale.id}** scale.`,
    "Its overall shape and function must read at 10 m. Identity and ornament may come from painted artwork; do not model details merely to make the untextured silhouette name every motif. If the request names a stand-in, yours replaces it in the same spot.",
    "If the request describes a scene (a pile, a set, a heap of several things), make the ONE strongest object of it that reads as the whole idea.",
    "",
    "## Real size (binding)",
    `Real-world metres for a ${scale.id}-scale ${scaleReferences(scale)}.`,
    range ? `Size gate: ${range}.` : "No kind range applies: size it as the real object is for that user. Never scale a thing up so it reads from far away.",
    `A ${scale.id}-scale prop is never larger than ${(6 * scale.height / 1.8).toFixed(1)} m on any side.`,
    "",
    "## Style (binding): PSX / WoW Classic / EverQuest, KISS",
    "- Few, chunky parts (typically 4-20 calls). Big readable shapes; the texture carries all small detail.",
    `- No part smaller than ${LIMITS.partMinExtent * 100} cm in its largest dimension: nails, rivets, grain, rope twist, writing, seams, studs, stitching are painted by the role texture, never modelled. Chain = a few chunky links or a coiled tube, not 40 links.`,
    `- At most ${LIMITS.trianglesMax} triangles after triangulation (aim for 150-700). Prefer beams/blocks/panels; use low segment counts (6-10) on lathe/tube/vessel.`,
    "- Openings, gaps, legs, cavities and outlines are real geometry; surfaces are not.",
    `- Texel density is fixed by the helper at ${LIMITS.texel.target} texels/m. Use named paint(...) surfaces for custom artwork; the tool owns their UVs, image import and atlas packing. Do not manually scale UVs or create materials, images or modifiers.`,
    "- Geometry carries the outer silhouette, openings, functional depth, support and moving parts. Paint carries carved relief, decorative shell segmentation, veins, bevel shading, faces, symbols, patina, seams and small fittings, even when the motif itself is large.",
    "- First decide what is structural and what is painted. A beetle door is a thick door with painted beetle artwork; an elaborate seal is a shallow disc with a painted face; an insect statue uses a few shaped masses with painted shell divisions and eyes. Do not assemble ornamental legs, veins or a seal from tubes when artwork can express them.",
    "",
    "## Shared material roles (plain surfaces; custom painted regions are declared separately)",
    ...Object.entries(ROLE_NOTES).map(([k, v]) => `- \`${k}\`: ${v}`),
    "",
    "## Named artwork surfaces (prefer these for identity and ornament)",
    "Build the simple shape with the helpers and give its part a stable name. Then call:",
    "`paint(m, 'beetle-front', part='door body', projection='front', detail='A painted carved beetle with layered wing covers, recessed legs, aged bronze borders and worn teal pigments.')`",
    "The helper paints only the facing polygons of that part. Projections: front/back/left/right/top/bottom; cylinder unwraps a vertical shell with a real seam. Use separate named front/back surfaces when the artwork differs. A flat disc face uses top or front according to its modeled pose; its circular UV footprint is preserved.",
    "Use a detailed art description rather than generic material names. No image or file access in the design: `props paint plan` measures the surface and writes the exact UV guide, `props paint gen` generates/registers art, and `props paint import --art <png>` registers supplied art. Missing or stale artwork blocks final builds. Ordinary unpainted wood/stone props may still use shared roles alone.",
    "",
    "## Frame and mount",
    "- Blender coordinates, metres, Z up. The FRONT of the prop faces **-Y**; its back is +Y.",
    "- `floor`: stands on z = 0 (its lowest point touches the ground; the tool re-centres X/Y and drops it to 0).",
    "- `wall`: hangs on a wall; its flat back is the highest-Y face and everything projects toward -Y.",
    "- `surface`: small enough to rest on a table or shelf (under 0.6 m).",
    "- `ceiling`: hangs from a beam, gate arm or ceiling; build it hanging, with its top suspension point the highest point (the tool puts the origin at the top centre). No post, no beam: the host already has one.",
    "- Things that lie on the ground (a coil, a lid, a heap) are `floor` and lie flat.",
    "- Never model smoke, fire, flames, steam, mist or light: those are vfx/light prefabs a dresser adds. A fire pit is its stones, ash and fuel.",
    "- Standing water (a pool, a spring, a trough's water) is NOT geometry: model the basin/rim and its dry bed, and pass `water=dict(centre=(x,y,z), radius=r, depth=d)` to emit — a flat engine water disc (the engine's water material and swimmable `water` volume) is added at that centre (z = the waterline, inside the rim), radius r, reaching depth d down to the bed.",
    "",
    "## Contract (the check enforces it)",
    `Write exactly one file, \`${name}.py\`: a Python snippet executed inside the helper namespace of \`context/helpers.py\` (read it, and the`,
    "examples in `context/examples.py`, which are real catalogued designs in the same palette). Rules:",
    `- Build exactly one mesh: \`m=Mesh('${name}')\`, then helper calls (block, beam, panel, table, tray, vessel, disc, wheel, sack, loaf, m.tube, m.lathe, m.slab, m.add), paint(...) declarations and \`math\`.`,
    "- No imports, no bpy, no file access, no functions other than small local helpers, no randomness (use fixed numbers).",
    "- Every helper call names a part (`part='...'`) where it takes one, saying what the part IS.",
    "- End with exactly ONE call:",
    `  \`emit(m, '<one-sentence design: what it is and how it reads>', category='<one of ${CATEGORIES.join("|")}>', mount='floor|wall|surface|ceiling', solid=True|False, setting='indoor|outdoor|both', cultures=['${r.culture}', ...])\``,
    "  `solid=False` only for soft things a body walks through (cloth, a rope heap, straw). `cultures` must include the requested culture; add others only if they would truly use it.",
    "- Add `centrepiece=True` only if it belongs in the middle of a room or yard (a bier on display, a well, a gibbet).",
    "",
    "The check builds your design in Blender headless and refuses it on: missing/extra emit, wrong name, an unknown role, a part under 5 cm,",
    `more than ${LIMITS.trianglesMax} triangles, texel density outside ${LIMITS.texel.min}-${LIMITS.texel.max}/m, a size outside the real-size range or the scale class, or a culture missing.`,
  ];
  const lm = input.request.landmark, hero = input.request.size;
  if (hero && !lm) lines.push("", "## Size (a hero prop placed at this size)", `The finished prop is ${hero} m tall; do not scale later. Build it at ${hero} m (within 10%): the place stands it at scale 1.`);
  if (lm) lines.push("", "## LANDMARK structure (overrides the size and triangle limits above)", `This is a landmark seen from 300 m: build it at its FULL real size, ${lm} m tall (within 10%), never small. Its largest side may be up to ${lm} m and it may use up to ${LANDMARK_TRIANGLES} triangles. Keep it KISS: long beams and blocks, few parts; the scale class only says who uses it.`);
  if (input.reviewNote) lines.push("", "## The owner reviewed an earlier design for this request and sent it back", "Make a NEW design that fixes this (it overrides anything above it contradicts):", "", input.reviewNote.trim());
  if (input.retry) lines.push("", "## Your previous design FAILED the check", "Fix exactly these faults (the rest of the brief still holds):", "```", input.retry.trim(), "```");
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n") + "\n";
}

/** The helper library Codex designs against: town-craft's helper functions + the shared Mesh class (text, for context). */
export function helperContext(worldKit: string): string {
  const tc = path.join(worldKit, "authoring/town-craft/build.py"), mesh = path.join(worldKit, "authoring/crockin-river-culture/mesh.py");
  const build = fs.readFileSync(tc, "utf8");
  const a = build.indexOf("def block("), b = build.indexOf("def emit(");
  if (a < 0 || b < 0) throw Error(`town-craft build.py has no helper section (def block .. def emit): ${tc}`);
  const meshText = fs.readFileSync(mesh, "utf8");
  const m0 = meshText.indexOf("class Mesh");
  const surfaceText = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'surfaces.py'), 'utf8');
  return [
    "# Helper library for prop designs (read-only reference). Mesh is the shared mesh builder; the functions below it",
    "# are the town-craft helpers. Coordinates: metres, Z up, front faces -Y. UVs and the atlas are handled for you.",
    "# emit(m, design, category='tool', mount='floor', solid=True, setting='both', cultures=[...], centrepiece=False, water=None) ends a design.",
    "import math",
    "",
    meshText.slice(m0 >= 0 ? m0 : 0).split("\n    def object(")[0],
    "",
    build.slice(a, b).trimEnd(),
    surfaceText.slice(surfaceText.indexOf('PROJECTIONS ='), surfaceText.indexOf('def clipped(')).trimEnd(),
    "",
  ].join("\n");
}

/** Two short real designs from town-craft/designs.py as style examples (whole blocks, by mesh name). */
export function exampleContext(worldKit: string, names = ["wash-tub-and-board", "public-pillory", "porters-back-frame", "cargo-loading-skid"]): string {
  const text = fs.readFileSync(path.join(worldKit, "authoring/town-craft/designs.py"), "utf8");
  const blocks = text.split(/\n(?=m=Mesh\(')/);
  const pick = names.map((n) => blocks.find((b) => b.startsWith(`m=Mesh('${n}')`))).filter((b): b is string => !!b).map((b) => { const ls = b.split("\n"), end = ls.findIndex((l) => /^\s*emit\(m,/.test(l)); return (end >= 0 ? ls.slice(0, end + 1) : ls).join("\n").trim(); });
  return [
    "# Real catalogued town-craft designs (same helpers, same palette). Their emit() takes a family first; YOURS does not:",
    "# emit(m, design, category=..., mount=..., solid=..., setting=..., cultures=[...]).",
    ...pick,
    "",
  ].join("\n\n");
}
