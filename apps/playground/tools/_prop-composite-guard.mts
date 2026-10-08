/**
 * The composite guard (docs/world-standards props: "A missing object is a prop request, not a composite"):
 * `props compose` refuses a recipe whose prefab parts mix cultures or scale classes, that use a prop of another
 * culture or scale than the composite declares, or that resize a prop to stand in for a different-sized thing.
 * The way out is a PROP REQUEST (authoring/dressing/prop-requests.json, `props request add`), never a composite of
 * whatever is at hand. Pure apart from the request file: the caller supplies each part's dressing.
 */
import fs from "node:fs";
import path from "node:path";

export interface PartDressing { scale?: string; cultures?: string[] }
export interface Vocab { scales: { id: string; accepts?: string[] }[]; cultures: { id: string; accepts?: string[] }[] }
/** A prefab part scaled beyond this factor (either way) is a stand-in for a different-sized thing. */
export const STAND_IN_SCALE = 1.25;

const scaleOk = (v: Vocab, place: string, prop: string): boolean => prop === "any" || prop === place || !!v.scales.find((s) => s.id === place)?.accepts?.includes(prop);
const cultureOk = (v: Vocab, place: string[], prop: string[]): boolean => {
  if (!place.length || prop.includes("any") || place.includes("any")) return true;
  const ok = new Set(place.flatMap((c) => [c, ...(v.cultures.find((x) => x.id === c)?.accepts ?? [])]));
  return prop.some((c) => ok.has(c));
};

interface Part { prefab?: string; scale?: number | number[] }

/** Every reason a composite recipe must be a prop request instead. Empty = it may be composed. */
export function compositeFaults(recipe: { declare?: PartDressing; parts?: Part[] }, dressingOf: (prefab: string) => PartDressing | undefined, vocab: Vocab): string[] {
  const out: string[] = [];
  const declScale = recipe.declare?.scale;
  const declCultures = recipe.declare?.cultures ?? [];
  const known = (recipe.parts ?? []).filter((p) => p.prefab).map((p) => ({ p, d: dressingOf(p.prefab!) ?? {} }));
  for (const { p, d } of known) {
    const s = Array.isArray(p.scale) ? p.scale : [p.scale ?? 1, p.scale ?? 1, p.scale ?? 1];
    const worst = Math.max(...s.map((x) => Math.max(x, 1 / x)));
    if (worst > STAND_IN_SCALE) out.push(`${p.prefab} is resized x${+Math.max(...s).toFixed(2)}${Math.min(...s) < 1 ? `/x${+Math.min(...s).toFixed(2)}` : ""} to stand in for a different-sized thing`);
    if (declScale && d.scale && !scaleOk(vocab, declScale, d.scale)) out.push(`${p.prefab} is ${d.scale}-scale; the composite is ${declScale}-scale`);
    if (declCultures.length && d.cultures?.length && !cultureOk(vocab, declCultures, d.cultures)) out.push(`${p.prefab} is ${d.cultures.join("/")}; the composite is ${declCultures.join("/")}`);
  }
  // parts among themselves: one scale class, and no two parts from cultures that accept neither the other
  const scales = [...new Set(known.map((k) => k.d.scale).filter((s): s is string => !!s && s !== "any"))];
  if (scales.length > 1) out.push(`its parts mix scale classes (${scales.join(", ")})`);
  for (let i = 0; i < known.length; i++)
    for (let j = i + 1; j < known.length; j++) {
      const a = known[i]!, b = known[j]!;
      const ca = a.d.cultures ?? [], cb = b.d.cultures ?? [];
      if (ca.length && cb.length && !cultureOk(vocab, ca, cb) && !cultureOk(vocab, cb, ca))
        out.push(`${a.p.prefab} (${ca.join("/")}) and ${b.p.prefab} (${cb.join("/")}) belong to different cultures`);
    }
  return [...new Set(out)];
}

export interface PropRequest { id: string; name: string; culture: string; scale: string; for: string; why: string; at: string; status: "open" | "made" | "dropped" }
export const requestsFile = (project: string): string => path.join(project, "authoring/dressing/prop-requests.json");
export function readRequests(project: string): PropRequest[] {
  const f = requestsFile(project);
  return fs.existsSync(f) ? ((JSON.parse(fs.readFileSync(f, "utf8")) as { requests?: PropRequest[] }).requests ?? []) : [];
}
/** Log a request (merged into an open one for the same thing, culture and scale). */
export function addRequest(project: string, r: Omit<PropRequest, "id" | "at" | "status">): PropRequest {
  const list = readRequests(project);
  const slug = r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const dup = list.find((x) => x.status === "open" && x.name.toLowerCase() === r.name.toLowerCase() && x.culture === r.culture && x.scale === r.scale);
  if (dup && !dup.for.split(", ").includes(r.for)) dup.for = `${dup.for}, ${r.for}`;
  const row: PropRequest = dup ?? { id: `${r.culture}/${slug}`, ...r, at: new Date().toISOString(), status: "open" };
  if (!dup) list.push(row);
  const f = requestsFile(project);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ about: "Props places need that the catalogue lacks, by culture and scale (props request add). A place leaves the spot for it and names it in its handoff; nobody composes a stand-in.", requests: list }, null, 1) + "\n");
  return row;
}
