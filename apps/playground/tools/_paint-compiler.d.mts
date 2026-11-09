export type PaintImage={width:number;height:number;data:Uint8Array};
export type PaintCompiler={module:string;export:string};
export function compileProjectPaint(image:PaintImage,theme:string,recipe:string,compiler:PaintCompiler|null|undefined,assets:string):Promise<{image:PaintImage;mask:Uint8Array;regions:unknown[]}>;
