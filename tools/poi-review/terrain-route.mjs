import { core, z } from './engine.mjs';
import { auditTerrainRouteSeparation } from './route-separation.mjs';
const point = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export const routeSearchSchema = z.object({ start: point, goal: point, bounds: z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()]).describe('[minX,minZ,maxX,maxZ]'), step: z.number().min(1).default(8), heightStep: z.number().min(.25).default(4), maxEarthwork: z.number().min(0).max(100).default(10), maxGrade: z.number().positive().max(1).default(.35), earthworkCost: z.number().nonnegative().default(.06), trailWidth: z.number().positive().default(4), voxelSize: z.number().positive().default(2), maxExpanded: z.number().int().positive().max(500000).default(180000), avoid: z.array(z.tuple([z.number().finite(), z.number().finite(), z.number().finite(), z.number().finite()])).default([]).describe('Forbidden XZ rectangles [minX,minZ,maxX,maxZ], padded for trail width and voxel footprint. Include existing foundations and protected POIs; plan to an exterior entry landing.') }).strict();
class Heap {
    q = [];
    push(v) { let i = this.q.length; this.q.push(v); while (i) {
        const p = (i - 1) >> 1;
        if (this.q[p].f <= v.f)
            break;
        this.q[i] = this.q[p];
        i = p;
    } this.q[i] = v; }
    pop() { const r = this.q[0], v = this.q.pop(); if (this.q.length) {
        let i = 0;
        while (i * 2 + 1 < this.q.length) {
            let c = i * 2 + 1;
            if (c + 1 < this.q.length && this.q[c + 1].f < this.q[c].f)
                c++;
            if (this.q[c].f >= v.f)
                break;
            this.q[i] = this.q[c];
            i = c;
        }
        this.q[i] = v;
    } return r; }
}
// Search elevation as well as horizontal position, so a modest cut or fill can
// connect a contour trail. This proposes edits; collision proof comes afterward.
export function findTerrainRoute(input, height) {
    const c = routeSearchSchema.parse(input), [x0, z0, x1, z1] = c.bounds, nx = Math.floor((x1 - x0) / c.step) + 1, nz = Math.floor((z1 - z0) / c.step) + 1;
    if (nx < 2 || nz < 2 || nx * nz > 100000)
        throw Error('Search grid must contain 4..100000 nodes');
    for (const p of [c.start, c.goal])
        if (p[0] < x0 || p[0] > x1 || p[2] < z0 || p[2] > z1)
            throw Error('Endpoint outside search bounds');
    const forbidden = (x, z) => c.avoid.some(b => x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]);
    if (forbidden(c.start[0], c.start[2]) || forbidden(c.goal[0], c.goal[2]))
        throw Error('Route endpoint is inside a forbidden footprint');
    const hs = new Map(), h = (x, z) => { const key = x.toFixed(3) + ',' + z.toFixed(3); if (!hs.has(key))
        hs.set(key, height(x, z)); return hs.get(key); };
    const snap = p => [Math.round((p[0] - x0) / c.step), Math.round((p[2] - z0) / c.step)], startCell = snap(c.start), goalCell = snap(c.goal), key = (i, j, y) => `${i},${j},${y}`;
    const open = new Heap(), states = new Map(), closed = new Set(), dist = new Map();
    const heuristic = p => Math.max(Math.hypot(p[0] - c.goal[0], p[2] - c.goal[2]), Math.abs(p[1] - c.goal[1]) / c.maxGrade);
    const initial = { i: startCell[0], j: startCell[1], p: c.start, id: 'start', g: 0, parent: null };
    states.set(initial.id, initial);
    dist.set(initial.id, 0);
    open.push({ ...initial, f: heuristic(initial.p) });
    const dirs = [];
    for (let i = -3; i <= 3; i++)
        for (let j = -3; j <= 3; j++)
            if ((i || j) && Math.max(Math.abs(i), Math.abs(j)) <= 3 && gcd(Math.abs(i), Math.abs(j)) === 1)
                dirs.push([i, j]);
    let expanded = 0, last = null;
    while (open.q.length && expanded < c.maxExpanded) {
        const u = open.pop();
        if (closed.has(u.id) || u.g !== dist.get(u.id))
            continue;
        closed.add(u.id);
        expanded++;
        if (u.id === 'goal') {
            last = u;
            break;
        }
        const choices = dirs.map(([di, dj]) => [u.i + di, u.j + dj]);
        if (Math.abs(u.i - goalCell[0]) <= 3 && Math.abs(u.j - goalCell[1]) <= 3)
            choices.unshift(goalCell);
        for (const [i, j] of choices) {
            if (i < 0 || j < 0 || i >= nx || j >= nz)
                continue;
            const goal = i === goalCell[0] && j === goalCell[1], x = goal ? c.goal[0] : x0 + i * c.step, z = goal ? c.goal[2] : z0 + j * c.step, ground = h(x, z);
            if (!Number.isFinite(ground))
                continue;
            const length = Math.hypot(x - u.p[0], z - u.p[2]);
            if (length < .01 || c.avoid.some(rect => segmentRectangle(u.p[0], u.p[2], x, z, rect)))
                continue;
            const low = Math.ceil((ground - c.maxEarthwork) / c.heightStep), high = Math.floor((ground + c.maxEarthwork) / c.heightStep), levels = goal ? [c.goal[1]] : Array.from({ length: high - low + 1 }, (_, n) => (low + n) * c.heightStep);
            if (!goal && !levels.includes(ground)) levels.push(ground);
            for (const y of levels) {
                const grade = Math.abs(y - u.p[1]) / length;
                if (grade > c.maxGrade + 1e-8)
                    continue;
                const id = goal ? 'goal' : key(i, j, y);
                if (closed.has(id))
                    continue;
                let maxCut = 0, sumCut = 0, allowed = true;
                const samples = Math.max(2, Math.ceil(length / (c.step / 2)));
                for (let t = 0; t <= samples; t++) {
                    const f = t / samples, yy = u.p[1] + (y - u.p[1]) * f, xx = u.p[0] + (x - u.p[0]) * f, zz = u.p[2] + (z - u.p[2]) * f, cut = Math.abs(yy - h(xx, zz));
                    if (forbidden(xx, zz) || !Number.isFinite(cut) || cut > c.maxEarthwork + .01) {
                        allowed = false;
                        break;
                    }
                    sumCut += cut;
                    maxCut = Math.max(maxCut, cut);
                }
                if (!allowed)
                    continue;
                const g = u.g + Math.hypot(length, y - u.p[1]) * (1 + sumCut / (samples + 1) * c.earthworkCost + grade * grade * .4);
                if (g >= (dist.get(id) ?? Infinity))
                    continue;
                const v = { i, j, p: [x, y, z], id, g, parent: u.id, maxCut };
                dist.set(id, g);
                states.set(id, v);
                open.push({ ...v, f: g + heuristic(v.p) });
            }
        }
    }
    if (!last)
        return { found: false, expanded, samples: hs.size, reason: expanded >= c.maxExpanded ? 'Search budget exhausted' : 'No path within grade and earthwork limits', scope: 'Planning from supplied heights only; no terrain changed and no collision certification.' };
    const nodes = [];
    for (let n = last; n; n = states.get(n.parent))
        nodes.push(n);
    nodes.reverse();
    const points = nodes.map(n => n.p), length = points.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - points[i][0], p[2] - points[i][2]), 0);
    const separation = auditTerrainRouteSeparation(points, c);
    return { found: true, usableCandidate: separation.passed, separation, points, length, expanded, samples: hs.size, maxGrade: Math.max(...points.slice(1).map((p, i) => Math.abs(p[1] - points[i][1]) / Math.hypot(p[0] - points[i][0], p[2] - points[i][2]))), maxEarthwork: Math.max(...nodes.map(n => n.maxCut ?? 0)), scope: 'Heightfield planning candidate with sampled cut/fill allowance. Smooth curves, inspect corridor shoulders and grade, apply recipe edits, then prove final actual-mesh routes before acceptance.' };
}
function gcd(a, b) { while (b)
    [a, b] = [b, a % b]; return a; }
export function planTerrainRoute(world, input) { const field = core.createWorldField(core.worldRecipeSchema.parse(world)); return findTerrainRoute({ voxelSize: world.voxelSize, ...input }, (x, z) => field.height(x, z)); }
function segmentRectangle(x, z, xx, zz, b) { let lo = 0, hi = 1; for (const [a, d, min, max] of [[x, xx - x, b[0], b[2]], [z, zz - z, b[1], b[3]]]) {
    if (Math.abs(d) < 1e-12) {
        if (a < min || a > max)
            return false;
        continue;
    }
    let t0 = (min - a) / d, t1 = (max - a) / d;
    if (t0 > t1)
        [t0, t1] = [t1, t0];
    lo = Math.max(lo, t0);
    hi = Math.min(hi, t1);
    if (lo > hi)
        return false;
} return true; }
