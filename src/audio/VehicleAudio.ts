// Toyota Fortuner 2.8 (1GD-FTV, 6AT, 4x4) vehicle audio.
// Synth layers run in an AudioWorklet (engine-worklet.js); optional recorded loops are
// crossfaded by SampleLayer. Signal graph:
//
//  worklet out0 core   -> gCore  -\
//  worklet out1 detail -> gDetail -+-> engineBus -+-> [ext: high-shelf]                 -> engExt -\
//  worklet out2 turbo  -> gTurbo  -+              \-> [int: LP -> boom -> low-shelf]     -> engInt -+
//  worklet out3 drive  -> gDrive  -+                                                               +-> mix -> master -> compressor -> limiter -> out
//  exterior loops      -> gSamp   -/                                                               |
//  interior loops      -> gSampInt ------------------------------------------------------------------+
//  worklet out4 road   -> gRoad -> roadBus -+-> roadExt ---------------------------------------------+
//                                           \-> [LP -> boom] -> roadInt ------------------------------/

import workletUrl from './engine-worklet.js?url';
import type { AudioState, Surface, VehicleAudioApi } from './types';
import { SampleLayer, parseManifest, type DecodedLoop } from './SampleLayer';
import { TUNING_SPEC, defaultTuning, workletTuning, type Tuning } from './tuning';

export type AudioMode = 'synth' | 'samples' | 'hybrid';

/** Must match PARAMS in engine-worklet.js */
const WORKLET_PARAMS = [
  'rpm', 'fuel', 'load', 'throttle', 'boost', 'starter', 'cold', 'tcSlip',
  'propRps', 'transRps', 'transGain', 'lowRange', 'frontDrive',
  'speed', 'wheelRps', 'slipLoose',
  'sAsphalt', 'sConcrete', 'sBroken', 'sGravel', 'sMud', 'sSand', 'sWet', 'sRumble',
  'squeal', 'squealPitch', 'scrape', 'abs', 'cabin',
] as const;
type WorkletParam = (typeof WORKLET_PARAMS)[number];

/** Toyota AC60F 6AT + 1GD Fortuner driveline. */
export const FORTUNER_DRIVELINE = {
  gearRatios: [3.6, 2.09, 1.488, 1.0, 0.687, 0.58] as const,
  reverseRatio: 3.732,
  finalDrive: 3.909,
  lowRange: 2.566,
  tyreRadius: 0.388, // m, 265/60 R18
};

const SURFACE_PARAM: Record<Surface, WorkletParam> = {
  asphalt: 'sAsphalt', concrete: 'sConcrete', broken: 'sBroken', gravel: 'sGravel',
  mud: 'sMud', sand: 'sSand', wet: 'sWet', rumble: 'sRumble',
};
const SURFACE_KEYS = Object.keys(SURFACE_PARAM) as Surface[];
/** How much a surface supports tyre squeal (paved only). */
const SQUEAL_GRIP: Record<Surface, number> = {
  asphalt: 1, concrete: 1, rumble: 0.8, broken: 0.6, wet: 0.25, gravel: 0, mud: 0, sand: 0,
};
const LOOSE: Record<Surface, number> = {
  asphalt: 0, concrete: 0, rumble: 0, broken: 0.2, wet: 0, gravel: 1, mud: 1, sand: 1,
};

type EngineState = 'off' | 'crank' | 'run' | 'stop';

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export class VehicleAudio implements VehicleAudioApi {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private params: Partial<Record<WorkletParam, AudioParam>> = {};
  private last: Float64Array = new Float64Array(WORKLET_PARAMS.length).fill(NaN);
  private paramIndex: Record<string, number> = {};
  private _started = false;
  private _mode: AudioMode = 'hybrid';
  private starting: Promise<void> | null = null;
  private tuning: Tuning = defaultTuning();

  // native graph
  private gCore!: GainNode; private gDetail!: GainNode; private gTurbo!: GainNode; private gDrive!: GainNode;
  private gRoad!: GainNode; private gSamp!: GainNode; private gSampInt!: GainNode;
  private engExtShelf!: BiquadFilterNode; private engIntLP!: BiquadFilterNode; private engIntBoom!: BiquadFilterNode; private engIntShelf!: BiquadFilterNode;
  private roadIntLP!: BiquadFilterNode; private roadIntBoom!: BiquadFilterNode;
  private engExt!: GainNode; private engInt!: GainNode; private roadExt!: GainNode; private roadInt!: GainNode;
  private master!: GainNode; private comp!: DynamicsCompressorNode; private limiter!: DynamicsCompressorNode;
  private _analyser: AnalyserNode | null = null;
  private engineBus!: GainNode;
  private fx: GainNode | null = null; // additive hook: bus for small cabin/vehicle sounds (horn, indicator tick)
  private lastGains: Float64Array = new Float64Array(12).fill(NaN);

  // samples
  private samples: SampleLayer | null = null;

  // ignition state machine
  private engState: EngineState = 'off';
  private engT = 0;
  private prevIgnition: boolean | null = null;
  private effRpm = 0;
  private stopFrom = 1;
  private catchEnv = 0;
  private cabinBlend = 0;
  private surfCounts = new Float64Array(SURFACE_KEYS.length);

  private volume = 0.8;
  private muted = false;

  get started(): boolean { return this._started; }
  get mode(): AudioMode { return this._mode; }
  /** AnalyserNode on the master output (for meters / spectrum displays). Null before start(). */
  get analyser(): AnalyserNode | null { return this._analyser; }
  get audioContext(): AudioContext | null { return this.ctx; }
  /** 'off' | 'crank' | 'run' | 'stop' — the audio engine's ignition state. */
  get engineState(): EngineState { return this.engState; }
  /** rpm actually being synthesised (includes cranking, start flare, run-down and TC flare). */
  get audibleRpm(): number { return this.effRpm; }
  get samplesLoaded(): boolean { return this.samples !== null; }
  /** Input for extra sounds (horn, indicator tick): goes through master volume / mute and the limiter. Null before start(). */
  get fxBus(): AudioNode | null { return this.fx; }

  constructor() {
    WORKLET_PARAMS.forEach((p, i) => { this.paramIndex[p] = i; });
  }

  async start(): Promise<void> {
    if (this._started) { await this.ctx?.resume(); return; }
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      await ctx.audioWorklet.addModule(workletUrl);
      this.node = new AudioWorkletNode(ctx, 'fortuner-engine', {
        numberOfInputs: 0,
        numberOfOutputs: 5,
        outputChannelCount: [1, 1, 1, 1, 1],
        processorOptions: { tuning: workletTuning(this.tuning) },
      });
      for (const p of WORKLET_PARAMS) {
        const ap = this.node.parameters.get(p);
        if (ap) this.params[p] = ap;
      }
      this.buildGraph(ctx, this.node);
      if (this.samples) this.samples.attach(ctx, this.gSamp, this.gSampInt);
      await ctx.resume();
      this._started = true;
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private buildGraph(ctx: AudioContext, node: AudioWorkletNode): void {
    const g = (v = 1): GainNode => { const n = ctx.createGain(); n.gain.value = v; return n; };
    const f = (type: BiquadFilterType, freq: number, q = 0.707, gain = 0): BiquadFilterNode => {
      const n = ctx.createBiquadFilter(); n.type = type; n.frequency.value = freq; n.Q.value = q; n.gain.value = gain; return n;
    };
    const T = this.tuning;
    this.gCore = g(T.coreGain); this.gDetail = g(T.detailGain); this.gTurbo = g(T.turboGain);
    this.gDrive = g(T.drivelineGain); this.gRoad = g(T.roadGain);
    this.gSamp = g(T.sampleGain); this.gSampInt = g(T.sampleGain);
    node.connect(this.gCore, 0); node.connect(this.gDetail, 1); node.connect(this.gTurbo, 2);
    node.connect(this.gDrive, 3); node.connect(this.gRoad, 4);

    this.engineBus = g(1);
    for (const n of [this.gCore, this.gDetail, this.gTurbo, this.gDrive, this.gSamp]) n.connect(this.engineBus);

    const mix = g(1);
    // engine: exterior (slightly brighter) / interior (firewall low-pass, boom, damped highs)
    this.engExtShelf = f('highshelf', 3000, 0.707, T.extBrightDb);
    this.engExt = g(1);
    this.engineBus.connect(this.engExtShelf).connect(this.engExt).connect(mix);
    this.engIntLP = f('lowpass', T.cabinLowpassHz, 0.6);
    this.engIntBoom = f('peaking', T.cabinBoomHz, 1.6, T.cabinBoomDb);
    this.engIntShelf = f('lowshelf', 120, 0.707, 3);
    this.engInt = g(0);
    this.engineBus.connect(this.engIntLP).connect(this.engIntBoom).connect(this.engIntShelf).connect(this.engInt).connect(mix);
    // pre-recorded interior loops: no cabin filter
    this.gSampInt.connect(mix);

    // road: exterior / interior (more low-pass; levels reduced in the worklet via `cabin`)
    const roadBus = g(1);
    this.gRoad.connect(roadBus);
    this.roadExt = g(1);
    roadBus.connect(this.roadExt).connect(mix);
    this.roadIntLP = f('lowpass', T.cabinRoadLowpassHz, 0.6);
    this.roadIntBoom = f('peaking', T.cabinBoomHz, 1.4, T.cabinBoomDb * 0.7);
    this.roadInt = g(0);
    roadBus.connect(this.roadIntLP).connect(this.roadIntBoom).connect(this.roadInt).connect(mix);

    // master: volume -> glue compressor -> brick-wall-ish limiter
    this.master = g(this.muted ? 0 : this.volume);
    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -18; this.comp.knee.value = 10; this.comp.ratio.value = 3.5;
    this.comp.attack.value = 0.005; this.comp.release.value = 0.2;
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001; this.limiter.release.value = 0.08;
    mix.connect(this.master).connect(this.comp).connect(this.limiter).connect(ctx.destination);
    this.fx = g(1); this.fx.connect(this.master);
    this._analyser = ctx.createAnalyser();
    this._analyser.fftSize = 4096;
    this._analyser.smoothingTimeConstant = 0.7;
    this.limiter.connect(this._analyser);
  }

  setMode(mode: AudioMode): void {
    this._mode = mode;
  }

  setMasterVolume(v: number): void {
    this.volume = clamp(v, 0, 2);
    this.applyMaster();
  }

  setMuted(m: boolean): void {
    this.muted = m;
    this.applyMaster();
  }

  private applyMaster(): void {
    if (!this.ctx || !this.master) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.05);
  }

  getTuning(): Tuning {
    return { ...this.tuning };
  }

  /** Change any TUNING_SPEC values live. Unknown keys are ignored. */
  setTuning(values: Partial<Tuning>): void {
    const wk: Tuning = {};
    let anyW = false;
    for (const s of TUNING_SPEC) {
      const v = values[s.key];
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      this.tuning[s.key] = v;
      if (s.target === 'worklet') { wk[s.key] = v; anyW = true; }
    }
    if (anyW && this.node) this.node.port.postMessage({ type: 'tuning', values: wk });
    this.applyNativeTuning();
  }

  private applyNativeTuning(): void {
    const ctx = this.ctx;
    if (!ctx || !this.engIntLP) return;
    const t = ctx.currentTime, T = this.tuning;
    this.engIntLP.frequency.setTargetAtTime(T.cabinLowpassHz, t, 0.05);
    this.roadIntLP.frequency.setTargetAtTime(T.cabinRoadLowpassHz, t, 0.05);
    this.engIntBoom.frequency.setTargetAtTime(T.cabinBoomHz, t, 0.05);
    this.engIntBoom.gain.setTargetAtTime(T.cabinBoomDb, t, 0.05);
    this.roadIntBoom.frequency.setTargetAtTime(T.cabinBoomHz, t, 0.05);
    this.roadIntBoom.gain.setTargetAtTime(T.cabinBoomDb * 0.7, t, 0.05);
    this.engExtShelf.gain.setTargetAtTime(T.extBrightDb, t, 0.05);
    this.lastGains.fill(NaN); // force gains to re-apply on next update
  }

  async loadSampleSet(manifestUrl: string): Promise<boolean> {
    try {
      const base = new URL(manifestUrl, typeof location !== 'undefined' ? location.href : 'http://localhost/');
      const res = await fetch(base.href, { cache: 'no-cache' });
      if (!res.ok) return false;
      const text = await res.text();
      let json: unknown;
      try { json = JSON.parse(text); } catch { return false; } // e.g. dev-server HTML fallback
      const entries = parseManifest(json);
      if (entries.length === 0) return false;
      // optional per-set tuning, e.g. { "loops": [...], "tuning": { "samplePitchClamp": 0.4 } }
      const setTuning = (json as { tuning?: unknown })?.tuning;
      if (setTuning && typeof setTuning === 'object' && !Array.isArray(setTuning)) this.setTuning(setTuning as Partial<Tuning>);
      // decode with the live context if we have one, otherwise an offline one (no autoplay issues)
      const decoder: BaseAudioContext = this.ctx ?? new OfflineAudioContext(1, 1, 48000);
      const decoded = await Promise.all(entries.map(async (e): Promise<DecodedLoop | null> => {
        try {
          const r = await fetch(new URL(e.file, base).href);
          if (!r.ok) return null;
          const buf = await r.arrayBuffer();
          const audio = await decoder.decodeAudioData(buf);
          return { ...e, buffer: audio };
        } catch {
          return null;
        }
      }));
      const loops = decoded.filter((d): d is DecodedLoop => d !== null);
      if (loops.length === 0) return false;
      const layer = new SampleLayer(loops);
      this.samples?.dispose();
      this.samples = layer;
      if (this.ctx && this.gSamp) layer.attach(this.ctx, this.gSamp, this.gSampInt);
      return true;
    } catch {
      return false;
    }
  }

  /** Drop any loaded recordings (engine falls back to the synth). */
  unloadSamples(): void {
    this.samples?.dispose();
    this.samples = null;
  }

  private setP(name: WorkletParam, v: number, tau: number, t: number): void {
    const i = this.paramIndex[name];
    const prev = this.last[i];
    if (Math.abs(v - prev) <= 1e-4 * (Math.abs(v) + 1e-2)) return; // NaN prev -> comparison false -> set
    this.last[i] = v;
    this.params[name]?.setTargetAtTime(v, t, tau);
  }

  private setG(slot: number, node: GainNode, v: number, tau: number, t: number): void {
    if (Math.abs(v - this.lastGains[slot]) <= 1e-4) return;
    this.lastGains[slot] = v;
    node.gain.setTargetAtTime(v, t, tau);
  }

  update(s: AudioState, dt: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.node || !this._started) return;
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1);
    const t = ctx.currentTime;
    const T = this.tuning;
    const port = this.node.port;

    // ---------------- ignition state machine (crank -> catch -> run -> run-down)
    const ign = !!s.ignition;
    if (this.prevIgnition === null) {
      this.engState = ign ? 'run' : 'off';
      this.engT = 10; // already running: no start transient
      this.effRpm = ign ? Math.max(s.rpm, T.idleRpm) : 0;
    } else if (ign && !this.prevIgnition) {
      if (this.engState === 'off' || this.engState === 'stop') {
        this.engState = 'crank'; this.engT = 0;
        port.postMessage({ type: 'starter-on' });
      }
    } else if (!ign && this.prevIgnition) {
      if (this.engState === 'crank') port.postMessage({ type: 'starter-off' });
      if (this.engState !== 'off') { this.engState = 'stop'; this.engT = 0; this.stopFrom = Math.max(1, this.effRpm); }
    }
    this.prevIgnition = ign;
    this.engT += dt;
    const simRpm = s.rpm > 300 ? s.rpm : T.idleRpm;
    let starter = 0, fuel = 0;
    switch (this.engState) {
      case 'crank':
        starter = 1;
        this.effRpm = 210 + 40 * Math.min(1, this.engT / 0.3);
        if (this.engT >= T.crankTime) {
          this.engState = 'run'; this.engT = 0; this.catchEnv = 1;
          port.postMessage({ type: 'starter-off' });
        }
        break;
      case 'run': {
        fuel = 1;
        const tt = this.engT;
        // first firings: rpm flares above idle then settles
        const flare = this.catchEnv * T.catchFlareRpm * (1 - Math.exp(-tt / 0.07)) * Math.exp(-tt / 0.55);
        this.catchEnv *= Math.exp(-dt / 1.2);
        this.effRpm = simRpm + flare;
        if (tt < 0.12) this.effRpm = 250 + (this.effRpm - 250) * (tt / 0.12); // ramp up out of cranking speed
        break;
      }
      case 'stop':
        this.effRpm -= Math.max(this.effRpm * 3.2, 500) * dt;
        if (this.effRpm <= 40) {
          this.effRpm = 0; this.engState = 'off';
          port.postMessage({ type: 'shudder' });
        }
        break;
      default:
        this.effRpm = 0;
    }
    const running = this.engState === 'run';
    const throttle = clamp(s.throttle, 0, 1);
    const tcSlip = clamp(s.tcSlip, 0, 1);
    const rpm = this.effRpm + (running ? T.tcFlareRpm * tcSlip * throttle : 0);
    const load = clamp(s.shifting ? s.load * 0.35 : s.load, -1, 1); // torque interruption during shifts

    this.setP('rpm', rpm, this.engState === 'crank' ? 0.05 : 0.02, t);
    this.setP('fuel', fuel, 0.03, t);
    this.setP('starter', starter, 0.02, t);
    this.setP('cold', this.catchEnv * 1.5, 0.05, t);
    this.setP('load', load, 0.04, t);
    this.setP('throttle', throttle, 0.03, t);
    this.setP('boost', running ? clamp(s.boost, 0, 1) : 0, 0.05, t);
    this.setP('tcSlip', running ? tcSlip : 0, 0.05, t);

    // ---------------- driveline
    const DL = FORTUNER_DRIVELINE;
    const wheelRps = Math.abs(s.wheelSpeed) / (2 * Math.PI * DL.tyreRadius);
    const propRps = wheelRps * DL.finalDrive;
    const low = s.driveMode === '4L';
    const tcase = low ? DL.lowRange : 1;
    const gear = Math.round(s.gear);
    const ratio = gear < 0 ? DL.reverseRatio : gear >= 1 && gear <= 6 ? DL.gearRatios[gear - 1] : 0;
    this.setP('propRps', propRps, 0.05, t);
    this.setP('transRps', propRps * tcase * ratio, 0.05, t);
    this.setP('transGain', gear === 0 ? 0 : gear === 4 ? 0.2 : 1, 0.1, t);
    this.setP('lowRange', low ? 1 : 0, 0.2, t);
    this.setP('frontDrive', s.driveMode === '2H' ? 0 : 1, 0.2, t);

    // ---------------- surfaces / tyres
    const speed = Math.abs(s.speed);
    this.setP('speed', speed, 0.05, t);
    this.setP('wheelRps', wheelRps, 0.05, t);
    let squeal = 0, slipPeak = 0, loose = 0, nW = 0;
    const counts = this.surfCounts;
    counts.fill(0);
    for (let w = 0; w < 4; w++) {
      const surf: Surface = (s.surface && s.surface[w]) || 'asphalt';
      const si = SURFACE_KEYS.indexOf(surf);
      if (si >= 0) { counts[si] += 1; nW++; }
      const slip = clamp((s.tyreSlip && s.tyreSlip[w]) || 0, 0, 1);
      const fz = Math.max(0, (s.tyreLoad && s.tyreLoad[w]) || 5500);
      const grip = SQUEAL_GRIP[surf] ?? 0;
      // squeal builds past the slip peak, eases a little in a full slide
      const sq = smoothstep(0.06, 0.2, slip) * (1 - 0.35 * smoothstep(0.5, 1, slip)) * Math.pow(fz / 5500, 0.7) * grip;
      squeal += sq;
      if (slip > slipPeak) slipPeak = slip;
      loose += slip * (LOOSE[surf] ?? 0);
    }
    for (let k = 0; k < SURFACE_KEYS.length; k++) {
      this.setP(SURFACE_PARAM[SURFACE_KEYS[k]], nW > 0 ? counts[k] / nW : k === 0 ? 1 : 0, 0.08, t);
    }
    this.setP('squeal', clamp(squeal / 2, 0, 2), 0.03, t);
    this.setP('squealPitch', 1150 - 320 * slipPeak + 120 * clamp(speed / 30, 0, 1), 0.05, t);
    this.setP('slipLoose', clamp(loose / 2, 0, 1), 0.05, t);
    this.setP('scrape', clamp(s.bellyScrape, 0, 1), 0.03, t);
    this.setP('abs', s.absActive ? 1 : 0, 0.02, t);

    // ---------------- discrete events
    if (s.impacts && s.impacts.length) {
      const nImp = Math.min(8, s.impacts.length);
      for (let k = 0; k < nImp; k++) {
        const im = s.impacts[k];
        if (!im || !(im.velocity > 0.05 || im.bumpStop)) continue;
        port.postMessage({ type: 'impact', w: im.wheel, v: im.velocity, b: !!im.bumpStop });
      }
    }

    if (s.bodyImpacts && s.bodyImpacts.length) {
      for (let k = 0; k < Math.min(6, s.bodyImpacts.length); k++) {
        const b = s.bodyImpacts[k]; if (!b || !(b.energy > 50)) continue;
        port.postMessage({ type: 'bodyImpact', e: b.energy, m: b.material, z: b.zone });
      }
    }

    // ---------------- cabin vs exterior
    const cabinT = s.camera === 'interior' ? 1 : 0;
    this.cabinBlend += (cabinT - this.cabinBlend) * (1 - Math.exp(-dt / 0.08));
    if (Math.abs(this.cabinBlend - cabinT) < 0.002) this.cabinBlend = cabinT;
    this.setP('cabin', cabinT, 0.08, t);
    const cabGain = dbToGain(T.cabinGainDb);
    this.setG(0, this.engExt, 1 - cabinT, 0.08, t);
    this.setG(1, this.engInt, cabinT * cabGain, 0.08, t);
    this.setG(2, this.roadExt, 1 - cabinT, 0.08, t);
    this.setG(3, this.roadInt, cabinT * cabGain * 0.9, 0.08, t);

    // ---------------- synth / samples / hybrid mixing
    const samplesActive = this.samples !== null && this._mode !== 'synth';
    let gate = 0;
    if (this.engState === 'run') gate = smoothstep(0.05, 0.35, this.engT);
    else if (this.engState === 'stop') gate = clamp(this.effRpm / this.stopFrom, 0, 1);
    const sg = samplesActive ? gate : 0;
    const coreKeep = this._mode === 'samples' ? 0 : T.hybridSynthCore;
    const detailKeep = this._mode === 'samples' ? 0 : T.hybridDetail;
    this.setG(4, this.gCore, T.coreGain * (1 - sg * (1 - coreKeep)), 0.1, t);
    this.setG(5, this.gDetail, T.detailGain * (1 - sg * (1 - detailKeep)), 0.1, t);
    this.setG(6, this.gTurbo, T.turboGain, 0.1, t);
    this.setG(7, this.gDrive, T.drivelineGain, 0.1, t);
    this.setG(8, this.gRoad, T.roadGain, 0.1, t);
    this.setG(9, this.gSamp, T.sampleGain, 0.1, t);
    this.setG(10, this.gSampInt, T.sampleGain, 0.1, t);
    if (this.samples) {
      this.samples.update(rpm, load, this.cabinBlend, samplesActive ? gate : 0,
        T.sampleOffLoad, T.sampleOnLoad, T.samplePitchClamp, t);
    }
  }

  /** Stop audio and release the context. */
  async dispose(): Promise<void> {
    this.samples?.dispose();
    this.samples = null;
    this.node?.disconnect();
    this.node = null;
    const ctx = this.ctx;
    this.ctx = null;
    this._started = false;
    if (ctx) await ctx.close();
  }
}
