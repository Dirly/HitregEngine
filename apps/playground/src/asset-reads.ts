import { assetBatchUrl } from "./asset-url.js";

interface Read {
  file: string;
  resolve(data: unknown): void;
  reject(error: Error): void;
}

/** Coalesce library reads: thousands of tiny files must not mean thousands of HTTP requests. */
export function batchedAssetReader(): (kind: string, file: string) => Promise<unknown> {
  const waiting: Read[] = [];
  let active = 0;
  let scheduled = false;
  const pump = (): void => {
    scheduled = false;
    while (active < 4 && waiting.length) {
      const batch = waiting.splice(0, 64);
      active++;
      void fetch(assetBatchUrl(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ files: batch.map((read) => read.file) }),
      }).then(async (response) => {
        if (!response.ok) throw new Error(`Asset batch HTTP ${response.status}`);
        const entries = await response.json() as Array<{ data?: unknown; error?: string }>;
        for (let i = 0; i < batch.length; i++) {
          const entry = entries[i];
          const read = batch[i]!;
          if (!entry || entry.error) read.reject(new Error(entry?.error ?? `Missing ${read.file}`));
          else read.resolve(entry.data);
        }
      }).catch((error: unknown) => {
        for (const read of batch) read.reject(error instanceof Error ? error : new Error(String(error)));
      }).finally(() => {
        active--;
        pump();
      });
    }
  };
  return (kind, file) => new Promise((resolve, reject) => {
    waiting.push({ file: `${kind}/${file}`, resolve, reject });
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(pump);
    }
  });
}
