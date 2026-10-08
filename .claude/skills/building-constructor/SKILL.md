---
name: building-constructor
description: Build a medieval town building from Derek's modular kit with the WFC house rules. Takes a building request (type, system common/stone, footprint, storeys, roof, street side, features such as grand_door, vault, vault_tall, nave, basilica, dome, gallery, fireplace, portico, tower, jetty, dormers, articulation), solves it with the rule set, reviews it strictly and delivers the .blend. Use when a building is requested, when the town planner hands over lots, or when a kit piece or a rule changes and the test buildings must be rebuilt.
---

# Building constructor

Reference: **MMO/WFC/wfc/README.md** (read it), the rules in `MMO/WFC/wfc/rules.py` (`RULE_TEXT`) and
**MMO/WFC/KIT-RULES.md** §22–23.
For engine export, also read [the shared town-baking policy](../../../docs/town-baking.md).

## The one principle
The rules ARE the generator. Never place, move or delete a piece by hand to make a building pass. A review failure means
a rule or a kit piece is missing. Add the rule (in `rules.py` / `rails.py`, with a `RULE_TEXT` line) or have the kit's
generator (`MMO/WFC/Generated/make_*.py`) add the piece, then rebuild every test building.

## Order
1. **Write the request(s)** into a JSON file (see README): name, system, size, storeys, roof, front, features. Pick the
   system by the type: banks, guild vaults, chapels (`nave`), churches (`basilica`), towers → `stone`; houses, taverns, workshops, markets → `common`.
2. **Build**: `"P:\Program Files\Blender Foundation\Blender 5.2\blender.exe" -b --factory-startup --python
   MMO/WFC/wfc/build.py -- <requests.json>` (headless only; never the live Blender MCP for building).
3. **Read every `RESULT` line.** `ok:false` means one of three things:
   - A RequestError: the feature combination is impossible. Change the request.
   - A contradiction naming a rule: the massing can't satisfy it (e.g. a 3×3 strongroom can't hold a stair with landings).
     Change the size or features.
   - A review failure: a missing rule or piece. Fix the rule or kit, never the building.
4. **Look** at `out/<name>/<name>_sheet.png` (Read the image) for every building against the review checklist.
5. **Deliver**: load the collections from `out/requests.blend` (or the town .blend) into Derek's Blender under a clear
   collection name (`bpy.data.libraries.load`, link the collection, offset clear of existing work), and summarise what was
   chosen (door, fireplace, vaults, dome, atrium) per building.
6. **Bake only as derived output, when installing in engine**: retain the editable
   collections and building/room ownership. Compile compatible atlas materials per
   shell and separate room/floor units; keep doors and effects independent. Follow
   the shared policy's UV, culling and capsule review gates. The legacy district
   exporter does not yet implement this partitioned output; do not claim it does.

## Never
- Hand-fix a building, or hide a piece to pass the review.
- Edit Derek's source kits (`MMO/WFC/*.obj`). The corrected copies are in `UVFixed/`; re-exported pieces go through
  `MMO/WFC/tools/uvfix/fix_uv.py -- <file>` then `weld.py`.
- Treat a warning as acceptable: geometry problems are failures (KIT-RULES §22.10).
