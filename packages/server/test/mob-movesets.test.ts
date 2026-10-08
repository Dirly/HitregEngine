import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { MobBrain } from "@hitreg/scripting";
import { ABILITIES, auditAbilities } from "../../../apps/playground/projects/voxel-demo/scripts/lib/abilities.js";
import { MOB_ABILITIES } from "../../../apps/playground/projects/voxel-demo/scripts/lib/mob-abilities.js";
import { TELL_LEAD } from "../../../apps/playground/projects/voxel-demo/scripts/lib/combat-rules.js";

/**
 * voxel-demo's creature movesets (package C of docs/combat-plan.md), pinned
 * without a server: every mob ability is tagged and tells long enough, and
 * every prefab's `moves` parses, names a real ability, and repeats that
 * ability's wind-up — the brain stands committed for the move's `windup`, the
 * caster resolves at the ability's, and the two drifting apart is a mob that
 * walks off while its swing lands, or stands like a post after it has.
 *
 * The game has no test runner of its own, so this imports it by path, like
 * defence-rules.test.ts (projects/ is gitignored).
 */

const PREFABS = join(__dirname, "../../../apps/playground/projects/voxel-demo/assets/prefabs/mobs");

interface Entity {
  components: { script?: { name: string; params: Record<string, unknown> } };
}

function brainsOf(): Array<{ file: string; params: Record<string, unknown> }> {
  const out: Array<{ file: string; params: Record<string, unknown> }> = [];
  for (const file of readdirSync(PREFABS).filter((f) => f.endsWith(".json"))) {
    const doc = JSON.parse(readFileSync(join(PREFABS, file), "utf8")) as { entities: Record<string, Entity> };
    for (const e of Object.values(doc.entities)) {
      if (e.components.script?.name === "mob-brain") out.push({ file, params: e.components.script.params });
    }
  }
  return out;
}

describe("mob abilities", () => {
  it("pass the ability audit (tagged, tell long enough, dodgeable, declared)", () => {
    expect(auditAbilities(MOB_ABILITIES)).toEqual([]);
  });

  it("each wind up for at least their class's tell", () => {
    for (const a of Object.values(MOB_ABILITIES)) {
      expect(a.kind, a.id).toBeDefined();
      expect(a.attackClass, a.id).toBeDefined();
      expect(a.timing.windup, a.id).toBeGreaterThanOrEqual(TELL_LEAD[a.attackClass!]);
    }
  });

  it("keep ground telegraphs for the unblockable only", () => {
    for (const a of Object.values(MOB_ABILITIES)) {
      expect(a.timing.kind === "telegraph", a.id).toBe(a.attackClass === "unblockable");
    }
  });

  it("cast magic in more than one school", () => {
    const schools = new Set(Object.values(MOB_ABILITIES).filter((a) => a.kind === "magic").map((a) => a.element));
    expect(schools.size).toBeGreaterThanOrEqual(3);
  });
});

describe("mob prefab movesets", () => {
  const brains = brainsOf();

  it("every prefab carries a moveset that parses", () => {
    expect(brains.length).toBeGreaterThan(0);
    for (const b of brains) {
      const parsed = z.array(MobBrain.moveSchema).safeParse(b.params["moves"]);
      expect(parsed.success, b.file).toBe(true);
      expect((parsed.data ?? []).length, b.file).toBeGreaterThan(0);
    }
  });

  it("every move names a real ability and repeats its wind-up and cooldown floor", () => {
    for (const b of brains) {
      for (const move of z.array(MobBrain.moveSchema).parse(b.params["moves"])) {
        const a = ABILITIES[move.ability];
        expect(a, `${b.file}: ${move.ability}`).toBeDefined();
        expect(move.windup, `${b.file}: ${move.ability}`).toBeCloseTo(a!.timing.windup, 5);
        expect(move.cooldown, `${b.file}: ${move.ability}`).toBeGreaterThanOrEqual(a!.cooldown);
      }
    }
  });

  it("has at least three roles: a brute, a skirmisher and a caster", () => {
    const has = (pred: (abilities: string[], rules: string[]) => boolean) =>
      brains.some((b) => {
        const moves = z.array(MobBrain.moveSchema).parse(b.params["moves"]);
        return pred(moves.map((m) => m.ability), moves.map((m) => m.target));
      });
    expect(has((a) => a.includes("mobSlam") && a.includes("mobSweep"))).toBe(true); // brute
    expect(has((a, r) => a.includes("mobLeap") && r.includes("behind"))).toBe(true); // skirmisher
    expect(has((a) => a.some((id) => ABILITIES[id]?.kind === "magic"))).toBe(true); // caster
  });

  it("gives two caster types two different schools", () => {
    const schools = new Set<string>();
    for (const b of brains) {
      for (const move of z.array(MobBrain.moveSchema).parse(b.params["moves"])) {
        const a = ABILITIES[move.ability];
        if (a?.kind === "magic") schools.add(a.element);
      }
    }
    expect(schools.size).toBeGreaterThanOrEqual(2);
  });

  // E1/F: casters kited out of every melee interrupt. A melee player has to be
  // able to reach one, and to find it casting once there.
  it("a ranged creature backs away slower than a player runs, and a caster still casts in melee", () => {
    const player = JSON.parse(readFileSync(join(PREFABS, "../characters/player.json"), "utf8")) as { entities: Record<string, Entity> };
    const run = Object.values(player.entities)
      .map((e) => e.components.script)
      .find((s) => s?.name === "third-person-controller")!.params["speed"] as number;
    expect(run).toBeGreaterThan(0);
    for (const b of brains) {
      if (!((b.params["preferredRange"] as number) > 0)) continue;
      const retreat = (b.params["retreatSpeed"] as number) || (b.params["speed"] as number) * 0.6;
      expect(retreat, b.file).toBeLessThan(run * 0.5);
      const moves = z.array(MobBrain.moveSchema).parse(b.params["moves"]);
      const spells = moves.filter((m) => ABILITIES[m.ability]?.kind === "magic");
      // a caster's spell on its threat target reaches down to melee range, so a pummel finds a cast to stop
      if (spells.length) expect(spells.some((m) => m.target === "threat" && (m.range?.[0] ?? 0) === 0), b.file).toBe(true);
    }
  });
});
