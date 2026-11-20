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
import { Hull } from './hull';
import { colliders } from '../world/colliders';
import { CarCollide } from './collide';
import { Damage } from './damage';
import { CrashRecorder } from './crashRecorder';

/** A body impact for audio and the camera (ground or a world object). */
export interface BodyImpact { energy: number; vn: number; zone: string; material: string }

/** Ground the vehicle drives on. Default: the analytic terrain (terrain.ts). Node tests inject synthetic ground. */
export interface GroundProvider { heightAt(x: number, z: number): number; surfaceAt(x: number, z: number): SurfaceKey }
export const TERRAIN_GROUND: GroundProvider = { heightAt, surfaceAt };

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
/** q ← exp(½·ω·h) ⊗ q: exact rotation by the world-frame angular velocity ω over h. */
function rotQuat(q: Quat, w: V3, h: number) {
  const wl = Math.hypot(w.x, w.y, w.z); if (wl < 1e-12) return;
  const a = 0.5 * wl * h, s = Math.sin(a) / wl, c = Math.cos(a);
  const dx = w.x * s, dy = w.y * s, dz = w.z * s;
  const nw = c * q.w - dx * q.x - dy * q.y - dz * q.z, nx = c * q.x + dx * q.w + dy * q.z - dz * q.y;
  const ny = c * q.y - dx * q.z + dy * q.w + dz * q.x, nz = c * q.z + dx * q.y - dy * q.x + dz * q.w;
  const ql = Math.hypot(nw, nx, ny, nz); q.w = nw / ql; q.x = nx / ql; q.y = ny / ql; q.z = nz / ql;
}

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
  rimPeak: number; rimSet: number; rimE: number; // rim-strike hysteresis state; rimE = elastic energy it can return (J)
  kerbSide: number;                              // −1/0/+1: side of a step (kerb face) under / beside the tyre
  vLong: number; vLat: number;                   // contact-point velocity along / across the wheel (m/s), for smoke & marks
  kerbPeak: number;                              // largest lateral kerb force on the rim side since repair (N), for wheel damage
}

export class Vehicle {
  P: VehicleParams;
  // derived geometry
  a: number; b: number; hcg: number; R: number; mS: number; mTot: number;
  /** Lateral CG offset from the geometric centreline (m, + = left); the body frame sits at the CG, so the centreline is at x = −xcg. */
  xcg: number;
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
  vscOn = true; dacOn = false; vscRollActive = false; rollRateBody = 0; vscActive = false; trcActive = false; absActive = false; hacT = 0; dacActive = false;
  // outputs / telemetry
  t = 0; odometer = 0; accelBody = v3(); prevVel = v3(); bellyScrape = 0; bellyMinClear = 1;
  impacts: ImpactEvent[] = [];
  speed = 0; yawRate = 0; roll = 0; pitch = 0; seatAz = 0; prevSeatVz = 0;
  input: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  steerWheelAngle = 0;
  bellyPoints: V3[] = [];
  // ---- crash state ----
  ground: GroundProvider;
  /** Upper-body collision hull (elastic-plastic points, friction anchors). Its crush survives reset; repair() clears it. */
  hull: Hull;
  /** Roll angle −π..π (atan2; `roll` stays asin for the HUD/tests). */
  rollFull = 0;
  /** Integrated body roll / pitch rotation since reset (rad, unbounded), and the largest |value| reached. */
  rollTotal = 0; pitchTotal = 0; rollMaxAbs = 0; pitchMaxAbs = 0;
  get quarterTurns() { return Math.floor(this.rollMaxAbs / (Math.PI / 2) + 1e-9); }
  get fullRolls() { return Math.floor(this.rollMaxAbs / (2 * Math.PI) + 1e-9); }
  get endOverEnds() { return Math.floor(this.pitchMaxAbs / (2 * Math.PI) + 1e-9); }
  /** Body angular speed above which the world-frame angular-momentum integrator is used (rad/s). */
  lIntThreshold = 1;
  /** Largest lateral kerb (sidewall/rim) force this step, N (telemetry). */
  kerbForce = 0;
  /** Elastic energy in the kerb contacts this step, J (energy audit). */
  kerbElastic = 0;
  private rearFlat = 0; private stepN = 0;
  /** World colliders (trees, posts, walls, cones) against the body. */
  collide = new CarCollide();
  /** Body, wheel and engine damage (survives reset; repair() clears it). */
  damage: Damage;
  /** Crash statistics (events open on a body hit, > 3 g or tilt > 60°). */
  recorder = new CrashRecorder();
  /** Body impacts (new hull ground contacts and world-object hits) since the last takeBodyImpacts(). */
  bodyImpacts: BodyImpact[] = [];
  /** Force of all body contacts (ground hull + objects) this step, world (N), and the zone of the latest contact. */
  lastBodyForce = v3(); lastContactZone = '';
  /** Why the engine stopped on its own (airbag / inverted / overheat), for the UI; cleared when read. */
  engineStopReason: string | null = null;
  private _fb0 = v3();

  // temps
  private _a = v3(); private _b = v3(); private _c = v3(); private _d = v3(); private _e = v3(); private _f = v3(); private _g = v3();
  private _qh: Quat = { w: 1, x: 0, y: 0, z: 0 };
  private _sPrev = [0, 0, 0, 0]; private _sdot = [0, 0, 0, 0]; private _sdotP = [0, 0, 0, 0];
  private up = v3(); private fwd = v3(); private left = v3(); private _n = v3();

  constructor(params: VehicleParams = FORTUNER, ground: GroundProvider = TERRAIN_GROUND) {
    this.P = params;
    this.ground = ground;
    const P = params;
    this.xcg = P.driverMass.v * P.driverSeatX.v / (P.kerbMass.v + P.driverMass.v);
    this.hull = new Hull(params, SURFACES, -this.xcg);
    this.damage = new Damage(this.hull);
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
      name, front, left, driven: !front, mount: v3((left ? 1 : -1) * (front ? P.trackFront.v : P.trackRear.v) / 2 - this.xcg, yW, front ? this.a : -this.b),
      s: 0, vw: 0, omega: 0, theta: 0, u: 0, vlat: 0, pen: 0, penPrev: 0, Fz: 0, Fx: 0, Fy: 0, kappa: 0, alpha: 0, slip: 0, steer: 0,
      surface: 'asphalt', absFactor: 1, brakeTorque: 0, driveTorque: 0, springF: 0, damperF: 0, bumpStop: false, travelFrac: 0.5,
      centre: v3(), contact: v3(), contactN: v3(0, 1, 0), grounded: false, lastImpactT: -1, rimPeak: 0, rimSet: 0, rimE: 0, kerbSide: 0, vLong: 0, vLat: 0, kerbPeak: 0,
    });
    this.wheels = [mk('FL', true, true), mk('FR', true, false), mk('RL', false, true), mk('RR', false, false)];
    // underbody probe points (body frame): bumpers from approach/departure angles, mid-wheelbase from ramp-over angle.
    const oF = P.overhangFront.v, oR = P.overhangRear.v;
    const yBumperF = oF * Math.tan(P.approachDeg.v * Math.PI / 180) - this.hcg;
    const yBumperR = oR * Math.tan(P.departureDeg.v * Math.PI / 180) - this.hcg;
    const yMid = (L / 2) * Math.tan(P.rampOverDeg.v * Math.PI / 360) - this.hcg;
    const zMid = (this.a - this.b) / 2;
    for (const x0 of [-0.6, 0, 0.6]) {
      const x = x0 - this.xcg;
      this.bellyPoints.push(v3(x, yBumperF, this.a + oF), v3(x, yBumperF + 0.06, this.a + oF * 0.55),
        v3(x, yMid, zMid), v3(x, yMid + 0.02, zMid + 0.5), v3(x, yMid + 0.02, zMid - 0.5),
        v3(x, yBumperR, -this.b - oR), v3(x, yBumperR + 0.05, -this.b - oR * 0.5));
    }
    this.bellyPoints.push(v3(-this.xcg, P.groundClearance.v + 0.02 - this.hcg, this.a - 0.05)); // front diff / skid plate
    this.reset(0, 0, 0);
  }

  setGround(g: GroundProvider) { this.ground = g; }
  /** Restores the crushed body (hull) and its energy books. Backspace/reset keeps damage; Y repairs (Stage 2 key). */
  repair() { this.hull.repair(); this.damage.repair(); for (const w of this.wheels) { w.kerbPeak = 0; w.rimPeak = 0; w.rimSet = 0; } this.collide.Wbreak = 0; this.collide.Wfric = 0; }

  reset(x: number, z: number, heading: number) {
    // nudge out of solid colliders (trees, posts, buildings) so the car never lands inside one
    if (colliders.size && !colliders.isFree(x, z, 2.6)) {
      search: for (let r = 1; r <= 40; r++) for (let k = 0; k < 16; k++) {
        const a = k * Math.PI / 8, xx = x + r * Math.sin(a), zz = z + r * Math.cos(a);
        if (colliders.isFree(xx, zz, 2.6)) { x = xx; z = zz; break search; }
      }
    }
    const h = this.ground.heightAt(x, z);
    set(this.pos, x, h + this.hcg + 0.02, z);
    this.q = { w: Math.cos(heading / 2), x: 0, y: Math.sin(heading / 2), z: 0 };
    set(this.vel, 0, 0, 0); set(this.w, 0, 0, 0);
    for (const wh of this.wheels) { wh.s = 0; wh.vw = 0; wh.omega = 0; wh.u = 0; wh.vlat = 0; wh.pen = 0; wh.penPrev = 0; wh.absFactor = 1; wh.rimPeak = 0; wh.rimSet = 0; wh.rimE = 0; wh.kerbSide = 0; }
    this.windup = 0; this.lockAngle = 0; this.odometer = 0; this.shiftT = 0;
    this.boost = 0; this.trcEng = 0; this.trcEngI = 0; this._sdot.fill(0);
    this.hull.clearContacts(); this.collide.clear(); this.recorder.cancel(); this.damage.resetMotion();
    this.rollTotal = 0; this.pitchTotal = 0; this.rollMaxAbs = 0; this.pitchMaxAbs = 0;
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
  /** First press from D (or any non-M selector) only switches to M at the current gear, cancelling an auto-shift in
   *  progress (Toyota sequential mode); later presses shift. */
  shiftManual(d: number) {
    if (this.selector !== 'M') { this.selector = 'M'; this.manualGear = this.gear; this.targetGear = this.gear; return; }
    this.manualGear = clamp(this.manualGear + d, 1, 6);
  }

  private autoShift(dt: number, throttle: number) {
    if (this.shiftT > 0) { this.shiftT -= dt; if (this.shiftT <= this.P.shiftTime.v / 2 && this.gear !== this.targetGear) this.gear = this.targetGear; return; }
    if (this.selector === 'M') {
      // the TCU still protects the engine: below ~1000 turbine rpm (or with the output turning backwards) it downshifts
      // one gear at a time down to 1st, as Toyota's sequential mode does when the car slows
      const tRpm = this.turbineOmega * 60 / (2 * Math.PI);
      if (this.manualGear > 1 && this.gear === this.manualGear && tRpm < 1000 && this.speed < 60 / 3.6) this.manualGear--;
      if (this.manualGear !== this.gear) { this.targetGear = this.manualGear; this.shiftT = this.P.shiftTime.v; }
      return;
    }
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
  /** True after the engine died under load (ignition dropped); cleared by startEngine(). */
  stalled = false;
  /** False from a start until the engine first reaches 600 rpm (the stall check is armed after that). */
  engineRunning = true; private runUpT = 0;
  /** Test hook: force the lock-up clutch on (true) / off (false); null = TCU logic. */
  lockupOverride: boolean | null = null;
  private lockupHold = 0; private prevPropR = 0;

  // ---------------- main step ----------------
  step(dt: number) {
    const P = this.P, inp = this.input, gnd = this.ground;
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
    const dmg = this.damage;
    if (dmg.wheelFault) for (let i = 0; i < 4; i++) this.wheels[i].steer = (i < 2 ? this.wheels[i].steer : 0) + dmg.toe[i]; // bent track rod / axle
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
    const eCut = this.trcCut > this.trcEng ? this.trcCut : this.trcEng; // VSC and A-TRC engine torque requests (the larger wins)
    const cut = (this.shiftT > 0 && this.selector !== 'N' ? 0.75 : 1) * (eCut > 0 ? 1 - eCut : 1); // shift torque reduction, A-TRC/VSC
    fuel *= cut;
    const bTarget = dmg.intercooler ? 0 : fuel * this.spool(rpm); // holed intercooler: no boost
    const tau = lerp(P.turboLagLow.v, P.turboLagHigh.v, sstep(1200, 3000, rpm));
    this.boost += (bTarget - this.boost) * Math.min(1, dt / tau);
    const tFull = this.torqueFull(rpm), na = P.naTorqueFraction.v;
    const boostFrac = clamp(this.boost / Math.max(0.05, this.spool(rpm)), 0, 1);
    const tAvail = tFull * (na + (1 - na) * boostFrac);
    const tFric = this.frictionTorque(rpm);
    // Drive-by-wire: the pedal (or idle governor) requests a share of full-load torque; boost only caps it (smoke limit).
    // Full pedal gives exactly tAvail as before, so full-throttle calibration is unchanged; part pedal no longer gets scaled twice.
    this.engineTorque = this.ignition ? Math.min(fuel * (tFull + tFric), (tAvail + tFric) * cut) - tFric : -tFric;
    if (dmg.derate < 1 && this.engineTorque > 0) this.engineTorque *= dmg.derate; // overheating (coolant leak)
    // starter
    if (this.crankT > 0) { this.crankT -= dt; this.engineTorque = Math.max(this.engineTorque, 60 * (rpm < 280 ? 1 : 0)); if (this.crankT <= 0 && !dmg.engineDead) this.ignition = true; }

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
      // capacity shape: full at stall (SR=0), steep near coupling so slip at full load is ~5 % (typical).
      // SR < 0 (turbine turning backwards, e.g. the car sliding backwards in a forward gear): the pump works against
      // the reversed turbine flow and absorbs more than at stall; bounded at 1.74 × stall capacity (SR ≤ −3).
      if (wt <= we) { Tp = cap * we * we * Math.pow(Math.min(4, Math.max(0, 1 - SR)), 0.4); }
      else { const sr = we / Math.max(wt, 1); Tp = -cap * 1.1 * wt * wt * Math.pow(Math.max(0, 1 - sr), 0.4); }
      const cp = P.tcCouplingPoint.v;
      const TR = SR < cp && wt <= we ? lerp(P.tcStallTorqueRatio.v, 1, Math.max(0, SR) / cp) : 1;
      Tt = Tp * TR;
      this.tcSlip = we > 1 ? clamp(1 - SR, 0, 1) : 0;
      // lock-up clutch
      // Lock-up clutch (TCU logic). It releases at once on brake or handbrake, on a fast wheel deceleration, on driven-wheel
      // slip, at low output speed (judged from the driven wheels, not the body) and while the car is far from straight
      // running; it re-engages only after 1 s of calm. Without this a locked rear axle stalls the engine through the clutch.
      const vOut = Math.abs(propR / fd) * this.R;                 // driven-wheel surface speed
      const wheelDecel = (this.prevPropR - propR) / fd / dt;      // rad/s² at the driven wheels (+ = slowing)
      this.prevPropR = propR;
      let slipD = 0; for (let k = 2; k < 4; k++) { const kp = Math.abs(this.wheels[k].kappa) + Math.abs(this.wheels[k].alpha) * 0.5; if (kp > slipD) slipD = kp; }
      const calm = inp.brake < 0.05 && inp.handbrake < 0.02 && wheelDecel < 12 && slipD < 0.12 && Math.abs(this.yawRate) < 0.6;
      const allowed = this.selector !== 'R' && this.gear >= 3 && vOut > 48 / 3.6 && thr < 0.75 && this.shiftT <= 0 && this.driveMode !== '4L';
      if (!calm || !allowed) this.lockupHold = 0; else this.lockupHold += dt;
      this.lockup = this.lockupOverride ?? (allowed && calm && (this.lockup || this.lockupHold > 1));
      if (this.lockup) { const Tl = clamp(200 * (we - wt), -650, 650); Tp += Tl; Tt += Tl; this.tcSlip *= 0.1; }
    } else { this.tcSlip = 0; this.lockup = false; Tp = 0.004 * we; }
    this.pumpTorque = Tp;
    this.omegaE += (this.engineTorque - Tp) / P.engineInertia.v * dt;
    if (this.omegaE < 0) this.omegaE = 0;
    // Stall: only once the engine has run up to idle after a start (the starter hands over at ~250–300 rpm and the
    // engine then runs up on its own). A start that never reaches 600 rpm within 2 s also counts as a stall.
    if (this.ignition && this.crankT <= 0) {
      if (!this.engineRunning) { this.runUpT += dt; if (this.rpmNow() > 600) this.engineRunning = true; else if (this.runUpT > 2) { this.ignition = false; this.stalled = true; } }
      else if (this.omegaE < 300 * Math.PI / 30) { this.ignition = false; this.stalled = true; this.engineRunning = false; }
    }
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
    // Wheel vw is the absolute speed along body-up; when up rotates, v·(ω×up) changes it kinematically (finding F12).
    const wUp = dot(this.w, up), wPerp2 = dot(this.w, this.w) - wUp * wUp;
    const kinB = wPerp2 > 1 ? sstep(1, 1.5, Math.sqrt(wPerp2)) : 0; // tumbling blend for the rigid force share
    const wxu = crossTo(this._g, this.w, up);
    this.bellyScrape = 0;
    let anyGround = false;
    let gMax = -Infinity; // highest ground sampled this step (hull cull)
    this.kerbForce = 0; this.kerbElastic = 0; this.rearFlat = 0; this.stepN++;
    // Wheels read each other's state (anti-roll bar s, live-axle scrub ṡ) from the start of the step, so the result does
    // not depend on the update order (left was updated before right: a one-step left/right bias on a symmetric car).
    const sPrev = this._sPrev, sdP = this._sdotP;
    for (let i = 0; i < 4; i++) { sPrev[i] = this.wheels[i].s; sdP[i] = this._sdot[i]; }
    for (let i = 0; i < 4; i++) {
      const wh = this.wheels[i];
      const isFront = wh.front;
      const k = isFront ? P.springFront.v : P.springRear.v;
      const mU = isFront ? P.unsprungFront.v : P.unsprungRear.v / 2;
      // static preload: axle share × side share about the CG (the CG sits xcg off the centreline, driver's side heavier)
      const cornerS = this.mS * G * (isFront ? (1 - this.a / L) : (this.a / L)) * (0.5 + (wh.left ? 1 : -1) * this.xcg / (isFront ? P.trackFront.v : P.trackRear.v));
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
      if (dmg.wheelFault) Fs *= dmg.springK[i]; // collapsed suspension
      const bumpT = isFront ? P.bumpTravelFront.v : P.bumpTravelRear.v, droopT = isFront ? P.droopTravelFront.v : P.droopTravelRear.v;
      const cb = isFront ? P.damperBumpFront.v : P.damperBumpRear.v, crb = isFront ? P.damperReboundFront.v : P.damperReboundRear.v;
      const vk = P.damperKneeVel.v;
      const comp = -sdot; // compression velocity (+ = closing)
      const dampLin = (c: number, v: number) => Math.abs(v) < vk ? c * v : Math.sign(v) * c * (vk + (Math.abs(v) - vk) * 0.45);
      const Fd = comp > 0 ? dampLin(cb, comp) : dampLin(crb, comp);
      wh.springF = Fs; wh.damperF = Fd;
      Fs += dmg.wheelFault ? Fd * dmg.damperK[i] : Fd;
      // anti-roll bar (pairs 0/1 and 2/3)
      Fs += (isFront ? P.arbFront.v : P.arbRear.v) * (sPrev[i ^ 1] - wh.s) * 0.5;
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
      // tilted ring: the lowest point of a cambered tyre is R·cosθ + (w/2)·sinθ below the centre (= R below 37.7°)
      const axY = Math.abs(left.y * cs - fwd.y * sn);
      const Rr = axY > 0.61 ? Math.min(R, R * Math.sqrt(Math.max(0, 1 - axY * axY)) + 0.5 * P.tyreWidth.v * Math.min(1, axY)) : R;
      // Penetration is measured along the contact normal (radially to the ring), so the force is the gradient of a
      // potential: straight below the centre it is the same number as before; at an edge it is R − |C − P|.
      let pen = -1, bx = C.x, by = 0, bz = C.z, bxk = 0;
      const hl2 = fwx * fwx + fwz * fwz;
      for (let kk = -4; kk <= 4; kk++) {
        const xk = kk * 0.16 * Rr;
        const px = C.x + fwx * xk, pz = C.z + fwz * xk;
        const h = gnd.heightAt(px, pz); if (h > gMax) gMax = h;
        const dyc = C.y - h;
        const pk = kk === 0 ? Rr - dyc : Rr - Math.sqrt(hl2 * xk * xk + dyc * dyc) * (dyc >= 0 ? 1 : -1);
        if (pk > pen) { pen = pk; bx = px; by = h; bz = pz; bxk = xk; }
      }
      // ---- width-aware contact: a step across the tyre width (kerb, ledge, pothole rim) ----
      // The ring above only sees the centre line. When the tyre moves sideways (or a step is already under it) the
      // shoulders are sampled; with a step, the vertical penetration is the width-weighted mix of the low and high
      // ground (continuous as the face sweeps across the tread), and a sidewall/rim force acts on the face.
      const hwT = 0.5 * P.tyreWidth.v;
      const axhx = left.x * cs - fwd.x * sn, axhz = left.z * cs - fwd.z * sn, axhl = Math.hypot(axhx, axhz) || 1;
      const ux = axhx / axhl, uz = axhz / axhl; // horizontal wheel-left
      let stepOn = false, stS = 0, stF = 0, stLo = 0, stHi = 0, stYb = 0, stBx = 0, stBz = 0, stHm = 0;
      {
        const rbx = bx - this.pos.x, rby = by - this.pos.y, rbz = bz - this.pos.z;
        const vlat0 = (this.vel.x + this.w.y * rbz - this.w.z * rby) * ux + (this.vel.z + this.w.x * rby - this.w.y * rbx) * uz;
        if (wh.kerbSide !== 0 || ((this.stepN + i) & 3) === 0 && (vlat0 > 0.05 || vlat0 < -0.05)) { // idle wheels: every 4th step
          const both = wh.kerbSide !== 0, lead = vlat0 >= 0 ? 1 : -1;
          const hP = both || lead > 0 ? gnd.heightAt(bx + ux * hwT, bz + uz * hwT) : by;
          const hM = both || lead < 0 ? gnd.heightAt(bx - ux * hwT, bz - uz * hwT) : by;
          // a step is a departure from the local ground plane (last contact normal), not a smooth cross-slope
          const cn = wh.contactN, cy = cn.y > 0.3 ? cn.y : 1;
          const pP = by - (cn.x * ux + cn.z * uz) * hwT / cy, pM = by + (cn.x * ux + cn.z * uz) * hwT / cy;
          const isStep = both || Math.abs((lead > 0 ? hP - pP : hM - pM)) > 0.03 ? Math.max(Math.abs(hP - pP) * (both || lead > 0 ? 1 : 0), Math.abs(hM - pM) * (both || lead < 0 ? 1 : 0)) > 0.03 : false;
          const hi = Math.max(hP, hM, by), lo = Math.min(hP, hM, by);
          if (isStep && hi - lo > 0.03) {
            stS = hP - hM > 0 ? 1 : hP - hM < 0 ? -1 : (hP > by ? 1 : -1); // side of the high ground
            const mid = 0.5 * (hi + lo);
            // locate the face along the wheel plane at the step's mid-height (a point rigid with the wheel)
            const ddm = (C.y - mid) / (up.y > 0.2 ? up.y : 0.2); stBx = C.x - up.x * ddm; stBz = C.z - up.z * ddm; stHm = mid;
            let a = -hwT, b = hwT; // face position along stS·u from the wheel plane: high ground beyond it
            for (let it = 0; it < 7; it++) { const m = 0.5 * (a + b); if (gnd.heightAt(stBx + ux * stS * m, stBz + uz * stS * m) > mid) b = m; else a = m; }
            stF = 0.5 * (a + b); stLo = lo; stHi = hi; stYb = by - pen; stepOn = true;
            // the tread part over the low ground carries the ring load; the step edge itself is a corner contact (below)
            const pl = lo - stYb, wf = clamp((hwT - stF) / (2 * hwT), 0, 1);
            pen = pl > 0 ? (1 - wf) * pl : pl;
            bxk = 0; by = stYb + Math.max(0, pen); // contact height on the tread
          }
        }
        wh.kerbSide = stepOn ? stS : 0;
      }
      const surfKey = gnd.surfaceAt(C.x, C.z); wh.surface = surfKey; const surf = SURFACES[surfKey];
      const sink = surf.sink;
      pen += sink * 0.0; // sinkage handled through rolling resistance
      const n = this._n;
      if (stepOn) set(n, 0, 1, 0); // tread on two flat levels
      else if (Math.abs(bxk) < 1e-6) { // flat contact: ground normal; penetration measured along it
        // central differences; across a discontinuity (a drop or ledge within ±8 cm) the flatter one-sided slope is used,
        // otherwise the normal would come out nearly horizontal and fling the car
        const e = 0.08, hxp = gnd.heightAt(bx + e, bz) - by, hxm = by - gnd.heightAt(bx - e, bz), hzp = gnd.heightAt(bx, bz + e) - by, hzm = by - gnd.heightAt(bx, bz - e);
        const sx = Math.abs(hxp - hxm) < 0.01 ? (hxp + hxm) / (2 * e) : (Math.abs(hxp) < Math.abs(hxm) ? hxp : hxm) / e;
        const sz = Math.abs(hzp - hzm) < 0.01 ? (hzp + hzm) / (2 * e) : (Math.abs(hzp) < Math.abs(hzm) ? hzp : hzm) / e;
        normTo(n, set(n, -sx, 1, -sz));
        if (n.y < 1 && n.y > 0.5) { const dyc = C.y - by; pen = Rr - dyc * n.y; const d = dyc * n.y; bx = C.x - n.x * d; by = C.y - n.y * d; bz = C.z - n.z * d; }
      } else normTo(n, set(n, C.x - bx, C.y - by, C.z - bz)); // edge contact: force points to wheel centre
      set(wh.contactN, n.x, n.y, n.z); set(wh.contact, bx, by, bz);
      let Fz = 0, gU = 1, un = 1;
      if (pen > 0) {
        const penRate = (pen - wh.penPrev) / dt;
        Fz = Math.max(0, (dmg.wheelFault ? P.tyreVerticalStiffness.v * dmg.kTyre[i] : P.tyreVerticalStiffness.v) * pen + P.tyreVerticalDamping.v * penRate);
        // rim contact: 4e6 N/m on loading; a rim strike is mostly plastic, so unloading runs 5× stiffer from the peak
        // (returns ~20 % of the energy). Never reached in normal driving (0 steps in simtest/humptest/feeltest/braketest).
        const pr = pen - 0.09;
        if (pr > 0) {
          if (pr >= wh.rimPeak) { wh.rimPeak = pr; wh.rimSet = 0.8 * pr; Fz += 4e6 * pr; wh.rimE = 0.5 * 4e6 * pr * pr / 5; }
          else { const f = Math.max(0, 2e7 * (pr - wh.rimSet)); Fz += f; wh.rimE = 0.5 * f * f / 2e7; }
        } else { wh.rimPeak = 0; wh.rimSet = 0; wh.rimE = 0; }
        // Uprightness: the normal force stays geometric (tilted ring, conservative); only the rolling-tyre slip model fades
        // out between 60° and 80° of tilt (gU 1 → 0) and hands over to plain sidewall sliding at the true contact point.
        un = up.x * n.x + up.y * n.y + up.z * n.z; if (un < 0.5) gU = un <= 0 ? 0 : sstep(0.17, 0.5, un);
        anyGround = true;
      }
      wh.penPrev = pen > 0 ? pen : 0; wh.pen = pen; wh.grounded = Fz > 0; wh.Fz = Fz;
      const FzT = gU < 1 ? Fz * gU : Fz; // load carried by the rolling-tyre (slip) model
      // contact frame
      const lx = fwx - n.x * (fwx * n.x + fwy * n.y + fwz * n.z), ly = fwy - n.y * (fwx * n.x + fwy * n.y + fwz * n.z), lz = fwz - n.z * (fwx * n.x + fwy * n.y + fwz * n.z);
      const ll = Math.hypot(lx, ly, lz) || 1; const longx = lx / ll, longy = ly / ll, longz = lz / ll;
      const latx = n.y * longz - n.z * longy, laty = n.z * longx - n.x * longz, latz = n.x * longy - n.y * longx; // n × long = left
      // contact point velocity (body point at the contact)
      const rcx = bx - this.pos.x, rcy = by - this.pos.y, rcz = bz - this.pos.z;
      const vcx = this.vel.x + this.w.y * rcz - this.w.z * rcy, vcy = this.vel.y + this.w.z * rcx - this.w.x * rcz, vcz = this.vel.z + this.w.x * rcy - this.w.y * rcx;
      let vx = vcx * longx + vcy * longy + vcz * longz, vy = vcx * latx + vcy * laty + vcz * latz;
      wh.vLong = vx - wh.omega * R; wh.vLat = vy; // sliding speed telemetry (smoke, marks)
      // Suspension geometry: the jacking pairs J (Fix A lateral, anti-dive/squat longitudinal) do work J·(relative
      // vertical speed). In a real linkage the contact patch scrubs sideways / fore-aft by exactly the matching amount and
      // the tyre force does the opposite work, so the scrub is added to the slip velocity here (geometric share only).
      const hRCw = isFront ? P.rollCentreFront.v : P.rollCentreRear.v, hAw = (isFront ? P.antiDiveFront.v : P.antiSquatRear.v) * this.hcg;
      const gFs = gU < (1 - kinB) ? gU : 1 - kinB;
      if (P.jackingForces.v && gFs > 0 && FzT > 0) {
        const halfT = (isFront ? P.trackFront.v : P.trackRear.v) / 2, zW = wh.mount.z;
        // relative speed along up between the RC / CG body points and the wheel
        const hLw = R - hRCw;
        const rjx = C.x - this.pos.x - up.x * hLw, rjy = C.y - this.pos.y - up.y * hLw, rjz = C.z - this.pos.z - up.z * hLw;
        const rjl = rjx * left.x + rjy * left.y + rjz * left.z;
        const qx = rjx - left.x * rjl, qy = rjy - left.y * rjl, qz = rjz - left.z * rjl; // RC on the centreline
        const vRCu = dot(this.vel, up) + (this.w.y * qz - this.w.z * qy) * up.x + (this.w.z * qx - this.w.x * qz) * up.y + (this.w.x * qy - this.w.y * qx) * up.z;
        const zO = isFront ? -this.b : this.a; // the other axle station (body reaction of the anti jacking)
        const vOu = dot(this.vel, up) + zO * ((this.w.y * fwd.z - this.w.z * fwd.y) * up.x + (this.w.z * fwd.x - this.w.x * fwd.z) * up.y + (this.w.x * fwd.y - this.w.y * fwd.x) * up.z);
        if (isFront) vy += gFs * (wh.left ? -1 : 1) * (hRCw / halfT) * (vRCu - wh.vw);
        // Live axle: roll scrub only. The axle rolling relative to the body about the lateral rod (left wheel rising)
        // swings the contact patches to the left, as a front wheel in bump does: Δvy = hRC·(ω_axle − ω_body), from the
        // suspension rates of the last step (the body's own roll is already in the contact-point velocity). Was
        // hRC·(vw3 − vw2)/t: reversed sign (the axle jacking pair below then fed axle roll instead of being dissipated by
        // the tyre) and absolute wheel speeds, which carry the pending jacking impulse (2·Ja·dt/m) and so read a false
        // rear slip in steady cornering.
        else vy += gFs * (hRCw / halfT) * (sdP[3] - sdP[2]) / 2;
        vx += gFs * -(hAw / (zW - zO)) * (vOu - wh.vw);
      }
      const Re = R - Math.max(0, Math.min(pen, 0.06)) * 0.3;
      // ---- transient slip (bristle deflection) ----
      const Lx = P.relaxLenLong.v, Ly = P.relaxLenLat.v;
      const avx = Math.abs(vx);
      const vsx = vx - wh.omega * Re;
      if (FzT > 0) {
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
      let mu = P.muPeak.v * surf.mu * Math.max(P.loadSensitivityMin.v, 1 - P.loadSensitivity.v * (FzT / Fz0 - 1));
      if (dmg.wheelFault) mu *= dmg.muTyre[i]; // flat tyre
      let Fx = 0, Fy = 0;
      const avy = Math.abs(vy);
      if (FzT > 0 && s > 1e-6) {
        const F = mu * FzT * Math.sin(Cmf * Math.atan(Bmf * s));
        Fx = F * sx / s; Fy = F * sy / s * 0.97;
        // low-speed lateral damping so a parked car doesn't creep/oscillate on the bristle spring
        // (only while the lateral speed is small too: it must not add grip to a car sliding sideways)
        const lsd = (1 - sstep(0.5, 3, avx)) * (avy < 1 ? 1 : 1 - sstep(1, 2, avy));
        if (lsd > 0) Fy += lsd * -clamp(vy * 3, -1, 1) * mu * FzT * 0.3;
        // soft-ground plough: soil berm ahead of a tyre sliding sideways (20–50° slip, above ~2 m/s lateral)
        if (avy > 1.5) {
          const pl = P.plough.v[surfKey] ?? 0;
          if (pl > 0) { const ph = sstep(0.349, 0.873, Math.atan2(avy, avx)) * sstep(1.5, 2.5, avy); if (ph > 0) Fy -= Math.sign(vy) * pl * FzT * ph; }
        }
      }
      // ---- step under the tyre: low-tread ramp term and the step-edge corner contact ----
      if (stepOn) {
        const ph = stHi - stYb, pl = stLo - stYb;
        const fx0 = -stS * ux, fz0 = -stS * uz; // horizontal, toward the low side
        // low tread: pen = (1 − wf)·pl depends on the face position → lateral force Fz·pl/(2·hw) toward the step
        if (Fz > 0 && pl > 0) {
          const Fr = -Fz * pl / (2 * hwT);
          const kx = bx - this.pos.x, ky = by - this.pos.y, kz = bz - this.pos.z;
          Fb.x += fx0 * Fr; Fb.z += fz0 * Fr; Tb.x += ky * fz0 * Fr; Tb.y += (kz * fx0 - kx * fz0) * Fr; Tb.z += -ky * fx0 * Fr;
        }
        // corner: the step edge inside the tyre section. Depth D = min(lateral dl, vertical ph) along the shorter way out
        // (minimum translation, continuous potential): sideways it presses the sidewall then the rim, upwards it lifts the
        // tyre onto the step with the tyre's own vertical law.
        const dl = hwT - stF;
        if (ph > 0 && dl > 0) {
          const lateral = dl <= ph, D = lateral ? dl : ph;
          const kx = stBx + ux * stS * stF - this.pos.x, ky = stHm - this.pos.y, kz = stBz + uz * stS * stF - this.pos.z;
          const vax = this.vel.x + this.w.y * kz - this.w.z * ky, vay = this.vel.y + this.w.z * kx - this.w.x * kz, vaz = this.vel.z + this.w.x * ky - this.w.y * kx;
          let F: number, V: number;
          if (lateral) {
            const rb = D - P.kerbSidewallBulge.v, rimOn = stHi > C.y - P.rimRadius.v && rb > 0;
            F = P.kerbCarcassRate.v * D + (rimOn ? P.kerbRimRate.v * rb : 0); V = 0.5 * P.kerbCarcassRate.v * D * D + (rimOn ? 0.5 * P.kerbRimRate.v * rb * rb : 0);
            const app = -(vax * fx0 + vaz * fz0); if (app > 0) F += 3e3 * app * Math.min(1, D / 0.01);
            Fb.x += fx0 * F; Fb.z += fz0 * F; Tb.x += ky * fz0 * F; Tb.y += (kz * fx0 - kx * fz0) * F; Tb.z += -ky * fx0 * F;
            if (rimOn && F > wh.kerbPeak) wh.kerbPeak = F; // telemetry only (wheel damage)
          } else {
            const rb = D - 0.09;
            F = P.tyreVerticalStiffness.v * D + (rb > 0 ? 4e6 * rb : 0); V = 0.5 * P.tyreVerticalStiffness.v * D * D + (rb > 0 ? 2e6 * rb * rb : 0);
            if (vay < 0) F += 3e3 * -vay * Math.min(1, D / 0.01);
            // along body-up to the wheel (it is the tyre being lifted), the rest to the body at the edge
            const fu = F * up.y; wh.vw += fu / mU * dt;
            const fbx = -up.x * fu, fby = F - up.y * fu, fbz = -up.z * fu;
            Fb.x += fbx; Fb.y += fby; Fb.z += fbz; Tb.x += ky * fbz - kz * fby; Tb.y += kz * fbx - kx * fbz; Tb.z += kx * fby - ky * fbx;
            anyGround = true;
          }
          this.kerbElastic += V; this.kerbForce = Math.max(this.kerbForce, F);
        }
      }
      wh.Fx = Fx; wh.Fy = Fy; wh.slip = Math.min(1, s / 2.2);
      // ---- wheel spin ----
      const Iw = P.wheelInertia.v + (wh.driven || this.driveMode !== '2H' ? 0.35 : 0);
      const Trr = dmg.wheelFault ? surf.rr * FzT * Re * dmg.rrTyre[i] + dmg.drag[i] : surf.rr * FzT * Re;
      let om = wh.omega + (drive[i] - Fx * Re) / Iw * dt;
      // rolling resistance & brakes as friction (cannot reverse spin)
      const brakeMax = isFront ? P.brakeTorqueFront.v : P.brakeTorqueRear.v;
      let Tbk = brakeMax * this.brakePressure * wh.absFactor * (isFront ? 1 : this.ebd) + this.assistBrake[i];
      if (!isFront) Tbk += 2600 * inp.handbrake;
      if (this.selector === 'P') Tbk += isFront ? 0 : 6000;
      wh.brakeTorque = Tbk;
      const imp = (Tbk + Trr) / Iw * dt;
      om = Math.abs(om) <= imp ? 0 : om - Math.sign(om) * imp;
      wh.omega = om; wh.theta += om * dt; wh.driveTorque = drive[i];
      // ---- forces: tyre force vector ----
      let Ftx = n.x * Fz + longx * Fx + latx * Fy, Fty = n.y * Fz + longy * Fx + laty * Fy, Ftz = n.z * Fz + longz * Fx + latz * Fy;
      if (gU < 1 && Fz > 0) { // tyre on its shoulder/side: plain sliding friction of the sidewall rubber
        // Coulomb limit, regularised by a capped viscous slope (an uncapped Fz/0.3 m/s slope is an unstable explicit damper)
        const vt = Math.hypot(vx, vy), fs = Math.min(0.7 * P.muPeak.v * surf.mu * Fz * (1 - gU), 2e4 * vt) / (vt || 1);
        Ftx -= (longx * vx + latx * vy) * fs; Fty -= (longy * vx + laty * vy) * fs; Ftz -= (longz * vx + latz * vy) * fs;
      }
      // along body-up → unsprung vertical dynamics; perpendicular part → body at roll-centre height
      const Fup = Ftx * up.x + Fty * up.y + Ftz * up.z;
      const Fhx = Ftx - up.x * Fup, Fhy = Fty - up.y * Fup, Fhz = Ftz - up.z * Fup;
      // Lateral part acts at the roll-centre height; longitudinal part at an "anti" height
      // (anti-dive front / anti-squat-lift rear as a fraction of CG height). Assumptions, see params.
      const hRC = isFront ? P.rollCentreFront.v : P.rollCentreRear.v;
      const anti = isFront ? P.antiDiveFront.v : P.antiSquatRear.v;
      let FlatS = Fhx * left.x + Fhy * left.y + Fhz * left.z;
      let FlonS = Fhx * fwd.x + Fhy * fwd.y + Fhz * fwd.z;
      const hL = R - hRC, hA = R - anti * this.hcg; // drop from wheel centre to application height
      const lpx = C.x - this.pos.x - up.x * hL, lpy = C.y - this.pos.y - up.y * hL, lpz = C.z - this.pos.z - up.z * hL;
      const apx = C.x - this.pos.x - up.x * hA, apy = C.y - this.pos.y - up.y * hA, apz = C.z - this.pos.z - up.z * hA;
      // Rigid share: the suspension-geometry path (RC / anti heights + jacking) is only energy-consistent for small tilt
      // and slow body rotation (it has no scrub motion and puts the force off its true line). Tilted beyond 20–40°, or
      // rolling/pitching faster than 1–1.5 rad/s, the ground normal force moves to the contact point; the slip forces
      // also fade with gU (60–80°). gN = gF = 1 in all upright driving, which keeps that path bit-identical.
      const gR = 1 - kinB, gT = up.y >= 0.94 ? 1 : sstep(0.766, 0.94, up.y);
      const gN = gR < gT ? gR : gT, gF = gR < gU ? gR : gU;
      if (gN < 1 || gF < 1) {
        const Nu = Fz * (n.x * up.x + n.y * up.y + n.z * up.z);
        const nhx = n.x * Fz - up.x * Nu, nhy = n.y * Fz - up.y * Nu, nhz = n.z * Fz - up.z * Nu; // normal ⟂ up
        const thx = Fhx - nhx, thy = Fhy - nhy, thz = Fhz - nhz;                                   // friction ⟂ up
        const kN = 1 - gN, kF = 1 - gF;
        const rgx = nhx * kN + thx * kF, rgy = nhy * kN + thy * kF, rgz = nhz * kN + thz * kF;       // rigid share
        Tb.x += rcy * rgz - rcz * rgy; Tb.y += rcz * rgx - rcx * rgz; Tb.z += rcx * rgy - rcy * rgx;
        FlatS -= rgx * left.x + rgy * left.y + rgz * left.z; FlonS -= rgx * fwd.x + rgy * fwd.y + rgz * fwd.z;
      }
      const fLx = left.x * FlatS, fLy = left.y * FlatS, fLz = left.z * FlatS;
      const fAx = fwd.x * FlonS, fAy = fwd.y * FlonS, fAz = fwd.z * FlonS;
      Fb.x += Fhx + up.x * Fs; Fb.y += Fhy + up.y * Fs; Fb.z += Fhz + up.z * Fs;
      Tb.x += lpy * fLz - lpz * fLy + apy * fAz - apz * fAy + rm.y * up.z * Fs - rm.z * up.y * Fs;
      Tb.y += lpz * fLx - lpx * fLz + apz * fAx - apx * fAz + rm.z * up.x * Fs - rm.x * up.z * Fs;
      Tb.z += lpx * fLy - lpy * fLx + apx * fAy - apy * fAx + rm.x * up.y * Fs - rm.y * up.x * Fs;
      // Fix A, jacking: the lateral force at the ground reaches the body at the roll centre through the links, so the moment
      // Fy·hRC goes to the tyre loads directly: J = Fy·hRC/(t/2) lifts the body at the RC (centreline, axle z) and presses the wheel.
      // Only the share that still goes through the suspension geometry (FlatS) is jacked.
      let J = 0;
      if (!isFront) this.rearFlat += FlatS; // live axle: handled for the whole axle after the loop
      else if (P.jackingForces.v && FlatS !== 0) {
        J = (wh.left ? -1 : 1) * FlatS * hRC / ((isFront ? P.trackFront.v : P.trackRear.v) / 2);
        const lpl = lpx * left.x + lpy * left.y + lpz * left.z;
        const jx = lpx - left.x * lpl, jy = lpy - left.y * lpl, jz = lpz - left.z * lpl; // RC on the centreline
        Fb.x += up.x * J; Fb.y += up.y * J; Fb.z += up.z * J;
        Tb.x += (jy * up.z - jz * up.y) * J; Tb.y += (jz * up.x - jx * up.z) * J; Tb.z += (jx * up.y - jy * up.x) * J;
      }
      // Anti-dive / anti-squat: the longitudinal force reaches the body at the anti height, so its moment Fx·hA goes to
      // the tyre loads through the links: J = ∓Fx·hA/L on the wheel, reacted by the body at the other axle station
      // (side-view swing-arm slope tanθ = anti·h/L, the classic definition of % anti).
      if (P.jackingForces.v && FlonS !== 0) {
        const zO = isFront ? -this.b : this.a, Jl = -FlonS * (anti * this.hcg) / (wh.mount.z - zO);
        Fb.x += up.x * Jl; Fb.y += up.y * Jl; Fb.z += up.z * Jl;
        Tb.x -= left.x * zO * Jl; Tb.y -= left.y * zO * Jl; Tb.z -= left.z * zO * Jl;
        J += Jl;
      }
      // unsprung vertical: tyre up-force − suspension − jacking − gravity
      const prevVw = wh.vw;
      wh.vw += (Fup - Fs - J - mU * G * up.y) / mU * dt;
      wh.vw += (vMount.x * wxu.x + vMount.y * wxu.y + vMount.z * wxu.z) * dt;
      const sdotNew = -(wh.vw - vMountUp); this._sdot[i] = sdotNew;
      wh.s += sdotNew * dt;
      // impact events for audio (suspension closing fast)
      if (comp > 0.45 && this.t - wh.lastImpactT > 0.12) { this.impacts.push({ wheel: i as 0 | 1 | 2 | 3, velocity: comp, bumpStop: wh.bumpStop }); wh.lastImpactT = this.t; }
      else if (wh.bumpStop && bpen > 0.012 && this.t - wh.lastImpactT > 0.15) { this.impacts.push({ wheel: i as 0 | 1 | 2 | 3, velocity: Math.max(comp, 0.3), bumpStop: true }); wh.lastImpactT = this.t; }
      void prevVw;
    }

    // Fix A for the live rear axle: the axle's lateral force enters the body at the lateral-rod height, and its moment
    // F·hRC is carried inside the rigid axle as a tyre-load difference ±F·hRC/t (no vertical force on the body).
    if (P.jackingForces.v && this.rearFlat !== 0) {
      const Ja = this.rearFlat * P.rollCentreRear.v / P.trackRear.v, mUr = P.unsprungRear.v / 2;
      this.wheels[2].vw += Ja / mUr * dt; this.wheels[3].vw -= Ja / mUr * dt;
    }
    // ---- underbody contact ----
    this.bellyMinClear = 9;
    const rearAxleDrop = (this.wheels[2].s + this.wheels[3].s) / 2;
    for (let k = 0; k < this.bellyPoints.length; k++) {
      const bp = this.bellyPoints[k];
      const r = rotate(this.q, bp, this._d);
      const px = this.pos.x + r.x, py = this.pos.y + r.y, pz = this.pos.z + r.z;
      const h = gnd.heightAt(px, pz); const clr = py - h; if (h > gMax) gMax = h;
      if (clr < this.bellyMinClear) this.bellyMinClear = clr;
      if (clr < 0) {
        const vpx = this.vel.x + this.w.y * r.z - this.w.z * r.y, vpy = this.vel.y + this.w.z * r.x - this.w.x * r.z, vpz = this.vel.z + this.w.x * r.y - this.w.y * r.x;
        const Fn = 6e5 * -clr + (vpy < 0 ? -vpy * 2.5e4 : 0);
        const vh = Math.hypot(vpx, vpz) || 1; const mu = 0.45;
        const fx = -vpx / vh * mu * Fn * Math.min(1, vh * 5), fz = -vpz / vh * mu * Fn * Math.min(1, vh * 5);
        if (Fn > 4e4) this.damage.belly(Fn, vh, dt);
        Fb.x += fx; Fb.y += Fn; Fb.z += fz;
        Tb.x += r.y * fz - r.z * Fn; Tb.y += r.z * fx - r.x * fz; Tb.z += r.x * Fn - r.y * fx;
        this.bellyScrape = Math.max(this.bellyScrape, Math.min(1, (-clr * 30) * Math.min(1, vh / 3) + 0.2));
      }
    }
    // rear diff housing hangs on the live axle (unsprung): clearance = wheel-centre height − (R − GC)
    {
      const cL = this.wheels[2].centre, cR = this.wheels[3].centre;
      const dx = (cL.x + cR.x) / 2, dz = (cL.z + cR.z) / 2, dy = (cL.y + cR.y) / 2 - (this.R - P.groundClearance.v);
      const clr = dy - gnd.heightAt(dx, dz);
      if (clr < this.bellyMinClear) this.bellyMinClear = clr;
      // the housing hangs below the axle only while roughly upright
      if (clr < 0 && up.y > 0.5) { this.bellyScrape = Math.max(this.bellyScrape, Math.min(1, -clr * 40 + 0.2)); Fb.y += 3e5 * -clr; this.wheels[2].vw += 3e5 * -clr / P.unsprungRear.v * dt; this.wheels[3].vw += 3e5 * -clr / P.unsprungRear.v * dt; }
    }
    void rearAxleDrop;

    // ---- upper body hull (roof, pillars, sides, mirrors, tyre sidewalls) ----
    // While roughly upright, points more than 10 cm above the highest ground sampled this step are skipped unsampled.
    this.hull.tNow = this.t;
    const fb0 = this._fb0; fb0.x = Fb.x; fb0.y = Fb.y; fb0.z = Fb.z;
    this.hull.step(this, left, up, fwd, gnd, up.y > 0.5 ? gMax + 0.10 : Infinity, dt, Fb, Tb);
    // world colliders (trees, posts, walls, cones): nothing near → one counter increment
    this.collide.step(this, this.hull, left, up, fwd, this.t, dt, Fb, Tb);
    if (this.hull.contacts || this.collide.contacts) {
      const bf = this.lastBodyForce; bf.x = Fb.x - fb0.x; bf.y = Fb.y - fb0.y; bf.z = Fb.z - fb0.z;
      for (const hgt of this.hull.groundHits) { this.lastContactZone = hgt.zone; if (hgt.vn > 1.5 && this.bodyImpacts.length < 32) this.bodyImpacts.push({ energy: 0.25 * this.mTot * hgt.vn * hgt.vn, vn: hgt.vn, zone: hgt.zone, material: 'ground' }); }
      for (const ch of this.collide.hits) { this.lastContactZone = ch.zone; if (this.bodyImpacts.length < 32) this.bodyImpacts.push({ energy: ch.energy, vn: ch.vn, zone: ch.zone, material: ch.material }); }
    }
    if (this.hull.contacts || this.hull.wheelHit) {
      for (let i = 0; i < 4; i++) { const f = this.hull.wheelUp[i]; if (f !== 0) this.wheels[i].vw += f / (this.wheels[i].front ? P.unsprungFront.v : P.unsprungRear.v / 2) * dt; }
      if (this.hull.scrape > this.bellyScrape) this.bellyScrape = this.hull.scrape;
    }
    // Fix B: gravity on the unsprung masses perpendicular to body-up (their along-up part is in the wheel equations)
    { const gU = (this.mTot - this.mS) * G; Fb.x += gU * up.x * up.y; Fb.y -= gU * (1 - up.y * up.y); Fb.z += gU * up.z * up.y; }

    // ---- aero ----
    const sp = len(this.vel);
    if (sp > 0.1) {
      const Fa = 0.5 * 1.2 * P.cd.v * P.frontalArea.v * sp * sp;
      Fb.x -= this.vel.x / sp * Fa; Fb.y -= this.vel.y / sp * Fa; Fb.z -= this.vel.z / sp * Fa;
      const cpY = 0.95 - this.hcg; // centre of pressure ≈ 0.95 m above ground
      const r = rotate(this.q, set(this._e, -this.xcg, cpY, 0.2), this._e);
      // r × F with F = −v̂·Fa (the yaw component was missing: with the CG off the centreline the drag line then lost its
      // yaw moment while the drive force kept its own, and the car turned toward the CG side)
      Tb.x += r.y * (-this.vel.z / sp * Fa) - r.z * (-this.vel.y / sp * Fa);
      Tb.y += r.z * (-this.vel.x / sp * Fa) - r.x * (-this.vel.z / sp * Fa);
      Tb.z += r.x * (-this.vel.y / sp * Fa) - r.y * (-this.vel.x / sp * Fa);
    }

    // ---- integrate body ----
    // horizontal motion carries the unsprung masses too
    const aUp = dot(Fb, up) / this.mS;
    const kH = this.mS / this.mTot;
    const ax = (Fb.x / this.mS - up.x * aUp) * kH + up.x * aUp, ay = (Fb.y / this.mS - up.y * aUp) * kH + up.y * aUp, az = (Fb.z / this.mS - up.z * aUp) * kH + up.z * aUp;
    this.vel.x += ax * dt; this.vel.y += ay * dt; this.vel.z += az * dt;
    this.pos.x += this.vel.x * dt; this.pos.y += this.vel.y * dt; this.pos.z += this.vel.z * dt;
    // angular
    const I = this.I;
    if (dot(this.w, this.w) > this.lIntThreshold * this.lIntThreshold) this.integrateL(Tb, dt);
    else {
      // body-frame Euler equations, explicit (bit-identical to the original below the threshold)
      const wb = rotateInv(this.q, this.w, this._d), tb = rotateInv(this.q, Tb, this._e);
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
    }

    // ---- telemetry ----
    this.odometer += sp * dt;
    this.yawRate = dot(this.w, up);
    this.pitch = Math.asin(clamp(-fwd.y, -1, 1));
    this.roll = Math.asin(clamp(left.y, -1, 1));
    this.rollFull = Math.atan2(left.y, up.y); this.rollRateBody = dot(this.w, fwd);
    this.rollTotal += dot(this.w, fwd) * dt; this.pitchTotal += dot(this.w, left) * dt;
    const ra = Math.abs(this.rollTotal), pa = Math.abs(this.pitchTotal);
    if (ra > this.rollMaxAbs) this.rollMaxAbs = ra;
    if (pa > this.pitchMaxAbs) this.pitchMaxAbs = pa;
    const aw = set(this._f, (this.vel.x - this.prevVel.x) / dt, (this.vel.y - this.prevVel.y) / dt + G, (this.vel.z - this.prevVel.z) / dt);
    const alpha = 0.02; // low-pass for display
    this.accelBody.x += (dot(aw, left) - this.accelBody.x) * alpha;
    this.accelBody.y += (dot(aw, up) - this.accelBody.y) * alpha;
    this.accelBody.z += (dot(aw, fwd) - this.accelBody.z) * alpha;
    set(this.prevVel, this.vel.x, this.vel.y, this.vel.z);
    // driver-seat vertical acceleration (RHD: driver on the right = −X), for comfort metrics
    const seat = rotate(this.q, set(this._e, P.driverSeatX.v - this.xcg, 0.35, 0.25), this._e);
    const vSeat = this.vel.y + this.w.z * seat.x - this.w.x * seat.z;
    this.seatAz = (vSeat - this.prevSeatVz) / dt; this.prevSeatVz = vSeat;
    this.autoShift(dt, thr);
    void anyGround;
    // ---- damage (ΔV, rollover, faults, coolant) and the crash recorder ----
    const stop = this.damage.update(this, up, fwd, left, dt);
    if (stop && this.ignition) { this.ignition = false; this.stalled = true; this.engineRunning = false; this.engineStopReason = stop; }
    if (dmg.engineDead && this.ignition) { this.ignition = false; this.stalled = true; this.engineRunning = false; this.engineStopReason = 'dead'; }
    this.recorder.update(this, up, fwd, left, dt);
  }
  /** Body impacts since the last call (audio, camera). */
  takeBodyImpacts() { const b = this.bodyImpacts; this.bodyImpacts = []; return b; }

  /**
   * Angular step in the world frame: L = R·I·Rᵀ·ω; L += T·dt; rotate q by ω_mid = R·I⁻¹·Rᵀ·L (exact exponential map);
   * ω = R'·I⁻¹·R'ᵀ·L. Torque-free tumbling conserves L exactly (explicit Euler on Euler's equations grows it).
   */
  private integrateL(T: V3, dt: number) {
    const I = this.I, q = this.q;
    const wb = rotateInv(q, this.w, this._d);
    const L = rotate(q, set(this._g, I.x * wb.x, I.y * wb.y, I.z * wb.z), this._e);
    L.x += T.x * dt; L.y += T.y * dt; L.z += T.z * dt;
    // midpoint: ω at the half-step orientation drives the full step (second order; keeps E_rot to ~1e-5 over 10 s)
    const omegaAt = (qq: Quat, o: V3) => { const Lb = rotateInv(qq, L, this._d); return rotate(qq, set(this._g, Lb.x / I.x, Lb.y / I.y, Lb.z / I.z), o); };
    const qh = this._qh; qh.w = q.w; qh.x = q.x; qh.y = q.y; qh.z = q.z;
    rotQuat(qh, omegaAt(q, this._f), 0.5 * dt);
    rotQuat(q, omegaAt(qh, this._f), dt);
    const Lb2 = rotateInv(q, L, this._d);
    rotate(q, set(this._g, Lb2.x / I.x, Lb2.y / I.y, Lb2.z / I.z), this.w);
  }

  // ---------------- driver aids ----------------
  assistBrake = [0, 0, 0, 0];
  /** EBD rear brake-pressure factor (0.3–1). */
  ebd = 1;
  brakePressure = 0;
  private trcCut = 0;
  /** A-TRC engine torque cut (0–0.9) and its integral state. */
  trcEng = 0; private trcEngI = 0;
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
    // EBD (standard on the Fortuner with ABS): the rear line pressure is trimmed so the lightly loaded rear wheels do not
    // slip more than the fronts under braking; it recovers when the rear slip falls back.
    if (inp.brake > 0.05 && vF > 2) {
      const kf = (this.wheels[0].kappa + this.wheels[1].kappa) / 2, kr = (this.wheels[2].kappa + this.wheels[3].kappa) / 2;
      if (kr < kf - 0.015 && kr < -0.06) this.ebd = Math.max(0.3, this.ebd - 3 * dt); else this.ebd = Math.min(1, this.ebd + 1.5 * dt);
    } else this.ebd = Math.min(1, this.ebd + 3 * dt);
    // A-TRC / TRC [A]: holds driven-wheel slip near the tyre's peak (~10 %). A wheel spinning past the target is braked
    // (which also sends torque across the open diff) and, in 2H/4H, the engine torque is cut (TRC throttle closing).
    // Brakes alone cannot do it: at a full-throttle launch the converter (×2 at stall) and 1st gear put ~6 kN·m on each
    // rear wheel against ~2.3 kN·m of grip, so the old brake-only A-TRC (threshold 22 % slip, 2.2 kN·m) let the rears spin
    // up to 35 % slip on dry asphalt and 120 % on grass, and spinning tyres lost the side grip that keeps the car straight.
    // Wheel-speed sensors are direction-blind (magnitudes); reference = body speed (the free-rolling fronts in 2H).
    // VSC OFF switches A-TRC off too (Toyota: hold the VSC OFF button): burnouts and power slides stay possible.
    this.trcActive = false; this.trcCut = Math.max(0, this.trcCut - dt * 2);
    const vRef = Math.abs(vF);
    const slipOk = 0.10 * vRef + 0.05; // m/s of wheel-speed excess tolerated (10 % + sensor/creep allowance)
    let eSum = 0, nDr = 0;
    if (this.vscOn && !this.rearLocker && inp.throttle > 0.05) {
      for (let i = 0; i < 4; i++) {
        const wh = this.wheels[i]; const driven = !wh.front || this.driveMode !== '2H';
        if (!driven) continue;
        if (this.driveMode === '4L') { // crawl: brake-only A-TRC with the original law (22 % slip, 2.2 kN·m)
          const kap = (Math.abs(wh.omega) * this.R - vRef) / Math.max(1, vRef);
          if (kap > 0.22 && vRef < 60 / 3.6) { this.assistBrake[i] += clamp((kap - 0.22) * 6000, 0, 2200); this.trcActive = true; }
          continue;
        }
        const e = Math.abs(wh.omega) * this.R - vRef - slipOk;
        eSum += e > 0 ? e : 0; nDr++;
        if (e > 0 && vRef < 60 / 3.6) { this.assistBrake[i] += clamp(e * 2500, 0, 2500); this.trcActive = true; }
      }
    }
    // engine part (2H/4H; in 4L A-TRC stays brake-only so the crawl keeps its torque): PI on the mean excess slip
    const eMean = nDr ? eSum / nDr : 0;
    if (eMean > 0) {
      this.trcEngI = Math.min(0.85, this.trcEngI + 8 * eMean * dt);
      this.trcEng = Math.min(0.9, this.trcEngI + 1.0 * eMean); this.trcActive = true;
    } else {
      this.trcEngI = Math.max(0, this.trcEngI - 0.8 * dt); // torque comes back over ~1 s once the wheels grip
      this.trcEng = this.trcEngI;
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
    // VSC roll mitigation [A]: above 0.75 g lateral with the body rolling outward, brake the outer front wheel hard.
    // That saturates the outer front tyre, cuts lateral force (and yaw) and so the roll moment. Upright driving below
    // 0.75 g never reaches it.
    this.vscRollActive = false;
    if (this.vscOn && this.speed > 20 / 3.6 && this.driveMode !== '4L') {
      const ay = this.accelBody.x / G, sgn = ay > 0 ? 1 : -1;
      const rr = this.rollRateBody * sgn, rl = this.roll * sgn;
      if (ay * sgn > P.vscRollG.v && (rr > 0.1 || rl > 5 * Math.PI / 180)) {
        const outerFront = ay > 0 ? 1 : 0; // left turn (ay > 0): the right front is outside
        this.assistBrake[outerFront] += P.brakeTorqueFront.v * clamp((ay * sgn - P.vscRollG.v) / 0.08, 0.4, 1.2);
        this.trcCut = Math.min(0.8, this.trcCut + dt * 4); this.vscActive = true; this.vscRollActive = true;
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

  /** Why the engine will not start ('' = it will). */
  startBlock(): string { const d = this.damage; return d.engineDead ? 'Engine dead: it cranks but will not fire. Y repairs.' : d.overheated ? `Engine overheated (${d.coolantT.toFixed(0)} °C): let it cool below 115 °C` : ''; }
  startEngine() { if (this.damage.overheated) return; this.damage.fuelCut = false; if (!this.ignition && this.crankT <= 0) { this.crankT = 0.9; this.omegaE = Math.max(this.omegaE, 20); this.stalled = false; this.engineRunning = false; this.runUpT = 0; } }
  private rpmNow() { return this.omegaE * 60 / (2 * Math.PI); }
  stopEngine() { this.ignition = false; }

  audioSurface(): Surface[] { return this.wheels.map(w => (w.surface === 'grass' ? 'gravel' : w.surface) as Surface); }
}
