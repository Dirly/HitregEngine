// Enforce the player/editor boundary against the modules actually emitted by the bundler.
export function assertPlayerModules(modules) {
  const forbidden = [...modules].filter((id) => {
    const file = id.replace(/\\/g, "/").split("?")[0];
    return /(?:^|\/)packages\/editor\//.test(file) ||
      /(?:^|\/)@hitreg\/editor(?:\/|$)/.test(file) ||
      /\/apps\/playground\/src\/(?:main|thumbnails|thumbnail-cache|dev-bridge|live-sync)\.[cm]?[jt]sx?$/.test(file);
  });
  if (forbidden.length) throw new Error(`Player build contains development tools:\n${forbidden.join("\n")}`);
}
