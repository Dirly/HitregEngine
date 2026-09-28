#!/bin/sh
# scratch: lake-head mesh probe + world-wide water checks, summary lines only
cd /d/Users/Derek/Desktop/HitRegStudios/Engine/apps/playground
export NODE_OPTIONS=--max-old-space-size=8192
npx tsx tools/_lakehead-mesh.mts | tail -1 &
npx tsx tools/_lake-shore.mts | head -1 &
npx tsx tools/_water-check.mts | grep -E "hanging > 0.3|^pools" &
npx tsx tools/_lake-river-steps.mts | tail -2 &
wait
