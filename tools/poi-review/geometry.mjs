export function transform(p, m) { const c = Math.cos(m.yaw), s = Math.sin(m.yaw), k = m.scale; return [m.position[0] + k * (c * p[0] + s * p[2]), m.position[1] + k * p[1], m.position[2] + k * (-s * p[0] + c * p[2])]; }
const sub = (a, b) => a.map((v, i) => v - b[i]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);
const cross2 = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
export function intersectionArea(a, b) { let poly = a; const sign = Math.sign(cross2(...b)); for (let i = 0; i < 3 && poly.length; i++) {
    const u = b[i], v = b[(i + 1) % 3], next = [];
    for (let j = 0; j < poly.length; j++) {
        const p = poly[j], q = poly[(j + 1) % poly.length], dp = sign * cross2(u, v, p), dq = sign * cross2(u, v, q);
        if (dp >= -1e-10)
            next.push(p);
        if ((dp > 0 && dq < 0) || (dp < 0 && dq > 0)) {
            const t = dp / (dp - dq);
            next.push(p.map((x, k) => x + t * (q[k] - x)));
        }
    }
    poly = next;
} return Math.abs(poly.reduce((s, p, i) => s + p[0] * poly[(i + 1) % poly.length][1] - p[1] * poly[(i + 1) % poly.length][0], 0)) / 2; }
// Exact-plane overlap candidates, independent of triangle tessellation. This is
// deliberately not advertised as a general self-intersection or visibility test.
export function coplanarOverlaps(instances, { buried = () => false, limit = 2000000 } = {}) {
    const planes = new Map();
    let comparisons = 0;
    const hits = [];
    for (const { id, geometry, placement } of instances) {
        const pos = geometry.positions, idx = geometry.indices;
        for (let i = 0; i < idx.length; i += 3) {
            const tri = Array.from(idx.slice(i, i + 3), j => transform(Array.from(pos.slice(j * 3, j * 3 + 3)), placement));
            let n = cross(sub(tri[1], tri[0]), sub(tri[2], tri[0])), len = Math.hypot(...n);
            if (len < 1e-10)
                continue;
            n = n.map(x => x / len);
            const axis = n.map(Math.abs).indexOf(Math.max(...n.map(Math.abs)));
            if (n[axis] < 0)
                n = n.map(x => -x);
            const d = dot(n, tri[0]), key = [...n, d].map(x => Math.round(x * 1e4)).join(',');
            const axes = [0, 1, 2].filter(x => x !== axis), p = tri.map(v => axes.map(x => v[x]));
            const item = { id, tri, n, d, p, min: Math.min(...p.map(v => v[0])), max: Math.max(...p.map(v => v[0])), lo: Math.min(...p.map(v => v[1])), hi: Math.max(...p.map(v => v[1])) };
            if (!planes.has(key))
                planes.set(key, []);
            planes.get(key).push(item);
        }
    }
    for (const list of planes.values()) {
        list.sort((a, b) => a.min - b.min);
        for (let i = 0; i < list.length; i++)
            for (let j = i + 1; j < list.length && list[j].min < list[i].max - 1e-7; j++) {
                const a = list[i], b = list[j];
                if (a.id === b.id || b.lo >= a.hi || a.lo >= b.hi)
                    continue;
                if (++comparisons > limit)
                    return { passed: false, incomplete: true, comparisons, hits, reason: 'Overlap comparison budget exceeded; partition the review spatially' };
                if (a.tri.some(p => Math.abs(dot(b.n, p) - b.d) > .0002))
                    continue;
                const area = intersectionArea(a.p, b.p);
                if (area < 1e-6)
                    continue;
                const insideTerrain = [...a.tri, ...b.tri].every(buried);
                if (!insideTerrain && hits.length < 100)
                    hits.push({ a: a.id, b: b.id, projectedArea: area, point: a.tri[0] });
            }
    }
    return { passed: hits.length === 0, incomplete: false, comparisons, hits, scope: 'Coplanar triangle intersections between architectural instances; terrain-buried pairs excluded. Does not prove general intersections, near-coplanar depth precision or visual quality.' };
}
