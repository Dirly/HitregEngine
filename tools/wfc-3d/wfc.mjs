const DIRECTIONS = ["px", "nx", "py", "ny", "pz", "nz"];

const DELTA = {
  px: [1, 0, 0],
  nx: [-1, 0, 0],
  py: [0, 1, 0],
  ny: [0, -1, 0],
  pz: [0, 0, 1],
  nz: [0, 0, -1],
};

const OPPOSITE = { px: "nx", nx: "px", py: "ny", ny: "py", pz: "nz", nz: "pz" };
const ROTATIONS = new Set([0, 90, 180, 270]);

function fail(message) {
  throw new Error(`invalid WFC tileset: ${message}`);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finitePositive(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Parse and normalize the file format consumed by the registered tool. */
export function parseTileset(raw) {
  if (!isRecord(raw)) fail("root must be an object");
  if (raw.version !== 1) fail("version must be 1");
  if (typeof raw.name !== "string" || raw.name.trim() === "") fail("name is required");

  const cellSize = raw.cellSize ?? [1, 1, 1];
  if (!Array.isArray(cellSize) || cellSize.length !== 3 || !cellSize.every(finitePositive)) {
    fail("cellSize must be three positive numbers");
  }
  if (!Array.isArray(raw.tiles) || raw.tiles.length === 0) fail("tiles must be a non-empty array");

  const seen = new Set();
  const tiles = raw.tiles.map((input, index) => {
    if (!isRecord(input)) fail(`tiles[${index}] must be an object`);
    if (typeof input.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(input.id)) {
      fail(`tiles[${index}].id must match ^[a-z0-9][a-z0-9_-]*$`);
    }
    if (seen.has(input.id)) fail(`duplicate tile id "${input.id}"`);
    seen.add(input.id);
    if (input.prefabId !== undefined && (typeof input.prefabId !== "string" || input.prefabId === "")) {
      fail(`tile "${input.id}" prefabId must be a non-empty string when present`);
    }
    const weight = input.weight ?? 1;
    if (!finitePositive(weight)) fail(`tile "${input.id}" weight must be positive`);
    const offset = input.offset ?? [0, 0, 0];
    if (
      !Array.isArray(offset) ||
      offset.length !== 3 ||
      offset.some((value) => typeof value !== "number" || !Number.isFinite(value))
    ) {
      fail(`tile "${input.id}" offset must be three finite numbers`);
    }
    const rotations = input.rotations ?? [0];
    if (
      !Array.isArray(rotations) ||
      rotations.length === 0 ||
      rotations.some((rotation) => !ROTATIONS.has(rotation)) ||
      new Set(rotations).size !== rotations.length
    ) {
      fail(`tile "${input.id}" rotations must be unique values from 0, 90, 180, 270`);
    }
    if (!isRecord(input.sockets)) fail(`tile "${input.id}" sockets must be an object`);
    const sockets = {};
    for (const direction of DIRECTIONS) {
      const socket = input.sockets[direction];
      if (typeof socket !== "string" || socket === "") {
        fail(`tile "${input.id}" socket ${direction} must be a non-empty string`);
      }
      sockets[direction] = socket;
    }
    const alignUv = (input.alignUv ?? []).map((entry, i) => {
      if (!isRecord(entry) || typeof entry.child !== "string" || entry.child === "") {
        fail(`tile "${input.id}" alignUv[${i}] must be { child, factor? }`);
      }
      const factor = entry.factor ?? -1;
      if (factor !== 1 && factor !== -1) fail(`tile "${input.id}" alignUv[${i}].factor must be 1 or -1`);
      return { child: entry.child, factor };
    });
    return {
      id: input.id,
      prefabId: input.prefabId,
      weight,
      offset: [...offset],
      rotations: [...rotations],
      sockets,
      alignUv,
    };
  });

  const boundary = {};
  if (raw.boundary !== undefined) {
    if (!isRecord(raw.boundary)) fail("boundary must be an object");
    for (const [direction, socket] of Object.entries(raw.boundary)) {
      if (!DIRECTIONS.includes(direction)) fail(`unknown boundary direction "${direction}"`);
      if (typeof socket !== "string" || socket === "") fail(`boundary ${direction} must be a string`);
      boundary[direction] = socket;
    }
  }

  const pins = (raw.pins ?? []).map((pin, index) => {
    if (!isRecord(pin)) fail(`pins[${index}] must be an object`);
    if (
      !Array.isArray(pin.at) ||
      pin.at.length !== 3 ||
      pin.at.some((coordinate) => !Number.isInteger(coordinate) || coordinate < 0)
    ) {
      fail(`pins[${index}].at must contain three non-negative integers`);
    }
    if (typeof pin.tile !== "string" || !seen.has(pin.tile)) {
      fail(`pins[${index}].tile must name a declared tile`);
    }
    if (pin.rotation !== undefined && !ROTATIONS.has(pin.rotation)) {
      fail(`pins[${index}].rotation must be 0, 90, 180, or 270`);
    }
    const tile = tiles.find((candidate) => candidate.id === pin.tile);
    if (pin.rotation !== undefined && !tile.rotations.includes(pin.rotation)) {
      fail(`pins[${index}] requests a rotation not allowed by tile "${pin.tile}"`);
    }
    return { at: [...pin.at], tile: pin.tile, rotation: pin.rotation };
  });

  let adjacency = null;
  if (raw.adjacency !== undefined) {
    if (!isRecord(raw.adjacency)) fail("adjacency must be { horizontal: [[a,b]...], vertical: [[lowerPy, upperNy]...] }");
    const pairs = (list, name) => {
      if (list === undefined) return [];
      if (!Array.isArray(list)) fail(`adjacency.${name} must be an array of [a, b] pairs`);
      return list.map((pair, i) => {
        if (!Array.isArray(pair) || pair.length !== 2 || pair.some((v) => typeof v !== "string" || v === "")) {
          fail(`adjacency.${name}[${i}] must be two non-empty socket strings`);
        }
        return [pair[0], pair[1]];
      });
    };
    adjacency = { horizontal: pairs(raw.adjacency.horizontal, "horizontal"), vertical: pairs(raw.adjacency.vertical, "vertical") };
  }

  let outside;
  if (raw.outside !== undefined) {
    if (typeof raw.outside !== "string" || !seen.has(raw.outside)) fail("outside must name a declared tile");
    outside = raw.outside;
  }

  return { version: 1, name: raw.name, cellSize: [...cellSize], tiles, boundary, pins, adjacency, outside };
}

/**
 * Face compatibility. Without `adjacency` two touching faces must carry the
 * same socket string (the hand-authored model). With it, the LEARNED pairs
 * are the whole rule: horizontal pairs are unordered, vertical pairs are
 * (lower cell's py, upper cell's ny). `direction` is the face of the FIRST
 * socket's cell that touches the second's cell.
 */
export function faceCompatibility(tileset) {
  if (!tileset.adjacency) {
    return (a, _direction, b) => a === b;
  }
  const horizontal = new Set();
  for (const [a, b] of tileset.adjacency.horizontal) {
    horizontal.add(`${a}|${b}`);
    horizontal.add(`${b}|${a}`);
  }
  const vertical = new Set(tileset.adjacency.vertical.map(([lower, upper]) => `${lower}|${upper}`));
  return (a, direction, b) => {
    if (direction === "py") return vertical.has(`${a}|${b}`);
    if (direction === "ny") return vertical.has(`${b}|${a}`);
    return horizontal.has(`${a}|${b}`);
  };
}

function directionForVector(x, y, z) {
  return DIRECTIONS.find((direction) => {
    const vector = DELTA[direction];
    return vector[0] === x && vector[1] === y && vector[2] === z;
  });
}

function rotatedSockets(sockets, rotation) {
  const turns = rotation / 90;
  const out = {};
  for (const localDirection of DIRECTIONS) {
    let [x, y, z] = DELTA[localDirection];
    for (let turn = 0; turn < turns; turn++) [x, z] = [z, -x];
    out[directionForVector(x, y, z)] = sockets[localDirection];
  }
  return out;
}

function rotatedOffset(offset, rotation) {
  const radians = (rotation * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    offset[0] * cos + offset[2] * sin,
    offset[1],
    -offset[0] * sin + offset[2] * cos,
  ];
}

function variantsFor(tileset) {
  return tileset.tiles.flatMap((tile) =>
    tile.rotations.map((rotation) => ({
      key: `${tile.id}@${rotation}`,
      tileId: tile.id,
      prefabId: tile.prefabId,
      alignUv: tile.alignUv,
      rotation,
      // Rotation variants split, rather than multiply, a tile's authored weight.
      weight: tile.weight / tile.rotations.length,
      offset: rotatedOffset(tile.offset, rotation),
      sockets: rotatedSockets(tile.sockets, rotation),
    })),
  );
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const flatIndex = (x, y, z, width, depth) => y * width * depth + z * width + x;

function coordinates(index, width, depth) {
  const layer = width * depth;
  const y = Math.floor(index / layer);
  const rest = index - y * layer;
  return [rest % width, y, Math.floor(rest / width)];
}

function isBoundary(x, y, z, width, height, depth, direction) {
  return (
    (direction === "px" && x === width - 1) ||
    (direction === "nx" && x === 0) ||
    (direction === "py" && y === height - 1) ||
    (direction === "ny" && y === 0) ||
    (direction === "pz" && z === depth - 1) ||
    (direction === "nz" && z === 0)
  );
}

function weightedChoice(candidates, variants, random) {
  const total = candidates.reduce((sum, index) => sum + variants[index].weight, 0);
  let cursor = random() * total;
  for (const index of candidates) {
    cursor -= variants[index].weight;
    if (cursor <= 0) return index;
  }
  return candidates[candidates.length - 1];
}

function entropy(candidates, variants) {
  let sum = 0;
  let weightedLog = 0;
  for (const index of candidates) {
    const weight = variants[index].weight;
    sum += weight;
    weightedLog += weight * Math.log(weight);
  }
  return Math.log(sum) - weightedLog / sum;
}

function propagate(cells, queue, variants, width, height, depth, compatible) {
  const queued = new Uint8Array(cells.length);
  for (const index of queue) queued[index] = 1;
  while (queue.length > 0) {
    const index = queue.shift();
    queued[index] = 0;
    const current = cells[index];
    if (current.length === 0) return false;
    const [x, y, z] = coordinates(index, width, depth);
    for (const direction of DIRECTIONS) {
      const [dx, dy, dz] = DELTA[direction];
      const nx = x + dx;
      const ny = y + dy;
      const nz = z + dz;
      if (nx < 0 || nx >= width || ny < 0 || ny >= height || nz < 0 || nz >= depth) continue;
      const neighborIndex = flatIndex(nx, ny, nz, width, depth);
      const allowed = [...new Set(current.map((variant) => variants[variant].sockets[direction]))];
      const opposite = OPPOSITE[direction];
      const before = cells[neighborIndex];
      const after = before.filter((variant) => {
        const socket = variants[variant].sockets[opposite];
        return allowed.some((mine) => compatible(mine, direction, socket));
      });
      if (after.length === before.length) continue;
      if (after.length === 0) return false;
      cells[neighborIndex] = after;
      if (!queued[neighborIndex]) {
        queued[neighborIndex] = 1;
        queue.push(neighborIndex);
      }
    }
  }
  return true;
}

function attempt(tileset, variants, options, attemptIndex, compatible) {
  const { width, height, depth } = options;
  const all = variants.map((_, index) => index);
  const cells = Array.from({ length: width * height * depth }, () => [...all]);
  const initialQueue = [];
  // `outside`: the world beyond the grid is one fixed tile (at rotation 0),
  // so a boundary face must be compatible with that tile's opposite face —
  // the learned-from-example way to say "buildings are enclosed by void".
  const outside = tileset.outside
    ? variants.find((v) => v.tileId === tileset.outside && v.rotation === 0) ?? variants.find((v) => v.tileId === tileset.outside)
    : null;

  for (let index = 0; index < cells.length; index++) {
    const [x, y, z] = coordinates(index, width, depth);
    let candidates = cells[index];
    for (const [direction, socket] of Object.entries(tileset.boundary)) {
      if (isBoundary(x, y, z, width, height, depth, direction)) {
        candidates = candidates.filter((variant) => variants[variant].sockets[direction] === socket);
      }
    }
    if (outside) {
      for (const direction of DIRECTIONS) {
        if (direction in tileset.boundary || !isBoundary(x, y, z, width, height, depth, direction)) continue;
        const theirs = outside.sockets[OPPOSITE[direction]];
        candidates = candidates.filter((variant) => compatible(variants[variant].sockets[direction], direction, theirs));
      }
    }
    if (candidates.length === 0) return null;
    cells[index] = candidates;
    initialQueue.push(index);
  }

  for (const pin of tileset.pins) {
    const [x, y, z] = pin.at;
    if (x >= width || y >= height || z >= depth) {
      throw new Error(`pin [${pin.at.join(", ")}] is outside the ${width}x${height}x${depth} grid`);
    }
    const index = flatIndex(x, y, z, width, depth);
    cells[index] = cells[index].filter((variant) => {
      const candidate = variants[variant];
      return candidate.tileId === pin.tile && (pin.rotation === undefined || candidate.rotation === pin.rotation);
    });
    if (cells[index].length === 0) return null;
    initialQueue.push(index);
  }

  if (!propagate(cells, initialQueue, variants, width, height, depth, compatible)) return null;
  const random = mulberry32((options.seed + Math.imul(attemptIndex, 0x9e3779b9)) >>> 0);

  while (true) {
    let selected = -1;
    let lowest = Infinity;
    for (let index = 0; index < cells.length; index++) {
      if (cells[index].length <= 1) continue;
      const score = entropy(cells[index], variants) + random() * 1e-7;
      if (score < lowest) {
        lowest = score;
        selected = index;
      }
    }
    if (selected === -1) return cells;
    cells[selected] = [weightedChoice(cells[selected], variants, random)];
    if (!propagate(cells, [selected], variants, width, height, depth, compatible)) return null;
  }
}

/** Deterministic weighted 3D simple-tiled WFC with exact socket matching. */
export function collapseTileset(rawTileset, rawOptions) {
  const tileset = parseTileset(rawTileset);
  const options = {
    width: rawOptions.width,
    height: rawOptions.height,
    depth: rawOptions.depth,
    seed: rawOptions.seed >>> 0,
    attempts: rawOptions.attempts,
  };
  for (const key of ["width", "height", "depth", "attempts"]) {
    if (!Number.isInteger(options[key]) || options[key] < 1) throw new Error(`${key} must be a positive integer`);
  }

  const variants = variantsFor(tileset);
  const searchSize = options.width * options.height * options.depth * variants.length;
  if (searchSize > 5_000_000) {
    throw new Error(
      `grid x rotation variants is ${searchSize.toLocaleString()}, above the 5,000,000 candidate safety limit; reduce dimensions or tile rotations`,
    );
  }
  const compatible = faceCompatibility(tileset);
  for (let attemptIndex = 0; attemptIndex < options.attempts; attemptIndex++) {
    const cells = attempt(tileset, variants, options, attemptIndex, compatible);
    if (!cells) continue;
    const collapsed = cells.map((candidates, index) => {
      const [x, y, z] = coordinates(index, options.width, options.depth);
      return { x, y, z, ...variants[candidates[0]] };
    });
    return { tileset, variants, cells: collapsed, attempt: attemptIndex + 1, ...options };
  }
  throw new Error(
    `WFC contradicted on all ${options.attempts} attempt(s); check socket coverage, boundaries, and pins`,
  );
}

function rotationQuat(degrees) {
  const half = (degrees * Math.PI) / 360;
  const value = Math.sin(half);
  const scalar = Math.cos(half);
  return [0, Math.abs(value) < 1e-12 ? 0 : value, 0, Math.abs(scalar) < 1e-12 ? 0 : scalar];
}

/** Convert a collapsed grid to a prefab composed only of nested prefab instances. */
export function collapsedPrefab(result, outputName, origin = "center") {
  if (origin !== "center" && origin !== "min") throw new Error('origin must be "center" or "min"');
  const [sx, sy, sz] = result.tileset.cellSize;
  const offsetX = origin === "center" ? ((result.width - 1) * sx) / 2 : 0;
  const offsetZ = origin === "center" ? ((result.depth - 1) * sz) / 2 : 0;
  const entities = {
    root: {
      name: outputName,
      parent: null,
      tags: ["generated", "wfc-3d"],
      components: { transform: {} },
      locked: false,
    },
  };
  for (const cell of result.cells) {
    if (!cell.prefabId) continue;
    const id = `cell-${cell.x}-${cell.y}-${cell.z}`;
    entities[id] = {
      name: `${cell.tileId} [${cell.x},${cell.y},${cell.z}]`,
      parent: "root",
      tags: ["wfc-cell", `wfc-tile:${cell.tileId}`],
      components: {
        transform: {
          position: [
            cell.x * sx - offsetX + cell.offset[0],
            cell.y * sy + cell.offset[1],
            cell.z * sz - offsetZ + cell.offset[2],
          ],
          rotation: rotationQuat(cell.rotation),
        },
        prefab: {
          prefabId: cell.prefabId,
          ...(cell.rotation !== 0 && cell.alignUv?.length
            ? {
                overrides: cell.alignUv.map((align) => ({
                  path: `${align.child}/components/mesh/source/uvRotation`,
                  value: uvCounterRotation(cell.rotation, align.factor),
                })),
              }
            : {}),
        },
      },
    };
  }
  return { version: 1, name: outputName, root: "root", entities, props: {} };
}

/**
 * The `mesh.source.uvRotation` (degrees, counter-clockwise in UV space —
 * three's rotateUV) that keeps a UV-aligned child's texture running along
 * the building's own axis when its cell is placed at grid variant
 * `rotation`. `factor` is the sign the kit import measured from the part's
 * UV projection: −1 when the projection preserves handedness (u = x, v = z),
 * +1 when it mirrors (u = x, v = −z). Normalised to (−180, 180].
 */
export function uvCounterRotation(rotation, factor = -1) {
  let value = (((factor * rotation) % 360) + 360) % 360;
  if (value > 180) value -= 360;
  return value;
}

function colorFor(value) {
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `hsl(${Math.abs(hash) % 360} 42% 38%)`;
}

/** Lightweight top-down diagnostic preview; actual prefab thumbnails remain in the asset dock. */
export function previewSvg(result) {
  const cell = Math.max(12, Math.min(42, Math.floor(480 / Math.max(result.width, result.depth))));
  const width = result.width * cell;
  const height = result.depth * cell;
  const top = new Map();
  for (const item of result.cells) {
    const key = `${item.x}:${item.z}`;
    const previous = top.get(key);
    if (!previous || item.y > previous.y) top.set(key, item);
  }
  const rects = [...top.values()].map((item) => {
    const x = item.x * cell;
    const y = (result.depth - item.z - 1) * cell;
    const label = item.prefabId ? item.tileId.slice(0, 3) : "·";
    return `<g><rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${colorFor(item.tileId)}" stroke="#30363d"/><text x="${x + cell / 2}" y="${y + cell / 2 + 3}" text-anchor="middle" font-family="monospace" font-size="${Math.max(7, cell * 0.25)}" fill="#e6edf3">${label}</text></g>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#0b0e14"/>${rects}</svg>`;
}

export { DIRECTIONS };
