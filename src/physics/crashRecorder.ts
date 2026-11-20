// Crash recorder (PLAN_crash_damage_mirrors.md §5). DOM-free: the vehicle feeds it every physics step; the UI shows
// the finished reports. No injury figures: nothing in the model supports them.
//
// An event opens on a body hit (hull ground contact or a world collider over 5 kN), on more than 3 g (10 ms average),
// or on a tilt beyond 60°. It closes after 1 s at rest, after 3 s of driving on (upright, no body contact), or after 20 s.
// Knocking a cone opens a "minor" event: it is logged but does not pop up.

import type { Vehicle } from './vehicle';
import { DAMAGE_ZONES, ZONE_LABEL, type DamageZone } from './damage';
import type { HullZone } from './params';

const G = 9.81, D2R = Math.PI / 180;
/** Literature band for the mean deceleration of a vehicle from trip to rest in a rollover [M]. */
export const ROLL_DECEL_BAND: [number, number] = [0.36, 0.61];

export interface CrashReport {
  id: number; title: string; minor: boolean; when?: string;
  rows: [string, string][];
  series: { name: string; t: number[]; y: number[]; unit: string }[];
  data: Record<string, unknown>;
  note: string;
}

type V3 = { x: number; y: number; z: number };

export class CrashRecorder {
  open = false;
  /** Finished reports not yet taken by the UI. */
  done: CrashReport[] = [];
  /** True while an open event is more than a cone strike (HUD shows the crash line). */
  get serious() { return this.open && !this.minor; }
  /** Live values while open (HUD). */
  rollRel = 0; quarterTurns = 0;
  /** Sim time of the last opening (for tests). */
  openedAt = -1;
  /** The latest finished report (kept after the UI takes `done`), and its id (0 = none yet). */
  last: CrashReport | null = null;
  get lastId() { return this.last ? this.last.id : 0; }
  private n = 0;
  // 10 ms rings: CG and driver's seat velocity (world)
  private rc = new Float64Array(11 * 3); private rs = new Float64Array(11 * 3); private ri = 0; private filled = 0;
  private gCG = 0; private gSeat = 0;
  // event state
  private t0 = 0; private tAcc = 0; private restT = 0; private calmT = 0;
  private v0 = 0; private slip0 = 0; private pos0: V3 = { x: 0, y: 0, z: 0 }; private path = 0;
  private roll0 = 0; private pitch0 = 0; private rollMax = 0; private pitchMax = 0; private rollRateMax = 0;
  private air = 0; private peakH = 0; private peakG = 0; private peakGSeat = 0;
  private imp = { x: 0, z: 0, n: 0 }; private firstZone = ''; private firstHit = '';
  private crush0: Record<HullZone, number> = {} as Record<HullZone, number>; private Wc0 = 0; private Wf0 = 0; private Wb0 = 0; private Wcf0 = 0;
  private E0 = 0; private minor = true; private trigger = ''; private lastCT = 0; private posC: V3 = { x: 0, y: 0, z: 0 };
  private dpPt0 = new Float64Array(0);
  private ser = { t: [] as number[], v: [] as number[], roll: [] as number[], g: [] as number[] };
  private serT = 0;

  /** Called by Vehicle.step after the body moved. up/fwd/left: body axes (world). */
  update(v: Vehicle, up: V3, fwd: V3, left: V3, dt: number) {
    // 10 ms average acceleration at the CG and at the driver's seat (coordinate acceleration, gravity excluded)
    const k = this.ri * 3, rc = this.rc, rs = this.rs;
    const sx = -0.38, sy = 0.1, sz = 0.25; // driver's hip point, body frame (RHD: driver on −X)
    const rx = left.x * sx + up.x * sy + fwd.x * sz, ry = left.y * sx + up.y * sy + fwd.y * sz, rz = left.z * sx + up.z * sy + fwd.z * sz;
    const w = v.w, vel = v.vel;
    rc[k] = vel.x; rc[k + 1] = vel.y; rc[k + 2] = vel.z;
    rs[k] = vel.x + w.y * rz - w.z * ry; rs[k + 1] = vel.y + w.z * rx - w.x * rz; rs[k + 2] = vel.z + w.x * ry - w.y * rx;
    this.ri = this.ri === 10 ? 0 : this.ri + 1; if (this.filled < 11) { this.filled++; return; }
    const o = this.ri * 3;
    this.gCG = Math.hypot(rc[k] - rc[o], rc[k + 1] - rc[o + 1], rc[k + 2] - rc[o + 2]) / (0.01 * G);
    this.gSeat = Math.hypot(rs[k] - rs[o], rs[k + 1] - rs[o + 1], rs[k + 2] - rs[o + 2]) / (0.01 * G);
    const hull = v.hull, col = v.collide;
    const bodyHit = (hull.contacts > 0 && hull.peakForce > 5e3) || (col.contacts > 0 && col.peakForce > 5e3);
    // opening needs motion: a new contact arriving at > 1 m/s, or a loaded contact while the car still moves (a car
    // resting on its side or against a wall keeps its contacts without starting a new event)
    const moving = vel.x * vel.x + vel.y * vel.y + vel.z * vel.z > 4 || w.x * w.x + w.y * w.y + w.z * w.z > 1;
    let newHit = hull.groundHits.length > 0; for (const h of col.hits) if (h.vn > 0.5) newHit = true;
    if (!this.open) {
      const tilt = up.y < 0.5;
      const quiet = v.t - this.closedAt < 3; // just after an event: only a new body hit or a moving tilt opens another
      const hitOpen = newHit || (bodyHit && moving);
      if (hitOpen || (this.gCG > 3 && !quiet) || (tilt && moving) || col.propsHit > 0) this.begin(v, up, fwd, left, hitOpen ? 'body hit' : this.gCG > 3 ? `${this.gCG.toFixed(1)} g` : tilt ? 'tilt > 60°' : 'cone');
      else return;
    }
    this.step(v, up, fwd, left, dt, bodyHit);
  }

  private begin(v: Vehicle, up: V3, fwd: V3, left: V3, why: string) {
    this.open = true; this.trigger = why; this.openedAt = v.t;
    this.t0 = v.t; this.tAcc = 0; this.restT = 0; this.calmT = 0; this.path = 0;
    const vl = v.vel.x * fwd.x + v.vel.y * fwd.y + v.vel.z * fwd.z, vs = v.vel.x * left.x + v.vel.y * left.y + v.vel.z * left.z;
    this.v0 = Math.hypot(v.vel.x, v.vel.y, v.vel.z); this.slip0 = Math.abs(vl) + Math.abs(vs) > 0.5 ? Math.atan2(-vs, Math.abs(vl)) * Math.sign(vl || 1) : 0;
    this.pos0 = { x: v.pos.x, y: v.pos.y, z: v.pos.z };
    this.roll0 = v.rollTotal; this.pitch0 = v.pitchTotal; this.rollMax = 0; this.pitchMax = 0; this.rollRateMax = 0;
    this.air = 0; this.peakH = 0; this.peakG = 0; this.peakGSeat = 0; this.imp = { x: 0, z: 0, n: 0 }; this.firstZone = ''; this.firstHit = '';
    const h = v.hull; this.crush0 = { ...h.crushWork }; this.Wc0 = h.Wcrush; this.Wf0 = h.Wfric; this.Wb0 = v.collide.Wbreak; this.Wcf0 = v.collide.Wfric;
    this.dpPt0 = Float64Array.from(h.dp);
    this.E0 = this.kinetic(v);
    this.minor = why === 'cone';
    v.damage.clearPeaks(); this.lastCT = v.t; this.posC = { x: v.pos.x, y: v.pos.y, z: v.pos.z };
    this.ser = { t: [], v: [], roll: [], g: [] }; this.serT = 0;
  }

  private kinetic(v: Vehicle) {
    const sp2 = v.vel.x ** 2 + v.vel.y ** 2 + v.vel.z ** 2;
    const q = v.q, w = v.w; // ½ωᵀIω with ω in the body frame
    const cx = -q.x, cy = -q.y, cz = -q.z, cw = q.w;
    const ix = cw * w.x + cy * w.z - cz * w.y, iy = cw * w.y + cz * w.x - cx * w.z, iz = cw * w.z + cx * w.y - cy * w.x, iw = -cx * w.x - cy * w.y - cz * w.z;
    const bx = ix * cw + iw * -cx + iy * -cz - iz * -cy, by = iy * cw + iw * -cy + iz * -cx - ix * -cz, bz = iz * cw + iw * -cz + ix * -cy - iy * -cx;
    let spin = 0; for (const wh of v.wheels) spin += 0.5 * (v.P.wheelInertia.v + (wh.driven || v.driveMode !== '2H' ? 0.35 : 0)) * wh.omega * wh.omega;
    return 0.5 * v.mTot * sp2 + 0.5 * (v.I.x * bx * bx + v.I.y * by * by + v.I.z * bz * bz) + spin;
  }

  private step(v: Vehicle, up: V3, fwd: V3, left: V3, dt: number, bodyHit: boolean) {
    const t = v.t - this.t0;
    const sp = Math.hypot(v.vel.x, v.vel.y, v.vel.z);
    this.path += sp * dt;
    if (bodyHit || v.collide.contacts) this.minor = false;
    if (v.hull.contacts || v.collide.contacts) { this.lastCT = v.t; this.posC.x = v.pos.x; this.posC.y = v.pos.y; this.posC.z = v.pos.z; }
    if (this.gCG > 3 || up.y < 0.5) this.minor = false;
    // principal direction of force: impulse of the body contacts over the first 150 ms (body frame, horizontal)
    if (t < 0.15 && (v.hull.contacts || v.collide.contacts)) {
      const a = v.lastBodyForce; const fx = a.x * left.x + a.y * left.y + a.z * left.z, fz = a.x * fwd.x + a.y * fwd.y + a.z * fwd.z;
      this.imp.x += fx * dt; this.imp.z += fz * dt; this.imp.n++;
      if (!this.firstZone) { this.firstZone = v.lastContactZone; }
    }
    if (!this.firstHit && v.collide.struck.size) { for (const tag of v.collide.struck.values()) { this.firstHit = tag; break; } }
    const rr = Math.abs(v.w.x * fwd.x + v.w.y * fwd.y + v.w.z * fwd.z);
    if (rr > this.rollRateMax) this.rollRateMax = rr;
    this.rollRel = v.rollTotal - this.roll0; const pr = Math.abs(v.pitchTotal - this.pitch0);
    if (Math.abs(this.rollRel) > this.rollMax) this.rollMax = Math.abs(this.rollRel);
    if (pr > this.pitchMax) this.pitchMax = pr;
    this.quarterTurns = Math.floor(this.rollMax / (Math.PI / 2) + 1e-9);
    if (this.gCG > this.peakG) this.peakG = this.gCG; if (this.gSeat > this.peakGSeat) this.peakGSeat = this.gSeat;
    if (v.wheels.every(wh => wh.Fz <= 0) && !v.hull.contacts && !v.collide.contacts) this.air += dt;
    const hg = v.pos.y - v.ground.heightAt(v.pos.x, v.pos.z); if (hg > this.peakH) this.peakH = hg;
    // series every 10 ms
    this.serT += dt;
    if (this.serT >= 0.0099 && this.ser.t.length < 2400) { this.serT = 0; this.ser.t.push(+t.toFixed(3)); this.ser.v.push(sp * 3.6); this.ser.roll.push(this.rollRel / D2R); this.ser.g.push(this.gCG); }
    // close: 1 s at rest, 3 s driving on upright without body contact, or 20 s
    const wr = Math.hypot(v.w.x, v.w.y, v.w.z);
    if (sp < 0.2 && wr < 0.2) this.restT += dt; else this.restT = 0;
    if (up.y > 0.9 && !v.hull.contacts && !v.collide.contacts && sp > 0.5 && t > 1) this.calmT += dt; else this.calmT = 0;
    const since = v.t - this.lastCT;
    if (this.restT >= 1) this.finish(v, 'rest', t - this.restT);
    else if (t > 1 && since >= 1 && up.y > 0.9 && sp < 4) this.finish(v, `separated, rolling on at ${(sp * 3.6).toFixed(0)} km/h`, this.lastCT - this.t0, this.posC);
    else if (this.calmT >= 3) this.finish(v, 'drove on', t - this.calmT, this.posC);
    else if (t >= 20) this.finish(v, 'timeout (20 s)', t);
  }

  private closedAt = -1e9;
  private finish(v: Vehicle, how: string, tEnd: number, end: V3 = v.pos) {
    this.open = false; this.closedAt = v.t;
    const h = v.hull, d = v.damage, c = v.collide;
    const dist = Math.hypot(end.x - this.pos0.x, end.z - this.pos0.z);
    const qt = Math.floor(this.rollMax / (Math.PI / 2) + 1e-9), rolls = Math.floor(this.rollMax / (2 * Math.PI) + 1e-9), eoe = Math.floor(this.pitchMax / (2 * Math.PI) + 1e-9);
    // clock direction the impulse came from (12 = dead ahead, 3 = right, 9 = left); body +X is left
    let clock = '–';
    if (Math.hypot(this.imp.x, this.imp.z) > 50) { const fr = this.imp.x, ff = -this.imp.z; const phi = Math.atan2(fr, ff); let hr = Math.round(phi / (Math.PI / 6)); hr = ((hr % 12) + 12) % 12; clock = `${hr === 0 ? 12 : hr} o'clock`; }
    // crush energy by damage zone (from the per-point crush increase × that point's yield-ish force is not tracked; use hull zone work)
    const crushByHull: Record<string, number> = {}; for (const z of Object.keys(h.crushWork) as HullZone[]) crushByHull[z] = h.crushWork[z] - (this.crush0[z] ?? 0);
    const dz: Record<DamageZone, number> = { front: 0, rear: 0, left: 0, right: 0, roof: 0, underbody: 0 };
    let dpSum = 0; const dpZ: Record<DamageZone, number> = { ...dz };
    for (let i = 0; i < h.n; i++) { const z = d.pointZone[i]; const inc = h.dp[i] - (this.dpPt0[i] ?? 0); if (z && inc > 0) { dpZ[z] += inc; dpSum += inc; } }
    const Wcrush = h.Wcrush - this.Wc0;
    for (const z of DAMAGE_ZONES) dz[z] = dpSum > 0 ? Wcrush * dpZ[z] / dpSum : 0;
    let primary: DamageZone | '' = ''; let pm = 0; for (const z of DAMAGE_ZONES) if (dz[z] > pm) { pm = dz[z]; primary = z; }
    const Wfric = (h.Wfric - this.Wf0) + (c.Wfric - this.Wcf0), Wbreak = c.Wbreak - this.Wb0, Erest = this.kinetic(v);
    const other = Math.max(0, this.E0 - Wcrush - Wfric - Wbreak - Erest);
    const kJ = (x: number) => (x / 1000).toFixed(1) + ' kJ', pc = (x: number) => this.E0 > 1 ? ` (${(x / this.E0 * 100).toFixed(0)} %)` : '';
    const tags = new Map<string, number>(); for (const tg of c.struck.values()) tags.set(tg, (tags.get(tg) ?? 0) + 1);
    const cones = [...c.struck.values()].filter(t => t === 'cone').length;
    const objs = [...tags].filter(([t]) => t !== 'cone').map(([t, n]) => n > 1 ? `${t} ×${n}` : t).join(', ') || 'none (ground only)';
    const decelD = dist > 0.05 ? this.v0 * this.v0 / (2 * G * dist) : 0;
    const decelT = tEnd > 0.05 ? this.v0 / (G * tEnd) : 0;
    const rolled = qt >= 1;
    if (!this.minor && this.E0 < 1e4 && Wcrush < 100 && !rolled && c.struck.size === 0) this.minor = true; // a jolt, not a crash: logged only
    const dmg = DAMAGE_ZONES.filter(z => d.zone[z] >= 0.005).map(z => `${ZONE_LABEL[z]} ${(d.zone[z] * 100).toFixed(0)} %`).join(' · ') || 'none';
    const faults = d.faults();
    const rows: [string, string][] = [
      ['Opened by', `${this.trigger}; closed by ${how}`],
      ['Speed at first contact', `${(this.v0 * 3.6).toFixed(1)} km/h, slip angle ${(this.slip0 / D2R).toFixed(0)}°`],
      ['Impact', `${primary ? ZONE_LABEL[primary] : this.firstZone || '–'}${this.firstHit ? ' · first object: ' + this.firstHit : ''} · from ${clock}`],
      ['ΔV (150 ms window)', `long ${d.peakDvLong.toFixed(1)} m/s · lat ${d.peakDvLat.toFixed(1)} m/s`],
      ['Peak g (10 ms avg)', `CG ${this.peakG.toFixed(1)} g · driver's seat ${this.peakGSeat.toFixed(1)} g`],
      ['Rollover', `${qt} quarter turn${qt === 1 ? '' : 's'} · ${rolls} full roll${rolls === 1 ? '' : 's'} · ${eoe} end-over-end · peak roll rate ${(this.rollRateMax / D2R).toFixed(0)}°/s`],
      ['Airborne', `${this.air.toFixed(2)} s · peak CG height ${this.peakH.toFixed(2)} m`],
      [how === 'rest' ? 'To rest' : 'To last contact', `${dist.toFixed(1)} m (path ${this.path.toFixed(1)} m) in ${tEnd.toFixed(2)} s`],
      ['Mean deceleration', `${decelD.toFixed(2)} g (distance) · ${decelT.toFixed(2)} g (time)${rolled ? ` · rollover band ${ROLL_DECEL_BAND[0]}–${ROLL_DECEL_BAND[1]} g [M]: ${decelD >= ROLL_DECEL_BAND[0] && decelD <= ROLL_DECEL_BAND[1] ? 'inside' : decelD < ROLL_DECEL_BAND[0] ? 'below' : 'above'}` : ''}`],
      ['Energy at first contact', `${kJ(this.E0)} (translation + rotation)`],
      ['→ crush', `${kJ(Wcrush)}${pc(Wcrush)}${Wcrush > 1 ? ' — ' + DAMAGE_ZONES.filter(z => dz[z] > 50).map(z => `${ZONE_LABEL[z].split(' ')[0]} ${kJ(dz[z])}`).join(', ') : ''}`],
      ['→ body friction', `${kJ(Wfric)}${pc(Wfric)}`],
      ['→ objects broken', `${kJ(Wbreak)}${pc(Wbreak)}`],
      ['→ tyres, suspension, height', `${kJ(other)}${pc(other)}`],
      ['→ remaining motion', `${kJ(Erest)}${pc(Erest)}`],
      ['Damage', dmg],
      ['Mechanical faults', faults.join(', ') || 'none'],
      ['Objects struck', objs],
      ['Cones hit', String(cones)],
    ];
    const titleBits = [rolled ? `rollover ${qt}×90°` : '', primary ? ZONE_LABEL[primary].toLowerCase() + ' impact' : '', this.firstHit && this.firstHit !== 'cone' ? 'into ' + this.firstHit : ''].filter(Boolean);
    const rep: CrashReport = {
      id: ++this.n, minor: this.minor,
      title: this.minor ? (cones ? `Cone strike at ${(this.v0 * 3.6).toFixed(0)} km/h (${cones} cone${cones === 1 ? '' : 's'})` : `Jolt at ${(this.v0 * 3.6).toFixed(0)} km/h (${this.peakG.toFixed(1)} g)`) : `Crash at ${(this.v0 * 3.6).toFixed(0)} km/h${titleBits.length ? ': ' + titleBits.join(', ') : ''}`,
      rows,
      series: [
        { name: 'Speed', t: this.ser.t, y: this.ser.v, unit: 'km/h' },
        { name: 'Roll', t: this.ser.t, y: this.ser.roll, unit: '°' },
        { name: 'g (10 ms)', t: this.ser.t, y: this.ser.g, unit: 'g' },
      ],
      data: {
        speed_kmh: +(this.v0 * 3.6).toFixed(2), slip_deg: +(this.slip0 / D2R).toFixed(1), zone: primary, clock, dv_long: +d.peakDvLong.toFixed(2), dv_lat: +d.peakDvLat.toFixed(2),
        peak_g_cg: +this.peakG.toFixed(2), peak_g_seat: +this.peakGSeat.toFixed(2), quarter_turns: qt, full_rolls: rolls, end_over_ends: eoe, peak_roll_rate_dps: +(this.rollRateMax / D2R).toFixed(0),
        airborne_s: +this.air.toFixed(3), peak_cg_height_m: +this.peakH.toFixed(2), distance_m: +dist.toFixed(2), path_m: +this.path.toFixed(2), time_s: +tEnd.toFixed(2),
        mean_decel_g: +decelD.toFixed(3), energy_kJ: { start: +(this.E0 / 1000).toFixed(2), crush: +(Wcrush / 1000).toFixed(2), crush_by_zone: Object.fromEntries(DAMAGE_ZONES.map(z => [z, +(dz[z] / 1000).toFixed(2)])), friction: +(Wfric / 1000).toFixed(2), objects: +(Wbreak / 1000).toFixed(2), other: +(other / 1000).toFixed(2), remaining: +(Erest / 1000).toFixed(2) },
        damage: Object.fromEntries(DAMAGE_ZONES.map(z => [z, +(d.zone[z] * 100).toFixed(1)])), faults, objects: Object.fromEntries(tags), cones, crush_by_hull_zone_kJ: Object.fromEntries(Object.entries(crushByHull).map(([k, x]) => [k, +(x / 1000).toFixed(2)])),
      },
      note: 'Crush, friction and thresholds are assumptions to be checked against crash data (src/physics/params.ts, damage.ts). No injury figures: the model has no occupants.',
    };
    this.done.push(rep); if (this.done.length > 8) this.done.shift(); this.last = rep;
    c.clearStruck();
  }

  /** Discards an open event (teleport / recover). */
  cancel() { this.open = false; this.rollRel = 0; this.quarterTurns = 0; this.filled = 0; this.ri = 0; this.gCG = this.gSeat = 0; this.closedAt = -1e9; }
}
