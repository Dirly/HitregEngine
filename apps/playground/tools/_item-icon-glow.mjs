/** A steady snapshot of the item's real part-selective emissive colour. No bloom/VFX. */
export function iconPartGlow(glow, partIndex, part) {
  if (!glow || !(glow.intensity > 0)) return null;
  if (glow.parts && !glow.parts.some(name => partIndex?.[name] === part)) return null;
  const hex = glow.color.replace('#', '');
  const linear = value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  return [0, 2, 4].map(offset => linear(parseInt(hex.slice(offset, offset + 2), 16) / 255) * glow.intensity);
}

/** Preserve the old lit byte value exactly when this part does not emit.
 * HDR emission is added in linear light and Reinhard-mapped for a small PNG. */
export function iconLitChannel(litByte, emission) {
  if (!(emission > 0)) return Math.min(255, litByte);
  const v = Math.min(255, litByte) / 255;
  const linear = (v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4) + emission;
  const mapped = linear / (1 + linear);
  return 255 * (mapped <= .0031308 ? mapped * 12.92 : 1.055 * mapped ** (1 / 2.4) - .055);
}
