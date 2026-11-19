// Fortuner vehicle dynamics: 6-DOF sprung body + 4 unsprung vertical DOFs + wheel spin,
// transient-slip (relaxation-length) tyres with a Magic-Formula similarity combined-slip model,
// rigid-ring tyre/obstacle contact (true speed-breaker and pothole enveloping),
// turbo-diesel with spool lag, torque converter + lock-up clutch, 6AT shift logic,
// part-time transfer case (2H/4H/4L) with driveline wind-up, open diffs + rear locker,
// brakes with ABS, A-TRC, VSC, HAC, DAC, aero drag and underbody contact.
// Integrated at a fixed 1 kHz. Body frame: +X left, +Y up, +Z forward; origin at the CG.

import { FORTUNER, type VehicleParams } from './params';
import { heightAt, surfaceAt, SURFACES, type SurfaceKey } from '../world/terrain';
import type { Surface, ImpactEvent } from '../audio/types';

// ---------------- tiny vector helpers (no allocations in the hot loop) ----------------
type V3 = { x: number; y: number; z: number };
const v3 = (x = 0, y = 0, z = 0): V3 => ({ x, y, z });
const set = (o: V3, x: number, y: number, z: number) => { o.x = x; o.y = y; o.z = z; return o; };
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const crossTo = (o: V3, a: V3, b: V3) => set(o, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
const len = (a: V3) => Math.hypot(a.x, a.y, a.z);
const normTo = (o: V3, a: V3) => { const l = len(a) || 1; return set(o, a.x / l, a.y / l, a.z / l); };
const clamp = (x: number, a: number, b: number) => x < a ? a : x > b ? b : x;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const sstep = (e0: number, e1: number, x: number) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };
const G = 9.81;

type Quat = { w: number; x: number; y: number; z: number };
function rotate(q: Quat, v: V3, o: V3) { // o = q v q*
  const ix = q.w * v.x + q.y * v.z - q.z * v.y, iy = q.w * v.y + q.z * v.x - q.x * v.z, iz = q.w * v.z + q.x * v.y - q.y * v.x, iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return set(o, ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y, iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z, iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x);
}
function rotateInv(q: Quat, v: V3, o: V3) { const c = { w: q.w, x: -q.x, y: -q.y, z: -q.z }; return rotate(c, v, o); }

export interface DriverInput {
  throttle: number;   // 0..1
  brake: number;      // 0..1
  steer: number;      // -1..1 (+ = left)
  handbrake: number;  // 0..1
}

export type Selector = 'P' | 'R' | 'N' | 'D' | 'M';
export type DriveMode = '2H' | '4H' | '4L';

export interface WheelState {
  name: string; front: boolean; left: boolean; driven: boolean;
  mount: V3;               // body-frame wheel-centre position at static ride height
  s: number;               // suspension displacement from static (m): + = droop / extension, − = bump
  vw: number;              // absolute wheel velocity along body up (m/s)
  omega: number;           // spin (rad/s), + = rolling forward
  theta: number;           // accumulated spin angle (visual)
  u: number; vlat: number; // tyre bristle deflections (long/lat), m
  pen: number; penPrev: number;
  Fz: number; Fx: number; Fy: number;
  kappa: number; alpha: number; slip: number;
  steer: number;           // road-wheel angle (rad)
  surface: SurfaceKey;
  absFactor: number; brakeTorque: number; driveTorque: number;
  springF: number; damperF: number; bumpStop: boolean; travelFrac: number;
  centre: V3; contact: V3; contactN: V3; grounded: boolean;
  lastImpactT: number;
}

export class Vehicle {
  P: VehicleParams;
  // derived geometry
  a: number; b: number; hcg: number; R: number; mS: number; mTot: number;
  I: V3;
  // body state
  pos = v3(); vel = v3(); q: Quat = { w: 1, x: 0, y: 0, z: 0 }; w = v3();
  wheels: WheelState[] = [];
  // powertrain
  rpm = 0; omegaE = 0; boost = 0; ignition = false; crankT = 0;
  selector: Selector = 'P'; gear = 1; targetGear = 1; shiftT = 0; manualGear = 1;
  driveMode: DriveMode = '2H'; rearLocker = false; lockup = false;
  tcSlip = 0; turbineOmega = 0; engineTorque = 0; pumpTorque = 0;
  windup = 0; windupTorque = 0; lockAngle = 0;
  // assists
  vscOn = true; dacOn = false; vscActive = false; trcActive = false; absActive = false; hacT = 0; dacActive = false;
  // outputs / telemetry
  t = 0; odometer = 0; accelBody = v3(); prevVel = v3(); bellyScrape = 0; bellyMinClear = 1;
  impacts: ImpactEvent[] = [];
  speed = 0; yawRate = 0; roll = 0; pitch = 0; seatAz = 0; prevSeatVz = 0;
  input: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  steerWheelAngle = 0;
  bellyPoints: V3[] = [];

  // temps
  private _a = v3(); private _b = v3(); private _c = v3(); private _d = v3(); private _e = v3(); private _f = v3();
  private up = v3(); private fwd = v3(); private left = v3(); private _n = v3();

  constructor(params: VehicleParams = FORTUNER) {
    this.P = params;
    const P = params;
    const L = P.wheelbase.v;
    this.hcg = P.cgHeight.v;
    this.R = P.tyreRadius.v;
    this.mTot = P.kerbMass.v + P.driverMass.v;
    const mU = 2 * P.unsprungFront.v + P.unsprungRear.v;
    this.mS = this.mTot - mU;
    this.a = L * (1 - P.frontAxleShare.v);  // CG → front axle
    this.b = L * P.frontAxleShare.v;        // CG → rear axle
    this.I = v3(P.inertiaPitch.v, P.inertiaYaw.v, P.inertiaRoll.v);
    const Rl = this.R - (this.mTot * G / 4) / P.tyreVerticalStiffness.v;
    const yW = Rl - this.hcg;
    const mk = (name: string, front: boolean, left: boolean): WheelState => ({
      name, front, left, driven: !front, mount: v3((left ? 1 : -1) * (front ? P.trackFront.v : P.trackRear.v) / 2, yW, front ? this.a : -this.b),
      s: 0, vw: 0, omega: 0, theta: 0, u: 0, vlat: 0, pen: 0, penPrev: 0, Fz: 0, Fx: 0, Fy: 0, kappa: 0, alpha: 0, slip: 0, steer: 0,
      surface: 'asphalt', absFactor: 1, brakeTorque: 0, driveTorque: 0, springF: 0, damperF: 0, bumpStop: false, travelFrac: 0.5,
      centre: v3(), contact: v3(), contactN: v3(0, 1, 0), grounded: false, lastImpactT: -1,
    });
    this.wheels = [mk('FL', true, true), mk('FR', true, false), mk('RL', false, true), mk('RR', false, false)];
    // underbody probe points (body frame): bumpers from approach/departure angles, mid-wheelbase from ramp-over angle.
    const oF = P.overhangFront.v, oR = P.overhangRear.v;
    const yBumperF = oF * Math.tan(P.approachDeg.v * Math.PI / 180) - this.hcg;
    const yBumperR = oR * Math.tan(P.departureDeg.v * Math.PI / 180) - this.hcg;
    const yMid = (L / 2) * Math.tan(P.rampOverDeg.v * Math.PI / 360) - this.hcg;
    const zMid = (this.a - this.b) / 2;
    for (const x of [-0.6, 0, 0.6]) {
      this.bellyPoints.push(v3(x, yBumperF, this.a + oF), v3(x, yBumperF + 0.06, this.a + oF * 0.55),
        v3(x, yMid, zMid), v3(x, yMid + 0.02, zMid + 0.5), v3(x, yMid + 0.02, zMid - 0.5),
        v3(x, yBumperR, -this.b - oR), v3(x, yBumperR + 0.05, -this.b - oR * 0.5));
    }
    this.bellyPoints.push(v3(0, P.groundClearance.v + 0.02 - this.hcg, this.a - 0.05)); // front diff / skid plate
    this.reset(0, 0, 0);
  }

  reset(x: number, z: number, heading: number) {
    const h = heightAt(x, z);
    set(this.pos, x, h + this.hcg + 0.02, z);
    this.q = { w: Math.cos(heading / 2), x: 0, y: Math.sin(heading / 2), z: 0 };
    set(this.vel, 0, 0, 0); set(this.w, 0, 0, 0);
    for (const wh of this.wheels) { wh.s = 0; wh.vw = 0; wh.omega = 0; wh.u = 0; wh.vlat = 0; wh.pen = 0; wh.penPrev = 0; wh.absFactor = 1; }
    this.windup = 0; this.lockAngle = 0; this.odometer = 0; this.shiftT = 0;
    this.boost = 0;
  }

  get kmh() { return this.speed * 3.6; }

  // ---------------- engine & transmission ----------------
  private torqueFull(rpm: number) {
    const c = this.P.torqueCurve.v; if (rpm <= c[0][0]) return c[0][1] * Math.max(0, rpm / c[0][0]);
    for (let i = 1; i < c.length; i++) if (rpm <= c[i][0]) { const t = (rpm - c[i - 1][0]) / (c[i][0] - c[i - 1][0]); return lerp(c[i - 1][1], c[i][1], t); }
    return c[c.length - 1][1];
  }
  private frictionTorque(rpm: number) { return rpm < 50 ? 0 : this.P.frictionTorque0.v + this.P.frictionTorquePerKrpm.v * rpm / 1000; }
  private spool(rpm: number) { const [a, b] = this.P.turboSpoolRpm.v; return 0.15 + 0.85 * sstep(a * 0.7, b, rpm); }

  gearRatio(g = this.gear): number { if (this.selector === 'R') return -this.P.reverseRatio.v; if (this.selector === 'N' || this.selector === 'P') return 0; return this.P.gearRatios.v[g - 1]; }
  transferRatio() { return this.driveMode === '4L' ? this.P.lowRange.v : 1; }

  setSelector(s: Selector) {
    if ((s === 'R' || s === 'P') && Math.abs(this.speed) > 1.5) return false;
    if (s === 'D' && this.selector === 'R' && this.speed > 1.5) return false;
    this.selector = s; if (s === 'D' || s === 'M') { this.gear = this.targetGear = 1; this.manualGear = 1; } return true;
  }
  setDriveMode(m: DriveMode): string | null {
    if (m === '4L' || this.driveMode === '4L') { if (Math.abs(this.speed) > 1.0 || (this.selector !== 'N' && this.selector !== 'P')) return 'Stop and select N to shift into or out of 4L'; }
    if (m === '4H' && this.speed > 100 / 3.6) return '2H↔4H only below 100 km/h';
    this.driveMode = m; if (m !== '4L') { this.rearLocker = false; this.dacOn = false; } return null;
  }
  toggleLocker(): string | null {
    if (!this.rearLocker && this.driveMode !== '4L') return 'Rear diff lock works in 4L only';
    if (!this.rearLocker && this.speed > 8 / 3.6) return 'Engage the rear diff lock below 8 km/h';
    this.rearLocker = !this.rearLocker; return null;
  }
  shiftManual(d: number) { if (this.selector !== 'M') { this.selector = 'M'; this.manualGear = this.gear; } this.manualGear = clamp(this.manualGear + d, 1, 6); }

  private autoShift(dt: number, throttle: number) {
    if (this.shiftT > 0) { this.shiftT -= dt; if (this.shiftT <= this.P.shiftTime.v / 2 && this.gear !== this.targetGear) this.gear = this.targetGear; return; }
    if (this.selector === 'M') { if (this.manualGear !== this.gear) { this.targetGear = this.manualGear; this.shiftT = this.P.shiftTime.v; } return; }
    if (this.selector !== 'D') return;
    const out = this.turbineOmega * 60 / (2 * Math.PI); // turbine rpm in current gear
    const ratios = this.P.gearRatios.v;
    const outShaft = out / ratios[this.gear - 1];
    const lowRange = this.driveMode === '4L';
    const upRpm = lerp(1750, 3450, sstep(0.05, 0.95, throttle)) * (lowRange ? 0.9 : 1);
    const downRpm = lerp(1150, 2300, sstep(0.1, 0.95, throttle));
    if (this.gear < 6 && out > upRpm && this.speed > 1) { this.targetGear = this.gear + 1; this.shiftT = this.P.shiftTime.v; }
    else if (this.gear > 1) {
      const rpmAfter = outShaft * ratios[this.gear - 2];
      const kick = throttle > 0.92 && this.kickArm && rpmAfter < 3500;
      if (out < downRpm || kick) { this.targetGear = this.gear - 1; this.shiftT = this.P.shiftTime.v * 0.8; if (kick) this.kickArm = false; }
    }
    if (throttle < 0.85) this.kickArm = true;
  }
  private kickArm = true;
  private idleI = 0;

  // ---------------- main step ----------------
  step(dt: number) {
    const P = this.P, inp = this.input;
    this.t += dt;
    this.impacts.length = 0 as any;
    const up = rotate(this.q, set(this._a, 0, 1, 0), this.up);
    const fwd = rotate(this.q, set(this._a, 0, 0, 1), this.fwd);
    const left = rotate(this.q, set(this._a, 1, 0, 0), this.left);
    const Fb = set(this._b, 0, -this.mS * G, 0); // world force on body
    const Tb = set(this._c, 0, 0, 0);            // world torque on body (about CG)
    const vF = dot(this.vel, fwd);
    this.speed = Math.abs(vF);

    // ---- steering (Ackermann) ----
    const L = P.wheelbase.v, tr = P.trackFront.v;
    const dMax = P.maxRoadWheelDeg.v * Math.PI / 180;
    const dC = inp.steer * dMax * 0.88; // centre angle; inner wheel reaches dMax
    if (Math.abs(dC) > 1e-4) {
      const Rt = L / Math.tan(Math.abs(dC));
      const di = Math.atan(L / (Rt - tr / 2)), dO = Math.atan(L / (Rt + tr / 2));
      const sgn = Math.sign(dC);
      this.wheels[0].steer = sgn * (sgn > 0 ? di : dO); this.wheels[1].steer = sgn * (sgn > 0 ? dO : di);
    } else { this.wheels[0].steer = this.wheels[1].steer = 0; }
    this.steerWheelAngle = dC * P.steerRatio.v;

    // ---- engine ----
    // pedal map: gentle tip-in like a Toyota drive-by-wire map (15 % pedal ≈ 22 % torque request, full = full)
    let thr = Math.pow(clamp(inp.throttle, 0, 1), 0.8);
    if (!this.ignition) thr = 0;
    const rpm = this.omegaE * 60 / (2 * Math.PI);
    // idle governor (adds fuel below ~idle when the driver is off throttle)
    const idleErr = (P.idleRpm.v - rpm) / 300;
    this.idleI = clamp(this.idleI + idleErr * dt * 0.8, -0.05, 0.25);
    // governor and pedal add (the governor holds idle under converter load; the pedal asks for torque on top of it)
    const gov = clamp(idleErr * 1.6 + 0.09 + this.idleI, 0, 0.7) * (rpm < P.idleRpm.v + 400 ? 1 : 0);
    let fuel = this.ignition ? Math.min(1, thr + gov * (1 - thr)) : 0;
    if (rpm > P.redlineRpm.v) fuel = 0;
    const cut = (this.shiftT > 0 && this.selector !== 'N' ? 0.75 : 1) * (this.trcCut > 0 ? 1 - this.trcCut : 1); // shift torque reduction, A-TRC
    fuel *= cut;
    const bTarget = fuel * this.spool(rpm);
    const tau = lerp(P.turboLagLow.v, P.turboLagHigh.v, sstep(1200, 3000, rpm));
    this.boost += (bTarget - this.boost) * Math.min(1, dt / tau);
    const tFull = this.torqueFull(rpm), na = P.naTorqueFraction.v;
    const boostFrac = clamp(this.boost / Math.max(0.05, this.spool(rpm)), 0, 1);
    const tAvail = tFull * (na + (1 - na) * boostFrac);
    const tFric = this.frictionTorque(rpm);
    // Drive-by-wire: the pedal (or idle governor) requests a share of full-load torque; boost only caps it (smoke limit).
    // Full pedal gives exactly tAvail as before, so full-throttle calibration is unchanged; part pedal no longer gets scaled twice.
    this.engineTorque = this.ignition ? Math.min(fuel * (tFull + tFric), (tAvail + tFric) * cut) - tFric : -tFric;
    // starter
    if (this.crankT > 0) { this.crankT -= dt; this.engineTorque = Math.max(this.engineTorque, 60 * (rpm < 280 ? 1 : 0)); if (this.crankT <= 0) this.ignition = true; }

    // ---- driveline speeds ----
    const gr = this.gearRatio(), xr = this.transferRatio(), fd = P.finalDrive.v;
    const wRL = this.wheels[2].omega, wRR = this.wheels[3].omega, wFL = this.wheels[0].omega, wFR = this.wheels[1].omega;
    const propR = fd * (wRL + wRR) / 2, propF = fd * (wFL + wFR) / 2;
    const outShaft = propR * xr;
    const inGear = gr !== 0 && this.selector !== 'P';
    this.turbineOmega = inGear ? outShaft * gr : this.omegaE;
    // ---- torque converter ----
    const we = Math.max(this.omegaE, 0), wt = this.turbineOmega;
    let Tp = 0, Tt = 0;
    if (inGear) {
      const wStall = P.tcStallRpm.v * 2 * Math.PI / 60, cap = 500 / (wStall * wStall);
      const SR = we > 1 ? wt / we : (wt > 0 ? 2 : 0);
      // capacity shape: full at stall (SR=0), steep near coupling so slip at full load is ~5 % (typical)
      if (wt <= we) { Tp = cap * we * we * Math.pow(Math.max(0, 1 - SR), 0.4); }
      else { const sr = we / Math.max(wt, 1); Tp = -cap * 1.1 * wt * wt * Math.pow(Math.max(0, 1 - sr), 0.4); }
      const cp = P.tcCouplingPoint.v;
      const TR = SR < cp && wt <= we ? lerp(P.tcStallTorqueRatio.v, 1, Math.max(0, SR) / cp) : 1;
      Tt = Tp * TR;
      this.tcSlip = we > 1 ? clamp(1 - SR, 0, 1) : 0;
      // lock-up clutch
      this.lockup = this.selector !== 'R' && this.gear >= 3 && this.speed > 48 / 3.6 && thr < 0.75 && this.shiftT <= 0 && this.driveMode !== '4L';
      if (this.lockup) { const Tl = clamp(200 * (we - wt), -650, 650); Tp += Tl; Tt += Tl; this.tcSlip *= 0.1; }
    } else { this.tcSlip = 0; this.lockup = false; Tp = 0.004 * we; }
    this.pumpTorque = Tp;
    this.omegaE += (this.engineTorque - Tp) / P.engineInertia.v * dt;
    if (this.omegaE < 0) this.omegaE = 0;
    if (!this.ignition && this.crankT <= 0 && this.omegaE < 30) this.omegaE *= 0.98;
    this.rpm = this.omegaE * 60 / (2 * Math.PI);

    // ---- torque to axles ----
    const Tout = inGear ? Tt * gr * P.driveEff.v * (this.shiftT > 0 ? 0.85 : 1) : 0;
    let TpropTotal = Tout * xr;
    let TpropR = TpropTotal, TpropF = 0;
    if (this.driveMode !== '2H') {
      // locked centre: torsional coupling front↔rear propshaft (wind-up)
      this.windup += (propR - propF) * dt;
      const k = 9000, c = 40;
      this.windupTorque = k * this.windup + c * (propR - propF);
      TpropF = this.windupTorque; TpropR = TpropTotal - this.windupTorque;
      // slow wind-up release through tyre scrub is natural; clamp to shaft strength
      this.windup = clamp(this.windup, -0.6, 0.6);
    } else { this.windup = 0; this.windupTorque = 0; }
    const drive = [TpropF * fd / 2, TpropF * fd / 2, TpropR * fd / 2, TpropR * fd / 2];
    if (this.rearLocker) { this.lockAngle += (wRL - wRR) * dt; const Tl = 8000 * this.lockAngle + 60 * (wRL - wRR); drive[2] -= Tl; drive[3] += Tl; } else this.lockAngle = 0;

    // brake hydraulics: pressure builds with ~0.12 s time constant, releases faster
    this.brakePressure += (inp.brake - this.brakePressure) * Math.min(1, dt / (inp.brake > this.brakePressure ? 0.12 : 0.06));
    // ---- assists: ABS / A-TRC / VSC / HAC / DAC ----
    this.assists(dt, vF, drive);

    // ---- per wheel ----
    this.bellyScrape = 0;
    let anyGround = false;
    for (let i = 0; i < 4; i++) {
      const wh = this.wheels[i];
      const isFront = wh.front;
      const k = isFront ? P.springFront.v : P.springRear.v;
      const mU = isFront ? P.unsprungFront.v : P.unsprungRear.v / 2;
      const cornerS = this.mS * G * (isFront ? (1 - this.a / L) : (this.a / L)) / 2;
      // mount world position & velocity
      const rm = rotate(this.q, wh.mount, this._d);
      const mountW = set(this._e, this.pos.x + rm.x, this.pos.y + rm.y, this.pos.z + rm.z);
      const vMount = crossTo(this._f, this.w, rm); vMount.x += this.vel.x; vMount.y += this.vel.y; vMount.z += this.vel.z;
      const vMountUp = dot(vMount, up);
      // wheel centre
      const C = wh.centre; set(C, mountW.x - up.x * wh.s, mountW.y - up.y * wh.s, mountW.z - up.z * wh.s);
      const sdot = -(wh.vw - vMountUp); // + = extending (wheel moving down relative to body)
      // ---- suspension force (+ pushes body up / wheel down) ----
      let Fs = Math.max(0, cornerS - k * wh.s);
      const bumpT = isFront ? P.bumpTravelFront.v : P.bumpTravelRear.v, droopT = isFront ? P.droopTravelFront.v : P.droopTravelRear.v;
      const cb = isFront ? P.damperBumpFront.v : P.damperBumpRear.v, crb = isFront ? P.damperReboundFront.v : P.damperReboundRear.v;
      const vk = P.damperKneeVel.v;
      const comp = -sdot; // compression velocity (+ = closing)
      const dampLin = (c: number, v: number) => Math.abs(v) < vk ? c * v : Math.sign(v) * c * (vk + (Math.abs(v) - vk) * 0.45);
      const Fd = comp > 0 ? dampLin(cb, comp) : dampLin(crb, comp);
      wh.springF = Fs; wh.damperF = Fd;
      Fs += Fd;
      // anti-roll bar (pairs 0/1 and 2/3)
      const o = this.wheels[i ^ 1];
      Fs += (isFront ? P.arbFront.v : P.arbRear.v) * (o.s - wh.s) * 0.5;
      // bump stop (progressive) and rebound stop
      wh.bumpStop = false;
      const bpen = -wh.s - bumpT;
      if (bpen > 0) {
        Fs += P.bumpStopRate.v * bpen * bpen + 3000 * Math.max(0, comp) * Math.min(1, bpen / 0.01);
        if (bpen > 0.035) Fs += 3e6 * (bpen - 0.035);
        wh.bumpStop = true;
      }
      const rpen = wh.s - droopT;
      if (rpen > 0) Fs -= 2.5e5 * rpen + 2500 * sdot;
      wh.travelFrac = clamp((wh.s + bumpT) / (bumpT + droopT), 0, 1);

      // ---- tyre / ground contact (rigid ring over the true profile) ----
      const steer = wh.steer;
      const cs = Math.cos(steer), sn = Math.sin(steer);
      // wheel heading = fwd rotated about up by steer (+ = left)
      const fwx = fwd.x * cs + left.x * sn, fwy = fwd.y * cs + left.y * sn, fwz = fwd.z * cs + left.z * sn;
      const R = this.R;
      let pen = -1, bx = C.x, by = 0, bz = C.z, bxk = 0;
      for (let kk = -4; kk <= 4; kk++) {
        const xk = kk * 0.16 * R;
        const px = C.x + fwx * xk, pz = C.z + fwz * xk;
        const h = heightAt(px, pz);
        const pk = h - (C.y + fwy * xk - Math.sqrt(R * R - xk * xk));
        if (pk > pen) { pen = pk; bx = px; by = h; bz = pz; bxk = xk; }
      }
      const surfKey = surfaceAt(C.x, C.z); wh.surface = surfKey; const surf = SURFACES[surfKey];
      const sink = surf.sink;
      pen += sink * 0.0; // sinkage handled through rolling resistance
      const n = this._n;
      if (Math.abs(bxk) < 1e-6) { // flat contact: ground normal
        const e = 0.08, hx = heightAt(bx + e, bz) - heightAt(bx - e, bz), hz = heightAt(bx, bz + e) - heightAt(bx, bz - e);
        normTo(n, set(n, -hx / (2 * e), 1, -hz / (2 * e)));
      } else normTo(n, set(n, C.x - bx, C.y - by, C.z - bz)); // edge contact: force points to wheel centre
      set(wh.contactN, n.x, n.y, n.z); set(wh.contact, bx, by, bz);
      let Fz = 0;
      if (pen > 0) {
        const penRate = (pen - wh.penPrev) / dt;
        Fz = Math.max(0, P.tyreVerticalStiffness.v * pen + P.tyreVerticalDamping.v * penRate);
        if (pen > 0.09) Fz += 4e6 * (pen - 0.09); // rim contact
        anyGround = true;
      }
      wh.penPrev = pen > 0 ? pen : 0; wh.pen = pen; wh.grounded = Fz > 0; wh.Fz = Fz;
      // contact frame
      const lx = fwx - n.x * (fwx * n.x + fwy * n.y + fwz * n.z), ly = fwy - n.y * (fwx * n.x + fwy * n.y + fwz * n.z), lz = fwz - n.z * (fwx * n.x + fwy * n.y + fwz * n.z);
      const ll = Math.hypot(lx, ly, lz) || 1; const longx = lx / ll, longy = ly / ll, longz = lz / ll;
      const latx = n.y * longz - n.z * longy, laty = n.z * longx - n.x * longz, latz = n.x * longy - n.y * longx; // n × long = left
      // contact point velocity (body point at the contact)
      const rcx = bx - this.pos.x, rcy = by - this.pos.y, rcz = bz - this.pos.z;
      const vcx = this.vel.x + this.w.y * rcz - this.w.z * rcy, vcy = this.vel.y + this.w.z * rcx - this.w.x * rcz, vcz = this.vel.z + this.w.x * rcy - this.w.y * rcx;
      const vx = vcx * longx + vcy * longy + vcz * longz, vy = vcx * latx + vcy * laty + vcz * latz;
      const Re = R - Math.max(0, Math.min(pen, 0.06)) * 0.3;
      // ---- transient slip (bristle deflection) ----
      const Lx = P.relaxLenLong.v, Ly = P.relaxLenLat.v;
      const avx = Math.abs(vx);
      const vsx = vx - wh.omega * Re;
      if (Fz > 0) {
        wh.u += (-vsx - (avx / Lx) * wh.u) * dt;
        wh.vlat += (-vy - (avx / Ly) * wh.vlat) * dt;
      } else { wh.u *= 0.9; wh.vlat *= 0.9; }
      wh.u = clamp(wh.u, -1.2 * Lx, 1.2 * Lx); wh.vlat = clamp(wh.vlat, -1.0 * Ly, 1.0 * Ly);
      const kap = wh.u / Lx, alp = wh.vlat / Ly;
      wh.kappa = kap; wh.alpha = alp;
      // ---- force (MF similarity, combined slip) ----
      const kp = P.slipPeak.v, ap = Math.tan(P.slipAnglePeakDeg.v * Math.PI / 180);
      const sx = kap / kp, sy = alp / ap, s = Math.hypot(sx, sy);
      const Cmf = P.mfC.v, Bmf = Math.tan(Math.PI / (2 * Cmf));
      const Fz0 = this.mTot * G / 4;
      const mu = P.muPeak.v * surf.mu * (1 - P.loadSensitivity.v * (Fz / Fz0 - 1));
      let Fx = 0, Fy = 0;
      if (Fz > 0 && s > 1e-6) {
        const F = mu * Fz * Math.sin(Cmf * Math.atan(Bmf * s));
        Fx = F * sx / s; Fy = F * sy / s * 0.97;
        // low-speed lateral damping so a parked car doesn't creep/oscillate on the bristle spring
        const lsd = 1 - sstep(0.5, 3, avx);
        if (lsd > 0) Fy += lsd * -clamp(vy * 3, -1, 1) * mu * Fz * 0.3;
      }
      wh.Fx = Fx; wh.Fy = Fy; wh.slip = Math.min(1, s / 2.2);
      // ---- wheel spin ----
      const Iw = P.wheelInertia.v + (wh.driven || this.driveMode !== '2H' ? 0.35 : 0);
      const Trr = surf.rr * Fz * Re;
      let om = wh.omega + (drive[i] - Fx * Re) / Iw * dt;
      // rolling resistance & brakes as friction (cannot reverse spin)
      const brakeMax = isFront ? P.brakeTorqueFront.v : P.brakeTorqueRear.v;
      let Tbk = brakeMax * this.brakePressure * wh.absFactor + this.assistBrake[i];
      if (!isFront) Tbk += 2600 * inp.handbrake;
      if (this.selector === 'P') Tbk += isFront ? 0 : 6000;
      wh.brakeTorque = Tbk;
      const imp = (Tbk + Trr) / Iw * dt;
      om = Math.abs(om) <= imp ? 0 : om - Math.sign(om) * imp;
      wh.omega = om; wh.theta += om * dt; wh.driveTorque = drive[i];
      // ---- forces: tyre force vector ----
      const Ftx = n.x * Fz + longx * Fx + latx * Fy, Fty = n.y * Fz + longy * Fx + laty * Fy, Ftz = n.z * Fz + longz * Fx + latz * Fy;
      // along body-up → unsprung vertical dynamics; perpendicular part → body at roll-centre height
      const Fup = Ftx * up.x + Fty * up.y + Ftz * up.z;
      const Fhx = Ftx - up.x * Fup, Fhy = Fty - up.y * Fup, Fhz = Ftz - up.z * Fup;
      // Lateral part acts at the roll-centre height; longitudinal part at an "anti" height
      // (anti-dive front / anti-squat-lift rear as a fraction of CG height). Assumptions, see params.
      const hRC = isFront ? 0.12 : 0.45;
      const anti = isFront ? 0.25 : 0.35;
      const FlatS = Fhx * left.x + Fhy * left.y + Fhz * left.z;
      const FlonS = Fhx * fwd.x + Fhy * fwd.y + Fhz * fwd.z;
      const hL = R - hRC, hA = R - anti * this.hcg; // drop from wheel centre to application height
      const lpx = C.x - this.pos.x - up.x * hL, lpy = C.y - this.pos.y - up.y * hL, lpz = C.z - this.pos.z - up.z * hL;
      const apx = C.x - this.pos.x - up.x * hA, apy = C.y - this.pos.y - up.y * hA, apz = C.z - this.pos.z - up.z * hA;
      const fLx = left.x * FlatS, fLy = left.y * FlatS, fLz = left.z * FlatS;
      const fAx = fwd.x * FlonS, fAy = fwd.y * FlonS, fAz = fwd.z * FlonS;
      Fb.x += Fhx + up.x * Fs; Fb.y += Fhy + up.y * Fs; Fb.z += Fhz + up.z * Fs;
      Tb.x += lpy * fLz - lpz * fLy + apy * fAz - apz * fAy + rm.y * up.z * Fs - rm.z * up.y * Fs;
      Tb.y += lpz * fLx - lpx * fLz + apz * fAx - apx * fAz + rm.z * up.x * Fs - rm.x * up.z * Fs;
      Tb.z += lpx * fLy - lpy * fLx + apx * fAy - apy * fAx + rm.x * up.y * Fs - rm.y * up.x * Fs;
      // unsprung vertical: tyre up-force − suspension − gravity
      const prevVw = wh.vw;
      wh.vw += (Fup - Fs - mU * G * up.y) / mU * dt;
      const sdotNew = -(wh.vw - vMountUp);
      wh.s += sdotNew * dt;
      // impact events for audio (suspension closing fast)
      if (comp > 0.45 && this.t - wh.lastImpactT > 0.12) { this.impacts.push({ wheel: i as 0 | 1 | 2 | 3, velocity: comp, bumpStop: wh.bumpStop }); wh.lastImpactT = this.t; }
      else if (wh.bumpStop && bpen > 0.012 && this.t - wh.lastImpactT > 0.15) { this.impacts.push({ wheel: i as 0 | 1 | 2 | 3, velocity: Math.max(comp, 0.3), bumpStop: true }); wh.lastImpactT = this.t; }
      void prevVw;
    }

    // ---- underbody contact ----
    this.bellyMinClear = 9;
    const rearAxleDrop = (this.wheels[2].s + this.wheels[3].s) / 2;
    for (let k = 0; k < this.bellyPoints.length; k++) {
      const bp = this.bellyPoints[k];
      const r = rotate(this.q, bp, this._d);
      const px = this.pos.x + r.x, py = this.pos.y + r.y, pz = this.pos.z + r.z;
      const h = heightAt(px, pz); const clr = py - h;
      if (clr < this.bellyMinClear) this.bellyMinClear = clr;
      if (clr < 0) {
        const vpx = this.vel.x + this.w.y * r.z - this.w.z * r.y, vpy = this.vel.y + this.w.z * r.x - this.w.x * r.z, vpz = this.vel.z + this.w.x * r.y - this.w.y * r.x;
        const Fn = 6e5 * -clr + (vpy < 0 ? -vpy * 2.5e4 : 0);
        const vh = Math.hypot(vpx, vpz) || 1; const mu = 0.45;
        const fx = -vpx / vh * mu * Fn * Math.min(1, vh * 5), fz = -vpz / vh * mu * Fn * Math.min(1, vh * 5);
        Fb.x += fx; Fb.y += Fn; Fb.z += fz;
        Tb.x += r.y * fz - r.z * Fn; Tb.y += r.z * fx - r.x * fz; Tb.z += r.x * Fn - r.y * fx;
        this.bellyScrape = Math.max(this.bellyScrape, Math.min(1, (-clr * 30) * Math.min(1, vh / 3) + 0.2));
      }
    }
    // rear diff housing hangs on the live axle (unsprung): clearance = wheel-centre height − (R − GC)
    {
      const cL = this.wheels[2].centre, cR = this.wheels[3].centre;
      const dx = (cL.x + cR.x) / 2, dz = (cL.z + cR.z) / 2, dy = (cL.y + cR.y) / 2 - (this.R - P.groundClearance.v);
      const clr = dy - heightAt(dx, dz);
      if (clr < this.bellyMinClear) this.bellyMinClear = clr;
      if (clr < 0) { this.bellyScrape = Math.max(this.bellyScrape, Math.min(1, -clr * 40 + 0.2)); Fb.y += 3e5 * -clr; this.wheels[2].vw += 3e5 * -clr / P.unsprungRear.v * dt; this.wheels[3].vw += 3e5 * -clr / P.unsprungRear.v * dt; }
    }
    void rearAxleDrop;

    // ---- aero ----
    const sp = len(this.vel);
    if (sp > 0.1) {
      const Fa = 0.5 * 1.2 * P.cd.v * P.frontalArea.v * sp * sp;
      Fb.x -= this.vel.x / sp * Fa; Fb.y -= this.vel.y / sp * Fa; Fb.z -= this.vel.z / sp * Fa;
      const cpY = 0.95 - this.hcg; // centre of pressure ≈ 0.95 m above ground
      const r = rotate(this.q, set(this._e, 0, cpY, 0.2), this._e);
      Tb.x += r.y * (-this.vel.z / sp * Fa) - r.z * (-this.vel.y / sp * Fa);
      Tb.z += r.x * (-this.vel.y / sp * Fa) - r.y * (-this.vel.x / sp * Fa);
    }

    // ---- integrate body ----
    // horizontal motion carries the unsprung masses too
    const aUp = dot(Fb, up) / this.mS;
    const kH = this.mS / this.mTot;
    const ax = (Fb.x / this.mS - up.x * aUp) * kH + up.x * aUp, ay = (Fb.y / this.mS - up.y * aUp) * kH + up.y * aUp, az = (Fb.z / this.mS - up.z * aUp) * kH + up.z * aUp;
    this.vel.x += ax * dt; this.vel.y += ay * dt; this.vel.z += az * dt;
    this.pos.x += this.vel.x * dt; this.pos.y += this.vel.y * dt; this.pos.z += this.vel.z * dt;
    // angular (body frame)
    const wb = rotateInv(this.q, this.w, this._d), tb = rotateInv(this.q, Tb, this._e);
    const I = this.I;
    const Iwx = I.x * wb.x, Iwy = I.y * wb.y, Iwz = I.z * wb.z;
    const gx = wb.y * Iwz - wb.z * Iwy, gy = wb.z * Iwx - wb.x * Iwz, gz = wb.x * Iwy - wb.y * Iwx;
    wb.x += (tb.x - gx) / I.x * dt; wb.y += (tb.y - gy) / I.y * dt; wb.z += (tb.z - gz) / I.z * dt;
    rotate(this.q, wb, this.w);
    // quaternion integrate
    const q = this.q, hw = 0.5 * dt;
    const qw = q.w - hw * (this.w.x * q.x + this.w.y * q.y + this.w.z * q.z);
    const qx = q.x + hw * (this.w.x * q.w + this.w.y * q.z - this.w.z * q.y);
    const qy = q.y + hw * (this.w.y * q.w + this.w.z * q.x - this.w.x * q.z);
    const qz = q.z + hw * (this.w.z * q.w + this.w.x * q.y - this.w.y * q.x);
    const ql = Math.hypot(qw, qx, qy, qz); q.w = qw / ql; q.x = qx / ql; q.y = qy / ql; q.z = qz / ql;

    // ---- telemetry ----
    this.odometer += sp * dt;
    this.yawRate = dot(this.w, up);
    this.pitch = Math.asin(clamp(-fwd.y, -1, 1));
    this.roll = Math.asin(clamp(left.y, -1, 1));
    const aw = set(this._f, (this.vel.x - this.prevVel.x) / dt, (this.vel.y - this.prevVel.y) / dt + G, (this.vel.z - this.prevVel.z) / dt);
    const alpha = 0.02; // low-pass for display
    this.accelBody.x += (dot(aw, left) - this.accelBody.x) * alpha;
    this.accelBody.y += (dot(aw, up) - this.accelBody.y) * alpha;
    this.accelBody.z += (dot(aw, fwd) - this.accelBody.z) * alpha;
    set(this.prevVel, this.vel.x, this.vel.y, this.vel.z);
    // driver-seat vertical acceleration (RHD: driver on the right = −X), for comfort metrics
    const seat = rotate(this.q, set(this._e, -0.38, 0.35, 0.25), this._e);
    const vSeat = this.vel.y + this.w.z * seat.x - this.w.x * seat.z;
    this.seatAz = (vSeat - this.prevSeatVz) / dt; this.prevSeatVz = vSeat;
    this.autoShift(dt, thr);
    void anyGround;
  }

  // ---------------- driver aids ----------------
  assistBrake = [0, 0, 0, 0];
  brakePressure = 0;
  private trcCut = 0;
  private assists(dt: number, vF: number, drive: number[]) {
    const P = this.P, inp = this.input;
    this.assistBrake.fill(0);
    // ABS
    let abs = false;
    for (const wh of this.wheels) {
      const v = Math.abs(vF);
      const kap = v > 1 ? (wh.omega * this.R - vF) / v : 0;
      if (inp.brake > 0.05 && v > 2 && kap < -0.13 && wh.grounded) wh.absFactor = Math.max(0.12, wh.absFactor - 30 * dt);
      else wh.absFactor = Math.min(1, wh.absFactor + (inp.brake > 0.05 ? 6 : 20) * dt);
      if (wh.absFactor < 0.97 && inp.brake > 0.05) abs = true;
    }
    this.absActive = abs;
    // A-TRC (brake-based traction control on spinning driven wheels)
    this.trcActive = false; this.trcCut = Math.max(0, this.trcCut - dt * 2);
    const v = Math.max(1, Math.abs(vF));
    for (let i = 0; i < 4; i++) {
      const wh = this.wheels[i]; const driven = !wh.front || this.driveMode !== '2H';
      if (!driven || this.rearLocker) continue;
      const kap = (wh.omega * this.R - vF) / v;
      if (inp.throttle > 0.05 && kap > 0.22 && Math.abs(vF) < 60 / 3.6) { this.assistBrake[i] += clamp((kap - 0.22) * 6000, 0, 2200); this.trcActive = true; }
    }
    // VSC (yaw-rate error → single-wheel braking + torque cut)
    this.vscActive = false;
    if (this.vscOn && this.speed > 20 / 3.6 && this.driveMode !== '4L') {
      const L = P.wheelbase.v, Kus = 0.0035;
      const d = (this.wheels[0].steer + this.wheels[1].steer) / 2;
      let rRef = vF * d / (L * (1 + Kus * vF * vF));
      const rMax = 0.85 * G / Math.max(3, Math.abs(vF)); rRef = clamp(rRef, -rMax, rMax);
      const r = this.yawRate, err = r - rRef;
      const band = 0.11 + 0.25 * Math.abs(rRef);
      if (Math.abs(err) > band) {
        this.vscActive = true;
        const over = Math.abs(r) > Math.abs(rRef) && Math.sign(r) === Math.sign(rRef || r);
        const mag = clamp((Math.abs(err) - band) * 9000, 0, 3000);
        if (over) { const outerFront = r > 0 ? 1 : 0; this.assistBrake[outerFront] += mag; }
        else { const innerRear = rRef > 0 ? 2 : 3; this.assistBrake[innerRear] += mag; this.trcCut = Math.min(0.6, this.trcCut + dt * 3); }
      }
    }
    // HAC: hold for 2 s after brake release on a slope
    const slope = Math.abs(this.pitch);
    if (inp.brake > 0.2 && this.speed < 0.3 && slope > 0.05) this.hacT = 2;
    if (this.hacT > 0) { this.hacT -= dt; if (inp.throttle > 0.25 && this.engineTorque > 250) this.hacT = 0; if (inp.brake < 0.1 && this.hacT > 0) for (let i = 0; i < 4; i++) this.assistBrake[i] += 1800; }
    // DAC: 4L downhill speed control (~5 km/h)
    this.dacActive = false;
    if (this.dacOn && this.driveMode === '4L' && inp.throttle < 0.05 && inp.brake < 0.05 && this.speed > 4.5 / 3.6) {
      const e = this.speed - 5 / 3.6; const T = clamp(e * 5000, 0, 2500); for (let i = 0; i < 4; i++) this.assistBrake[i] += T; this.dacActive = true;
    }
    void drive;
  }

  startEngine() { if (!this.ignition && this.crankT <= 0) { this.crankT = 0.9; this.omegaE = Math.max(this.omegaE, 20); } }
  stopEngine() { this.ignition = false; }

  audioSurface(): Surface[] { return this.wheels.map(w => (w.surface === 'grass' ? 'gravel' : w.surface) as Surface); }
}
