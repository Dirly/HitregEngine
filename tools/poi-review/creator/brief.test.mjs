import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { prepareCreatorJob } from './brief.mjs';

const example = () => JSON.parse(fs.readFileSync(new URL('./brief.example.json', import.meta.url), 'utf8'));
const cli = fileURLToPath(new URL('./prepare.mjs', import.meta.url));
const run = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
function removeTrialDirectory(dir) {
  const absolute = path.resolve(dir), parent = path.resolve(os.tmpdir());
  assert.equal(path.dirname(absolute), parent);
  assert.ok(/^hitreg-poi-(creator|contract)-/.test(path.basename(absolute)));
  fs.rmSync(absolute, { recursive: true, force: true });
}

test('intake rejects missing size, hostility, description and location rather than inferring an adventure', () => {
  for (const field of ['adventureSize', 'hostility', 'description', 'location']) {
    const input = example(); delete input[field];
    assert.throws(() => prepareCreatorJob(input), field);
  }
  const input = example(); input.description = '   ';
  assert.throws(() => prepareCreatorJob(input));
  input.description = 'Iron mine'; input.hostility = 'unknown';
  assert.throws(() => prepareCreatorJob(input));
  for (const anchor of [[1, 2], [1, 2, 3, 4], [1, NaN, 3]]) {
    const input = example(); input.location.anchor = anchor;
    assert.throws(() => prepareCreatorJob(input));
  }
});

test('preparation preserves complete scope and constraints, defaults to plan and never claims a built owner', () => {
  const input = example(); delete input.mode;
  const job = prepareCreatorJob(input);
  assert.equal(job.brief.adventureSize, 'large');
  assert.equal(job.brief.hostility, 'mixed');
  assert.deepEqual(job.brief.requirements, input.requirements);
  assert.deepEqual(job.brief.constraints, input.constraints);
  assert.deepEqual(job.brief.location, input.location);
  assert.equal(job.brief.mode, 'plan');
  assert.equal(job.progress.stage, 'briefed');
  assert.equal(job.progress.ownerAgentId, null);
  assert.deepEqual(job.progress.evidence, {});
  assert.equal(job.handoff.readyForInstall, false);
  assert.equal(job.handoff.measurements.measuredCombinedUsableAreaM2, null);
  assert.deepEqual(job.handoff.requiredContent.map(c => c.requirement), input.requirements);
  assert.ok(job.handoff.requiredContent.every(c => !c.implemented && !c.tested));
  input.mode = 'build';
  assert.equal(prepareCreatorJob(input).brief.mode, 'build');
});

test('CLI creates an intake bundle, rejects invalid requests before writing, and protects existing jobs', t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hitreg-poi-creator-'));
  t.after(() => removeTrialDirectory(temp));
  const brief = path.join(temp, 'input.json'), out = path.join(temp, 'job');
  fs.writeFileSync(brief, JSON.stringify(example()));
  const result = run(['--brief', brief, '--out-dir', out]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(out).sort(), ['brief.json', 'handoff.json', 'owner-prompt.txt', 'progress.json']);
  const before = fs.readFileSync(path.join(out, 'brief.json'), 'utf8');
  assert.equal(JSON.parse(before).adventureSize, 'large');
  assert.equal(JSON.parse(result.stdout).status, 'briefed-not-built');
  assert.notEqual(run(['--brief', brief, '--out-dir', out]).status, 0);
  assert.equal(fs.readFileSync(path.join(out, 'brief.json'), 'utf8'), before);
  const invalid = example(); delete invalid.hostility;
  fs.writeFileSync(brief, JSON.stringify(invalid));
  const invalidOut = path.join(temp, 'invalid-job');
  assert.notEqual(run(['--brief', brief, '--out-dir', invalidOut]).status, 0);
  assert.equal(fs.existsSync(invalidOut), false);
  assert.notEqual(run(['--unknown', 'value']).status, 0);
});

test('filled mine and cemetery briefs are valid and generated contract matches its source', t => {
  for (const file of ['brief.example.json', 'cemetery.example.json']) {
    const input = JSON.parse(fs.readFileSync(new URL(file, import.meta.url), 'utf8'));
    assert.equal(prepareCreatorJob(input).brief.mode, 'plan');
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hitreg-poi-contract-'));
  t.after(() => removeTrialDirectory(temp));
  const out = path.join(temp, 'schema.json'), result = run(['--schema', out]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')), JSON.parse(fs.readFileSync(new URL('./brief.schema.json', import.meta.url), 'utf8')));
});
