/** Typed surface of the shared project dependency/asset lookup helper. */
export const PROJECTS: string;
export function projectsRoot(): string;
export function closure(project: string): string[];
export function assetDirs(project: string, kind: string): string[];
export function findAsset(project: string, relative: string): string | null;
export function assetPath(project: string, relative: string): string;
export function assetIds(project: string, kind: string, extension?: string): Set<string>;
export function firstExisting(roots: string[], relative: string): string | null;
