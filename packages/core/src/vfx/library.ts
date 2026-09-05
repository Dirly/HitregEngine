import { BASE_PRESETS, type Preset, type Slot } from "./presets.js";
import { EXTRA_PRESETS } from "./presets-more.js";
import { SYMBOL_PRESETS } from "./presets-symbols.js";
import type { Phase } from "./modules.js";

/**
 * The whole preset library: the founding set, the second pass (PSX masks,
 * rain, wedges, multi-strand bolts, status effects, shadow, stacks) and the
 * third (symbols, slashes, stepping sequences). Split across files only so
 * each stays readable; the generator sees one list.
 */
export const PRESETS: readonly Preset[] = [...BASE_PRESETS, ...EXTRA_PRESETS, ...SYMBOL_PRESETS];

export function presetsFor(phase: Phase, slot: Slot): Preset[] {
  return PRESETS.filter((p) => p.slot === slot && p.phases.includes(phase));
}

export function presetById(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
