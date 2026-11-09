import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultWorldRecipe, worldRecipeSchema, type Op } from '@hitreg/core';
import { populate } from '../tools/zonegen/commands/populate.mts';
import { bestiarySchema, zoneBestiarySchema } from '../tools/zonegen/schemas.mts';
import { makePaths, type Ctx, type Finding } from '../tools/zonegen/lib.mts';
import type { ZonePlan } from '../tools/zonegen/commands/_zone.mts';

test('common wildlife, fill, roamers and companions keep their physical size through the real population planner', () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'hitreg-populate-scale-'));
  const cwd = process.cwd(), previousRoot = process.env.HITREG_PROJECTS_ROOT;
  const write = (file: string, data: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
  try {
    process.chdir(scratch);
    process.env.HITREG_PROJECTS_ROOT = path.join(scratch, 'projects');
    const paths = makePaths('fixture', 'flat'), zone = 'zone-1';
    const r = defaultWorldRecipe();
    r.name = 'flat'; r.terrain.base = 10; r.terrain.warp.strength = 0;
    for (const noise of [r.terrain.continent, r.terrain.hills, r.terrain.mountains, r.terrain.detail, r.terrain.dunes, r.terrain.mesas]) noise.amplitude = 0;
    r.terrain.overhang.strength = 0; r.terrain.coast.cliff = 0;
    const recipe = worldRecipeSchema.parse({ ...r,
      regions: [
        { id: zone, name: 'Fixture', polygon: [[-600,-600],[600,-600],[600,600],[-600,600]], hub: [-400,0], tags: [] },
        // A nested biome/place region is wilderness, not an implicit safe town.
        { id: 'woodland', name: 'Woodland', within: zone, polygon: [[-600,-600],[600,-600],[600,600],[-600,600]], tags: ['place'] },
        { id: 'town', name: 'Town', within: zone, polygon: [[-590,-590],[-510,-590],[-510,-510],[-590,-510]], hub: [-550,-550], tags: ['town','safe'] },
      ],
      biomes: [{ id: 'grassland', height: [-100,100], surface: [1,0,0,0,0,0,0,0], cliff: [1,0,0,0,0,0,0,0] }],
    });
    write(paths.recipe, recipe);
    write(path.join(paths.projectDir, 'assets/prefabs/mobs/beetle-base.json'), {
      version: 1, name: 'Fixture beetle', root: 'body', entities: {
        body: { name: 'body', parent: null, components: { collider: { shape: 'cylinder', size: [.8,.24,.8] }, script: { name: 'third-person-controller', params: { clipSpeeds: { Walk: 1.2 } } } } },
        brain: { name: 'brain', parent: 'body', components: { script: { name: 'mob-brain', params: { attackRange: .95, radius: .45, eyeHeight: .04, moves: [{ ability: 'mobBite', range: [0,.96] }] } } } },
        caster: { name: 'caster', parent: 'body', components: { script: { name: 'combat-caster', params: { reach: .4 } } } },
        combat: { name: 'combat', parent: 'body', components: { script: { name: 'combat-actor', params: {} } } },
      },
    });
    const bestiary = bestiarySchema.parse({ creatures: [{ id: 'beetle', name: 'Beetle', family: 'beetle', kind: 'wildlife',
      body: { model: 'fixture.glb', status: 'ready' }, themes: [{ id: 'base', status: 'ready' }], roles: ['melee'], abilities: ['mobBite'],
      habitats: ['grassland'], level: [1,10], template: 'mobs/beetle-base' }], factions: [] });
    const options: Record<string,string> = { step: '40', gap: '100', view: '30', budget: '100', 'hub-halo': '0' };
    const ctx = { argv: [], world: 'flat', project: 'fixture', zone, paths,
      opt: (key: string, fallback = '') => options[key] ?? fallback, flag: () => false } as Ctx;

    for (const scale of [1,4]) {
      write(path.join(paths.zoneDir(zone), 'wanderers.json'), { zone, areas: [{ id: 'beetles', name: 'Beetle roamers', placement: 'anywhere',
        at: { at: [250,250] }, radius: 60, population: 8, hiddenFrom: 25, roamRange: [12,24], level: 6, disposition: 'neutral',
        behaviorArchetype:'aggressive', mix: [{ creature: 'beetle', theme: 'base', faction: 'roaming-beetles', behaviorArchetype:'neutral', scale, with: [{ creature: 'beetle', theme: 'base', scale: 2 }] }],
      }, { id: 'woodland-pocket', name: 'Occupied woodland', placement: 'solo', at: { at: [-250,250] }, radius: 80,
        population: 10, hiddenFrom: 30, roamRange: [10,22], disposition: 'neutral', mix: [{creature:'beetle',theme:'base',scale}],
      }] });
      const zb = zoneBestiarySchema.parse({ zone, wildlife: [{ creature: 'beetle', behaviorArchetype:'neutral', habitats: ['grassland'], density: 'dense', scale }],
        faction: [{ creature: 'beetle', theme: 'base', role: 'melee' }], minor: [], rares: [], groups: [{id:'colony',name:'Colony',members:[{creature:'beetle',theme:'base',role:'melee',behaviorArchetype:'aggressive'}],where:'woods',premise:'Defend nest, forage peacefully',behaviorAt:{nest:{faction:'nest-guards',temperament:'hostile'},forage:{faction:'foragers',temperament:'passive'}}}] });
      const plan = { bestiary, zoneBestiary: zb, brief: { level: [3,8], hub: 'none' },
        graph: { locations: [{id:'nest',kind:'poi',hostile:'colony'},{id:'forage',kind:'poi',hostile:'colony'}], quests: [], items: [] }, reservations: { reservations: [{location:'nest',center:[-250,-250],radius:35},{location:'forage',center:[250,-250],radius:35}] } } as unknown as ZonePlan;
      const findings: Finding[] = [];
      const result = populate(ctx, zone, plan, findings);
      assert.ok(result, JSON.stringify(findings));
      // This isolated fixture contains only neutral beetles, so the whole-zone hostile-diversity gate is expected.
      assert.deepEqual(findings.filter(f => f.level === 'error' && f.code !== 'wanderers-thin'), []);
      assert.ok(result.areas.some(a => a.kind === 'wildlife'));
      assert.ok(result.areas.some(a => a.kind === 'fill'));
      for(const [location,temperament,faction]of [['nest','hostile','nest-guards'],['forage','passive','foragers']]){
        const local: NonNullable<ReturnType<typeof populate>>['areas'][number] | undefined = result.areas.find(a=>a.location===location);
        assert.ok(local);
        assert.equal(local.temperament,temperament,'location behavior must survive group placement');
        assert.ok(local.spawns.every(s=>s.behaviorArchetype==='aggressive'),'fixed member policy survives area mood');
        for(const t of result.templates.filter(t=>t.standsAt===local.id&&!t.templateOnly))assert.equal(t.standingBehavior?.behaviorArchetype,'aggressive','standing member keeps its policy before a depleted slot is removed');
        const refs:string[]=[...local.spawns.map(s=>s.template),...result.templates.filter(t=>t.standsAt===local.id).map(t=>t.id)];
        assert.ok(refs.every(id=>result.templates.find(t=>t.id===id)!.faction===faction));
      }
      const pocket = result.areas.find(a => a.id.includes('wander-woodland-pocket'))!;
      assert.ok(pocket, 'an anchored solo table must produce an actual habitat population');
      assert.deepEqual([pocket.x,pocket.z], [-250,250]);
      assert.equal(pocket.life!.population, 10);
      assert.equal(pocket.life!.hiddenFrom, 30);
      assert.deepEqual(pocket.life!.roamRange, [10,22]);
      assert.ok(result.areas.every(a => a.x > -510 || a.z > -510), 'real safe town remains excluded');
      const roamer = result.areas.find(a => a.id.endsWith('wander-beetles'))!;
      assert.ok(roamer);
      assert.equal(roamer.life!.population, 8);
      assert.equal(roamer.life!.behaviorArchetype,'aggressive');
      assert.equal((roamer.life!.mix as any[])[0].behaviorArchetype,'neutral','member archetype wins over area');
      assert.equal((roamer.life!.mix as any[])[0].temperament,'passive','density and disposition reports use resolved policy');
      assert.equal(roamer.life!.hiddenFrom, 25, 'compact habitat birth exclusion must survive authoring');
      assert.deepEqual(roamer.life!.roamRange, [12,24], 'members need their own authored wandering ranges');
      const rows = roamer.life!.mix as { template: string; with: string[] }[];
      const main = result.templates.find(t => t.id === rows[0]!.template)!;
      const companion = result.templates.find(t => t.id === rows[0]!.with[0])!;
      assert.equal(main.scale ?? 1, scale);
      assert.equal(main.faction, 'roaming-beetles', 'an authored assist faction must survive population planning');
      assert.ok(result.templates.filter(t=>(t.scale??1)===scale).some(t=>t.faction==='wild'), 'shared skin and level must not collapse different combat/assist factions');
      assert.equal(companion.scale, 2);
      assert.ok(companion.level >= 3, 'array index must not become the companion level');
      assert.equal(companion.templateOnly, true, 'roaming bodies remain server-held templates');
      for (const area of result.areas.filter(a => a.kind === 'wildlife' || a.kind === 'fill')) {
        assert.equal(area.behaviorArchetype,'neutral');
        const ids: string[] = [...area.spawns.map(s => s.template), ...result.templates.filter(t => t.standsAt === area.id && !t.templateOnly).map(t => t.id)];
        for (const id of ids) assert.equal(result.templates.find(t => t.id === id)!.scale ?? 1, scale);
        for(const template of result.templates.filter(t=>t.standsAt===area.id&&!t.templateOnly)){
          const body:Op|undefined=result.ops.find(o=>o.op==='add-entity'&&o.id===template.id);
          assert.ok(body?.op==='add-entity');
          const ov:Array<{path:string;value:unknown}>=(body.entity.components.prefab as {overrides:Array<{path:string;value:unknown}>}).overrides;
          assert.equal(ov.find(o=>o.path==='brain/components/script/params/behaviorArchetype')?.value,'neutral','authored standing body uses the same policy as later clones');
        }
      }
      if (scale === 4) {
        const op = result.ops.find(o => o.op === 'add-entity' && o.id === main.id);
        assert.ok(op?.op === 'add-entity');
        assert.deepEqual((op.entity.components.transform as {scale:number[]}).scale, [4,4,4]);
        const overrides = (op.entity.components.prefab as {overrides:{path:string;value:unknown}[]}).overrides;
        assert.equal(overrides.find(o => o.path === 'brain/components/script/params/attackRange')!.value, 3.8);
        assert.equal(overrides.find(o => o.path === 'brain/components/script/params/radius')!.value, 1.8);
        assert.equal(overrides.find(o => o.path === 'caster/components/script/params/reach')!.value, 1.6);
        assert.deepEqual(overrides.find(o => o.path === 'body/components/script/params/clipSpeeds')!.value, {Walk:4.8});
      }
    }
  } finally {
    process.chdir(cwd);
    if (previousRoot === undefined) delete process.env.HITREG_PROJECTS_ROOT; else process.env.HITREG_PROJECTS_ROOT = previousRoot;
    const target = path.resolve(scratch);
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(target).startsWith('hitreg-populate-scale-'));
    fs.rmSync(target, { recursive: true, force: true });
  }
});
