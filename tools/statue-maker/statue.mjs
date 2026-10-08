import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { GltfBuilder } from '../wfc-3d/gltf.mjs';

const require = createRequire(new URL('../../apps/playground/package.json', import.meta.url));
export const T = await import(pathToFileURL(require.resolve('three')).href);
const { GLTFLoader } = await import(pathToFileURL(require.resolve('three/examples/jsm/loaders/GLTFLoader.js')).href);
const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
const { ComponentRegistry, registerCoreComponents, createScene, applyOps, prefabDocSchema, validatePrefab } = await tsImport('../../packages/core/src/index.ts', import.meta.url);
const { partProblems, partRulesSchema } = await tsImport('../../packages/core/src/character/part-rules.ts', import.meta.url);
const V = (...a) => new T.Vector3(...a), Q = () => new T.Quaternion();
const safeId = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*)*$/;
export function assetId(id) {
  if (typeof id !== 'string' || !safeId.test(id) || id.split('/').some(p => p === '..' || p === '.')) throw new Error(`Unsafe asset ID: ${id}`);
  return id;
}
function positive(n, label) { if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} must be positive and finite`); return n; }
function vector(a, label) { if (!Array.isArray(a) || a.length !== 3 || !a.every(Number.isFinite)) throw new Error(`${label} must be three finite numbers`); return a; }

/** Strip source appearance before loading: sculpture preserves geometry, never atlas faces. */
export async function loadModel(bytes) {
  bytes = Buffer.from(bytes);
  let doc, bin;
  if (bytes.readUInt32LE(0) === 0x46546c67) {
    for (let at = 12; at + 8 <= bytes.length;) {
      const length = bytes.readUInt32LE(at), type = bytes.readUInt32LE(at + 4);
      const chunk = bytes.subarray(at + 8, at + 8 + length);
      if (type === 0x4e4f534a) doc = JSON.parse(chunk.toString('utf8'));
      if (type === 0x004e4942) bin = chunk;
      at += 8 + length;
    }
  } else doc = JSON.parse(bytes.toString('utf8'));
  if (!doc) throw new Error('Missing glTF document');
  for (const buffer of doc.buffers ?? []) {
    if (!buffer.uri && bin) buffer.uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;
    if (!buffer.uri?.startsWith('data:')) throw new Error('Use a GLB or self-contained glTF; external buffer URLs are unsupported');
  }
  for (const mesh of doc.meshes ?? []) for (const primitive of mesh.primitives) delete primitive.material;
  delete doc.materials; delete doc.images; delete doc.textures; delete doc.samplers;
  // Node needs only the fetch progress event; no canvas, texture decoder, or DOM shim.
  if (!globalThis.ProgressEvent) globalThis.ProgressEvent = class { constructor(type, init) { this.type = type; Object.assign(this, init); } };
  const model = await new GLTFLoader().parseAsync(JSON.stringify(doc), '');
  model.sourceDoc = doc;
  return model;
}
function tableFor(model) {
  const tables = [model.sourceDoc.extras?.parts, ...model.sourceDoc.meshes.map(m => m.extras?.parts), ...model.sourceDoc.nodes.map(n => n.extras?.parts)].filter(Boolean);
  if (!tables.length) return null;
  return tables[0];
}
export function selectedParts(model, wanted) {
  if (wanted === undefined) return null;
  if (!Array.isArray(wanted) || !wanted.length) throw new Error('Parts must be a nonempty list, or omitted for the entire model');
  const table = tableFor(model);
  if (!table) throw new Error('Selected model has no named parts table');
  const rules = model.sourceDoc.nodes?.find(n=>n.extras?.rules)?.extras.rules;
  if (rules) { const problems = partProblems(partRulesSchema.parse(rules),wanted); if(problems.length) throw new Error(`Invalid part combination: ${problems.join('; ')}`); }
  return wanted.map(name => {
    const value = Array.isArray(table) ? table.findIndex(p => (typeof p === 'string' ? p : p.name) === name) : table[name];
    const index = typeof value === 'number' ? value : value?.index;
    if (!Number.isInteger(index) || index < 0) throw new Error(`Unknown model part: ${name}`);
    return index;
  });
}
export async function inspectModel(bytes) {
  const model=await loadModel(bytes),bones=[];
  model.scene.traverse(o=>{if(o.isBone)bones.push(o.name);});
  return {parts:tableFor(model),bones,clips:model.animations.map(c=>({name:c.name,duration:c.duration})),coordinates:'source world space; human profile expects Y-up, +Z forward'};
}
function getBone(root, name) { const bone = root.getObjectByName(name); if (!bone?.isBone) throw new Error(`Missing rig bone: ${name}`); return bone; }
const pos = o => o.getWorldPosition(V());
function aim(root, bone, child, target) {
  root.updateMatrixWorld(true);
  const current = pos(child).sub(pos(bone)).normalize(), wanted = target.clone().sub(pos(bone)).normalize();
  const world = Q().setFromUnitVectors(current, wanted).multiply(bone.getWorldQuaternion(Q()));
  bone.quaternion.copy(bone.parent.getWorldQuaternion(Q()).invert().multiply(world));
  root.updateMatrixWorld(true);
}
export function poseModel(model, pose = { kind: 'rest' }) {
  const root = model.scene, measurements = [];
  root.updateMatrixWorld(true);
  if (pose.kind === 'clip') {
    const clip = model.animations.find(c => c.name === pose.clip);
    if (!clip) throw new Error(`Unknown animation clip: ${pose.clip}`);
    if (!Number.isFinite(pose.time) || pose.time < 0 || pose.time > clip.duration) throw new Error(`Clip time must be within 0..${clip.duration}`);
    const mixer = new T.AnimationMixer(root); const action = mixer.clipAction(clip);
    action.setLoop(T.LoopOnce, 1); action.clampWhenFinished = true; action.play(); mixer.setTime(pose.time);
  } else if (pose.kind === 'sword-rest') {
    if (!pose.bones || !pose.hands) throw new Error('sword-rest requires explicit bones and hand targets in source units');
    for (const side of ['left', 'right']) {
      const names = pose.bones[side], spec = pose.hands[side];
      if (!names || !spec) throw new Error(`Missing ${side} arm mapping`);
      const upper = getBone(root, names.upper), elbowBone = getBone(root, names.forearm), hand = getBone(root, names.hand), finger = getBone(root, names.finger);
      const start = pos(upper), target = V(...vector(spec.target, 'hand target')), pole = V(...vector(spec.pole, 'elbow pole'));
      const l1 = pos(elbowBone).distanceTo(start), l2 = pos(hand).distanceTo(pos(elbowBone)), dir = target.clone().sub(start), distance = dir.length();
      if (distance >= l1 + l2 || distance <= Math.abs(l1 - l2)) throw new Error(`${side} hand target outside arm reach`);
      dir.normalize(); const along = (l1*l1 - l2*l2 + distance*distance) / (2*distance);
      pole.addScaledVector(dir, -pole.dot(dir)).normalize();
      if (pole.lengthSq() < .5) throw new Error('Elbow pole is parallel to hand target');
      const elbow = start.clone().addScaledVector(dir, along).addScaledVector(pole, Math.sqrt(l1*l1 - along*along));
      aim(root, upper, elbowBone, elbow); aim(root, elbowBone, hand, target);
      aim(root, hand, finger, pos(hand).add(V(...vector(spec.fingerDirection, 'finger direction'))));
      const wristError = pos(hand).distanceTo(target);
      if (wristError > 1e-4) throw new Error(`IK failed: ${side} wrist error ${wristError}`);
      measurements.push({ side, wrist: pos(hand).toArray(), wristError, elbow: pos(elbowBone).toArray() });
    }
  } else if (pose.kind !== 'rest') throw new Error(`Unknown pose kind: ${pose.kind}`);
  for (const [name, rotation] of Object.entries(pose.rotations ?? {})) getBone(root, name).quaternion.multiply(Q().setFromEuler(new T.Euler(...vector(rotation, 'bone rotation').map(T.MathUtils.degToRad))));
  root.updateMatrixWorld(true); root.traverse(o => { if (o.isSkinnedMesh) o.skeleton.update(); });
  return measurements;
}
function mountMatrix(root, mount) {
  if (!mount) return new T.Matrix4();
  const offset = vector(mount.offset ?? [0,0,0], 'mount offset'), rotation = vector(mount.rotationDeg ?? [0,0,0], 'mount rotation');
  const scale = positive(mount.scale ?? 1, 'mount scale');
  const local = new T.Matrix4().compose(V(...offset), Q().setFromEuler(new T.Euler(...rotation.map(T.MathUtils.degToRad))), V(scale,scale,scale));
  return mount.socket ? getBone(root, mount.socket).matrixWorld.clone().multiply(local) : local;
}
function gather(model, parts, matrix, group) {
  const selected = selectedParts(model, parts), triangles = [], seen = new Set();
  model.scene.updateMatrixWorld(true);
  model.scene.traverse(mesh => {
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry, p = geometry.getAttribute('position'), part = geometry.getAttribute('uv1'), index = geometry.index;
    if (selected && !part) throw new Error('Named part selection requires TEXCOORD_1/uv1 part IDs');
    for (let k = 0; k < (index?.count ?? p.count); k += 3) {
      let ids = [0,1,2].map(j => index ? index.getX(k+j) : k+j);
      if (selected) { const id = Math.round(part.getX(ids[0])); if (!selected.includes(id)) continue; seen.add(id); }
      const points = ids.map(i => {
        const v = mesh.getVertexPosition(i, V());
        return v.applyMatrix4(mesh.matrixWorld).applyMatrix4(matrix);
      });
      if (matrix.determinant() * mesh.matrixWorld.determinant() < 0) points.reverse();
      if (points.some(p => !p.toArray().every(Number.isFinite))) throw new Error('Non-finite posed vertex');
      triangles.push({ p: points, group, color: [177,174,158] });
    }
  });
  if (!triangles.length || selected?.some(id => !seen.has(id))) throw new Error('Part selection contains empty geometry');
  return triangles;
}
/** Area-weighted welded normals. Positions and triangles are never rounded or moved. */
export function smoothNormals(triangles, tolerance = 1e-6) {
  const incident = new Map(), rows = [];
  for (const tri of triangles) {
    const normal = V().crossVectors(tri.p[1].clone().sub(tri.p[0]), tri.p[2].clone().sub(tri.p[0]));
    const unit=normal.clone().normalize();
    const row = tri.p.map(p => `${tri.group}:${p.toArray().map(n => Math.round(n/tolerance)).join(',')}`);
    rows.push({row,unit});
    for (const key of row) { if (!incident.has(key)) incident.set(key, []); incident.get(key).push({normal,unit}); }
  }
  // Coincident opposite sheet faces belong to opposite smoothing hemispheres.
  // Otherwise they cancel, giving arbitrary fallback normals on thin robes/blades.
  return rows.flatMap(({row,unit})=>row.flatMap(key=>{
    const n=V();for(const face of incident.get(key))if(unit.dot(face.unit)>-.95)n.add(face.normal);
    return (n.lengthSq()?n.normalize():unit.lengthSq()?unit:V(0,1,0)).toArray();
  }));
}
/** Validate ground bearings against an actual baked pedestal, in its prefab's local frame. */
export function validatePedestal(triangles, pedestal, offset, tolerance = .06) {
  positive(offset, 'pedestal height');
  const bounds = new T.Box3().setFromPoints(pedestal.flatMap(t=>t.p));
  if (Math.abs(bounds.min.y)>tolerance || Math.abs(bounds.max.y-offset)>tolerance) throw new Error('Pedestal model bounds disagree with its foot anchor or declared height');
  const groups = new Map();
  // The lowest point of each lateral half and each separate object is a bearing.
  // This catches both feet and the sword, without confusing toes with ankle vertices.
  for(const triangle of triangles)for(const p of triangle.p){const key=`${triangle.group}:${p.x<0?'left':'right'}`;if(!groups.has(key)||p.y<groups.get(key).y)groups.set(key,p);}
  const figureBounds=new T.Box3().setFromPoints(triangles.flatMap(t=>t.p));
  const samples=[...groups].filter(([,p])=>p.y<figureBounds.max.y*.025);
  const reports=[];
  for(const [part,p]of samples){
    const ray=new T.Ray(V(p.x,bounds.max.y+1,p.z),V(0,-1,0));let hitY=-Infinity;
    for(const triangle of pedestal){const hit=ray.intersectTriangle(...triangle.p,false,V());if(hit)hitY=Math.max(hitY,hit.y);}
    const gap=p.y+offset-hitY;
    if(!Number.isFinite(hitY)||gap>tolerance||gap< -tolerance)throw new Error(`Pedestal bearing failed for ${part}: gap ${gap}m`);
    reports.push({part,point:[p.x,p.y+offset,p.z],supportY:hitY,gap});
  }
  if(!reports.length)throw new Error('No sculpture bearing samples');
  return {bounds:[bounds.min.toArray(),bounds.max.toArray()],tolerance,bearings:reports};
}
export function validatePedestalPrefab(raw, pedestal) {
  assetId(pedestal.prefabId); assetId(pedestal.model);
  const prefab=prefabDocSchema.parse(raw);validatePrefab(prefab);
  const root=prefab.entities[prefab.root];
  if(root.components.mesh||root.components.collider)throw new Error('Pedestal prefab needs an empty anchor');
  const meshes=Object.entries(prefab.entities).filter(([,entity])=>entity.components.mesh);
  if(meshes.length!==1)throw new Error('Pedestal prefab must contain exactly its one baked model');
  const [id,entity]=meshes[0],mesh=entity.components.mesh;
  if(mesh.source?.kind!=='asset'||mesh.source.assetId!==pedestal.model)throw new Error('Pedestal prefab model does not match the bearing model');
  for(let current=id;current;current=prefab.entities[current].parent){
    const e=prefab.entities[current],t=e.components.transform??{};
    if(e.components.prefab)throw new Error('Pedestal prefab may not nest another prefab');
    const matrix=new T.Matrix4().compose(V(...(t.position??[0,0,0])),new T.Quaternion(...(t.rotation??[0,0,0,1])),V(...(t.scale??[1,1,1])));
    if(matrix.elements.some((n,i)=>Math.abs(n-new T.Matrix4().elements[i])>1e-8))throw new Error('Pedestal model and anchor transforms must be identity');
  }
  if(Object.values(prefab.entities).some(e=>e.components.prefab))throw new Error('Pedestal prefab may not nest another prefab');
  return {prefabSha256:createHash('sha256').update(JSON.stringify(raw)).digest('hex'),model:pedestal.model};
}
export async function buildStatue(recipe, readModel, options = {}) {
  if (recipe.version !== 1) throw new Error('Recipe version must be 1');
  assetId(recipe.name); assetId(recipe.materialId); positive(recipe.height, 'height');
  const pedestalContract=recipe.pedestal?validatePedestalPrefab(options.pedestalPrefab,recipe.pedestal):null;
  if (recipe.height > 200) throw new Error('Statue height must be <= 200m');
  const hashes = {}, cache = new Map();
  async function load(id) {
    assetId(id);
    if (!cache.has(id)) { const bytes = await readModel(id); hashes[id] = createHash('sha256').update(bytes).digest('hex'); cache.set(id, bytes); }
    return loadModel(cache.get(id));
  }
  const body = await load(recipe.body.model), measurements = poseModel(body, recipe.pose);
  let triangles = gather(body, recipe.body.parts, new T.Matrix4(), 'body');
  for (const [i, attachment] of (recipe.attachments ?? []).entries()) {
    const model = await load(attachment.model);
    triangles.push(...gather(model, attachment.parts, mountMatrix(body.scene, attachment.mount), `attachment-${i}`));
    // Creation mounts mirror the right-hand copy across the model's local Z.
    if (attachment.mount?.mirrorTo) triangles.push(...gather(model, attachment.parts, mountMatrix(body.scene, { ...attachment.mount, ...attachment.mount.mirrorTo }).multiply(new T.Matrix4().makeScale(1,1,-1)), `attachment-${i}-mirror`));
  }
  const humanBounds = new T.Box3().setFromPoints(triangles.flatMap(t => t.p)), floor = humanBounds.min.y;
  const scale = recipe.height / positive(humanBounds.max.y - floor, 'source height');
  for (const tri of triangles) for (const p of tri.p) p.set(p.x*scale, (p.y-floor)*scale, p.z*scale);
  let swordReport;
  if (recipe.sword) {
    if (recipe.pose?.kind !== 'sword-rest') throw new Error('Point-down sword requires sword-rest pose');
    const sword = await load(recipe.sword.model), st = gather(sword, recipe.sword.parts, new T.Matrix4(), 'sword');
    const box = new T.Box3().setFromPoints(st.flatMap(t => t.p)), center = box.getCenter(V());
    const top = positive(recipe.sword.pommelHeight, 'sword pommel height'), front = recipe.sword.front;
    if (!Number.isFinite(front)) throw new Error('sword.front must be finite');
    const width = positive(recipe.sword.width, 'sword width'), depth = positive(recipe.sword.depth, 'sword depth');
    for (const tri of st) for (const p of tri.p) { const q = p.clone(); p.set((q.z-center.z)*width*scale/(box.max.z-box.min.z), (box.max.y-q.y)*top*scale/(box.max.y-box.min.y), front*scale+(q.x-center.x)*depth*scale/(box.max.x-box.min.x)); }
    // This source-axis permutation has positive determinant; winding is preserved.
    triangles.push(...st); swordReport = { tipY: 0, pommelY: top*scale, front: front*scale };
  }
  const bounds = new T.Box3().setFromPoints(triangles.flatMap(t => t.p));
  const positions = new Float32Array(triangles.flatMap(t => t.p.flatMap(p => p.toArray()))), normals = new Float32Array(smoothNormals(triangles));
  const builder = new GltfBuilder('HitReg statue-maker v1: static baked sculpture');
  const weights = new Float32Array(positions.length/3*4);
  for(let i=0;i<positions.length/3;i++) weights.set([0,1,0,0],i*4);
  const attributes = { POSITION: builder.pushAccessor(positions,'VEC3',{minMax:true}), NORMAL: builder.pushAccessor(normals,'VEC3'), _SPLATWEIGHT: builder.pushAccessor(weights,'VEC4') };
  builder.pushMesh({ name: recipe.name, primitives: [{attributes, mode:4}] }); builder.pushNode({name:recipe.name,mesh:0},true);
  const model = builder.finish(), offset = recipe.pedestal ? positive(recipe.pedestal.height, 'pedestal height') : 0;
  let pedestalReport;
  if(recipe.pedestal){
    if(!recipe.pedestal.model)throw new Error('Pedestal requires its baked model for actual bearing validation');
    const base=await load(recipe.pedestal.model);
    if(base.animations.length||base.sourceDoc.skins?.length)throw new Error('Pedestal must be a static baked model');
    const baseTriangles=gather(base,undefined,new T.Matrix4(),'pedestal');
    pedestalReport={...validatePedestal(triangles,baseTriangles,offset),...pedestalContract,destinationPrefabVerified:options.pedestalSource==='asset-file'};
  }
  const entities = { anchor: {name:recipe.name,parent:null,tags:['statue'],components:{transform:{}}}, sculpture:{name:'Sculpture',parent:'anchor',tags:[],components:{transform:{position:[0,offset,0]},mesh:{source:{kind:'asset',assetId:`${recipe.name}.gltf`},material:recipe.materialId,castShadow:true,receiveShadow:true},collider:{shape:'trimesh'}}} };
  if (recipe.pedestal) entities.pedestal = {name:'Pedestal',parent:'anchor',tags:[],components:{transform:{},prefab:{prefabId:assetId(recipe.pedestal.prefabId)}}};
  const registry = new ComponentRegistry(); registerCoreComponents(registry);
  const {doc} = applyOps(createScene(recipe.name), Object.entries(entities).map(([id,entity]) => ({op:'add-entity',id,entity})), registry);
  const prefab = prefabDocSchema.parse({...doc,root:'anchor',props:{}}); validatePrefab(prefab);
  const report = {version:1,name:recipe.name,height:bounds.max.y-bounds.min.y,figureHeight:recipe.height,bounds:[bounds.min.toArray(),bounds.max.toArray()],scale,triangles:triangles.length,measurements,sword:swordReport,sourceHashes:hashes,skins:0,animations:0,shading:'smooth area-weighted welded normals; unchanged geometry',pedestal:pedestalReport??null};
  return {model,prefab,report,triangles};
}
