/**
 * The dev bridge URL for one asset file. Once the page has loaded a scene's
 * project scope (asset-loader), every read names that scope's owning project
 * (`&project=`), so the bridge resolves the file inside the scene's project
 * closure first and a same-named copy in an unrelated project (a lab's stale
 * model) can never shadow it. Unscoped pages send no project.
 */
let scopeOwner: string | null = null;

/** Set by asset-loader from the assets-index x-hitreg-scope header (owner first). */
export const setAssetScopeOwner = (owner: string | null): void => {
  scopeOwner = owner;
};

export const assetFileUrl = (file: string): string =>
  `/__hitreg/asset-file?file=${encodeURIComponent(file)}${scopeOwner ? `&project=${encodeURIComponent(scopeOwner)}` : ""}`;
