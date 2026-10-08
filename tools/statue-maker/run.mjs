import fs from 'node:fs/promises';
import path from 'node:path';
import { buildStatue, assetId } from './statue.mjs';
import { previewPng } from './preview.mjs';

export async function run(context, inputs) {
  if (!context.assetExists || !context.writeAsset) throw new Error('Asset writer and existence checks are required');
  const bundle = JSON.parse(Buffer.from(inputs.bundle.data,'base64').toString('utf8'));
  const recipe = bundle.recipe;
  assetId(recipe.name);assetId(recipe.materialId);if(recipe.pedestal)assetId(recipe.pedestal.prefabId);
  if (!context.assetExists(`materials/${recipe.materialId}.json`)) throw new Error(`Missing material ${recipe.materialId}`);
  if (recipe.pedestal && !context.assetExists(`prefabs/${recipe.pedestal.prefabId}.json`)) throw new Error('Missing pedestal prefab');
  const result = await buildStatue(recipe, id => { if (!bundle.models?.[id]) throw new Error(`Missing bundled model ${id}`); return Buffer.from(bundle.models[id],'base64'); },{pedestalPrefab:bundle.pedestalPrefab,pedestalSource:'bundle'});
  if(recipe.pedestal&&bundle.pedestalPrefabSha256!==result.report.pedestal.prefabSha256)throw new Error('Bundled pedestal document hash mismatch');
  const outputs = [{kind:'model',id:`${recipe.name}.gltf`,file:`models/${recipe.name}.gltf`,doc:result.model},{kind:'prefab',id:recipe.name,file:`prefabs/${recipe.name}.json`,doc:result.prefab}];
  for (const out of outputs) if(context.assetExists(out.file)) throw new Error(`Output exists: ${out.file}; choose a new recipe name`);
  await fs.mkdir(context.runDir,{recursive:true});
  await fs.writeFile(path.join(context.runDir,'recipe.json'),JSON.stringify(recipe,null,2));
  await fs.writeFile(path.join(context.runDir,'report.json'),JSON.stringify(result.report,null,2));
  const preview=await previewPng(result.model,320);
  await fs.writeFile(path.join(context.runDir,'clay-preview.png'),preview);
  for (const out of outputs) await context.writeAsset(out.file,Buffer.from(JSON.stringify(out.doc)));
  return {assets:outputs.map(({doc,...out})=>out),previews:[{label:'Exported smooth normals: neutral clay',mediaType:'image/png',data:preview.toString('base64')}],warnings:recipe.pedestal?['Pedestal bearing geometry and bundled prefab verified; this host cannot read the destination prefab to certify that it matches the bundled document.']:[],report:result.report,log:`Baked ${result.report.triangles} triangles, ${result.report.height.toFixed(3)}m; no skins or animations.`};
}
