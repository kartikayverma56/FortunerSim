// Visible crash damage on the car model (PLAN_crash_damage_mirrors.md §4 "Visual"):
// - Dents: the hull's crush increments (Hull.dents, body frame) displace the merged static car meshes on the CPU,
//   depth·(1 − (d/r)²)² along the push direction with ±15 % position-hashed noise. Normals are recomputed only for the
//   moved vertices (one index scan per touched mesh). Rest positions / normals are copied lazily for repair.
//   Work is queued and spent in slices of at most ~3 ms per frame (hits within 100 ms are merged by the hull).
// - Glass: the window panes are split per pane before the merge (rig.ts). Tempered side and rear panes shatter (hidden);
//   the laminated windscreen stays, frosted, with a crack overlay on planar UVs centred on the nearest impact.
// - Lamps break (stay dark) when their corner is crushed; a door mirror glass hides when its hull point yields
//   (src/render/mirrors.ts then skips it).
// - Repair (Y) restores geometry, normals, glass, lamps and mirrors. The shadow proxy is never deformed.
import * as THREE from 'three';
import type { CarVisual, GlassPane } from './rig';
import type { Vehicle } from '../physics/vehicle';
import type { Dent } from '../physics/hull';

interface DMesh {
  mesh: THREE.Mesh; pos: THREE.BufferAttribute; nrm: THREE.BufferAttribute | null; index: ArrayLike<number> | null;
  toLocal: THREE.Matrix4; scale: number; box: THREE.Box3;
  rest: Float32Array | null; restN: Float32Array | null; flag: Uint8Array | null; dirty: boolean;
  /** Vertices moved since the last normal fix, and a vertex → triangle list (CSR, built at load) so the normal fix
   *  touches only their triangles instead of scanning the whole index. */
  moved: number[]; adjOff: Uint32Array | null; adjTri: Uint32Array | null; triStamp: Uint32Array | null; stamp: number;
}
interface Job { d: Dent; k: number } // next mesh index to process

const BUDGET_MS = 3;

export class DamageVisual {
  meshes: DMesh[] = [];
  /** Stats for window.sim (last pass ms, vertices moved, passes). */
  stats = { lastMs: 0, maxMs: 0, maxItemMs: 0, verts: 0, passes: 0, dents: 0, meshes: 0, vertsTotal: 0 };
  private jobs: Job[] = []; private itemEst = 0.2;
  private shattered: Record<GlassPane, boolean> = { front: false, rear: false, left: false, right: false };
  private crack: THREE.Mesh | null = null;
  private glassMeshes: Partial<Record<GlassPane, THREE.Mesh[]>> = {};
  private mirrorMeshes: { id: string; mesh: THREE.Mesh }[] = [];
  private windscreenProps: { rough: number; opacity: number } | null = null;
  private lastDent: THREE.Vector3 | null = null;
  private v = new THREE.Vector3(); private n = new THREE.Vector3();

  constructor(private car: CarVisual, private veh: Vehicle) {
    car.root.updateMatrixWorld(true);
    const toBody = new THREE.Matrix4().copy(car.root.matrixWorld).invert();
    const skip = new Set<THREE.Object3D>();
    for (const c of Object.values(car.corners)) for (const d of [c.spin, c.steer, c.vert, c.caliper]) if (d) skip.add(d.node);
    for (const d of [car.rearAxle, car.steeringWheel, car.needleTacho, car.needleSpeed]) if (d) skip.add(d.node);
    const paneOf = new Map<THREE.Material, GlassPane>(); for (const [p, m] of Object.entries(car.glassPane)) if (m) paneOf.set(m, p as GlassPane);
    car.root.traverse(o => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || !m.geometry || (m.material as THREE.Material).visible === false && m.name === 'Car_shadow_proxy') return;
      if (m.name === 'Car_shadow_proxy' || m.name === 'Reverse_lamps' || Array.isArray(m.material)) return;
      for (let p: THREE.Object3D | null = m; p; p = p.parent) if (skip.has(p)) return;
      const g = m.geometry, pos = g.attributes.position as THREE.BufferAttribute;
      if (!pos) return; // interleaved / quantised attributes (unmerged meshopt meshes) are converted on the first dent
      const rel = new THREE.Matrix4().multiplyMatrices(toBody, m.matrixWorld);
      const box = new THREE.Box3().setFromBufferAttribute(pos).applyMatrix4(rel);
      this.meshes.push({ mesh: m, pos, nrm: (g.attributes.normal as THREE.BufferAttribute) ?? null, index: g.index ? g.index.array : null,
        toLocal: rel.clone().invert(), scale: rel.getMaxScaleOnAxis(), box, rest: null, restN: null, flag: null, dirty: false, moved: [], adjOff: null, adjTri: null, triStamp: null, stamp: 0 });
      this.stats.vertsTotal += pos.count;
      const pane = paneOf.get(m.material as THREE.Material); if (pane) (this.glassMeshes[pane] ??= []).push(m);
    });
    // unmerged meshopt meshes carry interleaved / quantised attributes: plain floats now (once, at load), not mid-crash
    for (const m of this.meshes) if (!(m.pos.array instanceof Float32Array) || (m.pos as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) this.toFloat(m);
    for (const m of this.meshes) this.buildAdjacency(m);
    this.mirrorMeshes = car.mirrorMeshes();
    this.stats.meshes = this.meshes.length;
  }

  /** Once per frame after the physics. */
  update() {
    const veh = this.veh;
    for (const d of veh.hull.takeDents(veh.t, 0.1)) { this.jobs.push({ d, k: 0 }); this.stats.dents++; this.lastDent = new THREE.Vector3(d.x, d.y, d.z); }
    if (this.jobs.length || this.meshes.some(m => m.dirty)) this.work();
    this.glassAndLamps();
  }

  /** One slice of the queued work (dent × mesh displacements, then the touched meshes' normals), ≤ ~3 ms. */
  private work() {
    const t0 = performance.now(); let moved = 0, items = 0;
    for (;;) {
      const ta = performance.now();
      if (items && ta - t0 + this.itemEst > BUDGET_MS) break; // the next item might not fit this frame
      if (this.jobs.length) { const job = this.jobs[0]; moved += this.apply(this.meshes[job.k++], job.d); if (job.k >= this.meshes.length) this.jobs.shift(); }
      else { const m = this.meshes.find(q => q.dirty); if (!m) break; this.fixNormals(m); }
      items++; const ti = performance.now() - ta; if (ti > this.stats.maxItemMs) this.stats.maxItemMs = ti; this.itemEst = Math.max(ti, this.itemEst * 0.9);
    }
    const ms = performance.now() - t0;
    if (items) { this.stats.lastMs = ms; this.stats.maxMs = Math.max(this.stats.maxMs, ms); this.stats.verts += moved; this.stats.passes++; }
  }

  /** Displaces one mesh's vertices around a dent; returns how many moved. */
  private apply(m: DMesh, d: Dent): number {
    const nl = Math.hypot(d.nx, d.ny, d.nz); if (nl < 1e-9) return 0;
    // radius in the body frame: a pole leaves a narrow deep V, a flat contact a wider dish
    const r = d.r >= 0 ? Math.min(0.6, 0.28 + 0.35 * d.total) : Math.min(0.75, 0.42 + 0.3 * d.total);
    const p = this.v.set(d.x, d.y, d.z);
    if (p.x < m.box.min.x - r || p.x > m.box.max.x + r || p.y < m.box.min.y - r || p.y > m.box.max.y + r || p.z < m.box.min.z - r || p.z > m.box.max.z + r) return 0;
    p.applyMatrix4(m.toLocal);
    const n = this.n.set(d.nx / nl, d.ny / nl, d.nz / nl).transformDirection(m.toLocal);
    const s = m.scale, rl = r / s, rl2 = rl * rl, D = d.depth / s;
    if (!(m.pos.array instanceof Float32Array) || (m.pos as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) this.toFloat(m); // quantised (meshopt) attributes of an unmerged mesh
    const a = m.pos.array as Float32Array, cnt = m.pos.count;
    if (!m.rest) { m.rest = a.slice(); if (m.nrm) m.restN = (m.nrm.array as Float32Array).slice(); m.flag = new Uint8Array(cnt); }
    const flag = m.flag!, maxDisp2 = (1.0 / s) ** 2, rest = m.rest;
    let moved = 0;
    for (let i = 0, j = 0; i < cnt; i++, j += 3) {
      const dx = a[j] - p.x, dy = a[j + 1] - p.y, dz = a[j + 2] - p.z;
      const q = dx * dx + dy * dy + dz * dz; if (q >= rl2) continue;
      const u = 1 - q / rl2, w = u * u * (1 + 0.15 * hash3(rest[j], rest[j + 1], rest[j + 2]));
      let x = a[j] + n.x * D * w, y = a[j + 1] + n.y * D * w, z = a[j + 2] + n.z * D * w;
      const ex = x - rest[j], ey = y - rest[j + 1], ez = z - rest[j + 2], e2 = ex * ex + ey * ey + ez * ez;
      if (e2 > maxDisp2) { const k = Math.sqrt(maxDisp2 / e2); x = rest[j] + ex * k; y = rest[j + 1] + ey * k; z = rest[j + 2] + ez * k; }
      a[j] = x; a[j + 1] = y; a[j + 2] = z; if (flag[i] !== 1) { flag[i] = 1; m.moved.push(i); } moved++;
    }
    if (moved) { m.dirty = true; m.pos.needsUpdate = true; }
    return moved;
  }

  private toFloat(m: DMesh) {
    const g = m.mesh.geometry;
    const conv = (at: THREE.BufferAttribute) => { const n = at.count, k = at.itemSize, arr = new Float32Array(n * k); for (let i = 0; i < n; i++) { arr[i * k] = at.getX(i); if (k > 1) arr[i * k + 1] = at.getY(i); if (k > 2) arr[i * k + 2] = at.getZ(i); if (k > 3) arr[i * k + 3] = at.getW(i); } return new THREE.BufferAttribute(arr, k); };
    m.pos = conv(m.pos); g.setAttribute('position', m.pos);
    if (m.nrm && (!(m.nrm.array instanceof Float32Array) || (m.nrm as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute)) { m.nrm = conv(m.nrm); g.setAttribute('normal', m.nrm); }
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && (g.attributes[k] as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) g.setAttribute(k, conv(g.attributes[k] as THREE.BufferAttribute));
  }

  private buildAdjacency(m: DMesh) {
    const cnt = m.pos.count, idx = m.index, n = idx ? idx.length : cnt;
    const off = new Uint32Array(cnt + 1);
    for (let t = 0; t < n; t++) off[(idx ? idx[t] : t) + 1]++;
    for (let i = 0; i < cnt; i++) off[i + 1] += off[i];
    const fill = off.slice(0, cnt), tri = new Uint32Array(n);
    for (let t = 0; t < n; t++) { const v = idx ? idx[t] : t; tri[fill[v]++] = t - (t % 3); }
    m.adjOff = off; m.adjTri = tri; m.triStamp = new Uint32Array(Math.ceil(n / 3));
  }

  /** Recomputes the normals of the moved vertices from their own triangles (CSR adjacency; cost ∝ moved vertices). */
  private fixNormals(m: DMesh) {
    m.dirty = false;
    const nrm = m.nrm, flag = m.flag, mv = m.moved; if (!nrm || !flag || !m.adjOff) { mv.length = 0; return; }
    const a = m.pos.array as Float32Array, na = nrm.array as Float32Array, idx = m.index, off = m.adjOff, tl = m.adjTri!, ts = m.triStamp!;
    const st = ++m.stamp;
    for (const i of mv) { na[3 * i] = na[3 * i + 1] = na[3 * i + 2] = 0; }
    for (const v of mv) for (let k = off[v]; k < off[v + 1]; k++) {
      const t = tl[k], tk = t / 3; if (ts[tk] === st) continue; ts[tk] = st;
      const i0 = idx ? idx[t] : t, i1 = idx ? idx[t + 1] : t + 1, i2 = idx ? idx[t + 2] : t + 2;
      const ax = a[3 * i1] - a[3 * i0], ay = a[3 * i1 + 1] - a[3 * i0 + 1], az = a[3 * i1 + 2] - a[3 * i0 + 2];
      const bx = a[3 * i2] - a[3 * i0], by = a[3 * i2 + 1] - a[3 * i0 + 1], bz = a[3 * i2 + 2] - a[3 * i0 + 2];
      const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
      if (flag[i0] === 1) { na[3 * i0] += cx; na[3 * i0 + 1] += cy; na[3 * i0 + 2] += cz; }
      if (flag[i1] === 1) { na[3 * i1] += cx; na[3 * i1 + 1] += cy; na[3 * i1 + 2] += cz; }
      if (flag[i2] === 1) { na[3 * i2] += cx; na[3 * i2 + 1] += cy; na[3 * i2 + 2] += cz; }
    }
    for (const i of mv) {
      const x = na[3 * i], y = na[3 * i + 1], z = na[3 * i + 2], l = Math.hypot(x, y, z);
      if (l > 1e-12) { na[3 * i] = x / l; na[3 * i + 1] = y / l; na[3 * i + 2] = z / l; } else { na[3 * i] = m.restN![3 * i]; na[3 * i + 1] = m.restN![3 * i + 1]; na[3 * i + 2] = m.restN![3 * i + 2]; }
      flag[i] = 2; // moved, normals done (repair restores it)
    }
    mv.length = 0;
    nrm.needsUpdate = true;
  }

  /** Glass, lamps and mirrors from the crush state (cheap; runs every frame). */
  private glassAndLamps() {
    const h = this.veh.hull, d = this.veh.damage;
    // crush of the points around each pane (window line and above)
    let L = 0, R = 0, Rr = 0, F = 0;
    for (let i = 0; i < h.nBody; i++) {
      const dp = h.dp[i]; if (dp <= 0) continue;
      const x = h.px[i], y = h.py[i], z = h.pz[i];
      if (h.zone[i] === 'mirror') continue;
      if (y >= 0.18 && x > 0.5) L = Math.max(L, dp);
      if (y >= 0.18 && x < -0.5) R = Math.max(R, dp);
      if (z < -1.9 && y >= 0.3) Rr = Math.max(Rr, dp);
      if ((y > 0.6 && z > 0.3) || (z > 1.1 && y > 0.3)) F = Math.max(F, dp); // A-pillars, header, cowl
    }
    const roof = d.zone.roof, latDV = d.peakDvLat;
    this.shatter('left', L > 0.06 || roof > 0.15 || (latDV > 6 && L > 0.02));
    this.shatter('right', R > 0.06 || roof > 0.15 || (latDV > 6 && R > 0.02));
    this.shatter('rear', Rr > 0.06 || roof > 0.2);
    let front = 0; for (const i of d.zonePts.front) front = Math.max(front, h.dp[i]);
    this.crackWindscreen(F > 0.03 || roof > 0.1 || front > 0.3);
    // lamps: a crushed corner smashes the lamp there
    for (const [mat, spot] of this.car.lampSpot) {
      let dp = 0;
      for (let i = 0; i < h.nBody; i++) {
        const x = h.px[i], z = h.pz[i]; if (h.zone[i] === 'mirror') continue;
        const near = spot.front ? z > 1.9 : z < -2.0;
        const side = spot.side === 'centre' ? Math.abs(x) < 0.5 && h.py[i] > 0.3 : spot.side === 'both' ? Math.abs(x) > 0.3 : spot.side === 'left' ? x > 0.3 : x < -0.3;
        if (near && side && h.dp[i] > dp) dp = h.dp[i];
      }
      this.car.breakLamp(mat as THREE.MeshStandardMaterial, dp > 0.04);
    }
    this.car.reverseBroken = Rr > 0.06 || d.zone.rear > 0.2;
    for (const { id, mesh } of this.mirrorMeshes) if (id !== 'interior') mesh.visible = !(id === 'left' ? d.mirrorBroken.left : d.mirrorBroken.right);
  }

  private shatter(p: GlassPane, on: boolean) {
    if (on === this.shattered[p]) return;
    if (p === 'front') return; // laminated: cracks, never falls out
    this.shattered[p] = on;
    for (const m of this.glassMeshes[p] ?? []) m.visible = !on;
  }

  private crackWindscreen(on: boolean) {
    if (on === this.shattered.front) return;
    this.shattered.front = on;
    const mat = this.car.glassPane.front;
    if (!on) { if (this.crack) { this.crack.removeFromParent(); (this.crack.material as THREE.MeshBasicMaterial).map?.dispose(); this.crack.geometry.dispose(); this.crack = null; }
      if (mat && this.windscreenProps) { mat.roughness = this.windscreenProps.rough; mat.opacity = this.windscreenProps.opacity; } return; }
    const ws = this.glassMeshes.front?.[0]; if (!ws || !mat) return;
    this.windscreenProps = { rough: mat.roughness, opacity: mat.opacity };
    mat.roughness = 0.35; // frosted round the breaks
    // planar UVs in the body frame (x across, y up), crack centre at the impact nearest the screen (else the middle)
    const g = new THREE.BufferGeometry(); g.setAttribute('position', ws.geometry.attributes.position.clone()); if (ws.geometry.index) g.setIndex(ws.geometry.index.clone());
    this.car.root.updateMatrixWorld(true);
    const rel = new THREE.Matrix4().multiplyMatrices(new THREE.Matrix4().copy(this.car.root.matrixWorld).invert(), ws.matrixWorld);
    const p = g.attributes.position, uv = new Float32Array(p.count * 2), b = new THREE.Box3(), v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(rel); b.expandByPoint(v); }
    for (let i = 0; i < p.count; i++) { v.fromBufferAttribute(p, i).applyMatrix4(rel); uv[2 * i] = (v.x - b.min.x) / Math.max(1e-3, b.max.x - b.min.x); uv[2 * i + 1] = (v.y - b.min.y) / Math.max(1e-3, b.max.y - b.min.y); }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    let cu = 0.35 + Math.random() * 0.3, cv = 0.4 + Math.random() * 0.3;
    if (this.lastDent && this.lastDent.z > 0.5) { cu = THREE.MathUtils.clamp((this.lastDent.x - b.min.x) / (b.max.x - b.min.x), 0.1, 0.9); cv = THREE.MathUtils.clamp((this.lastDent.y - b.min.y) / (b.max.y - b.min.y), 0.15, 0.85); }
    const tex = crackTexture(cu, 1 - cv);
    const cm = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false });
    this.crack = new THREE.Mesh(g, cm); this.crack.name = 'Windscreen_cracks'; this.crack.renderOrder = 2;
    this.crack.matrixAutoUpdate = false; this.crack.matrix.copy(ws.matrix);
    ws.parent!.add(this.crack);
  }

  /** Y: geometry, normals, glass, lamps and mirrors back to new. */
  repair() {
    this.jobs.length = 0;
    for (const m of this.meshes) {
      if (!m.rest) continue;
      (m.pos.array as Float32Array).set(m.rest); m.pos.needsUpdate = true;
      if (m.nrm && m.restN) { (m.nrm.array as Float32Array).set(m.restN); m.nrm.needsUpdate = true; }
      m.flag!.fill(0); m.dirty = false; m.moved.length = 0;
    }
    for (const p of ['left', 'right', 'rear'] as GlassPane[]) this.shatter(p, false);
    this.crackWindscreen(false);
    for (const mat of this.car.lampSpot.keys()) this.car.breakLamp(mat as THREE.MeshStandardMaterial, false);
    this.car.reverseBroken = false;
    for (const { mesh } of this.mirrorMeshes) mesh.visible = true;
    this.lastDent = null;
  }
}

/** Deterministic ±1 noise from a position (same for duplicated vertices on seams, so the mesh never tears). */
function hash3(x: number, y: number, z: number) {
  let h = Math.imul(Math.round(x * 40) | 0, 73856093) ^ Math.imul(Math.round(y * 40) | 0, 19349663) ^ Math.imul(Math.round(z * 40) | 0, 83492791);
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995); h ^= h >>> 15;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

/** Laminated-glass break: radial cracks from the impact point plus concentric rings, white on transparent. */
function crackTexture(u: number, v: number) {
  const S = 1024, c = document.createElement('canvas'); c.width = c.height = S;
  const g = c.getContext('2d')!; const cx = u * S, cy = v * S;
  let seed = 1234567; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  g.fillStyle = 'rgba(235,240,245,0.28)'; g.beginPath(); g.arc(cx, cy, 150, 0, Math.PI * 2); g.fill(); // crushed spot
  g.strokeStyle = 'rgba(245,248,250,0.85)'; g.lineCap = 'round';
  const n = 22;
  for (let k = 0; k < n; k++) {
    let a = (k / n) * Math.PI * 2 + rnd() * 0.25, x = cx, y = cy; const len = 260 + rnd() * 520;
    g.lineWidth = 4 + rnd() * 4; g.beginPath(); g.moveTo(x, y);
    for (let s = 0; s < len; s += 18) { a += (rnd() - 0.5) * 0.35; x += Math.cos(a) * 18; y += Math.sin(a) * 18; g.lineTo(x, y); }
    g.stroke();
  }
  for (let r = 40; r < 260; r += 30 + rnd() * 40) { // spider-web rings, broken into arcs
    g.lineWidth = 3 + rnd() * 2; for (let a = 0; a < Math.PI * 2; a += 0.35 + rnd() * 0.4) { if (rnd() < 0.3) continue; g.beginPath(); g.arc(cx, cy, r + (rnd() - 0.5) * 12, a, a + 0.25 + rnd() * 0.3); g.stroke(); }
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
