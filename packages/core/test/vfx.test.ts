import { describe, expect, it } from "vitest";
import {
  BUDGET,
  ELEMENTS,
  PHASES,
  PRESETS,
  SPELL_KINDS,
  auditSpell,
  completeModule,
  FOOTPRINT_TOLERANCE,
  expandRepeat,
  fitSpellToVolume,
  footprintOverflows,
  generateSpell,
  makeRng,
  moduleReach,
  wiggleLift,
  wiggleOffset,
  moduleDuration,
  parseSpell,
  phasesForKind,
  randomArchetype,
  rerollModule,
  spellStats,
  spellTimeline,
  symbolSpin,
  symbolsFor,
  vfxEffectSchema,
  type DecalEntry,
  type SpriteCatalog,
  type SymbolEntry,
} from "../src/index.js";

const catalog: SpriteCatalog = {
  burst: [{ sheet: "explosion", frames: 12 }],
  flash: [{ sheet: "impact_spark", frames: 5 }],
  ring: [{ sheet: "shockwave", frames: 13 }],
  rune: [{ sheet: "rune", frames: 8 }],
  slash: [{ sheet: "slash_arc", frames: 9 }],
  vortex: [{ sheet: "vortex", frames: 12 }],
  bolt: [{ sheet: "bolt", frames: 10 }],
};

describe("vfx modules", () => {
  it("fills defaults through the discriminated union", () => {
    const m = completeModule({ kind: "ring", radius: 3 });
    expect(m.kind).toBe("ring");
    if (m.kind === "ring") {
      expect(m.inner).toBe(0.7);
      expect(m.anchor.at).toBe("origin");
      expect(m.blend).toBe("additive");
    }
  });

  it("rejects an unknown kind and out-of-range values", () => {
    expect(() => completeModule({ kind: "laser" as never })).toThrow();
    expect(vfxEffectSchema.safeParse({ modules: [{ kind: "shell", radius: -1 }] }).success).toBe(false);
  });

  it("every preset builds a valid module for every element", () => {
    for (const element of ELEMENTS) {
      for (const kind of SPELL_KINDS) {
        const spell = generateSpell({ seed: `${element}:${kind}`, element, archetype: { kind }, catalog });
        for (const phase of PHASES) {
          const effect = spell.phases[phase];
          if (!effect) continue;
          for (const m of effect.modules) expect(m.kind).toBeTruthy();
        }
      }
    }
  });
});

describe("spell generator", () => {
  it("is deterministic for a seed", () => {
    const a = generateSpell({ seed: 4127, catalog });
    const b = generateSpell({ seed: 4127, catalog });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = generateSpell({ seed: 4128, catalog });
    expect(JSON.stringify(c)).not.toBe(JSON.stringify(a));
  });

  it("fills exactly the phases the archetype uses", () => {
    for (const kind of SPELL_KINDS) {
      const spell = generateSpell({ seed: kind, archetype: { kind }, catalog });
      // every phase the archetype uses except the telegraph (the host draws that)
      const expected = phasesForKind(spell.archetype).filter((p) => p !== "telegraph");
      const got = PHASES.filter((p) => spell.phases[p]);
      expect(got).toEqual(expected);
      expect(spell.phases.impact?.modules.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("scales the presentation off the archetype radius", () => {
    const small = generateSpell({ seed: 7, element: "destruction", archetype: { kind: "area", radius: 2, range: 6 }, catalog });
    const big = generateSpell({ seed: 7, element: "destruction", archetype: { kind: "area", radius: 6, range: 6 }, catalog });
    const ringOf = (s: typeof small): number => {
      const r = s.phases.impact?.modules.find((m) => m.kind === "ring");
      return r && r.kind === "ring" ? r.radius : 0;
    };
    expect(ringOf(big)).toBeGreaterThan(ringOf(small));
  });

  it("random archetypes respect the dodgeability rule", () => {
    const rng = makeRng(99);
    for (let i = 0; i < 200; i++) {
      const a = randomArchetype(rng);
      if (a.kind === "area" || a.kind === "zone" || a.kind === "channel" || a.kind === "summon") {
        expect(a.radius).toBeLessThanOrEqual(6.5 * (a.windup - 0.15) + 1e-6);
      }
    }
  });

  it("generated spells pass the audit and stay inside the budget", () => {
    const rng = makeRng(1);
    let checked = 0;
    for (let i = 0; i < 150; i++) {
      const seed = rng.int(0, 1e9);
      const spell = generateSpell({ seed, catalog });
      const violations = auditSpell(spell);
      expect(violations, `seed ${seed} (${spell.archetype.kind}/${spell.element}): ${violations.map((v) => v.detail).join("; ")}`).toEqual([]);
      const stats = spellStats(spell);
      expect(stats.peakParticles).toBeLessThanOrEqual(BUDGET.peakParticles);
      checked++;
    }
    expect(checked).toBe(150);
  });

  it("rerolls a module into another preset of the same slot", () => {
    const spell = generateSpell({ seed: 5, element: "destruction", archetype: { kind: "area", intensity: 0.9 }, catalog });
    const idx = spell.phases.impact!.modules.findIndex((m) => m.preset === "impact.debris" || m.preset === "impact.dust");
    expect(idx).toBeGreaterThanOrEqual(0);
    const next = rerollModule(spell, "impact", idx, 1, catalog);
    expect(next).not.toBeNull();
    // same slot (debris), a different preset
    const slotOf = (id: string): string | undefined => PRESETS.find((p) => p.id === id)?.slot;
    expect(slotOf(next!.preset!)).toBe("debris");
    expect(next!.preset).not.toBe(spell.phases.impact!.modules[idx]!.preset);
  });

  it("round-trips through the spell schema", () => {
    const spell = generateSpell({ seed: 3, catalog });
    const again = parseSpell(JSON.parse(JSON.stringify(spell)));
    expect(again).toEqual(spell);
  });
});

describe("spell timeline", () => {
  it("places a projectile's impact after its flight", () => {
    const t = spellTimeline({ ...randomArchetype(makeRng(2), "projectile"), range: 20, speed: 10, windup: 0.3 });
    expect(t.impact?.at).toBeCloseTo(2.3);
    expect(t.travel?.duration).toBeCloseTo(2);
  });

  it("ticks a zone at its rate for its duration", () => {
    const t = spellTimeline({ ...randomArchetype(makeRng(2), "zone"), windup: 0.5, duration: 3, ticksPerSecond: 2 });
    expect(t.ticks.length).toBe(6);
    expect(t.ticks[0]).toBeCloseTo(1);
    expect(t.linger?.duration).toBe(3);
  });
});

describe("audit", () => {
  it("generated spells carry no telegraph — the host draws the dodge volume", () => {
    for (let seed = 0; seed < 40; seed++) {
      const spell = generateSpell({ seed, archetype: { kind: "area" }, catalog });
      expect(spell.phases.telegraph).toBeUndefined();
      expect(auditSpell(spell)).toEqual([]);
    }
  });

  it("flags a budget blowout", () => {
    const spell = generateSpell({ seed: 12, archetype: { kind: "area" }, catalog });
    const m = completeModule({ kind: "particles", burst: 2000, emitter: { max: 2000, lifetime: [2, 2] } });
    spell.phases.impact!.modules.push(m, m);
    expect(auditSpell(spell).some((x) => x.rule === "budget")).toBe(true);
  });

  it("the preset library covers every phase slot the grammar asks for", () => {
    const seen = new Set(PRESETS.map((p) => `${p.slot}`));
    expect(seen.has("core")).toBe(true);
    expect(seen.has("volume")).toBe(true);
  });
});

describe("repeat (stepping sequences)", () => {
  it("expands a module into staggered, offset, scaled copies", () => {
    const m = completeModule({ kind: "mesh", size: 1, spin: 2, delay: 0.1, repeat: { count: 3, every: 0.05, step: [0, 0, 1.5], scale: 1.1, alternate: true } });
    const copies = expandRepeat(m);
    expect(copies).toHaveLength(3);
    expect(copies.map((c) => c.delay).map((d) => Math.round(d * 1000) / 1000)).toEqual([0.1, 0.15, 0.2]);
    expect(copies[2]!.anchor.offset[2]).toBeCloseTo(3);
    if (copies[1]!.kind === "mesh" && copies[2]!.kind === "mesh") {
      expect(copies[1]!.size).toBeCloseTo(1.1);
      expect(copies[1]!.spin).toBe(-2); // alternate flips odd copies
      expect(copies[2]!.spin).toBe(2);
    }
    for (const c of copies) expect(c.repeat.count).toBe(1);
  });

  it("turns copies around the anchor so they stand in a circle", () => {
    const m = completeModule({ kind: "ring", radius: 1, repeat: { count: 4, step: [0, 0, 2], turn: 90 } });
    const [a, b, c, d] = expandRepeat(m).map((x) => x.anchor.offset);
    expect(a).toEqual([0, 0, 0]);
    expect(b![0]).toBeCloseTo(2); // turned 90°: forward → right
    expect(b![2]).toBeCloseTo(0);
    expect(c![2]).toBeCloseTo(-4);
    expect(d![0]).toBeCloseTo(-6);
  });

  it("advances an orbiting sprite's phase instead of moving it", () => {
    const m = completeModule({ kind: "sprite", sheet: "s", orbit: 1, orbitSpeed: 2, repeat: { count: 3, turn: 120 } });
    const copies = expandRepeat(m);
    for (const c of copies) expect(c.anchor.offset).toEqual([0, 0, 0]);
    if (copies[1]!.kind === "sprite") expect(copies[1]!.orbitPhase).toBeCloseTo((2 * Math.PI) / 3);
  });

  it("the audit counts every copy", () => {
    const spell = generateSpell({ seed: 12, archetype: { kind: "area" }, catalog });
    const m = completeModule({ kind: "particles", burst: 300, emitter: { max: 300, lifetime: [1, 1] }, repeat: { count: 6, every: 0.1 } });
    spell.phases.impact!.modules = [m];
    expect(spellStats(spell).phases.impact!.particles).toBe(1800);
    expect(spellStats(spell).phases.impact!.instances).toBe(6);
    const big = completeModule({ kind: "ring", repeat: { count: 24 } });
    spell.phases.impact!.modules = [big, big];
    expect(auditSpell(spell).some((v) => v.rule === "budget" && v.detail.includes("instances"))).toBe(true);
  });
});

describe("symbols", () => {
  const symbols: SymbolEntry[] = [
    { id: "sym:0", sheet: "sym", cell: [0, 0], roles: ["sigil"], tags: ["circle"], orient: ["ground", "facing"], spin: "ground", enabled: true },
    { id: "sym:1", sheet: "sym", cell: [1, 0], roles: ["glyph", "star"], tags: [], orient: ["facing", "billboard"], spin: "none", enabled: true },
    { id: "sym:2", sheet: "sym", cell: [2, 0], roles: ["head"], tags: ["arrow"], orient: ["velocity"], spin: "none", enabled: true },
    { id: "sym:3", sheet: "sym", cell: [3, 0], roles: ["stuck"], tags: ["arrow"], orient: ["vertical"], spin: "none", enabled: true },
    { id: "sym:4", sheet: "sym", cell: [4, 0], roles: ["sigil"], tags: [], orient: ["ground"], spin: "any", enabled: false },
  ];
  const withSymbols: SpriteCatalog = { ...catalog, symbols };

  it("picks symbols only at orientations they allow and clips their spin", () => {
    expect(symbolsFor(withSymbols, ["sigil"], "ground").map((s) => s.id)).toEqual(["sym:0"]); // sym:4 is disabled
    expect(symbolsFor(withSymbols, ["sigil"], "billboard")).toEqual([]);
    expect(symbolSpin(symbols[0]!, "ground", 1.5)).toBe(1.5);
    expect(symbolSpin(symbols[0]!, "facing", 1.5)).toBe(0); // spins only when lying flat
    expect(symbolSpin(symbols[1]!, "billboard", 1.5)).toBe(0);
  });

  it("generated spells use symbol presets, honour the rules, and still pass the audit", () => {
    const rng = makeRng(7);
    let symbolModules = 0;
    for (let i = 0; i < 120; i++) {
      const seed = rng.int(0, 1e9);
      const spell = generateSpell({ seed, catalog: withSymbols, pixel: 24 });
      const violations = auditSpell(spell);
      expect(violations, `seed ${seed} (${spell.archetype.kind}): ${violations.map((v) => v.detail).join("; ")}`).toEqual([]);
      for (const phase of PHASES) {
        for (const m of spell.phases[phase]?.modules ?? []) {
          if (m.kind !== "sprite" || !m.cell) continue;
          symbolModules++;
          const entry = symbols.find((s) => s.sheet === m.sheet && s.cell[0] === m.cell![0] && s.cell[1] === m.cell![1])!;
          expect(entry.enabled).toBe(true);
          // a world-fixed quad rides on a symbol that may travel or stand up
          if (m.orient === "world") expect(entry.orient.some((o) => o === "velocity" || o === "vertical")).toBe(true);
          else expect(entry.orient).toContain(m.orient);
          if (entry.spin === "none" || (entry.spin === "ground" && m.orient !== "ground")) expect(m.spin).toBe(0);
          expect(m.pixel).toBeGreaterThan(0);
        }
      }
    }
    expect(symbolModules).toBeGreaterThan(20);
  });

  it("a projectile gets a symbol head and a stuck projectile when the catalog has them", () => {
    let heads = 0;
    let stuck = 0;
    for (let seed = 0; seed < 40; seed++) {
      const spell = generateSpell({ seed, archetype: { kind: "projectile" }, catalog: withSymbols });
      if (spell.phases.travel?.modules.some((m) => m.preset === "travel.symbolHead")) heads++;
      if (spell.phases.impact?.modules.some((m) => m.preset === "impact.stuck")) stuck++;
    }
    expect(heads).toBeGreaterThan(5);
    expect(stuck).toBeGreaterThan(5);
  });

  it("a school draws only its own symbols, falling back to unschooled ones", () => {
    const sigil = (id: string, col: number, elements?: SymbolEntry["elements"]): SymbolEntry => ({
      id,
      sheet: id.split(":")[0]!,
      cell: [col, 0],
      roles: ["sigil", "glyph", "star", "mark"],
      tags: ["circle"],
      orient: ["ground", "facing", "billboard", "vertical", "velocity"],
      spin: "ground",
      enabled: true,
      ...(elements ? { elements } : {}),
    });
    const schooled: SpriteCatalog = {
      ...catalog,
      symbols: [sigil("generic:0", 0), sigil("shadow:0", 1, ["shadow"]), sigil("holy:0", 2, ["holy"])],
    };
    const sheetsFor = (element: (typeof ELEMENTS)[number]): Set<string> => {
      const seen = new Set<string>();
      for (let seed = 0; seed < 60; seed++) {
        const spell = generateSpell({ seed, element, catalog: schooled });
        for (const phase of PHASES) for (const m of spell.phases[phase]?.modules ?? []) if (m.kind === "sprite" && m.cell) seen.add(m.sheet);
      }
      return seen;
    };
    expect([...sheetsFor("shadow")]).toEqual(["shadow"]);
    expect([...sheetsFor("holy")]).toEqual(["holy"]);
    expect([...sheetsFor("water")]).toEqual(["generic"]); // no water sheet yet
  });

  it("impacts grow a ground decal from the school's own marks, and still pass the audit", () => {
    const mark = (id: string, col: number, elements?: DecalEntry["elements"]): DecalEntry => ({
      id,
      sheet: id.split(":")[0]!,
      cell: [col, 0],
      tags: ["crack"],
      enabled: true,
      ...(elements ? { elements } : {}),
    });
    const withDecals: SpriteCatalog = {
      ...catalog,
      decals: [mark("generic-decals:0", 0), mark("nature-decals:0", 1, ["nature"]), mark("destruction-decals:0", 2, ["destruction"])],
    };
    for (const element of ["nature", "destruction", "holy"] as const) {
      let scars = 0;
      for (let seed = 0; seed < 40; seed++) {
        const spell = generateSpell({ seed, element, archetype: { kind: "area" }, catalog: withDecals });
        expect(auditSpell(spell)).toEqual([]);
        for (const phase of PHASES)
          for (const m of spell.phases[phase]?.modules ?? []) {
            if (m.kind !== "decal") continue;
            scars++;
            expect(m.sheet).toBe(element === "holy" ? "generic-decals" : `${element}-decals`);
            expect(m.grow).toBeGreaterThan(0);
          }
      }
      expect(scars).toBeGreaterThan(20);
    }
    // no decals in the catalog: no decal modules, nothing breaks
    const bare = generateSpell({ seed: 1, element: "nature", archetype: { kind: "area" }, catalog });
    expect(PHASES.flatMap((p) => bare.phases[p]?.modules ?? []).some((m) => m.kind === "decal")).toBe(false);
  });

  it("a decal module fills its defaults and counts its fade in the audit", () => {
    const m = completeModule({ kind: "decal", sheet: "x", duration: 2, fadeOut: 0.5 });
    expect(m.kind).toBe("decal");
    if (m.kind === "decal") {
      expect(m.cell).toEqual([0, 0]);
      expect(m.grow).toBe(0.5);
      expect(moduleDuration(m, 1)).toBeCloseTo(2.5);
    }
  });

  it("symbols lying on the ground never spin; a texel look reaches every piece", () => {
    const sigils: SymbolEntry[] = [
      { id: "s:0", sheet: "s", cell: [0, 0], roles: ["sigil", "glyph", "star", "mark"], tags: [], orient: ["ground", "facing", "billboard", "vertical", "velocity"], spin: "any", enabled: true },
    ];
    for (let seed = 0; seed < 60; seed++) {
      const spell = generateSpell({ seed, catalog: { ...catalog, symbols: sigils }, texel: 0.06 });
      expect(spell.texel).toBe(0.06);
      for (const p of PHASES)
        for (const m of spell.phases[p]?.modules ?? []) {
          if (m.kind === "sprite" && m.orient === "ground") expect(m.spin).toBe(0);
          if (m.kind !== "particles" && m.kind !== "light" && m.kind !== "shake" && m.kind !== "sound") expect(m.texel).toBe(0.06);
        }
    }
  });

  it("banned presets are never generated", () => {
    const banned = ["impact.debris", "impact.dust", "travel.wake", "crown.glyphs"];
    for (let seed = 0; seed < 60; seed++) {
      const spell = generateSpell({ seed, catalog: { ...catalog, disabledPresets: banned } });
      for (const p of PHASES) for (const m of spell.phases[p]?.modules ?? []) expect(banned).not.toContain(m.preset);
    }
  });

  it("summoned bodies are the school's drawings, and never cones, diamonds or spheres", () => {
    const objects: SymbolEntry[] = ["spike", "crystal", "rock", "orb", "blade"].map((tag, i) => ({
      id: `obj:${i}`,
      sheet: "obj",
      cell: [i, 0],
      roles: ["object"],
      tags: [tag],
      orient: ["vertical"],
      spin: "none",
      enabled: true,
      elements: ["water"],
    }));
    let drawn = 0;
    for (let seed = 0; seed < 200; seed++) {
      for (const element of ["water", "holy"] as const) {
        const spell = generateSpell({ seed, element, catalog: { ...catalog, symbols: objects } });
        for (const p of PHASES)
          for (const m of spell.phases[p]?.modules ?? []) {
            if (m.kind !== "mesh" || m.asset) continue;
            if (m.sheet) {
              drawn++;
              expect(element).toBe("water");
              expect(m.cells.length).toBeGreaterThan(0);
            } else expect(["spike", "crystal", "orb"]).not.toContain(m.primitive);
          }
      }
    }
    expect(drawn).toBeGreaterThan(10);
  });

  it("fits visuals inside the damage volume, and to a game's own radius", () => {
    const spell = generateSpell({ seed: 3, element: "water", archetype: { kind: "area", radius: 3 }, catalog });
    spell.phases.impact!.modules.push(
      completeModule({ kind: "ring", radius: 9, expand: [0.2, 1.3] }),
      completeModule({ kind: "particles", burst: 20, emitter: { speed: [6, 9], lifetime: [1, 1.5], spread: 180, shape: "sphere", shapeSize: [2, 2, 2] } }),
    );
    expect(footprintOverflows(spell).length).toBeGreaterThanOrEqual(2);
    const fitted = fitSpellToVolume(spell);
    expect(footprintOverflows(fitted)).toEqual([]);
    for (const m of fitted.phases.impact!.modules) {
      const reach = moduleReach(m);
      if (reach !== null) expect(reach).toBeLessThanOrEqual(3 * FOOTPRINT_TOLERANCE + 1e-6);
    }
    // a game playing this spell for a 1.5 m ability pulls it in further
    const small = fitSpellToVolume(spell, { radius: 1.5 });
    for (const m of small.phases.impact!.modules) {
      const reach = moduleReach(m);
      if (reach !== null) expect(reach).toBeLessThanOrEqual(1.5 * FOOTPRINT_TOLERANCE + 1e-6);
    }
  });

  it("weave and bob start at zero, stay inside their amplitude, and differ shot to shot", () => {
    const w = { amplitude: 0.4, wavelength: 3, vertical: 0.3 };
    expect(wiggleOffset(w, 1, 0)).toBe(0);
    expect(wiggleLift(w, 1, 0)).toBe(0);
    let differs = false;
    for (let d = 0; d <= 20; d += 0.25) {
      expect(Math.abs(wiggleOffset(w, 3, d))).toBeLessThanOrEqual(0.4 + 1e-9);
      expect(Math.abs(wiggleLift(w, 3, d))).toBeLessThanOrEqual(0.3 + 1e-9);
      if (Math.abs(wiggleOffset(w, 3, d) - wiggleOffset(w, 4, d)) > 0.05) differs = true;
    }
    expect(differs).toBe(true);
    expect(wiggleLift({ wavelength: 3 }, 1, 5)).toBe(0); // no bob unless asked
  });

  it("knows exactly the five schools", () => {
    expect([...ELEMENTS].sort()).toEqual(["destruction", "holy", "nature", "shadow", "water"]);
  });

  it("melee spells get real cuts", () => {
    let slashes = 0;
    for (let seed = 0; seed < 30; seed++) {
      const spell = generateSpell({ seed, archetype: { kind: "melee" }, catalog });
      if (spell.phases.cast?.modules.some((m) => m.kind === "slash")) slashes++;
    }
    expect(slashes).toBeGreaterThan(15);
  });
});
