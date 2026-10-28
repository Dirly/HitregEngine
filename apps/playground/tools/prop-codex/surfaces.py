"""Named painted UV surfaces over the existing Mesh helper. Loaded by build.py; no runtime dependency."""
import hashlib
from mathutils.geometry import tessellate_polygon

PROJECTIONS = {'front': (0, 2, (0,-1,0)), 'back': (0,2,(0,1,0)),
               'left': (1,2,(-1,0,0)), 'right': (1,2,(1,0,0)),
               'top': (0,1,(0,0,1)), 'bottom': (0,1,(0,0,-1))}

def paint(m, name, *, part, projection='front', detail):
    """Paint the facing surface of a named modeled part. Keep silhouette/functional depth in geometry."""
    if not isinstance(name,str) or not name or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in name):
        raise ValueError('paint surface name must be a lowercase slug')
    if projection not in [*PROJECTIONS,'cylinder']:
        raise ValueError('paint projection must be front/back/left/right/top/bottom/cylinder')
    if not isinstance(detail,str) or not detail.strip():raise ValueError('paint detail must describe the artwork')
    declarations=getattr(m,'paint_surfaces',[])
    if any(d['name']==name for d in declarations):raise ValueError('duplicate paint surface '+name)
    declarations.append(dict(name=name,part=part,projection=projection,detail=detail))
    m.paint_surfaces=declarations

def clipped(poly, axis, bound, above):
    result=[]
    for a,b in zip(poly,poly[1:]+poly[:1]):
        ia=a[1][axis]>=bound-1e-8 if above else a[1][axis]<=bound+1e-8
        ib=b[1][axis]>=bound-1e-8 if above else b[1][axis]<=bound+1e-8
        if ia:result.append(a)
        if ia!=ib:
            t=(bound-a[1][axis])/(b[1][axis]-a[1][axis]);result.append((a[0].lerp(b[0],t),a[1].lerp(b[1],t)))
    return result

def face_pieces(points,coords,period=1,wrap=False):
    poly=[(Vector(p),Vector(uv)) for p,uv in zip(points,coords)]
    first=math.floor(min(uv[0] for uv in coords)) if wrap else 0
    last=math.floor(max(uv[0] for uv in coords)-1e-8) if wrap else 0
    for ix in range(first,max(first,last)+1):
        p=clipped(poly,0,ix*period,True);p=clipped(p,0,(ix+1)*period,False) if p else []
        p=clipped(p,1,0,True) if p else [];p=clipped(p,1,1,False) if p else []
        p=[x for j,x in enumerate(p) if (x[0]-p[j-1][0]).length>1e-7]
        if len(p)>=3:yield [(pos,Vector((uv.x-ix,uv.y))) for pos,uv in p]

def describe_paint(m):
    faces={};surfaces=[];offset=0;parts={}
    for p in m.parts:
        parts.setdefault(p['part'],[]).extend(range(offset,offset+p['faces']));offset+=p['faces']
    for declaration in getattr(m,'paint_surfaces',[]):
        projection=declaration['projection'];selected=[]
        for fi in parts.get(declaration['part'],[]):
            pts=[Vector(m.v[i]) for i in m.f[fi]]
            n=(pts[1]-pts[0]).cross(pts[2]-pts[0]).normalized()
            if (abs(n.z)<.65 if projection=='cylinder' else n.dot(Vector(PROJECTIONS[projection][2]))>=.65):selected.append(fi)
        if not selected:raise ValueError('paint surface '+declaration['name']+' has no facing polygons on part '+str(declaration['part']))
        if any(fi in faces for fi in selected):raise ValueError('paint surfaces overlap on the same mesh faces')
        allpoints=[Vector(m.v[i]) for fi in selected for i in m.f[fi]]
        if projection=='cylinder':
            cx=(min(p.x for p in allpoints)+max(p.x for p in allpoints))/2;cy=(min(p.y for p in allpoints)+max(p.y for p in allpoints))/2
            radius=max(math.hypot(p.x-cx,p.y-cy) for p in allpoints);lo=min(p.z for p in allpoints);width=math.tau*radius;height=max(p.z for p in allpoints)-lo
        else:
            ax,ay,_=PROJECTIONS[projection];lx=min(p[ax] for p in allpoints);ly=min(p[ay] for p in allpoints)
            width=max(p[ax] for p in allpoints)-lx;height=max(p[ay] for p in allpoints)-ly
        if min(width,height)<.025:raise ValueError('paint surface is edge-on or smaller than one texel: '+declaration['name'])
        triangles=[]
        for fi in selected:
            pts=[Vector(m.v[i]) for i in m.f[fi]]
            if projection=='cylinder':
                angles=[math.atan2(p.y-cy,p.x-cx)%math.tau for p in pts]
                if max(angles)-min(angles)>math.pi:angles=[a+math.tau if a<math.pi else a for a in angles]
                uv=[(a/math.tau,(p.z-lo)/height) for a,p in zip(angles,pts)]
            else:
                uv=[((p[ax]-lx)/width,(p[ay]-ly)/height) for p in pts]
                # Read front/back and left/right as if looking at the respective face.
                if projection in ['back','left','bottom']:uv=[(1-u,v) for u,v in uv]
            faces[fi]=(declaration['name'],uv,projection=='cylinder')
            for piece in face_pieces(pts,uv,wrap=projection=='cylinder'):
                coords=[Vector((p[1].x,p[1].y,0)) for p in piece]
                for tri in tessellate_polygon([coords]):
                    # Blender 5.2 returns flattened indices; older releases returned Vectors.
                    triangles.append([[coords[v].x,coords[v].y] if isinstance(v,int) else [v.x,v.y] for v in tri])
        surfaces.append({**declaration,'metres':[width,height],'pixels':[max(2,round(width*40)),max(2,round(height*40))],'triangles':triangles,'faces':len(selected)})
    payload={'vertices':m.v,'faces':m.f,'uv':m.uv,'roles':m.roles,'surfaces':surfaces,
             'uvHelperSha256':hashlib.sha256((Path(__file__).parent/'surfaces.py').read_bytes()).hexdigest()}
    digest=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return {'geometrySha256':digest,'surfaces':surfaces,'roles':sorted(set(m.roles))},faces

def painted_object(m, plan, face_map, layout, material, wall=False):
    """Preserve metre UVs for shared tiles, explicit unique UVs for artwork, on one material/page."""
    used={i for f in m.f for i in f};lo=[min(m.v[i][k] for i in used) for k in range(3)];hi=[max(m.v[i][k] for i in used) for k in range(3)]
    m.shift=Vector(((lo[0]+hi[0])/2,hi[1] if wall else (lo[1]+hi[1])/2,(lo[2]+hi[2])/2 if wall else lo[2]))
    vv=[];ff=[];uu=[];size=layout['size']
    def add_piece(piece,region,painted):
        piece=[p for j,p in enumerate(piece) if (p[0]-piece[j-1][0]).length>1e-7]
        if len(piece)<3:return
        if sum((piece[j][0]-piece[0][0]).cross(piece[j+1][0]-piece[0][0]).length for j in range(1,len(piece)-1))<1e-10:return
        start=len(vv);vv.extend([pos-m.shift for pos,uv in piece]);ff.append(tuple(start+j for j in range(len(piece))))
        if painted:uu.append([((region['x']+uv.x*region['w'])/size,1-(region['y']+(1-uv.y)*region['h'])/size) for _,uv in piece])
        else:uu.append([((region['x']+6+uv.x*40)/size,1-(region['y']+128-6-uv.y*40)/size) for _,uv in piece])
    for fi,(face,coords,role) in enumerate(zip(m.f,m.uv,m.roles)):
        pts=[Vector(m.v[i]) for i in face]
        if fi in face_map:
            name,uv,wrap=face_map[fi]
            for piece in face_pieces(pts,uv,wrap=wrap):add_piece(piece,layout['surfaces'][name],True)
        else:
            poly=[(pos,Vector(uv)) for pos,uv in zip(pts,coords)];period=2.9
            low=[math.floor(min(uv[k] for uv in coords)/period) for k in range(2)];high=[math.floor((max(uv[k] for uv in coords)-1e-8)/period) for k in range(2)]
            for ix in range(low[0],max(low[0],high[0])+1):
                for iy in range(low[1],max(low[1],high[1])+1):
                    p=poly
                    for axis,bound in [(0,ix*period),(1,iy*period)]:
                        p=clipped(p,axis,bound,True);p=clipped(p,axis,bound+period,False) if p else []
                    add_piece([(pos,Vector((uv.x-ix*period,uv.y-iy*period))) for pos,uv in p],layout['roles'][role],False)
    me=bpy.data.meshes.new(m.name);me.from_pydata(vv,[],ff);me.update();layer=me.uv_layers.new(name='UVMap')
    for f,coords in zip(me.polygons,uu):
        for li,uv in zip(f.loop_indices,coords):layer.data[li].uv=uv
    bm=bmesh.new();bm.from_mesh(me);bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-6);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bmesh.ops.triangulate(bm,faces=list(bm.faces));bmesh.ops.dissolve_degenerate(bm,dist=1e-7,edges=list(bm.edges));bm.to_mesh(me);bm.free();me.update()
    ob=bpy.data.objects.new(m.name,me);collection.objects.link(ob);me.materials.append(material)
    for f in me.polygons:f.use_smooth=False
    return ob
