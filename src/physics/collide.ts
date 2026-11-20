// Car body against world colliders (src/world/colliders.ts): broadphase list, narrowphase and contact response.
// DOM-free; used by Vehicle.step after the ground hull.
//
// Broadphase: every 16 steps (or when the registry changes) the colliders within 4 m + 0.05 s of travel are copied into
//   a near list. With nothing near, a step costs one counter increment.
// Narrowphase: the car is two body-frame boxes (lower body, cabin).
//   - Cylinders (trees, posts, poles): five spheres along the part of the axis that overlaps each car box; the deepest
//     sphere is the contact (one contact per collider and box), so thin poles cannot fall between hull points.
//   - Boxes (buildings, walls, signs boards, traffic): every hull point (body and tyre sidewall) against the box, by its
//     minimum-penetration face, plus the box's four vertical edges against the car boxes as zero-radius cylinders.
//   - Moving boxes: the same, with relative velocity; the struck object takes the reaction (registry coasts it after).
//   - Props (cones): knocked away through colliders.contact(); the 4 kg reaction on the car is ignored.
// Response: the hull's elastic-plastic law. Point contacts use and share the hull point's own crush δp (so ground and
//   walls add up in one damage state); sphere / edge contacts carry their own plastic set, start from the nearest hull
//   point's δp and write it back (max), so a pole that slides along the side leaves a continuous dent.
//   Contacts keep the face they entered through ("sticky"), so a deep crush never flips to a side face.
// Frangible colliders fail at breakForce: the object absorbs breakEnergy (taken from the car's motion along the contact).

import { colliders, footprintDist, type Collider, type ColliderMaterial } from '../world/colliders';
import { HARDEN, yieldForce, type Hull } from './hull';

type V3 = { x: number; y: number; z: number };
export interface CollideBody { pos: V3; vel: V3; w: V3; mTot: number; wheels: { centre: V3; steer: number; left: boolean }[] }

/** Car boxes, body frame (+X left, +Y up, +Z forward, origin at the CG): lower body and cabin. */
export const CAR_BOXES = [
  { hx: 0.9275, y0: -0.50, y1: 0.30, z0: -2.515, z1: 2.28 },
  { hx: 0.80, y0: 0.30, y1: 1.035, z0: -2.45, z1: 1.25 },
] as const;
const R_CAR = 2.95;                         // bounding radius about the CG (box corners 2.87 m, mirrors)
// body-frame footprint used for the quick separating-axis reject (mirrors included)
const FX = 1.06, FY0 = -0.5, FY1 = 1.035, FZ0 = -2.515, FZ1 = 2.28;
const FCY = (FY0 + FY1) / 2, FHY = (FY1 - FY0) / 2, FCZ = (FZ0 + FZ1) / 2, FHZ = (FZ1 - FZ0) / 2;

interface Slot {
  key: number; seen: number; face: number; dp: number; pt: number;
  ax: number; ay: number; az: number; anchored: boolean;
  J: number; v0: number; started: boolean; E: number;
}

/** A body impact (new contact) for audio / camera / the crash recorder. */
export interface BodyHit { energy: number; vn: number; zone: string; material: ColliderMaterial | 'ground'; tag: string; id: number; force: number }

export class CarCollide {
  /** Colliders near the car (refreshed every 16 steps). */
  near: Collider[] = []; nNear = 0;
  /** Contacts with force this step, the largest contact force (N) and summed force vector this step. */
  contacts = 0; peakForce = 0;
  /** Energy taken by breaking objects (J) and body friction on objects (J) since the last repair/reset of the books. */
  Wbreak = 0; Wfric = 0;
  /** New body hits this step (cleared every step that has contacts). */
  hits: BodyHit[] = [];
  /** Every collider struck since clearStruck(): id → tag. Props (cones) included. */
  struck = new Map<number, string>();
  /** Props knocked since clearStruck(). */
  propsHit = 0;
  private stepN = 15; private ver = -1;
  private slots = new Map<number, Slot>(); private pool: Slot[] = []; private stamp = 0;
  private t = 0;
  // per-step basis (body axes in world)
  private L!: V3; private U!: V3; private F!: V3;
  private b!: CollideBody; private hull!: Hull; private Fb!: V3; private Tb!: V3; private dt = 0.001;

  /** Forget contact states (reset / teleport). */
  clear() { for (const s of this.slots.values()) this.pool.push(s); this.slots.clear(); this.stepN = 15; this.ver = -1; this.nNear = 0; this.hits.length = 0; }
  clearStruck() { this.struck.clear(); this.propsHit = 0; }

  step(b: CollideBody, hull: Hull, left: V3, up: V3, fwd: V3, t: number, dt: number, Fb: V3, Tb: V3) {
    this.contacts = 0; if (this.hits.length) this.hits.length = 0;
    if (++this.stepN >= 16 || colliders.version !== this.ver) {
      this.stepN = 0; this.ver = colliders.version;
      const sp = Math.hypot(b.vel.x, b.vel.y, b.vel.z);
      this.nNear = colliders.queryCircle(b.pos.x, b.pos.z, 4 + 0.05 * sp, this.near);
    }
    if (this.nNear === 0) { if (this.slots.size) this.releaseAll(); return; }
    this.peakForce = 0;
    this.b = b; this.hull = hull; this.L = left; this.U = up; this.F = fwd; this.t = t; this.dt = dt; this.Fb = Fb; this.Tb = Tb;
    const st = ++this.stamp;
    const pos = b.pos;
    // car centre and its half extent along world Y (for the vertical reject)
    const ccx = pos.x + up.x * FCY + fwd.x * FCZ, ccy = pos.y + up.y * FCY + fwd.y * FCZ, ccz = pos.z + up.z * FCY + fwd.z * FCZ;
    const eY = FX * Math.abs(left.y) + FHY * Math.abs(up.y) + FHZ * Math.abs(fwd.y);
    for (let k = 0; k < this.nNear; k++) {
      const c = this.near[k];
      if (!c.enabled || c.broken) continue;
      if (c.y0 > ccy + eY + 0.05 || c.y1 < ccy - eY - 0.05) continue;
      if (footprintDist(c, pos.x, pos.z) > R_CAR) continue;
      if (c.kind === 'cyl') { this.cylinder(c, c.x, c.z, c.radius, 0); continue; }
      // boxes: separating-axis reject of the two footprints (horizontal) before any per-point work
      if (!this.boxOverlaps(c, ccx, ccz)) continue;
      this.boxPoints(c);
      const hx = c.halfX, hz = c.halfZ;
      for (let e = 0; e < 4; e++) {
        const lx = e & 1 ? hx : -hx, lz = e & 2 ? hz : -hz;
        this.cylinder(c, c.x + lx * c.cos + lz * c.sin, c.z - lx * c.sin + lz * c.cos, 0, 2 + 2 * e);
      }
    }
    // release contacts not touched this step
    for (const [k, s] of this.slots) if (s.seen !== st) { this.slots.delete(k); this.pool.push(s); }
  }

  /** Elastic energy stored in the object contacts (J), for the energy audit. */
  elasticEnergy() { let e = 0; for (const s of this.slots.values()) e += s.E; return e; }

  private releaseAll() { for (const s of this.slots.values()) this.pool.push(s); this.slots.clear(); }

  private slot(key: number, create: boolean): Slot | undefined {
    let s = this.slots.get(key);
    if (!s && create) {
      s = this.pool.pop() ?? { key: 0, seen: 0, face: -1, dp: 0, pt: -1, ax: 0, ay: 0, az: 0, anchored: false, J: 0, v0: 0, started: false, E: 0 };
      s.key = key; s.E = 0; s.face = -1; s.dp = 0; s.pt = -1; s.anchored = false; s.J = 0; s.v0 = 0; s.started = false;
      this.slots.set(key, s);
    }
    if (s) s.seen = this.stamp;
    return s;
  }

  private axes = new Float64Array(8);
  /** Horizontal SAT between the collider box footprint and the car's (tilt-aware) footprint, 0.1 m margin. */
  private boxOverlaps(c: Collider, ccx: number, ccz: number) {
    const L = this.L, U = this.U, F = this.F;
    const dx = ccx - c.x, dz = ccz - c.z;
    const axes = this.axes; axes[0] = c.cos; axes[1] = -c.sin; axes[2] = c.sin; axes[3] = c.cos;
    const fl = Math.hypot(F.x, F.z); let na = 4;
    if (fl > 1e-6) { axes[4] = F.x / fl; axes[5] = F.z / fl; axes[6] = -F.z / fl; axes[7] = F.x / fl; na = 8; }
    for (let a = 0; a < na; a += 2) {
      const ux = axes[a], uz = axes[a + 1];
      const car = FX * Math.abs(ux * L.x + uz * L.z) + FHY * Math.abs(ux * U.x + uz * U.z) + FHZ * Math.abs(ux * F.x + uz * F.z);
      const box = c.halfX * Math.abs(ux * c.cos - uz * c.sin) + c.halfZ * Math.abs(ux * c.sin + uz * c.cos);
      if (Math.abs(dx * ux + dz * uz) > car + box + 0.1) return false;
    }
    return true;
  }

  /** Vertical cylinder (radius r, may be 0 for a box edge) against both car boxes. feat: slot feature base. */
  private cylinder(c: Collider, cx: number, cz: number, r: number, feat: number) {
    const pos = this.b.pos, L = this.L, U = this.U, F = this.F;
    const dx = cx - pos.x, dy = c.y0 - pos.y, dz = cz - pos.z;
    const ax = dx * L.x + dy * L.y + dz * L.z, ay = dx * U.x + dy * U.y + dz * U.z, az = dx * F.x + dy * F.y + dz * F.z;
    const ex = L.y, ey = U.y, ez = F.y; // world +Y in the body frame
    const H = c.y1 - c.y0;
    const isProp = c.breakForce === 0 && c.mass < Infinity;
    for (let bi = 0; bi < 2; bi++) {
      const B = CAR_BOXES[bi];
      // clip the axis against the box expanded by r (slabs)
      this.s0 = 0; this.s1 = H;
      this.clip(ax, ex, -B.hx - r, B.hx + r); if (this.s0 <= this.s1) this.clip(ay, ey, B.y0 - r, B.y1 + r); if (this.s0 <= this.s1) this.clip(az, ez, B.z0 - r, B.z1 + r);
      const s0 = this.s0, s1 = this.s1;
      const key = c.id * 512 + feat + bi;
      if (s0 > s1) continue;
      const sl = this.slots.get(key);
      const sticky = sl ? sl.face : -1;
      // deepest of five spheres
      let best = -Infinity, bpx = 0, bpy = 0, bpz = 0, bnx = 0, bny = 0, bnz = 0, bface = -1;
      for (let k = 0; k < 5; k++) {
        const s = s0 + (s1 - s0) * k / 4;
        const qx = ax + ex * s, qy = ay + ey * s, qz = az + ez * s;
        const px = qx < -B.hx ? -B.hx : qx > B.hx ? B.hx : qx, py = qy < B.y0 ? B.y0 : qy > B.y1 ? B.y1 : qy, pz = qz < B.z0 ? B.z0 : qz > B.z1 ? B.z1 : qz;
        const ddx = qx - px, ddy = qy - py, ddz = qz - pz, d2 = ddx * ddx + ddy * ddy + ddz * ddz;
        let depth: number, nx: number, ny: number, nz: number, cpx: number, cpy: number, cpz: number, face: number;
        if (d2 > 0) {
          const d = Math.sqrt(d2); depth = r - d; if (depth <= best) continue;
          nx = ddx / d; ny = ddy / d; nz = ddz / d; cpx = px; cpy = py; cpz = pz;
          const ax_ = Math.abs(ddx), ay_ = Math.abs(ddy), az_ = Math.abs(ddz);
          face = ax_ >= ay_ && ax_ >= az_ ? (ddx > 0 ? 0 : 1) : ay_ >= az_ ? (ddy > 0 ? 2 : 3) : (ddz > 0 ? 4 : 5);
        } else {
          const fd0 = B.hx - qx, fd1 = qx + B.hx, fd2 = B.y1 - qy, fd3 = qy - B.y0, fd4 = B.z1 - qz, fd5 = qz - B.z0;
          face = sticky;
          if (face < 0) { face = 0; let m = fd0; if (fd1 < m) { m = fd1; face = 1; } if (fd2 < m) { m = fd2; face = 2; } if (fd3 < m) { m = fd3; face = 3; } if (fd4 < m) { m = fd4; face = 4; } if (fd5 < m) { m = fd5; face = 5; } }
          const fd = face === 0 ? fd0 : face === 1 ? fd1 : face === 2 ? fd2 : face === 3 ? fd3 : face === 4 ? fd4 : fd5;
          depth = r + fd; if (depth <= best) continue;
          nx = face === 0 ? 1 : face === 1 ? -1 : 0; ny = face === 2 ? 1 : face === 3 ? -1 : 0; nz = face === 4 ? 1 : face === 5 ? -1 : 0;
          cpx = qx + nx * fd; cpy = qy + ny * fd; cpz = qz + nz * fd;
        }
        best = depth; bpx = cpx; bpy = cpy; bpz = cpz; bnx = nx; bny = ny; bnz = nz; bface = face;
      }
      if (!(best > 0)) continue;
      // world contact point and normal (collider → car = −outward normal of the car box)
      const Px = pos.x + L.x * bpx + U.x * bpy + F.x * bpz, Py = pos.y + L.y * bpx + U.y * bpy + F.y * bpz, Pz = pos.z + L.z * bpx + U.z * bpy + F.z * bpz;
      const nx = -(L.x * bnx + U.x * bny + F.x * bnz), ny = -(L.y * bnx + U.y * bny + F.y * bnz), nz = -(L.z * bnx + U.z * bny + F.z * bnz);
      if (isProp) { this.knockProp(c, Px, Py, Pz, nx, ny, nz); return; }
      const s = this.slot(key, true)!;
      if (s.face < 0 || best < 0.02) s.face = bface;
      if (s.pt < 0 || !s.started) { s.pt = this.nearestPoint(bpx, bpy, bpz); s.dp = this.hull.dp[s.pt]; }
      else s.pt = this.nearestPoint(bpx, bpy, bpz);
      this.respond(c, s, s.pt, false, best, Px, Py, Pz, nx, ny, nz, -1, bpx, bpy, bpz, -bnx, -bny, -bnz, r);
    }
  }

  private s0 = 0; private s1 = 0;
  private clip(o: number, d: number, lo: number, hi: number) {
    if (d > -1e-9 && d < 1e-9) { if (o < lo || o > hi) this.s1 = -1; return; }
    let t1 = (lo - o) / d, t2 = (hi - o) / d; if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; }
    if (t1 > this.s0) this.s0 = t1; if (t2 < this.s1) this.s1 = t2;
  }

  private nearestPoint(x: number, y: number, z: number) {
    const h = this.hull; let bi = 0, bd = Infinity;
    for (let i = 0; i < h.nBody; i++) { const dx = h.px[i] - x, dy = h.py[i] - y, dz = h.pz[i] - z, d = dx * dx + dy * dy + dz * dz; if (d < bd) { bd = d; bi = i; } }
    return bi;
  }

  /** Every hull point (body and tyre sidewalls) against a box collider. */
  private boxPoints(c: Collider) {
    const h = this.hull, b = this.b, pos = b.pos, L = this.L, U = this.U, F = this.F;
    const cs = c.cos, sn = c.sin, hx = c.halfX, hz = c.halfZ;
    let wi = -1, cx = 0, cy = 0, cz = 0, axlx = 0, axly = 0, axlz = 0, hfx = 0, hfy = 0, hfz = 0, side = 0;
    const halfW = h.halfWidth;
    for (let i = 0; i < h.n; i++) {
      const wh = h.wheel[i];
      let Px: number, Py: number, Pz: number;
      if (wh < 0) {
        const x = h.px[i], y = h.py[i], z = h.pz[i];
        Px = pos.x + L.x * x + U.x * y + F.x * z; Py = pos.y + L.y * x + U.y * y + F.y * z; Pz = pos.z + L.z * x + U.z * y + F.z * z;
      } else {
        if (wh !== wi) {
          wi = wh; const W = b.wheels[wh]; const c2 = Math.cos(W.steer), s2 = Math.sin(W.steer);
          cx = W.centre.x; cy = W.centre.y; cz = W.centre.z; side = W.left ? 1 : -1;
          hfx = F.x * c2 + L.x * s2; hfy = F.y * c2 + L.y * s2; hfz = F.z * c2 + L.z * s2;
          axlx = L.x * c2 - F.x * s2; axly = L.y * c2 - F.y * s2; axlz = L.z * c2 - F.z * s2;
        }
        const fo = h.pz[i], uo = h.py[i], so = side * halfW;
        Px = cx + axlx * so + hfx * fo + U.x * uo; Py = cy + axly * so + hfy * fo + U.y * uo; Pz = cz + axlz * so + hfz * fo + U.z * uo;
      }
      if (Py > c.y1 + 0.02 || Py < c.y0) continue;
      const dx = Px - c.x, dz = Pz - c.z;
      const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
      const key = c.id * 512 + 16 + i;
      const sl = this.slots.get(key);
      let face = -1, depth = 0;
      const pxp = hx - lx, pxm = hx + lx, pzp = hz - lz, pzm = hz + lz, ptop = c.y1 - Py;
      if (sl && sl.face >= 0) {
        // sticky: semi-infinite behind the entry face (a deep crush passes through a thin wall without losing contact)
        face = sl.face;
        const latOk = face < 2 ? Math.abs(lz) <= hz + 0.05 : face < 4 ? Math.abs(lx) <= hx + 0.05 : Math.abs(lx) <= hx + 0.05 && Math.abs(lz) <= hz + 0.05;
        depth = face === 0 ? pxm : face === 1 ? pxp : face === 2 ? pzm : face === 3 ? pzp : ptop;
        if (!latOk || depth <= 0 || depth > 2.5) continue;
      } else {
        if (pxp <= 0 || pxm <= 0 || pzp <= 0 || pzm <= 0 || ptop < 0) continue;
        // face the point entered through: the least penetration (0/1: ±X side faces, 2/3: ±Z, 4: top)
        face = 0; depth = pxm; if (pxp < depth) { depth = pxp; face = 1; } if (pzm < depth) { depth = pzm; face = 2; } if (pzp < depth) { depth = pzp; face = 3; } if (ptop < depth) { depth = ptop; face = 4; }
      }
      // outward face normal (world), collider → car
      let nx = 0, ny = 0, nz = 0;
      if (face === 0) { nx = -cs; nz = sn; } else if (face === 1) { nx = cs; nz = -sn; } else if (face === 2) { nx = -sn; nz = -cs; } else if (face === 3) { nx = sn; nz = cs; } else ny = 1;
      const s = this.slot(key, true)!; if (s.face < 0) s.face = face;
      const bx = (Px - pos.x) * L.x + (Py - pos.y) * L.y + (Pz - pos.z) * L.z, by = (Px - pos.x) * U.x + (Py - pos.y) * U.y + (Pz - pos.z) * U.z, bz = (Px - pos.x) * F.x + (Py - pos.y) * F.y + (Pz - pos.z) * F.z;
      const nbx = nx * L.x + ny * L.y + nz * L.z, nby = nx * U.x + ny * U.y + nz * U.z, nbz = nx * F.x + ny * F.y + nz * F.z;
      this.respond(c, s, i, true, depth, Px, Py, Pz, nx, ny, nz, wh, bx, by, bz, nbx, nby, nbz, -1);
    }
  }

  /** Elastic-plastic normal force + bristle friction at a world point; adds into Fb/Tb. */
  private respond(c: Collider, s: Slot, i: number, usePoint: boolean, depth: number, Px: number, Py: number, Pz: number,
    nx: number, ny: number, nz: number, wh: number, bx: number, by: number, bz: number, nbx: number, nby: number, nbz: number, rCol: number) {
    const h = this.hull, b = this.b, pos = b.pos, vel = b.vel, w = b.w, dt = this.dt;
    const dpi = usePoint ? h.dp[i] : s.dp;
    const x = depth - dpi;
    // relative velocity of the car point against the collider surface
    const rx = Px - pos.x, ry = Py - pos.y, rz = Pz - pos.z;
    let vx = vel.x + w.y * rz - w.z * ry, vy = vel.y + w.z * rx - w.x * rz, vz = vel.z + w.x * ry - w.y * rx;
    const moving = c.kind === 'moving';
    if (moving) { vx -= c.vx + c.yawRate * (Pz - c.z); vz -= c.vz - c.yawRate * (Px - c.x); }
    const vn = vx * nx + vy * ny + vz * nz;
    if (!s.started) { s.v0 = -vn; }
    if (x <= 0) { s.anchored = false; s.E = 0; return; }
    // a concentrated load (pole, box edge) loads the whole structure through the bumper beam: zone factor (params)
    const f = usePoint ? 1 : h.conc[i];
    const ke = h.ke[i], maxC = h.maxC[i], kp = h.kp[i] * f * (dpi < maxC ? 1 : HARDEN);
    const Fyl = yieldForce(h, i, dpi, f);
    let Fe = ke * x, D = 0;
    if (Fe > Fyl) {
      D = (Fe - Fyl) / (ke + kp);
      Fe -= ke * D;
      const W = Fe * D; h.Wcrush += W; h.crushWork[h.zone[i]] += W;
      if (usePoint) h.dp[i] = dpi + D; else { s.dp = dpi + D; if (s.dp > h.dp[i]) h.dp[i] = s.dp; }
      h.addDent(i, bx, by, bz, nbx, nby, nbz, D, rCol >= 0 ? rCol : -1, this.t);
    }
    let Fn = Fe;
    if (vn < 0 && D === 0) { Fn += -vn * (wh < 0 ? h.ceBody : h.ceTyreSide) * Math.min(1, x / 0.002); if (Fn > Fyl && Fe <= Fyl) Fn = Math.max(Fe, Fyl); }
    s.E = 0.5 * Fe * Fe / ke;
    // frangible object: it fails at breakForce
    let absorbed = 0;
    if (Fn >= c.breakForce) {
      Fn = c.breakForce;
      absorbed = colliders.contact(c.id, this.t, Px, Py, Pz, nx, ny, nz, Fn, s.J + Fn * dt, s.v0, vx, vy, vz);
    } else if (!s.started || s.J === 0 || ((this.stamp & 7) === 0)) {
      colliders.contact(c.id, this.t, Px, Py, Pz, nx, ny, nz, Fn, s.J + Fn * dt, s.v0, vx, vy, vz);
    }
    s.J += Fn * dt;
    if (!s.started) {
      s.started = true;
      if (!this.struck.has(c.id)) this.struck.set(c.id, c.tag || c.material);
      const v0 = Math.max(0, s.v0);
      this.hits.push({ energy: 0.5 * b.mTot * v0 * v0, vn: v0, zone: h.zone[i], material: c.material, tag: c.tag, id: c.id, force: Fn });
    }
    // friction: bristle anchor on fixed objects, regularised Coulomb on moving ones
    const vtx = vx - nx * vn, vty = vy - ny * vn, vtz = vz - nz * vn, vt = Math.hypot(vtx, vty, vtz);
    const mu = c.mu, lim = mu * Fn;
    let ftx: number, fty: number, ftz: number;
    if (!moving) {
      const kt = h.kTan, ct = h.cTan;
      if (!s.anchored) { s.anchored = true; s.ax = Px; s.ay = Py; s.az = Pz; }
      let ex = Px - s.ax, ey = Py - s.ay, ez = Pz - s.az;
      const en = ex * nx + ey * ny + ez * nz; ex -= nx * en; ey -= ny * en; ez -= nz * en;
      ftx = -kt * ex - ct * vtx; fty = -kt * ey - ct * vty; ftz = -kt * ez - ct * vtz;
      const ft = Math.hypot(ftx, fty, ftz);
      if (ft > lim) { const k = lim / ft; ftx *= k; fty *= k; ftz *= k; s.ax = Px + ftx / kt; s.ay = Py + fty / kt; s.az = Pz + ftz / kt; this.Wfric += lim * vt * dt; }
    } else {
      const f = Math.min(lim, 2e4 * vt) / (vt || 1); ftx = -vtx * f; fty = -vty * f; ftz = -vtz * f; this.Wfric += f * vt * vt * dt;
    }
    let fx = nx * Fn + ftx, fy = ny * Fn + fty, fz = nz * Fn + ftz;
    // energy the broken object took: one impulse against the relative motion at the contact
    if (absorbed > 0 && Number.isFinite(absorbed)) {
      const vr = Math.hypot(vx, vy, vz);
      if (vr > 0.05) {
        const m = b.mTot, dv = vr - Math.sqrt(Math.max(0, vr * vr - 2 * absorbed / m));
        const k = m * dv / dt / vr; fx -= vx * k; fy -= vy * k; fz -= vz * k;
        this.Wbreak += absorbed;
      }
    }
    if (moving && c.mass < Infinity) {
      c.vx -= fx / c.mass * dt; c.vz -= fz / c.mass * dt;
      const Iz = c.mass * (c.halfX * c.halfX + c.halfZ * c.halfZ) / 3;
      c.yawRate -= ((Pz - c.z) * fx - (Px - c.x) * fz) / Iz * dt;
    }
    if (wh >= 0) { // tyre sidewall: along-up part to the unsprung mass
      const U = this.U; const fu = fx * U.x + fy * U.y + fz * U.z; h.wheelUp[wh] += fu; h.wheelHit = true; fx -= U.x * fu; fy -= U.y * fu; fz -= U.z * fu;
    }
    const Fb = this.Fb, Tb = this.Tb;
    Fb.x += fx; Fb.y += fy; Fb.z += fz;
    Tb.x += ry * fz - rz * fy; Tb.y += rz * fx - rx * fz; Tb.z += rx * fy - ry * fx;
    this.contacts++; if (Fn > this.peakForce) this.peakForce = Fn;
  }

  private knockProp(c: Collider, Px: number, Py: number, Pz: number, nx: number, ny: number, nz: number) {
    const b = this.b, pos = b.pos, vel = b.vel, w = b.w;
    const rx = Px - pos.x, ry = Py - pos.y, rz = Pz - pos.z;
    const vx = vel.x + w.y * rz - w.z * ry, vy = vel.y + w.z * rx - w.x * rz, vz = vel.z + w.x * ry - w.y * rx;
    colliders.contact(c.id, this.t, Px, Py, Pz, nx, ny, nz, 0, 0, Math.hypot(vx, vz), vx, vy, vz);
    this.propsHit++; this.struck.set(c.id, c.tag || 'prop');
  }
}
