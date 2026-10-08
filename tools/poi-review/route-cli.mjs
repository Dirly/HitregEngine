import fs from 'node:fs';
import path from 'node:path';
import { planTerrainRoute } from './terrain-route.mjs';
const flags = {};
for (let i = 2; i < process.argv.length; i += 2)
    flags[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
if (!flags.world || !flags.search || !flags.out)
    throw Error('node tools/poi-review/route-cli.mjs --world world.json --search search.json --out route.json');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')), result = planTerrainRoute(read(flags.world), read(flags.search));
fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
fs.writeFileSync(flags.out, JSON.stringify(result, null, 2));
const { points, separation, ...summary } = result;
console.log(JSON.stringify({ ...summary, separation: separation ? { passed: separation.passed, count: separation.count } : undefined, points: points?.length }));
if (!result.found || !result.usableCandidate)
    process.exitCode = 1;
