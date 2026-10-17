/**
 * The river (and plain lake) water material a world's `rivers` stage writes, derived from its base water material:
 * the flowing tile (`<Name>Flowing`) for running water, the falling-water tile (`<Name>Fall`, with fallTextureScale
 * and fallSpeed) for waterfall faces, and the standing tile for still water. `has(tile)` says whether a texture id
 * resolves for the world: its own folder OR its dependsOn closure (foundation owns the stock water set; checking
 * only the world's own folder wrote river materials without the fall tile for every world built on foundation).
 */
export function riverWaterDoc(base: { color?: string; opacity?: number; water?: Record<string, unknown> }, has: (tile: string) => boolean): Record<string, unknown> {
  let texture = base.water?.["texture"] as string | undefined;
  if (texture) {
    const flowing = texture.replace(/(\.[a-z0-9]+)$/i, "Flowing$1");
    // tiles live anywhere in the project's dependsOn closure (foundation owns the stock water set): checking only the
    // world's own folder dropped the flowing tile and the fall tile (fallTexture/fallTextureScale/fallSpeed) from
    // every world built on foundation's water
    if (flowing !== texture && has(flowing)) texture = flowing;
  }
  const baseTexture = base.water?.["texture"] as string | undefined;
  const fallName = baseTexture ? baseTexture.replace(/(\.[a-z0-9]+)$/i, "Fall$1") : undefined;
  const fallTexture = fallName && fallName !== baseTexture && has(fallName) ? fallName : undefined;
  const doc = {
    shader: "water",
    color: base.color ?? "#2f7fa8",
    transparent: true,
    opacity: base.opacity ?? 0.9,
    water: {
      ...(base.water ?? {}),
      flowMode: "field",
      // a river is a few metres deep at most: the depth ramp must turn
      // over inside it or every channel reads as the shallowest band
      depthFadeDistance: 10,
      foamWidth: 0.6,
      // the current itself makes the motion; big standing waves on a
      // narrow channel look like a shaken tray, and a crisp two-step foam
      // band along the ribbon's edge read as a painted white rectangle
      waveAmplitude: 0.03,
      waveFrequency: 0.5,
      waveSpeed: 1.2,
      foamSteps: 3,
      foamPixel: 0.7,
      // the shore band is thin, broken into stepped patches and fades on still water (lakes and pools share this
      // material), so it gathers where the current meets a bank or a rock rather than outlining every shore
      foamBand: 1.4,
      shoreFoam: { breakup: 0.5, patch: 3.5, still: 0.12, flow: [0.1, 0.6] },
      // the sea layer keeps its sky, glints and abyss here, never its breaker lines or whitecaps: on a river or a
      // lake those drew three parallel white stripes along every bank and flecks over every pool
      ...(base.water?.["sea"] ? { sea: { ...(base.water["sea"] as Record<string, unknown>), breakers: 0, whitecaps: 0, whitecapStorm: 0 } } : {}),
      displace: false,
      // one tile size for rivers AND plain lakes: they share this material
      ...(texture ? { texture, textureScale: 10 } : {}),
      // the falling-water tile for waterfall faces: a `<Name>Fall` sibling of the base texture
      ...(fallTexture ? { fallTexture, fallTextureScale: 4, fallSpeed: 7 } : {}),
      // still water (lakes, and a river leaving one) keeps the standing-water tile, faded by the current
      ...(baseTexture ? { stillTexture: baseTexture, stillTextureScale: (base.water?.["textureScale"] as number | undefined) ?? 26 } : {}),
    },
  };
  return doc;
}
