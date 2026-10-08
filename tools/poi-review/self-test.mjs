import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { intersectionArea, coplanarOverlaps } from './geometry.mjs';
import { review } from './review.mjs';
import { core } from './engine.mjs';
import { GltfBuilder } from '../wfc-3d/gltf.mjs';
import { findTerrainRoute } from './terrain-route.mjs';
import { reviewRouteChain } from './chain.mjs';
import { auditTerrainRouteSeparation } from './route-separation.mjs';
import os from 'node:os';
import path from 'node:path';
import { run } from './run.mjs';
import { planPoi, poiRequestSchema } from './poi-plan.mjs';
const placement = { position: [0, 0, 0], yaw: 0, scale: 1 };
test('assembly detects partially overlapping triangles with different tessellation; touching edges are safe', () => { assert.equal(intersectionArea([[0, 0], [2, 0], [0, 2]], [[0, 0], [2, 0], [2, -2]]), 0); const geometry = { positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 0, 2]), indices: new Uint32Array([0, 1, 2]) }; const a = { id: 'a', geometry, placement }, b = { id: 'b', geometry, placement: { ...placement, position: [.5, 0, 0] } }; assert.equal(coplanarOverlaps([a, b]).passed, false); assert.equal(coplanarOverlaps([a, { ...b, placement: { ...placement, position: [2, 0, 0] } }]).passed, true); assert.equal(coplanarOverlaps([a, b], { buried: () => true }).passed, true); });
function cube(lo, hi) { const p = new Float32Array([lo[0], lo[1], lo[2], hi[0], lo[1], lo[2], hi[0], hi[1], lo[2], lo[0], hi[1], lo[2], lo[0], lo[1], hi[2], hi[0], lo[1], hi[2], hi[0], hi[1], hi[2], lo[0], hi[1], hi[2]]), idx = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 3, 7, 6, 3, 6, 2, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5]), g = new GltfBuilder('poi-review-test'); g.doc.meshes.push({ primitives: [{ attributes: { POSITION: g.pushAccessor(p, 'VEC3', { minMax: true }) }, indices: g.pushAccessor(idx, 'SCALAR') }] }); g.doc.nodes.push({ mesh: 0 }); g.doc.scenes[0].nodes.push(0); return Buffer.from(JSON.stringify(g.finish())).toString('base64'); }
function fixture() { const world = core.defaultWorldRecipe(); world.cellSize = 16; world.voxelSize = 1; world.terrain.base = .23; for (const name of ['continent', 'hills', 'mountains', 'detail'])
    world.terrain[name].amplitude = 0; world.terrain.dunes.amplitude = 0; world.terrain.coast.cliff = 0; world.terrain.overhang.strength = 0; const plan = { version: 1, name: 'test', bounds: { min: [1, -3, 1], max: [14, 8, 14] }, surveyStep: 4, anchor: [4, .23, 4], models: [{ id: 'pedestal', model: 'pedestal.gltf', position: [0, 0, 0] }], routes: [{ id: 'approach', points: [[3, .23, 3], [11, .23, 3]] }], probes: [{ id: 'foot', kind: 'support', points: [[3, .23, 3]], tolerance: .1 }], materials: [{ id: 'stone', modeledJoints: true, textureHasJoints: false, metresPerTexel: .027, targetMetresPerTexel: .027 }], intent: { purpose: 'test', arrival: 'walk', interior: 'outside', landscape: 'flat' } }; return { plan, world, models: { 'pedestal.gltf': cube([4, .23, 9], [6, 1.23, 11]) } }; }
test('actual terrain and capsule pass open ground, block a wall, reject false visual certification', async () => { const b = fixture(), good = await review(b); assert.equal(good.measuredPassed, true, JSON.stringify(good.failures)); assert.equal(good.status, 'needs-visual-review'); assert.equal(good.routes.length, 6); assert.ok(good.survey.every(p => Math.abs(p.height - .23) < .02)); b.plan.models.push({ id: 'wall', model: 'wall.gltf' }); b.models['wall.gltf'] = cube([7, 0, 1], [8, 4, 6]); const bad = await review(b); assert.equal(bad.measuredPassed, false); assert.ok(bad.routes.some(r => !r.passed)); assert.notEqual(good.hashes.plan, bad.hashes.plan); });
test('local floor headroom and material contradiction fail independently', async () => { const b = fixture(); b.plan.models.push({ id: 'roof', model: 'roof.gltf' }); b.models['roof.gltf'] = cube([1, 2.2, 1], [14, 2.7, 6]); b.plan.routes[0].enclosedFrom = 0; b.plan.materials[0].textureHasJoints = true; const r = await review(b); assert.ok(r.clearance.length > 0); assert.ok(r.clearance.every(c => !c.passed)); assert.equal(r.materials[0].passed, false); });
test('manifest validates in engine tool registry', () => { const r = new core.ToolRegistry(); r.register(JSON.parse(fs.readFileSync(new URL('./tool.json', import.meta.url), 'utf8'))); });
test('support excludes the supported object; survey alone cannot certify a site', async () => { const b = fixture(); b.plan.probes = [{ id: 'floating-object', kind: 'support', points: [[5, 1.23, 10]], tolerance: .05, excludeModels: ['pedestal'] }]; const r = await review(b); assert.equal(r.probes[0].passed, false); b.plan.models = []; b.plan.probes = []; b.plan.routes = []; const empty = await review(b); assert.equal(empty.measuredPassed, false); assert.equal(empty.status, 'incomplete'); });
test('terrain route mode proves an outdoor connection without invented structure data', async () => { const b = fixture(); b.plan.kind = 'terrain-route'; b.plan.models = []; b.plan.probes = []; b.plan.materials = []; const r = await review(b); assert.equal(r.measuredPassed, true); assert.equal(r.status, 'needs-visual-review'); assert.equal(r.routes.length, 6); });
test('terrain planner routes around a steep obstacle and refuses an impossible cliff', () => { const input = { start: [0, 0, 0], goal: [32, 0, 0], bounds: [-8, -24, 40, 24], step: 8, heightStep: 4, maxEarthwork: 1, maxGrade: .35 }; const r = findTerrainRoute(input, (x, z) => x >= 12 && x <= 20 && Math.abs(z) < 8 ? 20 : 0); assert.equal(r.found, true); assert.ok(r.length > 32); assert.ok(r.maxGrade <= .35); const bad = findTerrainRoute({ ...input, goal: [32, 20, 0] }, x => x >= 12 ? 20 : 0); assert.equal(bad.found, false); });
test('chain rejects disconnected passes and mixed world versions', () => { const segment = (a, b) => ({ name: 'segment', hashes: { world: 'same', plan: 'plan' }, measuredPassed: true, plannedRoutes: [{ id: 'path', points: [a, b], lanes: [0] }], routes: [{ id: 'path', lane: 0, reverse: false, passed: true }, { id: 'path', lane: 0, reverse: true, passed: true }] }); const a = [0, 0, 0], b = [3, 0, 0], c = [6, 0, 0], reports = [segment(a, b), segment(b, c)], expected = { start: a, end: c }; assert.equal(reviewRouteChain(reports, expected).passed, true); reports[1].hashes.world = 'stale'; assert.equal(reviewRouteChain(reports, expected).passed, false); reports[1].hashes.world = 'same'; reports[1].plannedRoutes[0].points[0] = [4, 0, 0]; assert.equal(reviewRouteChain(reports, expected).passed, false); });
test('terrain planning respects protected architectural footprints', () => { const r = findTerrainRoute({ start: [0, 0, 0], goal: [32, 0, 0], bounds: [-8, -24, 40, 24], avoid: [[10, -8, 22, 8]], step: 8, maxEarthwork: 0 }, () => 0); assert.equal(r.found, true); assert.ok(r.length > 32); for (const p of r.points)
    assert.ok(!(p[0] >= 10 && p[0] <= 22 && p[2] >= -8 && p[2] <= 8)); });
test('separation audit rejects stacked trail legs and permits a flat turn', () => { const p = [[0, 0, 0], [20, 0, 0], [20, 16, 20], [0, 16, 20], [0, 16, 1], [20, 16, 1]]; assert.equal(auditTerrainRouteSeparation(p).passed, false); assert.equal(auditTerrainRouteSeparation(p.map(q => [q[0], 0, q[2]])).passed, true); });
test('registered planner returns the validated result without asset writes', async (t) => { const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hitreg-poi-review-')); t.after(() => { fs.unlinkSync(path.join(runDir, 'route.json')); fs.rmdirSync(runDir); }); const bundle = { world: fixture().world, search: { start: [3, .23, 3], goal: [11, .23, 3], bounds: [0, 0, 16, 16], step: 4, maxEarthwork: 1 } }; const result = await run({ runDir, writeAsset: () => assert.fail('Read-only tool wrote an asset') }, { mode: 'plan-route', bundle: { data: Buffer.from(JSON.stringify(bundle)).toString('base64') } }); assert.equal(result.report.found, true); assert.equal(result.report.usableCandidate, true); assert.equal(result.assets.length, 0); core.toolResultSchema.parse(result); });

test('zero earthwork supports heights between elevation bins',()=>{const r=findTerrainRoute({start:[0,.23,0],goal:[40,.23,0],bounds:[-8,-16,48,16],step:8,maxEarthwork:0},()=>.23);assert.equal(r.found,true);assert.equal(r.usableCandidate,true);assert.ok(r.points.every(p=>p[1]===.23));});

const poiBrief=()=>({version:1,name:'Grove test',tier:'small',smallReference:{name:'Measured small grove',usableAreaM2:1500},site:{anchor:[8,.23,8],bounds:{min:[1,-3,1],max:[14,8,14]},approachOrigin:[3,.23,3],originDescription:'Known playable path',zone:'Test'},intent:{purpose:'Outdoor discovery',discovery:'Concealed spur',pacing:'Between major sites'},features:{grove:true,groundedWebs:true}});
test('POI workflow scales usable area, keeps pinpoints separate and never installs a dungeon by size',()=>{
  for(const [tier,m]of [['small',1],['medium',2],['large',4]]){const r=planPoi({...poiBrief(),tier});assert.equal(r.sizing.targetUsableAreaM2,1500*m);assert.equal(r.sizing.linearMultiplier,Math.sqrt(m));assert.equal(r.request.dungeon.mode,'none');assert.equal(r.status,'planned-not-built');assert.equal(r.stages.some(s=>s.id==='dungeon'),false)}
  const b=poiBrief();delete b.smallReference;b.tier='pinpoint';const r=planPoi(b);assert.equal(r.sizing.targetUsableAreaM2,null);assert.equal(r.sizing.areaMultiplier,null);
});
test('POI requests require measured sizing and explicit instance destination/spatial logic',()=>{
  const b=poiBrief();delete b.smallReference;assert.equal(poiRequestSchema.safeParse(b).success,false);
  assert.equal(poiRequestSchema.safeParse({...poiBrief(),dungeon:{mode:'instance'}}).success,false);
  const r=planPoi({...poiBrief(),features:{building:true},dungeon:{mode:'instance',destination:'test-tomb',spatialLogic:'Down-ramp beneath a deep rock shelf'}});assert.ok(r.stages.some(s=>s.id==='building'));assert.ok(r.stages.some(s=>s.id==='dungeon'));
});
test('every POI plan requires catalog intake before scene installation',()=>{
  for(const brief of [poiBrief(),{...poiBrief(),tier:'pinpoint'}]){
    const stages=planPoi(brief).stages;
    const catalog=stages.findIndex(s=>s.id==='catalog'),build=stages.findIndex(s=>s.id==='build');
    assert.ok(catalog>=0&&catalog<build);
    assert.equal(stages[catalog].guide,'docs/prop-cataloging.md');
    assert.match(stages[catalog].action,/catalog-check\.mjs/);
  }
});
test('generated POI review template cannot certify an unbuilt site',async()=>{
  const p=planPoi(poiBrief());assert.equal(p.reviewPlan.routes.length,0);const r=await review({world:fixture().world,plan:p.reviewPlan,models:{}});assert.equal(r.measuredPassed,false);assert.equal(r.status,'incomplete');
});
test('registered POI planner and CLI library share a read-only work plan',async t=>{
  const runDir=fs.mkdtempSync(path.join(os.tmpdir(),'hitreg-poi-plan-'));t.after(()=>{for(const name of ['workflow.json','review-plan.json'])fs.unlinkSync(path.join(runDir,name));fs.rmdirSync(runDir)});
  const result=await run({runDir,writeAsset:()=>assert.fail('Planner wrote game content')},{mode:'plan-poi',bundle:{data:Buffer.from(JSON.stringify(poiBrief())).toString('base64')}});
  assert.deepEqual(result.report,planPoi(poiBrief()));core.toolResultSchema.parse(result);assert.equal(result.assets.length,0);assert.ok(fs.existsSync(path.join(runDir,'review-plan.json')));
});
