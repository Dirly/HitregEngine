import fs from 'node:fs';
import path from 'node:path';
import { creatorBriefSchema, prepareCreatorJob, z } from './brief.mjs';
const flags = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--brief', '--out-dir', '--schema'].includes(key) || !process.argv[i + 1] || flags[key]) throw Error('Use --brief brief.json --out-dir JOB-DIRECTORY; or --schema brief.schema.json');
  flags[key] = process.argv[i + 1];
}
if (flags['--schema']) {
  if (Object.keys(flags).length !== 1) throw Error('--schema cannot be combined with job preparation');
  fs.writeFileSync(flags['--schema'], JSON.stringify(z.toJSONSchema(creatorBriefSchema, { io: 'input' }), null, 2) + '\n');
  console.log(JSON.stringify({ schema: flags['--schema'] }));
} else {
  if (!flags['--brief'] || !flags['--out-dir']) throw Error('Use --brief brief.json --out-dir JOB-DIRECTORY');
  const job = prepareCreatorJob(JSON.parse(fs.readFileSync(flags['--brief'], 'utf8').replace(/^\uFEFF/, ''))), dir = path.resolve(flags['--out-dir']);
  if (fs.existsSync(dir)) throw Error('Refusing to overwrite an existing POI job directory: ' + dir);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, content] of [['brief.json', JSON.stringify(job.brief, null, 2)], ['owner-prompt.txt', job.prompt], ['progress.json', JSON.stringify(job.progress, null, 2)], ['handoff.json', JSON.stringify(job.handoff, null, 2)]]) fs.writeFileSync(path.join(dir, name), content, { flag: 'wx' });
  console.log(JSON.stringify({ status: 'briefed-not-built', id: job.brief.id, adventureSize: job.brief.adventureSize, hostility: job.brief.hostility, mode: job.brief.mode, ownerAgentId: null, out: dir }));
}
