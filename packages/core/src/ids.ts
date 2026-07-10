/** Stable identifier for an entity within a scene document. */
export type EntityId = string;

export function newId(): EntityId {
  return crypto.randomUUID();
}
