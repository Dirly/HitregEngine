const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
export function reviewRouteChain(reports, { start, end, tolerance = .15, currentWorldHash } = {}) {
    const issues = [], segments = [];
    if (!reports.length)
        issues.push('No segment reports');
    const world = currentWorldHash ?? reports[0]?.hashes?.world;
    if (!world)
        issues.push('Missing world identity');
    for (let i = 0; i < reports.length; i++) {
        const r = reports[i];
        if (r.hashes?.world !== world)
            issues.push(`Segment ${i} uses a different world`);
        if (!r.measuredPassed)
            issues.push(`Segment ${i} has not passed measured review`);
        if (r.plannedRoutes?.length !== 1) {
            issues.push(`Segment ${i} must contain one unambiguous route`);
            continue;
        }
        const route = r.plannedRoutes[0], points = route.points;
        if (!Array.isArray(points) || points.length < 2) {
            issues.push(`Segment ${i} has no route endpoints`);
            continue;
        }
        for (const lane of route.lanes)
            for (const reverse of [false, true])
                if (!r.routes?.some(p => p.id === route.id && p.lane === lane && p.reverse === reverse && p.passed))
                    issues.push(`Segment ${i} missing passing lane ${lane}, reverse ${reverse}`);
        segments.push({ index: i, name: r.name, first: points[0], last: points.at(-1), planHash: r.hashes.plan });
        if (segments.length > 1 && distance(segments.at(-2).last, points[0]) > tolerance)
            issues.push(`Gap before segment ${i}`);
    }
    if (!start || !end)
        issues.push('Expected established access start and POI destination are required');
    else if (segments.length) {
        if (distance(start, segments[0].first) > tolerance)
            issues.push('Chain does not begin at expected access point');
        if (distance(end, segments.at(-1).last) > tolerance)
            issues.push('Chain does not reach expected POI destination');
    }
    return { passed: issues.length === 0, issues, worldHash: world, segments, scope: 'Continuous planned endpoints and bidirectional lane passes on one world hash. Requires fresh source reports and visual review; does not certify the supplied access point belongs to the wider playable network.' };
}
