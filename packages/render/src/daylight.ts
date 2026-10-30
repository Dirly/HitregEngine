import { uniform } from "three/tsl";

/**
 * How much daylight the rendered scene has right now, 0 (night) .. 1 (day),
 * as the day/night layer last said (SceneLighting.daylight) — published here,
 * once per frame, for the things that are not lights but still change at
 * night: a lantern's glass (`material.nightGlow`) and night-only particle
 * emitters (`particles.when`). One number, so nothing has to find the scene's
 * lighting to ask. 1 in a scene with no day/night script.
 */
export const worldDaylight = { value: 1, sunlit: 0 };

/** `1 - daylight` as a shader uniform. Shared by every night-glowing material. */
export const nightLevel = uniform(0);

/**
 * Called by SceneLighting.frame(). `sunlit` = how much open daylight is lighting the drawn scene: the daylight, but 0
 * in a scene with no sun (a dungeon or a cellar is dark whatever its clock says). Light halos and lamp fog glow are
 * judged against it: a fire's glow is small under the noon sky and strong in the dark (Red Dial 2026-10-30).
 */
export function publishDaylight(daylight: number, hasSun = true): void {
  const d = Math.min(1, Math.max(0, daylight));
  worldDaylight.value = d;
  worldDaylight.sunlit = hasSun ? d : 0;
  nightLevel.value = 1 - d;
}
