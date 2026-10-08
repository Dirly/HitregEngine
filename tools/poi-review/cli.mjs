import fs from 'node:fs';
import path from 'node:path';
import { review } from './review.mjs';
import { surveySvg } from './map.mjs';
const [command, ...args] = process.argv.slice(2), flags = {};
for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined)
        throw Error('Expected --key value');
    flags[args[i].slice(2)] = args[i + 1];
}
const read = p => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
if (!['review', 'pack'].includes(command) || !flags.out || (!flags.bundle && (!flags.plan || !flags.world || !flags.assets)))
    throw Error('node tools/poi-review/cli.mjs review|pack --plan plan.json --world world.json --assets project/assets --out report-or-bundle.json; or review --bundle bundle.json --out report.json');
let bundle;
if (flags.bundle) bundle = read(flags.bundle);
else {
    const plan = read(flags.plan), models = {}, root = path.resolve(flags.assets, 'models');
    for (const m of plan.models ?? []) {
        const target = path.resolve(root, m.model);
        if (!target.startsWith(root + path.sep))
            throw Error('Model path escapes assets');
        models[m.model] = fs.readFileSync(target).toString('base64');
    }
    bundle = { plan, world: read(flags.world), models };
}
const result = command === 'pack' ? bundle : await review(bundle);
fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
fs.writeFileSync(flags.out, JSON.stringify(result, null, 2));
if (command === 'review')
    fs.writeFileSync(flags.out + '.svg', surveySvg(result));
console.log(command === 'pack' ? 'Packed review inputs' : JSON.stringify({ status: result.status, measuredPassed: result.measuredPassed, failures: result.failures.length, missing: result.missing, out: flags.out }));
if (command === 'review' && !result.measuredPassed)
    process.exitCode = 1;
