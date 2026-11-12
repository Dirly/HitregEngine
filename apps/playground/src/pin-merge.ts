/**
 * Merging two copies of a scene's notes (`.hitreg/pins/<scene>.json`).
 *
 * The notes file has two writers: the editor tab (the human's notes) and agents (replies, `resolved`). Both used to
 * POST the WHOLE array and the server replaced the file, so whichever copy was older silently erased the other
 * side's work: an agent answering from a read made a minute ago dropped the notes written since, and the tab's next
 * save un-did the agent's `resolved` and `reply` (the tab never re-read the file). Every write and every re-read now
 * goes through this merge instead. Pure: the dev server (vite.config.ts) and the tab (pins.ts) share it.
 */
export interface MergePin {
  id: string;
  createdAt?: string;
  updatedAt?: string;
  reply?: string;
}

const stamp = (pin: MergePin): number => Date.parse(pin.updatedAt ?? pin.createdAt ?? "") || 0;
const same = (a: MergePin, b: MergePin): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * `incoming` laid over `existing`, per note id:
 * - a note only one side has is kept (omitting a note never deletes it: deletions are named in `deleted`);
 * - both have it: the copy with the later `updatedAt` wins; a tie goes to `incoming` (an agent's reply rides on the
 *   `updatedAt` it read); when `existing` wins, an agent `reply` it lacks is still taken from `incoming`.
 * Order: `existing`'s, then notes new in `incoming`.
 */
export function mergePins<T extends MergePin>(existing: readonly T[], incoming: readonly T[], deleted: readonly string[] = []): T[] {
  const gone = new Set(deleted);
  const inc = new Map(incoming.map((pin) => [pin.id, pin] as const));
  const out: T[] = [];
  for (const old of existing) {
    if (gone.has(old.id)) continue;
    const next = inc.get(old.id);
    if (!next || same(old, next)) { out.push(old); continue; }
    if (stamp(next) >= stamp(old)) out.push(next);
    else out.push(next.reply && !old.reply ? { ...old, reply: next.reply } : old);
  }
  const had = new Set(existing.map((pin) => pin.id));
  for (const pin of incoming) if (!had.has(pin.id) && !gone.has(pin.id)) out.push(pin);
  return out;
}
