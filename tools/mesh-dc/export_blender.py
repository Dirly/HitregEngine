"""Blender-side source bridge. Run through Blender MCP or Blender's Text Editor.

Preserves indexed loose solids before glTF's normal/material vertex splitting.
Closed topology is mandatory. Winding is normalized; holes are never filled.
"""
from collections import defaultdict, deque
import json
import math
import os
from pathlib import Path


def orient_closed_solid(positions, triangles, label):
    """Validate and orient a single indexed closed connected solid outward."""
    edges = defaultdict(list)
    for ti, tri in enumerate(triangles):
        if len(set(tri)) != 3:
            raise ValueError(f'{label}: repeated vertex in triangle {ti}')
        a, b, c = (positions[i] for i in tri)
        ab = [b[k]-a[k] for k in range(3)]
        ac = [c[k]-a[k] for k in range(3)]
        cross = [ab[1]*ac[2]-ab[2]*ac[1], ab[2]*ac[0]-ab[0]*ac[2], ab[0]*ac[1]-ab[1]*ac[0]]
        if sum(v*v for v in cross) < 1e-18:
            raise ValueError(f'{label}: degenerate triangle {ti}')
        for p, q in zip(tri, tri[1:]+tri[:1]):
            edges[min(p,q),max(p,q)].append((ti, p < q))
    bad = [(edge,len(uses)) for edge,uses in edges.items() if len(uses) != 2]
    if bad:
        opened = sum(n == 1 for _,n in bad)
        nonmanifold = sum(n > 2 for _,n in bad)
        raise ValueError(f'{label}: not closed ({opened} boundary edges, {nonmanifold} nonmanifold edges)')
    adjacency = defaultdict(list)
    for uses in edges.values():
        (a,da),(b,db) = uses
        adjacency[a].append((b,da == db))
        adjacency[b].append((a,da == db))
    flips = {0:False}
    queue = deque([0])
    while queue:
        a = queue.popleft()
        for b, toggle in adjacency[a]:
            wanted = flips[a] ^ toggle
            if b in flips:
                if flips[b] != wanted:
                    raise ValueError(f'{label}: non-orientable surface')
            else:
                flips[b] = wanted
                queue.append(b)
    if len(flips) != len(triangles):
        raise ValueError(f'{label}: disconnected surface inside one solid')
    oriented = [list(reversed(t)) if flips[i] else list(t) for i,t in enumerate(triangles)]
    origin = positions[0]
    volume6 = 0.0
    for tri in oriented:
        a,b,c = [[positions[i][k]-origin[k] for k in range(3)] for i in tri]
        volume6 += a[0]*(b[1]*c[2]-b[2]*c[1]) + a[1]*(b[2]*c[0]-b[0]*c[2]) + a[2]*(b[0]*c[1]-b[1]*c[0])
    if abs(volume6) < 1e-12:
        raise ValueError(f'{label}: closed surface encloses zero volume')
    if volume6 < 0:
        oriented = [list(reversed(t)) for t in oriented]
    return oriented, {'triangles':len(oriented), 'volume':abs(volume6)/6,
                      'windingFacesFlipped':sum(flips.values()), 'wholeSolidReversed':volume6 < 0}


def export_mesh_stamp(filepath, *, objects=None, anchor=(0,0,0), palette=None,
                      material_roles=None, group_for=None, component_filter=None,
                      name='Blender mesh stamp', audit_path=None):
    """Export selected/tagged objects to validated Y-up mesh-stamp JSON.

    Object properties: dc_role='prop' excludes, dc_export=False excludes,
    dc_group groups pieces into a physical section. Material dc_role supplies
    its palette role. Explicit call arguments override these defaults.
    component_filter(obj, bounds, material_names) can omit loose prop solids
    embedded in an older aggregate object. It cannot alter geometry.
    """
    import bpy
    from mathutils import Vector
    if objects is None:
        tagged = [o for o in bpy.context.scene.objects if o.get('dc_export',False)]
        objects = tagged or list(bpy.context.selected_objects)
    objects = sorted(objects, key=lambda o:o.name)
    objects = [o for o in objects if o.type == 'MESH' and o.get('dc_export',True)
               and o.get('dc_role','structure') != 'prop']
    if not objects:
        raise ValueError('Select mesh structures or mark objects dc_export=True')
    palette = [dict(p) for p in (palette or [])]
    role_indices = {p['id']:i for i,p in enumerate(palette)}
    if len(role_indices) != len(palette):
        raise ValueError('Palette roles must be unique')
    material_roles = material_roles or {}
    def material_index(material, override=None):
        mat_name = material.name if material else 'unassigned'
        role = override or material_roles.get(mat_name, material.get('dc_role',mat_name) if material else 'stone')
        if role not in role_indices:
            color = material.diffuse_color[:3] if material else (.45,.45,.45)
            # Blender diffuse channels are linear; export a conventional sRGB swatch.
            def srgb(c): return 12.92*c if c <= .0031308 else 1.055*c**(1/2.4)-.055
            hex_color = '#'+''.join(f'{round(max(0,min(1,srgb(c)))*255):02x}' for c in color)
            role_indices[role] = len(palette)
            palette.append({'id':role,'color':hex_color})
        return role_indices[role]
    groups = {}
    audits = []
    failures = []
    excluded_components = 0
    depsgraph = bpy.context.evaluated_depsgraph_get()
    anchor = Vector(anchor)
    for obj in objects:
        evaluated = obj.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        try:
            mesh.calc_loop_triangles()
            parent = list(range(len(mesh.vertices)))
            def find(a):
                while parent[a] != a:
                    parent[a] = parent[parent[a]]
                    a = parent[a]
                return a
            def union(a,b):
                a,b = find(a),find(b)
                if a != b: parent[b] = a
            for edge in mesh.edges: union(*edge.vertices)
            parts = defaultdict(list)
            for tri in mesh.loop_triangles:
                parts[find(tri.vertices[0])].append(tri)
            group_name = group_for(obj) if group_for else obj.get('dc_group',obj.name)
            if group_name is None:
                continue
            group = groups.setdefault(group_name, {'name':group_name,'positions':[], 'indices':[],
                                     'solidTriangleCounts':[], 'triangleMaterials':[]})
            object_audit = {'object':obj.name, 'group':group_name, 'sourceSolids':len(parts), 'exportedSolids':0}
            for part_index, source_tris in enumerate(parts.values()):
                used = sorted({i for tri in source_tris for i in tri.vertices})
                world = [obj.matrix_world @ mesh.vertices[i].co for i in used]
                bounds = {'min':[min(v[k] for v in world) for k in range(3)],
                          'max':[max(v[k] for v in world) for k in range(3)]}
                material_names = {mesh.materials[t.material_index].name for t in source_tris
                                  if t.material_index < len(mesh.materials) and mesh.materials[t.material_index]}
                if component_filter and not component_filter(obj,bounds,material_names):
                    excluded_components += 1
                    continue
                local_index = {index:i for i,index in enumerate(used)}
                # Proper rotation (+Z up to +Y up), not an axis swap/reflection.
                positions = [[float(v.x-anchor.x),float(v.z-anchor.z),float(-(v.y-anchor.y))] for v in world]
                if not all(math.isfinite(c) for v in positions for c in v):
                    failures.append({'object':obj.name,'solid':part_index,'error':'non-finite coordinates'})
                    continue
                triangles = [[local_index[i] for i in tri.vertices] for tri in source_tris]
                label = f'{obj.name} / solid {part_index}'
                try:
                    triangles, solid_audit = orient_closed_solid(positions,triangles,label)
                except ValueError as error:
                    failures.append({'object':obj.name,'solid':part_index,'error':str(error),'bounds':bounds})
                    continue
                offset = len(group['positions'])//3
                group['positions'].extend(round(c,9) for v in positions for c in v)
                group['indices'].extend(i+offset for tri in triangles for i in tri)
                group['solidTriangleCounts'].append(len(triangles))
                for tri in source_tris:
                    material = mesh.materials[tri.material_index] if tri.material_index < len(mesh.materials) else None
                    group['triangleMaterials'].append(material_index(material,obj.get('dc_material')))
                object_audit['exportedSolids'] += 1
            audits.append(object_audit)
        finally:
            evaluated.to_mesh_clear()
    groups = [g for g in groups.values() if g['indices']]
    report = {'sourceObjects':len(objects),'groups':len(groups), 'objects':audits,
              'excludedComponents':excluded_components,'closureFailures':failures,
              'closedSolids':sum(len(g['solidTriangleCounts']) for g in groups),
              'triangles':sum(len(g['indices'])//3 for g in groups),
              'anchorBlender':list(anchor),'axisConversion':'[x,y,z] -> [x,z,-y], after anchor subtraction',
              'passed':not failures and bool(groups)}
    if audit_path:
        Path(audit_path).parent.mkdir(parents=True,exist_ok=True)
        Path(audit_path).write_text(json.dumps(report,indent=2),encoding='utf-8')
    if failures:
        raise ValueError(f"Export refused: {len(failures)} source solids are not closed/valid. First: {failures[0]['error']}")
    if not groups:
        raise ValueError('No structure solids survived the export filter')
    document = {'version':1,'name':name,'palette':palette,'meshes':groups}
    destination = Path(filepath)
    destination.parent.mkdir(parents=True,exist_ok=True)
    temporary = destination.with_suffix(destination.suffix+'.tmp')
    temporary.write_text(json.dumps(document,separators=(',',':')),encoding='utf-8')
    os.replace(temporary,destination)
    return report
