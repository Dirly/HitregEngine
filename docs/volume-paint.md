# Painting DC volumes

Open a scene containing a `csg` mesh and expand **Volume paint** in the native editor. Deepwake uses this editable source now.

Choose a palette texture, radius and strength. In Brush mode, Shift-drag on the cave. In Angle fill mode, Shift-click: all vertices inside the radius whose normals fall within the chosen angle of the clicked face receive uniform-strength paint. This is a bounded facing-angle fill, not a connected-region flood. It can affect another nearby surface facing the same way within that radius. Ordinary camera navigation remains available without Shift.

**Undo paint / Redo paint** operate on complete gestures in the current session. **Save paint** writes the volume file, preserving the current geometry nodes on disk. Unsaved strokes are held while switching scenes but must be saved before reloading or closing the page. A concurrent paint change on disk blocks saving rather than overwriting that change.

The palette entries correspond to the volume material's triplanar layers. The panel currently targets the first CSG entity in the scene. Radius and normal are volume-local, so a scaled volume scales the brush along with it.

For agents, the registered `csg-volume` schema in the capability spec describes `paint`. Each stroke carries its centre, radius, strength, palette layer, optional normal, maximum angle and fill flag. A floor-area fill can be authored with `normal: [0, 1, 0]`, `maxAngle: 35`, and `fill: true`. Shape edits do not erase this ordered paint history. Deepwake's generator preserves it explicitly.

Painting changes only the material weights. Geometry positions, normals, indices and collision remain unchanged, and paint-only registration retains the geometry cache. Editing shape nodes still invalidates and regenerates that cache.
