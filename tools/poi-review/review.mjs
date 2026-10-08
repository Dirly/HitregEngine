import crypto from 'node:crypto';
import { core, physics } from './engine.mjs';
import { reviewSchema } from './schema.mjs';
import { coplanarOverlaps } from './geometry.mjs';
export const hash = v => crypto.createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : JSON.stringify(v)).digest('hex');
export async function review(bundle) {
    const plan = reviewSchema.parse(bundle.plan), world = core.worldRecipeSchema.parse(bundle.world), b = plan.bounds;
    const inBounds = p => p.every((v, i) => v >= b.min[i] && v <= b.max[i]);
    for (const r of plan.routes)
        for (const p of r.points)
            if (!inBounds(p))
                throw Error('Route outside survey bounds: ' + r.id);
    for (const p of plan.probes)
        for (const q of p.points)
            if (!inBounds(q))
                throw Error('Probe outside survey bounds: ' + p.id);
    const count = Math.ceil((b.max[0] - b.min[0]) / plan.surveyStep + 1) * Math.ceil((b.max[2] - b.min[2]) / plan.surveyStep + 1);
    if (count > 40000)
        throw Error('Survey exceeds 40000 columns; use larger surveyStep or smaller bounds');
    const densityCells = b.min.reduce((n, v, i) => n * (Math.ceil((b.max[i] - v) / world.voxelSize) + 3), 1);
    if (densityCells > 10000000)
        throw Error('Survey density box exceeds 10M samples; split the site');
    const cx0 = Math.floor(b.min[0] / world.cellSize), cx1 = Math.floor(b.max[0] / world.cellSize), cz0 = Math.floor(b.min[2] / world.cellSize), cz1 = Math.floor(b.max[2] / world.cellSize);
    if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > 64)
        throw Error('Review exceeds 64 terrain chunks; split the site');
    const worldId = 'poi-review-' + hash(bundle.world).slice(0, 16);
    core.registerVoxelWorld(worldId, world);
    const field = core.createWorldField(world), density = core.meshDensity(field, { x0: b.min[0], y0: b.min[1], z0: b.min[2], x1: b.max[0], y1: b.max[1], z1: b.max[2] });
    const geos = new Map(), ops = [], architecture = [], hashes = { world: hash(bundle.world), plan: hash(plan), models: {} };
    const add = (id, geo, transform) => { geos.set(id, geo); ops.push({ op: 'add-entity', id, entity: { name: id, parent: null, tags: [], components: { transform, mesh: { source: { kind: 'asset', assetId: id } }, collider: { shape: 'trimesh' } } } }); };
    for (let x = cx0; x <= cx1; x++)
        for (let z = cz0; z <= cz1; z++)
            add(`terrain:${x}:${z}`, core.voxelMesh({ kind: 'voxel', world: worldId, cell: [x, z] }), { position: [x * world.cellSize, 0, z * world.cellSize] });
    const terrainIds = ops.map(o => o.id), modelIds = [];
    for (const m of plan.models) {
        if (!bundle.models?.[m.model])
            throw Error('Missing bundled model ' + m.model);
        const bytes = Buffer.from(bundle.models[m.model], 'base64');
        hashes.models[m.model] = hash(bytes);
        const geo = physics.gltfCollisionGeometry(bytes);
        if (!geo?.positions.length || !geo.indices.length)
            throw Error('Empty model ' + m.model);
        const id = 'model:' + m.id;
        modelIds.push(id);
        add(id, geo, { position: m.position, rotation: [0, Math.sin(m.yaw / 2), 0, Math.cos(m.yaw / 2)], scale: [m.scale, m.scale, m.scale] });
        if (m.architecture)
            architecture.push({ id: m.id, geometry: geo, placement: m });
    }
    const player = plan.player, feetOffset = player.height / 2 + .02;
    ops.push({ op: 'add-entity', id: 'review-player', entity: { name: 'Review capsule', parent: null, tags: [], components: { transform: { position: [b.min[0], b.max[1] + 10, b.min[2]] }, rigidbody: { kind: 'kinematic' }, collider: { shape: 'capsule', size: [player.diameter, player.height, player.diameter] } } } });
    const registry = new core.ComponentRegistry();
    core.registerCoreComponents(registry);
    const doc = core.applyOps(core.createScene('POI read-only review'), ops, registry).doc;
    await physics.initPhysics();
    const sim = new physics.PhysicsSim(doc, [0, -9.81, 0], { meshGeometry: id => geos.get(id) });
    sim.configureCharacter('review-player', { offset: .02, autostep: { maxHeight: player.step, minWidth: .2, includeDynamicBodies: false }, snapToGround: player.step });
    sim.step(1 / 60);
    const ray = (p, d, max, exclude = []) => sim.raycast(p, d, max, { exclude: ['review-player', ...exclude], solid: false });
    try {
        const survey = [];
        for (let x = b.min[0]; x <= b.max[0] + 1e-6; x += plan.surveyStep)
            for (let z = b.min[2]; z <= b.max[2] + 1e-6; z += plan.surveyStep) {
                const hit = ray([x, b.max[1], z], [0, -1, 0], b.max[1] - b.min[1], modelIds);
                survey.push({ x, z, height: hit?.point[1] ?? null, heightfield: field.height(x, z), normal: hit?.normal ?? null, slopeDegrees: hit ? Math.acos(Math.min(1, Math.max(-1, hit.normal[1]))) * 180 / Math.PI : null, startsInSolid: density.solid(x, b.max[1], z) });
            }
        const routes = [];
        const clearance = [];
        for (const route of plan.routes) {
            // Cross-section probes along every enclosed segment use the local floor, never datum.
            for (let i = route.enclosedFrom ?? route.points.length; i < route.points.length - 1; i++) {
                const a = route.points[i], c = route.points[i + 1], length = Math.hypot(c[0] - a[0], c[2] - a[2]);
                for (let t = 0; t <= Math.ceil(length); t++) {
                    const f = t / Math.max(1, Math.ceil(length));
                    for (const lane of route.lanes) {
                        const p = a.map((v, k) => v + (c[k] - v) * f);
                        p[0] += (c[2] - a[2]) / Math.max(length, .001) * lane;
                        p[2] -= (c[0] - a[0]) / Math.max(length, .001) * lane;
                        const o = [p[0], p[1] + Math.min(.5, player.height / 2), p[2]], floor = ray(o, [0, -1, 0], 2), roof = ray(o, [0, 1, 0], 30), height = floor && roof ? roof.point[1] - floor.point[1] : null;
                        clearance.push({ route: route.id, point: p, height, passed: height !== null && height >= route.minHeadroom });
                    }
                }
            }
            for (const lane of route.lanes)
                for (const reverse of [false, true]) {
                    const points = route.points.map((p, i) => { const a = route.points[Math.max(0, i - 1)], c = route.points[Math.min(route.points.length - 1, i + 1)], len = Math.hypot(c[0] - a[0], c[2] - a[2]); return [p[0] + (c[2] - a[2]) / Math.max(len, .001) * lane, p[1], p[2] - (c[0] - a[0]) / Math.max(len, .001) * lane]; });
                    if (reverse)
                        points.reverse();
                    sim.setPosition('review-player', [points[0][0], points[0][1] + feetOffset + .08, points[0][2]]);
                    sim.step(1 / 60);
                    let velocity = 0, grounded = false, frames = 0, failure = null;
                    for (const target of points.slice(1)) {
                        let reached = false;
                        const current = sim.states().get('review-player').position;
                        const maxFrames = Math.min(18000, Math.ceil(Math.hypot(target[0] - current[0], target[2] - current[2]) / player.speed * 180) + 300);
                        for (let k = 0; k < maxFrames; k++) {
                            const p = sim.states().get('review-player').position, dx = target[0] - p[0], dz = target[2] - p[2], distance = Math.hypot(dx, dz);
                            if (distance < .16) {
                                reached = Math.abs(p[1] - target[1] - feetOffset) < .55;
                                break;
                            }
                            if (p[1] < b.min[1] - 2)
                                break;
                            velocity = grounded ? -.6 : Math.max(velocity - 9.81 / 60, -25);
                            const result = sim.moveCharacter('review-player', [dx / distance * Math.min(player.speed / 60, distance), velocity / 60, dz / distance * Math.min(player.speed / 60, distance)]);
                            grounded = result.grounded;
                            if (velocity < 0 && result.translation[1] > velocity / 60 + .001)
                                velocity = Math.max(-.6, result.translation[1] * 60);
                            sim.step(1 / 60);
                            frames++;
                        }
                        if (!reached) {
                            failure = { target, actual: [...sim.states().get('review-player').position] };
                            break;
                        }
                    }
                    routes.push({ id: route.id, lane, reverse, passed: !failure, frames, failure });
                }
        }
        const probes = plan.probes.flatMap(probe => probe.points.map(p => { if (probe.kind === 'support') {
            const hit = ray([p[0], p[1] + probe.tolerance + .01, p[2]], [0, -1, 0], probe.tolerance * 2 + .02, probe.excludeModels.map(id => 'model:' + id));
            const gap = hit ? p[1] - hit.point[1] : null;
            return { id: probe.id, kind: probe.kind, point: p, gap, passed: gap !== null && Math.abs(gap) <= probe.tolerance };
        } const solid = density.solid(...p); return { id: probe.id, kind: probe.kind, point: p, solid, passed: probe.kind === 'buried' ? solid : !solid }; }));
        const overlaps = coplanarOverlaps(architecture, { buried: p => inBounds(p) && density.solid(...p) });
        const materials = plan.materials.map(m => ({ ...m, passed: !(m.modeledJoints && m.textureHasJoints) && Math.abs(m.metresPerTexel / m.targetMetresPerTexel - 1) <= m.relativeTolerance }));
        const spacing = plan.neighbours.map(n => { const distance = Math.hypot(n.position[0] - plan.anchor[0], n.position[2] - plan.anchor[2]); return { ...n, distance, passed: distance >= n.minDistance }; });
        const failures = [...routes, ...clearance, ...probes, ...materials, ...spacing].filter(r => !r.passed);
        if (!overlaps.passed)
            failures.push({ id: 'assembly-overlap', ...overlaps });
        const missing = [];
        if (!plan.routes.length)
            missing.push('No reachability route');
        if (plan.kind === 'site' && !plan.probes.some(p => p.kind === 'support'))
            missing.push('No support probes');
        if (!plan.intent)
            missing.push('No design intent');
        if (plan.kind === 'site' && !plan.materials.length)
            missing.push('No material scale/joint declarations');
        if (plan.kind === 'site' && !plan.models.length)
            missing.push('Survey only: no structure supplied');
        if (survey.some(p => p.startsInSolid))
            missing.push('Survey ceiling intersects terrain; raise bounds.max[1]');
        if (survey.some(p => p.height === null))
            missing.push('Terrain surface missing in some survey columns; inspect bounds or voids');
        return { version: 1, name: plan.name, hashes, measuredPassed: failures.length === 0 && missing.length === 0, status: failures.length ? 'fail' : missing.length ? 'incomplete' : 'needs-visual-review', missing, failures, bounds: b, surveyStep: plan.surveyStep, plannedRoutes: plan.routes, survey, routes, clearance, probes, overlaps, materials, spacing, intent: plan.intent, scope: { terrain: 'Actual voxelMesh collision triangles; heightfield included only for comparison. Burial uses meshed density parity.', routes: 'Sampled requested lanes in both directions with engine kinematic capsule; does not prove all possible paths.', visual: 'Required separately: approach composition, believable interior destination, landscape blend, organic distortion, texture appearance, road discovery and actual portal behavior.', source: 'Report applies only to these exact world, manifest and model hashes. Supplied model list must cover every relevant collider; CLI/host do not infer scene membership.' } };
    }
    finally {
        sim.free();
    }
}
