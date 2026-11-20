// Tyre marks: braking streaks, drift smears and burnout patches, laid where each tyre really slides.
// One ring-buffer mesh (one draw call); the oldest segment is overwritten when the buffer is full.
import * as THREE from 'three';
import type { Vehicle } from '../physics/vehicle';

const MAX_SEG = 3000;            // ring buffer size (segments, all wheels)
const MIN_STEP = 0.12;           // m between mark points while rolling
const TYRE_W = 0.24;             // mark width (265 mm tyre, a little under the full tread)
const LIFT = 0.012;              // m above the road surface (plus polygon offset)

// rubber colour by surface: dark rubber on hard surfaces, darker ruts on loose ones
const SURF_RGB: Record<string, [number, number, number]> = {
  asphalt: [0.05, 0.05, 0.05], concrete: [0.06, 0.06, 0.06], rumble: [0.05, 0.05, 0.05], smooth: [0.05, 0.05, 0.05],
  wet: [0.04, 0.04, 0.045], gravel: [0.22, 0.19, 0.15], grass: [0.18, 0.15, 0.09], mud: [0.16, 0.11, 0.07], sand: [0.42, 0.36, 0.26],
};
const rgbFor = (s: string): [number, number, number] => SURF_RGB[s] ?? [0.06, 0.06, 0.06];

interface Track { active: boolean; x: number; y: number; z: number; lx: number; ly: number; lz: number; rx: number; ry: number; rz: number; burn: number }

export class SkidMarks {
  readonly mesh: THREE.Mesh;
  private pos = new Float32Array(MAX_SEG * 4 * 3);
  private col = new Float32Array(MAX_SEG * 4 * 4);
  private head = 0; private count = 0;
  private tracks: Track[] = [0, 1, 2, 3].map(() => ({ active: false, x: 0, y: 0, z: 0, lx: 0, ly: 0, lz: 0, rx: 0, ry: 0, rz: 0, burn: 0 }));
  private geo = new THREE.BufferGeometry();
  private dirty = false;
  private fwd = new THREE.Vector3(); private q = new THREE.Quaternion();
  private lastCar = new THREE.Vector3(NaN, 0, 0);

  constructor() {
    const idx = new Uint32Array(MAX_SEG * 6);
    for (let i = 0; i < MAX_SEG; i++) { const v = i * 4; idx.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6); }
    this.geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 1; this.mesh.name = 'SkidMarks';
  }

  /** Call once per rendered frame after physics. */
  update(veh: Vehicle) {
    // teleport / reset: break every strip so no mark is drawn across the jump
    const cp = veh.pos;
    if (!Number.isNaN(this.lastCar.x) && Math.hypot(cp.x - this.lastCar.x, cp.z - this.lastCar.z) > 3) this.tracks.forEach(t => (t.active = false));
    this.lastCar.set(cp.x, cp.y, cp.z);
    this.q.set(veh.q.x, veh.q.y, veh.q.z, veh.q.w);
    this.fwd.set(0, 0, 1).applyQuaternion(this.q);

    veh.wheels.forEach((w, i) => {
      const t = this.tracks[i];
      if (!w.grounded || w.Fz < 600) { t.active = false; t.burn = 0; return; }
      const load = Math.min(1, w.Fz / 6000);
      const longS = Math.max(0, Math.abs(w.kappa) - 0.12) / 0.35;             // braking lock-up / wheelspin
      const latS = Math.max(0, Math.abs(w.alpha) - 0.10) / 0.22;              // ~6° and up: sliding sideways
      const k = Math.min(1, (longS + latS) * (0.55 + 0.45 * load));
      const c = w.contact, n = w.contactN;
      const px = c.x + n.x * LIFT, py = c.y + n.y * LIFT, pz = c.z + n.z * LIFT;
      if (k < 0.05) { t.active = false; t.burn = 0; return; }
      // mark direction: travel since last point, or the car's heading for a stationary burnout
      let dx = px - t.x, dz = pz - t.z; const dist = Math.hypot(dx, dz);
      const rgb = rgbFor(w.surface);
      if (!t.active) { this.startTrack(t, px, py, pz, this.fwd.x, this.fwd.z, n); return; }
      if (dist < MIN_STEP) {
        // spinning on the spot: lay a short, darkening patch along the heading every so often
        t.burn += k * 0.05;
        if (t.burn > 1) { t.burn = 0; this.addPatch(px, py, pz, this.fwd.x, this.fwd.z, n, rgb, Math.min(0.85, 0.45 + k * 0.4)); }
        return;
      }
      dx /= dist; dz /= dist;
      const a = Math.min(0.85, 0.25 + 0.6 * k);
      // right vector in the ground plane: dir × normal
      let rx = dz * n.y, ry = n.z * dx - n.x * dz, rz = -dx * n.y; // n × dir: across the track, in the ground plane
      const rl = Math.hypot(rx, ry, rz) || 1; rx = rx / rl * TYRE_W / 2; ry = ry / rl * TYRE_W / 2; rz = rz / rl * TYRE_W / 2;
      this.addSeg(t.lx, t.ly, t.lz, t.rx, t.ry, t.rz, px - rx, py - ry, pz - rz, px + rx, py + ry, pz + rz, rgb, a);
      t.x = px; t.y = py; t.z = pz; t.lx = px - rx; t.ly = py - ry; t.lz = pz - rz; t.rx = px + rx; t.ry = py + ry; t.rz = pz + rz;
    });
    if (this.dirty) {
      const p = this.geo.attributes.position as THREE.BufferAttribute, cl = this.geo.attributes.color as THREE.BufferAttribute;
      p.needsUpdate = true; cl.needsUpdate = true; this.dirty = false;
      this.geo.setDrawRange(0, this.count * 6);
    }
  }

  /** Remove all marks (e.g. on a full reset). */
  clear() { this.count = 0; this.head = 0; this.tracks.forEach(t => (t.active = false)); this.geo.setDrawRange(0, 0); }

  private startTrack(t: Track, x: number, y: number, z: number, fx: number, fz: number, n: { x: number; y: number; z: number }) {
    const l = Math.hypot(fx, fz) || 1; const dx = fx / l, dz = fz / l;
    let rx = dz * n.y, rz = -dx * n.y; const rl = Math.hypot(rx, rz) || 1; rx = rx / rl * TYRE_W / 2; rz = rz / rl * TYRE_W / 2;
    Object.assign(t, { active: true, x, y, z, lx: x - rx, ly: y, lz: z - rz, rx: x + rx, ry: y, rz: z + rz, burn: 0 });
  }

  private addPatch(x: number, y: number, z: number, fx: number, fz: number, n: { x: number; y: number; z: number }, rgb: [number, number, number], a: number) {
    const l = Math.hypot(fx, fz) || 1; const dx = fx / l * 0.22, dz = fz / l * 0.22;
    let rx = fz / l * n.y, rz = -fx / l * n.y; const rl = Math.hypot(rx, rz) || 1; rx = rx / rl * TYRE_W / 2; rz = rz / rl * TYRE_W / 2;
    this.addSeg(x - dx - rx, y, z - dz - rz, x - dx + rx, y, z - dz + rz, x + dx - rx, y, z + dz - rz, x + dx + rx, y, z + dz + rz, rgb, a);
  }

  private addSeg(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, rgb: [number, number, number], a: number) {
    const i = this.head; const p = i * 12, c = i * 16;
    this.pos.set([ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz], p);
    for (let v = 0; v < 4; v++) this.col.set([rgb[0], rgb[1], rgb[2], a], c + v * 4);
    this.head = (this.head + 1) % MAX_SEG; this.count = Math.min(MAX_SEG, this.count + 1); this.dirty = true;
  }
}
