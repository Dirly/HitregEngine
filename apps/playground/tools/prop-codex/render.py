"""Review cards for Codex props, cold-loaded from their RUNTIME glTFs (the packed atlas page), headless:

  blender --background --python tools/prop-codex/render.py -- --models <a.gltf,b.gltf> --cards <dir> [--sheet <png>] [--labels a,b]

One 900 px card per prop beside a 1.8 m reference figure (render.py pattern of town-craft), and optionally one sheet with
every prop side by side, labelled, beside the figure. Nearest sampling, three area lights, Cycles 8 samples.
"""
import bpy, sys, math
from pathlib import Path
from mathutils import Vector

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
def opt(name, default=None):
    return argv[argv.index('--' + name) + 1] if '--' + name in argv else default
models = [Path(p) for p in opt('models').split(',') if p]
cards = Path(opt('cards')); cards.mkdir(parents=True, exist_ok=True)
sheet = opt('sheet'); labels = (opt('labels') or '').split(',')
painted = set((opt('painted') or '').split(','))

scene = bpy.context.scene
for o in list(scene.objects): bpy.data.objects.remove(o, do_unlink=True)
def link(ob): scene.collection.objects.link(ob); return ob
def aim(o, p): o.rotation_euler = (Vector(p) - o.location).to_track_quat('-Z', 'Y').to_euler()
def material(name, color):
    ma = bpy.data.materials.new(name); ma.use_nodes = True; b = ma.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1); b.inputs['Roughness'].default_value = 1; return ma

# engine water discs (prefab entities, not in the glTF): name:x,y,z,r in glTF frame, previewed as a flat blue-grey disc
waters = {}
for w in (opt('water') or '').split(';'):
    if ':' in w:
        n, v = w.split(':'); x, y, z, r = [float(t) for t in v.split(',')]; waters[n] = (x, -z, y, r)
water_mat = None
props = []
for f in models:
    before = set(bpy.data.objects); bpy.ops.import_scene.gltf(filepath=str(f))
    meshes = [o for o in bpy.data.objects if o not in before and o.type == 'MESH']
    for o in meshes:
        for ms in o.material_slots:
            if ms.material and ms.material.use_nodes:
                for n in ms.material.node_tree.nodes:
                    if n.type == 'TEX_IMAGE': n.interpolation = 'Closest'
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    lo = Vector([min(p[k] for p in pts) for k in range(3)]); hi = Vector([max(p[k] for p in pts) for k in range(3)])
    if f.stem in waters:
        if water_mat is None:
            water_mat = bpy.data.materials.new('engine water preview'); water_mat.use_nodes = True
            b = water_mat.node_tree.nodes['Principled BSDF']; b.inputs['Base Color'].default_value = (.16, .24, .24, 1); b.inputs['Roughness'].default_value = .15
        x, y, z, r = waters[f.stem]
        bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=r, depth=.02, location=(x, y, z - .01)); d = bpy.context.object; d.data.materials.append(water_mat)
        roots = [o for o in bpy.data.objects if o not in before and o.parent is None and o is not d]
        if roots: d.parent = roots[0]; d.matrix_parent_inverse = roots[0].matrix_world.inverted()
        meshes.append(d)
    props.append({'name': f.stem, 'objs': [o for o in bpy.data.objects if o not in before], 'meshes': meshes, 'lo': lo, 'hi': hi})

def place(p, at):
    roots = [o for o in p['objs'] if o.parent is None]
    off = Vector((at[0] - (p['lo'].x + p['hi'].x) / 2, at[1] - (p['lo'].y + p['hi'].y) / 2, -p['lo'].z))
    for o in roots: o.location += off
    p['lo'] += off; p['hi'] += off
def show(p, on):
    for o in p['meshes']: o.hide_render = not on

ground = material('review ground', (.10, .115, .10)); me = bpy.data.meshes.new('ground')
me.from_pydata([(-200, -200, -.002), (200, -200, -.002), (200, 200, -.002), (-200, 200, -.002)], [], [(0, 1, 2, 3)]); me.materials.append(ground); link(bpy.data.objects.new('ground', me))
for name, at, power in [('key', (-8, -12, 18), 3300), ('fill', (9, -2, 14), 1900), ('rim', (0, 10, 14), 2600)]:
    d = bpy.data.lights.new(name, 'AREA'); d.energy = power; d.shape = 'DISK'; d.size = 14; o = link(bpy.data.objects.new(name, d)); o.location = at; aim(o, (0, 0, 1))
cam = link(bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))); cam.data.type = 'ORTHO'; scene.camera = cam
scene.world = bpy.data.worlds.new('w'); scene.world.use_nodes = True
bg = scene.world.node_tree.nodes['Background']; bg.inputs[0].default_value = (.21, .24, .22, 1); bg.inputs[1].default_value = .55
scene.render.engine = 'CYCLES'; scene.cycles.samples = 8; scene.cycles.use_denoising = False
try:
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for kind in ('OPTIX', 'CUDA'):
        prefs.compute_device_type = kind; prefs.get_devices()
        if any(d.type == kind for d in prefs.devices):
            for d in prefs.devices: d.use = d.type == kind
            scene.cycles.device = 'GPU'; break
except Exception: pass
scene.view_settings.view_transform = 'Standard'; scene.render.image_settings.file_format = 'PNG'; scene.render.resolution_percentage = 100
ref = material('1.8 m reference', (.28, .42, .42)); figure = []
bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=.18, depth=1.44, location=(0, 0, .9)); figure.append(bpy.context.object)
for z in [.18, 1.62]:
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=6, radius=.18, location=(0, 0, z)); figure.append(bpy.context.object)
for o in figure: o.data.materials.append(ref)
def move_figure(x, y):
    for o in figure: o.location.x = x; o.location.y = y
texts = []
def label(text, at, size=.14):
    d = bpy.data.curves.new('label', 'FONT'); d.body = text; d.size = size; d.align_x = 'CENTER'; o = link(bpy.data.objects.new('label', d)); o.location = at
    o.data.materials.append(material('label', (.9, .88, .8))); texts.append(o); return o

for p in props: place(p, (0, 0)); show(p, False)
for i, p in enumerate(props):
    show(p, True); w = p['hi'].x - p['lo'].x; move_figure(p['lo'].x - .45, 0)
    lo = Vector((min(p['lo'].x, p['lo'].x - .7), p['lo'].y, 0)); hi = Vector((p['hi'].x, p['hi'].y, max(p['hi'].z, 1.8)))
    target = (lo + hi) / 2; span = max(hi - lo)
    cam.location = target + Vector((1.0, -1.85, 1.1)) * span; aim(cam, target); cam.data.ortho_scale = span * 1.55
    scene.render.resolution_x = 900; scene.render.resolution_y = 900
    scene.render.filepath = str(cards / ('prop-' + p['name'] + '.png')); bpy.ops.render.render(write_still=True)
    if p['name'] in painted:
        originals=[(ob,list(ob.data.materials)) for ob in p['meshes']]
        clay=material('geometry review clay',(.42,.42,.42))
        for ob,mats in originals:
            for slot in ob.material_slots:slot.material=clay
        scene.render.filepath=str(cards/('clay-'+p['name']+'.png'));bpy.ops.render.render(write_still=True)
        for ob,mats in originals:
            for slot,ma in zip(ob.material_slots,mats):
                unlit=bpy.data.materials.new('unlit artwork review');unlit.use_nodes=True;nt=unlit.node_tree;nt.nodes.clear();out=nt.nodes.new('ShaderNodeOutputMaterial');em=nt.nodes.new('ShaderNodeEmission');em.inputs['Strength'].default_value=1
                image=next((n.image for n in ma.node_tree.nodes if n.type=='TEX_IMAGE'),None)
                if image:
                    tex=nt.nodes.new('ShaderNodeTexImage');tex.image=image;tex.interpolation='Closest';nt.links.new(tex.outputs['Color'],em.inputs['Color'])
                else:em.inputs['Color'].default_value=ma.diffuse_color
                nt.links.new(em.outputs[0],out.inputs['Surface']);slot.material=unlit
        scene.render.filepath=str(cards/('unlit-'+p['name']+'.png'));bpy.ops.render.render(write_still=True)
        for ob,mats in originals:
            for slot,ma in zip(ob.material_slots,mats):slot.material=ma
    show(p, False)

if sheet:
    x = 0.0; gap = .8
    move_figure(-.6, 0); label('1.8 m', (-.6, -1.0, .01))
    for i, p in enumerate(props):
        w = p['hi'].x - p['lo'].x; place(p, (x + w / 2, 0)); show(p, True)
        label(labels[i] if i < len(labels) and labels[i] else p['name'], (x + w / 2, -1.0 - (i % 2) * .3, .01)); x += w + gap
    lo = Vector((-1.2, -1.8, 0)); hi = Vector((x, 1.5, max(max(p['hi'].z for p in props), 1.8)))
    target = (lo + hi) / 2; span = max(hi.x - lo.x, 3)
    cam.location = target + Vector((.35, -1.6, 1.0)) * span; aim(cam, target); cam.data.ortho_scale = span * 1.08
    scene.render.resolution_x = 2400; scene.render.resolution_y = max(900, int(2400 * (hi.z + 2.5) / span))
    scene.render.filepath = str(Path(sheet)); bpy.ops.render.render(write_still=True)
print('prop-codex render: %d card(s)%s' % (len(props), ', sheet ' + sheet if sheet else ''))
