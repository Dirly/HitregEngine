import { createRequire } from 'node:module';
const { z } = createRequire(new URL('../../../packages/core/package.json', import.meta.url))('zod');
export { z };
import { parentedTierFault, sizeTierSchema, tierFor, tierTargetsText } from '../size-tiers.mjs';
const text = z.string().trim().min(1);
export const creatorBriefSchema = z.object({
  version: z.literal(1),
  id: text.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).describe('Stable POI job slug, inferred from its name when needed.'),
  name: text,
  project: text.regex(/^[a-zA-Z0-9_-]+$/).describe('Active HitReg project folder name; infer from session context.'),
  adventureSize: z.enum(['pinpoint', 'small', 'medium', 'large']).describe('Size tier of the complete requested player experience, including described interiors; never silently replace it with an entrance-only scope. Physical targets come from tools/poi-review/size-tiers.mjs (footprint, measured usable area, linked features, creature groups, approaches, terrain shaping) and the install gate measures against them (job.mjs measure).'),
  parent: text.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional().describe('The job id of the larger place this job is one part of — a dungeon door whose dungeon belongs to another place job. A parented job is sized as a pinpoint child (adventureSize must be pinpoint) and the size gate judges the PARENT tier over the parent plus its children (tools/poi-review/size-tiers.mjs "PARENTED JOBS").'),
  sizeTargets: sizeTierSchema.optional().describe('Written by preparation from tools/poi-review/size-tiers.mjs for adventureSize; an input value is replaced. The install gate enforces it.'),
  hostility: z.enum(['non-hostile', 'hostile', 'mixed']).describe('Non-hostile: safe activities/discovery. Hostile: appropriate adversaries and retreats. Mixed: explicitly mapped safe-to-hostile transition.'),
  description: text.describe('The specific fantasy discovery, what investigating it reveals, its playable payoff and the physical place that delivers them. Ordinary trades support the adventure; a grim name or generic danger does not turn a work yard into a destination. Follow docs/world-standards/adventure-design.md and resolve unclear core intent before building.'),
  location: z.object({
    hint: text.describe('Human location description or survey instruction; exact coordinates may be resolved from current focus and map.'),
    anchor: z.array(z.number().finite()).length(3).optional().describe('Optional known engine X/Y/Z point in metres; validate against rendered terrain.'),
  }).strict(),
  requirements: z.array(text).default([]).describe('Specific requested destinations, activities, enemies, NPCs, rewards or mechanics. Required behavior must work before completion.'),
  constraints: z.array(text).default([]).describe('User limits and protected content, e.g. safe roads, existing scale, terrain or material choices. Retain verbatim intent.'),
  mode: z.enum(['plan', 'build']).default('plan').describe('Requested work stage, not authorization. Plan produces a surveyed design only; build owns the complete authorized POI through review. Honour current user stop/freeze instructions.'),
}).strict();

export function prepareCreatorJob(input) {
  const parsed = creatorBriefSchema.parse(input);
  if (parsed.parent) { const f = parentedTierFault(parsed.adventureSize, parsed.parent); if (f) throw new Error(f); }
  const tier = tierFor(parsed.adventureSize);
  const brief = { ...parsed, sizeTargets: tier };
  const prompt = [
    `Own the complete POI ${brief.name} (${brief.id}) in project ${brief.project}.`,
    'Read tools/poi-review/creator/SKILL.md in the active Engine checkout, then brief.json in this job directory.',
    `Requested adventure: ${brief.adventureSize}; hostility: ${brief.hostility}; work mode: ${brief.mode}.`,
    ...(brief.parent ? [`Part of ${brief.parent}: this job is that place's entrance, sized as a pinpoint child; the size gate judges ${brief.parent}'s tier over ${brief.parent} plus its children (job.mjs measure).`] : []),
    `Size targets (tools/poi-review/size-tiers.mjs; install REFUSES below them, measured by job.mjs measure): ${tierTargetsText(brief.adventureSize)} Record measurements.measuredCombinedUsableAreaM2 (measured, not estimated), measurements.features[] { id, kind, linkedTo[] } and measurements.approaches[] in handoff.json.`,
    `Description: ${brief.description}`,
    'Read docs/world-standards/adventure-design.md before designing: establish the fantasy discovery, investigation and payoff in the physical place. A trade yard plus generic danger or an ominous name is insufficient under P1/P4. Keep suitable enemies and believable work as supporting context. Never claim proposed interiors, encounters or mechanics are already playable.',
    `Location: ${brief.location.hint}${brief.location.anchor ? ' at engine X/Y/Z ' + brief.location.anchor.join(', ') : ''}.`,
    ...brief.requirements.map(r => `Required: ${r}`),
    ...brief.constraints.map(r => `Constraint: ${r}`),
    'You are the single author of this POI: survey, terrain, structures, gameplay, dressing, integration, evidence and repairs. Do not spawn other authors or hand this POI to separate terrain/dungeon/dressing builders.',
    'The coordinator reviews and serializes installation; return corrections to this owner. A job mode cannot override user authorization or a stopped/frozen world.',
    brief.mode === 'plan' ? 'Plan only: survey and design; do not create a blockout, mutate game assets/terrain/gameplay or install anything.' : 'Build the complete authorized experience in a private preview. Submit the full blockout early; do not finish with only an entrance, a cleared pad or proposed gameplay.',
    'Record owner identity and truthful progress in progress.json, followed by the skill handoff with current evidence. A prepared brief is not a built or reviewed POI.',
    'Gates (tools/poi-review/job.mjs, enforced): declare viewpoints[] { id, at, look } in progress.json before the blockout; the stage moves past blockout only with evidence.readShot { file, viewpoint } from a declared viewpoint (job.mjs stage). Record every fix attempt with job.mjs fix; a third is refused without the coordinator.',
    'Design first (gate 16, enforced): before anything repeats, write <job>/design.json { premise, journey[], areas[{ id, purpose, elements[] }], elements[{ id, shows, madeOf[] }], sample { area, shots[] }, reference[], concept[] } — the premise in a sentence, the player\'s journey, the areas, the story elements each made of catalogued prop ids (<collection>/<id>, they must exist) or structure:/creature:/decal:/terrain:, ONE area finished at player height with its frames, the owner-approved reference frames it is judged against, and a concept frame you draw from the premise BEFORE the build (apps/playground/tools/image-request.mjs gen with the zone\'s concept frames as --ref, saved under <job>/concept/). `job.mjs design <job>` checks it and prints the design hash; a fresh reviewer answers the rubric\'s Place lines P1-P5 on the sample frames (story read, every element seen, nothing random, worth visiting, finished to the bar), names "Design hash: <hash>" and "Reviewer: <id>", and `job.mjs design-review <job> --file <review>` records it. No stage past greybox-review and no install without that PASS; editing design.json or the sample frames re-opens it.',
    'Your install.mts calls requireFinalReview(<this job directory>) from tools/poi-review/job.mjs before it writes anything: it installs only after a fresh reviewer (not you, not the coordinator) writes Verdict: PASS, the ops hash (job.mjs hash), "Reviewer: <their agent id>" and a pass/fault/n-a line with evidence for every Quality + Site + Place item of docs/world-standards/review-rubric.md (Q1-Q5, S1-S9, P1-P5 again on the whole place), and job.mjs review records it; --force-dogfood belongs to the coordinator alone; only Derek writes ownerApproval.',
  ].join('\n') + '\n';
  return {
    brief, prompt,
    progress: { version: 1, poiId: brief.id, ownerAgentId: null, stage: 'briefed', mode: brief.mode, scope: 'Intake prepared only; no agent started, game changes or acceptance.', problems: [], evidence: {}, viewpoints: [], fixes: [], finalReview: null, timing: { setupSeconds: null, constructionSeconds: null, verificationSeconds: null } },
    handoff: {
      version: 1, poiId: brief.id, ownerAgentId: null, stage: 'briefed', briefPath: 'brief.json', readyForInstall: false,
      ...(brief.parent ? { parent: brief.parent } : {}),
      measurements: { adventureSize: brief.adventureSize, sizeTargets: tierTargetsText(brief.adventureSize), targetCombinedUsableAreaM2: tier.minUsableAreaM2, measuredCombinedUsableAreaM2: null, features: [], approaches: [], editFootprintBounds: null, components: [], routeGraph: null, methodAndExclusions: null },
      experience: { requested: brief.description, built: null },
      requiredContent: brief.requirements.map(requirement => ({ requirement, implemented: false, tested: false, evidence: [] })),
      preview: { scene: null, world: null },
      integration: { sceneOps: null, worldOps: null, inverseOps: [], catalogReports: [], sourceHashes: {} },
      review: { numeric: null, realPlayer: null, visual: null, problems: [] },
      installation: null, navigation: [], limitations: [],
    },
  };
}
