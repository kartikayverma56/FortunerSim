// Standardised, repeatable tests driven by an autopilot, so runs are comparable (the product idea from the brief).
import type { Vehicle, DriverInput } from '../physics/vehicle';
import { humps, IROAD, CRASHPAD } from '../world/terrain';
import { MAIN_X, REF_POTHOLE, ROAD_HUMPS, leftLane } from '../world/roads';

export interface TestResult { title: string; rows: [string, string][]; series?: { name: string; t: number[]; y: number[]; unit: string }[]; note?: string }
type Phase = 'idle' | 'settle' | 'run' | 'brake' | 'done';

export interface RefData { zeroTo100?: { value: number; source: string }; brake100?: { value: number; source: string }; brake80?: { value: number; source: string } }

export class TestRunner {
  active: null | TestKind = null;
  phase: Phase = 'idle'; t = 0; status = '';
  result: TestResult | null = null;
  ref: RefData = {};
  humpId = 'SB-01'; humpSpeed = 30;
  potholeSpeed = 40;                                   // pothole test: km/h
  rideClass: RideClass = 'district'; rideSpeed = 60;   // ride test: section and km/h
  // crash tests (crash pad, key 0; fishhook on the handling pad)
  fishSpeed = 64;                                      // fishhook entry speed, km/h (NHTSA: 56–80)
  kerbSpeed = 40;                                      // sideways speed into the 150 mm kerb, km/h
  poleTarget: 'pole' | 'wall' | 'sign' = 'pole'; poleSpeed = 50; // frontal impact target and speed, km/h
  dropKind: 'wheels' | 'roof' | 'corner' = 'corner'; dropHeight = 1.0; // drop: attitude and height of the lowest point, m
  private crashId = 0; private fish = { phase: 0, hw: 0, tPh: 0, lift: 0, maxRoll: 0, rolled: false, spin: false, A: 21.1, v0: 0 };
  private lineX = 0; private marks: Record<number, number> = {}; private d0 = 0; private log: { t: number; v: number; az: number; pitch: number; sF: number; sR: number; clr: number; fzMin: number }[] = [];
  private rideN = 0; private rideSum2 = 0; private rideBump = 0; private rideWasBump = false; private maxPen = 0; private vSum = 0;
  private brakeStartV = 0; private peakDecel = 0; private peakAz = 0; private minClr = 9; private bumpHits = 0; private airT = 0; private maxCompF = 0; private maxCompR = 0;

  start(kind: TestKind, veh: Vehicle) {
    this.crashReport = null;
    this.active = kind; this.phase = 'settle'; this.t = 0; this.result = null; this.marks = {}; this.log = [];
    this.peakDecel = 0; this.peakAz = 0; this.minClr = 9; this.bumpHits = 0; this.airT = 0; this.maxCompF = 0; this.maxCompR = 0;
    this.rideN = 0; this.rideSum2 = 0; this.rideBump = 0; this.rideWasBump = false; this.maxPen = 0; this.vSum = 0;
    if (kind === 'hump') { const h = humps.find(x => x.id === this.humpId)!; this.lineX = h.x ?? (IROAD.x0 + IROAD.x1) / 2 + 1.8; /* left lane: India drives on the left; +X is the car's left */ veh.reset(this.lineX, h.z - 140, 0); }
    else if (kind === 'pothole') { this.lineX = MAIN_X + REF_POTHOLE.d - veh.P.trackFront.v / 2; /* left wheels through the reference pothole */ veh.reset(this.lineX, REF_POTHOLE.s - 160, 0); }
    else if (kind === 'ride') { const w = RIDE[this.rideClass]; this.lineX = MAIN_X + leftLane((w[0] + w[1]) / 2); veh.reset(this.lineX, w[2], 0); }
    else if (kind === 'fishhook') { this.lineX = CRASHPAD.fishhook.x; veh.reset(this.lineX, CRASHPAD.fishhook.z, 0); /* open apron of the crash pad, clear of cones */ this.fish = { phase: -1, hw: 0, tPh: 0, lift: 0, maxRoll: 0, rolled: false, spin: false, A: 21.1, v0: 0 }; }
    else if (kind === 'kerb' || kind === 'pole' || kind === 'drop') { this.startCrash(kind, veh); return; }
    else { this.lineX = 0; veh.reset(0, 0, 0); }
    if (!veh.ignition) { veh.ignition = true; veh.omegaE = 80; }
    veh.setSelector('N'); veh.setDriveMode('2H'); veh.setSelector('D');
  }

  /** Crash-pad tests: the car is placed and launched directly (engine as it was, selector N), then the crash recorder's
   *  report becomes the result. */
  private startCrash(kind: 'kerb' | 'pole' | 'drop', veh: Vehicle) {
    const K = CRASHPAD; this.crashId = veh.recorder.lastId;
    veh.setSelector('N');
    const launch = (vx: number, vz: number, spin: number) => { veh.vel.x = vx; veh.vel.z = vz; for (const w of veh.wheels) w.omega = spin; };
    if (kind === 'kerb') {
      // sideways (car's left leading, +X) with the left tyre shoulder 5 cm from the kerb face; wheels not turning
      const x = K.kerb.x - (veh.P.trackFront.v / 2 + veh.P.tyreWidth.v / 2 + 0.05);
      veh.reset(x, (K.kerb.z0 + K.kerb.z1) / 2, 0); launch(this.kerbSpeed / 3.6, 0, 0); this.lineX = x;
    } else if (kind === 'pole') {
      const T = this.poleTarget, v = this.poleSpeed / 3.6;
      const x = T === 'pole' ? K.pole.x : T === 'wall' ? K.wall.x + 2 : K.signs.x - 0.35, zT = T === 'pole' ? K.pole.z - K.pole.r : T === 'wall' ? K.wall.z - K.wall.halfZ : K.signs.z[1];
      veh.reset(x, zT - veh.a - veh.P.overhangFront.v - 12, 0); launch(0, v, v / veh.R); this.lineX = x;
    } else {
      const { x, z } = K.drop; veh.reset(x, z, 0);
      const h = veh.ground.heightAt(x, z);
      const ori = this.dropKind === 'roof' ? [0, 0, Math.PI] : this.dropKind === 'corner' ? [0, 20 * Math.PI / 180, 35 * Math.PI / 180] : [0, 0, 0];
      const qy = { w: 1, x: 0, y: 0, z: 0 }, qp = { w: Math.cos(ori[1] / 2), x: Math.sin(ori[1] / 2), y: 0, z: 0 }, qr = { w: Math.cos(ori[2] / 2), x: 0, y: 0, z: Math.sin(ori[2] / 2) };
      const q = qmul(qmul(qy, qp), qr); veh.q.w = q.w; veh.q.x = q.x; veh.q.y = q.y; veh.q.z = q.z;
      // lowest body / wheel point → drop height above the ground
      let low = Infinity; const pts: [number, number, number][] = veh.P.hullPoints.v.map(p => [p[0], p[1], p[2]]);
      for (const w of veh.wheels) pts.push([w.mount.x, w.mount.y - veh.R, w.mount.z]);
      for (const b of veh.bellyPoints) pts.push([b.x, b.y, b.z]);
      for (const [px, py, pz] of pts) low = Math.min(low, rotY(q, px, py, pz));
      veh.pos.y = h - low + this.dropHeight;
      if (this.dropKind === 'corner') { const f = rotV(q, 0, 0, 1); veh.w.x = f.x * 3; veh.w.y = f.y * 3; veh.w.z = f.z * 3; }
      this.lineX = x;
    }
    this.phase = 'run'; this.t = 0;
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
    if (this.active === 'kerb' || this.active === 'pole' || this.active === 'drop') {
      inp.steer = 0;
      if (this.active === 'pole' && !veh.collide.struck.size && veh.recorder.lastId === this.crashId && !veh.recorder.open) inp.steer = Math.max(-0.1, Math.min(0.1, 0.18 * (this.lineX - veh.pos.x) - 1.6 * psi));
      else if (this.active === 'pole') inp.brake = 1; // after the hit the driver stands on the brake (no roll-back)
      const label = this.active === 'kerb' ? `Kerb trip at ${this.kerbSpeed} km/h` : this.active === 'pole' ? `${this.poleTarget} at ${this.poleSpeed} km/h` : `Drop (${this.dropKind}, ${this.dropHeight} m)`;
      this.status = veh.recorder.open ? `${label}: crash · roll ${(veh.recorder.rollRel * 57.3).toFixed(0)}° · ${veh.recorder.quarterTurns} quarter turns` : `${label}…`;
      const rep = veh.recorder.last;
      if (rep && rep.id !== this.crashId) { this.result = { title: `${label}: ${rep.title}`, rows: rep.rows, series: rep.series, note: rep.note }; this.crashReport = rep; this.stop(); }
      else if (this.t > 25) { this.result = { title: label, rows: [['Result', 'no crash event recorded (no body contact, < 3 g, tilt < 60°)'], ['Speed now', v.toFixed(1) + ' km/h']] }; this.stop(); }
      return inp;
    }
    if (this.active === 'fishhook') return this.fishhook(dt, veh, inp, psi);
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
    } else if (this.active === 'pothole') {
      const P = REF_POTHOLE, zFront = veh.pos.z + veh.a;
      const e = this.potholeSpeed - v; inp.throttle = Math.max(0, Math.min(1, e * 0.12 + 0.18)); inp.brake = e < -2 ? Math.min(1, -e * 0.05) : 0;
      if (this.phase === 'settle') { this.status = `Approaching the reference pothole at ${this.potholeSpeed} km/h… ${v.toFixed(0)} km/h`; if (zFront > P.s - 8) { this.phase = 'run'; this.t = 0; } }
      else if (this.phase === 'run') {
        this.sampleRun(veh, dt);
        this.status = `Pothole at ${v.toFixed(0)} km/h`;
        if (veh.pos.z - veh.b > P.s + P.dia / 2 + 6) { this.finishPothole(veh); this.stop(); }
      }
    } else if (this.active === 'ride') {
      const [w0, w1] = RIDE[this.rideClass];
      // drivers slow to 10–19 km/h for humps [S: C-024/025]: target follows v² = 15² + 2·a·d before each hump (a = 2.5 m/s²)
      const zFront = veh.pos.z + veh.a; let target = this.rideSpeed / 3.6;
      for (const h of ROAD_HUMPS) { if (!h.id.startsWith('VH')) continue; const dist = h.z - zFront; if (dist > -h.len - veh.a - veh.b && dist < 150) target = Math.min(target, Math.sqrt((15 / 3.6) ** 2 + 2 * 2.5 * Math.max(0, dist - 4))); }
      const e = target * 3.6 - v; inp.throttle = Math.max(0, Math.min(1, e * 0.12 + 0.2)); inp.brake = e < -2 ? Math.min(1, -e * 0.08) : 0;
      if (this.phase === 'settle') { this.status = `Ride ${this.rideClass}: getting up to ${this.rideSpeed} km/h… ${v.toFixed(0)} km/h`; if (veh.pos.z > w0) { this.phase = 'run'; this.t = 0; } }
      else if (this.phase === 'run') {
        this.sampleRun(veh, dt); this.rideN++; this.rideSum2 += veh.seatAz * veh.seatAz; this.vSum += v;
        const b = veh.wheels.some(w => w.bumpStop); if (b && !this.rideWasBump) this.rideBump++; this.rideWasBump = b;
        this.status = `Ride ${this.rideClass} at ${v.toFixed(0)} km/h · ${(veh.pos.z - w0).toFixed(0)} / ${(w1 - w0).toFixed(0)} m`;
        if (veh.pos.z > w1) { this.finishRide(veh); this.stop(); }
      }
    }
    return inp;
  }

  /** The crash report behind the last crash-test result (main.ts logs it). */
  crashReport: import('../physics/crashRecorder').CrashReport | null = null;

  /** NHTSA fishhook 1b on the handling pad: 0.3 g angle A = 21° (80 km/h), 6.5·A at 720°/s, reverse when the roll rate
   *  drops below 1.5°/s, hold 3 s; throttle off from the entry speed. Two-wheel lift = both same-side wheels 50 mm clear. */
  private fishhook(dt: number, veh: Vehicle, inp: DriverInput, psi: number): DriverInput {
    const F = this.fish, target = 6.5 * F.A, rate = 720, toSteer = (deg: number) => deg / (veh.P.maxRoadWheelDeg.v * 0.88 * veh.P.steerRatio.v);
    const v = veh.kmh;
    if (F.phase === -1) { // run-up on the pad's centre line
      const e = this.fishSpeed - v; inp.throttle = Math.max(0, Math.min(1, e * 0.15 + 0.3)); inp.brake = e < -3 ? 0.2 : 0;
      this.status = `Fishhook: run-up to ${this.fishSpeed} km/h… ${v.toFixed(0)}${veh.vscOn ? ' (VSC on)' : ' (VSC OFF)'}`;
      if (v >= this.fishSpeed - 0.5 && this.t > 2) { F.phase = 0; F.tPh = 0; F.v0 = v; this.t = 0; this.crashId = veh.recorder.lastId; }
      return inp;
    }
    F.tPh += dt;
    const fw = { x: 2 * (veh.q.x * veh.q.z + veh.q.w * veh.q.y), y: 2 * (veh.q.y * veh.q.z - veh.q.w * veh.q.x), z: 1 - 2 * (veh.q.x * veh.q.x + veh.q.y * veh.q.y) };
    const rr = Math.abs(veh.w.x * fw.x + veh.w.y * fw.y + veh.w.z * fw.z) * 57.3;
    if (F.phase === 0) { F.hw = Math.min(target, F.hw + rate * dt); if (F.hw >= target) { F.phase = 1; F.tPh = 0; } }
    else if (F.phase === 1) { if ((F.tPh > 0.05 && rr < 1.5) || F.tPh > 1.5) { F.phase = 2; F.tPh = 0; } }
    else if (F.phase === 2) { F.hw = Math.max(-target, F.hw - rate * dt); if (F.hw <= -target) { F.phase = 3; F.tPh = 0; } }
    else if (F.phase === 3) { if (F.tPh > 3) { F.phase = 4; F.tPh = 0; } }
    else F.hw = Math.min(0, F.hw + rate * dt);
    inp.steer = Math.max(-1, Math.min(1, toSteer(F.hw))); inp.throttle = 0;
    const cl = veh.wheels.map(w => -w.pen); const l = Math.max(Math.min(cl[0], cl[2]), Math.min(cl[1], cl[3]));
    if (l > F.lift) F.lift = l; F.maxRoll = Math.max(F.maxRoll, Math.abs(veh.rollFull) * 57.3); if (Math.abs(veh.rollFull) > Math.PI / 2) F.rolled = true;
    const sp = Math.hypot(veh.vel.x, veh.vel.z); if (sp > 3) { const beta = Math.abs(Math.atan2(fw.x * veh.vel.z - fw.z * veh.vel.x, fw.x * veh.vel.x + fw.z * veh.vel.z)); if (beta > 0.52) F.spin = true; }
    this.status = `Fishhook ${F.v0.toFixed(0)} km/h: wheel ${F.hw.toFixed(0)}° · roll ${(veh.rollFull * 57.3).toFixed(0)}° · lift ${(F.lift * 1000).toFixed(0)} mm`;
    this.log.push({ t: this.t, v, az: veh.accelBody.x / 9.81, pitch: veh.rollFull * 57.3, sF: F.hw, sR: l * 1000, clr: 0, fzMin: 0 });
    const rep = veh.recorder.last, crashed = rep && rep.id !== this.crashId;
    if ((veh.speed < 0.5 && this.t > 2) || this.t > 12 || crashed) {
      const rows: [string, string][] = [
        ['Entry speed', `${F.v0.toFixed(1)} km/h, throttle off, ${veh.vscOn ? 'VSC on' : 'VSC OFF'}, CG ${veh.P.cgHeight.v} m`],
        ['Steering', `0.3 g angle ${F.A}° → ${target.toFixed(0)}° handwheel at 720°/s, reversed at the roll-rate dip, held 3 s`],
        ['Max roll', `${F.maxRoll.toFixed(1)}°`],
        ['Largest same-side wheel lift', `${(F.lift * 1000).toFixed(0)} mm${F.lift >= 0.05 ? ' — TWO-WHEEL LIFT (≥ 50 mm)' : ''}`],
        ['Rolled over', F.rolled ? 'YES' : 'no'], ['Spun out (sideslip > 30°)', F.spin ? 'yes' : 'no'],
      ];
      if (crashed && rep) { rows.push(['Crash report', rep.title]); this.crashReport = rep; }
      this.result = { title: `Fishhook at ${F.v0.toFixed(0)} km/h`, rows, series: [this.series('Speed', 'v', 'km/h', 10), this.series('Handwheel', 'sF', '°', 10), this.series('Roll', 'pitch', '°', 10), this.series('Lift', 'sR', 'mm', 10)],
        note: 'NHTSA fishhook 1b parameters from memory [M]; the 4Runner class rates "no tip". CG height is an assumption (params.ts).' };
      this.stop();
    }
    void psi;
    return inp;
  }

  /** Shared per-step bookkeeping of the hump-style metrics (pothole and ride tests). */
  private sampleRun(veh: Vehicle, dt: number) {
    const sF = Math.min(veh.wheels[0].s, veh.wheels[1].s), sR = Math.min(veh.wheels[2].s, veh.wheels[3].s);
    this.peakAz = Math.max(this.peakAz, Math.abs(veh.seatAz / 9.81));
    this.minClr = Math.min(this.minClr, veh.bellyMinClear);
    this.maxCompF = Math.max(this.maxCompF, -sF); this.maxCompR = Math.max(this.maxCompR, -sR);
    for (const w of veh.wheels) this.maxPen = Math.max(this.maxPen, w.pen);
    if (veh.wheels.some(w => w.bumpStop)) this.bumpHits++;
    if (veh.wheels.some(w => w.Fz <= 0)) this.airT += dt;
    if (this.log.length < 200000) this.log.push({ t: this.t, v: veh.kmh, az: veh.seatAz / 9.81, pitch: veh.pitch * 57.3, sF: -sF * 1000, sR: -sR * 1000, clr: veh.bellyMinClear * 1000, fzMin: Math.min(...veh.wheels.map(w => w.Fz)) });
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
  private finishPothole(veh: Vehicle) {
    const P = REF_POTHOLE;
    const rows: [string, string][] = [
      ['Pothole', `district road s ${P.s} m, left wheel path: dia ${(P.dia * 1000).toFixed(0)} mm, ${(P.depth * 1000).toFixed(0)} mm deep`], ['Speed', this.potholeSpeed + ' km/h'],
      ['Peak seat vertical accel', this.peakAz.toFixed(2) + ' g'],
      ['Max tyre deflection', (this.maxPen * 1000).toFixed(0) + ' mm' + (this.maxPen > 0.09 ? ' — RIM CONTACT' : ' (rim contact at 90)')],
      ['Max front compression', (this.maxCompF * 1000).toFixed(0) + ` mm (bump travel ${(veh.P.bumpTravelFront.v * 1000).toFixed(0)})`],
      ['Max rear compression', (this.maxCompR * 1000).toFixed(0) + ` mm (bump travel ${(veh.P.bumpTravelRear.v * 1000).toFixed(0)})`],
      ['Bump-stop contact', this.bumpHits > 0 ? 'YES' : 'no'], ['Wheel airborne', this.airT > 0.005 ? (this.airT * 1000).toFixed(0) + ' ms' : 'no'],
    ];
    this.result = { title: `Pothole at ${this.potholeSpeed} km/h`, rows,
      series: [this.series('Seat accel', 'az', 'g', 4), this.series('Front comp.', 'sF', 'mm', 4), this.series('Rear comp.', 'sR', 'mm', 4)],
      note: 'Pothole size is an assumption (no Indian distribution published, Doc H H6.5). The tyre is a rigid ring sampled along the wheel heading, so the wall is felt as an edge.' };
  }
  private finishRide(veh: Vehicle) {
    const [w0, w1] = RIDE[this.rideClass], rms = Math.sqrt(this.rideSum2 / Math.max(1, this.rideN));
    const rows: [string, string][] = [
      ['Section', `${RIDE_LABEL[this.rideClass]}, s ${w0}–${w1} m, left lane`], ['Target speed', this.rideSpeed + ' km/h (15 km/h at humps)'],
      ['Mean speed', (this.vSum / Math.max(1, this.rideN)).toFixed(1) + ' km/h'],
      ['RMS seat vertical accel', `${rms.toFixed(2)} m/s² (${(rms / 9.81).toFixed(3)} g)`], ['Peak seat vertical accel', this.peakAz.toFixed(2) + ' g'],
      ['Bump-stop events', String(this.rideBump)], ['Max tyre deflection', (this.maxPen * 1000).toFixed(0) + ' mm'],
      ['Wheel airborne (total)', this.airT > 0.005 ? (this.airT * 1000).toFixed(0) + ' ms' : 'no'],
    ];
    this.result = { title: `Ride: ${RIDE_LABEL[this.rideClass]} at ${this.rideSpeed} km/h`, rows,
      series: [this.series('Seat accel', 'az', 'g', 20), this.series('Speed', 'v', 'km/h', 20)],
      note: 'Unweighted driver-seat vertical acceleration. Roughness is synthesised from ISO 8608 and scaled to the class IRI (tools/roadtest.ts).' };
    void veh;
  }
}

export type TestKind = 'acc' | 'brake' | 'hump' | 'pothole' | 'ride' | 'fishhook' | 'kerb' | 'pole' | 'drop';
type Qt = { w: number; x: number; y: number; z: number };
const qmul = (a: Qt, b: Qt): Qt => ({ w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z, x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w });
const rotV = (q: Qt, x: number, y: number, z: number) => { const p = qmul(qmul(q, { w: 0, x, y, z }), { w: q.w, x: -q.x, y: -q.y, z: -q.z }); return { x: p.x, y: p.y, z: p.z }; };
const rotY = (q: Qt, x: number, y: number, z: number) => rotV(q, x, y, z).y;
export type RideClass = 'sh' | 'district' | 'village';
/** Ride windows on the new road: [measure from z, to z, start z]. The state highway window is shorter: the run-up starts at the junction. */
export const RIDE: Record<RideClass, [number, number, number]> = { sh: [210, 490, -12], district: [510, 990, 290], village: [1010, 1500, 790] };
const RIDE_LABEL: Record<RideClass, string> = { sh: 'State highway (IRI 3.5)', district: 'District road (IRI 4.5)', village: 'Village entry (IRI 5.0)' };
