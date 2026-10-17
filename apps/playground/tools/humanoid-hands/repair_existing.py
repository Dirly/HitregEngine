"""Repair a modeled finger block on an existing articulated hand.

Retains every bone/rest matrix and action. Produces axis profiles for the
lossless GLB animation conditioner; the original remains a separate backup.
"""
import bpy,bmesh,json,math
from mathutils import Vector,Quaternion,Matrix

def repair(r,meshes,aliases):
 profiles={}
 for side,prefix in aliases.items():
  hand=r.data.bones[prefix];xf=hand.matrix_local.inverted();hinges=[(xf@r.data.bones[prefix+'Index'+str(i)].head_local).y for i in [1,2,3]]
  thumb=[(xf@r.data.bones[prefix+'Thumb'+str(i)].head_local).y for i in [1,2,3]]
  palm_axis=hand.matrix_local.to_quaternion()@Vector((-1,0,0))
  axes={}
  for digit in ['Index','Thumb']:
   for i in [1,2,3]:
    b=r.data.bones[prefix+digit+str(i)];axes[b.name]=list(b.matrix_local.to_quaternion().inverted()@palm_axis)
  thumb_sign=1 if (xf@r.data.bones[prefix+'Thumb2'].head_local).x>0 else -1
  profiles[side]={'prefix':prefix,'hinges':hinges,'thumb_hinges':thumb,'thumb_sign':thumb_sign,'curl_axes':axes,'mode':'mitten','fist_degrees':[62,76,50]}
 for o in meshes:
  bm=bmesh.new();bm.from_mesh(o.data);deform=bm.verts.layers.deform.active
  for side,profile in profiles.items():
   prefix=profile['prefix'];hand=r.data.bones[prefix];xf=hand.matrix_local.inverted();inv=xf.inverted();groups=[g.index for g in o.vertex_groups if g.name.startswith(prefix)]
   for cut in [x+d for x in profile['hinges']+profile['thumb_hinges'] for d in [-.001,0,.001]]:
    faces=[f for f in bm.faces if any(sum(v[deform].get(g,0) for g in groups)>.4 for v in f.verts)];geom=set(faces)
    for f in faces:geom.update(f.edges);geom.update(f.verts)
    if geom:bmesh.ops.bisect_plane(bm,geom=list(geom),dist=1e-7,plane_co=inv@Vector((0,cut,0)),plane_no=xf.to_3x3().transposed()@Vector((0,1,0)),clear_inner=False,clear_outer=False)
  bmesh.ops.triangulate(bm,faces=list(bm.faces));bm.to_mesh(o.data);bm.free();o.data.update()
  for side,profile in profiles.items():
   prefix=profile['prefix'];xf=r.data.bones[prefix].matrix_local.inverted();hinges=profile['hinges'];names=[prefix]+[prefix+'Index'+str(i) for i in [1,2,3]]
   for v in o.data.vertices:
    ws={o.vertex_groups[g.group].name:g.weight for g in v.groups};total=sum(w for n,w in ws.items() if n.startswith(prefix));co=xf@v.co
    if total<.2 or co.y<profile['thumb_hinges'][0]-.002:continue
    # Original thumb weights isolate its disconnected lobe/web; other modeled
    # digits form one continuous block and must bend together.
    def smooth(a,b,x):u=max(0,min(1,(x-a)/(b-a)));return u*u*(3-2*u)
    th=profile['thumb_hinges'];mask=smooth(.012,.024,co.x*profile['thumb_sign'])*smooth(0,.009,-co.z)*(1-smooth(th[2]+.01,th[2]+.025,co.y))
    tn=[prefix]+[prefix+'Thumb'+str(i) for i in [1,2,3]];centers=[th[0]-.006]+th
    ti=max(0,min(2,next((i-1 for i,x in enumerate(centers) if x>co.y),2)));u=max(0,min(1,(co.y-centers[ti])/(centers[ti+1]-centers[ti])))
    thumb={tn[ti]:total*mask*(1-u),tn[ti+1]:total*mask*u};strength=total*(1-mask)
    idx=next((i for i,h in enumerate(hinges) if co.y<h+.001),3)
    if idx<3:u=max(0,min(1,(co.y-(hinges[idx]-.001))/.002));nw={names[idx]:1-u,names[idx+1]:u}
    else:nw={names[3]:1}
    ws={n:w for n,w in ws.items() if not n.startswith(prefix)};ws.update(thumb)
    for n,w in nw.items():ws[n]=ws.get(n,0)+strength*w
    ws=dict(sorted(((n,w) for n,w in ws.items() if w>1e-6),key=lambda x:x[1],reverse=True)[:4]);t=sum(ws.values())
    for vg in o.vertex_groups:vg.remove([v.index])
    for n,w in ws.items():o.vertex_groups[n].add([v.index],w/t,'REPLACE')
 r['existing_hand_profiles']=json.dumps(profiles)
 return profiles

def pose(r,amount):
 for side,profile in json.loads(r['existing_hand_profiles']).items():
  for name,axis in profile['curl_axes'].items():
   p=r.pose.bones[name];i=int(name[-1])-1;angles=profile['fist_degrees'] if 'Index' in name else [28,18,12]
   p.rotation_mode='QUATERNION';p.rotation_quaternion=Quaternion(Vector(axis),math.radians(angles[i])*amount)
 bpy.context.view_layer.update()
