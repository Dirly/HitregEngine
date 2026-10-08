// World-space mesh positions and UVs, after instance transforms. Values are measured,
// not inferred from a material's declared scale. Singular values catch directional stretch.
export function checkTriangleTexels(vertices, uv, textureSize, target, tolerance=.1) {
  const a=vertices[1].map((x,i)=>x-vertices[0][i]),b=vertices[2].map((x,i)=>x-vertices[0][i]);
  const u=(uv[1][0]-uv[0][0])*textureSize[0],v=(uv[1][1]-uv[0][1])*textureSize[1],s=(uv[2][0]-uv[0][0])*textureSize[0],t=(uv[2][1]-uv[0][1])*textureSize[1],det=u*t-v*s;
  if(!Number.isFinite(det)||Math.abs(det)<1e-10)return {passed:false,reason:'Degenerate texture coordinates'};
  const x=a.map((q,i)=>(q*t-b[i]*v)/det),y=a.map((q,i)=>(b[i]*u-q*s)/det),dot=(a,b)=>a.reduce((sum,q,i)=>sum+q*b[i],0),xx=dot(x,x),yy=dot(y,y),xy=dot(x,y),d=Math.sqrt((xx-yy)**2+4*xy*xy);
  const scales=[Math.sqrt(Math.max(0,(xx+yy-d)/2)),Math.sqrt(Math.max(0,(xx+yy+d)/2))];
  return {passed:scales.every(s=>Number.isFinite(s)&&Math.abs(s/target-1)<=tolerance),metresPerTexel:scales,target,tolerance,anisotropy:scales[1]/scales[0]};
}
// A coverage gate for the requested perimeter screen. It proves distribution,
// not opacity: player-height sightline images are still required.
export function checkGrovePerimeter(trees,{center,radius,outerRadius,sectors=12,minPerSector=2,minOccupied=9}) {
  const counts=Array(sectors).fill(0);
  for(const p of trees){const dx=p[0]-center[0],dz=p[2]-center[1],r=Math.hypot(dx,dz);if(r<radius||r>outerRadius)continue;const i=Math.floor(((Math.atan2(dz,dx)+2*Math.PI)%(2*Math.PI))/(2*Math.PI)*sectors);counts[i]++}
  const occupied=counts.filter(n=>n>=minPerSector).length;
  return {passed:occupied>=minOccupied,counts,occupied,sectors,minPerSector,minOccupied,radius,outerRadius,scope:'Distribution check; verify actual perimeter occlusion in engine'};
}
