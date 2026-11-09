"""Named painted UV surfaces over the existing Mesh helper. Loaded by build.py; no runtime dependency."""
import hashlib
from mathutils.geometry import tessellate_polygon

PROJECTIONS = {'front': (0, 2, (0,-1,0)), 'back': (0,2,(0,1,0)),
               'left': (1,2,(-1,0,0)), 'right': (1,2,(1,0,0)),
               'top': (0,1,(0,0,1)), 'bottom': (0,1,(0,0,-1))}
AXES = {'x': 0, 'y': 1, 'z': 2}
FLIPS = {None: (False, False), 'u': (True, False), 'v': (False, True), 'uv': (True, True)}
SHARE_TOLERANCE = .03  # metres: a sharer's span may exceed its target's by about one 40 tx/m texel
# The UV rules' identity, hashed into every guide's geometrySha256. It was this file's own sha, so ANY edit staled every
# painted prop. Now it is a pinned value: change it (to the new file's sha256) only when an edit moves the UVs of
# declarations that already exist. r-ring 2026-10-30: share/flip/mirror are opt-in and leave plain declarations as
# they were, so the value stays at the sha of the file before them.
UV_RULES = '6e86fe77a6cc69faba730a5d00b355d4e53156a0a42f50c48b1532712e1816be'

def paint(m, name, *, part, projection='front', detail=None, share=None, flip=None, mirror=None, glow=None):
    """Paint the facing surface of a named modeled part. Keep silhouette/functional depth in geometry.

    share='<surface>': these faces reuse that declared surface's region at the SAME scale (metres per texel), anchored
    at the region's lower-left corner; the sharer's span must fit inside the target's span, or it is a fault. flip
    mirrors the sharer's footprint inside the region: True/'u' left-right (a back face reading the front's art at the
    same world point), 'v' top-bottom, 'uv' both (a copy turned 180 degrees about the projection axis).
    mirror=(axis, at) folds the projected UVs about the plane axis=at ('x'|'y'|'z', in the projection's own plane): the
    + side lands on the - side ('-x' etc. folds the - side onto the + side), so one side is painted. Faces crossing the
    plane are split along it. A sharer may also fold (the fold happens before the share).
    glow=<0..1>: the surface glows by its OWN painted pixels (emissive = the artwork x glow; a second material on the
    same page, no light). For self-lit art such as amber-cored eggs; paint the glow into the art. Sharers inherit it."""
    if not isinstance(name,str) or not name or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in name):
        raise ValueError('paint surface name must be a lowercase slug')
    if projection not in [*PROJECTIONS,'cylinder']:
        raise ValueError('paint projection must be front/back/left/right/top/bottom/cylinder')
    if share is None and (not isinstance(detail,str) or not detail.strip()):raise ValueError('paint detail must describe the artwork')
    if share is not None and (not isinstance(share,str) or share==name):raise ValueError('paint share names another paint surface')
    flip={False:None,True:'u'}.get(flip,flip) if isinstance(flip,bool) or flip is None else flip
    if flip not in FLIPS:raise ValueError("paint flip must be True, 'u', 'v' or 'uv'")
    if flip and share is None:raise ValueError('paint flip only applies to a shared surface')
    if glow is not None and (share is not None or not isinstance(glow,(int,float)) or not 0<glow<=1):raise ValueError('paint glow is a number in (0, 1] on an original surface (sharers inherit it)')
    if mirror is not None:
        if projection=='cylinder':raise ValueError('paint mirror does not apply to a cylinder wrap')
        if not (isinstance(mirror,(tuple,list)) and len(mirror)==2 and str(mirror[0]).lstrip('+-') in AXES and isinstance(mirror[1],(int,float))):
            raise ValueError("paint mirror is (axis, at): axis 'x'|'y'|'z' (a '-' prefix folds the - side), at in metres")
        if AXES[str(mirror[0]).lstrip('+-')] not in PROJECTIONS[projection][:2]:raise ValueError('paint mirror axis must lie in the '+projection+' projection plane')
        mirror=[str(mirror[0]),float(mirror[1])]
    declarations=getattr(m,'paint_surfaces',[])
    if any(d['name']==name for d in declarations):raise ValueError('duplicate paint surface '+name)
    d=dict(name=name,part=part,projection=projection,detail=detail if share is None else (detail or ''))
    if share is not None:d['share']=share;d['flip']=flip
    if mirror is not None:d['mirror']=mirror
    if glow is not None:d['glow']=float(glow)
    declarations.append(d)
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

def folded_polys(pts,uv,fold):
    """Split one face's projected polygon along the fold line (uv component k = c) and reflect the far piece."""
    if fold is None:return [(list(pts),[tuple(t) for t in uv])]
    k,c,plus=fold;poly=[(Vector(p),Vector(t)) for p,t in zip(pts,uv)];out=[]
    for piece,reflect in [(clipped(poly,k,c,not plus),False),(clipped(poly,k,c,plus),True)]:
        piece=[x for j,x in enumerate(piece) if (x[0]-piece[j-1][0]).length>1e-7]
        if len(piece)<3:continue
        coords=[]
        for _,t in piece:
            t=Vector(t)
            if reflect:t[k]=2*c-t[k]
            coords.append((t.x,t.y))
        out.append(([p for p,_ in piece],coords))
    return out

def describe_paint(m):
    faces={};surfaces=[];offset=0;parts={};spans={}
    for p in m.parts:
        parts.setdefault(p['part'],[]).extend(range(offset,offset+p['faces']));offset+=p['faces']
    declarations=getattr(m,'paint_surfaces',[])
    for d in declarations:
        if d.get('share') is None:continue
        target=next((t for t in declarations if t['name']==d['share']),None)
        if target is None:raise ValueError('paint surface '+d['name']+' shares unknown surface '+d['share'])
        if target.get('share') is not None:raise ValueError('paint surface '+d['name']+' shares '+target['name']+', which itself shares: share the original')
    # Originals first: a sharer is measured against its target's span.
    for declaration in [d for d in declarations if d.get('share') is None]+[d for d in declarations if d.get('share') is not None]:
        projection=declaration['projection'];selected=[]
        for fi in parts.get(declaration['part'],[]):
            pts=[Vector(m.v[i]) for i in m.f[fi]]
            n=(pts[1]-pts[0]).cross(pts[2]-pts[0]).normalized()
            if (abs(n.z)<.65 if projection=='cylinder' else n.dot(Vector(PROJECTIONS[projection][2]))>=.65):selected.append(fi)
        if not selected:raise ValueError('paint surface '+declaration['name']+' has no facing polygons on part '+str(declaration['part']))
        if any(fi in faces for fi in selected):raise ValueError('paint surfaces overlap on the same mesh faces')
        allpoints=[Vector(m.v[i]) for fi in selected for i in m.f[fi]]
        fold=None
        if projection=='cylinder':
            cx=(min(p.x for p in allpoints)+max(p.x for p in allpoints))/2;cy=(min(p.y for p in allpoints)+max(p.y for p in allpoints))/2
            radius=max(math.hypot(p.x-cx,p.y-cy) for p in allpoints);lo=min(p.z for p in allpoints);width=math.tau*radius;height=max(p.z for p in allpoints)-lo
        else:
            ax,ay,_=PROJECTIONS[projection];coords=[[p[ax],p[ay]] for p in allpoints];lo2=[min(c[j] for c in coords) for j in range(2)];hi2=[max(c[j] for c in coords) for j in range(2)]
            if declaration.get('mirror'):
                axis_name,at=declaration['mirror'];plus=not axis_name.startswith('-');k=[ax,ay].index(AXES[axis_name.lstrip('+-')])
                folded=[2*at-c[k] if ((c[k]>at) if plus else (c[k]<at)) else c[k] for c in coords]
                # The fold line bounds the span only where a face crosses it (its cut edge lies on the line).
                crossed=any(min(m.v[i][AXES[axis_name.lstrip('+-')]] for i in m.f[fi])<at-1e-7<at+1e-7<max(m.v[i][AXES[axis_name.lstrip('+-')]] for i in m.f[fi]) for fi in selected)
                lo2[k]=min(folded);hi2[k]=max(folded)
                if crossed:
                    if plus:hi2[k]=at
                    else:lo2[k]=at
                fold=(k,(at-lo2[k])/(hi2[k]-lo2[k]) if hi2[k]>lo2[k] else 0,plus)
            lx,ly=lo2;width,height=hi2[0]-lo2[0],hi2[1]-lo2[1]
        if min(width,height)<.025:raise ValueError('paint surface is edge-on or smaller than one texel: '+declaration['name'])
        target=declaration.get('share');region=declaration['name'] if target is None else target
        if target is None:spans[region]=(width,height);su=sv=1
        else:
            tw,th=spans[target]
            if width>tw+SHARE_TOLERANCE or height>th+SHARE_TOLERANCE:
                raise ValueError('paint surface %s (%.3f x %.3f m) does not fit the surface it shares, %s (%.3f x %.3f m): a share keeps the scale'%(declaration['name'],width,height,target,tw,th))
            su,sv=min(1,width/tw),min(1,height/th)  # same metres per texel as the target
        fu,fv=FLIPS[declaration.get('flip')]
        triangles=[]
        for fi in selected:
            pts=[Vector(m.v[i]) for i in m.f[fi]]
            if projection=='cylinder':
                angles=[math.atan2(p.y-cy,p.x-cx)%math.tau for p in pts]
                if max(angles)-min(angles)>math.pi:angles=[a+math.tau if a<math.pi else a for a in angles]
                uv=[(a/math.tau,(p.z-lo)/height) for a,p in zip(angles,pts)]
            else:
                uv=[((p[ax]-lx)/width,(p[ay]-ly)/height) for p in pts]
            polys=[]
            for poly_pts,coords in folded_polys(pts,uv,fold):
                # Read front/back and left/right as if looking at the respective face.
                if projection in ['back','left','bottom']:coords=[(1-u,v) for u,v in coords]
                if fu:coords=[(1-u,v) for u,v in coords]
                if fv:coords=[(u,1-v) for u,v in coords]
                coords=[(u*su,v*sv) for u,v in coords]
                polys.append((poly_pts,coords))
            faces[fi]=(region,polys,projection=='cylinder')
            for poly_pts,coords in polys:
                for piece in face_pieces(poly_pts,coords,wrap=projection=='cylinder'):
                    tc=[Vector((p[1].x,p[1].y,0)) for p in piece]
                    for tri in tessellate_polygon([tc]):
                        # Blender 5.2 returns flattened indices; older releases returned Vectors.
                        triangles.append([[tc[v].x,tc[v].y] if isinstance(v,int) else [v.x,v.y] for v in tri])
        if target is None:
            surfaces.append({**declaration,'metres':[width,height],'pixels':[max(2,round(width*40)),max(2,round(height*40))],'triangles':triangles,'faces':len(selected)})
        else:
            host=next(s for s in surfaces if s['name']==target);host['triangles'].extend(triangles);host['faces']+=len(selected)
            host.setdefault('shared',[]).append(declaration['name'])
    payload={'vertices':m.v,'faces':m.f,'uv':m.uv,'roles':m.roles,'surfaces':surfaces,'uvHelperSha256':UV_RULES}
    digest=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    return {'geometrySha256':digest,'surfaces':surfaces,'roles':sorted(set(m.roles))},faces

def glow_material(material, strength):
    """The same page, emitting its own pixels x strength: glTF emissiveTexture = the base colour texture, emissiveFactor = strength."""
    g=material.copy();g.name=material.name+' • glow';nodes=g.node_tree.nodes
    bsdf=next(n for n in nodes if n.type=='BSDF_PRINCIPLED');tex=next(n for n in nodes if n.type=='TEX_IMAGE')
    g.node_tree.links.new(tex.outputs['Color'],bsdf.inputs['Emission Color']);bsdf.inputs['Emission Strength'].default_value=strength
    return g

def painted_object(m, plan, face_map, layout, material, wall=False):
    """Preserve metre UVs for shared tiles, explicit unique UVs for artwork, on one material/page."""
    used={i for f in m.f for i in f};lo=[min(m.v[i][k] for i in used) for k in range(3)];hi=[max(m.v[i][k] for i in used) for k in range(3)]
    m.shift=Vector(((lo[0]+hi[0])/2,hi[1] if wall else (lo[1]+hi[1])/2,(lo[2]+hi[2])/2 if wall else lo[2]))
    vv=[];ff=[];uu=[];gg=[];size=layout['size'];glow={s['name']:s['glow'] for s in plan.get('surfaces',[]) if s.get('glow')}
    def add_piece(piece,region,painted):
        piece=[p for j,p in enumerate(piece) if (p[0]-piece[j-1][0]).length>1e-7]
        if len(piece)<3:return
        if sum((piece[j][0]-piece[0][0]).cross(piece[j+1][0]-piece[0][0]).length for j in range(1,len(piece)-1))<1e-10:return
        start=len(vv);vv.extend([pos-m.shift for pos,uv in piece]);ff.append(tuple(start+j for j in range(len(piece))));gg.append(1 if painted and current_region[0] in glow else 0)
        if painted:uu.append([((region['x']+uv.x*region['w'])/size,1-(region['y']+(1-uv.y)*region['h'])/size) for _,uv in piece])
        else:uu.append([((region['x']+6+uv.x*40)/size,1-(region['y']+128-6-uv.y*40)/size) for _,uv in piece])
    current_region=[None]
    for fi,(face,coords,role) in enumerate(zip(m.f,m.uv,m.roles)):
        pts=[Vector(m.v[i]) for i in face]
        if fi in face_map:
            name,polys,wrap=face_map[fi];current_region[0]=name
            for poly_pts,uv in polys:
                for piece in face_pieces(poly_pts,uv,wrap=wrap):add_piece(piece,layout['surfaces'][name],True)
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
    for f,coords,g in zip(me.polygons,uu,gg):
        f.material_index=g
        for li,uv in zip(f.loop_indices,coords):layer.data[li].uv=uv
    bm=bmesh.new();bm.from_mesh(me);bmesh.ops.remove_doubles(bm,verts=list(bm.verts),dist=1e-6);bmesh.ops.recalc_face_normals(bm,faces=list(bm.faces));bmesh.ops.triangulate(bm,faces=list(bm.faces));bmesh.ops.dissolve_degenerate(bm,dist=1e-7,edges=list(bm.edges));bm.to_mesh(me);bm.free();me.update()
    ob=bpy.data.objects.new(m.name,me);collection.objects.link(ob);me.materials.append(material)
    if glow:me.materials.append(glow_material(material,max(glow.values())))
    for f in me.polygons:f.use_smooth=False
    return ob
