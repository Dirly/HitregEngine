import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ABILITIES } from "../../../apps/playground/projects/voxel-demo/scripts/lib/abilities.js";
import { MOB_ABILITIES } from "../../../apps/playground/projects/voxel-demo/scripts/lib/mob-abilities.js";
import { SCHOOL_COLOR } from "../../../apps/playground/projects/voxel-demo/scripts/lib/combat-rules.js";
import { SKILL_ICON_TYPE } from "../../../apps/playground/projects/voxel-demo/scripts/lib/skill-icon-table.js";
import {
  TYPE_COLOR,
  VERB_ICON_IDS,
  VERB_SKIN,
  skillIcon,
  skillType,
} from "../../../apps/playground/projects/voxel-demo/scripts/lib/skill-icons.js";

/**
 * voxel-demo package D3c (docs/combat-build/D3c-icons-hud.md): every player
 * skill and every right-click verb has its own icon file, drawn on a sheet of
 * its own type, and the type colours are the school colours plus a distinct
 * physical one. The same checks as `npx tsx tools/skill-icons.mts audit`.
 */

const textures = path.resolve(__dirname, "../../../apps/playground/projects/voxel-demo/assets/textures");
const player = Object.values(ABILITIES).filter((a) => !(a.id in MOB_ABILITIES));

describe("skill icons (D3c)", () => {
  it("every player skill names an icon that exists, drawn on a sheet of its own type", () => {
    const problems: string[] = [];
    for (const a of player) {
      if (!a.icon) problems.push(`${a.id}: no icon`);
      else if (!existsSync(path.join(textures, a.icon))) problems.push(`${a.id}: missing file ${a.icon}`);
      else if (SKILL_ICON_TYPE[a.id] !== skillType(a)) problems.push(`${a.id}: drawn as ${SKILL_ICON_TYPE[a.id]}, is ${skillType(a)}`);
    }
    expect(problems).toEqual([]);
  });

  it("no two skills or verbs share an icon, by path or by picture", () => {
    const icons = [...player.map((a) => a.icon!), ...Object.values(VERB_SKIN).map((v) => v.icon)];
    expect(new Set(icons).size).toBe(icons.length);
    const hashes = icons.map((i) => createHash("sha1").update(readFileSync(path.join(textures, i))).digest("hex"));
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("the verbs have proper names and icons; a twisted skill wears its base's", () => {
    for (const id of VERB_ICON_IDS) expect(SKILL_ICON_TYPE[id]).toBe("physical");
    for (const v of Object.values(VERB_SKIN)) expect(v.name).not.toMatch(/^@/);
    expect(skillIcon("emberBolt+leech")).toBe(ABILITIES["emberBolt"]!.icon);
  });

  it("types: physical by kind, spells by school (frost is destruction); physical's colour is its own", () => {
    expect(skillType(ABILITIES["blink"]!)).toBe("physical");
    expect(skillType(ABILITIES["frostShard"]!)).toBe("destruction");
    expect(skillType(ABILITIES["smite"]!)).toBe("holy");
    for (const s of Object.keys(SCHOOL_COLOR) as Array<keyof typeof SCHOOL_COLOR>) expect(TYPE_COLOR[s]).toBe(SCHOOL_COLOR[s]);
    expect(Object.values(SCHOOL_COLOR)).not.toContain(TYPE_COLOR.physical);
  });
});
