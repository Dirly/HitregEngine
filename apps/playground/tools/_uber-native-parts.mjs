/** Append native-UV modular parts and small theme tiles without disturbing an existing ubermesh page. */
import fs from 'node:fs';
import path from 'node:path';
import {decodePng,encodePng} from './_png.mjs';

export function readUber(bytes){
 const jl=bytes.readUInt32LE(12),json=JSON.parse(bytes.subarray(20,20+jl)),bin=bytes.subarray(28+jl,28+jl+bytes.readUInt32LE(20+jl));
 const node=json.nodes.find(n=>n.extras?.parts),primitive=json.meshes[node.mesh].primitives[0];
 const values=index=>{const a=json.accessors[index],v=json.bufferViews[a.bufferView],dims={SCALAR:1,VEC2:2,VEC3:3,VEC4:4}[a.type],size={5121:1,5123:2,5125:4,5126:4}[a.componentType],stride=v.byteStride??dims*size,start=(v.byteOffset??0)+(a.byteOffset??0);return Array.from({length:a.count},(_,i)=>Array.from({length:dims},(_,c)=>{const o=start+i*stride+c*size;return a.componentType===5126?bin.readFloatLE(o):a.componentType===5125?bin.readUInt32LE(o):a.componentType===5123?bin.readUInt16LE(o):bin[o];}));};
 const order=primitive.indices===undefined?Array.from({length:json.accessors[primitive.attributes.POSITION].count},(_,i)=>i):values(primitive.indices).flat();
 const attributes=Object.fromEntries(Object.entries(primitive.attributes).map(([name,index])=>{const a=values(index);return[name,order.map(i=>a[i])];}));
 return{json,bin,node,primitive,attributes};
}
export function writeUber(doc,page){
 const{json,node,primitive,attributes}=doc,chunks=[],views=[],accessors=[];let at=0;
 const add=(bytes,target)=>{const pad=(4-at%4)%4;if(pad){chunks.push(Buffer.alloc(pad));at+=pad;}const i=views.length;views.push({buffer:0,byteOffset:at,byteLength:bytes.length,...(target?{target}:{})});chunks.push(bytes);at+=bytes.length;return i;};
 const attrs={};
 for(const[name,values]of Object.entries(attributes)){
  const n=values[0].length,view=add(Buffer.from(new Float32Array(values.flat()).buffer),34962),a={bufferView:view,componentType:5126,count:values.length,type:{1:'SCALAR',2:'VEC2',3:'VEC3',4:'VEC4'}[n]};
  if(name==='POSITION'){a.min=[0,1,2].map(c=>Math.min(...values.map(v=>v[c])));a.max=[0,1,2].map(c=>Math.max(...values.map(v=>v[c])));}
  attrs[name]=accessors.length;accessors.push(a);
 }
 primitive.attributes=attrs;delete primitive.indices;
 const material=json.materials[primitive.material??0],textureIndex=material.pbrMetallicRoughness.baseColorTexture.index,imageIndex=json.textures[textureIndex].source;
 json.images[imageIndex]={bufferView:add(encodePng(page.width,page.height,page.data)),mimeType:'image/png'};
 const bin=Buffer.concat(chunks),padded=Buffer.concat([bin,Buffer.alloc((4-bin.length%4)%4)]);json.buffers=[{byteLength:padded.length}];json.bufferViews=views;json.accessors=accessors;
 // These atlas ubermeshes are static one-primitive modules. Refuse a hidden second geometry/image dependency.
 if(json.meshes.length!==1||json.images.length!==1||json.skins?.length||json.animations?.length)throw Error('Native-part append requires a static single-mesh, single-page ubermesh');
 let js=Buffer.from(JSON.stringify(json));js=Buffer.concat([js,Buffer.alloc((4-js.length%4)%4,32)]);
 const h=Buffer.alloc(20),bh=Buffer.alloc(8);h.writeUInt32LE(0x46546c67);h.writeUInt32LE(2,4);h.writeUInt32LE(28+js.length+padded.length,8);h.writeUInt32LE(js.length,12);h.writeUInt32LE(0x4e4f534a,16);bh.writeUInt32LE(padded.length);bh.writeUInt32LE(0x004e4942,4);return Buffer.concat([h,js,bh,padded]);
}
export function embeddedPage(doc){
 const{json,bin,primitive}=doc,m=json.materials[primitive.material??0],ti=m.pbrMetallicRoughness.baseColorTexture.index,im=json.images[json.textures[ti].source],v=json.bufferViews[im.bufferView];return decodePng(bin.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength));
}
function mergeRules(old,extra){
 const result=structuredClone(old??{});
 for(const[k,v]of Object.entries(extra??{}))if(k==='oneOf')result[k]=[...(result[k]??[]),...v.filter(group=>!(result[k]??[]).some(g=>JSON.stringify(g)===JSON.stringify(group)))];else{result[k]??={};for(const[name,values]of Object.entries(v))result[k][name]=[...new Set([...(result[k][name]??[]),...values])];}
 return result;
}
export function appendNativeParts(bytes,extension,assets){
 const target=readUber(bytes);let page=embeddedPage(target);const oldParts={...target.node.extras.parts},oldTiles={...target.node.extras.tiles},pad=extension.gutter??8;
 // Re-derive an extension in place so a changed source/fit does not leave stale compiled parts.
 const replacing=new Set((extension.parts??[]).map(p=>oldParts[p.name]).filter(i=>i!==undefined));
 if(replacing.size){const keep=target.attributes.TEXCOORD_1.map((v,i)=>replacing.has(Math.round(v[0]))?-1:i).filter(i=>i>=0);for(const[name,values]of Object.entries(target.attributes))target.attributes[name]=keep.map(i=>values[i]);for(const spec of extension.parts)delete target.node.extras.parts[spec.name];}
 const native=(extension.textures??[]).map(texture=>{const id=typeof texture==='string'?texture:texture.id,source=typeof texture!=='string'&&texture.sourceFile?path.resolve(assets,texture.sourceFile):path.join(assets,'textures',id),p=decodePng(fs.readFileSync(source));if(p.width!==p.height)throw Error(`${id}: native tile must be square`);return{id,source,p,aliasOf:typeof texture==='object'?texture.aliasOf:undefined,copy:typeof texture==='object'&&!!texture.sourceFile};}),managed=new Set(native.map(n=>n.id)),repacked=new Set(extension.repackTextures?(extension.repackTextureIds??[...managed]):[]),retained=Object.fromEntries(Object.entries(oldTiles).filter(([id])=>!repacked.has(id))),originalPage=page,basePad=target.node.extras.pageGutter??8;
 let packed,growth=1;
 for(const id of repacked)if(!managed.has(id))throw Error(`Only declared native textures may be repacked: ${id}`);
 for(const factor of extension.repackTextures?(extension.pageGrowthFactors??[1]):[1]){
  if(!Number.isInteger(factor)||factor<1)throw Error('Native page growth must use positive integer nearest repeats');
  const W=originalPage.width*factor,H=originalPage.height*factor;if(W>(extension.maxPageSize??Infinity)||H>(extension.maxPageSize??Infinity))continue;
  const used=Object.values(retained).map(([u,v,s])=>({x:Math.round(u*W)-basePad*factor,y:Math.round(v*H)-basePad*factor,w:Math.round(s*W)+basePad*factor*2,h:Math.round(s*W)+basePad*factor*2})),tiles={...retained},spots=[];let okay=true;
  for(const n of native){
   if(n.aliasOf){const donor=native.find(v=>v.id===n.aliasOf);if(!donor||!tiles[n.aliasOf]||donor.p.width!==n.p.width||!Buffer.from(donor.p.data).equals(Buffer.from(n.p.data)))throw Error(`Native alias ${n.id} must exactly match its earlier source ${n.aliasOf}`);tiles[n.id]=tiles[n.aliasOf].slice();spots.push({id:n.id,aliasOf:n.aliasOf,size:n.p.width});continue;}
   const w=n.p.width+pad*2,xs=[...new Set([0,...used.map(r=>r.x+r.w)])].sort((a,b)=>a-b),ys=[...new Set([0,...used.map(r=>r.y+r.h)])].sort((a,b)=>a-b);let spot;
   if(!repacked.has(n.id)&&tiles[n.id]){const[u,v,s]=tiles[n.id];if(Math.round(s*W)!==n.p.width)throw Error(`Native tile size changed for ${n.id}; repack explicitly`);spot={x:Math.round(u*W)-pad,y:Math.round(v*H)-pad,w,h:w};}
   else for(const y of ys){for(const x of xs)if(x>=0&&y>=0&&x+w<=W&&y+w<=H&&!used.some(r=>x<r.x+r.w&&x+w>r.x&&y<r.y+r.h&&y+w>r.y)){spot={x,y,w,h:w};break;}if(spot)break;}
   if(!spot){okay=false;break;}used.push(spot);tiles[n.id]=[(spot.x+pad)/W,(spot.y+pad)/H,n.p.width/W];spots.push({id:n.id,size:n.p.width,...spot});
  }
  if(okay){packed={W,H,tiles,spots};growth=factor;break;}
 }
 if(!packed)throw Error('Native tiles do not fit; explicitly authorize repacking/page growth');
 if(growth!==1){const data=new Uint8Array(packed.W*packed.H*4);for(let y=0;y<packed.H;y++)for(let x=0;x<packed.W;x++){const s=(Math.floor(y/growth)*originalPage.width+Math.floor(x/growth))*4;data.set(originalPage.data.subarray(s,s+4),(y*packed.W+x)*4);}page={width:packed.W,height:packed.H,data};target.node.extras.pageGutter=basePad*growth;target.node.extras.pageIntegerScale=(target.node.extras.pageIntegerScale??1)*growth;}
 target.node.extras.tiles=packed.tiles;const placed=packed.spots;
 for(const n of native){if(n.copy){const dest=path.join(assets,'textures',n.id);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(n.source,dest);}if(n.aliasOf)continue;const spot=placed.find(v=>v.id===n.id);for(let y=-pad;y<n.p.height+pad;y++)for(let x=-pad;x<n.p.width+pad;x++){const s=(Math.max(0,Math.min(n.p.height-1,y))*n.p.width+Math.max(0,Math.min(n.p.width-1,x)))*4;page.data.set(n.p.data.subarray(s,s+4),((spot.y+pad+y)*page.width+spot.x+pad+x)*4);}}
 const appended=[];
 for(const spec of extension.parts??[]){
  const sourceFile=spec.sourceFile?path.resolve(assets,spec.sourceFile):path.join(assets,'models',spec.sourceModel),src=readUber(fs.readFileSync(sourceFile)),sourceNames=[].concat(spec.from),sourceIndices=sourceNames.map(name=>src.node.extras.parts[name]);if(sourceIndices.some(i=>i===undefined))throw Error(`Unknown source part ${spec.from}`);
  const index=oldParts[spec.name]??Math.max(...Object.values(target.node.extras.parts))+1;if(index>=24)throw Error('Ubermesh part-mask limit24 exceeded');
  const keep=src.attributes.TEXCOORD_1.map((v,i)=>sourceIndices.includes(Math.round(v[0]))?i:-1).filter(i=>i>=0);if(!keep.length)throw Error(`Empty source part ${spec.from}`);
  let rows=keep.map(i=>Object.fromEntries(Object.entries(src.attributes).map(([name,values])=>[name,values[i].slice()])));
  if(spec.clip){
   const axis={x:0,y:1,z:2}[spec.clip.axis],limit=spec.clip.max,clipped=[];
   for(let i=0;i<rows.length;i+=3){let polygon=rows.slice(i,i+3),out=[];for(let a=0;a<polygon.length;a++){const p=polygon[a],q=polygon[(a+1)%polygon.length],inside=p.POSITION[axis]<=limit,other=q.POSITION[axis]<=limit;if(inside)out.push(p);if(inside!==other){const t=(limit-p.POSITION[axis])/(q.POSITION[axis]-p.POSITION[axis]),r=Object.fromEntries(Object.keys(p).map(name=>[name,p[name].map((v,c)=>v+(q[name][c]-v)*t)]));const len=Math.hypot(...r.NORMAL);r.NORMAL=r.NORMAL.map(v=>v/len);out.push(r);}}for(let j=1;j+1<out.length;j++)clipped.push(out[0],out[j],out[j+1]);}
   rows=clipped;
  }
  const positions=rows.map(row=>row.POSITION.map((v,c)=>Math.fround(v+(spec.normalOffset??0)*row.NORMAL[c])));
  if(spec.scale){const lo=[0,1,2].map(c=>Math.min(...positions.map(v=>v[c]))),hi=[0,1,2].map(c=>Math.max(...positions.map(v=>v[c]))),pivot=lo.map((v,c)=>spec.anchor?.[c]==='min'?v:spec.anchor?.[c]==='max'?hi[c]:(v+hi[c])/2);for(const p of positions)for(let c=0;c<3;c++)p[c]=Math.fround(pivot[c]+(p[c]-pivot[c])*spec.scale[c]+(spec.translate?.[c]??0));}
  let project;
  if(spec.uvProjection){
   const axis=name=>({x:0,y:1,z:2}[name.replace('-','')]),u=axis(spec.uvProjection.u),v=axis(spec.uvProjection.v),us=spec.uvProjection.u.startsWith('-')?-1:1,vs=spec.uvProjection.v.startsWith('-')?-1:1;
   const lo=[Math.min(...positions.map(p=>p[u]*us)),Math.min(...positions.map(p=>p[v]*vs))],hi=[Math.max(...positions.map(p=>p[u]*us)),Math.max(...positions.map(p=>p[v]*vs))],box=spec.uvProjection.box;
   project=p=>[box[0]+(p[u]*us-lo[0])/(hi[0]-lo[0])*box[2],box[1]+(p[v]*vs-lo[1])/(hi[1]-lo[1])*box[3]];
  }
  for(const[name,out]of Object.entries(target.attributes)){
   if(!src.attributes[name])throw Error(`Missing native attribute ${name}`);
   for(const [ki,row]of rows.entries()){let value=row[name].slice();if(name==='TEXCOORD_1')value[0]=index;
    if(name==='POSITION')value=positions[ki];
    if(name==='NORMAL'&&spec.scale){value=value.map((v,c)=>v/spec.scale[c]);const len=Math.hypot(...value);value=value.map(v=>Math.fround(v/len));}
    if(name==='TEXCOORD_0'&&project)value=project(positions[ki]);
    out.push(value);
   }
  }
  target.node.extras.parts[spec.name]=index;appended.push({name:spec.name,index,sourceModel:spec.sourceModel,sourcePart:spec.from,vertices:rows.length,nativeUvsUnchanged:!project&&!spec.clip,normalOffset:spec.normalOffset??0,...(spec.clip?{clip:spec.clip}:{})});
 }
 target.node.extras.rules=mergeRules(target.node.extras.rules,extension.rules);
 target.node.extras.nativeParts={...(target.node.extras.nativeParts??{}),[extension.id]:{parts:extension.parts,textures:extension.textures,gutter:pad}};
 for(const[name,index]of Object.entries(oldParts))if(target.node.extras.parts[name]!==index)throw Error(`Old part index changed: ${name}`);
 for(const[id,tile]of Object.entries(retained))if(JSON.stringify(target.node.extras.tiles[id])!==JSON.stringify(tile))throw Error(`Old tile changed: ${id}`);
 return{bytes:writeUber(target,page),report:{appended,placed,pageSize:[page.width,page.height],pageGrowthInteger:growth,logicalPagePixelsPreservedByNearestRepeat:true,oldPartIndicesUnchanged:true,oldTileRectanglesUnchanged:!repacked.size,retainedTileRectanglesUnchanged:true,repackedNativeTextures:[...repacked]}};
}
