import { describe, expect, it } from "vitest";
import { checkQuestItems, dressingPlanSchema, questEntity, questPlacements, type QuestEntityDecl } from "../src/index.js";

const declared: QuestEntityDecl[] = [
  { id: "parish-strongbox", kind: "object", location: "hagsend", what: "the reeve's strongbox", zone: "hagsheer" },
  { id: "parish-register", kind: "readable", location: "hagsend", what: "the parish register", zone: "hagsheer" },
  { id: "watch-house-log", kind: "readable", location: "kirk-knowe", what: "the grave-watch log", zone: "hagsheer" },
  { id: "hesketh", kind: "presence", location: "hagsend", what: "a ghost", zone: "hagsheer" },
];
const plan = (items: unknown[]) => dressingPlanSchema.parse({ id: "hagsend--reeve-house", map: "m", items });
const box = (entity: string, extra: Record<string, unknown> = {}) => ({ id: "strongbox", prop: "house-interior/box-long-a", place: { kind: "auto", room: "G-1" }, quest: { entity, ...extra } });

describe("dressing plan quest field", () => {
  it("parses, and refuses a quest entity placed twice or on a set member", () => {
    expect(plan([box("parish-strongbox", { radius: 3 })]).items[0]!.quest).toEqual({ entity: "parish-strongbox", radius: 3 });
    const twice = dressingPlanSchema.safeParse({ id: "p", map: "m", items: [box("a"), { ...box("a"), id: "b" }] });
    expect(twice.success).toBe(false);
    expect(dressingPlanSchema.safeParse({ id: "p", map: "m", items: [{ ...box("a"), prop: "" }] }).success).toBe(false); // a stand-in with no prop
  });

  it("check: declared at this location passes; undeclared, other location, presence and duplicates are violations", () => {
    expect(checkQuestItems(plan([box("parish-strongbox")]), declared, ["hagsend"]).violations).toEqual([]);
    expect(checkQuestItems(plan([box("nope")]), declared, ["hagsend"]).violations.map((v) => v.code)).toEqual(["quest-undeclared"]);
    const wrong = checkQuestItems(plan([box("watch-house-log")]), declared, ["hagsend"]).violations;
    expect(wrong.map((v) => v.code)).toEqual(["quest-wrong-location"]);
    expect(wrong[0]!.message).toContain("kirk-knowe");
    expect(checkQuestItems(plan([box("hesketh")]), declared, ["hagsend"]).violations.map((v) => v.code)).toEqual(["quest-not-object"]);
    expect(checkQuestItems(plan([box("parish-strongbox")]), declared, ["hagsend"], new Set(["parish-strongbox"])).violations.map((v) => v.code)).toEqual(["quest-duplicate"]);
  });

  it("check warns for a declared object of the location in no plan (not presences, not other locations)", () => {
    const w = checkQuestItems(plan([box("parish-strongbox")]), declared, ["hagsend"]).warnings;
    expect(w.map((x) => x.code)).toEqual(["quest-object-unplanned"]);
    expect(w[0]!.message).toContain("parish-register");
    expect(checkQuestItems(plan([box("parish-strongbox")]), declared, ["hagsend"], new Set(["parish-register"])).warnings).toEqual([]);
  });

  it("the placement carrying the entity: the item itself, or a set item's anchor piece", () => {
    const p = dressingPlanSchema.parse({ id: "p", map: "m", items: [box("parish-strongbox"), { id: "desk", set: "desk-set", place: { kind: "auto", room: "G-1" }, quest: { entity: "parish-register" } }] });
    const m = questPlacements(p, [{ id: "strongbox" }, { id: "desk/desk" }, { id: "desk/chair" }]);
    expect(m.get("strongbox")?.entity).toBe("parish-strongbox");
    expect(m.get("desk/desk")?.entity).toBe("parish-register");
    expect(m.has("desk/chair")).toBe(false);
  });

  it("entity: exact id, tags, npc params with defaults", () => {
    const e = questEntity({ entity: "parish-register" }, { zone: "hagsheer", name: "Parish register", kind: "readable", placeTags: ["town:hagsend"], places: "zones/w/hagsheer/hagsend" });
    expect(e.id).toBe("parish-register");
    expect(e.tags).toEqual(["interactable", "zone:hagsheer", "town:hagsend"]);
    expect(e.script).toEqual({ name: "npc", params: { name: "Parish register", readable: true, face: false, radius: 2.5, dialogue: "zones/hagsheer/parish-register", places: "zones/w/hagsheer/hagsend" } });
    const o = questEntity({ entity: "parish-strongbox", radius: 4, dialogue: "x/y", readable: false }, { zone: "hagsheer", name: "S", kind: "readable" });
    expect(o.script.params).toEqual({ name: "S", face: false, radius: 4, dialogue: "x/y" });
  });
});
