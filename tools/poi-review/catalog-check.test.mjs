import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkCatalog } from './catalog-check.mjs';

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir()), project = fs.mkdtempSync(path.join(parent, 'hitreg-catalog-'));
  t.after(() => {
    const resolved = fs.realpathSync(project);
    assert.equal(path.dirname(resolved).toLowerCase(), parent.toLowerCase());
    assert.ok(path.basename(resolved).startsWith('hitreg-catalog-'));
    fs.rmSync(resolved, { recursive: true });
  });
  const write = (file, data) => { const target = path.join(project, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, JSON.stringify(data)); };
  write('authoring/prop-catalogs.json', { version: 1, catalogs: [{ path: 'authoring/props.json', entries: 'props', prefabIds: true, dressing: 'authoring/dressing.json' }, { path: 'authoring/models.json', entries: 'assets', pathFields: ['modelPath'] }] });
  write('authoring/props.json', { props: [{ id: 'brazier', fire: 'brazier' }] });
  write('authoring/models.json', { assets: [{ id: 'bowl', modelPath: 'assets/models/bowl.gltf' }] });
  write('assets/models/bowl.gltf', {});
  write('assets/materials/fx/ember-bed.json', {});
  write('assets/vfx/env/fire-brazier.json', {});
  const declaration = { mount: 'floor', size: [0.9, 0.7, 0.8], against: 'free', fire: true };
  write('authoring/dressing.json', { version: 1, props: { brazier: declaration } });
  const prefab = { root: 'root', entities: { root: { parent: null, components: { dressing: { ...declaration, clearance: 0, provides: [] } } }, bowl: { components: { mesh: { source: { kind: 'asset', assetId: 'bowl.gltf' }, material: 'fx/ember-bed' } } }, fire: { components: { vfx: { effect: 'env/fire-brazier' } } } } };
  write('assets/prefabs/brazier.json', prefab);
  return { project, write, prefab, declaration, check: assets => checkCatalog({ project, assets }) };
}

test('catalogued prefab retains dependency and fire evidence', t => {
  const f = fixture(t), r = f.check(['assets/prefabs/brazier.json']);
  assert.equal(r.passed, true); assert.deepEqual(r.results[0].effects, ['env/fire-brazier']);
  assert.equal(r.results[0].dependencies.length, 3);
});
test('uncatalogued and missing outputs fail', t => {
  const f = fixture(t); f.write('assets/models/unlisted.gltf', {});
  const r = f.check(['assets/models/unlisted.gltf', 'assets/models/missing.gltf']);
  assert.equal(r.passed, false); assert.match(r.failures.join('\n'), /No entry/); assert.match(r.failures.join('\n'), /Runtime file is missing/);
});
test('removing declared fire from otherwise valid prefab fails', t => {
  const f = fixture(t); delete f.prefab.entities.fire; f.write('assets/prefabs/brazier.json', f.prefab);
  assert.match(f.check(['assets/prefabs/brazier.json']).failures.join('\n'), /effect absent/);
});
test('nested prefab dependency failure is reported and cycles terminate', t => {
  const f = fixture(t); f.prefab.entities.nested = { components: { prefab: { prefabId: 'child' } } };
  f.write('assets/prefabs/brazier.json', f.prefab);
  f.write('assets/prefabs/child.json', { entities: { loop: { components: { prefab: { prefabId: 'brazier' } } }, broken: { components: { mesh: { source: { kind: 'asset', assetId: 'absent.glb' } } } } } });
  assert.match(f.check(['assets/prefabs/brazier.json']).failures.join('\n'), /Missing dependency: assets\/models\/absent.glb/);
});
test('changed output bytes invalidate recorded hash', t => {
  const f = fixture(t); f.write('authoring/models.json', { assets: [{ modelPath: 'assets/models/bowl.gltf', sha256: '0'.repeat(64) }] });
  assert.match(f.check(['assets/models/bowl.gltf']).failures.join('\n'), /Stale asset hash/);
});
test('empty selection, outside paths and broken index fail closed', t => {
  const f = fixture(t);
  assert.throws(() => f.check([]), /at least one/);
  assert.throws(() => f.check(['../outside.glb']), /leaves project/);
  f.write('authoring/prop-catalogs.json', { version: 1, catalogs: [{ path: 'authoring/props.json', entries: 'typo', prefabIds: true }] });
  assert.throws(() => f.check(['assets/prefabs/brazier.json']), /Missing array/);
});

test('catalogued prefab without a dressing declaration or exemption fails', t => {
  const f = fixture(t); f.write('authoring/dressing.json', { version: 1, props: {} });
  const r = f.check(['assets/prefabs/brazier.json']);
  assert.equal(r.passed, false); assert.match(r.failures.join('\n'), /No dressing declaration or exemption/);
  assert.equal(r.results[0].dressing.status, 'missing');
});
test('sidecar and collection exemptions pass; an exempt prefab must not carry a declaration', t => {
  const f = fixture(t); delete f.prefab.entities.root.components.dressing; f.write('assets/prefabs/brazier.json', f.prefab);
  f.write('authoring/dressing.json', { version: 1, props: { brazier: { exempt: 'scatter only' } } });
  assert.equal(f.check(['assets/prefabs/brazier.json']).results[0].dressing.status, 'exempt');
  f.write('authoring/prop-catalogs.json', { version: 1, catalogs: [{ path: 'authoring/props.json', entries: 'props', prefabIds: true, dressingExempt: 'building shells' }] });
  const r = f.check(['assets/prefabs/brazier.json']);
  assert.equal(r.passed, true); assert.equal(r.results[0].dressing.reason, 'building shells');
  f.prefab.entities.root.components.dressing = f.declaration; f.write('assets/prefabs/brazier.json', f.prefab);
  assert.match(f.check(['assets/prefabs/brazier.json']).failures.join('\n'), /still carries a dressing component/);
});
test('declaration not compiled onto the prefab, or out of date, fails', t => {
  const f = fixture(t); delete f.prefab.entities.root.components.dressing; f.write('assets/prefabs/brazier.json', f.prefab);
  assert.match(f.check(['assets/prefabs/brazier.json']).failures.join('\n'), /no dressing component; run props sync/);
  f.write('authoring/dressing.json', { version: 1, props: { brazier: { ...f.declaration, against: 'wall' } } });
  f.prefab.entities.root.components.dressing = f.declaration; f.write('assets/prefabs/brazier.json', f.prefab);
  assert.match(f.check(['assets/prefabs/brazier.json']).failures.join('\n'), /differs from authoring\/dressing.json/);
});
test('structurally invalid declarations fail', t => {
  const f = fixture(t);
  f.write('authoring/dressing.json', { version: 1, props: { brazier: { mount: 'slot', size: [0.9, 0, 0.8], provides: [{ id: 'bay', kind: 'slot' }] } } });
  const failures = f.check(['assets/prefabs/brazier.json']).failures.join('\n');
  assert.match(failures, /three positive metres/); assert.match(failures, /must name its slotKind/); assert.match(failures, /accepts nothing/);
});
