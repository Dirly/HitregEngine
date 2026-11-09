import * as THREE from "three";
import { Script, type ScriptEventDecl } from "./script.js";
import { npcSpawnEventSchema } from "./encounter-waves.js";

export const encounterChoiceKey = (entityId: string): string => `encounter-choice/${entityId}.template`;

/** A single server-owned roll per instance, under a stable actor id for gates and health mechanics. */
export class EncounterChoiceScript extends Script {
  static override scriptName = "encounter-choice";
  static override params = {
    actor: { default: "", description: "Stable entity id for the chosen NPC. Gates and other mechanics reference this id, whichever template wins." },
    choices: { default: [] as string[], description: "Equally likely NPC template ids. Rolled once by the authority and latched in encounter-choice/<entity>.template for this instance; wipes and late joins do not reroll." },
    names: { default: {} as Record<string, string>, description: "Optional display names by template id, published as name/<actor> for the chosen NPC." },
    leash: { default: 24, min: 1, max: 500, description: "Metres the chosen NPC may chase from this encounter's origin." },
    yaw: { default: 0, description: "Initial facing in radians." },
  };
  static override events: ScriptEventDecl[] = [{ name: "npc.spawn", schema: npcSpawnEventSchema }];
  private readonly at = new THREE.Vector3();
  private requested = false;

  override onFixedUpdate(): void {
    const ns = this.ctx.netState, ev = this.ctx.events;
    if (!ns?.isAuthority() || !ev || this.requested) return;
    const actor = this.param<string>("actor");
    const choices = this.param<string[]>("choices").filter((s) => typeof s === "string" && s.length > 0);
    if (!actor || !choices.length || this.ctx.getEntity(actor) || ns.get(`combat/${actor}.dead`) === true) return;
    const key = encounterChoiceKey(this.entityId);
    let template = ns.get(key);
    if (template === undefined) {
      template = choices[Math.floor(Math.random() * choices.length)]!;
      ns.set(key, template);
    }
    // A stale or invalid saved choice must never silently reroll an instance.
    if (typeof template !== "string" || !choices.includes(template)) return;
    this.object.getWorldPosition(this.at);
    const home = [this.at.x, this.at.y, this.at.z];
    this.requested = true;
    const name = this.param<Record<string, string>>("names")?.[template];
    if (name) ns.set(`name/${actor}`, name);
    ev.emit("npc.spawn", { template, id: actor, at: home, yaw: this.param<number>("yaw"),
      params: { home, leash: this.param<number>("leash"), roam: 0 }, respawn: false });
  }
}
