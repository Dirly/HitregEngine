import fs from "node:fs";

/**
 * The animation clips a model file ships with, read from its glTF JSON without touching a buffer.
 *
 * A controller only plays `<Stance>_<clip>` when the model has that clip. The server has no mixer, so without this it
 * could not tell, chose the plain clip every time and replicated it: every mob with a weapon stance played bare `Idle`
 * and `Walk` on the clients (a staff held like nothing, 2026-11-07). The stance list was right; only the model's clip
 * list was missing.
 */
const GLB_MAGIC = 0x46546c67;
const GLB_HEADER = 20;

export function gltfClipNames(file: string): string[] {
  const descriptor = fs.openSync(file, "r");
  try {
    const head = Buffer.alloc(GLB_HEADER);
    fs.readSync(descriptor, head, 0, GLB_HEADER, 0);
    let text: string;
    if (head.readUInt32LE(0) === GLB_MAGIC) {
      const json = Buffer.alloc(head.readUInt32LE(12));
      fs.readSync(descriptor, json, 0, json.length, GLB_HEADER);
      text = json.toString("utf8");
    } else {
      text = fs.readFileSync(file, "utf8");
    }
    const animations = (JSON.parse(text) as { animations?: { name?: string }[] }).animations ?? [];
    return animations.flatMap((clip) => (clip.name ? [clip.name] : []));
  } finally {
    fs.closeSync(descriptor);
  }
}

/** `gltfClipNames` once per file: a spawn must not re-read a model. An unreadable file has no clips. */
export function modelClipReader(resolveFile: (assetId: string) => string | undefined): (assetId: string) => string[] {
  const known = new Map<string, string[]>();
  return (assetId) => {
    const hit = known.get(assetId);
    if (hit) return hit;
    const file = resolveFile(assetId);
    let clips: string[] = [];
    if (file) {
      try {
        clips = gltfClipNames(file);
      } catch (error) {
        console.warn(`[server] could not read the clips of ${assetId}:`, error instanceof Error ? error.message : error);
      }
    }
    known.set(assetId, clips);
    return clips;
  };
}
