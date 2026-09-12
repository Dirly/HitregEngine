/** Browsing is shallow; an explicit search includes descendants. */
export function assetInFolder(id: string, folder: string, searching: boolean): boolean {
  const parent = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
  return parent === folder || (searching && (folder === "" || parent.startsWith(`${folder}/`)));
}

/** One shared page budget across all asset kinds, rather than a page per kind. */
export function assetPage(ids: string[], page: number, size = 48): { ids: string[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(ids.length / size));
  const current = Math.max(0, Math.min(page, pages - 1));
  return { ids: ids.slice(current * size, (current + 1) * size), page: current, pages };
}
