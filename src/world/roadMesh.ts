// Meshing of the new roads (roads.ts). Geometry only (no DOM): materials are made in worldMesh.ts.
// * Pieces of ~40 m along s. A piece's near mesh is a set of tensor sub-grids in (s, d): the base sample lines
//   (0.5 m along, 0.5 m across the carriageway, 0.07 m across the tarmac edge band, coarser on the verge) plus,
//   only where a feature lies, the feature's own fine lines (roadFeatures.meshLines). Every vertex height is
//   heightAt(), so mesh and physics agree at the vertices; tools/meshcheck.ts measures the error in between.
// * Near meshes are built lazily, a few milliseconds per frame, for pieces within ~80 m of the camera and
//   dropped beyond ~140 m. Far: one merged ribbon mesh per road (2 m along, ~20 columns), whose draw groups
//   skip the pieces currently drawn near, so the road costs 2–4 far draws + 2 per near piece.
// * Cells owned by another road (roads.roadOwner) are skipped, so the junction has no overlapping surfaces.
import * as THREE from 'three';
import { heightAt } from './terrain';
import { CLASSES, meshHalf, roadOwner, type Road } from './roads';
import { meshLines, type RoadFeature } from './roadFeatures';
import { vnoise, fbm, smooth } from './noise';

export const ROAD_TEX_MEAN = 0.51;   // linear mean of the neutral textures made in worldMesh.ts (road #bdbdbd, verge #c8c8c8)
export const VERGE_TEX_MEAN = 0.58;
const RAMP = 0.2;
type HFn = (x: number, z: number) => number;
/** Deadline for the current build slice (RoadLod sets it; synchronous builds leave it at Infinity). */
const SLICE = { end: Infinity };

// ---------------- colours (sRGB hex → linear multipliers over the neutral textures) ----------------
const lin = (hex: number, mean: number): [number, number, number] => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255].map(c => Math.pow(c, 2.2) / mean) as [number, number, number];
const ROADC: Record<string, [number, number, number]> = {
  apron: lin(0x4c4d50, ROAD_TEX_MEAN), join: lin(0x4c4d50, ROAD_TEX_MEAN), link: lin(0x4d4e51, ROAD_TEX_MEAN), sh: lin(0x48494c, ROAD_TEX_MEAN),
  district: lin(0x5b5852, ROAD_TEX_MEAN), village: lin(0x535356, ROAD_TEX_MEAN),
};
const DUST = lin(0x8d7c64, ROAD_TEX_MEAN);
const TINT: [number, number, number][] = [ // by RoadFeature.tint
  [1, 1, 1], lin(0x3b3329, ROAD_TEX_MEAN), lin(0x2c2d2f, ROAD_TEX_MEAN), lin(0x606062, ROAD_TEX_MEAN), lin(0x333436, ROAD_TEX_MEAN), lin(0x3a3532, ROAD_TEX_MEAN), lin(0x6a6a6c, ROAD_TEX_MEAN),
];
const EARTH = lin(0x9a8262, VERGE_TEX_MEAN), DITCH = lin(0x5e5a3c, VERGE_TEX_MEAN), FRONT = lin(0xa48d6c, VERGE_TEX_MEAN), WEED = lin(0x7a8048, VERGE_TEX_MEAN), GRASS = lin(0x617340, VERGE_TEX_MEAN);
const mix3 = (a: number[], b: number[], t: number, o: number[]) => { o[0] = a[0] + (b[0] - a[0]) * t; o[1] = a[1] + (b[1] - a[1]) * t; o[2] = a[2] + (b[2] - a[2]) * t; return o; };

/** Vertex colour at (s, d): worn asphalt with darker wheel paths and dusty edges, feature tints, earth verge fading to grass. */
export function colourAt(r: Road, s: number, d: number, o: number[]) {
  const sec = r.sectionAt(s), c = CLASSES[sec.cls], ad = Math.abs(d), e = r.edge(s, d);
  if (ad <= e + 0.02) {
    const base = ROADC[sec.cls];
    let v = 1 + 0.12 * fbm(s * 0.04, d * 0.25 + 3, 2) + 0.06 * vnoise(s * 0.8, d * 2.3);
    const lc = r.hw(s) / 2;
    for (const p of [lc - 0.77, lc + 0.77, -lc + 0.77, -lc - 0.77]) { const q = (d - p) / 0.35; v *= 1 - 0.10 * Math.exp(-q * q); }
    { const q = (ad - lc) / 0.35; v *= 1 - 0.07 * Math.exp(-q * q); } // oil drip line mid-lane
    o[0] = base[0] * v; o[1] = base[1] * v; o[2] = base[2] * v;
    mix3(o, DUST, 0.5 * smooth(e - 0.7, e, ad) * (0.7 + 0.3 * vnoise(s * 0.3, 7)), o);
    const f: RoadFeature | null = r.feats.top(s, d);
    if (f && f.tint) { const t = TINT[f.tint]; if (f.kind === 'rumble') { o[0] *= 1.25; o[1] *= 1.25; o[2] *= 1.25; } else mix3(o, t, f.kind === 'patch' ? 0.85 : 0.9, o); }
    return o;
  }
  const hw = r.hw(s), so = hw + r.field(s, 2), dw = r.field(s, 10), outer = r.coreHalf(s), bl = r.blendW(s);
  const n = fbm(s * 0.21 + d * 0.13, d * 0.21 - s * 0.13 + 21, 3), n2 = vnoise(s * 1.7 + d * 0.9, d * 1.7 - s * 0.9 + 5); // rotated: no axis-aligned blocks
  mix3(EARTH, DUST, 0.3 + 0.2 * n2, o);
  if (dw > 0.05 && ad > so) { const t = (ad - so) / dw; if (t < 1) mix3(o, DITCH, Math.sin(Math.PI * t) * 0.8, o); }
  if (c.front > 3 && ad > so) { mix3(o, FRONT, 0.6, o); mix3(o, WEED, Math.max(0, n - 0.15) * 1.2, o); }
  else if (ad > so) mix3(o, WEED, 0.35 + 0.3 * n, o);
  mix3(o, GRASS, smooth(outer, outer + bl * 0.7, ad), o);
  const k = 0.9 + 0.12 * n2; o[0] *= k; o[1] *= k; o[2] *= k;
  return o;
}

// ---------------- sample lines ----------------
function lines(parts: [number, number, number][], lo: number, hi: number): number[] {
  // union of the ranges' lines; range ends are kept (kinks), other lines closer than 0.45 × the finest local step are dropped
  const v: { x: number; m: boolean }[] = [];
  for (const [a, b, st] of parts) {
    const A = Math.max(a, lo), B = Math.min(b, hi); if (B < A - 1e-9) continue;
    const n = Math.max(1, Math.ceil((B - A) / st - 1e-9));
    for (let k = 0; k <= n; k++) v.push({ x: A + ((B - A) * k) / n, m: k === 0 || k === n });
  }
  v.sort((p, q) => p.x - q.x || (q.m ? 1 : 0) - (p.m ? 1 : 0));
  const stepAt = (x: number) => { let m = Infinity; for (const [a, b, st] of parts) if (x >= a - 1e-9 && x <= b + 1e-9 && st < m) m = st; return m === Infinity ? 1 : m; };
  const must = v.filter(p => p.m).map(p => p.x);
  const out: number[] = []; let mi = 0;
  for (const p of v) {
    const last = out.length ? out[out.length - 1] : -Infinity;
    if (p.x - last < 0.002) continue;
    if (!p.m) {
      while (mi < must.length && must[mi] < p.x - 1e-9) mi++;
      const lim = 0.45 * stepAt(p.x);
      if (p.x - last < lim || (mi < must.length && must[mi] - p.x < lim)) continue;
    }
    out.push(p.x);
  }
  return out;
}
const sameSet = (a: RoadFeature[], b: RoadFeature[]) => a.length === b.length && a.every((f, i) => f === b[i]);

/** Piece boundaries along s (~80 m, moved off features), including the end blends. */
export function pieceRanges(r: Road, len = 40): [number, number][] {
  const a = r.sMin - r.endBlend[0], b = r.sMax + r.endBlend[1], n = Math.max(1, Math.round((b - a) / len));
  const cuts = [a];
  for (let k = 1; k < n; k++) {
    let s = a + ((b - a) * k) / n;
    for (let guard = 0; guard < 50 && r.feats.at(s).some(f => s > f.s0 - 0.2 && s < f.s1 + 0.2); guard++) s += 0.5;
    cuts.push(s);
  }
  cuts.push(b);
  return cuts.slice(0, -1).map((c, i) => [c, cuts[i + 1]]);
}

interface Acc { pos: number[]; nor: number[]; uv: number[]; col: number[]; idx: [number[], number[]] }
const newAcc = (): Acc => ({ pos: [], nor: [], uv: [], col: [], idx: [[], []] });

/** Base d-lines of a piece from the cross-section's extremes over [s0, s1]. */
function baseDLines(r: Road, s0: number, s1: number) {
  let mh = 0, hwMin = Infinity, soMin = Infinity, soMax = 0, dwMax = 0, outMin = Infinity, outMax = 0;
  const eMin = [Infinity, Infinity], eMax = [0, 0];
  for (let s = s0; s <= s1 + 0.25; s += 0.25) {
    const sc = Math.min(r.sMax, Math.max(r.sMin, Math.min(s, s1))), hw = r.hw(sc), so = hw + r.field(sc, 2), dw = r.field(sc, 10), outer = r.coreHalf(sc);
    mh = Math.max(mh, meshHalf(r, sc)); hwMin = Math.min(hwMin, hw); soMin = Math.min(soMin, so); soMax = Math.max(soMax, so); dwMax = Math.max(dwMax, dw); outMin = Math.min(outMin, outer); outMax = Math.max(outMax, outer);
    for (const k of [0, 1]) { const e = r.edge(sc, k === 0 ? 1 : -1); eMin[k] = Math.min(eMin[k], e); eMax[k] = Math.max(eMax[k], e); }
  }
  const parts: [number, number, number][] = [];
  for (const k of [0, 1]) {
    const P = (a: number, b: number, st: number) => { if (b > a) parts.push(k === 0 ? [a, b, st] : [-b, -a, st]); };
    const bandA = eMin[k] - 0.08, bandB = eMax[k] + RAMP + 0.08;
    P(0, bandA, 0.5); P(bandA, bandB, 0.07); P(bandB, Math.max(bandB, soMax), 0.35);
    if (dwMax > 0.05) P(Math.max(bandB, soMin), soMax + dwMax, 0.3);
    const fa = Math.max(bandB, soMax + dwMax);
    P(fa, outMax, outMax - fa > 6 ? 2 : 1); P(Math.max(fa, outMin), mh, 1.5);
  }
  return { parts, mh };
}

/**
 * Builds one near piece. A generator: yields after every sub-grid so the caller can spread the work over frames.
 * Groups: 0 = carriageway (road material), 1 = shoulder/verge.
 */
export function* nearPieceJob(r: Road, s0: number, s1: number, hFn: HFn = heightAt, out: { geo?: THREE.BufferGeometry; tris?: number } = {}) {
  const feats = r.feats.list.filter(f => f.s1 > s0 && f.s0 < s1);
  const sParts: [number, number, number][] = [[s0, s1, 0.5]];
  for (const f of feats) sParts.push(...meshLines(f).s);
  const S = lines(sParts, s0, s1);
  const acc = newAcc();
  const flip = false; // both roads map (s, d) to the world by a rotation, so one winding fits both
  let firstRow: number[] | null = null, lastRow: number[] = [], firstGroups: number[] = [], lastGroups: number[] = [];
  // group consecutive s-intervals with the same active features
  let j = 0;
  while (j < S.length - 1) {
    const act = (a: number, b: number) => feats.filter(f => f.s1 > a && f.s0 < b);
    const set = act(S[j], S[j + 1]); let k = j + 1;
    // a sub-grid is at most ~10 m long, so the base lines follow the cross-section where it changes (section transitions)
    while (k < S.length - 1 && sameSet(act(S[k], S[k + 1]), set) && (S[k] - S[j] < 10 || set.length > 0)) k++;
    const rows = S.slice(j, k + 1);
    const { parts: dBase, mh } = baseDLines(r, rows[0], rows[rows.length - 1]);
    const dParts = dBase.slice(); for (const f of set) dParts.push(...meshLines(f).d);
    const D = lines(dParts, -mh, mh);
    const nx = D.length, ny = rows.length, v0 = acc.pos.length / 3;
    const H = new Float64Array(nx * ny);
    for (let b = 0; b < ny; b++) { for (let a = 0; a < nx; a++) H[b * nx + a] = hFn(r.toX(rows[b], D[a]), r.toZ(rows[b], D[a])); if (performance.now() > SLICE.end) yield; } // row-sized slices: no frame hitch
    const col = [0, 0, 0];
    for (let b = 0; b < ny; b++) {
      if (performance.now() > SLICE.end) yield;
      const s = rows[b];
      for (let a = 0; a < nx; a++) {
        const d = D[a], x = r.toX(s, d), z = r.toZ(s, d), h = H[b * nx + a];
        let hs: number, hd: number;
        if (b > 0 && b < ny - 1) hs = (H[(b + 1) * nx + a] - H[(b - 1) * nx + a]) / (rows[b + 1] - rows[b - 1]);
        else hs = (hFn(r.toX(s + 0.03, d), r.toZ(s + 0.03, d)) - hFn(r.toX(s - 0.03, d), r.toZ(s - 0.03, d))) / 0.06; // sub-grid edge: same normal on both sides
        if (a > 0 && a < nx - 1) hd = (H[b * nx + a + 1] - H[b * nx + a - 1]) / (D[a + 1] - D[a - 1]);
        else hd = a === 0 ? (H[b * nx + 1] - h) / (D[1] - d) : (h - H[b * nx + a - 1]) / (d - D[a - 1]);
        // world gradient: axis z → (∂/∂x, ∂/∂z) = (hd, hs); axis x → (hs, −hd)
        const gx = r.axis === 'z' ? hd : hs, gz = r.axis === 'z' ? hs : -hd, l = Math.hypot(gx, 1, gz);
        acc.pos.push(x, h, z); acc.nor.push(-gx / l, 1 / l, -gz / l); acc.uv.push(x / 4, z / 4);
        colourAt(r, Math.min(r.sMax, Math.max(r.sMin, s)), d, col); acc.col.push(col[0], col[1], col[2]);
      }
    }
    const groups: number[] = [];
    for (let b = 0; b < ny - 1; b++) for (let a = 0; a < nx - 1; a++) {
      if (a === 0 && performance.now() > SLICE.end) yield;
      const sc = (rows[b] + rows[b + 1]) / 2, dc = (D[a] + D[a + 1]) / 2;
      let g = -1;
      if (roadOwner(r.toX(sc, dc), r.toZ(sc, dc)) === r) {
        const scl = Math.min(r.sMax, Math.max(r.sMin, sc));
        g = Math.abs(dc) <= r.edge(scl, dc) + 0.02 && sc >= r.sMin && sc <= r.sMax ? 0 : 1;
        const p = v0 + b * nx + a, q = p + 1, u = p + nx, w = u + 1;
        if (!flip) acc.idx[g].push(p, u, q, q, u, w); else acc.idx[g].push(p, q, u, q, w, u);
      }
      if (b === 0) groups.push(g);
      if (b === ny - 2) lastGroups[a] = g;
    }
    if (!firstRow) { firstRow = D.map((_, a) => v0 + a); firstGroups = groups.slice(0, nx - 1); }
    lastRow = D.map((_, a) => v0 + (ny - 1) * nx + a); lastGroups = lastGroups.slice(0, nx - 1);
    j = k;
    yield;
  }
  // skirts (0.3 m curtains) at both piece ends hide cracks against the neighbour's far mesh
  const skirt = (row: number[], gs: number[]) => {
    const bots = row.map(t => { const id = acc.pos.length / 3; acc.pos.push(acc.pos[t * 3], acc.pos[t * 3 + 1] - 0.3, acc.pos[t * 3 + 2]); acc.nor.push(acc.nor[t * 3], acc.nor[t * 3 + 1], acc.nor[t * 3 + 2]); acc.uv.push(acc.uv[t * 2], acc.uv[t * 2 + 1] + 0.075); acc.col.push(acc.col[t * 3] * 0.7, acc.col[t * 3 + 1] * 0.7, acc.col[t * 3 + 2] * 0.7); return id; });
    for (let a = 0; a < row.length - 1; a++) {
      const g = gs[a]; if (g < 0) continue;
      const t0 = row[a], t1 = row[a + 1], b0 = bots[a], b1 = bots[a + 1];
      acc.idx[g].push(t0, t1, b0, t1, b1, b0, t0, b0, t1, t1, b0, b1); // both faces: cheap, and no winding bookkeeping
    }
  };
  if (firstRow) { skirt(firstRow, firstGroups); skirt(lastRow, lastGroups); }
  yield; // the typed-array copy below gets a slice of its own
  out.geo = toGeometry(acc); out.tris = (acc.idx[0].length + acc.idx[1].length) / 3;
  return out;
}
/** Synchronous build (tools and first frames). */
export function buildNearPiece(r: Road, s0: number, s1: number, hFn: HFn = heightAt) {
  const out: { geo?: THREE.BufferGeometry; tris?: number } = {}; const it = nearPieceJob(r, s0, s1, hFn, out);
  while (!it.next().done) { /* run to completion */ }
  return out as { geo: THREE.BufferGeometry; tris: number };
}

function toGeometry(acc: Acc) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(acc.nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(acc.uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(acc.col, 3));
  const n = acc.idx[0].length + acc.idx[1].length;
  const idx = acc.pos.length / 3 > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  idx.set(acc.idx[0], 0); idx.set(acc.idx[1], acc.idx[0].length);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.addGroup(0, acc.idx[0].length, 0); geo.addGroup(acc.idx[0].length, acc.idx[1].length, 1);
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  return geo;
}

/**
 * Far mesh of a whole road: a ribbon whose columns follow the cross-section (centre, edges, ramp foot, shoulder,
 * drain, frontage, blend). Index ranges are stored per piece and per material so pieces drawn near can be skipped.
 */
export function buildFarMesh(r: Road, pieces: [number, number][], hFn: HFn = heightAt) {
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], col: number[] = [];
  const rows: number[] = [];
  for (const [a, b] of pieces) { for (let s = a; s < b - 0.5; s += 2) rows.push(s); }
  rows.push(pieces[pieces.length - 1][1]);
  const c = [0, 0, 0]; let ncol = 0;
  const colsAt = (s: number) => {
    const sc = Math.min(r.sMax, Math.max(r.sMin, s)), hw = r.hw(sc), so = hw + r.field(sc, 2), dw = r.field(sc, 10), outer = r.coreHalf(sc), mh = meshHalf(r, sc);
    const side = (sg: number) => { const e = r.edge(sc, sg); return [hw * 0.5, Math.max(hw * 0.5 + 0.1, e - 0.6), e, e + RAMP, Math.max(e + RAMP + 0.01, so), so + dw * 0.5, so + dw, Math.max(so + dw + 0.02, outer), outer + (mh - outer) * 0.45, mh]; };
    const L = side(-1).map(x => -x).reverse(), R = side(1);
    return [...L, 0, ...R];
  };
  for (const s of rows) {
    const D = colsAt(s); ncol = D.length;
    for (const d of D) {
      const x = r.toX(s, d), z = r.toZ(s, d), e = 0.6;
      const gx = (hFn(x + e, z) - hFn(x - e, z)) / (2 * e), gz = (hFn(x, z + e) - hFn(x, z - e)) / (2 * e), l = Math.hypot(gx, 1, gz);
      pos.push(x, hFn(x, z), z); nor.push(-gx / l, 1 / l, -gz / l); uv.push(x / 4, z / 4);
      colourAt(r, Math.min(r.sMax, Math.max(r.sMin, s)), d, c); col.push(c[0], c[1], c[2]);
    }
  }
  const flip = false, mid = (ncol - 1) / 2;
  const per: [number[], number[]][] = pieces.map(() => [[], []]);
  let p = 0;
  for (let j = 0; j < rows.length - 1; j++) {
    const sc = (rows[j] + rows[j + 1]) / 2; while (p < pieces.length - 1 && sc > pieces[p][1]) p++;
    for (let i = 0; i < ncol - 1; i++) {
      const a = j * ncol + i, b = a + 1, u = a + ncol, w = u + 1;
      const dc = (pos[a * 3] + pos[w * 3]) / 2, zc = (pos[a * 3 + 2] + pos[w * 3 + 2]) / 2;
      if (roadOwner(dc, zc) !== r) continue;
      const g = i >= mid - 3 && i < mid + 3 && sc >= r.sMin && sc <= r.sMax ? 0 : 1; // between the two tarmac edges
      if (!flip) per[p][g].push(a, u, b, b, u, w); else per[p][g].push(a, b, u, b, w, u);
    }
  }
  const order: number[] = [], ranges: { road: [number, number]; verge: [number, number] }[] = pieces.map(() => ({ road: [0, 0], verge: [0, 0] }));
  for (let g = 0; g < 2; g++) per.forEach((pp, k) => { const st = order.length; order.push(...pp[g]); ranges[k][g === 0 ? 'road' : 'verge'] = [st, pp[g].length]; });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(new THREE.BufferAttribute(pos.length / 3 > 65535 ? new Uint32Array(order) : new Uint16Array(order), 1));
  geo.computeBoundingBox(); geo.computeBoundingSphere();
  return { geo, ranges, tris: order.length / 3 };
}

const _cam = new THREE.Vector3();
/**
 * Near/far switching along s. Driven by THREE.LOD's per-camera update() (the renderer calls it), so main.ts needs
 * no per-frame hook. Near pieces are built lazily within `budgetMs` per frame (more while the car's own piece is missing).
 */
export class RoadLod extends THREE.LOD {
  far: THREE.Mesh; pieces: [number, number][]; ranges: { road: [number, number]; verge: [number, number] }[];
  near = new Map<number, THREE.Mesh>(); private jobs = new Map<number, { it: Generator; out: { geo?: THREE.BufferGeometry; tris?: number } }>();
  private shownKey = ''; stats = { builds: 0, maxBuildMs: 0, maxSliceMs: 0, nearTris: 0, farTris: 0 }; // maxBuildMs: incl. the catch-up after a teleport; maxSliceMs: background slices
  constructor(public road: Road, private mats: THREE.Material[], public nearDist = 80, public keepDist = 140, public budgetMs = 4) {
    super();
    this.pieces = pieceRanges(road);
    const f = buildFarMesh(road, this.pieces);
    this.far = new THREE.Mesh(f.geo, mats); this.far.receiveShadow = true; this.ranges = f.ranges; this.stats.farTris = f.tris;
    this.add(this.far); this.setFarGroups(new Set());
  }
  private dist(k: number, s: number, d: number) { const [a, b] = this.pieces[k]; return Math.hypot(Math.max(0, a - s, s - b), Math.max(0, Math.abs(d) - meshHalf(this.road, s))); }
  update(camera: THREE.Camera) {
    _cam.setFromMatrixPosition(camera.matrixWorld);
    const r = this.road, s = r.toS(_cam.x, _cam.z), d = r.toD(_cam.x, _cam.z);
    const want: number[] = [];
    this.pieces.forEach((_, k) => { const dd = this.dist(k, s, d); if (dd < this.nearDist) want.push(k); else if (dd > this.keepDist) this.drop(k); });
    want.sort((a, b) => this.dist(a, s, d) - this.dist(b, s, d));
    const t0 = performance.now(), urgent = want.length > 0 && this.dist(want[0], s, d) < 1 && !this.near.has(want[0]);
    const budget = urgent ? 60 : this.budgetMs;
    for (const k of want) {
      if (this.near.has(k)) continue;
      let job = this.jobs.get(k);
      if (!job) { const out = {}; job = { it: nearPieceJob(r, this.pieces[k][0], this.pieces[k][1], heightAt, out), out }; this.jobs.set(k, job); }
      const tj = performance.now(); SLICE.end = t0 + budget;
      while (performance.now() - t0 < budget) { if (job.it.next().done) break; }
      SLICE.end = Infinity;
      const dtj = performance.now() - tj; this.stats.maxBuildMs = Math.max(this.stats.maxBuildMs, dtj); if (!urgent) this.stats.maxSliceMs = Math.max(this.stats.maxSliceMs, dtj);
      if (job.out.geo) {
        const m = new THREE.Mesh(job.out.geo, this.mats); m.receiveShadow = true; this.add(m); this.near.set(k, m); this.jobs.delete(k); this.stats.builds++;
      }
      if (performance.now() - t0 >= budget) break;
    }
    const shown = new Set<number>(); for (const k of want) if (this.near.has(k)) shown.add(k);
    for (const [k, m] of this.near) m.visible = shown.has(k);
    const key = [...shown].sort((a, b) => a - b).join(',');
    if (key !== this.shownKey) { this.shownKey = key; this.setFarGroups(shown); }
    let t = 0; for (const k of shown) t += (this.near.get(k)!.geometry.index!.count) / 3; this.stats.nearTris = t;
  }
  private drop(k: number) { const m = this.near.get(k); if (m) { this.remove(m); m.geometry.dispose(); this.near.delete(k); } this.jobs.delete(k); }
  /** Far draw groups = contiguous runs of pieces not drawn near (per material). */
  private setFarGroups(shown: Set<number>) {
    const g = this.far.geometry; g.clearGroups();
    for (const [mat, key] of [[0, 'road'], [1, 'verge']] as const) {
      let st = -1, cnt = 0;
      this.ranges.forEach((rg, k) => {
        const [a, n] = rg[key];
        if (shown.has(k) || n === 0) { if (st >= 0 && cnt) g.addGroup(st, cnt, mat); st = -1; cnt = 0; return; }
        if (st < 0) { st = a; cnt = 0; } cnt += n;
      });
      if (st >= 0 && cnt) g.addGroup(st, cnt, mat);
    }
  }
}

/**
 * Lane markings draped on the surface (one merged mesh for all roads): state highway centre line 3 m dash / 4.5 m gap
 * and edge lines, link road centre dashes, district road faded centre dashes, none in the village. Worn: random gaps.
 */
export function buildMarkings(roads: Road[], rnd: () => number) {
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const strip = (r: Road, sA: number, sB: number, d: number, w: number, fade: number) => {
    // skip paint over potholes and trench cuts
    for (const f of r.feats.at((sA + sB) / 2)) if ((f.kind === 'pothole' || f.kind === 'trench') && f.s1 > sA && f.s0 < sB && f.d1 > d - w && f.d0 < d + w) return;
    const n = Math.max(1, Math.ceil((sB - sA) / 0.5)), base = pos.length / 3;
    for (let k = 0; k <= n; k++) {
      const s = sA + ((sB - sA) * k) / n;
      for (const dd of [d - w / 2, d + w / 2]) { const x = r.toX(s, dd), z = r.toZ(s, dd); pos.push(x, heightAt(x, z) + 0.006, z); const c = 0.55 + 0.45 * fade; col.push(c, c, c * 0.97); }
    }
    const flip = false;
    for (let k = 0; k < n; k++) { const a = base + k * 2, b = a + 1, c = a + 2, e = a + 3; if (!flip) idx.push(a, c, b, b, c, e); else idx.push(a, b, c, b, e, c); }
  };
  for (const r of roads) for (const sec of r.sections) {
    const a = Math.max(sec.s0, r.sMin) + 6, b = Math.min(sec.s1, r.sMax) - 6;
    if (sec.cls === 'sh' || sec.cls === 'link' || sec.cls === 'district') {
      const dash = sec.cls === 'district' ? 1.5 : 3, gap = sec.cls === 'district' ? 4.5 : 4.5, keep = sec.cls === 'district' ? 0.45 : 0.9;
      for (let s = a; s + dash < b; s += dash + gap) if (rnd() < keep) strip(r, s, s + dash, 0, 0.12, sec.cls === 'district' ? 0.2 + rnd() * 0.3 : 0.6 + rnd() * 0.4);
    }
    if (sec.cls === 'sh') for (const sg of [1, -1]) {
      for (let s = a; s < b; s += 6) { if (rnd() < 0.18) continue; const fade = 0.5 + rnd() * 0.5; strip(r, s, Math.min(b, s + 6), sg * (r.hw(s) - 0.25), 0.15, fade); }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.setIndex(idx); geo.computeVertexNormals(); geo.computeBoundingSphere();
  return geo;
}
