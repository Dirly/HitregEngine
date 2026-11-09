import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  findNames, nameDatabaseSchema, nameEntrySchema, nameOwners, readNameDatabase,
  reserveName, resolveNameDatabase, validateNameClaim, validateNameDatabase,
  type NameDatabase, type NameEntry,
} from '../tools/_names.mts';
import { tryFileLock } from '../tools/_scene-write.mts';

const loader = import.meta.resolve('tsx');
const library = new URL('../tools/_names.mts', import.meta.url).href;
const cli = fileURLToPath(new URL('../tools/names.mts', import.meta.url));

function entry(overrides: Partial<NameEntry> = {}): NameEntry {
  return nameEntrySchema.parse({
    id: 'returned-god', name: 'Veyra', displayName: 'Veyra', kind: 'deity',
    status: 'reserved', project: 'redstrand', location: 'The shore',
    summary: 'One narrative identity in a temporary test namespace.', ...overrides,
  });
}

function database(entries: NameEntry[] = [], extra: Record<string, unknown> = {}): NameDatabase {
  return nameDatabaseSchema.parse({
    version: 1, world: 'redstrand', projects: ['redstrand', 'weeping-sun-tombs'],
    coverage: 'Temporary test identities only.', entries, ...extra,
  });
}

function fixture(t: TestContext, db = database()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hitreg-names-test-${process.pid}-`));
  function write(relative: string, value: unknown) {
    const file = path.resolve(root, relative);
    assert.ok(file.startsWith(root + path.sep), 'fixture writes stay inside its temporary directory');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
    return file;
  }
  t.after(() => {
    const target = path.resolve(root);
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(target).startsWith('hitreg-names-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  const file = write('redstrand/authoring/names.json', db);
  return { root, file, write };
}

function child(args: string[]) {
  const proc = spawn(process.execPath, ['--import', loader, ...args], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  proc.stdout.on('data', data => { stdout += String(data); });
  proc.stderr.on('data', data => { stderr += String(data); });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('close', code => resolve({ code, stdout, stderr }));
  });
  function output(pattern: RegExp): Promise<void> {
    if (pattern.test(stdout)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        proc.off('close', onClose);
        proc.off('error', onError);
      };
      const onData = () => { if (pattern.test(stdout)) { cleanup(); resolve(); } };
      const onClose = () => { cleanup(); reject(new Error(`Child closed before ${pattern}: ${stdout}\n${stderr}`)); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => { cleanup(); reject(new Error(`Child did not emit ${pattern}: ${stdout}\n${stderr}`)); }, 20_000);
      proc.stdout.on('data', onData);
      proc.once('close', onClose);
      proc.once('error', onError);
    });
  }
  async function stop() {
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
    await done;
  }
  return { process: proc, done, output, stop };
}

test('a deity claim prevents a differently identified dungeon boss from taking its name', t => {
  const god = entry({ status: 'retired' });
  const f = fixture(t, database([god]));
  const original = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => reserveName(f.file, entry({
    id: 'temple-boss', kind: 'boss', project: 'weeping-sun-tombs', name: 'Veyra', displayName: 'Veyra the Hungry',
  }), f.root), /Name collision.*returned-god.*temple-boss/);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original, 'a rejected reservation cannot partially alter the database');
});

test('current aliases reserve normalized spelling while previousNames remains searchable history', t => {
  const god = entry({ aliases: ['Véy-ra of the Weep'], previousNames: ['Nereth'] });
  const f = fixture(t, database([god]));
  assert.deepEqual(nameOwners(readNameDatabase(f.file), 'VEY RA, OF THE WEEP!').map(e => e.id), ['returned-god']);
  assert.throws(() => reserveName(f.file, entry({
    id: 'alias-thief', name: 'Vey ra of the Weep', displayName: 'A Different Boss', kind: 'boss',
  }), f.root), /Name collision/);
  const boss = reserveName(f.file, entry({
    id: 'temple-boss', name: 'Nereth', displayName: 'Nereth', kind: 'boss', project: 'weeping-sun-tombs',
  }), f.root);
  const db = readNameDatabase(f.file);
  assert.equal(boss.id, 'temple-boss');
  assert.deepEqual(nameOwners(db, 'Nereth').map(e => e.id), ['temple-boss']);
  assert.deepEqual(findNames(db, 'Né-reth').map(({ entry, match }) => [entry.id, match]), [
    ['returned-god', 'previous'], ['temple-boss', 'current'],
  ]);
  assert.deepEqual(validateNameDatabase(db, f.root), []);
});

test('a new comma epithet cannot evade a reserved distinguishing name', { timeout: 30_000 }, async t => {
  const f = fixture(t, database([entry({ displayName: 'Veyra, the Returned' })]));
  assert.deepEqual(nameOwners(readNameDatabase(f.file), 'Véy-ra, a New Title').map(e => e.id), ['returned-god']);
  assert.throws(() => reserveName(f.file, entry({ id: 'title-thief', name: 'Veyra, a New Title',
    displayName: 'Veyra, a New Title', kind: 'boss' }), f.root), /Name collision/);
  const check = await child([cli, 'check', '--project', 'redstrand', '--projects-root', f.root, '--name', 'Veyra, a New Title']).done;
  assert.equal(check.code, 1, check.stdout + check.stderr);
  const report = JSON.parse(check.stdout);
  assert.equal(report.available, false);
  assert.deepEqual(report.owners.map((owner: { id: string }) => owner.id), ['returned-god']);
});

test('stable actor bindings distinguish rename history from another identity owning the old name', t => {
  const god = entry({ previousNames: ['Nereth'], identifiers: [{ project: 'redstrand', id: 'old-nereth-id' }] });
  const boss = entry({ id: 'temple-boss', name: 'Nereth', displayName: 'Nereth', kind: 'boss', project: 'weeping-sun-tombs',
    identifiers: [{ project: 'weeping-sun-tombs', id: 'boss-nereth' }] });
  const f = fixture(t, database([god, boss]));
  const db = readNameDatabase(f.file);
  assert.deepEqual(validateNameClaim(db, 'redstrand', 'old-nereth-id', 'Veyra'), []);
  assert.match(validateNameClaim(db, 'redstrand', 'old-nereth-id', 'Nereth').join('\n'), /differs from registered Veyra/);
  assert.match(validateNameClaim(db, 'redstrand', 'new-actor', 'Veyra').join('\n'), /belongs to returned-god/);
  assert.match(validateNameClaim(db, 'redstrand', 'new-actor', 'Unused Name').join('\n'), /unregistered/);
  assert.deepEqual(findNames(db, 'old-nereth-id').map(({ entry, match }) => [entry.id, match]), [['returned-god', 'identity']]);
  assert.throws(() => reserveName(f.file, entry({ id: 'binding-thief', name: 'Other', displayName: 'Other', kind: 'npc',
    identifiers: [{ project: 'redstrand', id: 'old-nereth-id' }] }), f.root), /Duplicate actor identifier/);
  assert.deepEqual(readNameDatabase(f.file), db);
  const retired = database([entry({ ...god, status: 'retired' })]);
  assert.match(validateNameClaim(retired, 'redstrand', 'old-nereth-id', 'Veyra').join('\n'), /retired/i,
    'even an otherwise correct name and technical binding cannot install a retired identity');
});

test('the same technical key in another project is a distinct actor binding', t => {
  const db = database([
    entry({ identifiers: [{ project: 'redstrand', id: 'keeper' }] }),
    entry({ id: 'tomb-keeper', name: 'Isca', displayName: 'Isca', kind: 'npc', project: 'weeping-sun-tombs',
      identifiers: [{ project: 'weeping-sun-tombs', id: 'keeper' }] }),
  ]);
  const f = fixture(t, db);
  assert.deepEqual(validateNameDatabase(db, f.root), []);
  assert.deepEqual(validateNameClaim(db, 'weeping-sun-tombs', 'keeper', 'Isca'), []);
  assert.notDeepEqual(validateNameClaim(db, 'redstrand', 'keeper', 'Isca'), []);
});

test('reference checks follow escaped JSON pointers and detect current label drift', t => {
  const f = fixture(t);
  const label = f.write('weeping-sun-tombs/authoring/cast.json', { 'cast/roster': [{ 'name~display': 'Veyra' }] });
  const db = database([entry({ status: 'established', references: [{ project: 'weeping-sun-tombs',
    path: 'authoring/cast.json', pointer: '/cast~1roster/0/name~0display', expected: 'Veyra' }] })]);
  assert.deepEqual(validateNameDatabase(db, f.root), []);
  fs.writeFileSync(label, JSON.stringify({ 'cast/roster': [{ 'name~display': 'Nereth' }] }));
  const errors = validateNameDatabase(db, f.root);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /stale label.*cast~1roster\/0\/name~0display/);
  assert.match(errors[0]!, /expected "Veyra", got "Nereth"/);
});

test('world and dungeon discover one namespace without claiming unrelated projects', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'weeping-sun-tombs'), { recursive: true });
  f.write('elsewhere/authoring/names.json', database([], { world: 'elsewhere', projects: ['elsewhere'] }));
  assert.equal(resolveNameDatabase('redstrand', f.root), f.file);
  assert.equal(resolveNameDatabase('weeping-sun-tombs', f.root), f.file);
  assert.equal(resolveNameDatabase('unknown-world', f.root), null);
  f.write('second-world/authoring/names.json', database([], { world: 'second-world', projects: ['second-world', 'weeping-sun-tombs'] }));
  assert.throws(() => resolveNameDatabase('weeping-sun-tombs', f.root), /Multiple name databases claim/);
});

const collision = { name: 'Nereth', identities: ['old-god', 'temple-boss'], reason: 'Legacy story collision awaiting an authored rename.' };
function legacyConflictDatabase() {
  return database([
    entry({ id: 'old-god', name: 'Nereth', displayName: 'Nereth', kind: 'deity' }),
    entry({ id: 'temple-boss', name: 'Nereth', displayName: 'Nereth', kind: 'boss', project: 'weeping-sun-tombs' }),
  ], { conflicts: [collision] });
}

test('a declared legacy collision permits only its exact existing claimant set', t => {
  const db = legacyConflictDatabase();
  const f = fixture(t, db);
  assert.deepEqual(validateNameDatabase(db, f.root), []);
  const original = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => reserveName(f.file, entry({ id: 'third-claimant', name: 'Né-reth', displayName: 'Né-reth', kind: 'rare' }), f.root), /collision/i);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
  assert.match(validateNameDatabase(database(db.entries, { conflicts: [{ ...collision, identities: ['old-god', 'missing-owner'] }] }), f.root).join('\n'), /conflict|collision|claimant/i);
  assert.match(validateNameDatabase(database(db.entries), f.root).join('\n'), /collision/i, 'the declaration is necessary, not a general collision exemption');
});

test('CLI check reports a known conflict and fails while an unrelated reservation can succeed', { timeout: 30_000 }, async t => {
  const f = fixture(t, legacyConflictDatabase());
  const check = await child([cli, 'check', '--project', 'weeping-sun-tombs', '--projects-root', f.root]).done;
  assert.equal(check.code, 1, check.stdout + check.stderr);
  assert.doesNotThrow(() => JSON.parse(check.stdout));
  assert.match(check.stdout, /old-god/);
  assert.match(check.stdout, /temple-boss/);
  assert.match(check.stdout, /Legacy story collision/);
  const reserve = await child([cli, 'reserve', '--project', 'redstrand', '--projects-root', f.root,
    '--id', 'new-rare', '--name', 'Rustjaw', '--kind', 'rare', '--location', 'The shore', '--summary', 'An unrelated test reservation.']).done;
  assert.equal(reserve.code, 0, reserve.stdout + reserve.stderr);
  assert.equal(JSON.parse(reserve.stdout).id, 'new-rare');
  assert.equal(readNameDatabase(f.file).entries.length, 3);
  assert.deepEqual(validateNameDatabase(readNameDatabase(f.file), f.root), []);
});

test('parallel processes serialize same-name reservations and reread inside the lock', { timeout: 30_000 }, async t => {
  const f = fixture(t);
  const held = tryFileLock(f.file, 'names race fixture');
  assert.ok('release' in held);
  let released = false;
  const worker = (id: string, name: string) => child(['--input-type=module', '-e', `
    import { reserveName } from ${JSON.stringify(library)};
    process.stdout.write('READY\\n');
    process.stdin.once('data', () => {
      try {
        reserveName(${JSON.stringify(f.file)}, ${JSON.stringify(entry({ id, name, displayName: name, kind: 'rare' }))}, ${JSON.stringify(f.root)});
        process.stdout.write('RESERVED\\n');
      } catch (error) { process.stderr.write(String(error)); process.exitCode = 1; }
      process.stdin.pause();
    });
  `]);
  const workers = [worker('first-rare', 'Stone-Hand'), worker('second-rare', 'Stóne Hand')];
  try {
    await Promise.all(workers.map(w => w.output(/READY/)));
    for (const w of workers) w.process.stdin.end('go');
    await Promise.all(workers.map(w => w.output(/scene-write: waiting/)));
    assert.equal(readNameDatabase(f.file).entries.length, 0, 'neither process may write past another live holder');
    f.write('redstrand/authoring/names.json', database([entry({ id: 'retained-identity', name: 'Elsewhere', displayName: 'Elsewhere' })]));
    held.release(); released = true;
    const results = await Promise.all(workers.map(w => w.done));
    assert.deepEqual(results.map(r => r.code).sort(), [0, 1], JSON.stringify(results));
    assert.match(results.find(r => r.code === 1)!.stderr, /Name collision/);
    const db = readNameDatabase(f.file);
    assert.equal(db.entries.length, 2);
    assert.ok(db.entries.some(e => e.id === 'retained-identity'), 'contenders must reread the latest document after acquiring the lock');
    assert.equal(nameOwners(db, 'STONE HAND').length, 1);
    assert.deepEqual(validateNameDatabase(db, f.root), []);
    assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['names.json'], 'atomic writes leave no lock or temporary file');
  } finally {
    if (!released) held.release();
    await Promise.all(workers.map(w => w.stop()));
  }
});
