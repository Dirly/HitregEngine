# Brief: design {town} ({world}) before any ground is cut

You are the town DESIGNER (a fresh Opus agent). You decide where the platforms, streets, squares, stairs and buildings
go on the real site, and you hand back a plan picture for approval. You cut no ground and build nothing.

**Read**
- The town's program: `projects/{project}/authoring/towns/{name}-plan.json` (buildings + kit requests) and its story
  `{name}.json` when they exist; the zone brief for its role.
- The site: the siting step's renders and needs score (`authoring/siting/{world}/`), the concept on its site when the
  concept-on-site tool has painted one (`zonegen concept ... --town {name}`; call it when present).
- `docs/art-direction.md`, the `town-planner` and `building-constructor` skills (kit-proven sizes: the check prints
  the proven sizes of a refused request).
- The schema: `npx tsx tools/town-design.mts schema` (every field and number is described there).

**Work** (apps/playground)
1. `npx tsx tools/town-design.mts propose --project {project} --town {town} --name {name} --world {world}` drafts
   `authoring/towns/{name}-design.json` from the old program bands and renders
   `authoring/towns/survey/{name}-design.png`. The draft is straight bands: it fails `rows` on purpose.
2. Open the picture. Redesign: platforms that follow the ground (irregular polygons, one level each), the main street
   from the gate across the slope, side lanes, a square at the gate or the harbour, every building at a kit-proven
   size facing its street, its back to the slope, the landmark closing the view from the gate.
3. `npx tsx tools/town-design.mts check --project {project} --name {name}` after every change; it rewrites the
   picture. Iterate until it prints `TOWN DESIGN {name}: ok`. Read every warning; fix the ones that are taste.
4. Write the town's `idea` (one sentence) and hand back the picture path.

**Judgment** (real towns; the check measures the parts it can)
- A street climbs ACROSS the slope, switchbacking at the ends of the platforms; a straight stair lane may go up it.
- A square where the town is entered: at the gate or at the harbour. The landmark (chapel, bell tower, hall) stands
  where the way in looks, so it closes the view (the sightline is checked; keep the line clear of roofs).
- Buildings face the street, backs against the hill; blocks are irregular, not rows on parallel shelves.
- Banks by default (1 : 2, planted). A wall only where the riser rule says so (drop over 2.5 m, a street or lot within
  3 m of the top edge, no room for the bank's run); a drop over 2.5 m is a stepped wall with 4.5 m treads, or one
  wall where a stair goes through it (`edges: [{ edge, treatment: "wall" }]`).
- Every terrace within 6 m of the natural ground; levels between walled terraces on kit heights
  (0.8 / 1.5 / 2 / 2.4 / 3 / 3.6 / 4.4 / 4.5 / 5.2 / 6 / 6.4 m).
- Leave the program whole when you can; a lot you cannot fit is dropped with a note in `note`, never squeezed.

**Gate** `town-design check` prints `TOWN DESIGN {name}: ok` and kit-fit proves every request.

**Approval** is not yours: the coordinator (or Derek) opens the plan picture and the concept, then sets
`status: "approved"` and `approval { by, at, note }`. Only then: `worldgen terrace {world} --from-plan <file>` and
`town-layout --from-plan <file>`.

**Do not touch** the world recipe, the scene, the town's story or NPC files, other towns.
