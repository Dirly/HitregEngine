/**
 * Loading an ASCII FBX that three refuses.
 *
 * Blockbench exports FBX as text, and three's FBXLoader rejects those files —
 * for two reasons, neither of them a problem with the file:
 *
 *  1. `isFbxFormatASCII` decides a text file is FBX by walking the opening
 *     characters at a growing stride and declaring the format unknown the
 *     moment one lands on the corresponding letter of "Kaydara\FBX\Binary\\".
 *     It is a coincidence test, not a format test, so whether it passes depends
 *     on how long the comment banner is. Autodesk's two-line banner happens to
 *     clear it; Blockbench's three-line one does not.
 *  2. Its TextParser has no notion of a property at the top level — the
 *     `FileId:` / `CreationTime:` / `Creator:` lines every writer emits after
 *     the header block — and dereferences an empty node stack on the first one.
 *
 * So we hand the loader a copy with a banner it accepts and those top-level
 * scalars removed. Nothing the loader reads is altered. The banner is chosen by
 * running the same coincidence test here rather than hard-coding one, because
 * what passes depends on the bytes that follow it.
 */

/** three's sniffer, reproduced so we can ask it before handing over the file. */
function passesAsciiSniff(text) {
  const CORRECT = ["K", "a", "y", "d", "a", "r", "a", "\\", "F", "B", "X", "\\", "B", "i", "n", "a", "r", "y", "\\", "\\"];
  let cursor = 0;
  let rest = text;
  for (let i = 0; i < CORRECT.length; i++) {
    const ch = rest[0];
    rest = rest.slice(cursor + 1);
    cursor++;
    if (ch === CORRECT[i]) return false;
  }
  return true;
}

/** Drop unindented `Name: value` lines — the parser cannot represent them. */
function stripTopLevelProps(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^[A-Za-z_]\w*:\s*[^{]*$/.test(line))
    .join("\n");
}

const BANNER = "; FBX 7.3.0 project file\n; ----------------------------------------------------\n";

const asArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

/**
 * @param {Buffer} buf raw file bytes.
 * @returns {ArrayBuffer} bytes `FBXLoader.parse` will accept — the originals
 *   unchanged whenever it would already have taken them, binary FBX included.
 */
export function sanitizeFbx(buf) {
  if (buf.length >= 18 && buf.toString("binary", 0, 18) === "Kaydara FBX Binary") return asArrayBuffer(buf);
  const text = buf.toString("utf8");
  if (passesAsciiSniff(text) && !/^[A-Za-z_]\w*:\s*[^{]*$/m.test(text)) return asArrayBuffer(buf);
  const body = stripTopLevelProps(text.replace(/^(?:\s*;[^\n]*\n)+/, ""));
  // Pad the banner until the coincidence test clears. A few spaces is always
  // enough; the search is what keeps this independent of the exporter.
  for (let pad = 0; pad < 64; pad++) {
    const candidate = `${BANNER}${" ".repeat(pad)}\n${body}`;
    if (passesAsciiSniff(candidate)) return asArrayBuffer(Buffer.from(candidate, "utf8"));
  }
  return asArrayBuffer(buf); // give up and let the loader report it
}
