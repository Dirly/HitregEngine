/**
 * KEEP-OUTS — volumes the placement solver keeps dressing out of, read from structure DATA, never from pictures.
 *
 * Derek 2026-10-30: "Am I close to a doorway? I should delete myself. We use WFC; every building has grid data." A WFC
 * kit building exports its doors, gates, stair flights and hearth clearances as markers (`<model>.markers.json`, the
 * kit's own frame: position, yaw = the way it faces OUT / the direction of travel, size [w, h, d]); a catalogue prop
 * declares its own in `placeRule.openings`; a tool passes its lanes (streets, footpaths, door approaches). Each becomes a
 * plan box with a height band; a dressing piece inside one is moved out or dropped. Pure.
 */
import { laneBoxes, localToWorld, type Obb, type V2 } from "./obb.js";
import type { PlaceOpening } from "../components/place-rule.js";

/** Metres kept clear in front of (and behind) a door or gate. */
export const DOOR_CLEAR_DEPTH_M = 1.5;
/** Metres added to a door's width for its clear zone (0.2 m each side). */
export const DOOR_CLEAR_EXTRA_M = 0.4;
/** Height band a ground-floor keep-out holds above its marker (m): a lamp bracket over a door is not in the door. */
export const KEEP_OUT_HEADROOM_M = 2.4;

export type KeepOutKind = "door" | "gate" | "stair" | "hearth" | "lane";

export interface KeepOut {
  id: string;
  kind: KeepOutKind;
  box: Obb;
  /** World height band [lo, hi]; a piece whose own band misses it is not in it. Omitted = all heights. */
  band?: [number, number];
  /** Why, in words (shown in a drop reason). */
  why: string;
}

/** A marker as the WFC exporter writes it (`<model>.markers.json` `markers[]`). */
export interface StructureMarker {
  id: string;
  kind: string;
  level?: number;
  position: [number, number, number];
  /** Degrees, 0 faces +Z. */
  yaw?: number;
  size?: [number, number, number];
}

/** A placed structure: world plan position, yaw (radians), base height, uniform scale. */
export interface PlacedFrame { at: V2; yaw: number; y: number; k?: number }

const dirOf = (yawRad: number): V2 => [Math.sin(yawRad), Math.cos(yawRad)];

/** One door/gate clear zone (both sides of the opening). `w` = opening width (m), `p` world plan point, `yaw` radians facing out. */
function doorBox(p: V2, yaw: number, w: number, depth = DOOR_CLEAR_DEPTH_M): Obb {
  return { c: p, half: [(w + DOOR_CLEAR_EXTRA_M) / 2, depth], yaw };
}

/**
 * Keep-outs of one placed structure from its markers: `door` / `gate` (a clear zone DOOR_CLEAR_DEPTH_M deep on both
 * sides, the width + DOOR_CLEAR_EXTRA_M), `stair-approach` / `stair-foot` / `stair-head` (the flight's clear area at its
 * size), `hearth-clearance`. Other kinds (windows, fires, beams) keep nothing clear.
 */
export function keepOutsFromMarkers(owner: string, frame: PlacedFrame, markers: readonly StructureMarker[]): KeepOut[] {
  const k = frame.k ?? 1, out: KeepOut[] = [];
  for (const m of markers) {
    const p = localToWorld(frame.at, frame.yaw, [m.position[0] * k, m.position[2] * k]), yaw = frame.yaw + ((m.yaw ?? 0) * Math.PI) / 180;
    const y = frame.y + m.position[1] * k, band: [number, number] = [y - 0.3, y + KEEP_OUT_HEADROOM_M];
    const size = (m.size ?? [1, 0, 1]).map((v) => v * k) as [number, number, number];
    if (m.kind === "door" || m.kind === "gate") {
      out.push({ id: `${owner}:${m.id}`, kind: m.kind, box: doorBox(p, yaw, Math.max(0.8, size[0])), band, why: `${m.kind} ${m.id} of ${owner}` });
    } else if (m.kind === "stair-approach" || m.kind === "stair-foot" || m.kind === "stair-head") {
      const w = Math.max(0.8, size[0]), d = Math.max(m.kind === "stair-approach" ? 1 : 0.8, size[2]);
      out.push({ id: `${owner}:${m.id}`, kind: "stair", box: { c: p, half: [w / 2, d / 2], yaw }, band, why: `${m.kind} ${m.id} of ${owner}` });
    } else if (m.kind === "hearth-clearance") {
      out.push({ id: `${owner}:${m.id}`, kind: "hearth", box: { c: p, half: [Math.max(0.5, size[0]) / 2, Math.max(0.5, size[2]) / 2], yaw }, band, why: `hearth clearance ${m.id} of ${owner}` });
    }
  }
  return out;
}

/** Keep-outs a catalogue prop declares (`placeRule.openings`), placed at `frame`. */
export function keepOutsFromOpenings(owner: string, frame: PlacedFrame, openings: readonly PlaceOpening[]): KeepOut[] {
  const k = frame.k ?? 1;
  return openings.flatMap((o, i) => {
    const ko = keepOutsFromMarkers(owner, frame, [{ id: `${o.kind}-${i + 1}`, kind: o.kind === "stair" ? "stair-approach" : o.kind, position: o.position, yaw: o.yaw, size: [o.width, 0, o.depth ?? 3] }]);
    // a door's declared depth is its clear depth (each side), not the stair-run size the marker form carries
    return o.kind !== "stair" && o.depth ? ko.map((x) => ({ ...x, box: { ...x.box, half: [x.box.half[0], o.depth! * k] as V2 } })) : ko;
  });
}

/** Keep-outs along lanes (streets, footpaths, a door's approach): one box per segment, `width` wide, all heights. */
export function keepOutsFromLane(id: string, points: V2[], width: number, why = `lane ${id}`): KeepOut[] {
  return laneBoxes(points, width).map((box, i) => ({ id: `${id}#${i}`, kind: "lane" as const, box, why }));
}

/** A door the caller knows by its world point and the direction it faces out (a town lot's door, a kit door socket). */
export function keepOutAtDoor(id: string, at: V2, facing: V2, width: number, y?: number): KeepOut {
  const yaw = Math.atan2(facing[0], facing[1]);
  return { id, kind: "door", box: doorBox(at, yaw, width), ...(y !== undefined ? { band: [y - 0.3, y + KEEP_OUT_HEADROOM_M] as [number, number] } : {}), why: `door ${id}` };
}

/** The plan direction (x, z) a yaw (radians, three.js about +Y) faces. */
export const yawDirection = dirOf;
