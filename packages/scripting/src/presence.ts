import {
  dialogueConditionSchema,
  npcMemorySchema,
  testCondition,
  type CharacterSheet,
  type Conversation,
  type DialogueCondition,
  type NpcMemory,
  type Quest,
  type QuestJournal,
} from "@hitreg/core";
import { Script, type ScriptContext } from "./script.js";
import { readSheet, sheetStoreOf, type SheetStoreLike } from "./character-store.js";
import { worldFactsAt } from "./world-facts.js";

type Ctx = Pick<ScriptContext, "getEntity" | "getObject" | "getDataAsset" | "biomeAt">;

/**
 * The presence condition of `entityId`: a `presence` script's `when`, or an
 * `npc` builtin's `presence` param (an entity runs one script, so a person who
 * comes and goes carries it on the npc itself). Null = always present.
 */
function presenceCondition(ctx: Ctx, entityId: string): DialogueCondition | null {
  const script = ctx.getEntity(entityId)?.components["script"] as { name?: string; params?: Record<string, unknown> } | undefined;
  const raw = script?.name === "presence" ? script.params?.["when"] : script?.name === "npc" ? script.params?.["presence"] : undefined;
  if (!raw || typeof raw !== "object" || Object.keys(raw).length === 0) return null;
  const parsed = dialogueConditionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Client presentation shared by the `presence` and `npc` builtins: show the object only while it is there for this tab's player. */
export function showIfPresent(ctx: Ctx & Pick<ScriptContext, "localPlayer">, store: Pick<SheetStoreLike, "get">, entityId: string, object: { visible: boolean }): void {
  const me = ctx.localPlayer?.() ?? null;
  if (!me || !presenceCondition(ctx, entityId)) return;
  const there = presentFor(ctx, store, entityId, me);
  if (object.visible !== there) object.visible = there;
}

/**
 * Whether `entityId` is THERE for `actorId` right now: its `presence` script's
 * `when` holds for that character (clock and weather read at the entity's own
 * position; flags, quests, items read from the character). An entity without a
 * `presence` script is always there. A conversation already open with it keeps
 * it there until the conversation ends — a presence never leaves mid-sentence.
 * The authority uses this to refuse requests; clients use it to draw.
 */
export function presentFor(ctx: Ctx, store: Pick<SheetStoreLike, "get">, entityId: string, actorId: string | null): boolean {
  const when = presenceCondition(ctx, entityId);
  if (!when) return true;
  if (!actorId) return false;
  const conv = store.get(`dialogue/${actorId}`) as Conversation | undefined;
  if (conv?.npc === entityId) return true;
  const o = ctx.getObject(entityId);
  const at = o ? o.getWorldPosition(o.position.clone()) : null;
  const memory = (store.get(`npc/${actorId}`) as NpcMemory | undefined) ?? npcMemorySchema.parse({});
  const sheet: CharacterSheet | null = readSheet(store as SheetStoreLike, actorId);
  return testCondition(when, {
    npcId: entityId,
    memory,
    journal: store.get(`quests/${actorId}`) as QuestJournal | undefined,
    sheet,
    quest: (id) => {
      const a = ctx.getDataAsset?.(id);
      return a?.type === "quest" ? (a.data as Quest) : undefined;
    },
    metBefore: false,
    world: at ? worldFactsAt(ctx, store, at.x, at.z) : null,
  });
}

/**
 * An entity that is only THERE while a condition holds: a shape in the fog, a
 * stall that opens when a flag is set. Put it on a thing that runs no other
 * script; a PERSON who comes and goes (a ferryman at dusk) is an `npc` with
 * its `presence` param instead — one script per entity. Either can be a
 * `presence` quest source.
 *
 * The authority asks {@link presentFor} before honouring a talk or an interact
 * with it; every client hides it (the root object and its children) for its own
 * player while the condition fails. It is never removed from the shared world,
 * so give it no solid collider: a hidden thing must not block anyone. A
 * conversation open with it holds it in place until that conversation ends.
 */
export class PresenceScript extends Script {
  static override scriptName = "presence";
  static override presentation = true;
  static override params = {
    when: {
      default: {} as Record<string, unknown>,
      description:
        "condition (the dialogue/quest condition language): clock and weather are read at this entity; flags, quests and items " +
        "from the character looking. {} = always there",
    },
  };

  private store!: SheetStoreLike;
  private scan = 0;

  override onStart(): void {
    this.store = sheetStoreOf(this.ctx);
    if (!dialogueConditionSchema.safeParse(this.param<unknown>("when") ?? {}).success) console.warn(`[presence] ${this.entityId}: \`when\` is not a valid condition`);
  }

  /** Presentation: shown only while it is there for this tab's player. */
  override onLateUpdate(dt: number): void {
    this.scan -= dt;
    if (this.scan > 0) return;
    this.scan = 0.25;
    showIfPresent(this.ctx, this.store, this.entityId, this.object);
  }
}
