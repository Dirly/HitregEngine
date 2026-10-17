import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const [command='help',asset='all']=process.argv.slice(2);
const run=(file,args=[],tsx=false)=>{
 const result=spawnSync(process.execPath,[...(tsx?['--import','tsx']:[]),path.join(here,'humanoid-hands',file),...args],{stdio:'inherit',cwd:path.dirname(here)});
 if(result.status!==0)process.exit(result.status??1);
};
if(command==='bake'){run('bake.mjs',[asset]);run('verify.mts',[],true);console.log('Candidates verified. Preview the clips before running: pnpm -F playground hands install');}
else if(command==='check')run('verify.mts',[],true);
else if(command==='install')run('install.mts',[],true);
else console.log('Humanoid hands: bake [all|ogre|ratkin|crockin|frogkin], check, install.\nBlender: select the rig, press N, choose HitReg, then Open / Grip / Fist.\nAnansi and human use their preserved source libraries; repair/re-export their geometry through Blender MCP.');
