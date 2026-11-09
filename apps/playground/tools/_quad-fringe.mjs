/** Reposition repeated two-triangle cards along a reusable edge; retain their UVs. */
export function layoutQuadFringe(positions,uv,layout){
 if(positions.length%6||positions.length!==uv.length)throw Error('Quad fringe requires consecutive six-corner cards');
 const path=layout.path,lengths=[0];for(let i=1;i<path.length;i++)lengths.push(lengths[i-1]+Math.hypot(...path[i].map((v,a)=>v-path[i-1][a])));
 const count=positions.length/6,out=[];
 for(let q=0;q<count;q++){
  const along=lengths.at(-1)*(q+.5)/count;let k=1;while(k<lengths.length-1&&lengths[k]<along)k++;
  const t=(along-lengths[k-1])/(lengths[k]-lengths[k-1]),center=path[k].map((v,a)=>path[k-1][a]+(v-path[k-1][a])*t),delta=path[k].map((v,a)=>v-path[k-1][a]),L=Math.hypot(delta[0],delta[1]),right=[delta[0]/L,delta[1]/L,0],up=[-right[1],right[0],layout.lean??-.18],U=Math.hypot(...up);for(let a=0;a<3;a++)up[a]/=U;
  const card=uv.slice(q*6,q*6+6),lo=[0,1].map(a=>Math.min(...card.map(v=>v[a]))),hi=[0,1].map(a=>Math.max(...card.map(v=>v[a])));
  for(const p of card){const x=((p[0]-lo[0])/(hi[0]-lo[0])-.5)*layout.width,y=(.5-(p[1]-lo[1])/(hi[1]-lo[1]))*layout.height;out.push(center.map((v,a)=>Math.fround(v+x*right[a]+y*up[a])));}
 }
 return out;
}
