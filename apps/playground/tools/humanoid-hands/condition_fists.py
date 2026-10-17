"""Append calibrated fists to an existing GLB without re-exporting its mesh."""
import bpy,os,json,struct,math
from mathutils import Matrix,Vector,Quaternion

def condition(source,out,r,clips=('Attack1','Attack2','Punch_Hook','Punch_Hook_Rec')):
 raw=open(source,'rb').read();n=struct.unpack_from('<I',raw,12)[0];j=json.loads(raw[20:20+n]);binary=bytearray(raw[28+n:]);fists=json.loads(r['hand_fist_quaternions']);parents={c:i for i,node in enumerate(j['nodes']) for c in node.get('children',[])};world={}
 def matrix(i):
  if i in world:return world[i]
  node=j['nodes'][i];local=Matrix([node['matrix'][k::4] for k in range(4)]) if 'matrix' in node else Matrix.LocRotScale(Vector(node.get('translation',[0,0,0])),Quaternion([node.get('rotation',[0,0,0,1])[k] for k in [3,0,1,2]]),Vector(node.get('scale',[1,1,1])))
  world[i]=(matrix(parents[i]) if i in parents else Matrix.Identity(4))@local;return world[i]
 basis={};s=Quaternion((1,0,0),math.pi/2)
 for i,node in enumerate(j['nodes']):
  if node.get('name') in fists:basis[i]=(s@matrix(i).to_quaternion()).inverted()@(r.matrix_world@r.data.bones[node['name']].matrix_local).to_quaternion()
 edited=0
 for anim in j['animations']:
  if anim['name'] not in clips:continue
  for channel in anim['channels']:
   i=channel['target'].get('node');name=j['nodes'][i].get('name','')
   if channel['target']['path']!='rotation' or name not in fists:continue
   sampler=anim['samplers'][channel['sampler']];a=j['accessors'][sampler['output']]
   if sampler.get('interpolation','LINEAR')=='CUBICSPLINE':raise RuntimeError('Cubic hand tracks need tangents')
   rest=Quaternion([j['nodes'][i].get('rotation',[0,0,0,1])[k] for k in [3,0,1,2]]);c=basis[i];q=(rest@c@Quaternion(fists[name])@c.inverted()).normalized();values=[q.x,q.y,q.z,q.w]*a['count'];binary.extend(b'\0'*((-len(binary))%4));start=len(binary);binary.extend(struct.pack('<'+'f'*len(values),*values));vi=len(j['bufferViews']);j['bufferViews'].append({'buffer':0,'byteOffset':start,'byteLength':len(values)*4});ai=len(j['accessors']);j['accessors'].append({'bufferView':vi,'componentType':5126,'count':a['count'],'type':'VEC4'});sampler['output']=ai;edited+=1
 j['buffers'][0]['byteLength']=len(binary);js=json.dumps(j,separators=(',',':')).encode();js+=b' '*((-len(js))%4);binary+=b'\0'*((-len(binary))%4)
 with open(out,'wb') as f:f.write(struct.pack('<III',0x46546c67,2,28+len(js)+len(binary))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(binary),0x004e4942)+binary)
 return {'clips':list(clips),'finger_tracks':edited,'all_other_tracks_and_mesh_preserved':True}
