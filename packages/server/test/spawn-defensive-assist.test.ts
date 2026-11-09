import {describe,expect,it} from 'vitest';
import {z} from 'zod';
import {applyOps,AssetLibrary,createScene,type EntityDoc,type Op} from '@hitreg/core';
import {LoopbackHub} from '@hitreg/net';
import {GameServer,HeadlessWorld,NpcManager,SpawnAreaManager,defaultRegistry} from '../src/index.js';

/** Real template expansion/spawning, script events and physics: social choices must survive area temperament. */
describe('passive population defensive assistance',()=>{
 for(const placement of ['pack','anywhere'] as const)it(`${placement}: ants defend their own, beetles retaliate alone, default passive stays silent`,async()=>{
  const assets=new AssetLibrary();
  for(const [species,radius,faction]of [['ant',14,'ant-foragers'],['beetle',0,'wild'],['quiet',undefined,'quiet']]as const){
   assets.addPrefab(`mobs/${species}`,{version:1,name:species,root:'body',entities:{
    body:{name:'body',parent:null,tags:['npc'],components:{rigidbody:{kind:'dynamic',lockRotations:true},collider:{shape:'capsule',size:[.6,1.8,.6]},script:{name:'third-person-controller',params:{speed:4,jump:0}}}},
    brain:{name:'brain',parent:'body',tags:[],components:{script:{name:'mob-brain',params:{actor:'',roam:0,faction,hostileTo:'player',speed:4,leash:100,...(radius===undefined?{}:{alertRadius:radius})}}}},
   },props:{actor:{default:'',kind:'string',bindings:['brain/components/script/params/actor']}}});
  }
  const reg=defaultRegistry(),ops:Op[]=[
   {op:'add-entity',id:'floor',entity:{name:'floor',parent:null,tags:[],components:{transform:{position:[0,-.5,0]},rigidbody:{kind:'static'},collider:{shape:'box',size:[60,1,60]}}}},
   {op:'add-entity',id:'player',entity:{name:'player',parent:null,tags:['player'],components:{transform:{position:[0,1,8]}}}},
  ];
  // Without a voxel terrain, roaming placement uses the area's own Y directly (a body's centre, not a ground sample).
  for(const [species,x]of [['ant',-3],['beetle',3],['quiet',0]]as const)ops.push({op:'add-entity',id:species+'-area',entity:{name:species,parent:null,tags:[],components:{transform:{position:[x,1.2,0]},spawnArea:{placement,radius:2,temperament:'passive',leash:100,roam:0,...(placement==='pack'?{spawns:[{template:'prefab:mobs/'+species,count:species==='quiet'?1:2,spread:1}]}:{population:species==='quiet'?1:2,mix:[{template:'prefab:mobs/'+species,count:[1,1]}],hiddenFrom:0,roamRange:[0,0]})}}}as EntityDoc});
  const world=await HeadlessWorld.create({doc:applyOps(createScene('defensive assist'),ops,reg).doc,registry:reg,assets,fixedHz:30});
  world.netState.define('combat',z.union([z.number(),z.string(),z.boolean()]));world.netState.set('combat/player.faction','player');
  const hub=new LoopbackHub({manualFlush:true}),server=new GameServer({world,transport:hub.connect('host'),terrain:null,playerTemplate:null});
  const npcs=new NpcManager(server,{respawnSeconds:0,dormancy:false}),areas=new SpawnAreaManager(server,npcs,{every:100000,random:()=>.5});
  const states:Array<{mobId:string;state:string;targetId:string}>=[],alerts:Array<{mobId:string}>=[];
  world.eventBus.on('mob.state',p=>states.push(p as typeof states[number]));world.eventBus.on('mob.alert',p=>alerts.push(p as typeof alerts[number]));world.eventBus.on('mob.attack',()=>{});
  try{
   for(const area of areas.areas.values()){expect(areas.wake(area)).toBe(true);if(placement==='anywhere')areas.maintain(area,[],world.tick);}
   const ants=areas.areas.get('ant-area')!.npcIds,beetles=areas.areas.get('beetle-area')!.npcIds,quiet=areas.areas.get('quiet-area')!.npcIds;
   expect(ants).toHaveLength(2);expect(beetles).toHaveLength(2);expect(quiet).toHaveLength(1);
   const brain=(id:string)=>npcs.npcs.get(id)!.ids.map(eid=>world.entities.get(eid)?.components['script']as{name:string;params:Record<string,unknown>}|undefined).find(s=>s?.name==='mob-brain')!.params;
   for(const id of ants)expect(brain(id)['alertRadius']).toBe(14);
   for(const id of beetles)expect(brain(id)['alertRadius']).toBe(0);
   expect(brain(quiet[0]!)['alertRadius']).toBeUndefined(); // default -1 => silent when passive
   for(let i=0;i<30;i++)server.tick();
   expect(alerts).toHaveLength(0);expect(states.filter(s=>['chase','attack'].includes(s.state))).toHaveLength(0);
   world.eventBus.emit('mob.threat',{mobId:ants[0]!,sourceId:'player',amount:10});for(let i=0;i<20;i++)server.tick();
   for(const id of ants)expect(states.some(s=>s.mobId===id&&s.targetId==='player'&&['chase','attack'].includes(s.state)),JSON.stringify({id,states,debug:world.scripts.debugTree(npcs.npcs.get(id)!.ids)})).toBe(true);
   for(const id of [...beetles,...quiet])expect(states.some(s=>s.mobId===id&&s.targetId==='player')).toBe(false);
   world.eventBus.emit('mob.threat',{mobId:beetles[0]!,sourceId:'player',amount:10});world.eventBus.emit('mob.threat',{mobId:quiet[0]!,sourceId:'player',amount:10});for(let i=0;i<20;i++)server.tick();
   expect(states.some(s=>s.mobId===beetles[0]&&s.targetId==='player')).toBe(true);
   expect(states.some(s=>s.mobId===beetles[1]&&s.targetId==='player')).toBe(false);
   expect(states.some(s=>s.mobId===quiet[0]&&s.targetId==='player')).toBe(true);
   expect(alerts.filter(a=>[...beetles,...quiet].includes(a.mobId))).toHaveLength(0);
  }finally{areas.dispose();server.close();world.dispose();}
 });
});
