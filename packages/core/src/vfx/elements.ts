import { z } from "zod";

/**
 * Elements are the coherence axis of a generated spell: every module in every
 * phase draws from ONE palette, and the palette is what makes a frost bolt
 * and a frost nova read as siblings instead of as two random effects that
 * happen to be blue.
 *
 * The nine named ones match the colour rows of the purchased flipbook sheets
 * (row index = position here) so a sheet can be played in its authored colour;
 * `storm` has no authored row and always rides the greyscale row + tint, which
 * is what every element does by default anyway.
 */
export const ELEMENTS = [
  "fire",
  "arcane",
  "ice",
  "nature",
  "earth",
  "holy",
  "rose",
  "blood",
  "void",
  "storm",
  "shadow",
] as const;
export type Element = (typeof ELEMENTS)[number];
export const elementSchema = z.enum(ELEMENTS);

/**
 * `primary` is the body colour, `secondary` is what things fade toward (a
 * darker, richer cousin — never black, which reads as burnt), `glow` is the
 * near-white core of anything hot. `feel` is the element's default aesthetic
 * bias; the generator uses it to weight presets so fire is soft and heavy,
 * ice is crystalline and sharp, and void is wispy.
 */
export interface ElementPalette {
  primary: string;
  secondary: string;
  glow: string;
  /** Sheet row carrying this element's authored colour (5 = greyscale). */
  row: number;
  feel: readonly Feel[];
}

export const FEELS = ["sharp", "soft", "heavy", "wispy", "crystalline", "radiant"] as const;
export type Feel = (typeof FEELS)[number];
export const feelSchema = z.enum(FEELS);

export const ELEMENT_PALETTES: Record<Element, ElementPalette> = {
  fire: { primary: "#ff7a2a", secondary: "#8a1e00", glow: "#ffe2a8", row: 0, feel: ["soft", "heavy"] },
  arcane: { primary: "#a86cff", secondary: "#2b1466", glow: "#efe0ff", row: 1, feel: ["wispy", "sharp"] },
  ice: { primary: "#5ecbff", secondary: "#0f3d66", glow: "#e8fbff", row: 2, feel: ["crystalline", "sharp"] },
  nature: { primary: "#7ade5c", secondary: "#1d4a15", glow: "#e9ffd0", row: 3, feel: ["soft", "wispy"] },
  earth: { primary: "#e0a95a", secondary: "#4a3417", glow: "#fff0c8", row: 4, feel: ["heavy"] },
  holy: { primary: "#ffd66b", secondary: "#7a5a1e", glow: "#fff4d6", row: 5, feel: ["radiant", "soft"] },
  rose: { primary: "#ff8fc0", secondary: "#6b2340", glow: "#ffe6f2", row: 6, feel: ["soft", "wispy"] },
  blood: { primary: "#ff4a4a", secondary: "#4a0a0a", glow: "#ffc9c9", row: 7, feel: ["heavy", "sharp"] },
  void: { primary: "#7b6cff", secondary: "#120f33", glow: "#d9d4ff", row: 8, feel: ["wispy", "heavy"] },
  storm: { primary: "#7cc8ff", secondary: "#1a3a7a", glow: "#f2fbff", row: 5, feel: ["sharp", "radiant"] },
  // Shadow is the dark one: its body is normal-blended matter and its glow is
  // barely a glow. Invisibility, shadow-step, dread.
  shadow: { primary: "#4a3a6e", secondary: "#08060f", glow: "#9a8ac4", row: 8, feel: ["wispy", "heavy"] },
};

/** The three palette slots a module's `color` may name instead of a hex. */
export const PALETTE_SLOTS = ["primary", "secondary", "glow"] as const;
export type PaletteSlot = (typeof PALETTE_SLOTS)[number];

export interface Palette {
  primary: string;
  secondary: string;
  glow: string;
}

export function paletteFor(element: Element): Palette {
  const p = ELEMENT_PALETTES[element];
  return { primary: p.primary, secondary: p.secondary, glow: p.glow };
}

/** Resolve a module colour ("primary" | "#hex") against a palette. */
export function resolveColor(color: string, palette: Palette): string {
  if (color === "primary" || color === "secondary" || color === "glow") return palette[color];
  return color;
}
