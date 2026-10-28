import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { propReview, propPreview, savePropReview, reviewImage } from '../tools/_prop-review.mts';
import { propPolicy, filterPropIndex } from '../tools/_prop-curation.mts';
import { assertBuilderProps, applyOpsToSceneFile } from '../tools/_scene-write.mts';
import {filterReviewProps} from '../../../packages/editor/src/prop-review-filter.js';
const json = (file: string, data: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
function fixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hitreg-prop-review-'));
    for (const [name, deps] of [['kit', []], ['world', ['kit']]] as const)
        json(path.join(root, name, 'project.json'), { name, dependsOn: deps });
    const prefab = (id: string, child?: string) => ({ version: 1, name: id, root: 'root', entities: { root: { name: id, parent: null, tags: [], components: { transform: {}, dressing: { mount: 'floor', size: [1, 1, 1], category: 'decor', scale: 'human', cultures: ['civic'] } } }, art: { name: 'art', parent: 'root', tags: [], components: child ? { transform: {}, prefab: { prefabId: child } } : { transform: {}, mesh: { source: { kind: 'asset', assetId: 'props/test.gltf' }, material: 'props/wood' } } } } });
    for (const [id, child] of [['props/chair', undefined], ['props/bench', undefined], ['props/group', 'props/chair']] as const)
        json(path.join(root, 'kit/assets/prefabs', id + '.json'), prefab(id, child));
    json(path.join(root, 'kit/authoring/prop-catalogs.json'), { version: 1, catalogs: [{ path: 'authoring/props/catalog.json', entries: 'props', prefabIds: true, shared: true }] });
    json(path.join(root, 'kit/authoring/props/catalog.json'), { props: ['props/chair', 'props/bench', 'props/group'].map(id => ({ id, design: 'Fixture ' + id })) });
    json(path.join(root, 'kit/assets/models/props/test.gltf'), { asset: { version: '2.0' } });
    json(path.join(root, 'kit/assets/materials/props/wood.json'), { map: 'props/wood.png' });
    json(path.join(root, 'kit/assets/textures/props/wood.png'), {});
    json(path.join(root, 'world/assets/scenes/test.scene.json'), { entities: { existing: { components: { prefab: { prefabId: 'props/chair' } } } } });
    return root;
}
function clean(root: string) { const dir = path.resolve(root); assert.equal(path.dirname(dir), path.resolve(os.tmpdir())); assert.ok(path.basename(dir).startsWith('hitreg-prop-review-')); fs.rmSync(dir, { recursive: true, force: true }); }
function choice(root: string, project: string, id: string, use = 'exclude', note = '') { const catalog = propReview(root, project), row = catalog.props.find((p: any) => p.id === id)!; return savePropReview(root, project, { id, use, note, revision: catalog.revision, hash: row.hash }); }

const reviewFilters={query:'',kind:'prop',collection:'',category:'',culture:'',state:'all'};
test('trash removes props from active browsing and builders, preserves shared files and placements, and supports restore',()=>{
    const root=fixture();try{
        const prefab=path.join(root,'kit/assets/prefabs/props/chair.json'),model=path.join(root,'kit/assets/models/props/test.gltf'),scene=path.join(root,'world/assets/scenes/test.scene.json');
        const before=[prefab,model,scene].map(f=>fs.readFileSync(f,'utf8'));
        choice(root,'kit','props/chair','trash','Delete this style');
        const catalog=propReview(root,'world'),chair=catalog.props.find((p:any)=>p.id==='props/chair');
        assert.equal(chair.trashed,true);assert.equal(chair.trashProject,'kit');
        assert.equal(filterReviewProps(catalog.props,reviewFilters).some(p=>p.id==='props/chair'),false);
        assert.deepEqual(filterReviewProps(catalog.props,{...reviewFilters,state:'trash'}).map(p=>p.id),['props/chair']);
        assert.throws(()=>propPolicy(root,'world').assertAllowed('props/group'),/excluded from builders/);
        assert.deepEqual([prefab,model,scene].map(f=>fs.readFileSync(f,'utf8')),before,'deletion must preserve existing references and shared resources');
        choice(root,'world','props/chair','allow');assert.equal(propReview(root,'world').props.find((p:any)=>p.id==='props/chair').trashed,true,'a world cannot restore a dependency trash choice');
        choice(root,'kit','props/chair','allow');assert.equal(propPolicy(root,'world').excluded('props/chair'),null);assert.equal(propReview(root,'kit').props.find((p:any)=>p.id==='props/chair').trashed,false);
        // Even a missing prefab can be removed from the active library and later restored.
        fs.rmSync(prefab);assert.doesNotThrow(()=>choice(root,'kit','props/chair','trash'));
    }finally{clean(root);}
});

test('default review separates structural modules and whole buildings without hiding props built from WFC parts',()=>{
    const root=fixture();try{
        const file=path.join(root,'kit/assets/prefabs/props/chair.json'),chair=JSON.parse(fs.readFileSync(file,'utf8'));
        chair.entities.root.components.dressing={exempt:'structural retaining-wall kit piece: placed by the terrace command'};json(file,chair);
        const benchFile=path.join(root,'kit/assets/prefabs/props/bench.json'),bench=JSON.parse(fs.readFileSync(benchFile,'utf8'));bench.entities.root.components.dressing={category:'building',exempt:'assembled WFC building shell'};json(benchFile,bench);
        const rows=propReview(root,'kit').props;
        assert.equal(rows.find((p:any)=>p.id==='props/chair').kind,'module');assert.equal(rows.find((p:any)=>p.id==='props/bench').kind,'building');
        assert.equal(rows.find((p:any)=>p.id==='props/group').kind,'prop','a standalone assembly remains a prop even if it uses a kit module');
        assert.deepEqual(filterReviewProps(rows,reviewFilters).map(p=>p.id),['props/group']);
        assert.deepEqual(filterReviewProps(rows,{...reviewFilters,kind:'module'}).map(p=>p.id),['props/chair']);
        assert.equal(filterReviewProps(rows,{...reviewFilters,kind:'all'}).length,3);
    }finally{clean(root);}
});
test('owner exclusions persist, hide cached menu entries and sets, and block nested wrappers across world dependencies', () => {
    const root = fixture();
    try {
        const before = fs.readFileSync(path.join(root, 'kit/assets/prefabs/props/chair.json'));
        choice(root, 'kit', 'props/chair', 'exclude', 'Wrong style');
        let policy = propPolicy(root, 'world');
        assert.equal(policy.excluded('props/chair')?.note, 'Wrong style');
        assert.equal(policy.excluded('props/group')?.id, 'props/chair');
        assert.equal(policy.excluded('props/bench'), null);
        const oldIndex = { props: [{ id: 'props/chair' }, { id: 'props/bench' }, { id: 'props/group' }], sets: [{ id: 'set', props: ['props/chair', 'props/bench'] }] };
        assert.deepEqual(filterPropIndex(oldIndex, policy).props, [{ id: 'props/bench' }]);
        assert.equal(filterPropIndex(oldIndex, policy).sets.length, 0);
        choice(root, 'world', 'props/chair', 'allow');
        policy = propPolicy(root, 'world');
        assert.equal(policy.excluded('props/chair')?.project, 'kit', 'a world cannot silently restore an inherited exclusion');
        const rows = propReview(root, 'world').props;
        assert.equal(rows.find((p: any) => p.id === 'props/group').excluded, true);
        assert.equal(rows.length, 3, 'excluded props remain reviewable');
        assert.deepEqual(fs.readFileSync(path.join(root, 'kit/assets/prefabs/props/chair.json')), before);
        choice(root, 'kit', 'props/chair', 'reset');
        assert.equal(propPolicy(root, 'world').excluded('props/chair'), null);
    }
    finally {
        clean(root);
    }
});
test('stale revisions and changed dependencies are rejected before write; exclusions remain after asset regeneration', () => {
    const root = fixture();
    try {
        const old = propReview(root, 'kit'), row = old.props.find((p: any) => p.id === 'props/chair');
        choice(root, 'kit', 'props/bench', 'allow');
        assert.throws(() => savePropReview(root, 'kit', { id: row.id, use: 'exclude', revision: old.revision, hash: row.hash }), (e: any) => e.status === 409);
        const current = propReview(root, 'kit'), group = current.props.find((p: any) => p.id === 'props/group'), preview = propPreview(root, 'kit', group.id);
        assert.equal(preview.hash, group.hash);
        assert.equal(preview.materials['props/wood'].emissive,'#000000','sparse material files must not become white emissive models');
        assert.equal(preview.materials['props/wood'].opacity,1,'the preview bundle includes engine material defaults');
        json(path.join(root, 'kit/assets/models/props/test.gltf'), { asset: { version: '2.0' }, extras: { updated: true } });
        assert.notEqual(propPreview(root, 'kit', group.id).models['props/test.gltf'], preview.models['props/test.gltf'], 'changed model URLs bypass the in-memory renderer cache');
        json(path.join(root, 'kit/assets/materials/props/wood.json'), { map: 'props/wood.png', color: '#ff0000' });
        assert.throws(() => savePropReview(root, 'kit', { id: group.id, use: 'allow', revision: current.revision, hash: group.hash }), (e: any) => e.status === 409);
        choice(root, 'kit', 'props/chair');
        const file = path.join(root, 'kit/assets/prefabs/props/chair.json'), doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        doc.name = 'changed chair';
        json(file, doc);
        const changed = propReview(root, 'kit').props.find((p: any) => p.id === 'props/chair');
        assert.equal(changed.needsReview, true);
        assert.equal(changed.excluded, true);
    }
    finally {
        clean(root);
    }
});
test('scene-writing gate rejects new excluded prefabs before mutation while preserving moves and removals of existing ones', () => {
    const root = fixture();
    try {
        choice(root, 'kit', 'props/chair');
        const file = path.join(root, 'world/assets/scenes/test.scene.json'), before = fs.readFileSync(file);
        const add = { op: 'add-entity', id: 'new', entity: { components: { prefab: { prefabId: 'props/group' } } } };
        assert.throws(() => applyOpsToSceneFile(file, [add], () => { throw Error('must not execute'); }), /excluded from builders/);
        assert.deepEqual(fs.readFileSync(file), before);
        assert.doesNotThrow(() => assertBuilderProps(file, [{ op: 'set-component', id: 'existing', component: 'transform', data: { position: [1, 0, 0] } }, { op: 'remove-entity', id: 'existing' }]));
        assert.throws(() => assertBuilderProps(file, [{ op: 'set-component', id: 'existing', component: 'prefab', data: { prefabId: 'props/chair' } }]), /excluded/);
    }
    finally {
        clean(root);
    }
});
test('review paths, unknown ids and malformed policies fail closed; broken props can still be excluded', () => {
    const root = fixture();
    try {
        assert.throws(() => propReview(root, '../kit'));
        assert.throws(() => reviewImage(root, 'kit', 'authoring/../../project.json'));
        assert.throws(() => reviewImage(root, 'kit', 'assets/models/x.glb'));
        assert.throws(() => savePropReview(root, 'kit', { id: 'unknown', use: 'exclude', revision: 'none', hash: 'a'.repeat(64) }), /Unknown/);
        fs.rmSync(path.join(root, 'kit/assets/models/props/test.gltf'));
        assert.doesNotThrow(() => choice(root, 'kit', 'props/chair'));
        json(path.join(root, 'kit/authoring/prop-curation.json'), { version: 1, props: { 'props/chair': { use: 'typo' } } });
        assert.throws(() => propPolicy(root, 'world'));
    }
    finally {
        clean(root);
    }
});
