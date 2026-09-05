/**
 * Black-and-white PSX-style masks for procedural VFX: rings, arrows, spikes,
 * roots, chains, stars, glyphs — drawn on a coarse grid so they read as
 * pixel art, never as perfect geometry.
 *
 *   node tools/fx.mjs masks <project> [--size 48]
 *
 * Writes assets/textures/fx/masks/<name>.png (white RGB, shape in ALPHA) and
 * prints the catalog entries. A mask is laid across a `ring` module's disc
 * (`texture`), so every one is authored in disc space: centre (0.5, 0.5),
 * radius 0.5. Tags say what a mask MEANS so the generator can pick roots for
 * a root and chevrons for a haste.
 */
import fs from "node:fs";
import path from "node:path";
import { encodePng } from "./_png.mjs";

function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Grid {
  constructor(n) {
    this.n = n;
    this.a = new Uint8Array(n * n);
  }
  set(x, y, v = 1) {
    if (x < 0 || y < 0 || x >= this.n || y >= this.n) return;
    this.a[y * this.n + x] = v;
  }
  /** Normalised disc space (-1..1) → cell. */
  px(u) {
    return Math.floor(((u + 1) / 2) * this.n);
  }
  dot(u, v, r = 0) {
    const cx = this.px(u);
    const cy = this.px(v);
    for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + 0.5) this.set(cx + x, cy + y);
  }
  line(u0, v0, u1, v1, w = 0) {
    const steps = Math.ceil(Math.hypot(u1 - u0, v1 - v0) * this.n);
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 0 : i / steps;
      this.dot(u0 + (u1 - u0) * t, v0 + (v1 - v0) * t, w);
    }
  }
  ring(r, w = 0, dash = 0, gap = 0, phase = 0) {
    const steps = Math.ceil(2 * Math.PI * r * this.n);
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      if (dash > 0 && ((t * (dash + gap) * 100 + phase) % (dash + gap)) >= dash) continue;
      const a = t * Math.PI * 2;
      this.dot(Math.cos(a) * r, Math.sin(a) * r, w);
    }
  }
  poly(points, w = 0) {
    for (let i = 0; i < points.length; i++) {
      const [x0, y0] = points[i];
      const [x1, y1] = points[(i + 1) % points.length];
      this.line(x0, y0, x1, y1, w);
    }
  }
  fillSector(a0, a1, r0, r1) {
    for (let y = 0; y < this.n; y++) {
      for (let x = 0; x < this.n; x++) {
        const u = ((x + 0.5) / this.n) * 2 - 1;
        const v = ((y + 0.5) / this.n) * 2 - 1;
        const r = Math.hypot(u, v);
        if (r < r0 || r > r1) continue;
        let a = Math.atan2(v, u);
        if (a < a0) a += Math.PI * 2;
        if (a >= a0 && a <= a1) this.set(x, y);
      }
    }
  }
  /** Rotate a drawing function around the centre `k` times. */
  radial(k, draw, offset = 0) {
    for (let i = 0; i < k; i++) {
      const a = offset + (i / k) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      draw((u, v) => [u * c - v * s, u * s + v * c], i, a);
    }
  }
  toPng() {
    const out = new Uint8Array(this.n * this.n * 4);
    for (let i = 0; i < this.a.length; i++) {
      out[i * 4] = 255;
      out[i * 4 + 1] = 255;
      out[i * 4 + 2] = 255;
      out[i * 4 + 3] = this.a[i] ? 255 : 0;
    }
    return encodePng(this.n, this.n, out);
  }
}

/** name → { tags, draw(grid, rng) } */
export const MASKS = {
  "ring-dashed": {
    tags: ["ring", "generic"],
    draw: (g) => {
      g.ring(0.92, 1, 6, 3);
      g.ring(0.7, 0, 3, 5, 2);
    },
  },
  "ring-runic": {
    tags: ["ring", "rune", "arcane", "generic"],
    draw: (g, rng) => {
      g.ring(0.95, 0);
      g.ring(0.62, 0);
      g.radial(12, (rot, i) => {
        // a glyph stroke between the two rings
        const a = 0.66 + rng() * 0.1;
        const b = 0.9;
        const pts = [[a, 0], [b, 0]];
        if (rng() < 0.6) pts.push([(a + b) / 2, (rng() < 0.5 ? 1 : -1) * 0.06]);
        for (let k = 0; k < pts.length - 1; k++) {
          const p0 = rot(pts[k][0], pts[k][1]);
          const p1 = rot(pts[k + 1][0], pts[k + 1][1]);
          g.line(p0[0], p0[1], p1[0], p1[1]);
        }
      });
    },
  },
  "arrows-out": {
    tags: ["arrow", "haste", "shout", "repel"],
    draw: (g) => {
      g.radial(8, (rot) => {
        const tip = rot(0.92, 0);
        const l = rot(0.7, 0.14);
        const r = rot(0.7, -0.14);
        const tail = rot(0.5, 0);
        g.line(l[0], l[1], tip[0], tip[1], 1);
        g.line(r[0], r[1], tip[0], tip[1], 1);
        g.line(tail[0], tail[1], tip[0], tip[1], 0);
      });
    },
  },
  "arrows-in": {
    tags: ["arrow", "slow", "root", "pull", "gather"],
    draw: (g) => {
      g.radial(8, (rot) => {
        const tip = rot(0.45, 0);
        const l = rot(0.7, 0.16);
        const r = rot(0.7, -0.16);
        const tail = rot(0.95, 0);
        g.line(l[0], l[1], tip[0], tip[1], 1);
        g.line(r[0], r[1], tip[0], tip[1], 1);
        g.line(tail[0], tail[1], tip[0], tip[1], 0);
      });
    },
  },
  "spikes": {
    tags: ["spike", "earth", "ice", "root", "damage"],
    draw: (g) => {
      g.ring(0.6, 1);
      g.radial(10, (rot) => {
        const tip = rot(0.98, 0);
        const l = rot(0.58, 0.14);
        const r = rot(0.58, -0.14);
        g.poly([l, tip, r], 0);
        g.line(rot(0.6, 0)[0], rot(0.6, 0)[1], tip[0], tip[1], 1);
      });
    },
  },
  "roots": {
    tags: ["root", "nature", "vine", "hold"],
    draw: (g, rng) => {
      g.dot(0, 0, 3);
      const branch = (u, v, a, len, w, depth) => {
        const steps = 6;
        let x = u;
        let y = v;
        for (let i = 0; i < steps; i++) {
          a += (rng() - 0.5) * 0.9;
          const nx = x + Math.cos(a) * (len / steps);
          const ny = y + Math.sin(a) * (len / steps);
          g.line(x, y, nx, ny, w);
          x = nx;
          y = ny;
          if (depth > 0 && rng() < 0.45) branch(x, y, a + (rng() < 0.5 ? 0.9 : -0.9), len * 0.5, Math.max(0, w - 1), depth - 1);
        }
      };
      for (let i = 0; i < 7; i++) branch(0, 0, (i / 7) * Math.PI * 2 + rng() * 0.4, 0.85 + rng() * 0.12, 1, 2);
    },
  },
  "chains": {
    tags: ["chain", "root", "stun", "hold", "void"],
    draw: (g) => {
      const links = 14;
      for (let i = 0; i < links; i++) {
        const a0 = (i / links) * Math.PI * 2;
        const a1 = ((i + 0.75) / links) * Math.PI * 2;
        const r = 0.82 + (i % 2) * 0.06;
        const pts = [];
        for (let k = 0; k <= 8; k++) {
          const a = a0 + (a1 - a0) * (k / 8);
          pts.push([Math.cos(a) * (r + 0.05 * Math.sin((k / 8) * Math.PI)), Math.sin(a) * (r + 0.05 * Math.sin((k / 8) * Math.PI))]);
        }
        for (let k = 0; k <= 8; k++) {
          const a = a0 + (a1 - a0) * (k / 8);
          pts.push([Math.cos(a) * (r - 0.05 * Math.sin((k / 8) * Math.PI)), Math.sin(a) * (r - 0.05 * Math.sin((k / 8) * Math.PI))]);
        }
        g.poly(pts, 0);
      }
    },
  },
  "stars": {
    tags: ["star", "stun", "holy", "daze"],
    draw: (g) => {
      g.radial(5, (rot) => {
        const c = rot(0.62, 0);
        const pts = [];
        for (let k = 0; k < 10; k++) {
          const a = (k / 10) * Math.PI * 2;
          const rr = k % 2 === 0 ? 0.22 : 0.09;
          pts.push([c[0] + Math.cos(a) * rr, c[1] + Math.sin(a) * rr]);
        }
        g.poly(pts, 0);
      });
    },
  },
  "hourglass": {
    tags: ["slow", "time", "hourglass", "arcane"],
    draw: (g) => {
      g.ring(0.95, 0, 2, 2);
      g.poly([[-0.3, -0.5], [0.3, -0.5], [-0.3, 0.5], [0.3, 0.5]], 1);
      g.line(-0.3, -0.5, 0.3, -0.5, 1);
      g.line(-0.3, 0.5, 0.3, 0.5, 1);
      g.fillSector(0, Math.PI * 2, 0, 0.08);
    },
  },
  "chevrons": {
    tags: ["haste", "speed", "chevron", "storm"],
    draw: (g) => {
      for (let i = 0; i < 4; i++) {
        const y = -0.7 + i * 0.42;
        g.line(-0.55, y + 0.25, 0, y, 1);
        g.line(0, y, 0.55, y + 0.25, 1);
      }
    },
  },
  "hex-shield": {
    tags: ["shield", "ward", "hex", "holy", "arcane"],
    draw: (g) => {
      const hex = (r) => {
        const pts = [];
        for (let k = 0; k < 6; k++) pts.push([Math.cos((k / 6) * Math.PI * 2 + Math.PI / 6) * r, Math.sin((k / 6) * Math.PI * 2 + Math.PI / 6) * r]);
        return pts;
      };
      g.poly(hex(0.95), 1);
      g.poly(hex(0.55), 0);
      g.radial(6, (rot) => {
        const a = rot(0.55, 0);
        const b = rot(0.95, 0);
        g.line(a[0], a[1], b[0], b[1], 0);
      }, Math.PI / 6);
    },
  },
  "cross-heal": {
    tags: ["heal", "holy", "cross", "mend"],
    draw: (g) => {
      g.ring(0.9, 0, 4, 2);
      g.fillSector(0, Math.PI * 2, 0, 0.001);
      for (let i = -1; i <= 1; i++) {
        g.line(-0.55, i * 0.12, 0.55, i * 0.12, 0);
        g.line(i * 0.12, -0.55, i * 0.12, 0.55, 0);
      }
    },
  },
  "wedge": {
    tags: ["wedge", "cone", "melee", "breath"],
    draw: (g) => {
      // points to disc +Y (image top), which the ring renderer yaws onto the spell direction
      g.fillSector(-Math.PI / 2 - Math.PI / 5, -Math.PI / 2 + Math.PI / 5, 0.15, 0.95);
    },
  },
  "crescent": {
    tags: ["slash", "melee", "crescent", "blood"],
    draw: (g) => {
      for (let k = 0; k <= 60; k++) {
        const a = -Math.PI * 0.6 + (k / 60) * Math.PI * 1.2;
        const w = Math.round(2 * Math.sin((k / 60) * Math.PI));
        g.dot(Math.cos(a) * 0.8, Math.sin(a) * 0.8, w);
      }
    },
  },
  "eye": {
    tags: ["eye", "debuff", "void", "shadow", "mark"],
    draw: (g) => {
      const pts = [];
      for (let k = 0; k <= 24; k++) {
        const t = -1 + (k / 24) * 2;
        pts.push([t * 0.9, Math.sqrt(Math.max(0, 1 - t * t)) * 0.45]);
      }
      for (let k = 24; k >= 0; k--) {
        const t = -1 + (k / 24) * 2;
        pts.push([t * 0.9, -Math.sqrt(Math.max(0, 1 - t * t)) * 0.45]);
      }
      g.poly(pts, 0);
      g.fillSector(0, Math.PI * 2, 0, 0.22);
    },
  },
  "drips": {
    tags: ["drip", "slow", "blood", "poison", "nature"],
    draw: (g, rng) => {
      g.ring(0.9, 0);
      g.radial(9, (rot) => {
        const len = 0.18 + rng() * 0.25;
        const a = rot(0.88, 0);
        const b = rot(0.88 - len, 0);
        g.line(a[0], a[1], b[0], b[1], 0);
        g.dot(b[0], b[1], 1);
      });
    },
  },
  "burst": {
    tags: ["burst", "impact", "fire", "generic"],
    draw: (g, rng) => {
      g.dot(0, 0, 4);
      g.radial(14, (rot) => {
        const len = 0.5 + rng() * 0.45;
        const a = rot(0.2, 0);
        const b = rot(len, 0);
        g.line(a[0], a[1], b[0], b[1], rng() < 0.4 ? 1 : 0);
      });
    },
  },
  "triangles-in": {
    tags: ["pull", "root", "gather", "void"],
    draw: (g) => {
      g.radial(6, (rot) => {
        g.poly([rot(0.95, -0.2), rot(0.95, 0.2), rot(0.55, 0)], 0);
      });
      g.ring(0.4, 0, 2, 2);
    },
  },
  "bolts-ring": {
    tags: ["storm", "lightning", "shock", "stun"],
    draw: (g, rng) => {
      g.radial(6, (rot) => {
        let x = 0.35;
        let y = 0;
        for (let k = 0; k < 4; k++) {
          const nx = x + 0.15;
          const ny = (k % 2 === 0 ? 1 : -1) * (0.08 + rng() * 0.05);
          const a = rot(x, y);
          const b = rot(nx, ny);
          g.line(a[0], a[1], b[0], b[1], 0);
          x = nx;
          y = ny;
        }
      });
    },
  },
};

export function cmdMasks(project, size = 48) {
  if (!project) throw new Error("usage: fx.mjs masks <project> [--size 48]");
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
  const dir = path.join(root, "projects", project, "assets", "textures", "fx", "masks");
  fs.mkdirSync(dir, { recursive: true });
  const entries = [];
  for (const [name, m] of Object.entries(MASKS)) {
    const g = new Grid(size);
    m.draw(g, seeded(name.length * 7919 + 3));
    fs.writeFileSync(path.join(dir, `${name}.png`), g.toPng());
    entries.push({ texture: `fx/masks/${name}.png`, tags: m.tags });
    console.log(`  ${name}  [${m.tags.join(", ")}]`);
  }
  console.log(`wrote ${entries.length} masks to ${path.relative(root, dir)}`);
  console.log("catalog masks:", JSON.stringify(entries));
}
