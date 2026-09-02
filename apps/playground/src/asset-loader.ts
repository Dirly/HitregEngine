import { type AssetLibrary } from "@hitreg/core";
import { loadWorldRecipes } from "./voxel-world.js";

/**
 * assets/ is the project content folder. In dev everything is fetched FRESH
 * from disk through the bridge — vite's module cache must never serve assets
 * (its watcher ignores assets/, so cached imports go stale across reloads).
 * Returns the freshest scene doc content found, if any. When `preferredScene`
 * (a base name, no extension) matches a scene in the index, that one loads
 * instead of the first — used to reopen the last scene the user was editing.
 */
export async function loadAssets(
  assets: AssetLibrary,
  preferredScene?: string | null,
): Promise<string | null> {
  const index = (await fetch("/__hitreg/assets-index").then((r) => r.json())) as Record<
    string,
    string[]
  >;
  const fileUrl = (kind: string, file: string) =>
    `/__hitreg/asset-file?file=${encodeURIComponent(`${kind}/${file}`)}`;
  const readJson = (kind: string, file: string) =>
    fetch(fileUrl(kind, file)).then((r) => r.json());

  // Every JSON asset fetch is independent, so issue them all at once instead of
  // one blocking round-trip at a time — on a large project this is the
  // difference between a serial stall and a single parallel burst at boot (and
  // on every unavoidable reload). Registration order within a kind is
  // irrelevant (each keys by id), so await the whole batch, then add.
  const jsonKinds: { kind: string; type?: string; onlyJson?: boolean }[] = [
    { kind: "prefabs" },
    { kind: "materials", type: "material" },
    { kind: "terrain", type: "terrain-heightfield", onlyJson: true },
    { kind: "spritesheets", type: "spritesheet", onlyJson: true },
  ];
  await Promise.all(
    jsonKinds.map(async ({ kind, type, onlyJson }) => {
      const files = (index[kind] ?? []).filter((f) => !onlyJson || f.endsWith(".json"));
      const loaded = await Promise.all(
        files.map(async (file) => ({ id: file.replace(/\.json$/, ""), data: await readJson(kind, file) })),
      );
      for (const { id, data } of loaded) {
        if (type) assets.addDataAsset({ id, type, name: id, data });
        else assets.addPrefab(id, data);
      }
    }),
  );

  // World recipes register into the voxel world registry rather than the asset
  // library: render, physics and placement each resolve a generated cell by
  // world id, the same way they resolve a glTF by asset id.
  await loadWorldRecipes(index, readJson);

  for (const file of index["models"] ?? []) {
    if (!/\.(glb|gltf)$/.test(file)) continue;
    assets.addModel({ id: file, name: file.split("/").pop()!, url: fileUrl("models", file) });
  }
  for (const file of index["textures"] ?? []) {
    if (!/\.(png|jpe?g|webp)$/i.test(file)) continue;
    assets.addTexture({ id: file, name: file.split("/").pop()!, url: fileUrl("textures", file) });
  }
  for (const file of index["audio"] ?? []) {
    if (!/\.(wav|mp3|ogg)$/i.test(file)) continue;
    assets.addSound({ id: file, name: file.split("/").pop()!, url: fileUrl("audio", file) });
  }

  const scenes = (index["scenes"] ?? []).filter((f) => f.endsWith(".scene.json"));
  const sceneFile =
    (preferredScene && scenes.find((f) => f === `${preferredScene}.scene.json`)) ||
    scenes[0];
  if (!sceneFile) return null;
  return fetch(fileUrl("scenes", sceneFile)).then((r) => r.text());
}
