import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { withFileLock, writeAtomic } from './_scene-write.mts';

const projectName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const relativeFile = z.string().min(1).refine(s => !path.isAbsolute(s) && !/^[A-Za-z]:/.test(s) && !s.split(/[\\/]/).includes('..'), 'Use a project-relative file without traversal');
const source = z.object({ project: projectName, path: relativeFile }).strict();
const reference = source.extend({
  pointer: z.string().startsWith('/').describe('RFC6901 JSON pointer to a current authored label, not a historical report.'),
  expected: z.string().min(1).describe('Exact current string. check fails if the source label changes without updating its identity record.'),
}).strict();

export const nameEntrySchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).describe('Permanent narrative identity; changing a display name does not change this ID.'),
  name: z.string().trim().min(1).describe('Chosen distinguishing name, without an epithet. Reserves the name across all kinds in this database.'),
  displayName: z.string().trim().min(1),
  kind: z.enum(['deity', 'npc', 'boss', 'rare', 'historical']),
  status: z.enum(['reserved', 'proposed', 'established', 'retired']).describe('Established means present in authored content, not a claim of balanced encounters or live quest binding. Even retired identities retain their claims.'),
  project: projectName,
  location: z.string().min(1),
  summary: z.string().min(1),
  aliases: z.array(z.string().trim().min(1)).default([]).describe('Current names for this same identity; also reserved. Never use aliases to merge unrelated characters.'),
  previousNames: z.array(z.string().trim().min(1)).default([]).describe('Searchable rename history only; does not reserve the old name or assert identity with its current owner.'),
  identifiers: z.array(z.object({ project: projectName, id: z.string().min(1) }).strict()).default([]).describe('Stable technical actor/resident keys, including legacy IDs. These are not lore aliases.'),
  sources: z.array(source).default([]).describe('Canonical project-relative provenance, not generated proof logs.'),
  references: z.array(reference).default([]),
}).strict();

export const nameDatabaseSchema = z.object({
  version: z.literal(1),
  world: projectName,
  projects: z.array(projectName).min(1).describe('Projects sharing this narrative namespace. A dungeon resolves to its world database without adding a runtime dependency.'),
  coverage: z.string().min(1).describe('Explicit inventory scope and remaining gaps; not an assertion that every string has been scanned.'),
  conflicts: z.array(z.object({
    name: z.string().trim().min(1),
    identities: z.array(z.string().min(1)).min(2),
    reason: z.string().min(1),
  }).strict()).default([]).describe('Explicit unresolved legacy collisions. Exact identity sets only; the name remains unavailable to new actors. check reports these separately and exits nonzero until resolved.'),
  entries: z.array(nameEntrySchema),
}).strict();
export type NameEntry = z.infer<typeof nameEntrySchema>;
export type NameDatabase = z.infer<typeof nameDatabaseSchema>;
export const defaultProjectsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../projects');

/** Ignore punctuation, spacing, case and accents when claiming a name. */
export const nameKey = (name: string): string => name.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const candidateKeys = (name: string): string[] => [...new Set([name, name.split(',')[0]!].map(nameKey))];
const claims = (entry: NameEntry): string[] => [...new Set([entry.name, entry.displayName, ...entry.aliases].flatMap(candidateKeys))];
export function readNameDatabase(file: string): NameDatabase {
  return nameDatabaseSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}
export function projectFile(root: string, project: string, relative: string): string {
  projectName.parse(project); relativeFile.parse(relative);
  const base = path.resolve(root, project), file = path.resolve(base, relative);
  if (!file.startsWith(base + path.sep)) throw new Error('Source escapes project');
  // A project symlink is allowed; a source symlink escaping that project is not.
  if (fs.existsSync(file)) {
    const realBase = fs.realpathSync(base), realFile = fs.realpathSync(file);
    if (!realFile.startsWith(realBase + path.sep)) throw new Error('Source symlink escapes project');
  }
  return file;
}
export function resolveNameDatabase(project: string, root = defaultProjectsRoot): string | null {
  projectName.parse(project);
  const matches: string[] = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const file = path.join(root, dir.name, 'authoring/names.json');
    if (!fs.existsSync(file)) continue;
    const db = readNameDatabase(file);
    if (db.projects.includes(project)) matches.push(file);
  }
  if (matches.length > 1) throw new Error(`Multiple name databases claim ${project}: ${matches.join(', ')}`);
  return matches[0] ?? null;
}
export function pointerValue(doc: unknown, pointer: string): unknown {
  return pointer.slice(1).split('/').reduce<unknown>((value, part) => {
    const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
    return value !== null && typeof value === 'object' && Object.hasOwn(value, key) ? (value as Record<string, unknown>)[key] : undefined;
  }, doc);
}
export function findNames(db: NameDatabase, query: string): { entry: NameEntry; match: 'current' | 'previous' | 'identity' | 'related' }[] {
  const key = nameKey(query);
  if (!key) throw new Error('Name query must contain letters or numbers');
  return db.entries.flatMap(entry => {
    const match: 'current' | 'previous' | 'identity' | 'related' | null = claims(entry).includes(key) ? 'current' : entry.previousNames.some(n => nameKey(n) === key) ? 'previous' :
      entry.id === query || entry.identifiers.some(i => i.id === query) ? 'identity' :
      [entry.name, entry.displayName, ...entry.aliases].some(n => nameKey(n).includes(key)) ? 'related' : null;
    return match ? [{ entry, match }] : [];
  });
}
export function nameOwners(db: NameDatabase, name: string): NameEntry[] {
  const key = nameKey(name);
  if (!key) throw new Error('Name must contain letters or numbers');
  return db.entries.filter(entry => candidateKeys(name).some(k => claims(entry).includes(k)));
}
export function validateNameDatabase(db: NameDatabase, root = defaultProjectsRoot): string[] {
  const errors: string[] = [], ids = new Set<string>(), keys = new Map<string, Set<string>>(), bindings = new Map<string, string>();
  if (new Set(db.projects).size !== db.projects.length || !db.projects.includes(db.world)) errors.push('Namespace projects must be unique and include the owning world');
  for (const entry of db.entries) {
    if (ids.has(entry.id)) errors.push(`Duplicate identity ${entry.id}`); ids.add(entry.id);
    if (!db.projects.includes(entry.project)) errors.push(`${entry.id}: project ${entry.project} is outside namespace`);
    for (const key of claims(entry)) {
      if (!key) { errors.push(`${entry.id}: empty normalized name`); continue; }
      const owners = keys.get(key) ?? new Set<string>(); owners.add(entry.id); keys.set(key, owners);
    }
    for (const binding of entry.identifiers) {
      if (!db.projects.includes(binding.project)) errors.push(`${entry.id}: identifier project ${binding.project} is outside namespace`);
      const key = `${binding.project}/${binding.id}`, owner = bindings.get(key);
      if (owner) errors.push(`Duplicate actor identifier ${key}: ${owner} / ${entry.id}`);
      bindings.set(key, entry.id);
    }
    if (entry.status === 'established' && !entry.sources.length && !entry.references.length) errors.push(`${entry.id}: established identity needs provenance`);
    for (const src of [...entry.sources, ...entry.references]) {
      try {
        const file = projectFile(root, src.project, src.path);
        if (!fs.existsSync(file)) { errors.push(`${entry.id}: missing ${src.project}/${src.path}`); continue; }
      } catch (error) { errors.push(`${entry.id}: ${String(error)}`); }
    }
    for (const ref of entry.references) {
      try {
        const file = projectFile(root, ref.project, ref.path);
        if (!fs.existsSync(file)) continue; // already reported above
        const actual = pointerValue(JSON.parse(fs.readFileSync(file, 'utf8')), ref.pointer);
        if (actual !== ref.expected) errors.push(`${entry.id}: stale label ${ref.project}/${ref.path}${ref.pointer}: expected ${JSON.stringify(ref.expected)}, got ${JSON.stringify(actual)}`);
      } catch (error) { errors.push(`${entry.id}: ${String(error)}`); }
    }
  }
  const conflictKeys = new Set<string>();
  for (const conflict of db.conflicts) {
    const key = nameKey(conflict.name), actual = keys.get(key) ?? new Set<string>();
    if (conflictKeys.has(key)) errors.push(`Duplicate conflict declaration ${conflict.name}`);
    conflictKeys.add(key);
    if (new Set(conflict.identities).size !== conflict.identities.length || actual.size !== conflict.identities.length || !conflict.identities.every(id => actual.has(id))) errors.push(`Stale conflict declaration ${conflict.name}: identities must exactly match its current owners`);
  }
  for (const [key, owners] of keys) if (owners.size > 1) {
    const acknowledged = db.conflicts.some(c => nameKey(c.name) === key && c.identities.length === owners.size && c.identities.every(id => owners.has(id)));
    if (!acknowledged) errors.push(`Name collision ${key}: ${[...owners].join(' / ')}`);
  }
  return errors;
}
/** A known name is not permission to reuse a different identity's name. */
export function validateNameClaim(db: NameDatabase, project: string, actorId: string, name: string): string[] {
  const bound = db.entries.find(e => e.identifiers.some(i => i.project === project && i.id === actorId));
  if (!bound) {
    const owners = nameOwners(db, name);
    return [`${project}/${actorId}: ${JSON.stringify(name)} ${owners.length ? `belongs to ${owners.map(e => e.id).join(', ')}` : 'is unregistered; reserve it and bind this actor before installation'}`];
  }
  if (bound.status === 'retired') return [`${project}/${actorId}: ${bound.id} is retired; explicitly reactivate its identity record before installation`];
  return claims(bound).includes(nameKey(name)) ? [] : [`${project}/${actorId}: label ${JSON.stringify(name)} differs from registered ${bound.displayName} (${bound.id})`];
}
/** Lock, reread and claim atomically so parallel agents cannot both reserve a name. */
export function reserveName(file: string, input: unknown, root = defaultProjectsRoot): NameEntry {
  const entry = nameEntrySchema.parse(input);
  return withFileLock(file, () => {
    const db = readNameDatabase(file);
    if (db.entries.some(e => e.id === entry.id)) throw new Error(`Identity ${entry.id} already exists; edit its existing record instead`);
    db.entries.push(entry);
    const errors = validateNameDatabase(db, root);
    if (errors.length) throw new Error(errors.join('\n'));
    writeAtomic(file, JSON.stringify(db, null, 2) + '\n');
    return entry;
  }, { label: `reserve name ${entry.name}`, waitMs: 30_000 });
}
