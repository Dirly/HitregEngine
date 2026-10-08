import test from 'node:test';import assert from 'node:assert/strict';import {checkTriangleTexels,checkGrovePerimeter} from './dressing-checks.mjs';
test('world-scale UVs preserve texels under different triangle sizes',()=>{for(const s of [1,8,47])assert(checkTriangleTexels([[0,0,0],[s,0,0],[0,0,s]],[[0,0],[s/8,0],[0,s/8]],[256,256],1/32).passed)});
test('a stretched axis fails even when another axis has correct scale',()=>{const r=checkTriangleTexels([[0,0,0],[8,0,0],[0,0,32]],[[0,0],[1,0],[0,1]],[256,256],1/32);assert(!r.passed);assert.equal(r.anisotropy,4)});
test('dense clump on one side does not establish a perimeter screen',()=>{assert(!checkGrovePerimeter(Array.from({length:80},(_,i)=>[20+i*.01,0,0]),{center:[0,0],radius:10,outerRadius:40}).passed)});
