import { describe, expect, it } from "vitest";
import { float, normalWorldGeometry, positionWorld, vec3 } from "three/tsl";
import { stableDominantTriplanarWeights, worldTriplanarBasis } from "../src/material-maps.js";

type Value = number | boolean | number[];
// Three's public Node type does not expose the fields of its internal node
// subclasses. Inspect those runtime fields, and reject every unsupported node.
type GraphNode = { type: string; uuid: string; [field: string]: any };

/** Interpret the PRODUCTION TSL graph, not a second implementation of its
 * axis-selection formula. Float32 arithmetic catches threshold roundoff; this
 * does not emulate raster derivatives or replace the in-engine GPU regression. */
function evaluate(root: unknown, inputs = new Map<string, Value>()): Value {
  const memo = new Map<string, Value>();
  const zip = (a: Value, b: Value, fn: (x: number, y: number) => number | boolean): Value => {
    if (Array.isArray(a) || Array.isArray(b)) {
      const count = Array.isArray(a) ? a.length : (b as number[]).length;
      return Array.from({ length: count }, (_, i) => Number(fn(
        Number(Array.isArray(a) ? a[i] : a), Number(Array.isArray(b) ? b[i] : b),
      )));
    }
    return fn(Number(a), Number(b));
  };
  const visit = (raw: unknown): Value => {
    const n = raw as GraphNode;
    if (!n || !n.uuid) throw new Error("Expected an actual TSL node");
    if (inputs.has(n.uuid)) return inputs.get(n.uuid)!;
    if (memo.has(n.uuid)) return memo.get(n.uuid)!;
    let result: Value;
    switch (n.type) {
      case "VarNode": result = visit(n.node); break;
      case "ConstNode":
        result = typeof n.value === "number" ? Math.fround(n.value)
          : typeof n.value === "boolean" ? n.value : n.value.toArray().map(Math.fround);
        break;
      case "SplitNode": {
        const source = visit(n.node) as number[];
        const parts = [...n.components].map(c => source["xyzw".indexOf(c)]!);
        result = parts.length === 1 ? parts[0]! : parts;
        break;
      }
      case "JoinNode": result = n.nodes.flatMap((child: unknown) => visit(child)); break;
      case "ConditionalNode": result = visit(n.condNode) ? visit(n.ifNode) : visit(n.elseNode); break;
      case "OperatorNode": {
        const a = visit(n.aNode), b = visit(n.bNode);
        switch (n.op) {
          case "+": result = zip(a, b, (x, y) => Math.fround(x + y)); break;
          case "-": result = zip(a, b, (x, y) => Math.fround(x - y)); break;
          case "*": result = zip(a, b, (x, y) => Math.fround(x * y)); break;
          case "/": result = zip(a, b, (x, y) => Math.fround(x / y)); break;
          case ">=": result = zip(a, b, (x, y) => x >= y); break;
          case "&&": result = Boolean(a) && Boolean(b); break;
          default: throw new Error(`Unsupported TSL operator ${n.op}`);
        }
        break;
      }
      case "MathNode": {
        const a = visit(n.aNode);
        switch (n.method) {
          case "abs": result = Array.isArray(a) ? a.map(Math.abs) : Math.abs(Number(a)); break;
          case "max": result = zip(a, visit(n.bNode), Math.max); break;
          case "pow": result = zip(a, visit(n.bNode), (x, y) => Math.fround(x ** y)); break;
          case "dot": {
            const b = visit(n.bNode) as number[];
            result = (a as number[]).reduce((sum, x, i) => Math.fround(sum + Math.fround(x * b[i]!)), 0);
            break;
          }
          default: throw new Error(`Unsupported TSL math ${n.method}`);
        }
        break;
      }
      default: throw new Error(`Unsupported TSL node ${n.type}`);
    }
    memo.set(n.uuid, result);
    return result;
  };
  return visit(root);
}

const unit = (n: number[]) => n.map(x => Math.fround(x / Math.hypot(...n)));
const oneHot = (axis: number) => [0, 1, 2].map(i => Number(i === axis));
const signed = (n: number[], mask: number) => n.map((x, i) => x * ((mask & (1 << i)) ? -1 : 1));
const direct = (normal: number[]) => evaluate(stableDominantTriplanarWeights(vec3(...normal as [number, number, number])));
const basisWeights = (normal: number[], dominantAxis: boolean, warp?: ReturnType<typeof vec3>) => {
  const basis = worldTriplanarBasis(float(2), warp, dominantAxis);
  return evaluate(basis.blend, new Map([[normalWorldGeometry.uuid, normal]]));
};

describe("stable dominant triplanar projection — actual TSL graph", () => {
  it.each([[0, 1], [0, 2], [1, 2]])("retains priority across perturbed %i/%i ties and every normal sign", (a, b) => {
    for (const delta of [-1.2e-3, -4e-4, -1e-6, 0, 1e-6, 4e-4, 1.2e-3]) {
      const n = [0, 0, 0]; n[a] = 1; n[b] = 1 + delta;
      for (let mask = 0; mask < 8; mask++) expect(direct(signed(unit(n), mask))).toEqual(oneHot(a));
    }
  });

  it("retains X at perturbed triple ties in all octants", () => {
    for (const n of [[1, 1, 1], [1, 1 + 4e-4, 1 - 4e-4], [1, 1 - 4e-4, 1 + 4e-4]]) {
      for (let mask = 0; mask < 8; mask++) expect(direct(signed(unit(n), mask))).toEqual([1, 0, 0]);
    }
  });

  it("measures the tie band from the global maximum, without chaining pairwise ties", () => {
    // X is close to Y, and Y is close to Z; X is more than 1e-3 from Z.
    const n = unit([1, 1.0015, 1.003]);
    expect(n[2]! - n[0]!).toBeGreaterThan(1e-3);
    expect(n[2]! - n[1]!).toBeLessThan(1e-3);
    for (let mask = 0; mask < 8; mask++) expect(direct(signed(n, mask))).toEqual([0, 1, 0]);
  });

  it("keeps clear winners outside the band, including higher-priority competitors", () => {
    for (let winner = 0; winner < 3; winner++) {
      for (let other = 0; other < 3; other++) {
        if (other === winner) continue;
        for (const excess of [1.6e-3, 4e-3]) {
          const n = [0, 0, 0]; n[winner] = 1 + excess; n[other] = 1;
          for (let mask = 0; mask < 8; mask++) expect(direct(signed(unit(n), mask))).toEqual(oneHot(winner));
        }
      }
      expect(direct(oneHot(winner))).toEqual(oneHot(winner));
    }
  });

  it("produces exactly one nonnegative weight over a varied normal grid", () => {
    for (const x of [-1, -.71, -.01, 0, .01, .71, 1]) {
      for (const y of [-1, -.71, -.01, 0, .01, .71, 1]) {
        for (const z of [-1, -.71, -.01, 0, .01, .71, 1]) {
          if (x === 0 && y === 0 && z === 0) continue;
          const result = direct(unit([x, y, z])) as number[];
          expect(result.every(value => value === 0 || value === 1)).toBe(true);
          expect(result.reduce((sum, value) => sum + value, 0)).toBe(1);
        }
      }
    }
  });

  it("uses the stable graph in the production world basis, unaffected by UV scale or warp", () => {
    for (const [normal, expected] of [
      [unit([1, 0, 1.0004]), [1, 0, 0]],
      [unit([0, 1, 1.0004]), [0, 1, 0]],
      [unit([1, 1.0015, 1.003]), [0, 1, 0]],
      [unit([1, 0, 1.004]), [0, 0, 1]],
    ] as const) {
      for (let mask = 0; mask < 8; mask++) {
        const n = signed(normal, mask);
        expect(basisWeights(n, true)).toEqual(expected);
        expect(basisWeights(n, true, vec3(7, 13, -4))).toEqual(expected);
        const graph = worldTriplanarBasis(float(.25), undefined, true);
        expect(evaluate(graph.blend, new Map([[normalWorldGeometry.uuid, n]]))).toEqual(expected);
      }
    }
  });

  it("leaves ordinary blended triplanar weights unchanged when not opted in", () => {
    expect(basisWeights(unit([1, 0, 1]), false)).toEqual([.5, 0, .5]);
    const unequal = basisWeights(unit([1, 0, 2]), false) as number[];
    expect(unequal[0]).toBeCloseTo(1 / 65, 6);
    expect(unequal[1]).toBe(0);
    expect(unequal[2]).toBeCloseTo(64 / 65, 6);
  });

  it("detects instability when tolerance is removed or narrowed in the actual graph", () => {
    const normal = unit([1, 0, 1.0004]);
    const graph = stableDominantTriplanarWeights(vec3(...normal as [number, number, number]));
    const withoutTolerance = new Map<string, Value>();
    graph.traverse((n: GraphNode) => {
      if (n.type === "ConstNode" && n.value === 1e-3) withoutTolerance.set(n.uuid, 0);
    });
    expect(withoutTolerance.size).toBe(1);
    expect(evaluate(graph)).toEqual([1, 0, 0]);
    // Override an input during evaluation; do not mutate Three's cached nodes.
    expect(evaluate(graph, withoutTolerance)).toEqual([0, 0, 1]);
    expect(evaluate(graph, new Map([...withoutTolerance.keys()].map(id => [id, 1e-4])))).toEqual([0, 0, 1]);
  });

  it("fails closed if the interpreter encounters an unsupported shader input", () => {
    expect(() => evaluate(positionWorld)).toThrow(/Unsupported TSL node/);
  });
});
