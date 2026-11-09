import path from 'node:path';

/** Alternate compiled atlases and texture IDs let isolated pages preserve the source page and its standalone sheets. */
export function weaponPagePaths(engine, recipe, modelId, args = {}) {
  const atlasRoot = typeof args['atlas-root'] === 'string' ? path.resolve(args['atlas-root']) : path.join(engine, 'tools', 'atlas', 'out');
  const textureDir = typeof args['texture-dir'] === 'string' ? args['texture-dir'] : path.posix.dirname(modelId);
  if (!textureDir || path.posix.isAbsolute(textureDir) || path.win32.isAbsolute(textureDir) || textureDir.includes('\\') || textureDir.split('/').includes('..')) throw new Error('--texture-dir must be a relative asset directory using forward slashes');
  return { atlasRoot, outDir: path.join(atlasRoot, recipe), textureDir };
}
