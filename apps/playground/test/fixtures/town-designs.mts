/**
 * Town design fixtures on one planar hillside (20 m at z = 0, rising 0.15 m per metre toward -Z; contours run along X).
 * - `rowTown`: the 2026-10-29 design round's own fixture — two shelves along the contour, ONE street each, houses
 *   strung on it, a ramp round the end. It passed `rows` (four buildings, two bearings) and must fail `bands`.
 * - `draftBands`: what `town-design propose` drafts from the program bands — three stacked shelves, one street each,
 *   switchback stairs at alternate ends. Must fail `bands`.
 * - `climbingTown`: the same hill designed as a town: a gate square, a main street that climbs ACROSS the slope from
 *   the square through a ramp to the upper level, a lane that links the levels by a stair, blocks turned onto the
 *   cross streets, the chapel closing the view from the gate. Must pass every rule.
 */
import { DESIGN_RULE, townDesignSchema, type TownDesign } from "../../tools/town-design-schema.mts";
import { siteFall } from "../../tools/town-design-check.mts";

type V2 = [number, number];
export const RISE = 0.15;
export const hill = (_x: number, z: number): number => 20 - z * RISE;
export const hillSite = { height: hill, sea: 0, ...siteFall(hill, [0, 10], 40) };
export const house = { system: "common", size: [5, 3], storeys: 2, roof: "gable", features: ["fireplace"] };
const cottage = { system: "common", size: [3, 3], storeys: 2, roof: "gable", features: [] as string[] };
const chapel = { system: "stone", size: [3, 6], storeys: 2, roof: "steep", features: ["nave", "tower"] };

/** The design round's fixture (test/town-design.test.ts before 2026-10-29 w0-tools), as it was. */
export function rowTownDoc(): Record<string, any> {
  return {
    town: "t", world: "w", name: "fixture", status: "approved",
    gate: { at: [0, 38], facing: [0, 1] },
    terraces: [
      { id: "low", level: 16.2, polygon: [[-30, 14], [30, 14], [30, 38], [-30, 38]], buildings: ["h1", "h2"] },
      { id: "high", level: 18.6, polygon: [[-30, -18], [30, -18], [30, 8], [-30, 8]], buildings: ["h3", "h4"] },
    ],
    streets: [
      { id: "low-street", name: "Low Street", kind: "main", points: [[-28, 32], [28, 32]], width: 5 },
      { id: "high-street", name: "High Street", kind: "lane", points: [[-28, -14], [28, -14]], width: 5 },
    ],
    squares: [{ id: "gate-square", name: "Gate Square", terrace: "low", polygon: [[-8, 28], [8, 28], [8, 35], [-8, 35]] }],
    connections: [{ id: "ramp", kind: "ramp", from: "low", to: "high", points: [[28, 20], [36, 14], [36, 4], [28, 2]], width: 4 }],
    landmark: { building: "h3", height: 12 },
    buildings: [
      { id: "h1", name: "H1", at: [-18, 21.94], facing: [0, 1], street: "low-street", request: house },
      { id: "h2", name: "H2", at: [18, 21.94], facing: [0, 1], street: "low-street", request: house },
      { id: "h3", name: "H3", at: [-16, -3.94], facing: [0, -1], street: "high-street", request: house },
      { id: "h4", name: "H4", at: [16, -3.94], facing: [0, -1], street: "high-street", model: "h3" },
    ],
  };
}
export const rowTown = (): TownDesign => townDesignSchema.parse(rowTownDoc());

/** A building opening on a street: `s` metres along the segment a -> b, on its left (+1) or right (-1) side. */
function lot(id: string, name: string, street: string, a: V2, b: V2, s: number, side: 1 | -1, request: Record<string, unknown> | undefined, model?: string, width = 5): Record<string, any> {
  const req = (request ?? house) as { size: [number, number] };
  const l = Math.hypot(b[0] - a[0], b[1] - a[1]), ax: V2 = [(b[0] - a[0]) / l, (b[1] - a[1]) / l], left: V2 = [-ax[1], ax[0]];
  const D = req.size[1] * DESIGN_RULE.cell;
  const back = width / 2 + 1 + 0.55 * DESIGN_RULE.cell + D / 2;
  const at: V2 = [a[0] + ax[0] * s + left[0] * side * back, a[1] + ax[1] * s + left[1] * side * back];
  const r = (v: number) => Math.round(v * 100) / 100;
  return { id, name, at: [r(at[0]), r(at[1])], facing: [r(-left[0] * side), r(-left[1] * side)], street, ...(model ? { model } : { request }) };
}

/** Three stacked program bands, one street each, houses both sides, switchback stairs (the `propose` draft). */
export function draftBands(): TownDesign {
  const levels = [13.1, 18.2, 23.3];
  const zc = [46, 12, -22];
  const terraces = levels.map((level, i) => ({ id: `t${i + 1}`, level, polygon: [[-50, zc[i]! - 16], [50, zc[i]! - 16], [50, zc[i]! + 16], [-50, zc[i]! + 16]], buildings: [] as string[] }));
  const streets = zc.map((z, i) => ({ id: `street-${i + 1}`, name: `Street ${i + 1}`, kind: i ? "lane" : "main", points: [[-48, z], [48, z]], width: 5 }));
  const buildings: Record<string, any>[] = [];
  zc.forEach((z, i) => {
    for (const [k, x] of [-36, -12, 12, 36].entries()) {
      const b = lot(`b${i}-${k}`, `B${i}${k}`, `street-${i + 1}`, [-48, z], [48, z], x + 48, k % 2 ? 1 : -1, cottage);
      buildings.push(b);
      terraces[i]!.buildings.push(b.id);
    }
  });
  return townDesignSchema.parse({
    town: "t", world: "w", name: "draft", status: "draft",
    gate: { at: [0, 62], facing: [0, 1] },
    terraces, streets,
    squares: [{ id: "gate-square", name: "Gate Square", terrace: "t1", polygon: [[-4, 52], [4, 52], [4, 60], [-4, 60]] }],
    connections: [
      { id: "up-1", kind: "stair", from: "t1", to: "t2", points: [[48, 46], [48, 12]], width: 4, street: "street-2" },
      { id: "up-2", kind: "stair", from: "t2", to: "t3", points: [[-48, 12], [-48, -22]], width: 4, street: "street-3" },
    ],
    landmark: { building: buildings[buildings.length - 1]!.id },
    buildings,
  });
}

/** The hill designed as a town (see the header): passes every rule, `bands` included, and does not read as rows. */
export function climbingTown(): TownDesign {
  const climb: V2[] = [[0, 58], [0, 48], [24, 30]];
  const climbHigh: V2[] = [[52, 12], [40, 2], [12, -4], [-8, -4]];
  const lane: V2[] = [[-10, 56], [-30, 44], [-36, 30]];
  const laneHigh: V2[] = [[-40, 4], [-36, -14]];
  const market: V2[] = [[10, 54], [50, 54]];
  const b: Record<string, any>[] = [
    // the climb leaves the gate square across the slope; a house on its uphill side faces it, back to the hill
    lot("climb-1", "Cooper", "climb", climb[1]!, climb[2]!, 12, -1, house),
    // Market Lane runs east off the square along the contour: one short block, its backs to the climb
    lot("market-1", "Chandler", "market-lane", market[0]!, market[1]!, 17, -1, cottage),
    lot("market-2", "Market Hall", "market-lane", market[0]!, market[1]!, 30.5, -1, cottage),
    // Stair Lane climbs west off the square to the stair; its houses step up with it
    lot("lane-2", "Lane House", "stair-lane", lane[1]!, lane[2]!, 8, 1, cottage),
    // the upper level: the climb turns along the hill to the chapel; houses on its uphill side
    lot("high-1", "Weaver", "climb", climbHigh[1]!, climbHigh[2]!, 7, 1, cottage),
    lot("high-2", "Smith", "climb", climbHigh[1]!, climbHigh[2]!, 24, 1, house),
    lot("high-3", "Tanner", "climb", climbHigh[0]!, climbHigh[1]!, 7, 1, cottage),
    // the chapel closes the climb, and the view in from the gate
    { id: "chapel", name: "Chapel", at: [-22.86, -4], facing: [1, 0], street: "climb", request: chapel },
  ];
  const onLow = ["climb-1", "market-1", "market-2", "lane-2"];
  return townDesignSchema.parse({
    town: "t", world: "w", name: "climbing", status: "approved",
    idea: "A hill town that climbs: the gate opens on a square, the street rises across the slope to the upper level and ends at the chapel.",
    gate: { at: [0, 63], facing: [0, 1] },
    terraces: [
      { id: "low", name: "Gate level", level: 15.5, polygon: [[-52, 24], [0, 16], [42, 26], [56, 44], [54, 64], [-50, 64]], buildings: onLow },
      { id: "high", name: "Chapel level", level: 17.9, polygon: [[-54, -22], [28, -25], [63, -7], [63, 14], [40, 14], [0, 8], [-54, 6]], buildings: b.map((x) => x.id).filter((x) => !onLow.includes(x)) },
    ],
    streets: [
      { id: "climb", name: "The Climb", kind: "main", points: [...climb, ...climbHigh], width: 5 },
      { id: "stair-lane", name: "Stair Lane", kind: "lane", points: [...lane, ...laneHigh], width: 4 },
      { id: "market-lane", name: "Market Lane", kind: "lane", points: market, width: 4 },
    ],
    squares: [{ id: "gate-square", name: "Gate Square", kind: "gate", terrace: "low", polygon: [[-10, 48], [10, 48], [10, 60], [-10, 60]] }],
    connections: [
      { id: "climb-ramp", kind: "ramp", from: "low", to: "high", points: [[24, 30], [52, 12]], width: 5, street: "climb" },
      { id: "lane-stair", kind: "stair", from: "low", to: "high", points: [[-36, 30], [-40, 4]], width: 4, street: "stair-lane" },
    ],
    landmark: { building: "chapel" },
    buildings: b,
  });
}
