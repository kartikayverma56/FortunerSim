// Keyboard + gamepad input with pedal/steer smoothing (keyboard keys are on/off, real pedals are not).
import type { DriverInput } from './physics/vehicle';

export class Input {
  keys = new Set<string>();
  out: DriverInput = { throttle: 0, brake: 0, steer: 0, handbrake: 0 };
  gamepad = false;
  padHorn = false; // gamepad left-stick press (L3)
  private pressed: string[] = [];
  constructor() {
    addEventListener('keydown', e => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (!this.keys.has(e.code)) this.pressed.push(e.code);
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'Slash'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', e => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }
  /** Keys pressed since the last call (for toggles). */
  takePressed() { const p = this.pressed; this.pressed = []; return p; }
  private padPrev: boolean[] = [];
  padPressed: number[] = [];

  update(dt: number, speedKmh: number) {
    const k = this.keys;
    let thrT = (k.has('KeyW') || k.has('ArrowUp')) ? (k.has('ShiftLeft') || k.has('ShiftRight') ? 0.35 : 1) : 0;
    let brkT = (k.has('KeyS') || k.has('ArrowDown')) ? 1 : 0;
    let steerT = ((k.has('KeyA') || k.has('ArrowLeft')) ? 1 : 0) - ((k.has('KeyD') || k.has('ArrowRight')) ? 1 : 0);
    let hb = k.has('Space') ? 1 : 0;
    // gamepad (standard mapping): RT throttle, LT brake, left stick steer, B/X handbrake
    this.padPressed = [];
    const gp = navigator.getGamepads?.().find(g => g && g.connected);
    let analogSteer: number | null = null;
    if (gp) {
      this.gamepad = true;
      const rt = gp.buttons[7]?.value ?? 0, lt = gp.buttons[6]?.value ?? 0, sx = gp.axes[0] ?? 0;
      if (rt > 0.02) thrT = Math.max(thrT, rt);
      if (lt > 0.02) brkT = Math.max(brkT, lt);
      if (Math.abs(sx) > 0.06) analogSteer = -Math.sign(sx) * Math.pow((Math.abs(sx) - 0.06) / 0.94, 1.4);
      if (gp.buttons[1]?.pressed) hb = 1;
      this.padHorn = !!gp.buttons[10]?.pressed;
      gp.buttons.forEach((b, i) => { if (b.pressed && !this.padPrev[i]) this.padPressed.push(i); this.padPrev[i] = b.pressed; });
    }
    const o = this.out;
    const ramp = (cur: number, tgt: number, up: number, down: number) => tgt > cur ? Math.min(tgt, cur + dt / up) : Math.max(tgt, cur - dt / down);
    // Keyboard pedals press in progressively like a foot: a tap is a light pedal, holding goes deeper.
    // Throttle: 0→50 % in 0.45 s, 50→100 % over another 0.9 s; off in 0.15 s. Brake: 0→50 % in 0.25 s, →100 % in 0.6 s more.
    const pedal = (cur: number, tgt: number, tHalf: number, tRest: number, tOff: number) =>
      tgt > cur ? Math.min(tgt, cur + dt * (cur < 0.5 ? 0.5 / tHalf : 0.5 / tRest)) : Math.max(tgt, cur - dt / tOff);
    o.throttle = analogSteer !== null || (gp && (gp.buttons[7]?.value ?? 0) > 0.02) ? thrT : pedal(o.throttle, thrT, 0.45, 0.9, 0.15);
    o.brake = gp && (gp.buttons[6]?.value ?? 0) > 0.02 ? brkT : pedal(o.brake, brkT, 0.25, 0.6, 0.12);
    o.handbrake = hb;
    if (analogSteer !== null) o.steer = analogSteer;
    else {
      // keyboard: rate-limited, self-centering, and limited at speed (what a driver's hands would do)
      const v = Math.max(0, Math.abs(speedKmh));
      const lim = 1 / (1 + Math.pow(v / 32, 1.7)); // ≈ the steer angle the tyres can actually use at this speed
      const tgt = steerT * Math.max(0.12, lim);
      // hands: brisk hand-over-hand when parking (full lock ≈ 1.1 s), smaller deliberate inputs at speed
      const turn = 0.9 - 0.45 * Math.min(1, v / 80);
      // caster self-centring: the wheel barely returns at a standstill, and returns quickly once rolling
      const centre = 0.25 + 2.4 * Math.min(1, v / 25);
      const rate = steerT === 0 ? centre : (Math.sign(tgt) !== Math.sign(o.steer) && o.steer !== 0 ? Math.max(turn, centre) * 1.6 : turn);
      o.steer = ramp(o.steer, tgt, 1 / rate, 1 / rate);
    }
    return o;
  }
}
