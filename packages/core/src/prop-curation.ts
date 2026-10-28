import { z } from 'zod';
export const propCurationSchema = z.object({
    version: z.literal(1),
    props: z.record(z.string().min(1), z.object({
        use: z.enum(['allow', 'exclude', 'trash']).describe('Owner choice for future builders. Trash removes a prop from the active review library and blocks future placement while retaining assets for recovery and existing references. Exclude and trash survive regeneration; allow cannot override either in a dependency project.'),
        note: z.string().max(2000).default(''),
        reviewedHash: z.string().regex(/^[a-f0-9]{64}$/).describe('Prefab/dependency fingerprint when reviewed. Changed content is shown as needing review; exclusions still apply.'),
        updatedAt: z.string().datetime(),
    }).strict()),
}).strict().describe('Owner prop review choices in authoring/prop-curation.json. Builders respect exclusions across the project dependency closure and nested prefabs; installed scenes and source assets are preserved.');
export type PropCuration = z.infer<typeof propCurationSchema>;
/** Exclusions are monotonic across a project closure; nested wrappers cannot bypass them. */
export function excludedProp(id: string, choices: readonly {
    project: string;
    data: PropCuration;
}[], children: (id: string) => readonly string[]): {
    id: string;
    project: string;
    note: string;
} | null {
    const seen = new Set<string>();
    function visit(at: string): ReturnType<typeof excludedProp> {
        if (seen.has(at))
            return null;
        seen.add(at);
        for (const source of choices) {
            const decision = source.data.props[at];
            if (decision?.use === 'exclude' || decision?.use === 'trash')
                return { id: at, project: source.project, note: decision.note };
        }
        for (const child of children(at)) {
            const found = visit(child);
            if (found)
                return found;
        }
        return null;
    }
    return visit(id);
}
