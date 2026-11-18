// Standardised, repeatable tests driven by an autopilot, so runs are comparable (the product idea from the brief).
import type { Vehicle, DriverInput } from '../physics/vehicle';
import { humps, IROAD } from '../world/terrain';

export interface TestResult { title: string; rows: [string, string][]; series?: { name: string; t: number[]; y: number[]; unit: string }[]; note?: string }
type Phase = 'idle' | 'settle' | 'run' | 'brake' | 'done';

export interface RefData { zeroTo100?: { value: number; source: string }; brake100?: { value: number; source: string }; brake80?: { value: number; source: string } }

export class TestRunner {
  active: null | 'acc' | 'brake' | 'hump' = null;
  phase: Phase = 'idle'; t = 0; status = '';
  result: TestResult | null = null;
  ref: RefData = {};
  humpId = 'SB-01'; humpSpeed = 30;
  private lineX = 0; private marks: Record<number, number> = {}; private d0 = 0; private log: { t: number; v: number; az: number; pitch: number; sF: number; sR: number; clr: number; fzMin: number }[] = [];
  private brakeStartV = 0; private peakDecel = 0; private peakAz = 0; private minClr = 9; private bumpHits = 0; private airT = 0; private maxCompF = 0; private maxCompR = 0;

  start(kind: 'acc' | 'brake' | 'hump', veh: Vehicle) {
    this.active = kind; this.phase = 'settle'; this.t = 0; this.result = null; this.marks = {}; this.log = [];
    this.peakDecel = 0; this.peakAz = 0; this.minClr = 9; this.bumpHits = 0; this.airT = 0; this.maxCompF = 0; this.maxCompR = 0;
    if (kind === 'hump') { const h = humps.find(x => x.id === this.humpId)!; this.lineX = (IROAD.x0 + IROAD.x1) / 2 + 1.8; /* left lane: India drives on the left; +X is the car's left */ veh.reset(this.lineX, h.z - 140, 0); }
    else { this.lineX = 0; veh.reset(0, 0, 0); }
    if (!veh.ignition) { veh.ignition = true; veh.omegaE = 80; }
    veh.setSelector('N'); veh.setDriveMode('2H'); veh.setSelector('D');
  }
  stop() { this.active = null; this.phase = 'idle'; this.status = ''; }

  /** Returns an input override while a test runs. */
  update(dt: number, veh: Vehicle): DriverInput | null {
    if (!this.active) return null;
    this.t += dt;
    const inp: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
    // lateral autopilot: hold x = lineX, heading +Z
    const hx = 2 * (veh.q.x * veh.q.z + veh.q.w * veh.q.y), hz = 1 - 2 * (veh.q.x * veh.q.x + veh.q.y * veh.q.y);
    const psi = Math.atan2(hx, hz);
    inp.steer = Math.max(-0.4, Math.min(0.4, 0.18 * (this.lineX - veh.pos.x) - 1.6 * psi));
    const v = veh.kmh;
    if (this.active === 'acc') {
      if (this.phase === 'settle') { inp.brake = 1; this.status = `Settling… ${Math.max(0, 2 - this.t).toFixed(1)} s`; if (this.t > 2) { this.phase = 'run'; this.t = 0; this.d0 = veh.odometer; } }
      else if (this.phase === 'run') {
        inp.throttle = 1;
        for (const m of [20, 40, 60, 80, 100, 120]) if (v >= m && this.marks[m] == null) this.marks[m] = this.t;
        this.log.push({ t: this.t, v, az: veh.accelBody.z / 9.81, pitch: veh.pitch * 57.3, sF: 0, sR: 0, clr: 0, fzMin: 0 });
        this.status = `0–100: ${this.t.toFixed(2)} s · ${v.toFixed(0)} km/h · gear ${veh.gear}`;
        if (v >= 100.5 || this.t > 40) { this.phase = 'brake'; this.finishAcc(veh); }
      } else if (this.phase === 'brake') { inp.brake = 0.35; if (veh.speed < 0.2) this.stop(); }
    } else if (this.active === 'brake') {
      if (this.phase === 'settle') { inp.throttle = 1; this.status = `Accelerating to 80 km/h… ${v.toFixed(0)}`; if (v >= 80) { this.phase = 'run'; this.t = 0; this.d0 = veh.odometer; this.brakeStartV = v; } }
      else if (this.phase === 'run') {
        inp.brake = 1; const dec = -veh.accelBody.z / 9.81; this.peakDecel = Math.max(this.peakDecel, dec);
        this.log.push({ t: this.t, v, az: dec, pitch: veh.pitch * 57.3, sF: 0, sR: 0, clr: 0, fzMin: 0 });
        this.status = `Braking: ${(veh.odometer - this.d0).toFixed(1)} m${veh.absActive ? ' · ABS' : ''}`;
        if (veh.speed < 0.05) { this.finishBrake(veh); this.stop(); }
      }
    } else if (this.active === 'hump') {
      const h = humps.find(x => x.id === this.humpId)!;
      const zFront = veh.pos.z + veh.a;
      const e = this.humpSpeed - v; inp.throttle = Math.max(0, Math.min(1, e * 0.12 + 0.18)); inp.brake = e < -2 ? Math.min(1, -e * 0.05) : 0;
      if (this.phase === 'settle') { this.status = `Approaching ${h.id} at ${this.humpSpeed} km/h… ${v.toFixed(0)} km/h`; if (zFront > h.z - 8) { this.phase = 'run'; this.t = 0; } }
      else if (this.phase === 'run') {
        const sF = Math.min(veh.wheels[0].s, veh.wheels[1].s), sR = Math.min(veh.wheels[2].s, veh.wheels[3].s);
        const fzMin = Math.min(...veh.wheels.map(w => w.Fz));
        this.peakAz = Math.max(this.peakAz, Math.abs(veh.seatAz / 9.81 - 0));
        this.minClr = Math.min(this.minClr, veh.bellyMinClear);
        this.maxCompF = Math.max(this.maxCompF, -sF); this.maxCompR = Math.max(this.maxCompR, -sR);
        if (veh.wheels.some(w => w.bumpStop)) this.bumpHits++;
        if (veh.wheels.some(w => w.Fz <= 0)) this.airT += dt;
        this.log.push({ t: this.t, v, az: veh.seatAz / 9.81, pitch: veh.pitch * 57.3, sF: -sF * 1000, sR: -sR * 1000, clr: veh.bellyMinClear * 1000, fzMin });
        this.status = `Crossing ${h.id} at ${v.toFixed(0)} km/h`;
        if (veh.pos.z - veh.b > h.z + h.len + 6) { this.finishHump(veh, h); this.stop(); }
      }
    }
    return inp;
  }

  private series(name: string, key: keyof TestRunner['log'][number], unit: string, step = 10) { const t: number[] = [], y: number[] = []; this.log.forEach((p, i) => { if (i % step === 0) { t.push(p.t); y.push(p[key] as number); } }); return { name, t, y, unit }; }
  private finishAcc(veh: Vehicle) {
    const m = this.marks; const r = (k: number) => m[k] != null ? m[k].toFixed(2) + ' s' : '–';
    const rows: [string, string][] = [['0–20 km/h', r(20)], ['0–40 km/h', r(40)], ['0–60 km/h', r(60)], ['0–80 km/h', r(80)], ['0–100 km/h', r(100)], ['Distance to 100', (veh.odometer - this.d0).toFixed(0) + ' m']];
    if (this.ref.zeroTo100) rows.push(['Reference 0–100', `${this.ref.zeroTo100.value} s (${this.ref.zeroTo100.source})`]);
    this.result = { title: '0–100 km/h (full throttle, D, 2H)', rows, series: [this.series('Speed', 'v', 'km/h'), this.series('Long. accel', 'az', 'g')],
      note: 'Simulated with partly assumed parameters (torque-curve shape, TC, shift map). Compare with the reference before trusting the number.' };
  }
  private finishBrake(veh: Vehicle) {
    const d = veh.odometer - this.d0;
    const rows: [string, string][] = [['80–0 km/h distance', d.toFixed(1) + ' m'], ['Peak deceleration', this.peakDecel.toFixed(2) + ' g'], ['Mean deceleration', ((this.brakeStartV / 3.6) ** 2 / (2 * d) / 9.81).toFixed(2) + ' g'], ['Max dive', Math.max(...this.log.map(l => l.pitch)).toFixed(1) + '°']];
    if (this.ref.brake80) rows.push(['Reference 80–0', `${this.ref.brake80.value} m (${this.ref.brake80.source})`]);
    this.result = { title: 'Panic braking 80–0 km/h (ABS)', rows, series: [this.series('Speed', 'v', 'km/h', 5), this.series('Decel', 'az', 'g', 5), this.series('Pitch', 'pitch', '°', 5)] };
  }
  private finishHump(veh: Vehicle, h: typeof humps[number]) {
    const rows: [string, string][] = [
      ['Hump', `${h.id}: ${h.name}`], ['Crossing speed', this.humpSpeed + ' km/h'],
      ['Peak seat vertical accel', this.peakAz.toFixed(2) + ' g'],
      ['Max front compression', (this.maxCompF * 1000).toFixed(0) + ` mm (bump travel ${(veh.P.bumpTravelFront.v * 1000).toFixed(0)})`],
      ['Max rear compression', (this.maxCompR * 1000).toFixed(0) + ` mm (bump travel ${(veh.P.bumpTravelRear.v * 1000).toFixed(0)})`],
      ['Bump-stop contact', this.bumpHits > 0 ? 'YES' : 'no'], ['Wheel airborne', this.airT > 0.005 ? (this.airT * 1000).toFixed(0) + ' ms' : 'no'],
      ['Min underbody clearance', (this.minClr * 1000).toFixed(0) + ' mm' + (this.minClr < 0 ? ' — SCRAPED' : '')],
    ];
    this.result = { title: `Speed breaker ${h.id} at ${this.humpSpeed} km/h`, rows,
      series: [this.series('Seat accel', 'az', 'g', 4), this.series('Front comp.', 'sF', 'mm', 4), this.series('Rear comp.', 'sR', 'mm', 4), this.series('Pitch', 'pitch', '°', 4)],
      note: 'Suspension rates, damping and bump-stop gaps are assumptions (not published); treat results as indicative until calibrated (Doc H T05/T06/T23).' };
    void veh;
  }
}
