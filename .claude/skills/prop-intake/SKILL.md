---
name: prop-intake
description: Bring a prop into the catalogue or fix one — search first, wrap / variant / compose before making, declare its dressing (mount, scale class, cultures, setting, centrepiece), check real size and texel density, re-skin purchased-pack props (`props reskin-plan` / `reskin`, `supersededBy`), and log a prop request instead of building a composite or a mechanism. Use when a prop is imported, generated, re-skinned or missing, when `props status` / `props dupes` fail, or when a dresser cannot find the right object.
---

# prop-intake

Source (binding, tool-neutral): `docs/prop-cataloging.md` (required process, reuse first, duplicate guard, coverage
command). Tool manual: header of `apps/playground/tools/props.mts`. Vocabulary: `DRESSING_VOCABULARY` + a project's
`authoring/dressing/vocabulary.json`. Run from `apps/playground`.

## Order
1. **Search**: `props menu --search <word>`; it also lists "exists but not offered" (superseded, exempt, undeclared):
   never remake those, wrap or variant them.
2. **Reuse**: `props wrap <id> --id <coll/name> [--scale --yaw --pitch --roll --decl '<json>']` (sized/posed, or a
   `setting` change), `props variant <id> --id <coll/name> --material <id> | --art <png> [--triplanar <m>]` (new skin,
   same mesh: always allowed), `props compose <recipe.json>` (props + models + primitives + alpha cards that read as one
   real thing).
3. **Only then make**, and only what may be made: ruins (from the DC stamp kit pieces), docks, shacks, rocks, DC bones,
   flat decal art. Never animals, plants, or anything the catalogue has. Then `props dupes <new id>`.
4. **Declare**: `props suggest <id>`, look at `props proof <id>` (beside a 1.8 m figure), write the collection's
   `dressing` sidecar (one mount per prefab; `scale`, `cultures`, `setting` indoor|outdoor|both, `centrepiece` when
   it belongs mid-room), `props sync`, `props index`.
5. **Prove**: `props status [--next]` (ok/STALE/MISSING per prop, exit 1 on any), `props report`.

## Gates: failure -> fix
- `props status` HIGH / LOW texel density (target in `authoring/prop-catalogs.json` `texelDensity`) -> `props
  reskin-plan` names the route (a/b/c), `props reskin <id> --route ... [--role wood|stone]`. Large built surfaces use
  the town role tiles.
- `props dupes`: `DUPLICATE of <id>` -> use that one.
- Coverage/dependency check of `docs/prop-cataloging.md` fails -> finish source, UV, material and behaviour records.
- `scale-undeclared` / hidden from menus -> the prop has no `scale`/`cultures`: declare them.

## Re-skins
- A purchased pack's wrong look is usually palette: regrade by colour family onto ONE wood, ONE iron, ONE undyed cloth
  reference; re-pack under-dense props at the size their UVs need. Leave glass, food and loot out of a regrade.
- A reskin is a NEW id; mark the old catalogue row `supersededBy: <new id>`: the menu offers only the successor while
  installed scenes and old plans keep checking.
- Purchased-pack props flagged LOW or needs-art are not placed until re-skinned.

## When the catalogue lacks it
- Log a prop request with `npx tsx tools/props.mts request add` (writes authoring/dressing/prop-requests.json; the owner's readable wishlist is authoring/prop-lists-by-culture.md), leave the spot, and
  say so in the handoff ("story not yet visible" when the read depends on it). Never re-purpose another culture's or
  scale's prop, never glue unrelated parts and cards into a story object. Encoded: `props compose` refuses mixed
  cultures/scales and resized stand-ins; `props request add` logs to authoring/dressing/prop-requests.json.
- Complex mechanisms (cranes, hoists, treadwheels, lifts, sluices, capstans, grates) are owner-made: request them.

## Judgment
- No bare primitive stands in for an object; a catalogue entry built from raw primitives is a bad entry.
- Real size per kind and user (a chain waist-high, a door ~2 m for its user), size variety in a set; never scaled up to read from afar. Encoded: tools/prop-kind-sizes.json (+ registry `realSize`); `props status` flags, `dress check` `wrong-size`.
- Scaling a small prop up does not make a big one: a giant version needs its own silhouette, mapped at the texel standard.
- Every scale and culture that holds rooms needs small lights and wall-free furniture of its own.
- Pieces that work are exported and catalogued for reuse; pieces the owner rejected are not.
