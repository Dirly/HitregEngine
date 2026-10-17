# Humanoid hands

For the current Ogre/Frogkin motions, open
`projects/foundation/authoring/creature-motion-v2/creature-motion-v2.blend`.
The HitReg panel has actor/clip buttons and Play. Ogre's hand profile and skin
were revised after a weights-only comparison; `ogre-motion-v2.blend` is its
current source. The earlier `*-hands-v1.blend` files remain repair archives.

For the original hand workbench, open a character's
`projects/foundation/authoring/humanoid-hands-v1/*-hands-v1.blend`.
Select its armature in the Outliner, hover the 3D viewport and press **N**.
Choose **HitReg**, then **Open**, **Grip**, or **Fist**. These preview buttons
pause the active clip. The four Rigify characters also have left/right sliders
and per-knuckle curl settings. **Save grip settings** writes that character's
profile for the next bake. Reopen the file to return to its saved animation.

Blender may ask to allow the embedded Python control panel when opening a file.
It is the same reviewed `blender_hands.py` supplied here, embedded with Rigify's UI.

The game uses its existing animation system. Hand repair is an authoring step:
production clips contain the calibrated finger rotations, so masks, blends,
weapon stances and sockets keep working without a separate runtime hand system.

From the engine root:

```
pnpm -F playground hands bake all
pnpm -F playground hands check
pnpm -F playground hands install
```

`bake` creates candidates and validates actual exported playback. It takes the
installed human body's 144 clips, retains their names, fits their rest poses to
the target, and applies its hand profile. `install` checks the verified file
hashes, preserves existing models as backups, and applies reversible bestiary
ops. Review changed poses before installing a new calibration. A family can be
baked alone; `bake crockin` or `bake frogkin` includes their currently installed
models. Modular appearances now share a canonical creature model, so removed
variant files are skipped. Baking reads the current installed skin, preserving
part IDs, weights and extra joints. Editable skin changes use the dedicated
Blender exporter before calibration; old rig archives do not replace newer skins.
Pass comma-separated names to select several families or individual variants.
The complete audit checks the installed human and Anansi libraries alongside
the mob candidates; those two use their dedicated Blender export workflows.
Installation preflights the whole batch and refuses a changed input model.
`node --import tsx tools/humanoid-hands/install.mts --dry-run` checks without writes.

The profile's `clip_grips` can override individual clips with a grip amount
between zero and one. Unarmed jabs/crosses/hooks use a closed fist by default;
other actions derive their grip from the source library. Anansi retains its
existing six-legged clips, with closed hands for its punches and slam.
Its hybrid rig uses the explicit `mixamorigSpine` upper-body mask validated
against walking, so casting preserves the creature's six-legged movement.

Project-owned clips are registered in
`projects/foundation/authoring/character-motion-manifest.json`. A library rebake
captures these from the installed actor and restores their exact tracks after
hand calibration. Ogre's Walk, GroundStomp, GroundPunch and ClubSlam, Frogkin's
Walk, Run, Sprint and Hop, and Anansi's Idle/Walk survive subsequent hand installs.
Missing registered clips or a changed
bind pose stop the bake instead of silently discarding motion. Edit those clips'
hand poses in their motion source files; the shared grip profile applies to the
remaining library clips.

For a new actor, inspect its actual hand geometry through Blender MCP first.
`blender_hands.py` supplies measured knuckle rows, normalized weights, thumb
isolation and controls for a Rigify **mitten** mesh. `repair_existing.py` handles
an existing finger skeleton on a mitten. Both preserve the supplied neutral
shape and UVs. Joint regions and curl direction need visual fitting: a five-digit
mesh must retain independent digit chains rather than share the block repair.

Use `export_existing.py` to preserve an existing GLB's skeleton, materials,
non-finger animation buffers and clip timing while replacing refined hand
geometry; `condition_fists.py` changes only selected finger tracks. The human
uber mesh has part-ID UVs and a null morph, so its topology repair/export remains
in `authoring/human-hand-repair-v1`; use its dedicated exporter for a geometry
change, then the shared fist conditioner. All Blender operations run through
Blender MCP. Never overwrite the source before checking a candidate.

Rig pairs remain data in `rig-map.mjs`. The normal retarget CLI now accepts FBX
and GLB characters/libraries. Node GLB re-export currently supports embedded PNG
textures; unsupported image formats fail explicitly. Rigify control rigs remain
editable; game exports use a conventional hierarchy with `CC_Base_Waist` above
the legs, plus character-specific tail/cloth joints.

These characters model fingers as a joined low-poly block and a thumb. The
repair supplies a clenched silhouette; it does not invent separated digits,
finger splay or cloth collision. Added edge rows interpolate the original UVs;
existing atlas pixels and the neutral character shape remain intact.
