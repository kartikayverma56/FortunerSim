// World collider registry: trees, posts, walls, buildings, traffic and loose props the car body can hit.
// No three.js, no DOM. Imported by physics, world code and node tools.
// Units: metres, kg, seconds, newtons, radians. World frame, +Y up.
// yaw is about +Y; 0 = local +Z along world +Z; positive turns +Z toward +X (same as Vehicle.reset heading).
//   world = (x + lx·cos + lz·sin,  z − lx·sin + lz·cos);  local = (dx·cos − dz·sin,  dx·sin + dz·cos)
//
// Rules for registering objects:
// - Anything a wheel should climb (kerbs, medians up to 0.30 m) goes in heightAt with a face run of at least 0.04 m, not here.
// - Taller objects are colliders. Buildings are one or more boxes; curved walls and guard rails use addWall. Cylinders are vertical only.
// - The owner of the visual listens to onBreak and onHit to tip, hide or animate it.
// - Colliders can be added or removed at any time (chunk streaming is fine).
// - When registering while terrain.ts itself is still evaluating, pass y0 explicitly (the default calls heightAt).
// - Anything that must show in the mirrors needs obj.layers.enable(MIRROR_LAYER) (src/render/layers.ts).
//
// Stage 1 (this file): registry, spatial hash (8 m cells), queries, events, prop and moving-collider stepping.
// The car-side narrowphase (hull points / boxes against these shapes) arrives in Stage 2 and reports through contact().

import { heightAt } from './terrain';

export type ColliderMaterial = 'wood' | 'steel' | 'concrete' | 'masonry' | 'plastic' | 'rubber' | 'vehicle' | 'animal';
export type ColliderId = number;            // > 0, never reused in a session

export interface ColliderOpts {
  y0?: number;                 // world Y of the bottom. Default heightAt(x, z) - 0.3
  material?: ColliderMaterial; // default 'concrete' (sets friction and sound)
  mu?: number;                 // friction against the car body; overrides the material value
  breakForce?: number;         // N; contact force at which the object fails. Omit = immovable
  breakEnergy?: number;        // J absorbed while failing. Default 0.15 * breakForce
  group?: number;              // same group breaks together (post + board)
  tag?: string;                // owner label: 'tree' | 'lamp' | 'sign' | 'building' | 'traffic' ...
  ref?: number;                // owner's own index (e.g. InstancedMesh instance); returned in events
}
export interface CylinderSpec extends ColliderOpts { x: number; z: number; radius: number; height: number } // vertical axis
export interface BoxSpec extends ColliderOpts { x: number; z: number; halfX: number; halfZ: number; yaw: number; height: number } // vertical sides
export interface MovingSpec extends BoxSpec { mass: number }
export interface PropSpec { x: number; z: number; yaw?: number; kind: 'cone' | 'drum' | 'barricade' | 'crate';
  radius: number; height: number; mass: number; tag?: string; ref?: number }

export interface Collider { readonly id: ColliderId; readonly kind: 'cyl' | 'box' | 'moving';
  x: number; z: number; y0: number; y1: number; radius: number; halfX: number; halfZ: number; cos: number; sin: number;
  material: ColliderMaterial; mu: number; breakForce: number; breakEnergy: number; group: number; tag: string; ref: number;
  enabled: boolean; broken: boolean; vx: number; vz: number; yawRate: number; mass: number }

export interface HitEvent { id: ColliderId; tag: string; ref: number; material: ColliderMaterial;
  px: number; py: number; pz: number;      // world contact point
  nx: number; ny: number; nz: number;      // unit normal, from the collider toward the car
  impulse: number; relSpeed: number; broke: boolean }

export interface MovingHandle { readonly id: ColliderId;
  setPose(x: number, z: number, yaw: number, vx: number, vz: number, yawRate?: number): void; // owner calls each frame until hit
  readonly hit: boolean;                    // true after the car struck it; the registry then owns its motion
  readonly pose: { x: number; z: number; yaw: number; vx: number; vz: number };
  release(): void }
export interface PropHandle { readonly id: ColliderId; readonly moved: boolean;
  readonly pos: { x: number; y: number; z: number }; readonly quat: { x: number; y: number; z: number; w: number };
  reset(): void }

/** Body-on-object friction by material (car body sliding on it). [A] */
export const MATERIAL_MU: Record<ColliderMaterial, number> = {
  wood: 0.45, steel: 0.30, concrete: 0.45, masonry: 0.50, plastic: 0.35, rubber: 0.80, vehicle: 0.35, animal: 0.30,
};

const CELL = 8;
const INF = Number.POSITIVE_INFINITY;
type Entry = Collider & { kind: 'cyl' | 'box' | 'moving'; cells: number[]; stamp: number; lastHit: number; prop: PropState | null; mov: MovingState | null; yaw: number };
interface PropState { spec: PropSpec; moved: boolean; pos: { x: number; y: number; z: number }; vel: { x: number; y: number; z: number };
  quat: { x: number; y: number; z: number; w: number }; w: { x: number; y: number; z: number }; rest: number }
interface MovingState { hit: boolean; pose: { x: number; z: number; yaw: number; vx: number; vz: number } }

const cellKey = (i: number, j: number) => i * 1000003 + j;

class Registry {
  private map = new Map<ColliderId, Entry>();
  private grid = new Map<number, Entry[]>();
  private props: Entry[] = [];
  private movers: Entry[] = [];
  private nextId = 1;
  private nextGroup = 1 << 20;   // auto groups for addWall, far above any owner-chosen group
  private stampN = 0;
  private hitCbs = new Set<(e: HitEvent) => void>();
  private breakCbs = new Set<(e: HitEvent) => void>();
  /** Seconds; advanced by stepProps. contact() takes the caller's sim time instead. */
  clock = 0;
  version = 0;

  // ---------- registration ----------
  private make(kind: Entry['kind'], x: number, z: number, height: number, o: ColliderOpts): Entry {
    const material = o.material ?? 'concrete';
    const y0 = o.y0 ?? heightAt(x, z) - 0.3;
    const breakForce = o.breakForce ?? INF;
    const e: Entry = {
      id: this.nextId++, kind, x, z, y0, y1: y0 + height, radius: 0, halfX: 0, halfZ: 0, cos: 1, sin: 0, yaw: 0,
      material, mu: o.mu ?? MATERIAL_MU[material], breakForce, breakEnergy: o.breakEnergy ?? (Number.isFinite(breakForce) ? 0.15 * breakForce : INF),
      group: o.group ?? 0, tag: o.tag ?? '', ref: o.ref ?? -1, enabled: true, broken: false, vx: 0, vz: 0, yawRate: 0, mass: INF,
      cells: [], stamp: 0, lastHit: -INF, prop: null, mov: null,
    };
    return e;
  }
  private setYaw(e: Entry, yaw: number) { e.yaw = yaw; e.cos = Math.cos(yaw); e.sin = Math.sin(yaw); }
  /** Half extents of the footprint's world AABB. */
  private extent(e: Entry): [number, number] {
    if (e.kind === 'cyl') return [e.radius, e.radius];
    const c = Math.abs(e.cos), s = Math.abs(e.sin);
    return [c * e.halfX + s * e.halfZ, s * e.halfX + c * e.halfZ];
  }
  private insert(e: Entry) {
    const [ex, ez] = this.extent(e);
    const i0 = Math.floor((e.x - ex) / CELL), i1 = Math.floor((e.x + ex) / CELL), j0 = Math.floor((e.z - ez) / CELL), j1 = Math.floor((e.z + ez) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = cellKey(i, j); let l = this.grid.get(k); if (!l) { l = []; this.grid.set(k, l); }
      l.push(e); e.cells.push(k);
    }
  }
  private unhash(e: Entry) {
    for (const k of e.cells) { const l = this.grid.get(k); if (!l) continue; const i = l.indexOf(e); if (i >= 0) { l[i] = l[l.length - 1]; l.pop(); } if (!l.length) this.grid.delete(k); }
    e.cells.length = 0;
  }
  private add(e: Entry): ColliderId { this.map.set(e.id, e); this.insert(e); this.version++; return e.id; }

  addCylinder(s: CylinderSpec): ColliderId {
    const e = this.make('cyl', s.x, s.z, s.height, s); e.radius = s.radius; return this.add(e);
  }
  addBox(s: BoxSpec): ColliderId {
    const e = this.make('box', s.x, s.z, s.height, s); e.halfX = s.halfX; e.halfZ = s.halfZ; this.setYaw(e, s.yaw); return this.add(e);
  }
  /** A polyline wall: one box per segment, all in one group (they break together if breakable). */
  addWall(points: ReadonlyArray<readonly [number, number]>, thickness: number, height: number, o: ColliderOpts = {}): ColliderId[] {
    const ids: ColliderId[] = []; const group = o.group ?? this.nextGroup++;
    for (let i = 0; i + 1 < points.length; i++) {
      const [ax, az] = points[i], [bx, bz] = points[i + 1];
      const dx = bx - ax, dz = bz - az, L = Math.hypot(dx, dz); if (L < 1e-6) continue;
      const mx = (ax + bx) / 2, mz = (az + bz) / 2;
      ids.push(this.addBox({ ...o, group, x: mx, z: mz, halfX: thickness / 2, halfZ: L / 2, yaw: Math.atan2(dx, dz), height,
        y0: o.y0 ?? Math.min(heightAt(ax, az), heightAt(bx, bz)) - 0.3 }));
    }
    return ids;
  }
  addMoving(s: MovingSpec): MovingHandle {
    const e = this.make('moving', s.x, s.z, s.height, s); e.halfX = s.halfX; e.halfZ = s.halfZ; this.setYaw(e, s.yaw); e.mass = s.mass;
    if (s.material == null) { e.material = 'vehicle'; e.mu = s.mu ?? MATERIAL_MU.vehicle; }
    const st: MovingState = { hit: false, pose: { x: s.x, z: s.z, yaw: s.yaw, vx: 0, vz: 0 } };
    e.mov = st; this.add(e); this.movers.push(e);
    const reg = this;
    return {
      id: e.id,
      setPose(x, z, yaw, vx, vz, yawRate = 0) {
        if (st.hit || !reg.map.has(e.id)) return;
        reg.unhash(e); e.x = x; e.z = z; reg.setYaw(e, yaw); e.vx = vx; e.vz = vz; e.yawRate = yawRate;
        st.pose.x = x; st.pose.z = z; st.pose.yaw = yaw; st.pose.vx = vx; st.pose.vz = vz; reg.insert(e);
      },
      get hit() { return st.hit; },
      get pose() { return st.pose; },
      release() { reg.remove(e.id); },
    };
  }
  addProp(s: PropSpec): PropHandle {
    const e = this.make('cyl', s.x, s.z, s.height, { material: s.kind === 'crate' ? 'wood' : s.kind === 'drum' ? 'steel' : 'plastic', tag: s.tag ?? s.kind, ref: s.ref, y0: undefined });
    e.radius = s.radius; e.mass = s.mass; e.breakForce = 0; e.breakEnergy = 0;
    const y = heightAt(s.x, s.z); e.y0 = y; e.y1 = y + s.height;
    const yaw = s.yaw ?? 0;
    const ps: PropState = { spec: s, moved: false, pos: { x: s.x, y, z: s.z }, vel: { x: 0, y: 0, z: 0 },
      quat: { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, w: { x: 0, y: 0, z: 0 }, rest: 0 };
    e.prop = ps; this.add(e); this.props.push(e);
    const reg = this;
    return {
      id: e.id,
      get moved() { return ps.moved; },
      get pos() { return ps.pos; },
      get quat() { return ps.quat; },
      reset() {
        if (!reg.map.has(e.id)) return;
        reg.unhash(e); ps.moved = false; ps.rest = 0; ps.pos.x = s.x; ps.pos.z = s.z; ps.pos.y = heightAt(s.x, s.z);
        ps.vel.x = ps.vel.y = ps.vel.z = 0; ps.w.x = ps.w.y = ps.w.z = 0; ps.quat.x = 0; ps.quat.y = Math.sin(yaw / 2); ps.quat.z = 0; ps.quat.w = Math.cos(yaw / 2);
        e.x = s.x; e.z = s.z; e.y0 = ps.pos.y; e.y1 = ps.pos.y + s.height; e.enabled = true; e.broken = false; reg.insert(e); reg.version++;
      },
    };
  }

  remove(id: ColliderId) {
    const e = this.map.get(id); if (!e) return;
    this.unhash(e); this.map.delete(id);
    if (e.prop) { const i = this.props.indexOf(e); if (i >= 0) this.props.splice(i, 1); }
    if (e.mov) { const i = this.movers.indexOf(e); if (i >= 0) this.movers.splice(i, 1); }
    this.version++;
  }
  removeTag(tag: string): number {
    let n = 0; for (const e of [...this.map.values()]) if (e.tag === tag) { this.remove(e.id); n++; }
    return n;
  }
  setEnabled(id: ColliderId, on: boolean) { const e = this.map.get(id); if (e && e.enabled !== on) { e.enabled = on; this.version++; } }
  /** Enables or disables every collider with this tag; with refFrom/refTo only refs in [refFrom, refTo) (others untouched). */
  setTagEnabled(tag: string, on: boolean, refFrom = -INF, refTo = INF) {
    let ch = false;
    for (const e of this.map.values()) if (e.tag === tag && e.ref >= refFrom && e.ref < refTo && e.enabled !== on) { e.enabled = on; ch = true; }
    if (ch) this.version++;
  }
  get(id: ColliderId): Collider | undefined { return this.map.get(id); }
  get size() { return this.map.size; }

  // ---------- queries ----------
  /** Colliders (enabled, not broken) whose footprint overlaps the circle. Fills out, returns the count. */
  queryCircle(x: number, z: number, r: number, out: Collider[]): number {
    out.length = 0;
    const st = ++this.stampN;
    const i0 = Math.floor((x - r) / CELL), i1 = Math.floor((x + r) / CELL), j0 = Math.floor((z - r) / CELL), j1 = Math.floor((z + r) / CELL);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const l = this.grid.get(cellKey(i, j)); if (!l) continue;
      for (const e of l) {
        if (e.stamp === st) continue; e.stamp = st;
        if (!e.enabled || e.broken) continue;
        if (footprintDist(e, x, z) <= r) out.push(e);
      }
    }
    return out.length;
  }
  /** True when no solid collider (props excluded: they get knocked aside) overlaps the circle. */
  isFree(x: number, z: number, r: number): boolean {
    const n = this.queryCircle(x, z, r, this.tmp);
    for (let i = 0; i < n; i++) if (!(this.tmp[i] as Entry).prop) return false;
    return true;
  }
  private tmp: Collider[] = [];
  isProp(id: ColliderId) { return !!this.map.get(id)?.prop; }

  // ---------- events ----------
  onHit(cb: (e: HitEvent) => void): () => void { this.hitCbs.add(cb); return () => { this.hitCbs.delete(cb); }; }
  onBreak(cb: (e: HitEvent) => void): () => void { this.breakCbs.add(cb); return () => { this.breakCbs.delete(cb); }; }

  /**
   * Narrowphase report from the car (Stage 2). force: contact force magnitude (N); impulse: N·s over the contact so far;
   * vx/vy/vz: car contact-point velocity (m/s), used to launch props and to take over moving colliders.
   * Handles breaking (force ≥ breakForce breaks the whole group), prop launch, moving-collider takeover and the
   * onHit throttle (once per collider per 0.1 s of t). Returns the energy (J) the object absorbed by breaking, else 0.
   */
  contact(id: ColliderId, t: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number,
    force: number, impulse: number, relSpeed: number, vx = 0, vy = 0, vz = 0): number {
    const e = this.map.get(id); if (!e || !e.enabled || e.broken) return 0;
    let absorbed = 0, broke = false;
    if (e.prop) {
      const ps = e.prop; ps.moved = true; ps.rest = 0;
      ps.vel.x = vx * 1.3; ps.vel.y = Math.max(vy * 1.3, 0.25 * Math.hypot(vx, vz)); ps.vel.z = vz * 1.3;
      ps.w.x = -vz * 2 / Math.max(0.1, ps.spec.height); ps.w.z = vx * 2 / Math.max(0.1, ps.spec.height); ps.w.y = (Math.random() - 0.5) * 4;
      e.broken = true; broke = true; // a struck prop leaves the solid registry; stepProps flies it
    } else if (force >= e.breakForce) {
      broke = true; absorbed = e.breakEnergy;
      if (e.group) { for (const o of this.map.values()) if (o.group === e.group && !o.broken) { o.broken = true; } } else e.broken = true;
      this.version++;
    }
    if (e.mov && !e.mov.hit) e.mov.hit = true;
    const fire = broke || t - e.lastHit >= 0.1;
    if (fire) {
      e.lastHit = t;
      const ev: HitEvent = { id, tag: e.tag, ref: e.ref, material: e.material, px, py, pz, nx, ny, nz, impulse, relSpeed, broke };
      for (const cb of this.hitCbs) cb(ev);
      if (broke) for (const cb of this.breakCbs) cb(ev);
    }
    return absorbed;
  }

  // ---------- per-frame stepping ----------
  /** Main loop, once per frame: flies struck props to rest and coasts struck moving colliders. */
  stepProps(dt: number) {
    this.clock += dt;
    if (dt <= 0) return;
    const g = 9.81;
    for (const e of this.props) {
      const ps = e.prop!; if (!ps.moved || ps.rest > 1) continue;
      const n = Math.max(1, Math.ceil(dt / 0.004)), h = dt / n;
      for (let k = 0; k < n; k++) {
        ps.vel.y -= g * h;
        ps.pos.x += ps.vel.x * h; ps.pos.y += ps.vel.y * h; ps.pos.z += ps.vel.z * h;
        const gy = heightAt(ps.pos.x, ps.pos.z);
        if (ps.pos.y <= gy) {
          ps.pos.y = gy;
          if (ps.vel.y < 0) ps.vel.y = -ps.vel.y * 0.3; if (ps.vel.y < 0.3) ps.vel.y = 0;
          const vh = Math.hypot(ps.vel.x, ps.vel.z), dv = 0.6 * g * h;
          if (vh <= dv) { ps.vel.x = 0; ps.vel.z = 0; } else { ps.vel.x -= ps.vel.x / vh * dv; ps.vel.z -= ps.vel.z / vh * dv; }
          const damp = Math.max(0, 1 - 6 * h); ps.w.x *= damp; ps.w.y *= damp; ps.w.z *= damp;
          settle(ps, h); // gravity tips a grounded prop onto a stable pose: upright, or lying on its flank
        }
        integrateQuat(ps.quat, ps.w, h);
      }
      const still = ps.vel.x * ps.vel.x + ps.vel.y * ps.vel.y + ps.vel.z * ps.vel.z < 0.01 && ps.w.x * ps.w.x + ps.w.y * ps.w.y + ps.w.z * ps.w.z < 0.04;
      ps.rest = still ? ps.rest + dt : 0;
    }
    for (const e of this.movers) {
      if (!e.mov!.hit || e.broken) continue;
      const vh = Math.hypot(e.vx, e.vz); const dv = 0.7 * g * dt;   // struck traffic skids to rest on locked tyres [A]
      if (vh <= dv) { e.vx = 0; e.vz = 0; } else { e.vx -= e.vx / vh * dv; e.vz -= e.vz / vh * dv; }
      e.yawRate *= Math.max(0, 1 - 2 * dt);
      if (vh > 0 || e.yawRate !== 0) {
        this.unhash(e); e.x += e.vx * dt; e.z += e.vz * dt; this.setYaw(e, e.yaw + e.yawRate * dt); this.insert(e);
        const p = e.mov!.pose; p.x = e.x; p.z = e.z; p.yaw = e.yaw; p.vx = e.vx; p.vz = e.vz;
      }
    }
  }

  /** Test helper: removes everything (ids keep counting up, so they are never reused). */
  clear() { this.map.clear(); this.grid.clear(); this.props.length = 0; this.movers.length = 0; this.version++; }
}

/** Horizontal distance from (x, z) to the collider footprint (0 inside). */
export function footprintDist(c: Collider, x: number, z: number): number {
  const dx = x - c.x, dz = z - c.z;
  if (c.kind === 'cyl') return Math.max(0, Math.hypot(dx, dz) - c.radius);
  const lx = dx * c.cos - dz * c.sin, lz = dx * c.sin + dz * c.cos;
  const ox = Math.max(0, Math.abs(lx) - c.halfX), oz = Math.max(0, Math.abs(lz) - c.halfZ);
  return Math.hypot(ox, oz);
}

/** On the ground a prop topples toward the nearest stable pose: upright (axis within ~37° of vertical) or lying on
 *  its flank (a cone rests with its axis atan(r/h) above horizontal). A spring on the axis direction stands in for the
 *  gravity torque about the contact edge; the ground damping above removes the energy. */
function settle(ps: PropState, h: number) {
  const q = ps.quat;
  const ux = 2 * (q.x * q.y - q.w * q.z), uy = 1 - 2 * (q.x * q.x + q.z * q.z), uz = 2 * (q.y * q.z + q.w * q.x); // local +Y in world
  let tx = 0, ty = 1, tz = 0;
  if (uy < 0.8) {
    const hl = Math.hypot(ux, uz), lie = Math.atan2(ps.spec.radius, ps.spec.height);
    const dx = hl > 1e-3 ? ux / hl : 1, dz = hl > 1e-3 ? uz / hl : 0;
    tx = dx * Math.cos(lie); ty = Math.sin(lie); tz = dz * Math.cos(lie);
  }
  const ax = uy * tz - uz * ty, ay = uz * tx - ux * tz, az = ux * ty - uy * tx; // u × t (|.| = sin of the angle)
  const k = 60 * h; ps.w.x += ax * k; ps.w.y += ay * k; ps.w.z += az * k;
}

function integrateQuat(q: { x: number; y: number; z: number; w: number }, w: { x: number; y: number; z: number }, h: number) {
  const hw = 0.5 * h;
  const qw = q.w - hw * (w.x * q.x + w.y * q.y + w.z * q.z), qx = q.x + hw * (w.x * q.w + w.y * q.z - w.z * q.y);
  const qy = q.y + hw * (w.y * q.w + w.z * q.x - w.x * q.z), qz = q.z + hw * (w.z * q.w + w.x * q.y - w.y * q.x);
  const l = Math.hypot(qw, qx, qy, qz) || 1; q.w = qw / l; q.x = qx / l; q.y = qy / l; q.z = qz / l;
}

export const colliders = new Registry();
export type ColliderRegistry = Registry;
