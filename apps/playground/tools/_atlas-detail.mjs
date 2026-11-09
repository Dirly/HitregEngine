/** Integer-nearest base pixels with fresh high-resolution paint only in selected key islands. */
import{resampleOrnament}from'./_ornament-pixels.mjs';
export function selectiveAtlasDetail(base,fresh,key,{size,hexes,dilate=0,logicalRegions=[]}){
 if(size%base.width||base.width!==base.height||fresh.width!==size||fresh.height!==size)throw Error('Selective detail needs square sheets and integer base scale');
 const mask=new Uint8Array(size*size),colors=hexes.map(h=>[1,3,5].map(i=>parseInt(h.slice(i,i+2),16)));
 for(let y=0;y<key.height;y++)for(let x=0;x<key.width;x++){const i=(y*key.width+x)*4;if(colors.some(c=>c.every((v,k)=>key.data[i+k]===v)))mask[Math.floor(y*size/key.height)*size+Math.floor(x*size/key.width)]=1;}
 for(let n=0;n<dilate;n++){const old=mask.slice();for(let y=0;y<size;y++)for(let x=0;x<size;x++)if(old[y*size+x])for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]){const X=x+dx,Y=y+dy;if(X>=0&&Y>=0&&X<size&&Y<size)mask[Y*size+X]=1;}}
 const data=new Uint8Array(size*size*4);for(let y=0;y<size;y++)for(let x=0;x<size;x++){const i=y*size+x,s=mask[i]?i:(Math.floor(y*base.width/size)*base.width+Math.floor(x*base.width/size)),source=mask[i]?fresh:base;data.set(source.data.subarray(s*4,s*4+4),i*4);}let image={width:size,height:size,data};for(const region of logicalRegions)image=resampleOrnament(image,key,region.hexes,region.size,{coverage:region.coverage??false,dilate:region.dilate??0}).image;return image;
}
