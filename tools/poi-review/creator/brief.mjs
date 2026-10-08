import { createRequire } from 'node:module';
const { z } = createRequire(new URL('../../../packages/core/package.json', import.meta.url))('zod');
export { z };
const text = z.string().trim().min(1);
export const creatorBriefSchema = z.object({
  version: z.literal(1),
  id: text.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).describe('Stable POI job slug, inferred from its name when needed.'),
  name: text,
  project: text.regex(/^[a-zA-Z0-9_-]+$/).describe('Active HitReg project folder name; infer from session context.'),
  adventureSize: z.enum(['pinpoint', 'small', 'medium', 'large']).describe('Size of the complete requested player experience, including described interiors; never silently replace it with an entrance-only scope. Physical targets use the chosen measured small reference.'),
  hostility: z.enum(['non-hostile', 'hostile', 'mixed']).describe('Non-hostile: safe activities/discovery. Hostile: appropriate adversaries and retreats. Mixed: explicitly mapped safe-to-hostile transition.'),
  description: text.describe('What the place is, why it exists, its atmosphere and what the player should experience. Resolve unclear core intent before building.'),
  location: z.object({
    hint: text.describe('Human location description or survey instruction; exact coordinates may be resolved from current focus and map.'),
    anchor: z.array(z.number().finite()).length(3).optional().describe('Optional known engine X/Y/Z point in metres; validate against rendered terrain.'),
  }).strict(),
  requirements: z.array(text).default([]).describe('Specific requested destinations, activities, enemies, NPCs, rewards or mechanics. Required behavior must work before completion.'),
  constraints: z.array(text).default([]).describe('User limits and protected content, e.g. safe roads, existing scale, terrain or material choices. Retain verbatim intent.'),
  mode: z.enum(['plan', 'build']).default('plan').describe('Requested work stage, not authorization. Plan produces a surveyed design only; build owns the complete authorized POI through review. Honour current user stop/freeze instructions.'),
}).strict();

export function prepareCreatorJob(input) {
  const brief = creatorBriefSchema.parse(input);
  const prompt = [
    `Own the complete POI ${brief.name} (${brief.id}) in project ${brief.project}.`,
    'Read tools/poi-review/creator/SKILL.md in the active Engine checkout, then brief.json in this job directory.',
    `Requested adventure: ${brief.adventureSize}; hostility: ${brief.hostility}; work mode: ${brief.mode}.`,
    `Description: ${brief.description}`,
    `Location: ${brief.location.hint}${brief.location.anchor ? ' at engine X/Y/Z ' + brief.location.anchor.join(', ') : ''}.`,
    ...brief.requirements.map(r => `Required: ${r}`),
    ...brief.constraints.map(r => `Constraint: ${r}`),
    'You are the single author of this POI: survey, terrain, structures, gameplay, dressing, integration, evidence and repairs. Do not spawn other authors or hand this POI to separate terrain/dungeon/dressing builders.',
    'The coordinator reviews and serializes installation; return corrections to this owner. A job mode cannot override user authorization or a stopped/frozen world.',
    brief.mode === 'plan' ? 'Plan only: survey and design; do not create a blockout, mutate game assets/terrain/gameplay or install anything.' : 'Build the complete authorized experience in a private preview. Submit the full blockout early; do not finish with only an entrance, a cleared pad or proposed gameplay.',
    'Record owner identity and truthful progress in progress.json, followed by the skill handoff with current evidence. A prepared brief is not a built or reviewed POI.',
    'Gates (tools/poi-review/job.mjs, enforced): declare viewpoints[] { id, at, look } in progress.json before the blockout; the stage moves past blockout only with evidence.readShot { file, viewpoint } from a declared viewpoint (job.mjs stage). Record every fix attempt with job.mjs fix; a third is refused without the coordinator.',
    'Your install.mts calls requireFinalReview(<this job directory>) from tools/poi-review/job.mjs before it writes anything: it installs only after a fresh reviewer writes Verdict: PASS with the ops hash (job.mjs hash) and job.mjs review records it; --force-dogfood belongs to the coordinator alone.',
  ].join('\n') + '\n';
  return {
    brief, prompt,
    progress: { version: 1, poiId: brief.id, ownerAgentId: null, stage: 'briefed', mode: brief.mode, scope: 'Intake prepared only; no agent started, game changes or acceptance.', problems: [], evidence: {}, viewpoints: [], fixes: [], finalReview: null, timing: { setupSeconds: null, constructionSeconds: null, verificationSeconds: null } },
    handoff: {
      version: 1, poiId: brief.id, ownerAgentId: null, stage: 'briefed', briefPath: 'brief.json', readyForInstall: false,
      measurements: { adventureSize: brief.adventureSize, smallReference: null, targetCombinedUsableAreaM2: null, measuredCombinedUsableAreaM2: null, editFootprintBounds: null, components: [], routeGraph: null, methodAndExclusions: null },
      experience: { requested: brief.description, built: null },
      requiredContent: brief.requirements.map(requirement => ({ requirement, implemented: false, tested: false, evidence: [] })),
      preview: { scene: null, world: null },
      integration: { sceneOps: null, worldOps: null, inverseOps: [], catalogReports: [], sourceHashes: {} },
      review: { numeric: null, realPlayer: null, visual: null, problems: [] },
      installation: null, navigation: [], limitations: [],
    },
  };
}
