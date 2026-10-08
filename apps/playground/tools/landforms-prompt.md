You are painting a LANDFORM KEY MAP. It is a data image read by a program, not artwork.

The attached image is a top-down relief map of a game world: grey shaded ground is LAND, dark blue-grey is SEA. North is up. It is {{SIZE}} x {{SIZE}} pixels and covers {{METRES}} metres across ({{MPP}} metres per pixel).

Produce ONE new PNG of exactly {{SIZE}} x {{SIZE}} pixels with exactly the same framing as the attached map, where every pixel is EITHER:
- one legend colour below, painted as a solid, flat, filled blob where that landform should go, OR
- fully transparent where nothing is added (if you cannot write transparency, use pure black #000000 there).

Hard rules:
- Do NOT copy the map into the output. No grey land, no sea, no coastline, no relief.
- Flat colours only, at EXACTLY the hex values given. No shading, no gradients, no texture, no noise, no glow, no drop shadow.
- No outlines, no borders, no strokes around shapes, no text, no labels, no numbers, no symbols, no legend box, no compass.
- Hard pixel edges (nearest-neighbour). Every shape at least {{STROKE}} pixels across at its narrowest. Shapes must not touch each other or the image edge.
- Each blob is one landform. Keep different landforms clearly apart (a gap of at least 10 pixels).

Legend (exact colours):
{{LEGEND}}

Placement rules:
- Land classes go fully inside grey LAND, away from the coastline. Sea stacks go in the dark SEA just off a coast.
- Long thin strokes (ridge spur, gorge) are drawn as a single solid line about {{STROKE}} pixels thick (never thinner: thin lines are discarded as noise), following the lie of the land: a gorge runs downhill toward the coast, a ridge spur runs out from high ground.
- All landforms together cover at most {{COVERAGE}}% of the land. Leave most of the land untouched (transparent).
- Usually 6 to 14 landforms in total, spread over the whole map, not clustered in one place.

Design brief: {{BRIEF}}
