// Recorded steady-rpm engine loops with a 4-way crossfade
// (2 nearest rpm loops x on/off load, equal-power), pitch = rpm / recordedRpm (clamped).
// Manifest format: see public/audio/engine/README.md.

export type LoopLoad = 'on' | 'off';
export type LoopPosition = 'exterior' | 'interior';

export interface SampleManifestEntry {
  file: string;
  rpm: number;
  load: LoopLoad;
  position: LoopPosition;
  /** optional linear gain trim for this loop (default 1) */
  gain?: number;
  /** optional loop points in seconds (default: whole file) */
  loopStart?: number;
  loopEnd?: number;
}

export interface DecodedLoop extends SampleManifestEntry {
  buffer: AudioBuffer;
}

interface LiveLoop {
  e: DecodedLoop;
  src: AudioBufferSourceNode;
  g: GainNode;
  cur: number;   // last gain target sent
  rate: number;  // last playbackRate target sent
}

const HALF_PI = Math.PI / 2;

function clamp(x: number, a: number, b: number): number {
  return x < a ? a : x > b ? b : x;
}

/** Parse a manifest JSON value (array, or { loops: [...] }) into validated entries. */
export function parseManifest(json: unknown): SampleManifestEntry[] {
  const arr: unknown = Array.isArray(json) ? json : (json && typeof json === 'object' ? (json as { loops?: unknown }).loops : null);
  if (!Array.isArray(arr)) return [];
  const out: SampleManifestEntry[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.file !== 'string' || typeof r.rpm !== 'number' || !(r.rpm > 0)) continue;
    const load: LoopLoad = r.load === 'off' ? 'off' : 'on';
    const position: LoopPosition = r.position === 'interior' ? 'interior' : 'exterior';
    out.push({
      file: r.file,
      rpm: r.rpm,
      load,
      position,
      gain: typeof r.gain === 'number' ? r.gain : 1,
      loopStart: typeof r.loopStart === 'number' ? r.loopStart : undefined,
      loopEnd: typeof r.loopEnd === 'number' ? r.loopEnd : undefined,
    });
  }
  return out;
}

export class SampleLayer {
  private live: LiveLoop[] = [];
  /** indices into `live`, grouped and sorted by rpm: [position][load] */
  private groups: Record<LoopPosition, Record<LoopLoad, number[]>> = {
    exterior: { on: [], off: [] },
    interior: { on: [], off: [] },
  };
  private tgt: Float32Array = new Float32Array(0);
  readonly hasInterior: boolean;
  readonly hasExterior: boolean;
  attached = false;

  constructor(readonly loops: DecodedLoop[]) {
    this.hasInterior = loops.some((l) => l.position === 'interior');
    this.hasExterior = loops.some((l) => l.position === 'exterior');
  }

  /** Create looping sources. Exterior loops go to extOut (through the cabin filter), interior loops to intOut. */
  attach(ctx: AudioContext, extOut: AudioNode, intOut: AudioNode): void {
    if (this.attached) return;
    const t0 = ctx.currentTime + 0.05;
    this.loops.forEach((e) => {
      const src = ctx.createBufferSource();
      src.buffer = e.buffer;
      src.loop = true;
      const ls = clamp(e.loopStart ?? 0, 0, e.buffer.duration);
      const le = clamp(e.loopEnd ?? e.buffer.duration, ls, e.buffer.duration);
      if (le - ls > 0.05) { src.loopStart = ls; src.loopEnd = le; }
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g);
      g.connect(e.position === 'interior' ? intOut : extOut);
      // random start offset so loops sharing a source recording do not phase
      src.start(t0, ls + Math.random() * Math.max(0.01, le - ls));
      this.live.push({ e, src, g, cur: 0, rate: 1 });
    });
    this.live.forEach((l, i) => this.groups[l.e.position][l.e.load].push(i));
    for (const pos of ['exterior', 'interior'] as const) {
      for (const ld of ['on', 'off'] as const) this.groups[pos][ld].sort((a, b) => this.live[a].e.rpm - this.live[b].e.rpm);
    }
    this.tgt = new Float32Array(this.live.length);
    this.attached = true;
  }

  /**
   * @param cabin 0 = exterior camera, 1 = interior (smoothed by caller)
   * @param gate  overall sample level (0 when engine not running)
   */
  update(rpm: number, load: number, cabin: number, gate: number, offLoad: number, onLoad: number, pitchClamp: number, t: number): void {
    if (!this.attached) return;
    const tgt = this.tgt;
    tgt.fill(0);
    if (gate > 0.0005) {
      let wExt: number, wInt: number;
      if (this.hasInterior && this.hasExterior) { wExt = Math.cos(cabin * HALF_PI); wInt = Math.sin(cabin * HALF_PI); }
      else if (this.hasInterior) { wExt = 0; wInt = 1; }
      else { wExt = 1; wInt = 0; }
      const u = clamp((load - offLoad) / Math.max(0.01, onLoad - offLoad), 0, 1);
      if (wExt > 0.001) this.accumulate('exterior', rpm, u, wExt * gate);
      if (wInt > 0.001) this.accumulate('interior', rpm, u, wInt * gate);
    }
    const lo = 1 - pitchClamp, hi = 1 + pitchClamp;
    for (let i = 0; i < this.live.length; i++) {
      const l = this.live[i];
      const g = tgt[i];
      if (Math.abs(g - l.cur) > 0.001 || (g === 0 && l.cur !== 0)) {
        l.g.gain.setTargetAtTime(g, t, 0.05);
        l.cur = g;
      }
      if (g > 0) {
        const rate = clamp(rpm / l.e.rpm, lo, hi);
        if (Math.abs(rate - l.rate) > 0.0005) {
          l.src.playbackRate.setTargetAtTime(rate, t, 0.03);
          l.rate = rate;
        }
      }
    }
  }

  private accumulate(pos: LoopPosition, rpm: number, u: number, w: number): void {
    const on = this.groups[pos].on, off = this.groups[pos].off;
    let wOn: number, wOff: number;
    if (on.length === 0) { wOn = 0; wOff = 1; }
    else if (off.length === 0) { wOn = 1; wOff = 0; }
    else { wOn = Math.sin(u * HALF_PI); wOff = Math.cos(u * HALF_PI); }
    if (wOn > 0.001) this.accumulateRpm(on, rpm, w * wOn);
    if (wOff > 0.001) this.accumulateRpm(off, rpm, w * wOff);
  }

  private accumulateRpm(list: number[], rpm: number, w: number): void {
    const n = list.length;
    if (n === 0) return;
    const live = this.live;
    if (rpm <= live[list[0]].e.rpm || n === 1) { this.tgt[list[0]] += w * (live[list[0]].e.gain ?? 1); return; }
    if (rpm >= live[list[n - 1]].e.rpm) { this.tgt[list[n - 1]] += w * (live[list[n - 1]].e.gain ?? 1); return; }
    for (let k = 0; k < n - 1; k++) {
      const a = live[list[k]].e, b = live[list[k + 1]].e;
      if (rpm >= a.rpm && rpm < b.rpm) {
        const x = (rpm - a.rpm) / Math.max(1, b.rpm - a.rpm);
        this.tgt[list[k]] += w * Math.cos(x * HALF_PI) * (a.gain ?? 1);
        this.tgt[list[k + 1]] += w * Math.sin(x * HALF_PI) * (b.gain ?? 1);
        return;
      }
    }
  }

  dispose(): void {
    for (const l of this.live) {
      try { l.src.stop(); } catch { /* already stopped */ }
      l.src.disconnect();
      l.g.disconnect();
    }
    this.live = [];
    this.attached = false;
  }
}
