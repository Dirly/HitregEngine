"""Lossless GLB hand repair: append mesh/finger buffers, retain all other bytes."""
import bpy,os,json,struct,math,shutil,bisect
from mathutils import Matrix,Quaternion,Vector

def export_existing(source,out,r,o):
 raw=open(source,'rb').read();n=struct.unpack_from('<I',raw,12)[0];j=json.loads(raw[20:20+n]);binary=bytearray(raw[28+n:])
 def append(values,kind,typ=5126,target=None,bounds=False):
  width={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[kind];binary.extend(b'\0'*((-len(binary))%4));start=len(binary);binary.extend(struct.pack('<'+('H' if typ==5123 else 'f')*len(values),*values));view={'buffer':0,'byteOffset':start,'byteLength':len(binary)-start}
  if target:view['target']=target
  vi=len(j['bufferViews']);j['bufferViews'].append(view);a={'bufferView':vi,'componentType':typ,'count':len(values)//width,'type':kind}
  if bounds:a.update(min=[min(values[i::width]) for i in range(width)],max=[max(values[i::width]) for i in range(width)])
  ai=len(j['accessors']);j['accessors'].append(a);return ai
 def vals(ai):
  a=j['accessors'][ai];v=j['bufferViews'][a['bufferView']];w={'SCALAR':1,'VEC2':2,'VEC3':3,'VEC4':4}[a['type']];offset=v.get('byteOffset',0)+a.get('byteOffset',0);stride=v.get('byteStride',w*4)
  return [struct.unpack_from('<'+'f'*w,binary,offset+i*stride) for i in range(a['count'])]
 joints={j['nodes'][ni]['name']:i for i,ni in enumerate(j['skins'][0]['joints'])};arrays={x:[] for x in ['POSITION','NORMAL','TEXCOORD_0','JOINTS_0','WEIGHTS_0']};m=o.data;m.calc_loop_triangles()
 for tri in m.loop_triangles:
  for li in tri.loops:
   v=m.vertices[m.loops[li].vertex_index];co=v.co;normal=m.corner_normals[li].vector;uv=m.uv_layers[0].data[li].uv
   arrays['POSITION'].extend((co.x,co.z,-co.y));arrays['NORMAL'].extend((normal.x,normal.z,-normal.y));arrays['TEXCOORD_0'].extend((uv.x,1-uv.y))
   ws=sorted([(joints[o.vertex_groups[g.group].name],g.weight) for g in v.groups if g.weight>1e-6],key=lambda x:x[1],reverse=True)[:4];t=sum(w for i,w in ws)
   if not t:raise RuntimeError('Unweighted vertex')
   ws=[(i,w/t) for i,w in ws]+[(0,0)]*(4-len(ws));arrays['JOINTS_0'].extend(i for i,w in ws);arrays['WEIGHTS_0'].extend(w for i,w in ws)
 p=j['meshes'][0]['primitives'][0]
 if set(p['attributes'])-set(arrays):raise RuntimeError('Additional mesh attributes need explicit preservation')
 if p.get('targets'):raise RuntimeError('Morph shapes need measured transfer')
 p['attributes']={k:append(v,'VEC2' if k.startswith('TEX') else 'VEC4' if k in ['JOINTS_0','WEIGHTS_0'] else 'VEC3',5123 if k=='JOINTS_0' else 5126,34962,k=='POSITION') for k,v in arrays.items()};p.pop('indices',None)
 parents={c:i for i,n in enumerate(j['nodes']) for c in n.get('children',[])};world={}
 def matrix(i):
  if i in world:return world[i]
  node=j['nodes'][i];local=Matrix([node['matrix'][k::4] for k in range(4)]) if 'matrix' in node else Matrix.LocRotScale(Vector(node.get('translation',[0,0,0])),Quaternion([node.get('rotation',[0,0,0,1])[k] for k in [3,0,1,2]]),Vector(node.get('scale',[1,1,1])))
  world[i]=(matrix(parents[i]) if i in parents else Matrix.Identity(4))@local;return world[i]
 basis={};s=Quaternion((1,0,0),math.pi/2)
 for i,node in enumerate(j['nodes']):
  if node.get('name') in r.data.bones:basis[i]=(s@matrix(i).to_quaternion()).inverted()@(r.matrix_world@r.data.bones[node['name']].matrix_local).to_quaternion()
 profiles=json.loads(r['existing_hand_profiles']);edited=0
 for anim in j['animations']:
  for side,profile in profiles.items():
   prefix=profile['prefix'];refs={}
   for ch in anim['channels']:
    name=j['nodes'][ch['target']['node']].get('name','')
    if name.startswith(prefix) and ch['target']['path']=='rotation':refs[name]=(ch,anim['samplers'][ch['sampler']])
   ref=refs.get(prefix+'Index1')
   if not ref:continue
   ni=ref[0]['target']['node'];rest=Quaternion([j['nodes'][ni].get('rotation',[0,0,0,1])[k] for k in [3,0,1,2]]);c=basis[ni]
   grips=[min(1,(c.inverted()@rest.inverted()@Quaternion((v[3],v[0],v[1],v[2]))@c).angle/math.radians(62)) for v in vals(ref[1]['output'])]
   grip_times=[v[0] for v in vals(ref[1]['input'])]
   # Punch/slam already use the closed-hand action family: complete the
   # modeled block's fist, without modifying their arm/body performance.
   if 'Punch' in anim['name'] or 'Slam' in anim['name']:grips=[1.]*len(grips)
   for name,axis in profile['curl_axes'].items():
    if name not in refs:continue
    channel,sampler=refs[name];ni=channel['target']['node'];rest=Quaternion([j['nodes'][ni].get('rotation',[0,0,0,1])[k] for k in [3,0,1,2]]);c=basis[ni];old=vals(sampler['output']);output=[]
    if sampler.get('interpolation','LINEAR')=='CUBICSPLINE':raise RuntimeError('Cubic finger tracks need tangent conditioning')
    sampled=[]
    for time in [v[0] for v in vals(sampler['input'])]:
     ix=max(0,min(len(grips)-2,bisect.bisect_right(grip_times,time)-1));u=max(0,min(1,(time-grip_times[ix])/(grip_times[ix+1]-grip_times[ix])));sampled.append(grips[ix]*(1-u)+grips[ix+1]*u)
    for grip in sampled:
     i=int(name[-1])-1;angle=(profile['fist_degrees'] if 'Index' in name else [28,18,12])[i];q=(rest@c@Quaternion(Vector(axis),math.radians(angle)*grip)@c.inverted()).normalized();output.extend((q.x,q.y,q.z,q.w))
    sampler['output']=append(output,'VEC4');edited+=1
 def write(file,doc,bin):
  doc['buffers'][0]['byteLength']=len(bin);js=json.dumps(doc,separators=(',',':')).encode();js+=b' '*((-len(js))%4);bin+=b'\0'*((-len(bin))%4)
  with open(file,'wb') as f:f.write(struct.pack('<III',0x46546c67,2,28+len(js)+len(bin))+struct.pack('<II',len(js),0x4e4f534a)+js+struct.pack('<II',len(bin),0x004e4942)+bin)
 write(out,j,binary.copy())
 return {'candidate':out,'clips_preserved':len(j['animations']),'bones_preserved':len(j['skins'][0]['joints']),'finger_tracks_corrected':edited,'render_vertices':len(arrays['POSITION'])//3,'source_binary_prefix_preserved':True}
