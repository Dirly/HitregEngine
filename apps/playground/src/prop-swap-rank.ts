/**
 * The prop editor's Swap list order (owner walkthrough 2026-10-13: a barrel was offered bonfires and lean-tos).
 * A swap should be the same SORT of thing: first its size (footprint and height each within +-50% of the selected
 * prop's), then the same dressing category and mount, then the place's culture and scale class. Inside a tier the
 * closest size comes first. Pure: the editor panel calls it, the tests pin it.
 */
export interface SwapProp {
  id: string;
  mount?: string;
  size?: [number, number, number];
  category?: string;
  scale?: string;
  cultures?: string[];
}
export interface SwapRow {
  id: string;
  /** Fits this place's scale class and culture (the old ✓). */
  fits: boolean;
  /** Footprint and height within +-50% of the selected prop. */
  sizeOk: boolean;
  why: string;
  rank: number;
  dist: number;
}

/** Footprint long side, footprint short side, height. */
function dims(s: [number, number, number]): [number, number, number] {
  return [Math.max(s[0], s[2]), Math.min(s[0], s[2]), s[1]];
}
/** Size closeness: summed |log ratio| over footprint long, short and height (0 = the same size); Infinity when unknown. */
export function sizeDistance(a?: [number, number, number], b?: [number, number, number]): number {
  if (!a || !b) return Infinity;
  const da = dims(a), db = dims(b);
  let d = 0;
  for (let i = 0; i < 3; i++) d += Math.abs(Math.log(Math.max(1e-3, db[i]!) / Math.max(1e-3, da[i]!)));
  return d;
}
/** Every dimension within +-50% of the selected prop's. */
export function sizeWithin(a?: [number, number, number], b?: [number, number, number], tol = 0.5): boolean {
  if (!a || !b) return false;
  const da = dims(a), db = dims(b);
  return da.every((v, i) => db[i]! >= v * (1 - tol) && db[i]! <= v * (1 + tol));
}

export function rankSwaps(
  catalog: Iterable<SwapProp>,
  current: string,
  place: { scale?: string; cultures?: string[] } = {},
  filter = "",
  limit = 60,
): SwapRow[] {
  const all = [...catalog];
  const cur = all.find((p) => p.id === current);
  const scale = place.scale ?? cur?.scale;
  const cultures = place.cultures?.length ? place.cultures : (cur?.cultures ?? []);
  const f = filter.trim().toLowerCase();
  const rows = all
    .filter((p) => p.id !== current && (!f || p.id.toLowerCase().includes(f)))
    .map((p): SwapRow => {
      const sizeOk = sizeWithin(cur?.size, p.size);
      const sameCat = !!cur?.category && p.category === cur.category;
      const sameMount = !cur?.mount || p.mount === cur.mount;
      const scaleOk = !scale || !p.scale || p.scale === "any" || p.scale === scale;
      const cultOk = !cultures.length || !p.cultures?.length || p.cultures.includes("any") || p.cultures.some((c) => cultures.includes(c));
      // size first, then category + mount, then culture, then the place's scale class
      const rank = (sizeOk ? 0 : 16) + (sameCat ? 0 : 4) + (sameMount ? 0 : 4) + (cultOk ? 0 : 2) + (scaleOk ? 0 : 1);
      const why = [sizeOk ? "" : "other size", sameCat ? "" : p.category ? `a ${p.category}` : "", sameMount ? "" : `${p.mount ?? "?"} mount`, cultOk ? "" : "other culture", scaleOk ? "" : `scale ${p.scale}`]
        .filter(Boolean).join(", ");
      return { id: p.id, fits: scaleOk && cultOk, sizeOk, why, rank, dist: sizeDistance(cur?.size, p.size) };
    });
  rows.sort((a, b) => a.rank - b.rank || a.dist - b.dist || a.id.localeCompare(b.id));
  return rows.slice(0, limit);
}
