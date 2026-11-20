// Upper-body collision hull: elastic-plastic point contacts with friction anchors (bristle model).
// DOM-free. Used by Vehicle.step; ground only in Stage 1 (world colliders reuse the same law in Stage 2).
//
// Per point, against the ground:
//   P = pos + R·p;  h = heightAt(P);  n = ground normal (e = 0.15 m);  d = (h − P.y)·n.y
//   x  = d − δp                                   elastic deflection; δp = permanent crush (damage state and energy sink)
//   Fn = ke·x + ce·max(0, −vn)·min(1, x / 2 mm)   approach-only damper, never adhesive
//   if Fn > Fy + kp·δp (and δp < maxCrush): Δ = (Fn − Fy − kp·δp)/(ke + kp); δp += Δ; Fn −= ke·Δ; Wcrush += Fn·Δ
//   Ft = −kt·(Pt − anchor) − ct·vt, clamped to μ·Fn (the anchor slides when clamped)
// No artificial angular damping: spin is lost through plastic hits and friction at successive points.

import type { HullZone, VehicleParams } from './params';

type V3 = { x: number; y: number; z: number };

export interface HullGround { heightAt(x: number, z: number): number; surfaceAt(x: number, z: number): string }
/** What the hull needs from the vehicle each step (all world frame). */
export interface HullBody {
  pos: V3; vel: V3; w: V3;
  wheels: { centre: V3; steer: number; left: boolean }[];
}

/** Hardening multiplier beyond a zone's crush depth. */
export const HARDEN = 10;
/** Yield force (N) of hull point i at plastic set dp, with the load-spread factor f (concentrated loads). */
export function yieldForce(h: Hull, i: number, dp: number, f = 1) {
  const mc = h.maxC[i], kp = h.kp[i] * f;
  return h.Fy[i] * f + kp * (dp < mc ? dp : mc) + (dp > mc ? HARDEN * kp * (dp - mc) : 0);
}

export interface Dent { i: number; x: number; y: number; z: number; nx: number; ny: number; nz: number; depth: number; r: number; t: number; total: number }

export const HULL_ZONES: HullZone[] = ['front', 'roofRail', 'roofPanel', 'door', 'sill', 'mirror', 'tyre'];

export class Hull {
  readonly n: number;            // total points (body + 4 × tyre)
  readonly nBody: number;
  readonly px: Float64Array; readonly py: Float64Array; readonly pz: Float64Array; // body frame (tyre points: fore, up, side)
  readonly wheel: Int8Array;     // −1 body point, else wheel index
  readonly zone: HullZone[];
  readonly ke: Float64Array; readonly Fy: Float64Array; readonly kp: Float64Array; readonly maxC: Float64Array;
  /** Load-spread factor for concentrated (pole / edge) contacts on this point's zone. */
  readonly conc: Float64Array;
  /** Permanent crush per point (m). Kept through reset (towing the car back onto its wheels keeps the damage). */
  readonly dp: Float64Array;
  /** Last normal force per point (N), 0 when out of contact. */
  readonly Fn: Float64Array;
  /** Elastic deflection per point (m), for the energy audit. */
  readonly X: Float64Array;
  private ax: Float64Array; private ay: Float64Array; private az: Float64Array; private act: Uint8Array;
  /** Along-body-up force on each wheel from its sidewall points this step (N); the vehicle feeds it to the unsprung mass. */
  readonly wheelUp = new Float64Array(4);
  // energy bookkeeping (J, since the last repair) and per-step telemetry
  Wcrush = 0; Wfric = 0;
  crushWork: Record<HullZone, number>;
  contacts = 0; peakForce = 0; scrape = 0;
  private ce: number; private ceTyre: number; private kt: number; private ct: number;
  /** Contact parameters shared with the world-collider narrowphase (collide.ts). */
  get ceBody() { return this.ce; } get ceTyreSide() { return this.ceTyre; } get kTan() { return this.kt; } get cTan() { return this.ct; }
  get halfWidth() { return this.halfW; }
  /** True when a world collider touched a tyre sidewall this step (wheelUp holds its share). */
  wheelHit = false;
  /** Pending dents for the visual deformation (body frame), merged per point within 0.3 m; see takeDents(). */
  dents: Dent[] = [];
  /** New ground contacts of body points this step with their approach speed (m/s), for audio, camera and the recorder. */
  groundHits: { vn: number; zone: HullZone; i: number }[] = [];
  private lastHitT = new Float64Array(0);
  private bodyMu: Record<string, number>;
  private tyreMu: Record<string, number>;
  private halfW: number;
  // bounds for the O(1) upright cull
  private yMinBody = 0; private xMaxBody = 0; private zMaxBody = 0; private foreMax = 0; private upMin = 0;
  private nAct = 0;
  /** Sim time, set by the vehicle before step() (dent and hit time stamps). */
  tNow = 0;

  /** xOff: body-frame x of the geometric centreline (the body frame sits at the CG, which the driver moves off-centre). */
  constructor(P: VehicleParams, surfaces: Record<string, { mu: number }>, xOff = 0) {
    const pts = P.hullPoints.v, tp = P.hullTyrePoints.v, Z = P.hullZones.v;
    this.nBody = pts.length; this.n = pts.length + 4 * tp.length;
    const n = this.n;
    this.px = new Float64Array(n); this.py = new Float64Array(n); this.pz = new Float64Array(n);
    this.wheel = new Int8Array(n); this.zone = [];
    this.ke = new Float64Array(n); this.Fy = new Float64Array(n); this.kp = new Float64Array(n); this.maxC = new Float64Array(n);
    this.dp = new Float64Array(n); this.Fn = new Float64Array(n); this.X = new Float64Array(n);
    this.ax = new Float64Array(n); this.ay = new Float64Array(n); this.az = new Float64Array(n); this.act = new Uint8Array(n);
    this.conc = new Float64Array(n);
    const setZ = (i: number, z: HullZone) => { const s = Z[z]; this.zone[i] = z; this.ke[i] = s.ke; this.Fy[i] = s.Fy; this.kp[i] = s.kp; this.maxC[i] = s.maxCrush; this.conc[i] = P.hullConcentrated.v[z] ?? 1; };
    pts.forEach(([x, y, z, zone], i) => { this.px[i] = x + xOff; this.py[i] = y; this.pz[i] = z; this.wheel[i] = -1; setZ(i, zone); });
    let i = pts.length;
    for (let w = 0; w < 4; w++) for (const [fore, up] of tp) { this.px[i] = 0; this.py[i] = up; this.pz[i] = fore; this.wheel[i] = w; setZ(i, 'tyre'); i++; }
    this.ce = P.hullContactDamping.v; this.ceTyre = P.hullTyreDamping.v; this.kt = P.hullTangentialStiffness.v; this.ct = P.hullTangentialDamping.v;
    this.bodyMu = P.bodyGroundMu.v;
    this.tyreMu = {}; for (const k of Object.keys(surfaces)) this.tyreMu[k] = 0.7 * P.muPeak.v * surfaces[k].mu; // sidewall rubber sliding [A]
    this.halfW = P.tyreWidth.v / 2;
    for (let k = 0; k < this.nBody; k++) { this.yMinBody = Math.min(this.yMinBody, this.py[k]); this.xMaxBody = Math.max(this.xMaxBody, Math.abs(this.px[k])); this.zMaxBody = Math.max(this.zMaxBody, Math.abs(this.pz[k])); }
    for (const [fore, up] of tp) { this.foreMax = Math.max(this.foreMax, Math.abs(fore)); this.upMin = Math.min(this.upMin, up); }
    this.crushWork = Object.fromEntries(HULL_ZONES.map(z => [z, 0])) as Record<HullZone, number>;
    this.lastHitT = new Float64Array(n).fill(-1);
  }

  /** Records crush D (m) at a body-frame point with the push direction n (body frame, force on the car). r: contact
   *  radius hint (pole radius), −1 for a point contact. */
  addDent(i: number, x: number, y: number, z: number, nx: number, ny: number, nz: number, D: number, r: number, t: number) {
    if (this.wheel[i] >= 0 || D <= 0) return;
    for (const d of this.dents) if (d.i === i && Math.abs(d.x - x) + Math.abs(d.y - y) + Math.abs(d.z - z) < 0.3) {
      const k = D / (d.depth + D); d.x += (x - d.x) * k; d.y += (y - d.y) * k; d.z += (z - d.z) * k;
      d.nx += nx * D; d.ny += ny * D; d.nz += nz * D; d.depth += D; d.t = t; d.total = this.dp[i]; if (r > d.r) d.r = r; return;
    }
    if (this.dents.length >= 96) return;
    this.dents.push({ i, x, y, z, nx: nx * D, ny: ny * D, nz: nz * D, depth: D, r, t, total: this.dp[i] });
  }
  /** Dents not updated for minAge seconds (sim time), removed from the queue. */
  takeDents(t: number, minAge = 0.1): Dent[] {
    if (!this.dents.length) return [];
    const out: Dent[] = [], keep: Dent[] = [];
    for (const d of this.dents) (t - d.t >= minAge ? out : keep).push(d);
    this.dents = keep; return out;
  }

  /** Clears contact anchors (reset keeps the crush). */
  clearContacts() { this.act.fill(0); this.nAct = 0; this.Fn.fill(0); this.X.fill(0); this.wheelUp.fill(0); this.scrape = 0; this.contacts = 0; }
  /** Repairs all crush and clears the energy books. */
  repair() { this.dp.fill(0); this.Wcrush = 0; this.Wfric = 0; for (const z of HULL_ZONES) this.crushWork[z] = 0; this.clearContacts(); this.dents.length = 0; }
  maxCrush(zone?: HullZone) { let m = 0; for (let i = 0; i < this.n; i++) if ((!zone || this.zone[i] === zone) && this.dp[i] > m) m = this.dp[i]; return m; }
  /** Elastic energy stored in the point contacts (J), for the energy audit. */
  elasticEnergy() { let e = 0; for (let i = 0; i < this.n; i++) if (this.Fn[i] > 0) e += 0.5 * this.ke[i] * this.X[i] * this.X[i]; return e; }

  /**
   * Ground contact for every hull point. Adds forces/torques (about the CG) into Fb/Tb, fills wheelUp.
   * cullY: points whose world Y is above this are skipped without sampling (pass +Infinity to test all).
   */
  step(b: HullBody, left: V3, up: V3, fwd: V3, g: HullGround, cullY: number, dt: number, Fb: V3, Tb: V3) {
    const pos = b.pos, vel = b.vel, w = b.w;
    this.wheelUp[0] = this.wheelUp[1] = this.wheelUp[2] = this.wheelUp[3] = 0;
    this.contacts = 0; this.peakForce = 0; this.scrape = 0; this.wheelHit = false;
    if (this.groundHits.length) this.groundHits.length = 0;
    const ce = this.ce, kt = this.kt, ct = this.ct, e = 0.15;
    let wi = -1, cx = 0, cy = 0, cz = 0, axlx = 0, axly = 0, axlz = 0, hfx = 0, hfy = 0, hfz = 0, side = 0;
    // O(1) cull while upright: when even the lowest possible point of a group is above cullY, skip the group unsampled
    let i0 = 0;
    if (cullY !== Infinity && this.nAct === 0 && up.y > 0) {
      const lb = pos.y + up.y * this.yMinBody - Math.abs(left.y) * this.xMaxBody - Math.abs(fwd.y) * this.zMaxBody;
      if (lb > cullY) {
        i0 = this.nBody; let all = true;
        for (let k = 0; k < 4 && all; k++) { const c = b.wheels[k].centre; if (c.y + up.y * this.upMin - this.halfW - this.foreMax * Math.abs(fwd.y) - 0.3 * Math.abs(left.y) <= cullY) all = false; }
        if (all) return;
      }
    }
    for (let i = i0; i < this.n; i++) {
      const wh = this.wheel[i];
      let Px: number, Py: number, Pz: number;
      if (wh < 0) {
        const x = this.px[i], y = this.py[i], z = this.pz[i];
        Py = pos.y + left.y * x + up.y * y + fwd.y * z;
        if (Py > cullY) { if (this.act[i]) { this.act[i] = 0; this.Fn[i] = 0; this.X[i] = 0; this.nAct--; } continue; }
        Px = pos.x + left.x * x + up.x * y + fwd.x * z; Pz = pos.z + left.z * x + up.z * y + fwd.z * z;
      } else {
        if (wh !== wi) { // wheel frame: heading and axle (wheel's left) with steer, outboard side
          wi = wh; const W = b.wheels[wh]; const cs = Math.cos(W.steer), sn = Math.sin(W.steer);
          cx = W.centre.x; cy = W.centre.y; cz = W.centre.z; side = W.left ? 1 : -1;
          hfx = fwd.x * cs + left.x * sn; hfy = fwd.y * cs + left.y * sn; hfz = fwd.z * cs + left.z * sn;
          axlx = left.x * cs - fwd.x * sn; axly = left.y * cs - fwd.y * sn; axlz = left.z * cs - fwd.z * sn;
        }
        const fo = this.pz[i], uo = this.py[i], so = side * this.halfW;
        Py = cy + axly * so + hfy * fo + up.y * uo;
        if (Py > cullY) { if (this.act[i]) { this.act[i] = 0; this.Fn[i] = 0; this.X[i] = 0; this.nAct--; } continue; }
        Px = cx + axlx * so + hfx * fo + up.x * uo; Pz = cz + axlz * so + hfz * fo + up.z * uo;
      }
      const h = g.heightAt(Px, Pz);
      const d0 = h - Py, dpi = this.dp[i];
      if (d0 <= dpi) { if (this.act[i]) { this.act[i] = 0; this.Fn[i] = 0; this.X[i] = 0; this.nAct--; } continue; }
      // ground normal
      const hx = g.heightAt(Px + e, Pz) - g.heightAt(Px - e, Pz), hz = g.heightAt(Px, Pz + e) - g.heightAt(Px, Pz - e);
      let nx = -hx / (2 * e), ny = 1, nz = -hz / (2 * e); const nl = Math.hypot(nx, ny, nz); nx /= nl; ny /= nl; nz /= nl;
      const x = d0 * ny - dpi;
      if (x <= 0) { if (this.act[i]) { this.act[i] = 0; this.Fn[i] = 0; this.X[i] = 0; this.nAct--; } continue; }
      // point velocity (rigid body point)
      const rx = Px - pos.x, ry = Py - pos.y, rz = Pz - pos.z;
      const vx = vel.x + w.y * rz - w.z * ry, vy = vel.y + w.z * rx - w.x * rz, vz = vel.z + w.x * ry - w.y * rx;
      const vn = vx * nx + vy * ny + vz * nz;
      const ke = this.ke[i];
      // plastic yield on the elastic trial force (the spring is in series with the plastic element; the damper acts on
      // the elastic rate, so while the structure flows the damper adds nothing beyond the yield force)
      // beyond the zone's crush depth the structure behind it keeps yielding with 10x the hardening (engine block,
      // firewall, rim): never a rigid elastic stop that would hand the impact energy back as a rebound
      const mc = this.maxC[i], kpi = dpi < mc ? this.kp[i] : HARDEN * this.kp[i];
      const Fyl = yieldForce(this, i, dpi);
      let Fe = ke * x, D = 0;
      if (Fe > Fyl) {
        D = (Fe - Fyl) / (ke + kpi);
        this.dp[i] = dpi + D; Fe -= ke * D;
        const W = Fe * D; this.Wcrush += W; this.crushWork[this.zone[i]] += W;
        if (wh < 0) this.addDent(i, this.px[i], this.py[i], this.pz[i], nx * left.x + ny * left.y + nz * left.z, nx * up.x + ny * up.y + nz * up.z, nx * fwd.x + ny * fwd.y + nz * fwd.z, D, -1, this.tNow);
      }
      let Fn = Fe;
      if (vn < 0 && D === 0) { Fn += -vn * (wh < 0 ? ce : this.ceTyre) * Math.min(1, x / 0.002); if (Fn > Fyl && Fe <= Fyl) Fn = Math.max(Fe, Fyl); }
      // friction anchor (bristle)
      if (!this.act[i]) {
        this.act[i] = 1; this.nAct++; this.ax[i] = Px; this.ay[i] = Py; this.az[i] = Pz;
        if (wh < 0 && vn < -1 && this.tNow - this.lastHitT[i] > 0.1) { this.groundHits.push({ vn: -vn, zone: this.zone[i], i }); this.lastHitT[i] = this.tNow; }
      }
      let ex = Px - this.ax[i], ey = Py - this.ay[i], ez = Pz - this.az[i];
      const en = ex * nx + ey * ny + ez * nz; ex -= nx * en; ey -= ny * en; ez -= nz * en;
      const vtx = vx - nx * vn, vty = vy - ny * vn, vtz = vz - nz * vn;
      let ftx = -kt * ex - ct * vtx, fty = -kt * ey - ct * vty, ftz = -kt * ez - ct * vtz;
      const mu = wh < 0 ? (this.bodyMu[g.surfaceAt(Px, Pz)] ?? 0.45) : (this.tyreMu[g.surfaceAt(Px, Pz)] ?? 0.6);
      const ft = Math.hypot(ftx, fty, ftz), lim = mu * Fn;
      const vt = Math.hypot(vtx, vty, vtz);
      if (ft > lim) {
        const s = lim / ft; ftx *= s; fty *= s; ftz *= s;
        this.ax[i] = Px + ftx / kt; this.ay[i] = Py + fty / kt; this.az[i] = Pz + ftz / kt; // anchor slides
        this.Wfric += lim * vt * dt;
      }
      this.Fn[i] = Fn; this.X[i] = x - D; this.contacts++; if (Fn > this.peakForce) this.peakForce = Fn;
      if (vt > 0.3 && wh < 0) { const sc = Math.min(1, Fn / 2e4) * Math.min(1, vt / 3); if (sc > this.scrape) this.scrape = sc; }
      let fx = nx * Fn + ftx, fy = ny * Fn + fty, fz = nz * Fn + ftz;
      if (wh >= 0) { // sidewall: along-up part to the unsprung mass, the rest to the body at the point
        const fu = fx * up.x + fy * up.y + fz * up.z; this.wheelUp[wh] += fu; fx -= up.x * fu; fy -= up.y * fu; fz -= up.z * fu;
      }
      Fb.x += fx; Fb.y += fy; Fb.z += fz;
      Tb.x += ry * fz - rz * fy; Tb.y += rz * fx - rx * fz; Tb.z += rx * fy - ry * fx;
    }
  }
}
