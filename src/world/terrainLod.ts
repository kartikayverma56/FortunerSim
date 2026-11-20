// Terrain distance LOD. Each fine ground mesh is cut into pieces; every piece has its original grid
// ("near", unchanged sample lines) and a coarser twin ("far") that keeps a subset of the same sample
// lines, so far heights are exact heightAt() samples. Lines are dropped only while the surface stays
// within `tol` metres of the full grid, and never at surface / paint / hole borders. A piece shows its
// far twin only beyond the distance where that error is under ~1.5 px, and never closer than near[0].
// Skirts (short vertical curtains) on every piece edge hide the T-junction slivers between pieces.
// Physics never sees any of this: it samples heightAt()/surfaceAt() directly.
import * as THREE from 'three';
import { heightAt, surfaceAt } from './terrain';

export interface LodSpec {
  piece: number;              // target piece size, m (both axes)
  maxStep: [number, number];  // far line spacing cap, m, along [x, z]
  tol: number;                // height error allowed when a sample line is dropped, m
  near: [number, number];     // clamp for the near→far switch distance, m (camera to piece box)
  normalStep: number;         // finite-difference step for far-mesh normals, m
}

const REF_TAN = Math.tan(THREE.MathUtils.degToRad(68) / 2); // cockpit fov, the widest view
const PX = (2 * REF_TAN) / 960;                              // rad per pixel at 960 px tall
const TOL_PX = 1.5;
const HOLE = 255;

const _p = new THREE.Vector3();
/** Shows the near mesh while the camera is close to the piece's box, the far twin otherwise. */
export class TerrainLOD extends THREE.LOD {
  nearMesh: THREE.Mesh; farMesh: THREE.Mesh; box: THREE.Box3; switchDist: number; isFar = false;
  constructor(nearMesh: THREE.Mesh, farMesh: THREE.Mesh, box: THREE.Box3, switchDist: number) {
    super();
    this.nearMesh = nearMesh; this.farMesh = farMesh; this.box = box; this.switchDist = switchDist;
    this.add(nearMesh, farMesh); farMesh.visible = false;
  }
  // called by the renderer for the camera being drawn (the shadow pass reuses that choice)
  update(camera: THREE.Camera) {
    _p.setFromMatrixPosition(camera.matrixWorld);
    let d = this.box.distanceToPoint(_p);
    const pc = camera as THREE.PerspectiveCamera;
    if (pc.isPerspectiveCamera) d *= Math.tan(THREE.MathUtils.degToRad(pc.fov) / 2) / REF_TAN / pc.zoom; // narrow fov = closer
    const far = d > this.switchDist * (this.isFar ? 0.92 : 1); // small hysteresis
    if (far !== this.isFar) { this.isFar = far; this.nearMesh.visible = !far; this.farMesh.visible = far; }
  }
}

interface Field { xs: number[]; zs: number[]; nx: number; nz: number; P: Float32Array; N: Float32Array; C: Uint8Array; names: string[] }

function makeField(xs: number[], zs: number[], keep?: (cx: number, cz: number) => boolean, surfOf?: (cx: number, cz: number) => string, hFn: (x: number, z: number) => number = heightAt): Field {
  const nx = xs.length, nz = zs.length;
  const P = new Float32Array(nx * nz * 3);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) { const k = (j * nx + i) * 3; P[k] = xs[i]; P[k + 1] = hFn(xs[i], zs[j]); P[k + 2] = zs[j]; }
  const names: string[] = [], ids = new Map<string, number>();
  const C = new Uint8Array((nx - 1) * (nz - 1));
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
    if (keep && !keep(cx, cz)) { C[j * (nx - 1) + i] = HOLE; continue; }
    const s = surfOf ? surfOf(cx, cz) : surfaceAt(cx, cz);
    let id = ids.get(s); if (id === undefined) { id = names.length; ids.set(s, id); names.push(s); }
    C[j * (nx - 1) + i] = id;
  }
  // area-weighted vertex normals over the whole region (as computeVertexNormals would), so pieces have no seams
  const N = new Float32Array(P.length);
  const add = (a: number, b: number, c: number) => { // face (a, b, c): n = (c - b) × (a - b)
    a *= 3; b *= 3; c *= 3;
    const ux = P[c] - P[b], uy = P[c + 1] - P[b + 1], uz = P[c + 2] - P[b + 2], vx = P[a] - P[b], vy = P[a + 1] - P[b + 1], vz = P[a + 2] - P[b + 2];
    const nx_ = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz_ = ux * vy - uy * vx;
    for (const k of [a, b, c]) { N[k] += nx_; N[k + 1] += ny; N[k + 2] += nz_; }
  };
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) { const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1; add(a, c, b); add(b, c, d); }
  for (let k = 0; k < N.length; k += 3) { const l = Math.hypot(N[k], N[k + 1], N[k + 2]) || 1; N[k] /= l; N[k + 1] /= l; N[k + 2] /= l; }
  return { xs, zs, nx, nz, P, N, C, names };
}

/** Indices that cut lines `c` into pieces of about `len` metres. */
function splits(c: number[], len: number) {
  const n = c.length, span = c[n - 1] - c[0], k = Math.max(1, Math.round(span / len)), out = [0];
  for (let q = 1; q < k; q++) {
    const t = c[0] + (span * q) / k; let i = out[out.length - 1] + 1;
    while (i < n - 1 && Math.abs(c[i + 1] - t) < Math.abs(c[i] - t)) i++;
    if (i < n - 1 && i > out[out.length - 1]) out.push(i);
  }
  out.push(n - 1); return out;
}

/** Greedy line decimation along one axis of a piece: keep l0 and l1, keep `must` lines, drop the rest while it fits. */
function decimate(F: Field, axis: 'x' | 'z', l0: number, l1: number, r0: number, r1: number, maxStep: number, tol: number) {
  const { P, C, nx } = F, cw = nx - 1;
  const coords = axis === 'x' ? F.xs : F.zs, ls = axis === 'x' ? 1 : nx, rs = axis === 'x' ? nx : 1;
  const must = (l: number) => { // a surface, paint or hole border crosses this line somewhere in the piece
    for (let r = r0; r < r1; r++) {
      const a = axis === 'x' ? C[r * cw + l - 1] : C[(l - 1) * cw + r], b = axis === 'x' ? C[r * cw + l] : C[l * cw + r];
      if (a !== b) return true;
    }
    return false;
  };
  const fits = (a: number, b: number) => {
    const ca = coords[a], w = coords[b] - ca;
    for (let r = r0; r <= r1; r++) {
      const base = r * rs, ha = P[(base + a * ls) * 3 + 1], hb = P[(base + b * ls) * 3 + 1];
      for (let l = a + 1; l < b; l++) if (Math.abs(P[(base + l * ls) * 3 + 1] - ha - ((hb - ha) * (coords[l] - ca)) / w) > tol) return false;
    }
    return true;
  };
  const out = [l0]; let a = l0;
  while (a < l1) {
    let b = a + 1;
    while (b < l1 && !must(b) && coords[b + 1] - coords[a] <= maxStep + 1e-6 && fits(a, b + 1)) b++;
    out.push(b); a = b;
  }
  return out;
}

/** Largest height difference between the full grid and the far twin (same triangle split), over the piece. */
function farError(F: Field, FX: number[], FZ: number[]) {
  const { P, xs, zs, nx } = F, h = (i: number, j: number) => P[(j * nx + i) * 3 + 1];
  let err = 0;
  for (let b = 0; b < FZ.length - 1; b++) for (let a = 0; a < FX.length - 1; a++) {
    const i0 = FX[a], i1 = FX[a + 1], j0 = FZ[b], j1 = FZ[b + 1];
    if (i1 - i0 < 2 && j1 - j0 < 2) continue; // an original cell: exact
    const ha = h(i0, j0), hb = h(i1, j0), hc = h(i0, j1), hd = h(i1, j1), wx = xs[i1] - xs[i0], wz = zs[j1] - zs[j0];
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const u = (xs[i] - xs[i0]) / wx, v = (zs[j] - zs[j0]) / wz;
      const f = u + v <= 1 ? ha + u * (hb - ha) + v * (hc - ha) : hd + (1 - u) * (hc - hd) + (1 - v) * (hb - hd);
      err = Math.max(err, Math.abs(h(i, j) - f));
    }
  }
  return err;
}

/** Geometry for the sub-grid LX × LZ (indices into the field), with per-surface groups and edge skirts. */
function pieceGeometry(F: Field, LX: number[], LZ: number[], farNormals: number, skirt: number, hFn: (x: number, z: number) => number = heightAt) {
  const { P, N, C, nx } = F, cw = nx - 1, mx = LX.length, mz = LZ.length;
  const pos: number[] = [], nor: number[] = [], uv: number[] = [];
  for (let b = 0; b < mz; b++) for (let a = 0; a < mx; a++) {
    const k = (LZ[b] * nx + LX[a]) * 3, x = P[k], y = P[k + 1], z = P[k + 2];
    pos.push(x, y, z); uv.push(x / 6, z / 6);
    if (farNormals > 0) { // smoothed slope at the far mesh's own scale; the same at a shared edge of two pieces
      const e = farNormals, hx = (hFn(x + e, z) - hFn(x - e, z)) / (2 * e), hz = (hFn(x, z + e) - hFn(x, z - e)) / (2 * e), l = Math.hypot(hx, 1, hz);
      nor.push(-hx / l, 1 / l, -hz / l);
    } else nor.push(N[k], N[k + 1], N[k + 2]);
  }
  const v = (a: number, b: number) => b * mx + a;
  const groups = new Map<number, number[]>();
  const tri = (s: number, ...ix: number[]) => { let g = groups.get(s); if (!g) groups.set(s, (g = [])); for (const i of ix) g.push(i); };
  for (let b = 0; b < mz - 1; b++) for (let a = 0; a < mx - 1; a++) {
    const s = C[LZ[b] * cw + LX[a]]; if (s === HOLE) continue;
    tri(s, v(a, b), v(a, b + 1), v(a + 1, b), v(a + 1, b), v(a, b + 1), v(a + 1, b + 1));
  }
  if (skirt > 0) {
    const edge = (tops: number[], surf: number[], ox: number, oz: number) => {
      const bots = tops.map(t => { const id = pos.length / 3; pos.push(pos[t * 3], pos[t * 3 + 1] - skirt, pos[t * 3 + 2]); nor.push(nor[t * 3], nor[t * 3 + 1], nor[t * 3 + 2]); uv.push(uv[t * 2], uv[t * 2 + 1]); return id; });
      for (let k = 0; k < tops.length - 1; k++) {
        if (surf[k] === HOLE) continue;
        const t0 = tops[k], t1 = tops[k + 1], b0 = bots[k], b1 = bots[k + 1];
        const ex = pos[t1 * 3] - pos[t0 * 3], ez = pos[t1 * 3 + 2] - pos[t0 * 3 + 2];
        if (-ez * ox + ex * oz > 0) tri(surf[k], t0, b0, t1, t1, b0, b1); else tri(surf[k], t0, t1, b0, t1, b1, b0); // face outwards
      }
    };
    const ra = [...Array(mx).keys()], rb = [...Array(mz).keys()];
    edge(ra.map(a => v(a, 0)), ra.map(a => C[LZ[0] * cw + LX[a]]), 0, -1);
    edge(ra.map(a => v(a, mz - 1)), ra.map(a => C[LZ[mz - 2] * cw + LX[a]]), 0, 1);
    edge(rb.map(b => v(0, b)), rb.map(b => C[LZ[b] * cw + LX[0]]), -1, 0);
    edge(rb.map(b => v(mx - 1, b)), rb.map(b => C[LZ[b] * cw + LX[mx - 2]]), 1, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  let total = 0; for (const g of groups.values()) total += g.length;
  const idx = pos.length / 3 > 65535 ? new Uint32Array(total) : new Uint16Array(total);
  const order: string[] = []; let off = 0;
  for (const [s, g] of groups) { geo.addGroup(off, g.length, order.length); order.push(F.names[s]); idx.set(g, off); off += g.length; }
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  return { geo, order, tris: total / 3 };
}

export interface LodStats { pieces: number; nearTris: number; farTris: number; maxErr: number }

/**
 * Build a tensor grid on sample lines xs × zs (same as the old buildGrid), cut into LOD pieces.
 * `mats` maps a piece's surface order to its materials. `hFn` (default heightAt) lets the coarse base terrain
 * sink under the new roads' own meshes.
 */
export function buildLodTerrain(xs: number[], zs: number[], spec: LodSpec, mats: (order: string[]) => THREE.Material[],
  keep?: (cx: number, cz: number) => boolean, surfOf?: (cx: number, cz: number) => string,
  hFn: (x: number, z: number) => number = heightAt): { objects: TerrainLOD[]; stats: LodStats } {
  const F = makeField(xs, zs, keep, surfOf, hFn);
  const sx = splits(xs, spec.piece), sz = splits(zs, spec.piece);
  const plans: { NX: number[]; NZ: number[]; FX: number[]; FZ: number[]; err: number }[] = [];
  for (let q = 0; q < sz.length - 1; q++) for (let p = 0; p < sx.length - 1; p++) {
    const i0 = sx[p], i1 = sx[p + 1], j0 = sz[q], j1 = sz[q + 1];
    const FX = decimate(F, 'x', i0, i1, j0, j1, spec.maxStep[0], spec.tol);
    const FZ = decimate(F, 'z', j0, j1, i0, i1, spec.maxStep[1], spec.tol);
    const NX: number[] = [], NZ: number[] = [];
    for (let i = i0; i <= i1; i++) NX.push(i);
    for (let j = j0; j <= j1; j++) NZ.push(j);
    plans.push({ NX, NZ, FX, FZ, err: farError(F, FX, FZ) });
  }
  const maxErr = Math.max(0, ...plans.map(p => p.err));
  // a gap between two pieces is at most the sum of their far errors; this also covers the old seams between zones
  const skirt = Math.max(0.05, 2 * maxErr + 0.03);
  const stats: LodStats = { pieces: plans.length, nearTris: 0, farTris: 0, maxErr };
  const objects = plans.map(pl => {
    const n = pieceGeometry(F, pl.NX, pl.NZ, 0, skirt, hFn), f = pieceGeometry(F, pl.FX, pl.FZ, spec.normalStep, skirt, hFn);
    stats.nearTris += n.tris; stats.farTris += f.tris;
    const nm = new THREE.Mesh(n.geo, mats(n.order)), fm = new THREE.Mesh(f.geo, mats(f.order));
    nm.receiveShadow = fm.receiveShadow = true;
    const dist = THREE.MathUtils.clamp(pl.err / (PX * TOL_PX), spec.near[0], spec.near[1]);
    return new TerrainLOD(nm, fm, n.geo.boundingBox!.clone(), dist);
  });
  return { objects, stats };
}
