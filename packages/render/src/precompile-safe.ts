/**
 * `material.userData[PRECOMPILE_SAFE] = true`: a transparent material that
 * reads nothing of the frame (no viewport depth, no scene colour), so
 * `precompileGroup` may compile it off-frame. Transparent materials are
 * otherwise skipped there (see compileInSceneContext: the water shader's
 * depth read broke when compiled outside the scene pass).
 */
export const PRECOMPILE_SAFE = "precompileSafe";
