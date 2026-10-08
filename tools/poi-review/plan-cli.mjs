import fs from 'node:fs';import path from 'node:path';
import {planPoi,poiRequestSchema} from './poi-plan.mjs';
import {z} from './engine.mjs';
const args=process.argv.slice(2),flags={};
for(let i=0;i<args.length;i+=2){if(!args[i]?.startsWith('--')||args[i+1]===undefined)throw Error('Expected --key value');flags[args[i].slice(2)]=args[i+1]}
if(flags.schema){fs.writeFileSync(flags.schema,JSON.stringify(z.toJSONSchema(poiRequestSchema,{io:'input'}),null,2));console.log(flags.schema)}
else {
  if(!flags.request||!flags['out-dir'])throw Error('node tools/poi-review/plan-cli.mjs --request request.json --out-dir authoring/my-poi; or --schema poi-request-schema.json');
  const result=planPoi(JSON.parse(fs.readFileSync(flags.request,'utf8').replace(/^\uFEFF/,''))),dir=path.resolve(flags['out-dir']);
  for(const name of ['workflow.json','review-plan.json'])if(fs.existsSync(path.join(dir,name)))throw Error('Refusing to overwrite existing authoring work: '+path.join(dir,name));
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'workflow.json'),JSON.stringify(result,null,2));
  fs.writeFileSync(path.join(dir,'review-plan.json'),JSON.stringify(result.reviewPlan,null,2));
  console.log(JSON.stringify({status:result.status,tier:result.sizing.tier,targetUsableAreaM2:result.sizing.targetUsableAreaM2,out:dir}));
}
