import {describe,it,expect} from 'vitest';
import {cloudOpeningSchema,skySchema} from '../src/index.js';
describe('world-anchored cloud openings',()=>{
 it('validates finite world coordinates, bounded radius and at most four openings',()=>{
  const opening=cloudOpeningSchema.parse({center:[700,245,-329],radius:32});
  expect(opening.color).toBe('#80d4ff');expect(opening.intensity).toBe(.6);
  expect(skySchema.safeParse({clouds:{openings:[opening]}}).success).toBe(true);
  expect(skySchema.safeParse({clouds:{openings:Array(5).fill(opening)}}).success).toBe(false);
  expect(cloudOpeningSchema.safeParse({...opening,center:[NaN,200,0]}).success).toBe(false);
  expect(cloudOpeningSchema.safeParse({...opening,radius:-1}).success).toBe(false);
 });
 it('preserves legacy sky docs and accepts explicit clearing',()=>{
  expect(skySchema.parse({clouds:{coverage:.8}}).clouds?.openings).toBeUndefined();
  expect(skySchema.parse({clouds:{openings:[]}}).clouds?.openings).toEqual([]);
 });
});
