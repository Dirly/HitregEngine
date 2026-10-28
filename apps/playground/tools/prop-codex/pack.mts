/** Reuse the kit atlas packer, while keeping painted images out of the immutable town page. */
import fs from 'node:fs';import path from 'node:path';
import {Atlas,decodeImage,solidImage} from '../../../../tools/wfc-3d/atlas.mjs';
import {readGltf,imageBytes} from '../../../../tools/wfc-3d/gltf.mjs';
import {packAtlas,atlasPaths} from '../../../../tools/wfc-3d/kit.mjs';
import type {GeometryRecord} from './check.mts';
export const PAINTED_ATLAS='codex-craft-painted';
/** Check all retained consumers before either packer writes anything. No density-reducing fallback. */
export function assertAtlasBudget(layout:any,entries:{file:string;out:string;kind:string}[],maxPages:number){
 const atlas=new Atlas({pageSize:2048,pad:4,layout}),byOut=new Map<string,any>();
 for(const s of layout?.sources ?? [])byOut.set(s.out,s);for(const s of entries)byOut.set(s.out,s);
 for(const s of byOut.values()){
  if(!fs.existsSync(s.file))continue;const g=readGltf(s.file);
  for(const material of g.doc.materials ?? []){
   const pbr=material.pbrMetallicRoughness ?? {};
   if(pbr.baseColorTexture){
    const texture=g.doc.textures[pbr.baseColorTexture.index],source=imageBytes(g,texture.source),image=decodeImage(source.bytes,source.mimeType),factor=pbr.baseColorFactor ?? [1,1,1,1];
    if(factor.some((f:number)=>Math.abs(f-1)>1e-6)){const rgba=new Uint8Array(image.rgba);for(let i=0;i<rgba.length;i++)rgba[i]=Math.round(rgba[i]!*Math.max(0,Math.min(1,factor[i%4])));atlas.add({...image,rgba});}
    else atlas.add(image);
   }
   else atlas.add(solidImage(pbr.baseColorFactor ?? [1,1,1,1]));
  }
  if((g.doc.meshes ?? []).some((m:any)=>m.primitives.some((p:any)=>p.material===undefined)))atlas.add(solidImage([1,1,1,1]));
 }
 if(atlas.pages.length>maxPages)throw Error(`Prop atlas needs ${atlas.pages.length} pages; budget is ${maxPages}. Split the collection or deliberately repack unused islands; UVs will not be shrunk.`);
}
export function packBuiltProps(wk:string,built:GeometryRecord[],log:(s:string)=>void=()=>{}){
 const assetsDir=path.join(wk,'assets'),groups=[{atlas:'town-craft',rows:built.filter(g=>!g.paint),max:1},{atlas:PAINTED_ATLAS,rows:built.filter(g=>!!g.paint),max:4}];
 const plans=groups.map(group=>{
  const layoutFile=atlasPaths(assetsDir,group.atlas).layoutFile;
  const existing=fs.existsSync(layoutFile)?JSON.parse(fs.readFileSync(layoutFile,'utf8')):null;
  const moved=new Set(groups.filter(g=>g.atlas!==group.atlas).flatMap(g=>g.rows.map(r=>`models/codex-craft/${r.name}.gltf`)));
  const layout=existing?{...existing,sources:(existing.sources ?? []).filter((s:any)=>!moved.has(s.out))}:null;
  const entries=group.rows.map(r=>({file:path.join(wk,'authoring/codex-craft/source',r.name+'.glb'),out:`models/codex-craft/${r.name}.gltf`,kind:'prop' as const}));
  if(entries.length)assertAtlasBudget(layout,entries,group.max);
  return {...group,layoutFile,existing,layout,entries};
 });
 for(const p of plans){
  if(p.existing&&p.layout.sources.length!==p.existing.sources.length)fs.writeFileSync(p.layoutFile,JSON.stringify(p.layout,null,2)+'\n');
  if(p.entries.length)packAtlas({assetsDir,atlasName:p.atlas,pageSize:2048,pad:4,entries:p.entries,log,warn:(s:string)=>log('! '+s)});
 }
}
