/* eslint-disable */
// Toyota Fortuner 2.8 (1GD-FTV) procedural audio — AudioWorklet processor.
// Plain JS, self-contained (no imports). Loaded via `import url from './engine-worklet.js?url'`.
//
// Outputs (all mono):
//   0 core      combustion pulses -> exhaust (pipe resonances + muffler + body modes), intake, block radiation, structure-borne orders
//   1 detail    diesel clatter (pilot + main injection knock through block resonances), injector ticks, valvetrain
//   2 turbo     VNT whistle, compressor whoosh, lift-off hiss
//   3 driveline gear/diff/transfer whine, torque-converter churn, starter motor
//   4 road      tyre rolling per surface, squeal, wind, suspension impacts, underbody scrape, ABS
//
// Continuous inputs come in as k-rate AudioParams (the main thread smooths them with setTargetAtTime);
// discrete events (impacts, starter clicks) and tuning arrive via port messages.
// The per-sample loop allocates nothing.

const TAU = Math.PI * 2;

function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z1 = 0; this.z2 = 0; }
  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  _set(b0, b1, b2, a0, a1, a2) {
    const i = 1 / a0;
    this.b0 = b0 * i; this.b1 = b1 * i; this.b2 = b2 * i; this.a1 = a1 * i; this.a2 = a2 * i;
    return this;
  }
  lp(f, q) {
    const w = TAU * clamp(f, 10, sampleRate * 0.45) / sampleRate, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
  }
  hp(f, q) {
    const w = TAU * clamp(f, 10, sampleRate * 0.45) / sampleRate, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
  }
  /** Band-pass, 0 dB peak gain. */
  bp(f, q) {
    const w = TAU * clamp(f, 10, sampleRate * 0.45) / sampleRate, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set(al, 0, -al, 1 + al, -2 * c, 1 - al);
  }
  peak(f, q, db) {
    const A = Math.pow(10, db / 40);
    const w = TAU * clamp(f, 10, sampleRate * 0.45) / sampleRate, c = Math.cos(w), al = Math.sin(w) / (2 * q);
    return this._set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
  }
}

// name, default, min, max  (keep in sync with WORKLET_PARAMS in VehicleAudio.ts)
const PARAMS = [
  ['rpm', 0, 0, 9000],
  ['fuel', 0, 0, 1],        // 1 = combustion enabled (running), 0 = motoring/cranking/off
  ['load', 0, -1, 1],
  ['throttle', 0, 0, 1],
  ['boost', 0, 0, 1],
  ['starter', 0, 0, 1],
  ['cold', 0, 0, 4],        // extra clatter right after start
  ['tcSlip', 0, 0, 1],
  ['propRps', 0, 0, 400],   // propeller-shaft rev/s (diff pinion)
  ['transRps', 0, 0, 800],  // transmission input-shaft rev/s
  ['transGain', 0, 0, 1],   // 0 in N, ~0.2 in direct 4th, 1 otherwise
  ['lowRange', 0, 0, 1],    // 4L engaged
  ['frontDrive', 0, 0, 1],  // front axle driven (4H/4L)
  ['speed', 0, 0, 120],     // m/s
  ['wheelRps', 0, 0, 200],
  ['slipLoose', 0, 0, 1],   // wheelspin on loose surfaces
  ['sAsphalt', 1, 0, 1], ['sConcrete', 0, 0, 1], ['sBroken', 0, 0, 1], ['sGravel', 0, 0, 1],
  ['sMud', 0, 0, 1], ['sSand', 0, 0, 1], ['sWet', 0, 0, 1], ['sRumble', 0, 0, 1],
  ['squeal', 0, 0, 2],
  ['squealPitch', 950, 100, 4000],
  ['scrape', 0, 0, 1],
  ['abs', 0, 0, 1],
  ['cabin', 0, 0, 1],
];

const DEFAULT_T = {
  exhaustLevel: 1, exhaustPipeMs: 3.4, exhaustPipeFb: 0.42, tailpipeMs: 7.6, tailpipeFb: 0.4,
  mufflerHz: 360, bodyRes1Hz: 88, bodyRes2Hz: 168, bodyRes3Hz: 305, bodyResDb: 5,
  blockLevel: 0.55, structLevel: 0.5, growl: 0.6, flowNoise: 0.35,
  intakeLevel: 0.6, intakeResHz: 145,
  imbalance: 1, jitter: 1, burble: 0.5,
  pilotGapMs: 0.8, pilotLevel: 0.5,
  clatterHz: 1150, clatterDecayMs: 1.1, clatterLoadFactor: 0.45, valveTick: 0.25,
  whistleMinHz: 2300, whistleMaxHz: 7400, whistleLevel: 0.5, hissLevel: 0.6,
  whineLevel: 0.5, pinionTeeth: 10, transTeeth: 31, tcaseTeeth: 24, tcChurnLevel: 0.5, starterLevel: 0.8,
  tyreLevel: 1, squealLevel: 1, windLevel: 1, gustDepth: 0.3, impactLevel: 1, scrapeLevel: 1, absLevel: 0.6,
  jointSpacing: 4.5, wheelbase: 2.745, grainRate: 1, rumbleSpacing: 0.3,
};

const NV = 10; // impact voice pool
const EXK = 0.55; // exhaust pre-saturation gain
const BLK = 0.9; // block radiation gain

class FortunerEngineProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return PARAMS.map((p) => ({ name: p[0], defaultValue: p[1], minValue: p[2], maxValue: p[3], automationRate: 'k-rate' }));
  }

  constructor(options) {
    super();
    const T = {};
    for (const k in DEFAULT_T) T[k] = DEFAULT_T[k];
    const init = options && options.processorOptions && options.processorOptions.tuning;
    if (init) for (const k in init) if (k in T && typeof init[k] === 'number') T[k] = init[k];
    this.T = T;
    this.dirty = true;
    this.seed = 0x12345678;
    this.scratch = new Float32Array(128);

    // ---- engine state
    this.p = 0;              // nominal firing-slot phase 0..1
    this.cyl = 0;            // slot counter (firing order index 0..3)
    this.pilotCd = 0; this.mainCd = 0; this.intakeCd = 0;
    this.evAmp = 0; this.evCyl = 0;
    this.ps1 = 0; this.ps2 = 0;   // pressure pulse (difference of exponentials)
    this.is1 = 0; this.is2 = 0;   // intake pulse
    this.ce = 0; this.te = 0; this.ve = 0; // clatter / injector tick / valvetrain exciters
    this.vtPh = 0;
    this.dcX = 0; this.dcY = 0;
    this.d1 = new Float32Array(8192); this.d2 = new Float32Array(8192); this.di = 0;
    this.lp1 = 0; this.lp2 = 0;
    this.kd = 0.99; this.kr = 0.9; this.kid = 0.99; this.kir = 0.98;
    this.combAmp = 0; this.motorAmp = 0; this.clatAmt = 0; this.intakeAmp = 0; this.over = 0;
    this.slotSamples = 1000;
    // per-cylinder character (fixed "this engine" imbalance)
    this.cylAmpDev = new Float64Array([0.0, -0.075, 0.06, -0.03]);
    this.cylOff = new Float64Array([0.022, 0.036, 0.012, 0.03]);
    this.cylW = new Float64Array([ // clatter resonator weights per cylinder
      1.0, 0.8, 0.6, 0.45,
      0.85, 1.0, 0.5, 0.55,
      1.0, 0.65, 0.75, 0.35,
      0.9, 0.9, 0.55, 0.5,
    ]);

    this.exDC = new Biquad(); this.muf1 = new Biquad(); this.muf2 = new Biquad();
    this.body1 = new Biquad(); this.body2 = new Biquad(); this.body3 = new Biquad();
    this.flowBP = new Biquad(); this.blockHP = new Biquad(); this.blockBP = new Biquad();
    this.intHelm = new Biquad(); this.intRoar = new Biquad(); this.coreHP = new Biquad();
    this.cr1 = new Biquad(); this.cr2 = new Biquad(); this.cr3 = new Biquad(); this.cr4 = new Biquad();
    this.tickHP = new Biquad(); this.detailHP = new Biquad();

    // ---- turbo
    this.wPh = 0; this.wf = 2300; this.thrHold = 0; this.hissEnv = 0;
    this.tAiry = new Biquad(); this.tBroad = new Biquad(); this.tHiss = new Biquad(); this.tHissHP = new Biquad();

    // ---- driveline
    this.diffPh = 0; this.fdiffPh = 0; this.transPh = 0; this.tcasePh = 0; this.stPh1 = 0; this.stPh2 = 0;
    this.whAm = 1; this.whAmT = 1; this.whAmTimer = 0;
    this.tcBP = new Biquad(); this.stBP = new Biquad(); this.drvHP = new Biquad();

    // ---- road
    this.aspLow = new Biquad(); this.aspMid = new Biquad(); this.concBP = new Biquad(); this.brokenLP = new Biquad();
    this.sandBP = new Biquad(); this.wetHP = new Biquad(); this.wetBP = new Biquad();
    this.grainA = new Biquad(); this.grainB = new Biquad(); this.gEnvA = 0; this.gEnvB = 0;
    this.ping1 = new Biquad(); this.ping2 = new Biquad(); this.pingE1 = 0; this.pingE2 = 0; this.pingSel = 0;
    this.mudBP = new Biquad(); this.mudLow = new Biquad(); this.mud1 = 0; this.mud2 = 0; this.mudF = 300; this.mudFT = 300;
    this.rbLP = new Biquad(); this.rbPh = 0; this.trPh = 0;
    this.jPh = 0; this.jRearCd = 0; this.jRearAmp = 0;
    this.sq1 = new Biquad(); this.sq2 = new Biquad(); this.sqPh = 0; this.sqJit = 0; this.sqAm = 1; this.sqAmT = 1; this.sqTimer = 0;
    this.windLP = new Biquad(); this.windBP = new Biquad(); this.gust = 1; this.gustT = 1; this.gustTimer = 0;
    this.scrA = new Biquad(); this.scrB = new Biquad(); this.scrLow = new Biquad(); this.scrG = 0; this.scrGT = 0; this.scrTimer = 0;
    this.absBP = new Biquad(); this.absPh = 0; this.absMPh = 0; this.absClick = 0; this.absGatePrev = 0;
    this.impLP = new Biquad(); this.impBP = new Biquad(); this.roadHP = new Biquad();

    // impact voices (struct-of-arrays)
    this.vAct = new Uint8Array(NV);
    this.vPh1 = new Float64Array(NV); this.vF1 = new Float64Array(NV); this.vA1 = new Float64Array(NV); this.vK1 = new Float64Array(NV); this.vG1 = new Float64Array(NV);
    this.vPh2 = new Float64Array(NV); this.vF2 = new Float64Array(NV); this.vA2 = new Float64Array(NV); this.vK2 = new Float64Array(NV);
    this.vNa = new Float64Array(NV); this.vNb = new Float64Array(NV); this.vKn = new Float64Array(NV);

    // smoothed (per-block ramped) values
    this.sRpm = 0; this.sStarter = 0; this.sStruct = 0; this.sRoar = 0; this.sTurbo = 0; this.sBroadT = 0;
    this.sWhine = 0; this.sTc = 0; this.sRoll = 0; this.sWind = 0; this.sSqueal = 0; this.sScrape = 0; this.sAbs = 0;
    this.sExh = 0; this.sBlk = 0;

    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  rand() { // xorshift32 -> [0,1)
    let x = this.seed;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.seed = x >>> 0;
    return this.seed / 4294967296;
  }
  bi() { return this.rand() * 2 - 1; }

  onMessage(d) {
    if (!d) return;
    switch (d.type) {
      case 'tuning':
        for (const k in d.values) if (k in this.T && typeof d.values[k] === 'number') this.T[k] = d.values[k];
        this.dirty = true;
        break;
      case 'impact': {
        const vf = Math.min(2.2, Math.pow(clamp(d.v, 0, 5) / 1.5, 1.2));
        const lvl = this.T.impactLevel;
        if (d.b) { // bump stop: harder, higher, metallic clunk
          this.voice(105 * (0.92 + 0.16 * this.rand()), (0.55 * vf + 0.3) * lvl, 0.05, 0.6,
            (950 + 350 * this.rand()), (0.22 * vf + 0.1) * lvl, 0.028, (0.5 * vf + 0.2) * lvl, (0.45 * vf + 0.15) * lvl, 0.008);
        } else {
          const front = d.w < 2;
          this.voice((front ? 62 : 54) * (0.9 + 0.2 * this.rand()), 0.55 * vf * lvl, 0.085, 0.72,
            130 + 45 * this.rand(), 0.2 * vf * lvl, 0.045, 0.45 * vf * lvl, 0.04 * vf * lvl, 0.012);
        }
        break;
      }
      case 'bodyImpact': { // body crash: low structural thud + sheet-metal crunch, coloured by what was hit
        const e = Math.max(0, d.e || 0), lvl = this.T.impactLevel;
        const a = Math.min(1.6, 0.25 + 0.42 * Math.log10(1 + e / 400)); // 0.4 kJ (bump) … 300 kJ (pole at 50 km/h)
        const m = d.m || 'ground';
        const ring = m === 'steel' ? 1 : m === 'concrete' || m === 'masonry' ? 0.55 : m === 'wood' ? 0.35 : m === 'ground' ? 0.3 : 0.2;
        this.voice(42 * (0.9 + 0.2 * this.rand()), 0.9 * a * lvl, 0.16, 0.6,
          (m === 'steel' ? 720 : 380) * (0.85 + 0.3 * this.rand()), 0.35 * a * ring * lvl, 0.06 + 0.12 * ring, 0.9 * a * lvl, 0.55 * a * lvl, 0.05 + 0.04 * a);
        if (a > 0.6) this.voice(1900 + 900 * this.rand(), 0.18 * a * lvl, 0.03, 0.7, 3200 + 900 * this.rand(), 0.12 * a * lvl, 0.05, 0.4 * a * lvl, 0.7 * a * lvl, 0.09); // glass / plastic shards
        break;
      }
      case 'starter-on':
        this.voice(170, 0.25, 0.03, 0.9, 2300 + 300 * this.rand(), 0.12, 0.02, 0.15, 0.25, 0.006);
        break;
      case 'starter-off':
        this.voice(210, 0.12, 0.02, 0.9, 2800, 0.08, 0.015, 0.05, 0.18, 0.005);
        break;
      case 'shudder':
        this.voice(36, 0.5, 0.2, 0.8, 85, 0.25, 0.09, 0.3, 0.02, 0.03);
        break;
    }
  }

  /** Start an impact voice. glideTo = fraction of f1 reached after ~tau1. */
  voice(f1, a1, tau1, glideTo, f2, a2, tau2, na, nb, tauN) {
    let best = 0, bestA = 1e9;
    for (let v = 0; v < NV; v++) {
      if (!this.vAct[v]) { best = v; bestA = -1; break; }
      const a = this.vA1[v] + this.vA2[v];
      if (a < bestA) { bestA = a; best = v; }
    }
    const sr = sampleRate;
    this.vAct[best] = 1;
    this.vPh1[best] = 0; this.vF1[best] = f1; this.vA1[best] = a1; this.vK1[best] = Math.exp(-1 / (tau1 * sr));
    this.vG1[best] = Math.exp(Math.log(glideTo) / (tau1 * sr));
    this.vPh2[best] = 0; this.vF2[best] = f2; this.vA2[best] = a2; this.vK2[best] = Math.exp(-1 / (tau2 * sr));
    this.vNa[best] = na; this.vNb[best] = nb; this.vKn[best] = Math.exp(-1 / (tauN * sr));
  }

  updateStatic() {
    const T = this.T;
    this.exDC.hp(22, 0.7);
    this.body1.peak(T.bodyRes1Hz, 1.4, T.bodyResDb);
    this.body2.peak(T.bodyRes2Hz, 2.0, T.bodyResDb * 0.7);
    this.body3.peak(T.bodyRes3Hz, 2.8, T.bodyResDb * 0.5);
    this.flowBP.bp(650, 0.7);
    this.blockHP.hp(220, 0.7); this.blockBP.bp(620, 0.9);
    this.intHelm.bp(T.intakeResHz, 3.5);
    this.coreHP.hp(18, 0.7);
    const c = T.clatterHz;
    this.cr1.bp(c, 9); this.cr2.bp(c * 2.04, 12); this.cr3.bp(c * 3.13, 14); this.cr4.bp(c * 4.62, 10);
    this.tickHP.hp(5500, 0.7); this.detailHP.hp(300, 0.7);
    this.tBroad.bp(4200, 0.8); this.tHiss.bp(3300, 1.1); this.tHissHP.hp(1800, 0.7);
    this.tcBP.bp(420, 1.2); this.stBP.bp(1900, 1.0); this.drvHP.hp(40, 0.7);
    this.aspLow.lp(170, 0.7); this.aspMid.bp(850, 0.8); this.concBP.bp(1300, 0.7); this.brokenLP.lp(240, 1.1);
    this.sandBP.bp(1800, 0.5); this.wetHP.hp(3000, 0.7); this.wetBP.bp(6000, 0.8);
    this.grainA.bp(2200, 1.4); this.grainB.bp(4600, 1.2);
    this.mudLow.lp(140, 0.8); this.rbLP.lp(380, 1.3);
    this.windLP.lp(480, 0.6);
    this.scrA.bp(1100, 1.2); this.scrB.bp(2600, 6); this.scrLow.bp(165, 4);
    this.absBP.bp(260, 1.6);
    this.impLP.lp(380, 0.8); this.impBP.bp(1700, 1.0); this.roadHP.hp(25, 0.7);
    this.dirty = false;
  }

  onSlot(rpmN) {
    const T = this.T;
    this.cyl = (this.cyl + 1) & 3;
    const c = this.cyl;
    const jScale = T.jitter * (1.3 - rpmN);
    let off = this.cylOff[c] * T.imbalance + 0.012 * jScale * this.bi();
    if (off < 0.002) off = 0.002;
    const delay = Math.max(1, Math.round(off * this.slotSamples));
    let amp = this.combAmp * (1 + T.imbalance * this.cylAmpDev[c]) * (1 + 0.07 * jScale * this.bi());
    if (this.over > 0) {
      // fuel cut on overrun: irregular weak events ("burble")
      amp *= 1 + T.burble * this.over * this.bi();
      if (this.rand() < 0.1 * T.burble * this.over) amp += 0.35 * this.over;
    }
    if (amp < this.motorAmp) amp = this.motorAmp;
    this.evAmp = amp;
    this.evCyl = c;
    if (this.combAmp > 0.02 && T.pilotLevel > 0) {
      this.pilotCd = delay;
      this.mainCd = delay + Math.max(1, Math.round(T.pilotGapMs * 0.001 * sampleRate));
    } else {
      this.pilotCd = 0;
      this.mainCd = delay;
    }
    this.intakeCd = delay + Math.round(0.45 * this.slotSamples);
  }

  process(inputs, outputs, P) {
    const o0 = (outputs[0] && outputs[0][0]) || this.scratch;
    const n = o0.length;
    const o1 = (outputs[1] && outputs[1][0]) || this.scratch;
    const o2 = (outputs[2] && outputs[2][0]) || this.scratch;
    const o3 = (outputs[3] && outputs[3][0]) || this.scratch;
    const o4 = (outputs[4] && outputs[4][0]) || this.scratch;
    if (this.dirty) this.updateStatic();
    const T = this.T;
    const sr = sampleRate, invSr = 1 / sr;

    // ---------- block-rate parameter reads
    const rpmT = P.rpm[0], fuel = P.fuel[0], load = P.load[0], thr = P.throttle[0], boost = P.boost[0];
    const starterT = P.starter[0], cold = P.cold[0], tcSlip = P.tcSlip[0];
    const propRps = P.propRps[0], transRps = P.transRps[0], transGain = P.transGain[0], lowRange = P.lowRange[0], frontDrive = P.frontDrive[0];
    const speed = P.speed[0], wheelRps = P.wheelRps[0], slipLoose = P.slipLoose[0];
    const wA = P.sAsphalt[0], wC = P.sConcrete[0], wB = P.sBroken[0], wG = P.sGravel[0], wM = P.sMud[0], wS = P.sSand[0], wW = P.sWet[0], wR = P.sRumble[0];
    const squealT = P.squeal[0], sqPitch = P.squealPitch[0], scrapeT = P.scrape[0], absT = P.abs[0], cabin = P.cabin[0];

    const turning = rpmT > 25 ? 1 : 0;
    const rpmN = clamp((rpmT - 700) / 3700, 0, 1);
    const loadPos = load > 0 ? load : 0;
    const over = clamp((-load - 0.03) / 0.17, 0, 1) * (rpmT > 950 ? 1 : 0);
    this.over = over;
    const fuelEff = fuel * (1 - 0.92 * over);
    this.combAmp = fuelEff * (0.32 + 0.68 * Math.pow(loadPos, 0.8)) * turning;
    this.motorAmp = (0.12 + 0.25 * rpmN) * turning;
    this.clatAmt = (fuelEff * (1 - 0.55 * rpmN) * (1 - T.clatterLoadFactor * loadPos) * (1 + cold) + 0.12 * fuel * over) * turning;
    this.intakeAmp = (0.25 + 0.75 * Math.max(thr, boost)) * turning;

    const fireHzT = rpmT / 30;
    const slotSec = fireHzT > 1 ? 1 / fireHzT : 1;
    this.slotSamples = slotSec * sr;
    const combFrac = this.combAmp / (this.combAmp + this.motorAmp + 1e-9);
    const tauR = 0.0012 + (0.00018 - 0.0012) * combFrac;           // diesel: sharp rise when firing
    let tauD = clamp(slotSec * (0.2 + 0.18 * loadPos) * (1 - 0.4 * over), 0.0007, 0.012);
    if (tauD < 2.5 * tauR) tauD = 2.5 * tauR;
    // normalise the difference-of-exponentials pulse to unit peak
    const tPk = Math.log(tauD / tauR) * tauD * tauR / (tauD - tauR);
    const pulseNorm = 1 / (Math.exp(-tPk / tauD) - Math.exp(-tPk / tauR));
    this.kr = Math.exp(-1 / (tauR * sr));
    this.kd = Math.exp(-1 / (tauD * sr));
    this.kir = Math.exp(-1 / (0.0016 * sr));
    this.kid = Math.exp(-1 / (clamp(slotSec * 0.4, 0.002, 0.02) * sr));
    const kClat = Math.exp(-1 / (T.clatterDecayMs * 0.001 * sr));
    const kTick = Math.exp(-1 / (0.00012 * sr));
    const kVt = Math.exp(-1 / (0.0003 * sr));

    // muffler opens up a little with flow
    const mufF = T.mufflerHz * (0.75 + 0.55 * loadPos + 0.45 * rpmN);
    this.muf1.lp(mufF, 0.75); this.muf2.lp(mufF * 1.6, 0.6);
    this.intRoar.bp(600 + 1500 * boost + 400 * rpmN, 0.7);
    const growlDrive = 1 + 3 * T.growl * loadPos * (0.4 + 0.6 * thr);
    const growlNorm = 1 / Math.pow(growlDrive, 0.3);

    // targets for ramped levels
    // loudness rises with rpm and load; overrun is thinner
    const exhT = T.exhaustLevel * turning * (0.4 + 0.75 * rpmN) * (0.55 + 0.75 * loadPos) * (1 + 0.35 * over) + T.exhaustLevel * 1.2 * starterT;
    const blkT = T.blockLevel * turning * (0.6 + 0.6 * rpmN + 1.5 * starterT);
    const structT = T.structLevel * (0.25 + 0.75 * loadPos) * (0.3 + 0.7 * fuel) * turning;
    const roarT = T.intakeLevel * (0.08 + 0.92 * clamp(rpmT / 4400, 0, 1.2) * (0.25 + 0.75 * Math.max(thr, boost))) * turning;

    // turbo
    const wfT = T.whistleMinHz + (T.whistleMaxHz - T.whistleMinHz) * Math.pow(boost, 0.85) + 300 * rpmN;
    const turboT = T.whistleLevel * Math.pow(boost, 1.6) * (0.35 + 0.65 * thr);
    const broadT = T.whistleLevel * boost * (0.2 + 0.8 * thr) * clamp(rpmT / 2500, 0, 1.5);
    this.tAiry.bp(wfT, 28);
    if (thr > this.thrHold) this.thrHold = thr;
    else {
      this.thrHold += (thr - this.thrHold) * (1 - Math.exp(-n / (0.3 * sr)));
      const drop = this.thrHold - thr;
      if (drop > 0.3 && boost > 0.15) {
        const h = boost * Math.min(1, drop * 1.3);
        if (h > this.hissEnv) this.hissEnv = h;
        this.thrHold = thr;
      }
    }
    const kHiss = Math.exp(-1 / (0.38 * sr));

    // driveline
    const whineT = T.whineLevel * clamp(speed / 6, 0, 1) * (0.3 + 0.7 * Math.abs(load)) * (propRps > 0.5 ? 1 : 0);
    const tcT = T.tcChurnLevel * tcSlip * clamp(rpmT / 3000, 0, 1.3) * (0.3 + 0.7 * thr) * turning;
    this.whAmTimer -= n;
    if (this.whAmTimer <= 0) { this.whAmT = 0.8 + 0.4 * this.rand(); this.whAmTimer = (0.15 + 0.4 * this.rand()) * sr; }
    this.whAm += (this.whAmT - this.whAm) * 0.05;

    // road
    const vn = speed / 25;
    const rollT = T.tyreLevel * Math.min(1.8, Math.pow(vn, 1.4)) * (1 - 0.45 * cabin);
    const windT = T.windLevel * Math.min(3, (speed / 30) * (speed / 30)) * (1 - 0.65 * cabin);
    this.windBP.bp(650 + 32 * speed, 0.7);
    this.gustTimer -= n;
    if (this.gustTimer <= 0) { this.gustT = 1 + T.gustDepth * this.bi(); this.gustTimer = (0.4 + 1.6 * this.rand()) * sr; }
    this.gust += (this.gustT - this.gust) * (1 - Math.exp(-n / (0.7 * sr)));
    const squealT2 = T.squealLevel * Math.min(1.5, squealT) * (1 - 0.45 * cabin);
    this.sqJit = this.sqJit * 0.96 + 0.12 * this.bi();
    const sqF = sqPitch * (1 + 0.025 * this.sqJit);
    this.sq1.bp(sqF, 32); this.sq2.bp(sqF * 1.52, 22);
    const scrapeT2 = T.scrapeLevel * scrapeT * (0.35 + 0.65 * clamp(speed / 4, 0, 1));
    const absT2 = T.absLevel * absT * (1 + 0.5 * cabin);
    const impCab = 1 + 0.25 * cabin;
    const grainRate = T.grainRate * (speed * (85 * wG + 150 * wS) + slipLoose * 1400 * (wG + wS + 0.4 * wM));
    const grainP = Math.min(0.5, grainRate * invSr);
    const gWsum = wG + wS + 1e-6;
    const grainAmpBase = (wG * 1.0 + wS * 0.32) / gWsum;
    const kGrain = Math.exp(-1 / ((0.0007 * wG + 0.0016 * wS) / gWsum * sr));
    const kPing = Math.exp(-1 / (0.0003 * sr));
    const pingP = (speed * 0.45 * wG + slipLoose * 4 * wG) * invSr;
    const mudP = (wheelRps * 2.2 + slipLoose * 18) * wM * invSr;
    const kMudR = Math.exp(-1 / (0.012 * sr)), kMudD = Math.exp(-1 / (0.07 * sr));
    this.mudF += (this.mudFT - this.mudF) * 0.08;
    if (wM > 0.001) this.mudBP.bp(this.mudF, 3);
    const potP = speed * 0.7 * wB * invSr;
    const jointOn = wC > 0.05 && speed > 1;
    const rolling = speed > 0.15 || slipLoose > 0.02;

    // ---------- ramps
    const r = 1 / n;
    let rpm = this.sRpm; const dRpm = (rpmT - rpm) * r;
    let st = this.sStarter; const dSt = (starterT - st) * r;
    let exh = this.sExh; const dExh = (exhT - exh) * r;
    let blkL = this.sBlk; const dBlk = (blkT - blkL) * r;
    let stru = this.sStruct; const dStru = (structT - stru) * r;
    let roar = this.sRoar; const dRoar = (roarT - roar) * r;
    let tur = this.sTurbo; const dTur = (turboT - tur) * r;
    let brT = this.sBroadT; const dBrT = (broadT - brT) * r;
    let wh = this.sWhine; const dWh = (whineT - wh) * r;
    let tc = this.sTc; const dTc = (tcT - tc) * r;
    let roll = this.sRoll; const dRoll = (rollT - roll) * r;
    let wind = this.sWind; const dWind = (windT - wind) * r;
    let sq = this.sSqueal; const dSq = (squealT2 - sq) * r;
    let scr = this.sScrape; const dScr = (scrapeT2 - scr) * r;
    let ab = this.sAbs; const dAb = (absT2 - ab) * r;
    const wfStep = (wfT - this.wf) * r;

    const D1 = clamp(Math.round(T.exhaustPipeMs * 0.001 * sr), 2, 8000);
    const D2 = clamp(Math.round(T.tailpipeMs * 0.001 * sr), 2, 8000);
    const fb1 = T.exhaustPipeFb, fb2 = T.tailpipeFb;
    const clatK = 2.2;
    const cw = this.cylW;

    for (let i = 0; i < n; i++) {
      rpm += dRpm; st += dSt; exh += dExh; blkL += dBlk; stru += dStru; roar += dRoar; tur += dTur; brT += dBrT;
      wh += dWh; tc += dTc; roll += dRoll; wind += dWind; sq += dSq; scr += dScr; ab += dAb;
      this.wf += wfStep;
      const n1 = this.bi(), n2 = this.bi(), n3 = this.bi();

      // ================= ENGINE =================
      const sinP = Math.sin(TAU * this.p);
      const rpmInst = rpm * (1 + 0.35 * st * sinP); // cranking: compression slows the crank before TDC
      this.p += rpmInst * (1 / 30) * invSr;
      if (this.p >= 1) { this.p -= 1; this.onSlot(rpmN); }

      if (this.pilotCd > 0 && --this.pilotCd === 0) {
        const a = this.evAmp * T.pilotLevel;
        this.ps1 += 0.12 * a; this.ps2 += 0.12 * a;
        this.ce += 0.55 * this.clatAmt * T.pilotLevel;
        this.te += 0.4 * this.clatAmt;
      }
      if (this.mainCd > 0 && --this.mainCd === 0) {
        const a = this.evAmp;
        this.ps1 += a; this.ps2 += a;
        this.ce += this.clatAmt;
        this.te += 0.6 * this.clatAmt;
      }
      if (this.intakeCd > 0 && --this.intakeCd === 0) {
        this.is1 += this.intakeAmp; this.is2 += this.intakeAmp;
      }
      const pulse = (this.ps1 - this.ps2) * pulseNorm;
      this.ps1 *= this.kd; this.ps2 *= this.kr;
      const ipulse = this.is1 - this.is2;
      this.is1 *= this.kid; this.is2 *= this.kir;

      // exhaust: pulse + gas-flow turbulence -> DC block -> quarter-wave tailpipe (inverting) -> header comb -> muffler -> body modes
      let x = pulse + T.flowNoise * this.flowBP.run(n1) * (pulse * 0.8 + 0.04 * roar);
      x = this.exDC.run(x + 1e-18);
      const di = this.di;
      const r2 = this.d2[(di - D2) & 8191];
      this.lp2 += (r2 - this.lp2) * 0.35;
      const y2 = x - fb2 * this.lp2;
      this.d2[di] = y2;
      const r1 = this.d1[(di - D1) & 8191];
      this.lp1 += (r1 - this.lp1) * 0.5;
      const y1 = y2 + fb1 * this.lp1;
      this.d1[di] = y1;
      this.di = (di + 1) & 8191;
      let ex = this.muf2.run(this.muf1.run(y1));
      ex = this.body3.run(this.body2.run(this.body1.run(ex)));
      // load-dependent growl: soft saturation
      const g = ex * EXK * exh * growlDrive;
      ex = (g / (1 + Math.abs(g))) * growlNorm;

      // combustion noise radiated by the block (the "diesel" mid band)
      const blk = this.blockBP.run(this.blockHP.run(pulse)) * blkL * BLK;
      // structure-borne orders: firing order + half/first order from cylinder imbalance (idle lope)
      const cyc = (this.cyl + this.p) * 0.25;
      const strc = stru * (0.5 * sinP + 0.18 * Math.sin(2 * TAU * this.p) + 0.12 * T.imbalance * Math.sin(TAU * cyc) + 0.08 * T.imbalance * Math.sin(2 * TAU * cyc));
      // intake: Helmholtz airbox + roar
      const intake = this.intHelm.run(ipulse) * 1.6 * T.intakeLevel + this.intRoar.run(n2) * roar * 0.22;

      o0[i] = this.coreHP.run(ex + blk + strc * 0.35 + intake);

      // ----- clatter (detail)
      this.vtPh += rpm * (1 / 7.5) * invSr;
      if (this.vtPh >= 1) { this.vtPh -= 1; if (turning) this.ve += T.valveTick * (0.3 + 0.7 * this.rand()) * 0.25; }
      const cylBase = this.evCyl * 4;
      const exc = n3 * this.ce;
      const vex = n2 * this.ve;
      const cl = this.cr1.run(exc * cw[cylBase]) + 0.8 * this.cr2.run(exc * cw[cylBase + 1]) +
        0.6 * this.cr3.run(exc * cw[cylBase + 2] + vex) + 0.45 * this.cr4.run(exc * cw[cylBase + 3] + vex);
      const tick = this.tickHP.run(n1 * this.te);
      this.ce *= kClat; this.te *= kTick; this.ve *= kVt;
      o1[i] = this.detailHP.run(cl * clatK + tick * 0.5 + 1e-18);

      // ================= TURBO =================
      this.wPh += this.wf * invSr; if (this.wPh >= 1) this.wPh -= 1;
      const whistle = Math.sin(TAU * this.wPh) * 0.08 + this.tAiry.run(n2) * 1.4;
      const broad = this.tBroad.run(n3) * 0.12 * brT;
      const hiss = this.tHiss.run(this.tHissHP.run(n1)) * this.hissEnv * T.hissLevel * 0.5;
      this.hissEnv *= kHiss;
      o2[i] = whistle * tur + broad + hiss;

      // ================= DRIVELINE =================
      let dl = 0;
      if (wh > 1e-5) {
        this.diffPh += propRps * T.pinionTeeth * invSr; if (this.diffPh >= 1) this.diffPh -= Math.floor(this.diffPh);
        this.fdiffPh += propRps * T.pinionTeeth * 1.013 * invSr; if (this.fdiffPh >= 1) this.fdiffPh -= Math.floor(this.fdiffPh);
        this.transPh += transRps * T.transTeeth * invSr; if (this.transPh >= 1) this.transPh -= Math.floor(this.transPh);
        this.tcasePh += propRps * 2.566 * T.tcaseTeeth * invSr; if (this.tcasePh >= 1) this.tcasePh -= Math.floor(this.tcasePh);
        const sd = Math.sin(TAU * this.diffPh);
        let w = sd + 0.3 * sd * sd * sd;
        w += 0.6 * frontDrive * Math.sin(TAU * this.fdiffPh);
        w += 0.55 * transGain * Math.sin(TAU * this.transPh);
        w += 2.2 * lowRange * (Math.sin(TAU * this.tcasePh) + 0.35 * Math.sin(2 * TAU * this.tcasePh));
        dl += w * wh * this.whAm * 0.05;
      }
      if (tc > 1e-5) dl += this.tcBP.run(n1) * tc * 0.25;
      if (st > 1e-4) {
        // starter: motor ~12x crank speed, 9-tooth pinion mesh + commutator whine + brush noise
        const motorRps = rpmInst * (1 / 60) * 12;
        this.stPh1 += motorRps * 9 * invSr; if (this.stPh1 >= 1) this.stPh1 -= Math.floor(this.stPh1);
        this.stPh2 += motorRps * 24 * invSr; if (this.stPh2 >= 1) this.stPh2 -= Math.floor(this.stPh2);
        const s1 = Math.sin(TAU * this.stPh1);
        const sm = 0.55 * s1 + 0.25 * s1 * s1 * s1 + 0.3 * Math.sin(TAU * this.stPh2) + 0.25 * this.stBP.run(n3);
        dl += sm * st * T.starterLevel * 0.14 * (1 - 0.3 * sinP);
      }
      o3[i] = this.drvHP.run(dl + 1e-18);

      // ================= ROAD / CHASSIS =================
      let rd = 0;
      if (rolling) {
        const low = this.aspLow.run(n1);
        const mid = this.aspMid.run(n2);
        let tyre = (wA + wW + wR) * (mid * 0.9 + low * 1.1) + wC * low * 1.0 + wS * low * 0.6 + wG * low * 0.9 + wM * low * 0.6;
        if (wA > 0.001) {
          this.trPh += wheelRps * 62 * (1 + 0.04 * n3) * invSr; if (this.trPh >= 1) this.trPh -= Math.floor(this.trPh);
          tyre += wA * 0.05 * Math.sin(TAU * this.trPh);
        }
        if (wC > 0.001) tyre += wC * this.concBP.run(n3) * 1.0;
        if (wB > 0.001) {
          tyre += wB * (this.brokenLP.run(n3) * 1.8 + mid * 0.6);
          if (this.rand() < potP) {
            const a = (0.08 + 0.25 * this.rand()) * Math.min(1.5, vn) * T.impactLevel * impCab;
            this.voice(50 + 20 * this.rand(), a, 0.07, 0.75, 120 + 50 * this.rand(), a * 0.4, 0.04, a * 0.8, a * 0.1, 0.01);
          }
        }
        if (wS > 0.001) tyre += wS * this.sandBP.run(n3) * 0.5;
        if (wW > 0.001) tyre += wW * (this.wetHP.run(n3) * 0.35 * Math.min(1.6, vn) + this.wetBP.run(n1) * 0.25);
        if (wG + wS > 0.001) {
          if (this.rand() < grainP) {
            const a = grainAmpBase * (0.25 + 0.75 * this.rand());
            if (this.rand() < 0.55) { if (a > this.gEnvA) this.gEnvA = a; } else if (a > this.gEnvB) this.gEnvB = a;
          }
          tyre += (this.grainA.run(n2 * this.gEnvA) * 3.2 + this.grainB.run(n3 * this.gEnvB) * 2.6);
          this.gEnvA *= kGrain; this.gEnvB *= kGrain;
          if (wG > 0.001 && this.rand() < pingP) { // stone hitting the underbody / arch
            const f = 2500 + 4000 * this.rand();
            if (this.pingSel) { this.ping1.bp(f, 30); this.pingE1 += 0.5 + this.rand(); } else { this.ping2.bp(f, 30); this.pingE2 += 0.5 + this.rand(); }
            this.pingSel ^= 1;
          }
          if (this.pingE1 > 1e-5 || this.pingE2 > 1e-5) {
            tyre += (this.ping1.run(n1 * this.pingE1) + this.ping2.run(n2 * this.pingE2)) * 6;
            this.pingE1 *= kPing; this.pingE2 *= kPing;
          }
        }
        if (wM > 0.001) {
          if (this.rand() < mudP) {
            const a = 0.5 + 0.5 * this.rand();
            this.mud1 += a; this.mud2 += a;
            this.mudFT = 170 + 380 * this.rand();
            if (this.rand() < 0.15) { // splat against the arch
              const s = 0.12 * Math.min(1.5, vn + slipLoose) * T.impactLevel;
              this.voice(70, s * 0.3, 0.04, 0.8, 160, s * 0.2, 0.03, s, s * 0.15, 0.03);
            }
          }
          const menv = this.mud2 - this.mud1;
          this.mud1 *= kMudR; this.mud2 *= kMudD;
          tyre += wM * (this.mudBP.run(n3) * menv * 10 + this.mudLow.run(n2) * 0.6);
        }
        if (wR > 0.001) {
          this.rbPh += speed / T.rumbleSpacing * invSr;
          if (this.rbPh >= 1) this.rbPh -= Math.floor(this.rbPh);
          tyre += wR * this.rbLP.run(this.rbPh < 0.3 ? 1.6 : -0.7) * 0.35;
        }
        if (jointOn) {
          this.jPh += speed / T.jointSpacing * invSr;
          if (this.jPh >= 1) {
            this.jPh -= 1;
            const a = 0.09 * wC * Math.min(1.4, vn + 0.2) * T.impactLevel * impCab;
            this.voice(68, a, 0.05, 0.8, 150, a * 0.5, 0.03, a * 0.7, a * 0.1, 0.006);
            this.jRearCd = Math.max(1, Math.round(T.wheelbase / speed * sr));
            this.jRearAmp = a * 0.9;
          }
        }
        if (this.jRearCd > 0 && --this.jRearCd === 0) {
          const a = this.jRearAmp;
          this.voice(60, a, 0.05, 0.8, 140, a * 0.5, 0.03, a * 0.7, a * 0.1, 0.006);
        }
        rd += tyre * roll * 0.45;
      }
      // squeal: narrow resonances + tone with stick-slip flutter
      if (sq > 1e-4) {
        this.sqTimer -= 1;
        if (this.sqTimer <= 0) { this.sqAmT = 0.55 + 0.45 * this.rand(); this.sqTimer = (0.008 + 0.025 * this.rand()) * sr; }
        this.sqAm += (this.sqAmT - this.sqAm) * 0.004;
        this.sqPh += sqF * invSr; if (this.sqPh >= 1) this.sqPh -= 1;
        const tone = Math.sin(TAU * this.sqPh);
        rd += sq * this.sqAm * (tone * 0.06 + this.sq1.run(n1) * 0.9 + this.sq2.run(n2) * 0.45) * 3;
      }
      // wind ∝ v², gusty
      if (wind > 1e-5) rd += (this.windLP.run(n3) * 0.9 + this.windBP.run(n1) * 0.35) * wind * this.gust * 0.7;
      // underbody scrape: granular grinding + chassis groan
      if (scr > 1e-4) {
        this.scrTimer -= 1;
        if (this.scrTimer <= 0) { this.scrGT = this.rand() < 0.15 ? 0.05 : 0.3 + 0.7 * this.rand(); this.scrTimer = (0.004 + 0.022 * this.rand()) * sr; }
        this.scrG += (this.scrGT - this.scrG) * 0.01;
        rd += scr * (this.scrG * (this.scrA.run(n1) * 0.7 + this.scrB.run(n2) * 0.5) + this.scrLow.run(n3) * 0.8) * 1.2;
      }
      // ABS: modulator pump buzz gated at ~14 Hz + valve clicks + pedal thumps
      if (ab > 1e-4) {
        this.absPh += 14 * invSr; if (this.absPh >= 1) this.absPh -= 1;
        this.absMPh += 78 * invSr; if (this.absMPh >= 1) this.absMPh -= 1;
        const gate = this.absPh < 0.45 ? 1 : 0;
        if (gate && !this.absGatePrev) {
          this.absClick = 1;
          this.voice(48, 0.05 * ab, 0.03, 0.9, 210, 0.02 * ab, 0.015, 0.03 * ab, 0.02 * ab, 0.004);
        }
        this.absGatePrev = gate;
        const saw = 2 * this.absMPh - 1;
        rd += ab * (this.absBP.run(saw) * (0.5 + 0.5 * gate) * 0.35 + n2 * this.absClick * 0.25);
        this.absClick *= 0.993;
      }
      // impact voices
      let imp = 0, nLow = 0, nHi = 0;
      for (let v = 0; v < NV; v++) {
        if (!this.vAct[v]) continue;
        let ph = this.vPh1[v] + this.vF1[v] * invSr; if (ph >= 1) ph -= 1; this.vPh1[v] = ph;
        let ph2 = this.vPh2[v] + this.vF2[v] * invSr; if (ph2 >= 1) ph2 -= 1; this.vPh2[v] = ph2;
        imp += this.vA1[v] * Math.sin(TAU * ph) + this.vA2[v] * Math.sin(TAU * ph2);
        nLow += this.vNa[v]; nHi += this.vNb[v];
        this.vF1[v] *= this.vG1[v];
        this.vA1[v] *= this.vK1[v]; this.vA2[v] *= this.vK2[v];
        this.vNa[v] *= this.vKn[v]; this.vNb[v] *= this.vKn[v];
        if (this.vA1[v] < 1e-5 && this.vA2[v] < 1e-5 && this.vNa[v] < 1e-5 && this.vNb[v] < 1e-5) this.vAct[v] = 0;
      }
      rd += (imp + this.impLP.run(n1 * nLow) * 1.5 + this.impBP.run(n2 * nHi)) * impCab * 0.4;
      o4[i] = this.roadHP.run(rd + 1e-18);
    }

    this.sRpm = rpmT; this.sStarter = starterT; this.sExh = exhT; this.sBlk = blkT; this.sStruct = structT; this.sRoar = roarT;
    this.sTurbo = turboT; this.sBroadT = broadT; this.sWhine = whineT; this.sTc = tcT; this.sRoll = rollT;
    this.sWind = windT; this.sSqueal = squealT2; this.sScrape = scrapeT2; this.sAbs = absT2;
    this.wf = wfT;
    return true;
  }
}

registerProcessor('fortuner-engine', FortunerEngineProcessor);
