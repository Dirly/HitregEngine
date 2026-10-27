/** Static bundles use the exporter's JSON packs; older bundles retain bounded file reads. */
export async function bundleAssetReader(
  index: Record<string, string[]>,
  url: (path: string) => string,
): Promise<(kind: string, file: string) => Promise<unknown>> {
  const packs = index["json-packs"];
  const entries = new Map<string, { data?: unknown; error?: string }>();
  let next = 0;
  if (packs) {
    await Promise.all(Array.from({ length: Math.min(4, packs.length) }, async () => {
      while (next < packs.length) {
        const file = packs[next++]!;
        const response = await fetch(url(file));
        if (!response.ok) throw new Error(`Asset pack ${file}: HTTP ${response.status}`);
        const data = await response.json() as Record<string, { data?: unknown; error?: string }>;
        for (const [key, value] of Object.entries(data)) entries.set(key, value);
      }
    }));
  }
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (kind, file) => {
    const key = `${kind}/${file}`;
    if (packs) {
      const entry = entries.get(key);
      if (!entry) throw new Error(`Missing packed asset ${key}`);
      if (entry.error) throw new Error(`${key}: ${entry.error}`);
      return entry.data;
    }
    if (active >= 24) await new Promise<void>((resolve) => waiting.push(resolve));
    else active++;
    try {
      const response = await fetch(url(`content/${key}`));
      if (!response.ok) throw new Error(`${key}: HTTP ${response.status}`);
      return await response.json();
    } finally {
      const resume = waiting.shift();
      if (resume) resume();
      else active--;
    }
  };
}
