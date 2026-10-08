const clamp = x => Math.max(0, Math.min(1, x));
function nearest(a, b, c, d) { const points = []; const project = (p, q, r) => { const dx = r[0] - q[0], dz = r[2] - q[2]; return clamp(((p[0] - q[0]) * dx + (p[2] - q[2]) * dz) / (dx * dx + dz * dz || 1)); }; points.push([0, project(a, c, d)], [1, project(b, c, d)], [project(c, a, b), 0], [project(d, a, b), 1]); const ux = b[0] - a[0], uz = b[2] - a[2], vx = d[0] - c[0], vz = d[2] - c[2], dx = c[0] - a[0], dz = c[2] - a[2], det = ux * vz - uz * vx; if (Math.abs(det) > 1e-10) {
    const t = (dx * vz - dz * vx) / det, s = (dx * uz - dz * ux) / det;
    if (t >= 0 && t <= 1 && s >= 0 && s <= 1)
        points.push([t, s]);
} return points.map(([t, s]) => { const p = a.map((v, i) => v + (b[i] - v) * t), q = c.map((v, i) => v + (d[i] - v) * s); return { p, q, distance: Math.hypot(p[0] - q[0], p[2] - q[2]), heightDifference: Math.abs(p[1] - q[1]) }; }).sort((a, b) => a.distance - b.distance)[0]; }
export function auditTerrainRouteSeparation(points, { trailWidth = 4, voxelSize = 2, maxCrossGrade = .6 } = {}) {
    const threshold = trailWidth + 2 * voxelSize, conflicts = [];
    let count = 0;
    for (let i = 0; i < points.length - 1; i++)
        for (let j = i + 2; j < points.length - 1; j++) {
            const [a, b, c, d] = [points[i], points[i + 1], points[j], points[j + 1]];
            if (Math.max(a[0], b[0]) + threshold < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) + threshold < Math.min(a[0], b[0]) || Math.max(a[2], b[2]) + threshold < Math.min(c[2], d[2]) || Math.max(c[2], d[2]) + threshold < Math.min(a[2], b[2]))
                continue;
            const n = nearest(a, b, c, d);
            if (n.distance < threshold && n.heightDifference > n.distance * maxCrossGrade + .5) {
                count++;
                if (conflicts.length < 100)
                    conflicts.push({ segments: [i, j], ...n });
            }
        }
    return { passed: count === 0, count, conflicts, minimumCorridorSeparation: threshold, scope: 'Conservative nearby-leg grade conflict audit for a single-valued terrain surface. Resolve flagged overlaps or inspect their actual mesh profiles; no bridge/tunnel is inferred.' };
}
