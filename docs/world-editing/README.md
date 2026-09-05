# World editing playbooks

How an agent (or a person) changes a LIVE voxel world by editing its recipe,
one feature kind per file. These are procedures, not reference: the exact
fields live in the schemas (`curl -s http://localhost:5173/__hitreg/spec` or
`spec.json`), the reasoning behind the invariants lives in
`docs/voxel-worlds.md`. A playbook tells you what to read, what to write,
in what order, and how to check it without asking a human to look.

The contract every playbook relies on:

- **The recipe is the world.** `apps/playground/projects/<project>/assets/worlds/<world>.json`
  is authoring truth; terrain, colliders, water and scatter are derived from
  it. Edit the JSON, and if the dev server is running the browser rebuilds
  the affected chunks in place. No generator run is needed for a feature the
  field can solve itself (rivers are the first; see the file).
- **Stages that come after your feature must be re-run** when it moves them:
  towns → paths → pois → trails, in that order, because paths are routed on
  the current ground and split at rivers.
- **Verify with data before an image, and with an image before believing
  it**: `worldgen audit` (exit 1 on findings), `worldgen map --plain`, then a
  headless screenshot if it matters.

Playbooks:

- [rivers.md](rivers.md) — carve a river from a lake to the sea or into
  another river, by hand, and check it.

Planned: lakes, paths and bridges, towns, points of interest, scatter and
props, canyons. Add a file when a second world needs the procedure.
