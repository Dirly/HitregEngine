#!/usr/bin/env tsx
import path from 'node:path';
import { z } from 'zod';
import { defaultProjectsRoot, findNames, nameDatabaseSchema, nameOwners, readNameDatabase, reserveName, resolveNameDatabase, validateNameDatabase } from './_names.mts';

const args = process.argv.slice(2), command = args[0];
const option = (name: string, fallback = ''): string => {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const value = args[at + 1];
  if (!value || value.startsWith('--')) throw new Error(`--${name} needs a value`);
  return value;
};
const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
try {
  if (command === 'schema') { print(z.toJSONSchema(nameDatabaseSchema)); process.exit(0); }
  if (!['lookup', 'check', 'list', 'reserve'].includes(command ?? '')) throw new Error('Usage: names.mts lookup|check|list|reserve --project <world-or-dungeon> [--name "Nereth"]\nreserve requires --id --name --kind --location --summary; optional --display-name --actor-id --actor-project --status');
  const project = option('project');
  if (!project) throw new Error('--project is required');
  const root = path.resolve(option('projects-root', defaultProjectsRoot));
  const file = resolveNameDatabase(project, root);
  if (!file) throw new Error(`No name database covers ${project}; create authoring/names.json using names.mts schema`);
  const db = readNameDatabase(file), name = option('name');
  if (command === 'lookup') {
    if (!name) throw new Error('lookup requires --name (a name or identity ID)');
    print({ database: path.relative(root, file), matches: findNames(db, name) });
  } else if (command === 'list') {
    print({ world: db.world, coverage: db.coverage, entries: db.entries.filter(e => !option('kind') || e.kind === option('kind')).map(e => ({ id: e.id, name: e.displayName, kind: e.kind, status: e.status, project: e.project, location: e.location })) });
  } else if (command === 'check') {
    const errors = validateNameDatabase(db, root), owners = name ? nameOwners(db, name) : [];
    print({ database: path.relative(root, file), entries: db.entries.length, errors, unresolvedConflicts: db.conflicts, ...(name ? { name, available: owners.length === 0, owners: owners.map(e => ({ id: e.id, name: e.displayName, kind: e.kind, location: e.location })) } : {}) });
    if (errors.length || owners.length || (!name && db.conflicts.length)) process.exitCode = 1;
  } else {
    const actor = option('actor-id'), actorProject = option('actor-project', project);
    print(reserveName(file, {
      id: option('id'), name, displayName: option('display-name', name), kind: option('kind'), status: option('status', 'reserved'),
      project: actorProject, location: option('location'), summary: option('summary'),
      identifiers: actor ? [{ project: actorProject, id: actor }] : [],
    }, root));
  }
} catch (error) { console.error(String(error)); process.exitCode = 1; }
