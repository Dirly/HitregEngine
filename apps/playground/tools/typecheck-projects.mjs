#!/usr/bin/env node
// Typecheck every projects/<name>/scripts tree.
//
// This exists because `apps/playground/tsconfig.json` has `"include": ["src"]`
// and project scripts reach the app through an `import.meta.glob` that tsc sees
// as `unknown` — so the package's own `tsc --noEmit` reported a green that said
// NOTHING about any project's code. That hole silently produced false
// confidence for a long time.
//
// Separate from the app's own check because `projects/` is gitignored: a fresh
// clone has none, and tsc treats "no input files" as a hard error. So this
// checks first and exits 0 with a note rather than failing a clean repo.
import { existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectsDir = path.join(APP, 'projects');

const withScripts = existsSync(projectsDir)
  ? readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(path.join(projectsDir, d.name, 'scripts')))
      .map((d) => d.name)
  : [];

if (withScripts.length === 0) {
  console.log('typecheck-projects: no projects/<name>/scripts trees — nothing to check');
  process.exit(0);
}

// Resolve TypeScript's own JS entry point and run it under THIS node, rather
// than shelling out to `npx`. On Windows, spawning a `.cmd` without `shell:
// true` fails with EINVAL (Node's CVE-2024-27980 fix), and `shell: true` would
// mean quoting paths by hand. This sidesteps both.
const require = createRequire(import.meta.url);
let tscJs;
try {
  tscJs = require.resolve('typescript/lib/tsc.js');
} catch {
  console.error('typecheck-projects: cannot resolve typescript — is it installed?');
  process.exit(1);
}

console.log(`typecheck-projects: ${withScripts.join(', ')}`);
const r = spawnSync(process.execPath, [tscJs, '-p', 'tsconfig.projects.json'], {
  cwd: APP,
  stdio: 'inherit',
});
if (r.error) {
  console.error(`typecheck-projects: ${r.error.message}`);
  process.exit(1);
}
process.exit(r.status ?? 1);
