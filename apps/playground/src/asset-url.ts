/**
 * The dev bridge URL for one asset file. Once the page has loaded a scene's
 * project scope (asset-loader), every read names that scope's owning project
 * (`&project=`), so the bridge resolves the file inside the scene's project
 * closure first and a same-named copy in an unrelated project (a lab's stale
 * model) can never shadow it. Unscoped pages send no project.
 */
let scopeOwner: string | null = null;
let bundleBase: string | null = null;

/** Published hosts resolve streaming files from their static bundle, without a dev bridge. */
export const setAssetBundleBase = (base: string): void => { bundleBase = base; };
export const assetIndexUrl = (): string => bundleBase ? new URL("assets-index.json", bundleBase).href : "/__hitreg/assets-index?kinds=chunks";

/** Set by asset-loader from the assets-index x-hitreg-scope header (owner first). */
export const setAssetScopeOwner = (owner: string | null): void => {
  scopeOwner = owner;
};

export const assetFileUrl = (file: string): string =>
  bundleBase ? new URL(`content/${file}`, bundleBase).href : `/__hitreg/asset-file?file=${encodeURIComponent(file)}${scopeOwner ? `&project=${encodeURIComponent(scopeOwner)}` : ""}`;

export const assetBatchUrl = (): string =>
  `/__hitreg/asset-json${scopeOwner ? `?project=${encodeURIComponent(scopeOwner)}` : ""}`;
