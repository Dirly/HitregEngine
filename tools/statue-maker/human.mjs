/** Compile a creation catalog into an explicit recipe. No project or asset paths are baked in. */
export function humanRecipe(catalog, options) {
  const { sex = 'male', hood = false, robe = false, shoulders = 'none', hair = true } = options;
  if (!['male','female'].includes(sex)) throw new Error('sex must be male or female');
  if (!['none','simple'].includes(shoulders)) throw new Error('shoulders must be none or simple');
  const slots = catalog.appearance;
  const compatible = o => !o.requires?.sex || o.requires.sex.includes(sex);
  const option = slot => slots.find(s => s.id === slot)?.options.find(compatible);
  const body = slots.find(s => s.id === 'sex')?.options.find(o => o.id === sex), face = option('face');
  if (!body?.parts || !face?.parts) throw new Error('Creation catalog must contain sex and face options');
  const findModel = suffix => catalog.mounts.find(m => m.model.endsWith(suffix) && compatible(m))?.model;
  const source = {head:face.model,hair:findModel('human-hair.glb'),hood:findModel('human-helm.glb'),shoulders:findModel('human-shoulder.glb'),...options.sources};
  const mount = model => {
    const result = catalog.mounts.find(m => m.model === model && compatible(m));
    if (!result) throw new Error(`No ${sex} mount for ${model}`);
    return structuredClone(result);
  };
  const attachments = [{model:source.head,parts:face.parts,mount:mount(source.head)}];
  // The kit hood explicitly hides the hair bases. Never stack intersecting full hair and hood.
  if (hood) attachments.push({model:source.hood,parts:['Hood'],mount:mount(source.hood)});
  else if (hair) attachments.push({model:source.hair,parts:options.hairParts??[sex==='female'?'FemaleBase1':'HairBase3'],mount:mount(source.hair)});
  if (shoulders === 'simple') attachments.push({model:source.shoulders,parts:['ShoulderBase1'],mount:mount(source.shoulders)});
  const prefix = sex === 'female' ? 'F_' : '';
  const parts = [...body.parts,`${prefix}Belt`,`${prefix}Buckle`,...(robe?[`${prefix}RobesFront`,`${prefix}RobesBack`]:[`${prefix}TassetFront`,`${prefix}TassetBack`])];
  const pose = structuredClone(options.pose ?? {kind:'sword-rest',bones:{},hands:{}});
  if (pose.kind === 'sword-rest' && !Object.keys(pose.bones??{}).length) {
    for (const [side,s] of [['left',1],['right',-1]]) {
      const p = side==='left'?'L':'R';
      pose.bones[side]={upper:`CC_Base_${p}_Upperarm`,forearm:`CC_Base_${p}_Forearm`,hand:`CC_Base_${p}_Hand`,finger:`CC_Base_${p}_Index1`};
      pose.hands[side]={target:[s*.13,side==='left'?1.05:1,.34],pole:[s*.9,-.4,-.1],fingerDirection:[-s*.12,-.04,.015]};
    }
  }
  return {version:1,name:options.name,height:options.height,materialId:options.materialId,body:{model:body.model,parts},attachments,pose,...(options.sword?{sword:options.sword}:{}),...(options.pedestal?{pedestal:options.pedestal}:{}),profile:{sex,hood,robe,shoulders,hair:hood?false:hair}};
}
