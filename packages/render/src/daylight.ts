import { uniform } from "three/tsl";

/**
 * How much daylight the rendered scene has right now, 0 (night) .. 1 (day),
 * as the day/night layer last said (SceneLighting.daylight) — published here,
 * once per frame, for the things that are not lights but still change at
 * night: a lantern's glass (`material.nightGlow`) and night-only particle
 * emitters (`particles.when`). One number, so nothing has to find the scene's
 * lighting to ask. 1 in a scene with no day/night script.
 */
export const worldDaylight = { value: 1 };

/** `1 - daylight` as a shader uniform. Shared by every night-glowing material. */
export const nightLevel = uniform(0);

/** Called by SceneLighting.frame(). */
export function publishDaylight(daylight: number): void {
  const d = Math.min(1, Math.max(0, daylight));
  worldDaylight.value = d;
  nightLevel.value = 1 - d;
}
