import {describe,it,expect} from 'vitest';
import {constrainCellQef} from '../src/voxel/dual-contouring.js';

describe('box-constrained cell QEF',()=>{
 it('re-solves on a cell face instead of breaking a diagonal plane by clamping',()=>{
  // Planes x+y=1.5 and x=1.4; unconstrained (1.4,.1,.5).
  const ata=new Float64Array([2,1,0,1,0,0]);
  const atb=new Float64Array([1.4,.5,0]);
  const out=new Float64Array([.9,-.4,0]);
  constrainCellQef(ata,atb,[.5,.5,.5],.1,out);
  expect(out[0]!+.5).toBeCloseTo(1,10);
  expect(out[1]!+.5).toBeCloseTo(.5,10);
  expect(out[2]!+.5).toBeCloseTo(.5,10);
 });
 it('preserves an already feasible rank deficient solution',()=>{
  const out=new Float64Array([.2,.2,0]);
  constrainCellQef(new Float64Array([1,1,0,1,0,0]),new Float64Array([.4,.4,0]),[.5,.5,.5],.1,out);
  expect([...out]).toEqual([.2,.2,0]);
 });
 it('handles corners and singular directions without leaving the cell',()=>{
  const out=new Float64Array([-2,3,0]);
  constrainCellQef(new Float64Array([1,0,0,1,0,0]),new Float64Array([-2,3,0]),[.5,.5,.5],.1,out);
  expect([...out]).toEqual([-.5,.5,0]);
 });
});
