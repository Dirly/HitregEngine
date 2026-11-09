/** Reduce current painted key islands to a logical pixel grid without changing sheet size or UVs. */
const maskCache=new WeakMap();
export function ornamentMask(key,hexes,S,dilate=0){
 const cache=maskCache.get(key)??new Map(),cacheKey=JSON.stringify([hexes,S,dilate]);maskCache.set(key,cache);if(cache.has(cacheKey))return cache.get(cacheKey).slice();
 const colors=new Set(hexes.map(h=>h.toLowerCase())),m=new Uint8Array(S*S);
 for(let y=0;y<key.height;y++)for(let x=0;x<key.width;x++){const j=(y*key.width+x)*4,h='#'+[0,1,2].map(c=>key.data[j+c].toString(16).padStart(2,'0')).join('');if(colors.has(h))m[Math.floor(y*S/key.height)*S+Math.floor(x*S/key.width)]=1;}
 for(let n=0;n<dilate;n++){const p=m.slice();for(let y=0;y<S;y++)for(let x=0;x<S;x++)if(p[y*S+x])for(const[dx,dy]of[[1,0],[-1,0],[0,1],[0,-1]]){const X=x+dx,Y=y+dy;if(X>=0&&Y>=0&&X<S&&Y<S)m[Y*S+X]=1;}}
 cache.set(cacheKey,m);return m.slice();
}
export function resampleOrnament(source,key,hexes,logicalPx,{coverage=false,coverageThreshold=0,dilate=0}={}){
 const S=source.width,N=logicalPx;if(S!==source.height||!Number.isInteger(N)||N<1)throw Error('Ornament resample requires square paint and a positive integer grid');
 const island=ornamentMask(key,hexes,S),mask=ornamentMask(key,hexes,S,dilate),coarse=new Uint8Array(N*N*4),best=new Float64Array(N*N).fill(Infinity),total=new Uint32Array(N*N),hits=new Uint32Array(N*N),out={width:S,height:S,data:source.data.slice()};
 for(let y=0;y<N;y++)for(let x=0;x<N;x++){const sx=Math.min(S-1,Math.floor((x+.5)*S/N)),sy=Math.min(S-1,Math.floor((y+.5)*S/N)),s=(sy*S+sx)*4;coarse.set(source.data.subarray(s,s+4),(y*N+x)*4);if(coverage)coarse[(y*N+x)*4+3]=0;}
 // An occupied source cell remains occupied after reduction; choose its nearest existing opaque colour.
 // This preserves connected thin rays rather than inventing bridges or painting new details.
 if(coverage)for(let y=0;y<S;y++)for(let x=0;x<S;x++){const p=y*S+x;if(!island[p])continue;const cx=Math.min(N-1,Math.floor((x+.5)*N/S)),cy=Math.min(N-1,Math.floor((y+.5)*N/S)),c=cy*N+cx;total[c]++;if(source.data[p*4+3]<128)continue;hits[c]++;const d=(x+.5-(cx+.5)*S/N)**2+(y+.5-(cy+.5)*S/N)**2;if(d<best[c]){best[c]=d;coarse.set(source.data.subarray(p*4,p*4+4),c*4);}}
 if(coverageThreshold)for(let i=0;i<total.length;i++)if(!total[i]||hits[i]/total[i]<coverageThreshold)coarse[i*4+3]=0;
 let changed=0,selected=0;for(let y=0;y<S;y++)for(let x=0;x<S;x++){const i=y*S+x;if(!mask[i])continue;selected++;const cx=Math.min(N-1,Math.floor((x+.5)*N/S)),cy=Math.min(N-1,Math.floor((y+.5)*N/S)),s=(cy*N+cx)*4;for(let c=0;c<4;c++){if(out.data[i*4+c]!==coarse[s+c])changed++;out.data[i*4+c]=coarse[s+c];}}
 return{image:out,mask,report:{logicalPx:N,storagePx:S,coveragePreserving:coverage,coverageThreshold,selectedPixels:selected,changedChannels:changed,sourceDesign:'Current source pixels only, no repaint or earlier art restoration'}};
}
