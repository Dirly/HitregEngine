/**
 * Which recipe roads are a town's own streets. Two writers name them: `town-ground build` writes `<town>-street-*`
 * (lanes `-street-lane-*`, the square `-street-square-*`), `town-layout` writes its plan lanes as `<town>-lane-*`.
 * Every consumer (paving, lights, exterior sockets) takes both; a road id with `-lane-` is a lane either way.
 * Door paths (`<town>-door-*`), stairs and world roads are not streets.
 */
export function isTownStreet(id: string, townId: string): boolean {
  return id.startsWith(`${townId}-street-`) || id.startsWith(`${townId}-lane-`);
}
