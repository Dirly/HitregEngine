/** Optional project-owned atlas finishing, with explicit pixel preservation. */
import path from 'node:path';
import {pathToFileURL} from 'node:url';

export async function compileProjectPaint(image,theme,recipe,compiler,assets){
  if(!compiler)return {image,mask:new Uint8Array(image.width*image.height),regions:[]};
  if(typeof compiler.module!=='string'||!compiler.module||typeof compiler.export!=='string'||!compiler.export)throw Error('paintCompiler requires module and export names');
  const module=await import(pathToFileURL(path.resolve(assets,compiler.module)).href),compile=module[compiler.export];
  if(typeof compile!=='function')throw Error('Missing paint compiler export '+compiler.export);
  const result=await compile({...image,data:new Uint8Array(image.data)},theme,recipe),output=result?.image,mask=result?.mask;
  if(!output||output.width!==image.width||output.height!==image.height||!(output.data instanceof Uint8Array)||output.data.length!==image.data.length)throw Error('Paint compiler must preserve atlas dimensions and RGBA format');
  if(!mask||mask.length!==image.width*image.height)throw Error('Paint compiler requires a per-pixel change mask');
  for(let i=0;i<mask.length;i++){
    if(mask[i]!==0&&mask[i]!==1)throw Error('Paint compiler mask must contain only 0 or 1');
    if(!mask[i])for(let c=0;c<4;c++)if(output.data[i*4+c]!==image.data[i*4+c])throw Error('Paint compiler changed a protected pixel at '+i);
  }
  return result;
}
