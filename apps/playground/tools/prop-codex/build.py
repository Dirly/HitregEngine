"""Build Codex prop designs on the town-craft helper library, headless:

  blender --background --python tools/prop-codex/build.py -- --world-kit <dir> --designs <a.py,b.py|dir> --out <glb dir> --geometry <json>

Each design is a snippet that builds one Mesh and calls emit(m, design, category=, mount=, solid=, setting=, cultures=,
centrepiece=). The helpers are town-craft's own (sliced from its build.py so the palette, UV rule and texel density are
the same code), the role sheet is town-craft's materials.png. Writes one GLB per design and a geometry record per design
(size, triangles, parts with extents, roles, texel density, errors). Never saves a .blend.
"""
import bpy, bmesh, math, json, copy, sys, traceback, hashlib
from pathlib import Path
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def opt(name, default=None):
    return argv[argv.index('--' + name) + 1] if '--' + name in argv else default
WK = Path(opt('world-kit')).resolve(); HERE = WK / 'authoring/town-craft'; PROJECT = WK
SOURCE = Path(opt('out')).resolve(); SOURCE.mkdir(parents=True, exist_ok=True)
GEOMETRY = Path(opt('geometry')).resolve()
PAINT_PLAN = opt('paint-mode','final') == 'plan'
PAINT_ROOT = Path(opt('paint-root',str(WK/'authoring/codex-craft/paint'))).resolve()
spec = opt('designs')
designs = sorted(Path(spec).glob('*.py')) if Path(spec).is_dir() else [Path(p) for p in spec.split(',') if p]

bpy.context.preferences.filepaths.save_version = 0
scene = bpy.context.scene
for o in list(scene.objects): bpy.data.objects.remove(o, do_unlink=True)
collection = bpy.data.collections.new('Codex craft')
scene.collection.children.link(collection)
image = bpy.data.images.load(str(PROJECT / 'assets/textures/town-craft/materials.png'), check_existing=True); image.pack()
mat = bpy.data.materials.new('Town craft role atlas'); mat.use_nodes = True
bs = mat.node_tree.nodes.get('Principled BSDF'); bs.inputs['Roughness'].default_value = 1
tex = mat.node_tree.nodes.new('ShaderNodeTexImage'); tex.image = image; tex.interpolation = 'Closest'
mat.node_tree.links.new(tex.outputs['Color'], bs.inputs['Base Color'])
ROLES = [r['name'] for r in json.loads((HERE / 'material-roles.json').read_text())['roles']]
helper = (WK / 'authoring/crockin-river-culture/mesh.py').read_text()
for a, b in [('rid%4', 'rid%8'), ('rid//4', 'rid//8'), ('((3-row)*128', '((7-row)*128'), ('/512', '/1024')]:
    if a not in helper: raise RuntimeError('Shared grid adapter drift: ' + a)
    helper = helper.replace(a, b)
exec(compile(helper, 'mesh.py', 'exec'), globals())
exec(compile((WK / 'authoring/mesh-cleanup.py').read_text(), 'mesh-cleanup.py', 'exec'), globals())
build = (HERE / 'build.py').read_text()
a, b = build.index('def block('), build.index('def emit(')
exec(compile(build[a:b], 'town-craft helpers', 'exec'), globals())
exec(compile((Path(__file__).parent/'surfaces.py').read_text(), 'prop painted surfaces', 'exec'), globals())

# per-part extents (the fussy-detail gate) and role checks ride on Mesh.add
_add = Mesh.add
def _tracked_add(self, verts, faces, role, part, uv=None):
    if role not in ROLES: raise ValueError(f'unknown role "{role}" (roles: {", ".join(ROLES)})')
    _add(self, verts, faces, role, part, uv)
    used = [verts[j] for f in faces for j in f]
    ext = [max(p[k] for p in used) - min(p[k] for p in used) for k in range(3)] if used else [0, 0, 0]
    self.parts[-1]['extent'] = [round(e, 4) for e in ext]
Mesh.add = _tracked_add

records = []; current = {}
def emit(m, design, category='tool', mount='floor', solid=True, setting='both', cultures=None, centrepiece=False, rooms=None, use=None, against='free', water=None):
    if current.get('emitted'): raise RuntimeError('emit called more than once')
    current['emitted'] = True
    if m.name != current['name']: raise RuntimeError(f'mesh is named "{m.name}", the design file is "{current["name"]}"')
    paint_plan,face_map = describe_paint(m)
    texture_size = 1024; paint_record = None
    if paint_plan['surfaces']:
        if PAINT_PLAN:
            # Dimension-correct placeholder coordinates for design checks ONLY; never exported.
            layout={'size':1024,'roles':{r:{'x':0,'y':0,'w':128,'h':128} for r in paint_plan['roles']},
                    'surfaces':{s['name']:{'x':0,'y':0,'w':s['pixels'][0],'h':s['pixels'][1]} for s in paint_plan['surfaces']}}
            paint_material=mat
        else:
            folder=PAINT_ROOT/m.name
            if not (folder/'receipt.json').exists():raise ValueError('painted surfaces need artwork: run props paint plan / gen or import for '+m.name)
            layout=json.loads((folder/'layout.json').read_text());receipt=json.loads((folder/'receipt.json').read_text())
            sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
            if layout['geometrySha256']!=paint_plan['geometrySha256']:raise ValueError('paint UV guide is stale: re-plan and import '+m.name)
            for filename,key in [('layout.json','layoutSha256'),('key.png','keySha256'),('manifest.json','manifestSha256'),('art.png','artSha256'),('atlas.png','atlasSha256')]:
                if not (folder/filename).exists() or sha(folder/filename)!=receipt[key]:raise ValueError('paint '+filename+' changed: import artwork again for '+m.name)
            if sha(WK/'assets/textures/town-craft/materials.png')!=receipt['roleSheetSha256']:raise ValueError('shared role art changed: import artwork again')
            image=bpy.data.images.load(str(folder/'atlas.png'),check_existing=True);image.reload();image.pack()
            paint_material=mat.copy();paint_material.name='Painted prop atlas • '+m.name
            next(n for n in paint_material.node_tree.nodes if n.type=='TEX_IMAGE').image=image
            paint_record={**paint_plan,'ready':True,'size':layout['size'],'atlasSha256':receipt['atlasSha256'],'artSha256':receipt['artSha256'],'layoutSha256':receipt['layoutSha256']}
        texture_size=layout['size'];ob=painted_object(m,paint_plan,face_map,layout,paint_material,wall=mount=='wall')
    else:ob=m.object(wall=mount=='wall')
    clean = clean_coplanar(ob.data)
    drop = 0.0
    if mount == 'ceiling':  # origin at the top centre: the suspension point
        drop = max(v.co.z for v in ob.data.vertices)
        for v in ob.data.vertices: v.co.z -= drop
    wrec = None
    if water:
        c = water['centre']; sx, sy, sz = m.shift
        wrec = {'centre': [round(c[0] - sx, 4), round(c[2] - sz - drop, 4), round(-(c[1] - sy), 4)], 'radius': float(water['radius']), 'depth': float(water['depth'])}
    bm = bmesh.new(); bm.from_mesh(ob.data); bmesh.ops.remove_doubles(bm, verts=list(bm.verts), dist=1e-6); bmesh.ops.recalc_face_normals(bm, faces=list(bm.faces)); bm.to_mesh(ob.data); bm.free(); ob.data.update()
    for o in bpy.context.selected_objects: o.select_set(False)
    ob.select_set(True); bpy.context.view_layer.objects.active = ob; bpy.context.view_layer.update()
    if not PAINT_PLAN:bpy.ops.export_scene.gltf(filepath=str(SOURCE / (m.name + '.glb')), export_format='GLB', use_selection=True, use_active_scene=True, export_yup=True, export_apply=True, export_materials='EXPORT')
    me = ob.data; uvl = me.uv_layers.active
    used = {i for p in me.polygons for i in p.vertices}; pts = [me.vertices[i].co for i in used]
    lo = [min(p[k] for p in pts) for k in range(3)]; hi = [max(p[k] for p in pts) for k in range(3)]
    dens = []
    for p in me.polygons:
        vs = [me.vertices[i].co for i in p.vertices]; uv = [uvl.data[li].uv for li in p.loop_indices]
        area = (vs[1] - vs[0]).cross(vs[2] - vs[0]).length / 2
        uarea = abs((uv[1].x - uv[0].x) * (uv[2].y - uv[0].y) - (uv[2].x - uv[0].x) * (uv[1].y - uv[0].y)) / 2 * texture_size * texture_size
        if area > 1e-6: dens.append((math.sqrt(uarea / area), area))
    dens.sort(); total = sum(w for _, w in dens); acc = 0; median = 0
    for d, w in dens:
        acc += w
        if acc >= total / 2: median = d; break
    current['record'] = {'name': m.name, 'design': design, 'category': category, 'mount': mount, 'solid': bool(solid), 'setting': setting,
        'cultures': list(cultures or []), 'centrepiece': bool(centrepiece), 'rooms': rooms, 'use': use, 'against': against,
        'size': [round(hi[0] - lo[0], 4), round(hi[2] - lo[2], 4), round(hi[1] - lo[1], 4)], 'triangles': len(me.polygons),
        'parts': m.parts, 'roles': sorted(set(m.roles)), 'shift': list(m.shift), 'cleanup': clean, 'texel': round(median, 2), 'water': wrec,
        'paintPlan': paint_plan if paint_plan['surfaces'] else None, 'paint': paint_record}
    if paint_record:
        surface_density={s['name']:[] for s in paint_plan['surfaces']}
        for p in me.polygons:
            uv=[uvl.data[li].uv for li in p.loop_indices];vs=[me.vertices[i].co for i in p.vertices]
            area=(vs[1]-vs[0]).cross(vs[2]-vs[0]).length/2
            if area<1e-9:continue
            ua=abs((uv[1].x-uv[0].x)*(uv[2].y-uv[0].y)-(uv[2].x-uv[0].x)*(uv[1].y-uv[0].y))/2*texture_size**2
            for name,r in layout['surfaces'].items():
                if all(r['x']-1e-4<=v.x*texture_size<=r['x']+r['w']+1e-4 and r['y']-1e-4<=(1-v.y)*texture_size<=r['y']+r['h']+1e-4 for v in uv):surface_density[name].append((math.sqrt(ua/area),area))
        for s in paint_record['surfaces']:
            values=sorted(surface_density[s['name']]);total=sum(w for d,w in values);acc=0;s['texel']=0;s['finalFaces']=len(values)  # 0: cleanup removed every face (hidden against a neighbour)
            for d,w in values:
                acc+=w
                if acc>=total/2:s['texel']=round(d,2);break

for f in designs:
    current.clear(); current['name'] = f.stem
    try:
        exec(compile(f.read_text(encoding='utf-8'), str(f), 'exec'), dict(globals()))
        if not current.get('emitted'): raise RuntimeError('the design never calls emit(...)')
        records.append(current['record'])
    except Exception as e:
        records.append({'name': f.stem, 'error': ''.join(traceback.format_exception_only(type(e), e)).strip(), 'trace': traceback.format_exc()[-1500:]})
GEOMETRY.parent.mkdir(parents=True, exist_ok=True)
GEOMETRY.write_text(json.dumps({'version': 1, 'density': 40, 'props': records}, indent=2))
print('prop-codex build: %d design(s), %d error(s)' % (len(records), sum(1 for r in records if 'error' in r)))
