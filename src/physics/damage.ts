// Damage state and its mechanical consequences (PLAN_crash_damage_mirrors.md §4). DOM-free.
// Body damage comes from the hull's permanent crush δp (ground and world colliders share it); wheel, engine and
// restraint faults follow the plan's table. Every multiplier is exactly 1 (and every offset exactly 0) while undamaged,
// so normal driving is bit-identical to the undamaged model.
//
// | Trigger                                             | Consequence                                                 |
// |-----------------------------------------------------|-------------------------------------------------------------|
// | Tyre sidewall yield (δp > 5 mm) or rim force > 60 kN | Toe offset up to 2° (steering pull), damper force × 0.3     |
// | Rim force > 40 kN or sidewall crush ≥ 30 mm          | Puncture: tyre rate 290 → 70 kN/m, μ × 0.6, rolling res. × 4 |
// | Wheel-arch crush > 0.15 m                            | Suspension collapsed: spring × 0.4, wheel dragged           |
// | Front crush > 0.12 m                                 | Coolant leak: temperature climbs with load; derate, stall   |
// | Front crush > 0.25 m                                 | Intercooler holed: no boost (0.42 no-boost torque fraction) |
// | Front crush > 0.5 m                                  | Engine dead                                                 |
// | ΔV > 6 m/s frontal or > 4 m/s lateral in 150 ms, or a rollover (tilt > 60° rolling > 1 rad/s) | Airbags, fuel cut (Enter restarts unless dead) |
// | Inverted > 3 s                                       | Engine stalls (oil starvation)                              |
// All thresholds are assumptions [A]; the airbag must-fire ΔV values are typical figures [M].

import type { Hull } from './hull';

export type DamageZone = 'front' | 'rear' | 'left' | 'right' | 'roof' | 'underbody';
export const DAMAGE_ZONES: DamageZone[] = ['front', 'rear', 'left', 'right', 'roof', 'underbody'];
export const ZONE_LABEL: Record<DamageZone, string> = { front: 'Front', rear: 'Rear', left: 'Left side', right: 'Right side', roof: 'Roof', underbody: 'Underbody' };
const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'];
const D2R = Math.PI / 180;

type V3 = { x: number; y: number; z: number };
/** What the damage model reads from the vehicle each step. */
export interface DamageHost {
  vel: V3; w: V3; hull: Hull; ignition: boolean; engineTorque: number; t: number;
  wheels: { rimPeak: number; kerbPeak: number }[];
}

export interface WheelDamage { toe: number; puncture: boolean; bent: boolean; collapsed: boolean }

export class Damage {
  readonly zone: Record<DamageZone, number> = { front: 0, rear: 0, left: 0, right: 0, roof: 0, underbody: 0 };
  /** Hull body points of each zone (mirrors and tyre points excluded: they are separate faults). */
  readonly zonePts: Record<DamageZone, number[]> = { front: [], rear: [], left: [], right: [], roof: [], underbody: [] };
  /** Hull point → damage zone (null for mirrors / tyre points). */
  readonly pointZone: (DamageZone | null)[] = [];
  readonly wheels: WheelDamage[] = [0, 1, 2, 3].map(() => ({ toe: 0, puncture: false, bent: false, collapsed: false }));
  // ---- per-wheel multipliers read by Vehicle.step (1 / 0 when undamaged) ----
  readonly kTyre = [1, 1, 1, 1]; readonly muTyre = [1, 1, 1, 1]; readonly rrTyre = [1, 1, 1, 1];
  readonly damperK = [1, 1, 1, 1]; readonly springK = [1, 1, 1, 1]; readonly drag = [0, 0, 0, 0]; readonly toe = [0, 0, 0, 0];
  /** True once any wheel fault exists (the vehicle skips the per-wheel lookups otherwise). */
  wheelFault = false;
  // ---- engine and restraints ----
  coolantLeak = false; intercooler = false; engineDead = false; airbags = false; fuelCut = false;
  coolantT = 90; derate = 1; invertedT = 0; overheated = false;
  mirrorBroken = { left: false, right: false };
  /** Underbody: energy of hard bottoming (belly force above 40 kN), J. */
  underbodyWork = 0;
  /** ΔV over the last 150 ms in body axes (m/s; long + = forwards) and the largest |values| since clearPeaks(). */
  dvLong = 0; dvLat = 0; peakDvLong = 0; peakDvLat = 0;
  /** Faults that appeared since the last takeEvents() (for toasts). */
  private events: string[] = [];
  private ring = new Float64Array(151 * 3); private ri = 0; private filled = 0;
  private lastW = 0; private lastRim = [0, 0, 0, 0]; private lastKerb = [0, 0, 0, 0];
  readonly archPt = [-1, -1, -1, -1]; private mirrorPt = { left: -1, right: -1 };
  private tyreMaxDp = [0, 0, 0, 0];
  constructor(private hull: Hull) {
    for (let i = 0; i < hull.n; i++) {
      let z: DamageZone | null = null;
      if (hull.wheel[i] < 0 && hull.zone[i] !== 'mirror') {
        const x = hull.px[i], y = hull.py[i], zz = hull.pz[i];
        z = y > 0.6 ? 'roof' : hull.zone[i] === 'front' ? 'front' : zz < -2.25 ? 'rear' : x > 0 ? 'left' : 'right';
        this.zonePts[z].push(i);
      }
      if (hull.zone[i] === 'mirror') { if (hull.px[i] > 0) this.mirrorPt.left = i; else this.mirrorPt.right = i; }
      this.pointZone.push(z);
    }
    // wheel-arch flare per wheel: the sill-zone point nearest the wheel at the arch height
    const wz = [1.29, 1.29, -1.455, -1.455], wx = [1, -1, 1, -1];
    for (let w = 0; w < 4; w++) {
      let bd = Infinity;
      for (let i = 0; i < hull.nBody; i++) { const d = Math.abs(hull.pz[i] - wz[w]) + Math.abs(hull.py[i] + 0.02) + (Math.sign(hull.px[i]) === wx[w] ? 0 : 9); if (d < bd) { bd = d; this.archPt[w] = i; } }
    }
  }

  /** Repairs everything (Y). The hull's crush is repaired by the vehicle. */
  repair() {
    for (const z of DAMAGE_ZONES) this.zone[z] = 0;
    for (let w = 0; w < 4; w++) { const d = this.wheels[w]; d.toe = 0; d.puncture = d.bent = d.collapsed = false; this.lastRim[w] = 0; this.lastKerb[w] = 0; this.tyreMaxDp[w] = 0; }
    this.kTyre.fill(1); this.muTyre.fill(1); this.rrTyre.fill(1); this.damperK.fill(1); this.springK.fill(1); this.drag.fill(0); this.toe.fill(0);
    this.wheelFault = false; this.coolantLeak = this.intercooler = this.engineDead = this.airbags = this.fuelCut = this.overheated = false;
    this.coolantT = 90; this.derate = 1; this.invertedT = 0; this.underbodyWork = 0; this.lastW = 0;
    this.mirrorBroken.left = this.mirrorBroken.right = false; this.events.length = 0;
  }
  /** Teleport / recover: the velocity history no longer applies. */
  resetMotion() { this.filled = 0; this.ri = 0; this.dvLong = this.dvLat = 0; this.invertedT = 0; }
  clearPeaks() { this.peakDvLong = 0; this.peakDvLat = 0; }
  takeEvents() { const e = this.events; this.events = []; return e; }
  /** Hard bottoming of the belly (from the vehicle's underbody loop). */
  belly(Fn: number, vh: number, dt: number) { if (Fn > 4e4) this.underbodyWork += (Fn - 4e4) * Math.max(0.3, vh) * dt; }

  /** Per physics step, after the body has moved. up/fwd/left: body axes (world). Returns true when the engine must stop now. */
  update(v: DamageHost, up: V3, fwd: V3, left: V3, dt: number): string | null {
    // ΔV over 150 ms (ring of world velocities)
    const r = this.ring, k = this.ri * 3;
    r[k] = v.vel.x; r[k + 1] = v.vel.y; r[k + 2] = v.vel.z;
    this.ri = this.ri === 150 ? 0 : this.ri + 1; if (this.filled < 151) this.filled++;
    let stop: string | null = null;
    if (this.filled === 151) {
      const o = this.ri * 3; // oldest sample (150 steps ago)
      const dx = v.vel.x - r[o], dy = v.vel.y - r[o + 1], dz = v.vel.z - r[o + 2];
      this.dvLong = dx * fwd.x + dy * fwd.y + dz * fwd.z; this.dvLat = dx * left.x + dy * left.y + dz * left.z;
      const al = Math.abs(this.dvLong), at = Math.abs(this.dvLat);
      if (al > this.peakDvLong) this.peakDvLong = al; if (at > this.peakDvLat) this.peakDvLat = at;
      if (!this.airbags && (this.dvLong < -6 || at > 4)) { this.airbags = true; this.fuelCut = true; this.events.push(`Airbags deployed (ΔV ${al > at ? al.toFixed(1) + ' m/s frontal' : at.toFixed(1) + ' m/s lateral'}), fuel cut — Enter restarts`); if (v.ignition) stop = 'airbag'; }
    }
    // rollover sensing (curtain airbags + fuel cut) and oil starvation when inverted
    if (up.y < 0.5) {
      const rr = Math.abs(v.w.x * fwd.x + v.w.y * fwd.y + v.w.z * fwd.z);
      if (!this.airbags && rr > 1) { this.airbags = true; this.fuelCut = true; this.events.push('Rollover: curtain airbags deployed, fuel cut — Enter restarts'); if (v.ignition) stop = 'airbag'; }
      if (up.y < -0.3) { this.invertedT += dt; if (this.invertedT > 3 && v.ignition) { stop = 'inverted'; this.events.push('Engine stalled: upside down for 3 s (oil starvation)'); } }
      else this.invertedT = 0;
    } else this.invertedT = 0;
    // re-evaluate faults only when something was crushed or a rim struck
    const h = this.hull;
    let rimNew = false;
    for (let w = 0; w < 4; w++) {
      const rp = v.wheels[w].rimPeak; if (rp > this.lastRim[w] + 0.002) { this.lastRim[w] = rp; rimNew = true; }
      const kp = v.wheels[w].kerbPeak; if (kp > this.lastKerb[w] + 5e3) { this.lastKerb[w] = kp; rimNew = true; }
    }
    if (h.Wcrush !== this.lastW || rimNew) { this.lastW = h.Wcrush; this.evaluate(v); }
    // coolant: temperature climbs with load once the radiator leaks; derate from 112 °C, stall at 125 °C
    if (this.coolantLeak) {
      if (v.ignition) {
        const load = Math.max(0, v.engineTorque) / 450;
        this.coolantT += (0.25 + 1.2 * load) * 0.255 * dt;
        if (this.coolantT >= 125 && !this.overheated) { this.overheated = true; stop = 'overheat'; this.events.push('Engine overheated (coolant lost) and stalled — let it cool below 115 °C'); }
      } else this.coolantT += (35 - this.coolantT) * 0.0006 * dt;
      if (this.overheated && this.coolantT < 115) this.overheated = false;
      const x = Math.min(1, Math.max(0, (this.coolantT - 112) / 10)); this.derate = 1 - 0.6 * x * x * (3 - 2 * x);
    }
    return stop;
  }

  private evaluate(v: DamageHost) {
    const h = this.hull;
    for (const z of DAMAGE_ZONES) {
      if (z === 'underbody') { this.zone.underbody = Math.min(1, this.underbodyWork / 5e4); continue; }
      const pts = this.zonePts[z]; let mx = 0, sum = 0;
      for (const i of pts) { const f = Math.min(1, h.dp[i] / h.maxC[i]); sum += f; if (f > mx) mx = f; }
      this.zone[z] = Math.min(1, 0.6 * mx + 0.4 * (pts.length ? sum / pts.length : 0));
    }
    // front structure crush (engine bay)
    let front = 0; for (const i of this.zonePts.front) if (h.dp[i] > front) front = h.dp[i];
    if (front > 0.12 && !this.coolantLeak) { this.coolantLeak = true; this.events.push('Radiator damaged: coolant leaking'); }
    if (front > 0.25 && !this.intercooler) { this.intercooler = true; this.events.push('Intercooler holed: no boost'); }
    if (front > 0.5 && !this.engineDead) { this.engineDead = true; this.events.push('Engine dead (front crush ' + (front * 100).toFixed(0) + ' cm)'); }
    for (const side of ['left', 'right'] as const) { const i = this.mirrorPt[side]; if (i >= 0 && h.dp[i] > 0.01 && !this.mirrorBroken[side]) { this.mirrorBroken[side] = true; this.events.push(`${side === 'left' ? 'Left' : 'Right'} door mirror broken`); } }
    // wheels: sidewall crush, rim strike force, arch crush
    for (let w = 0; w < 4; w++) {
      let dpT = 0; for (let i = h.nBody; i < h.n; i++) if (h.wheel[i] === w && h.dp[i] > dpT) dpT = h.dp[i];
      this.tyreMaxDp[w] = dpT;
      const rimF = Math.max(4e6 * this.lastRim[w], 0.75 * this.lastKerb[w]), arch = this.archPt[w] >= 0 ? h.dp[this.archPt[w]] : 0;
      const d = this.wheels[w], front = w < 2, sideSgn = w % 2 === 0 ? 1 : -1;
      const sev = Math.max(dpT > 0.005 ? dpT / 0.03 : 0, rimF > 6e4 ? (rimF - 6e4) / 6e4 + 0.3 : 0, arch > 0.05 ? arch / 0.15 : 0);
      if (sev > 0 && !d.bent) { d.bent = true; this.events.push(`${WHEEL_NAMES[w]} wheel bent: toe out of line`); }
      if (d.bent) {
        const toe = Math.min(2, 0.6 + 1.4 * Math.min(1, sev)) * D2R * (front ? sideSgn : -sideSgn); // fronts toe out, rears toe in
        if (Math.abs(toe) > Math.abs(d.toe)) d.toe = toe;
        this.toe[w] = d.toe; this.damperK[w] = 0.3;
      }
      if (!d.puncture && (rimF > 4e4 || dpT >= 0.03)) { d.puncture = true; this.kTyre[w] = 70e3 / 290e3; this.muTyre[w] = 0.6; this.rrTyre[w] = 4; this.events.push(`${WHEEL_NAMES[w]} tyre punctured`); }
      if (!d.collapsed && arch > 0.15) { d.collapsed = true; this.springK[w] = 0.4; this.drag[w] = 350; this.events.push(`${WHEEL_NAMES[w]} suspension collapsed`); }
      if (d.bent || d.puncture || d.collapsed) this.wheelFault = true;
    }
  }

  /** One-line readout for the HUD, e.g. "Damage Front 32 % · Roof 60 % · FL flat · coolant 104 °C". Empty when undamaged. */
  summary(): string {
    const parts: string[] = [];
    for (const z of DAMAGE_ZONES) if (this.zone[z] >= 0.01) parts.push(`${ZONE_LABEL[z].split(' ')[0]} ${(this.zone[z] * 100).toFixed(0)} %`);
    for (let w = 0; w < 4; w++) { const d = this.wheels[w]; const f = [d.puncture ? 'flat' : '', d.collapsed ? 'collapsed' : '', d.bent && !d.puncture && !d.collapsed ? 'bent' : ''].filter(Boolean).join('/'); if (f) parts.push(`${WHEEL_NAMES[w]} ${f}`); }
    if (this.engineDead) parts.push('engine dead'); else {
      if (this.coolantLeak) parts.push(`coolant ${this.coolantT.toFixed(0)} °C${this.derate < 0.99 ? ' derate' : ''}`);
      if (this.intercooler) parts.push('no boost');
    }
    if (this.airbags) parts.push('airbags');
    if (this.mirrorBroken.left || this.mirrorBroken.right) parts.push('mirror');
    return parts.length ? 'Damage ' + parts.join(' · ') : '';
  }
  /** Mechanical faults as a list (crash report). */
  faults(): string[] {
    const f: string[] = [];
    for (let w = 0; w < 4; w++) { const d = this.wheels[w]; if (d.puncture) f.push(`${WHEEL_NAMES[w]} puncture`); if (d.collapsed) f.push(`${WHEEL_NAMES[w]} suspension collapsed`); if (d.bent) f.push(`${WHEEL_NAMES[w]} toe ${(d.toe / D2R).toFixed(1)}°, damper 30 %`); }
    if (this.engineDead) f.push('engine dead'); if (this.intercooler) f.push('intercooler holed (no boost)'); if (this.coolantLeak) f.push('coolant leak');
    if (this.airbags) f.push('airbags deployed, fuel cut'); if (this.mirrorBroken.left) f.push('left mirror broken'); if (this.mirrorBroken.right) f.push('right mirror broken');
    return f;
  }
  get any() { return this.wheelFault || this.coolantLeak || this.intercooler || this.engineDead || this.airbags || DAMAGE_ZONES.some(z => this.zone[z] > 0.005) || this.mirrorBroken.left || this.mirrorBroken.right; }
}
