"""Measured mitten-hand repair and reusable Blender grip controls.

Execute through Blender MCP. Profiles are saved with each actor; never infer
regions from arbitrary vertex indices or alter the supplied neutral shape.
"""
import bpy,bmesh,json,math
from mathutils import Vector,Matrix

def select_only(objects,active=None):
 if bpy.context.object and bpy.context.object.mode!='OBJECT':bpy.ops.object.mode_set(mode='OBJECT')
 bpy.ops.object.select_all(action='DESELECT')
 for o in objects:o.hide_set(False);o.select_set(True)
 bpy.context.view_layer.objects.active=active or objects[-1]

def measure_hand(r,meshes,side):
 hand=r.data.bones['DEF-hand.'+side];xf=hand.matrix_local.inverted();pts=[]
 for o in meshes:
  for v in o.data.vertices:
   ws={o.vertex_groups[g.group].name:g.weight for g in v.groups}
   if ws.get(hand.name,0)>.5:pts.append(xf@v.co)
 length=max(p.y for p in pts)
 distal=[p for p in pts if p.y>length*.8]
 # Thumb lobe extends sideways from the broad finger block. The original
 # hands are mitten geometry, so one three-joint chain bends that block.
 xmin=min(p.x for p in distal);xmax=max(p.x for p in distal)
 center_z=(min(p.z for p in distal)+max(p.z for p in distal))*.5
 left=min(p.x for p in pts);right=max(p.x for p in pts)
 raised=[p for p in pts if p.z>max(p.z for p in distal)+length*.035 and length*.2<p.y<length*.78]
 if not raised:
  branch=[p for p in pts if length*.4<p.y<length*.78 and (p.x<xmin-length*.03 or p.x>xmax+length*.03)]
  raised=branch
 thumb_sign=1 if raised and sum(p.x for p in raised)>0 else -1
 edge=xmax if thumb_sign>0 else xmin
 thumb=[p for p in raised if (p.x-edge)*thumb_sign>length*.025]
 inside=False
 if not thumb and raised:
  peak=max(raised,key=lambda p:p.z);thumb=[peak];inside=True;thumb_sign=1 if peak.x>(xmin+xmax)*.5 else -1;edge=(xmin+xmax)*.5
 return {'length':length,'knuckles':[length*.37,length*.62,length*.82],
         'finger_center_z':center_z,'fist_degrees':[80,95,70],
         'thumb_sign':thumb_sign,'thumb_edge':edge,'thumb_inside':inside,'thumb_z':max(p.z for p in distal),'thumb_tip':list(max(thumb,key=lambda p:p.y)) if thumb else None,
         'curl_sign':-1 if side=='L' else 1,'region':'existing DEF-hand weight > 0.5; continuous wrist blend retained'}

def add_mitten_hands(r,meshes,profiles=None):
 profiles=profiles or {s:measure_hand(r,meshes,s) for s in ['L','R']}
 neutral={o.name:[v.co.copy() for v in o.data.vertices] for o in meshes}
 select_only([r]);bpy.ops.object.mode_set(mode='EDIT')
 for side,cfg in profiles.items():
  hand=r.data.edit_bones['DEF-hand.'+side];xf=hand.matrix.copy();length=cfg['length'];knuckles=cfg['knuckles']+[length*1.03]
  for i in range(3):
   b=r.data.edit_bones.new('DEF-index.%02d.%s'%(i+1,side));b.head=xf@Vector((0,knuckles[i],cfg['finger_center_z']*knuckles[i]/length));b.tail=xf@Vector((0,knuckles[i+1],cfg['finger_center_z']*knuckles[i+1]/length));b.align_roll(xf.to_3x3()@Vector((0,0,1)));b.parent=hand if i==0 else r.data.edit_bones['DEF-index.%02d.%s'%(i,side)];b.use_connect=i>0
  if cfg['thumb_tip']:
   tip=Vector(cfg['thumb_tip']);start=Vector((cfg['thumb_edge'],length*.27,tip.z*.7));points=[start.lerp(tip,t) for t in [0,.4,.73,1.06]]
   cfg['thumb_points']=[list(p) for p in points]
   for i in range(3):
    b=r.data.edit_bones.new('DEF-thumb.%02d.%s'%(i+1,side));b.head=xf@points[i];b.tail=xf@points[i+1];b.align_roll(xf.to_3x3()@Vector((0,0,1)));b.parent=hand if i==0 else r.data.edit_bones['DEF-thumb.%02d.%s'%(i,side)];b.use_connect=i>0
 bpy.ops.object.mode_set(mode='OBJECT')
 for o in meshes:
  bm=bmesh.new();bm.from_mesh(o.data);deform=bm.verts.layers.deform.active
  for side,cfg in profiles.items():
   hand=r.data.bones['DEF-hand.'+side];xf=hand.matrix_local.inverted();inv=xf.inverted();gi=o.vertex_groups.find(hand.name)
   faces=[f for f in bm.faces if any(v[deform].get(gi,0)>.5 for v in f.verts)]
   cuts=cfg['knuckles']+[p[1] for p in cfg.get('thumb_points',[])[:3]]
   for cut in [x+d*cfg['length'] for x in cuts for d in [-.018,0,.018]]:
    # Recompute faces after each cut; interpolated vertex deform/UV data stays intact.
    faces=[f for f in bm.faces if any(v[deform].get(gi,0)>.5 for v in f.verts)]
    geom=set(faces)
    for f in faces:geom.update(f.edges);geom.update(f.verts)
    if geom:bmesh.ops.bisect_plane(bm,geom=list(geom),dist=1e-7,plane_co=inv@Vector((0,cut,0)),plane_no=xf.to_3x3().transposed()@Vector((0,1,0)),clear_inner=False,clear_outer=False)
  bmesh.ops.triangulate(bm,faces=list(bm.faces));bm.to_mesh(o.data);bm.free();o.data.update()
  for side,cfg in profiles.items():
   hand=r.data.bones['DEF-hand.'+side];xf=hand.matrix_local.inverted();length=cfg['length'];hinges=cfg['knuckles']
   names=[hand.name]+['DEF-index.%02d.%s'%(i,side) for i in [1,2,3]]
   for n in names+['DEF-thumb.%02d.%s'%(i,side) for i in [1,2,3]]:
    if not o.vertex_groups.get(n):o.vertex_groups.new(name=n)
   for v in o.data.vertices:
    ws={o.vertex_groups[g.group].name:g.weight for g in v.groups};strength=ws.get(hand.name,0);co=xf@v.co
    if strength<=.05 or co.y<length*.25:continue
    def smooth(a,b,x):t=max(0,min(1,(x-a)/(b-a)));return t*t*(3-2*t)
    idx=next((i for i,h in enumerate(hinges) if co.y<h+length*.018),3)
    if idx<3:
     u=smooth(hinges[idx]-length*.018,hinges[idx]+length*.018,co.y);nw={names[idx]:1-u,names[idx+1]:u}
    else:nw={names[3]:1}
    if cfg.get('thumb_points'):
     thumb=(1 if cfg.get('thumb_inside') else smooth(-length*.02,length*.055,(co.x-cfg['thumb_edge'])*cfg['thumb_sign']))*smooth(cfg['thumb_z']-length*.01,cfg['thumb_z']+length*.06,co.z)*(1-smooth(length*.67,length*.8,co.y))
     points=[Vector(p) for p in cfg['thumb_points']];start=points[0];axis=(points[-1]-start);t=(co-start).dot(axis)/axis.length_squared
     tn=[hand.name]+['DEF-thumb.%02d.%s'%(i,side) for i in [1,2,3]];centers=[-.08,0,.4,.73]
     j=max(0,min(2,next((i-1 for i,x in enumerate(centers) if x>t),2)));u=max(0,min(1,(t-centers[j])/(centers[j+1]-centers[j])))
     nw={n:w*(1-thumb) for n,w in nw.items()}
     for n,w in [(tn[j],1-u),(tn[j+1],u)]:nw[n]=nw.get(n,0)+w*thumb
    ws.pop(hand.name,None)
    for n,w in nw.items():ws[n]=ws.get(n,0)+strength*w
    ws=dict(sorted(((n,w) for n,w in ws.items() if w>1e-6),key=lambda x:x[1],reverse=True)[:4]);total=sum(ws.values())
    for vg in o.vertex_groups:vg.remove([v.index])
    for n,w in ws.items():o.vertex_groups[n].add([v.index],w/total,'REPLACE')
 r['hand_profiles']=json.dumps(profiles);install_grip_controls(r)
 return profiles

def install_grip_controls(r):
 for side in ['L','R']:
  key='hand_grip_'+side;r[key]=0.0;r.id_properties_ui(key).update(min=0,max=1,description='0 Open; 0.5 Grip; 1 Fist. Calibrated for this hand.')
  cfg=json.loads(r['hand_profiles'])[side]
  for digit,angles in [('index',cfg.get('fist_degrees',[80,95,70])),('thumb',[28,10,10])]:
   for i,angle in enumerate(angles,1):
    p=r.pose.bones.get('DEF-%s.%02d.%s'%(digit,i,side))
    if not p:continue
    angle_key='hand_'+digit+str(i)+'_'+side;r[angle_key]=float(r.get(angle_key,angle if digit=='index' else [45,15,10][i-1]));r.id_properties_ui(angle_key).update(min=0,max=110,description='Maximum curl in degrees at Fist')
    p.rotation_mode='XYZ';fc=p.driver_add('rotation_euler',0);d=fc.driver;d.type='SCRIPTED'
    for var in list(d.variables):d.variables.remove(var)
    v=d.variables.new();v.name='grip';v.type='SINGLE_PROP';v.targets[0].id=r;v.targets[0].data_path='["'+key+'"]';a=d.variables.new();a.name='angle';a.type='SINGLE_PROP';a.targets[0].id=r;a.targets[0].data_path='["'+angle_key+'"]';d.expression='grip*angle*'+str(math.pi/180)
    if digit=='thumb' and i==1:
     fc=p.driver_add('rotation_euler',2);d=fc.driver;d.type='SCRIPTED'
     for var in list(d.variables):d.variables.remove(var)
     v=d.variables.new();v.name='grip';v.type='SINGLE_PROP';v.targets[0].id=r;v.targets[0].data_path='["'+key+'"]';cfg=json.loads(r['hand_profiles'])[side];d.expression='grip*'+str(math.radians(40)*cfg['thumb_sign'])

class HITREG_OT_save_hand_profile(bpy.types.Operator):
 bl_idname='hitreg.save_hand_profile';bl_label='Save grip settings';bl_options={'REGISTER'}
 def execute(self,context):
  r=context.object;path=r.get('hand_profile_file')
  if not path:self.report({'ERROR'},'This rig has no profile export path');return {'CANCELLED'}
  profile=json.loads(r['hand_profiles'])
  for side,cfg in profile.items():
   cfg['fist_degrees']=[r['hand_index'+str(i)+'_'+side] for i in [1,2,3]]
   cfg['thumb_degrees']=[r.get('hand_thumb'+str(i)+'_'+side,v) for i,v in enumerate([45,15,10],1)]
  with open(path) as f:report=json.load(f)
  report['profiles']=profile;report['status']='settings-changed-needs-preview'
  with open(path,'w') as f:json.dump(report,f,indent=2)
  r['hand_profiles']=json.dumps(profile);self.report({'INFO'},'Saved. Re-bake with pnpm -F playground hands bake '+report['actor']);return {'FINISHED'}

class HITREG_OT_hand_pose(bpy.types.Operator):
 bl_idname='hitreg.hand_pose';bl_label='Set hand pose';bl_options={'REGISTER','UNDO'}
 amount:bpy.props.FloatProperty(default=0,min=0,max=1)
 def execute(self,context):
  r=context.object
  if context.screen and context.screen.is_animation_playing:bpy.ops.screen.animation_play()
  if r.animation_data:
   r.animation_data.action=None
   for track in r.animation_data.nla_tracks:track.mute=True
  if 'hand_grip_L' in r:
   for s in ['L','R']:r['hand_grip_'+s]=self.amount
  else:
   from mathutils import Quaternion
   for n,q in json.loads(r['hand_fist_quaternions']).items():
    p=r.pose.bones[n];p.rotation_mode='QUATERNION';p.rotation_quaternion=Quaternion().slerp(Quaternion(q),self.amount)
  r.update_tag();context.view_layer.update();return {'FINISHED'}

class HITREG_PT_hand_grips(bpy.types.Panel):
 bl_label='HitReg Hands';bl_idname='HITREG_PT_hand_grips';bl_space_type='VIEW_3D';bl_region_type='UI';bl_category='HitReg'
 @classmethod
 def poll(cls,context):return context.object and ('hand_grip_L' in context.object or 'hand_fist_quaternions' in context.object)
 def draw(self,context):
  r=context.object;row=self.layout.row(align=True)
  for label,amount in [('Open',0),('Grip',.5),('Fist',1)]:row.operator('hitreg.hand_pose',text=label).amount=amount
  if 'hand_grip_L' in r:
   self.layout.label(text='0 = Open   0.5 = Grip   1 = Fist')
   for s in ['L','R']:self.layout.prop(r,'["hand_grip_'+s+'"]',text='Left' if s=='L' else 'Right',slider=True)
   box=self.layout.box();box.label(text='Fist curl (degrees)')
   for s in ['L','R']:
    row=box.row(align=True)
    for i in [1,2,3]:row.prop(r,'["hand_index'+str(i)+'_'+s+'"]',text=s+str(i))
   if r.get('hand_profile_file'):box.operator('hitreg.save_hand_profile')
  self.layout.label(text='Preview pauses the active clip.')

def register():
 for cls in [HITREG_OT_hand_pose,HITREG_OT_save_hand_profile,HITREG_PT_hand_grips]:
  old=getattr(bpy.types,cls.__name__,None)
  if old:bpy.utils.unregister_class(old)
  bpy.utils.register_class(cls)

# Blender imports Text blocks marked use_module under their own module name.
# Register on that path too so the panel survives reopening the .blend.
register()
