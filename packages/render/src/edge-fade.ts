import { Fn, float, max, sin, smoothstep, uv } from "three/tsl";

/** Coverage coordinates belong to the whole sheet, independently of tiled map UVs. */
export interface EdgeFadeData {
  shape?: "quad" | "triangle";
  width?: [number, number];
  noise?: number;
  noiseScale?: number;
  power?: number;
  uvChannel?: 0 | 1;
}

// TSL's fluent expression types do not model arbitrary swizzles/compositions.
type N = any;

/** CPU counterpart for authoring opacity/support audits; accepts coverage UVs, never tiled UVs. */
export function edgeFadeCoverage(point: readonly [number, number], data: EdgeFadeData = {}): number {
  const [x, y] = point, [wx, wy] = data.width ?? [0.08, 0.15];
  const frequency = data.noiseScale ?? 8;
  const wave = (Math.sin((x * 5.17 + y * 1.39) * frequency) + Math.sin((y * 4.73 - x * 1.91) * frequency)) * 0.5;
  const jitter = Math.max(0.05, 1 + (data.noise ?? 0.25) * wave);
  const ramp = (distance: number, width: number): number => {
    const t = Math.max(0, Math.min(1, distance / Math.max(width * jitter, 1e-5)));
    return t * t * (3 - 2 * t);
  };
  const mask = data.shape === "triangle"
    ? ramp(x, wx) * ramp(y, wy) * ramp(1 - x - y, Math.hypot(wx, wy))
    : ramp(Math.min(x, 1 - x), wx) * ramp(Math.min(y, 1 - y), wy);
  return Math.pow(mask, data.power ?? 1.2);
}

/**
 * A single continuous perimeter for a subdivided sheet, with rounded soft corners.
 * settings = (width.x, width.y, noise, noiseScale); numeric edits remain uniforms.
 * A missing coverage stream fails closed instead of repeating fades on the map's tiles.
 */
export function edgeFadeNode(data: EdgeFadeData, settings: N, power: N): N {
  const channel = data.uvChannel ?? 1;
  return (Fn as N)((_: unknown, builder: { hasGeometryAttribute(name: string): boolean }) => {
    if (!builder.hasGeometryAttribute(channel === 1 ? "uv1" : "uv")) return float(0);
    const p: N = uv(channel);
    const wave: N = sin(p.x.mul(5.17).add(p.y.mul(1.39)).mul(settings.w))
      .add(sin(p.y.mul(4.73).sub(p.x.mul(1.91)).mul(settings.w))).mul(0.5);
    const jitter: N = max(float(0.05), float(1).add(settings.z.mul(wave)));
    const width: N = settings.xy.mul(jitter).max(1e-5);
    const ramp = (distance: N, size: N): N => smoothstep(float(0), size, distance);
    const mask: N = data.shape === "triangle"
      ? ramp(p.x, width.x).mul(ramp(p.y, width.y)).mul(ramp(float(1).sub(p.x).sub(p.y), width.length()))
      : ramp(p.x.min(float(1).sub(p.x)), width.x).mul(ramp(p.y.min(float(1).sub(p.y)), width.y));
    return mask.pow(power);
  })();
}
