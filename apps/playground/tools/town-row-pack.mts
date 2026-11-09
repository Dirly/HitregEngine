/**
 * Row packing by plan type (k-town9, Bell Strand to the bird's-eye painting: ~30-35 houses inside the ring, roofs
 * touching). A party-wall row is a sequence of kit house types read from the kit catalogue's `plan` rows
 * (`plan.rowPitchMetres` = the lot each type takes, `plan.party` = its party sides), laid left (-x of the houses) to
 * right (+x), each neighbour pair one the kit's row-fit proof measured clean. The packer picks the sequence that:
 *   1. covers the most of the row's length (no house past its end);
 *   2. ends on a CORNER type (one party side, -x) at the row's +x end when one fits: its open +x gable faces the cross
 *      street / lane end (k-kit: "corner types at row ends");
 *   3. never repeats one type side by side when another fits, and spreads the types (variety reads as separate houses).
 * Pure; `rowPackTypes` reads a kit's catalogue + row-fit proof.
 */
import fs from "node:fs";
import path from "node:path";

export type RowType = { id: string; lot: number; party: string[]; depth: number; storeys: number };
export type RowPackOpts = {
  /** the ids allowed in this row, in order of preference (earlier = favoured when the cover ties) */
  pool: string[];
  /** proven neighbour pairs "<left id> | <right id>" (model basenames) */
  pairs: Set<string>;
  /** the house standing just left of the row's first lot (a row continued after a failed lot), or null */
  leftOf?: string | null;
  /** require a corner at the +x end only if it fits (default true: prefer); false = never a corner */
  corner?: boolean;
  /** the deepest lot this row can take (metres of wall depth), e.g. a row backed on the curtain */
  maxDepth?: number;
};

const key = (a: string, b: string) => `${a} | ${b}`;
export const isCorner = (t: RowType) => t.party.includes("-x") && !t.party.includes("+x");
const isMiddle = (t: RowType) => t.party.includes("-x") && t.party.includes("+x");

/** The best sequence of type ids for a row `length` m long (see the file header for the order of the criteria). */
export function packRow(length: number, types: Record<string, RowType>, o: RowPackOpts): string[] {
  const pool = o.pool.map((id) => types[id]).filter((t): t is RowType => !!t && (o.maxDepth === undefined || t.depth <= o.maxDepth + 1e-6));
  const prefRank = new Map(pool.map((t, i) => [t.id, i]));
  let best: { seq: string[]; score: number[] } | null = null;
  const better = (a: number[], b: number[]) => { for (let i = 0; i < a.length; i++) { if (Math.abs(a[i]! - b[i]!) > 1e-6) return a[i]! > b[i]!; } return false; };
  const scoreOf = (seq: string[], used: number) => {
    const last = seq.length ? types[seq[seq.length - 1]!]! : null;
    let repeats = 0; for (let i = 1; i < seq.length; i++) if (seq[i] === seq[i - 1]) repeats++;
    const distinct = new Set(seq).size;
    const pref = seq.reduce((s, id) => s + (prefRank.get(id) ?? 0), 0);
    // cover (cm), corner at the end, fewest side-by-side repeats, most distinct types, favoured types
    return [Math.round(used * 100), o.corner !== false && last && isCorner(last) ? 1 : 0, -repeats, distinct, -pref];
  };
  let nodes = 0;
  const dfs = (seq: string[], used: number) => {
    if (++nodes > 200000) return;
    const sc = scoreOf(seq, used);
    if (!best || better(sc, best.score)) best = { seq: seq.slice(), score: sc };
    const prev = seq.length ? seq[seq.length - 1]! : o.leftOf ?? null;
    if (seq.length && isCorner(types[prev!]!)) return; // a corner ends the row
    for (const t of pool) {
      if (used + t.lot > length + 1e-6) continue;
      if (isCorner(t) ? o.corner === false : !isMiddle(t)) continue;
      if (prev && !o.pairs.has(key(prev, t.id))) continue;
      seq.push(t.id); dfs(seq, used + t.lot); seq.pop();
    }
  };
  dfs([], 0);
  return best ? (best as { seq: string[] }).seq : [];
}

/** The row types of a kit: every catalogue row with a `plan.rowPitchMetres` and a party side, plus its row-fit proof. */
export function rowPackTypes(project: string, kit: string): { types: Record<string, RowType>; pairs: Set<string>; lots: Record<string, number> } {
  const dir = path.resolve("projects", project, "authoring", kit);
  const cat = JSON.parse(fs.readFileSync(path.join(dir, "catalog.json"), "utf8")) as unknown;
  const rows = (Array.isArray(cat) ? cat : ((cat as { props?: unknown[]; entries?: unknown[] }).props ?? (cat as { entries?: unknown[] }).entries ?? Object.values(cat as object))) as { id: string; plan?: { rowPitchMetres?: number; party?: string[]; wallsMetres?: number[]; storeys?: number } }[];
  const proof = JSON.parse(fs.readFileSync(path.join(dir, "row-fit.json"), "utf8")) as { lots?: Record<string, number>; pairs: { pair: string; findings: string[] }[] };
  const pairs = new Set(proof.pairs.filter((p) => !p.findings.length).map((p) => p.pair.replace(/'$/, "")));
  const lots = proof.lots ?? {};
  const types: Record<string, RowType> = {};
  for (const r of rows) {
    const id = r.id.split("/").pop()!;
    const lot = lots[id] ?? r.plan?.rowPitchMetres;
    if (!lot || !r.plan?.party?.length) continue;
    types[id] = { id, lot, party: r.plan.party, depth: r.plan.wallsMetres?.[1] ?? 0, storeys: r.plan.storeys ?? 1 };
  }
  return { types, pairs, lots };
}
