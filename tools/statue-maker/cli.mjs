import fs from 'node:fs';
import path from 'node:path';
import { buildStatue, assetId, inspectModel, validatePedestalPrefab } from './statue.mjs';
import { humanRecipe } from './human.mjs';
import { previewPng } from './preview.mjs';
const [command,...args]=process.argv.slice(2), flags={};
for(let i=0;i<args.length;i+=2){ if(!args[i].startsWith('--')||args[i+1]===undefined)throw new Error('Expected --name value options'); flags[args[i].slice(2)]=args[i+1]; }
if(command==='inspect'){
 if(!flags.assets||!flags.model)throw new Error('inspect --assets project/assets --model model.glb');
 console.log(JSON.stringify(await inspectModel(fs.readFileSync(path.join(path.resolve(flags.assets),'models',assetId(flags.model)))),null,2));process.exit(0);
}
if(command==='human'){
 if(!flags.catalog||!flags.out||!flags.name||!flags.material||!flags.height)throw new Error('human --catalog creation.json --out recipe.json --name namespace/name --height metres --material materialId [--sex male|female] [--hood yes] [--robe yes] [--shoulders simple] [--sword-model model.glb]');
 const catalog=JSON.parse(fs.readFileSync(flags.catalog,'utf8'));
 const result=humanRecipe(catalog,{name:flags.name,height:Number(flags.height),materialId:flags.material,sex:flags.sex??'male',hood:flags.hood==='yes',robe:flags.robe==='yes',shoulders:flags.shoulders??'none',...(flags['sword-model']?{sword:{model:flags['sword-model'],parts:['Handle','Pummel1','CrossGuard1','Blade1'],pommelHeight:.99,front:.34,width:.25,depth:.12}}:{})});
 fs.mkdirSync(path.dirname(path.resolve(flags.out)),{recursive:true});fs.writeFileSync(flags.out,JSON.stringify(result,null,2));console.log(`Wrote ${flags.out}`);process.exit(0);
}
if (!['build','pack'].includes(command)||!flags.recipe||!flags.assets) throw new Error('Usage: node tools/statue-maker/cli.mjs build|pack --recipe recipe.json --assets project/assets [--report report.json] [--out bundle.json] [--replace yes]');
const recipe=JSON.parse(fs.readFileSync(flags.recipe,'utf8')), root=path.resolve(flags.assets);
assetId(recipe.name);assetId(recipe.materialId);
const pedestalPrefab=recipe.pedestal?JSON.parse(fs.readFileSync(path.join(root,'prefabs',assetId(recipe.pedestal.prefabId)+'.json'),'utf8')):undefined;
const pedestalContract=recipe.pedestal?validatePedestalPrefab(pedestalPrefab,recipe.pedestal):undefined;
const readModel=id=>fs.readFileSync(path.join(root,'models',assetId(id)));
if(command==='pack'){
  if(!flags.out)throw new Error('pack requires --out');
  const ids=[recipe.body.model,...(recipe.attachments??[]).map(a=>a.model),...(recipe.sword?[recipe.sword.model]:[]),...(recipe.pedestal?[recipe.pedestal.model]:[])];
  const models=Object.fromEntries([...new Set(ids)].map(id=>[id,readModel(id).toString('base64')]));
  fs.mkdirSync(path.dirname(path.resolve(flags.out)),{recursive:true});fs.writeFileSync(flags.out,JSON.stringify({recipe,models,...(pedestalPrefab?{pedestalPrefab,pedestalPrefabSha256:pedestalContract.prefabSha256}:{})}));
  console.log(`Packed ${Object.keys(models).length} models into ${flags.out}`);
}else{
  if(!fs.existsSync(path.join(root,'materials',assetId(recipe.materialId)+'.json')))throw new Error('Material asset does not exist');
  if(recipe.pedestal&&!fs.existsSync(path.join(root,'prefabs',assetId(recipe.pedestal.prefabId)+'.json')))throw new Error('Pedestal prefab does not exist');
  const result=await buildStatue(recipe,readModel,{pedestalPrefab,pedestalSource:'asset-file'});
  const outputs=[[`models/${recipe.name}.gltf`,result.model],[`prefabs/${recipe.name}.json`,result.prefab]];
  for(const[file]of outputs)if(fs.existsSync(path.join(root,file))&&flags.replace!=='yes')throw new Error(`Output exists: ${file}; use --replace yes for an intentional rebake`);
  for(const[file,doc]of outputs){const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,JSON.stringify(doc));}
  if(flags.report){fs.mkdirSync(path.dirname(path.resolve(flags.report)),{recursive:true});fs.writeFileSync(flags.report,JSON.stringify(result.report,null,2));}
  if(flags.preview){fs.mkdirSync(path.dirname(path.resolve(flags.preview)),{recursive:true});fs.writeFileSync(flags.preview,await previewPng(result.model));}
  console.log(JSON.stringify(result.report,null,2));
}
