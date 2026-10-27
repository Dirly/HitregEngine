import { test } from "node:test";
import assert from "node:assert/strict";
import { displayName, humanDress, namedTitle, resolveBody, titleCase } from "../tools/zonegen/commands/populate.mts";

test("a creature whose body exists is never a capsule: own prefab, else the base body + an art row", () => {
  assert.deepEqual(resolveBody({ own: "mobs/wolf-brinecoat", template: "mobs/wolf-timber", anyTheme: null, artWhy: "x" }), { body: "mobs/wolf-brinecoat", placeholder: false, why: "ready body + theme" });
  const base = resolveBody({ own: null, template: "mobs/raven", anyTheme: null, artWhy: "rare theme 'blackbill' has no painted atlas" });
  assert.equal(base.body, "mobs/raven");
  assert.equal(base.placeholder, false);
  assert.match(base.art!, /blackbill/);
  assert.equal(resolveBody({ own: null, template: null, anyTheme: "mobs/rat", artWhy: "x" }).body, "mobs/rat");
});

test("only a creature with no body prefab at all is a capsule placeholder", () => {
  const r = resolveBody({ own: null, template: null, anyTheme: null, artWhy: "body needs-body" });
  assert.equal(r.body, "capsule");
  assert.equal(r.placeholder, true);
});

test("display names are '<Kin> <Role>' in Title Case, no levels", () => {
  const rat = { name: "Giant rat", themes: [{ id: "sewer" }] };
  assert.equal(displayName(rat, "sewer", false), "Giant Sewer Rat");
  assert.equal(displayName({ name: "Wolf", themes: [{ id: "brinecoat" }] }, "brinecoat", false), "Brinecoat Wolf");
  assert.equal(displayName({ name: "Giant raven", themes: [{ id: "base" }] }, "base", false), "Giant Raven");
  assert.equal(displayName({ name: "Wrecker", themes: [{ id: "oilskin-bearded-axe" }] }, "oilskin-bearded-axe", true), "Wrecker Axeman");
  assert.equal(displayName({ name: "Smuggler", themes: [] }, "oilskin-crossbow", true), "Smuggler Crossbowman");
  assert.equal(displayName({ name: "Cult Hierophant", themes: [] }, "cleric-staff", true), "Cult Hierophant");
  // the catalogue's own name for the theme wins
  assert.equal(displayName({ name: "Risen dead", themes: [{ id: "soldier", name: "Risen Soldier" }] }, "soldier", false), "Risen Soldier");
  // a one-word faction kin takes its role's noun; a two-word faction name already is kin + role
  assert.equal(displayName({ name: "FrogKin", kind: "faction", themes: [{ id: "bog" }] }, "bog", false, "melee"), "Frogkin Warrior");
  assert.equal(displayName({ name: "Ratkin Warrior", kind: "faction", themes: [{ id: "plague" }] }, "plague", false, "melee"), "Ratkin Warrior");
  // wildlife: theme words already in the name are not repeated
  assert.equal(displayName({ name: "Rime Wolf", kind: "wildlife", themes: [{ id: "rime" }] }, "rime", false), "Rime Wolf");
  assert.equal(displayName({ name: "Pestilent Wolf", kind: "wildlife", themes: [] }, "pestilence", false), "Pestilent Wolf");
  assert.equal(displayName({ name: "Ash Wolf", kind: "wildlife", themes: [] }, "ashen", false), "Ash Wolf");
  assert.equal(displayName({ name: "Giant ant", kind: "wildlife", themes: [{ id: "fire" }] }, "fire", false), "Giant Fire Ant");
  for (const n of ["Giant Sewer Rat", "Wrecker Axeman"]) assert.doesNotMatch(n, /\(lv/);
});

test("the same creature and theme get the same name in every zone (pure, no zone input)", () => {
  const c = { name: "Wolf", themes: [{ id: "timber" }] };
  assert.equal(displayName(c, "timber", false), displayName(c, "timber", false));
});

test("rares keep their unique name plus a title", () => {
  assert.equal(namedTitle("Old Blackbill", "Giant Raven", "the Raven of the Weep"), "Old Blackbill, the Raven of the Weep");
  assert.equal(namedTitle("Kelpmane", "Wild Horse"), "Kelpmane, the Wild Horse");
  assert.equal(namedTitle("Orrin the Lamp-Warden", "Wrecker Axeman"), "Orrin the Lamp-Warden");
  assert.equal(namedTitle("Mate Ferrow, the Weeper", "Ghost Knight"), "Mate Ferrow, the Weeper");
  assert.equal(titleCase("salvage-reeve hask"), "Salvage-Reeve Hask");
});

test("a human theme with an unpainted outfit wears a ready theme as a stand-in, never a capsule", () => {
  const dress = (t: string) => (t === "magus-staff" ? { outfit: "magus", weapon: "staff", wear: ["robe"], weaponItem: "staff", standIns: [] } : { error: `theme '${t}' names no declared outfit set` });
  const themes = [{ id: "magus-staff", status: "ready" }, { id: "grave-robes", status: "needs-art" }];
  const d = humanDress(dress, themes, "grave-robes");
  assert.ok(!("error" in d));
  if (!("error" in d)) {
    assert.equal(d.outfit, "magus");
    assert.match(d.standIns[0]!, /grave-robes -> magus-staff/);
  }
  const ready = humanDress(dress, themes, "magus-staff");
  assert.ok(!("error" in ready) && ready.standIns.length === 0);
  assert.ok("error" in humanDress(dress, [{ id: "grave-robes", status: "needs-art" }], "grave-robes"));
});
