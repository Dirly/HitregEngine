"""Packed images in a .blend, run by blend-images.mjs. `dedupe()` is importable by any script that imports glTFs into a
kept .blend: every import packs its own copy of the atlas, which took two low-poly kits to 870 MB and 500 MB."""
import bpy, hashlib, json, sys


def image_key(image):
    # same bytes under another colour space or alpha mode is a different texture
    return hashlib.sha1(bytes(image.packed_file.data)).hexdigest(), image.colorspace_settings.name, image.alpha_mode


def dedupe():
    """Point every user of a duplicate packed image at one copy, then purge. Returns how many copies went."""
    kept, removed = {}, 0
    for image in sorted((i for i in bpy.data.images if i.packed_file), key=lambda i: (len(i.name), i.name)):
        key = image_key(image)
        if key in kept:
            image.user_remap(kept[key])
            removed += 1
        else:
            kept[key] = image
    bpy.data.orphans_purge(do_local_ids=True, do_linked_ids=True, do_recursive=True)
    return removed


def signature():
    """A hash of what every object is: its mesh and, per material slot, the textures it samples and how."""
    keys, digest = {}, hashlib.sha1()
    for ob in sorted(bpy.data.objects, key=lambda o: o.name):
        digest.update(f"{ob.name}|{ob.type}|{list(map(tuple, ob.matrix_world))}".encode())
        if ob.type != "MESH":
            continue
        digest.update(f"{len(ob.data.vertices)}|{len(ob.data.polygons)}".encode())
        positions = [0.0] * (len(ob.data.vertices) * 3)
        ob.data.vertices.foreach_get("co", positions)
        digest.update(repr(positions).encode())
        for slot in ob.material_slots:
            material = slot.material
            nodes = material.node_tree.nodes if material and material.node_tree else []
            for node in sorted((n for n in nodes if n.type == "TEX_IMAGE" and n.image), key=lambda n: n.name):
                image = node.image
                if image.name not in keys:
                    keys[image.name] = image_key(image) if image.packed_file else ("file", image.filepath)
                digest.update(f"{node.name}|{node.interpolation}|{keys[image.name]}".encode())
    return digest.hexdigest()


def report():
    packed = [i for i in bpy.data.images if i.packed_file]
    return {
        "packed": len(packed),
        "distinct": len({image_key(i) for i in packed}),
        "packedBytes": sum(i.packed_file.size for i in packed),
        "objects": len(bpy.data.objects),
        "polygons": sum(len(m.polygons) for m in bpy.data.meshes),
        "signature": signature(),
    }


if __name__ == "__main__" and "--" in sys.argv:
    args = sys.argv[sys.argv.index("--") + 1:]
    if args:
        dedupe()
        bpy.ops.wm.save_as_mainfile(filepath=args[0], compress=True, copy=True)
    else:
        print("BLEND-IMAGES " + json.dumps(report()))
