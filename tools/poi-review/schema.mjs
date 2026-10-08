import { z } from './engine.mjs';
const point = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
const box = z.object({ min: point, max: point }).strict().refine(b => b.min.every((v, i) => v < b.max[i]), 'Positive bounds required');
export const reviewSchema = z.object({
    version: z.literal(1), name: z.string().min(1), kind: z.enum(['site', 'terrain-route']).default('site').describe('Terrain-route checks an outdoor connection without requiring constructed models, materials or support probes. It still requires routes and design intent.'),
    bounds: box.describe('World-space survey and collision bounds; include the whole approach and subterranean route, with air above the highest terrain.'),
    surveyStep: z.number().positive().default(2),
    models: z.array(z.object({ id: z.string().min(1), model: z.string().min(1), position: point.default([0, 0, 0]), yaw: z.number().finite().default(0), scale: z.number().positive().default(1), architecture: z.boolean().default(true) }).strict()).default([]),
    routes: z.array(z.object({ id: z.string(), points: z.array(point).min(2), lanes: z.array(z.number().finite()).min(3).default([-.65, 0, .65]), enclosedFrom: z.number().int().nonnegative().optional().describe('Waypoint index where every subsequent segment must have a roof and measured clearance.'), minHeadroom: z.number().positive().default(2.6) }).strict()).default([]),
    probes: z.array(z.object({ id: z.string(), kind: z.enum(['buried', 'air', 'support']), points: z.array(point).min(1), tolerance: z.number().nonnegative().default(.08), excludeModels: z.array(z.string()).default([]).describe('For support rays, exclude the supported object itself using model instance IDs; otherwise its own surface can falsely count as support.') }).strict()).default([]),
    materials: z.array(z.object({ id: z.string(), modeledJoints: z.boolean(), textureHasJoints: z.boolean(), metresPerTexel: z.number().positive(), targetMetresPerTexel: z.number().positive(), relativeTolerance: z.number().nonnegative().default(.2) }).strict()).default([]).describe('Authored surface claims requiring visual confirmation; numeric scale and contradictory joint choices are checked.'),
    neighbours: z.array(z.object({ id: z.string(), position: point, minDistance: z.number().nonnegative() }).strict()).default([]),
    anchor: point,
    player: z.object({ height: z.number().positive().default(1.8), diameter: z.number().positive().default(.7), step: z.number().nonnegative().default(.4), speed: z.number().positive().max(15).default(4) }).strict().default({ height: 1.8, diameter: .7, step: .4, speed: 4 }),
    intent: z.object({ purpose: z.string().min(1), arrival: z.string().min(1), interior: z.string().min(1), landscape: z.string().min(1) }).strict().optional().describe('Explain discovery, destination and terrain integration before building. Aesthetic acceptance still requires a separate visual review.'),
}).strict().superRefine((v, ctx) => { for (const r of v.routes) if (!r.lanes.includes(0) || !r.lanes.some(x=>x<0) || !r.lanes.some(x=>x>0)) ctx.addIssue({code:'custom',message:'Routes require center and both lateral lanes; choose offsets appropriate to the usable width'}); const ids = new Set(); for (const m of v.models) {
    if (ids.has(m.id))
        ctx.addIssue({ code: 'custom', message: 'Duplicate model instance id: ' + m.id });
    ids.add(m.id);
} for (const p of v.probes)
    for (const id of p.excludeModels)
        if (!ids.has(id))
            ctx.addIssue({ code: 'custom', message: 'Unknown excluded model: ' + id }); for (const r of v.routes)
    if (r.enclosedFrom !== undefined && r.enclosedFrom >= r.points.length - 1)
        ctx.addIssue({ code: 'custom', message: 'enclosedFrom must leave a segment to inspect' }); });
