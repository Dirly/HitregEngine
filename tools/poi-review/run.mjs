import fs from 'node:fs/promises';
import path from 'node:path';
import { review, hash } from './review.mjs';
import { surveySvg } from './map.mjs';
import { planTerrainRoute } from './terrain-route.mjs';
import { planPoi } from './poi-plan.mjs';
export async function run(context, inputs) { const bundle = JSON.parse(Buffer.from(inputs.bundle.data, 'base64').toString('utf8')); await fs.mkdir(context.runDir, { recursive: true }); if(inputs.mode==='plan-poi') {
    const result=planPoi(bundle);
    await fs.writeFile(path.join(context.runDir,'workflow.json'),JSON.stringify(result,null,2));
    await fs.writeFile(path.join(context.runDir,'review-plan.json'),JSON.stringify(result.reviewPlan,null,2));
    return {assets:[],previews:[],warnings:[result.scope],report:result,log:'POI work plan and incomplete review template created. Follow the measured stages; nothing installed.'};
} if (inputs.mode === 'plan-route') {
    const result = { ...planTerrainRoute(bundle.world, bundle.search), sourceHashes: { world: hash(bundle.world), search: hash(bundle.search) } };
    await fs.writeFile(path.join(context.runDir, 'route.json'), JSON.stringify(result, null, 2));
    return { assets: [], previews: [], warnings: [result.scope], report: result, log: `Terrain planning ${result.found ? (result.usableCandidate ? 'candidate found' : 'candidate requires separation repair') : 'failed'}; no terrain edited and no reachability certification.` };
} const result = await review(bundle), svg = surveySvg(result); await fs.writeFile(path.join(context.runDir, 'review.json'), JSON.stringify(result, null, 2)); await fs.writeFile(path.join(context.runDir, 'survey.svg'), svg); return { assets: [], previews: [{ label: 'Meshed terrain survey and route', mediaType: 'image/svg+xml', data: Buffer.from(svg).toString('base64') }], warnings: [result.scope.visual, ...result.missing], report: result, log: `${result.status}: ${result.failures.length} measured failures. No scene or terrain changes.` }; }
