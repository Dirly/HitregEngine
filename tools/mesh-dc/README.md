# Blender structures to DC

This bridge turns a modeled structure into an editable DC volume prefab. The
Blender file remains the modeling source; imported indexed solids become mesh
CSG nodes that support the same add, subtract, and paint operations as native
volumes. The registered **Blender to DC** tool supplies the import form. Its
manifest and the engine spec describe the exact input and output schemas.

## Prepare the Blender source

Model walls, floors, roofs, columns, and architectural supports with thickness.
Each connected part must enclose a volume. Independent closed parts may touch or
overlap: they are combined as solid material. An open room is made from closed
walls and floors around an empty interior, not from an open surface shell.

Keep furniture, doors, treasure, and other props separate. Mark those objects
with `dc_role = "prop"` or `dc_export = False` to omit them. Columns remain part
of the structure. The exporter uses selected meshes unless objects are explicitly
tagged `dc_export = True`. Assign `dc_group` to combine nearby structural parts
into a room or passage. Group size controls extraction cost, so avoid one giant
bounding box around a branching dungeon.

Run `export_blender.py` inside Blender through MCP or its Text Editor, then call
the exported function. For example, with the entry point already loaded:

```python
export_mesh_stamp(
    "/absolute/project/authoring/dungeon.mesh-stamp.json",
    anchor=(0, -48, 0),
    name="Dungeon structure",
    audit_path="/absolute/project/reports/source-audit.json",
)
```

The anchor is a measured Blender world position, normally the entrance landing.
The exporter evaluates modifiers and object transforms, converts Blender Z-up
to engine Y-up, and preserves the entrance-relative placement of every group.
It collects indexed loose solids before glTF can split vertices at material or
normal boundaries. It can normalize face winding, but refuses open or degenerate
parts. Fix source holes in Blender; the importer also rejects self-intersecting
solids. A supplied audit records source rejection and excluded parts.

## Import and stamp

Choose the exported JSON in **Blender to DC**, supply a fresh output name, and
import a representative group first. The tool writes native volume assets, a
palette material, and a prefab with an empty entrance anchor. Instantiate that
prefab using ordinary scene ops to stamp the construction. It contains native
CSG sources, so subtractive cuts and painting remain available.

For a project import, create the output namespace folders under that project's
`assets/volumes/`, `assets/materials/`, and `assets/prefabs/` first. The dev host
uses existing folder ownership to route new assets into the project. The stamp
prefab is written inside that namespace as `stamp.json`.

Import success means source validation passed. The first load extracts DC
geometry. Check the extracted mesh for closed topology, then validate the
actual render/collision geometry with the player's capsule in both directions
and on lateral lanes. Only then import and check the remaining groups. Thin
details below the selected voxel size may disappear, and a valid source does
not guarantee that a particular sampling resolution preserves its topology.
Keep an editable recipe when baking a runtime model; both rendering and
collision must use the same bake, and edits require a new bake.

## Preset materials and repainting

Assign Blender material slots by stable surface role: flagstone, dressed trim,
vault ceiling, basalt, wood, and so on. A material's `dc_role` property can map
its display name to that role; the export function also accepts an explicit
role mapping and palette. Assigning an object's `dc_material` overrides all of
its face slots. Supply the full ordered palette for repeatable imports even
when some roles are unused.

The bridge preserves triangle material roles as DC palette channels and creates
an initial color material. It does not translate Blender shader graphs or UV
layouts: DC creates new topology. Attach the engine's preset textures to the
matching material layers after import. Keep layer order stable. Replacing a
layer's texture changes that surface throughout the stamp; native volume paint
changes a local area's layer weights without changing the solid geometry.
In the editor's **Volume paint** panel, choose the room under **Structure**, pick
its surface under **Texture**, Shift-drag, then **Save paint**. Prefab children
appear in this selector too. Instances sharing one volume asset share its paint;
duplicate the asset when a stamp needs independent paint.
See [dungeon material guidance](../../docs/dungeon-materials.md) for the eleven
standard roles and theme swaps.

The importer also saves one ready composition JSON per group in its run folder's
`dc-compositions/` directory; their paths and material ID appear in the report.
Upload one in **Carved Stone Library → Scoped composition recipe**, enter the
reported **Palette material ID**, and choose a new output name. The resulting
baked prefab can be placed repeatedly. To union several pieces, repeat recipe
instances with distinct IDs, set their `position` and `yaw`, and bake that scoped
composition. Keep palette names and order identical. Import does not infer
architectural connections, protected air or bearing contracts; validate these
when fitting a stamp into a host.

The DC exporter retains every palette weight channel, including the third group
needed by the eleven-role dungeon palette. Rotated and translated mesh
composition is covered by its export test. The editable native prefab remains
the source for later painting; changing a baked prefab requires a fresh bake.

## Verify the bridge

`node --test tools/mesh-dc/self-test.mjs` checks the converter and registered
runner. `pnpm test` includes these checks and the core mesh-field tests. Source
audits, extracted topology checks, traversal, and visual evidence are still
required for each authored dungeon.
