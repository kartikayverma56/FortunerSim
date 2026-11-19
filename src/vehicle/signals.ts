// Indicators, hazards, horn and the lamp logic that drives CarVisual.setLamps, plus the two small synth voices
// (twin-tone horn, indicator relay tick) that play through VehicleAudio's fx bus (so they follow mute and volume).
import type { Vehicle } from '../physics/vehicle';

const BLINK_HZ = 1.5; // 90 flashes per minute (regulation range 60–120)

export class Signals {
  turn: -1 | 0 | 1 = 0;  // +1 left, −1 right
  hazard = false;
  horn = false;
  blinkOn = false;       // lamp phase this frame
  private phase = 0; private armed = false;
  private sfx: SignalSounds | null = null;

  toggleTurn(dir: 1 | -1) { this.turn = this.turn === dir ? 0 : dir; this.armed = false; if (this.turn || this.hazard) this.phase = 0; }
  toggleHazard() { this.hazard = !this.hazard; this.phase = 0; }
  get left() { return this.blinkOn && (this.hazard || this.turn === 1); }
  get right() { return this.blinkOn && (this.hazard || this.turn === -1); }

  /** Call once per frame. `ctx`/`bus` come from VehicleAudio once it has started. */
  update(dt: number, veh: Vehicle, audio: { ctx: AudioContext | null; bus: AudioNode | null; interior: boolean }) {
    // self-cancel: once the wheel has been turned past ~90° in the signalled direction and comes back near centre
    if (this.turn && !this.hazard) {
      const sw = veh.steerWheelAngle * this.turn;
      if (sw > 1.6) this.armed = true;
      else if (this.armed && sw < 0.35) { this.turn = 0; this.armed = false; }
    }
    const active = this.hazard || this.turn !== 0;
    const was = this.blinkOn;
    if (active) { this.phase = (this.phase + dt * BLINK_HZ) % 1; this.blinkOn = this.phase < 0.5; } else { this.phase = 0; this.blinkOn = false; }
    if (audio.ctx && audio.bus) {
      if (!this.sfx) this.sfx = new SignalSounds(audio.ctx, audio.bus);
      this.sfx.setCabin(audio.interior);
      if (this.blinkOn !== was) this.sfx.tick(this.blinkOn);
      this.sfx.setHorn(this.horn);
    }
  }
}

/** Twin-tone disc horn (≈ 415 / 500 Hz, the usual low/high pair) and a relay tick, all native Web Audio nodes. */
class SignalSounds {
  private horn: GainNode; private out: GainNode; private lp: BiquadFilterNode; private hornOn = false; private cabin = false;
  private tickBuf: AudioBuffer;
  constructor(private ctx: AudioContext, bus: AudioNode) {
    this.out = ctx.createGain(); this.out.gain.value = 1;
    this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 9000; this.lp.Q.value = 0.5;
    this.lp.connect(this.out).connect(bus);
    // horn: two sawtooth diaphragms → soft clip → resonant horn flare (peaks around 1.1 and 2.6 kHz)
    this.horn = ctx.createGain(); this.horn.gain.value = 0;
    const shaper = ctx.createWaveShaper(); const n = 1024, curve = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(2.2 * x) / Math.tanh(2.2); }
    shaper.curve = curve;
    const pre = ctx.createGain(); pre.gain.value = 0.55;
    for (const [f, g] of [[415, 0.5], [502, 0.45]] as const) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      const vib = ctx.createOscillator(); vib.frequency.value = 5.5; const vg = ctx.createGain(); vg.gain.value = 1.2; vib.connect(vg).connect(o.frequency); // slight diaphragm wobble
      const og = ctx.createGain(); og.gain.value = g; o.connect(og).connect(pre); o.start(); vib.start();
    }
    const p1 = ctx.createBiquadFilter(); p1.type = 'peaking'; p1.frequency.value = 1100; p1.Q.value = 1.2; p1.gain.value = 7;
    const p2 = ctx.createBiquadFilter(); p2.type = 'peaking'; p2.frequency.value = 2600; p2.Q.value = 1.5; p2.gain.value = 5;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 280;
    pre.connect(shaper).connect(hp).connect(p1).connect(p2).connect(this.horn).connect(this.lp);
    // relay tick: 30 ms of decaying click (two damped resonances + a noise transient)
    const sr = ctx.sampleRate, len = Math.round(sr * 0.03); this.tickBuf = ctx.createBuffer(1, len, sr);
    const d = this.tickBuf.getChannelData(0);
    for (let i = 0; i < len; i++) { const t = i / sr; d[i] = Math.exp(-t * 260) * (0.6 * Math.sin(2 * Math.PI * 2300 * t) + 0.35 * Math.sin(2 * Math.PI * 5200 * t)) + (Math.random() * 2 - 1) * Math.exp(-t * 900) * 0.5; }
  }
  setCabin(interior: boolean) {
    const t = this.ctx.currentTime;
    if (interior !== this.cabin) this.lp.frequency.setTargetAtTime(interior ? 1800 : 9000, t, 0.05); // the horn is outside the firewall
    this.cabin = interior;
  }
  setHorn(on: boolean) {
    if (on === this.hornOn) return; this.hornOn = on;
    const t = this.ctx.currentTime, g = this.horn.gain;
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.setTargetAtTime(on ? 0.32 : 0, t, on ? 0.008 : 0.025);
  }
  tick(on: boolean) {
    const s = this.ctx.createBufferSource(); s.buffer = this.tickBuf; s.playbackRate.value = on ? 1 : 0.8;
    const g = this.ctx.createGain(); g.gain.value = this.cabin ? 0.5 : 0.18; // the relay sits behind the dashboard
    s.connect(g).connect(this.out); s.start(); s.onended = () => g.disconnect();
  }
}
