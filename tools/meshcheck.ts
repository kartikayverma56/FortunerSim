// Mesh vs physics check for the new roads: builds every near piece (as the browser does, same code) and compares
// random points on the drawn triangles with heightAt() at the same (x, z). Pass: carriageway error < 10 mm.
// Also reports build time per piece, triangle counts, and that every surface triangle faces up.
import { heightAt } from '../src/world/terrain';
import { ROADS } from '../src/world/roads';
import { pieceRanges, buildNearPiece, buildFarMesh } from '../src/world/roadMesh';
import { mulberry } from '../src/world/noise';

const rnd = mulberry(99);
const err: Record<string, number[]> = { carriageway: [], verge: [] };
let worst = { e: 0, x: 0, z: 0 }, down = 0, total = 0, maxMs = 0, sumMs = 0, nPieces = 0, nearTris = 0, maxPieceTris = 0;
for (const r of ROADS) {
  const pcs = pieceRanges(r);
  const far = buildFarMesh(r, pcs);
  console.log(`${r.name}: ${pcs.length} pieces, far mesh ${far.tris} tris`);
  for (const [s0, s1] of pcs) {
    const t0 = performance.now(); const { geo, tris } = buildNearPiece(r, s0, s1); const ms = performance.now() - t0;
    maxMs = Math.max(maxMs, ms); sumMs += ms; nPieces++; nearTris += tris; maxPieceTris = Math.max(maxPieceTris, tris);
    const P = geo.getAttribute('position').array as Float32Array, I = geo.index!.array, G = geo.groups;
    for (const g of G) for (let t = g.start; t < g.start + g.count; t += 3) {
      const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      const ny = uz * vx - ux * vz, area2 = Math.hypot(uy * vz - uz * vy, ny, ux * vy - uy * vx);
      if (Math.abs(ny) < 0.2 * area2) continue; // skirt
      total++; if (ny < 0) down++;
      if (rnd() > 0.04) continue; // sample ~4 % of triangles
      let p = rnd(), q = rnd(); if (p + q > 1) { p = 1 - p; q = 1 - q; }
      const x = P[a] + ux * p + vx * q, z = P[a + 2] + uz * p + vz * q, y = P[a + 1] + uy * p + vy * q;
      const e = Math.abs(y - heightAt(x, z));
      const key = g.materialIndex === 0 ? 'carriageway' : 'verge'; err[key].push(e);
      if (key === 'carriageway' && e > worst.e) worst = { e, x, z };
    }
    geo.dispose();
  }
}
for (const [k, v] of Object.entries(err)) {
  v.sort((p, q) => p - q);
  const rms = Math.sqrt(v.reduce((p, q) => p + q * q, 0) / v.length);
  console.log(`${k.padEnd(11)} samples ${v.length}  RMS ${(rms * 1000).toFixed(2)} mm  p99 ${(v[Math.floor(v.length * 0.99)] * 1000).toFixed(2)} mm  p99.9 ${(v[Math.floor(v.length * 0.999)] * 1000).toFixed(2)} mm  max ${(v[v.length - 1] * 1000).toFixed(2)} mm  share > 10 mm ${(100 * v.filter(e => e > 0.01).length / v.length).toFixed(3)} %`);
}
console.log(`worst carriageway point (${worst.x.toFixed(2)}, ${worst.z.toFixed(2)}) ${(worst.e * 1000).toFixed(1)} mm`);
console.log(`triangles facing down: ${down} of ${total}`);
console.log(`near pieces ${nPieces}: ${nearTris} tris in all, max ${maxPieceTris} per piece; build ${(sumMs / nPieces).toFixed(0)} ms mean, ${maxMs.toFixed(0)} ms max per piece (node; the browser spreads it over frames)`);
const v = err.carriageway; console.log(v[Math.floor(v.length * 0.999)] < 0.01 ? 'PASS: carriageway p99.9 < 10 mm' : 'FAIL');
