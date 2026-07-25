/** Persist an asset file through the dev server's write endpoint. */
export function saveAsset(file: string, content: string): void {
  void fetch("/__hitreg/write-asset", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file, content }),
  }).then((res) => {
    if (!res.ok) console.warn("[playground] asset save failed:", file);
  });
}

export function clientLog(message: string): void {
  void fetch("/__hitreg/log", { method: "POST", body: message }).catch(() => undefined);
}

window.addEventListener("error", (e) => clientLog(`window.error: ${e.message} @ ${e.filename}:${e.lineno}`));
window.addEventListener("unhandledrejection", (e) => clientLog(`unhandledrejection: ${String(e.reason)}`));
