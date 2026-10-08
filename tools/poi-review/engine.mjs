import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(new URL('../../apps/playground/package.json', import.meta.url));
const { tsImport } = await import(pathToFileURL(require.resolve('tsx/esm/api')).href);
export const core = await tsImport('../../packages/core/src/index.ts', import.meta.url);
export const physics = await tsImport('../../packages/physics/src/index.ts', import.meta.url);
export const { z } = createRequire(new URL('../../packages/core/package.json', import.meta.url))('zod');
