/**
 * door-sign anchors for a town's exterior socket map: one wall point over each building's door, where its hanging sign goes
 * (owner ruling 2026-10-20: signs are exterior only, above the door). Taken from each building's own socket map
 * (`<town>-<model>.json`, its `sign-bracket` anchor: the door opening's centre at lintel + 0.3 m, measured by `dress sockets`
 * from the kit's own door socket) and carried into the world by the lot's transform from the town layout (centre, groundY,
 * yaw + preRot — the frame `dress apply` installs the building in). The bracket's `size` (clear space up to the eave) rides
 * along, and the building's `window` anchors come too (`window-<lot>-<id>`), so `dress check`'s `sign-over-door` sees them.
 * Pure: the caller reads the files.
 */
type P2 = [number, number];
type P3 = [number, number, number];
export interface DoorSignLot { id: string; model?: string; centre?: P2; groundY?: number; yaw?: number; preRot?: number }
export interface DoorSignAnchor { id: string; kind: "door-sign" | "door-sign-beside" | "door-sign-post" | "window"; level: number; position: P3; yaw: number; mount: "wall" | "floor"; outdoor: true; size?: P3; prefer?: number }

/** A freestanding sign post stands this far along the wall from the door's edge (inside the check's 1.0-1.5 m), and its footprint centre this far out from the wall. */
export const POST_FROM_EDGE = 1.25, POST_OUT = 1.0; // the anchor is the footprint centre: the post 0.6 m behind it, 0.4 m off the wall

/**
 * `door-sign-<lot>-post-l/-r`: floor points beside the door where a freestanding sign POST stands (owner ruling 2026-10-21:
 * a door under a low eave with no wall for a board), only on a side with no ground-floor window in the way. `door` is the
 * carried door-sign anchor, `windows` the building's carried windows, `groundY` the lot's ground.
 */
export function postAnchors(lot: string, door: { position: P3; yaw: number; size?: P3 }, windows: readonly { position: P3; yaw: number; size?: P3 }[], groundY: number): DoorSignAnchor[] {
  const ay = (door.yaw * Math.PI) / 180, t: P2 = [Math.cos(ay), -Math.sin(ay)], f: P2 = [Math.sin(ay), Math.cos(ay)];
  const half = (door.size?.[0] ?? 1.2) / 2, r2 = (v: number): number => +v.toFixed(2), out: DoorSignAnchor[] = [];
  for (const [side, sgn] of [["l", -1], ["r", 1]] as const) {
    const along = sgn * (half + POST_FROM_EDGE);
    const p: P3 = [r2(door.position[0] + t[0] * along + f[0] * POST_OUT), r2(groundY), r2(door.position[2] + t[1] * along + f[1] * POST_OUT)];
    // a ground-floor window on this wall within the post's reach (board 1 m wide + 0.3 m) blocks this side
    const blocked = windows.some((w) => {
      if (!w.size || w.position[1] - w.size[1] / 2 > groundY + 2.5) return false;
      const dw = (w.position[0] - door.position[0]) * t[0] + (w.position[2] - door.position[2]) * t[1];
      const off = Math.abs((w.position[0] - door.position[0]) * f[0] + (w.position[2] - door.position[2]) * f[1]);
      return off < 0.6 && Math.abs(dw - along) < w.size[0] / 2 + 0.8;
    });
    if (!blocked) out.push({ id: `door-sign-${lot}-post-${side}`, kind: "door-sign-post", level: 0, position: p, yaw: door.yaw, mount: "floor", outdoor: true });
  }
  return out;
}
export interface BuildingAnchor { id?: string; kind: string; level?: number; position: P3; yaw: number; mount: string; size?: P3; prefer?: number }

/** One `door-sign-<lot>` anchor per lot whose building map has a sign bracket, plus its windows; `skipped` names the rest and why. */
export function doorSignAnchors(lots: DoorSignLot[], buildingAnchors: (model: string) => BuildingAnchor[] | undefined): { anchors: DoorSignAnchor[]; skipped: string[] } {
  const anchors: DoorSignAnchor[] = [], skipped: string[] = [];
  for (const b of lots) {
    if (!b.model || !b.centre || b.groundY === undefined) { skipped.push(`${b.id} (no model/centre/groundY in the layout)`); continue; }
    const list = buildingAnchors(b.model);
    if (!list) { skipped.push(`${b.id} (no socket map for ${b.model})`); continue; }
    const a = list.find((x) => x.kind === "sign-bracket");
    if (!a) { skipped.push(`${b.id} (its socket map has no sign-bracket anchor)`); continue; }
    const th = (b.yaw ?? 0) + (b.preRot ?? 0), c = Math.cos(th), s = Math.sin(th);
    const r2 = (v: number): number => +v.toFixed(2);
    const carry = (x: BuildingAnchor): { position: P3; yaw: number } => {
      const [lx, ly, lz] = x.position;
      const deg = (((x.yaw + (th * 180) / Math.PI + 180) % 360) + 360) % 360 - 180;
      return { position: [r2(b.centre![0] + lx * c + lz * s), r2(b.groundY! + ly), r2(b.centre![1] - lx * s + lz * c)], yaw: +deg.toFixed(1) };
    };
    anchors.push({ id: `door-sign-${b.id}`, kind: "door-sign", level: 0, ...carry(a), mount: "wall", outdoor: true, ...(a.size ? { size: a.size } : {}) });
    // beside the door (a projecting sign where the wall over the door has no room): door-sign-<lot>-l / -r
    for (const x of list) if (x.kind === "sign-beside") anchors.push({ id: `door-sign-${b.id}-${(x.id ?? "").replace(/^sign-beside-/, "")}`, kind: "door-sign-beside", level: 0, ...carry(x), mount: "wall", outdoor: true, ...(x.size ? { size: x.size } : {}), ...(x.prefer !== undefined ? { prefer: x.prefer } : {}) });
    const wins: DoorSignAnchor[] = [];
    list.forEach((w, k) => {
      if (w.kind !== "window") return; // every storey's windows (marker y is the model frame's, not the level's): a tall sign reaches the first floor
      wins.push({ id: `window-${b.id}-${w.id ?? k}`, kind: "window", level: 0, ...carry(w), mount: "wall", outdoor: true, ...(w.size ? { size: w.size } : {}) });
    });
    anchors.push(...wins);
    // the third form: a freestanding sign post beside the door, on a window-free side
    anchors.push(...postAnchors(b.id, { ...carry(a), ...(a.size ? { size: a.size } : {}) }, wins, b.groundY!));
  }
  return { anchors, skipped };
}
