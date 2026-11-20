// Straight-line tracking: an undamaged car with the steering input held at exactly 0 must go straight.
// Rows: cruise 60 / 100 km/h and a full-throttle launch (10 s each) on perfectly flat asphalt and on the runway from the
// spawn point, the symmetric-car check, VSC/A-TRC off launches (chirp, burnout on loose ground) and information rows
// (RHD driver offset, a 2.5 % crossfall like the left lane of a crowned road, a grass launch).
// "right" = lateral displacement to the car's right (−X) over the 10 s window, in the window's initial heading frame;
// "hdg" = heading change (+ = left). Run: esbuild tools/straighttest.ts --bundle --platform=node --format=esm --outfile=tools/.straighttest.mjs
// then node tools/.straighttest.mjs [--trace] (--trace prints the per-wheel launch log of the default car).
import { Vehicle, TERRAIN_GROUND, type GroundProvider } from '../src/physics/vehicle';
import { FORTUNER } from '../src/physics/params';

const DT = 0.001;
const ground = (surf: string, crossfall = 0): GroundProvider => ({ heightAt: (x: number) => -crossfall * x, surfaceAt: () => surf as any });
const FLAT = ground('asphalt');
const head = (v: Vehicle) => { const q = v.q; return Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y)) * 180 / Math.PI; };

type Mode = 'c60' | 'c100' | 'launch';
interface Res { hdg: number; right: number; dist: number; kMax: number; spin: number; v: number; static: string }

function run(mode: Mode, opt: { tweak?: (P: any) => void; gnd?: GroundProvider; x?: number; z?: number; vsc?: boolean; trace?: boolean } = {}): Res {
  const P: any = structuredClone(FORTUNER); opt.tweak?.(P);
  const v = new Vehicle(P, opt.gnd ?? FLAT); v.reset(opt.x ?? 0, opt.z ?? 0, 0);
  v.ignition = true; v.omegaE = 750 * Math.PI / 30; v.setSelector('D'); v.input.steer = 0; v.vscOn = opt.vsc ?? true;
  v.input.brake = 1; for (let i = 0; i < 3000; i++) v.step(DT); v.input.brake = 0; // 3 s settle on the brake
  const st = v.wheels.map(w => w.Fz.toFixed(0)).join('/');
  const tgt = mode === 'c60' ? 60 : 100;
  if (mode !== 'launch') { let t = 0; v.input.throttle = 1; while (v.kmh < tgt && t < 40) { v.step(DT); t += DT; } }
  const h0 = head(v), x0 = v.pos.x, z0 = v.pos.z; let kMax = 0, spin = 0;
  const T = [0.05, 0.2, 0.5, 1, 2];
  for (let i = 1; i <= 10000; i++) {
    if (mode === 'launch') v.input.throttle = 1;
    else { const e = tgt / 3.6 - v.speed; v.input.throttle = Math.max(0, Math.min(1, 0.3 + e * 0.5)); }
    v.step(DT);
    let kNow = 0; for (let k = 0; k < 4; k++) if (!v.wheels[k].front || v.driveMode !== '2H') kNow = Math.max(kNow, Math.abs(v.wheels[k].kappa));
    kMax = Math.max(kMax, kNow); if (kNow > 0.2) spin += DT;
    if (opt.trace && T.includes(i / 1000)) console.log(`  t=${(i / 1000).toFixed(2)} v=${v.kmh.toFixed(1)} yaw=${(v.yawRate * 57.3).toFixed(3)}°/s cut=${v.trcEng.toFixed(2)} ` +
      v.wheels.map(w => `${w.name}: Fz ${w.Fz.toFixed(0)} Fx ${w.Fx.toFixed(0)} Fy ${w.Fy.toFixed(0)} κ ${w.kappa.toFixed(3)} α ${(w.alpha * 57.3).toFixed(3)}°`).join(' | '));
  }
  const hr = h0 * Math.PI / 180, dx = v.pos.x - x0, dz = v.pos.z - z0;
  return { hdg: head(v) - h0, right: -(dx * Math.cos(hr) - dz * Math.sin(hr)), dist: Math.hypot(dx, dz), kMax, spin, v: v.kmh, static: st };
}

const rows: string[] = [];
let fails = 0;
function row(name: string, mode: Mode, r: Res, lim?: { right: number; hdg?: number; k?: number }) {
  let verdict = 'info';
  if (lim) {
    const ok = Math.abs(r.right) <= lim.right && (lim.hdg == null || Math.abs(r.hdg) <= lim.hdg) && (lim.k == null || r.kMax <= lim.k);
    verdict = ok ? 'PASS' : 'FAIL'; if (!ok) fails++;
  }
  const target = !lim ? '–' : `|right| ≤ ${lim.right} m` + (lim.hdg != null ? `, |hdg| ≤ ${lim.hdg}°` : '') + (lim.k != null ? `, κ ≤ ${lim.k}` : '');
  rows.push(`| ${name} | ${mode} | ${r.right.toFixed(3)} | ${r.hdg.toFixed(3)} | ${r.dist.toFixed(0)} | ${r.v.toFixed(0)} | ${r.kMax.toFixed(3)} | ${r.spin.toFixed(2)} | ${r.static} | ${target} | ${verdict} |`);
}

if (process.argv.includes('--trace')) { console.log('per-wheel launch log, default car, flat asphalt, A-TRC on'); run('launch', { trace: true }); }

const CRUISE = { right: 0.15, hdg: 0.1 }, LAUNCH = { right: 0.5, k: 0.2 }, SYM = { right: 0.01, hdg: 0.01 };
// targets: the default (undamaged) car, flat asphalt, zero steer
for (const m of ['c60', 'c100'] as Mode[]) row('default car, flat asphalt', m, run(m), CRUISE);
row('default car, flat asphalt, A-TRC on', 'launch', run('launch'), LAUNCH);
// the runway from the spawn point (left lane, real terrain functions)
for (const m of ['c60', 'c100'] as Mode[]) row('runway from spawn (3.5, −40)', m, run(m, { gnd: TERRAIN_GROUND, x: 3.5, z: -40 }), CRUISE);
row('runway from spawn (3.5, −40)', 'launch', run('launch', { gnd: TERRAIN_GROUND, x: 3.5, z: -40 }), LAUNCH);
// symmetric car: must be straight to numerical noise
const noDriver = (P: any) => { P.driverMass.v = 0; };
for (const m of ['c60', 'c100', 'launch'] as Mode[]) row('symmetric (driverMass 0)', m, run(m, { tweak: noDriver }), SYM);
row('symmetric, jackingForces off', 'launch', run('launch', { tweak: P => { P.jackingForces.v = false; } }), SYM);
// VSC / A-TRC off: the rears may chirp; burnouts on loose ground must stay possible
row('VSC/A-TRC OFF, flat asphalt', 'launch', run('launch', { vsc: false }), { right: 0.5 });
{ const r = run('launch', { vsc: false, gnd: ground('gravel') }); row('VSC OFF, gravel (burnout: κ > 0.5)', 'launch', r); if (r.kMax <= 0.5) { fails++; rows[rows.length - 1] = rows[rows.length - 1].replace('| info |', '| FAIL |'); } else rows[rows.length - 1] = rows[rows.length - 1].replace('| info |', '| PASS |'); }
row('VSC OFF, grass', 'launch', run('launch', { vsc: false, gnd: ground('grass') }));
// information: RHD driver offset (driverSeatX −0.38), crossfall, loose ground with A-TRC
const rhd = (P: any) => { P.driverSeatX.v = -0.38; };
for (const m of ['c60', 'c100', 'launch'] as Mode[]) row('info: RHD driver at −0.38 m', m, run(m, { tweak: rhd }));
for (const m of ['c100', 'launch'] as Mode[]) row('info: 2.5 % crossfall falling left', m, run(m, { gnd: ground('asphalt', 0.025) }));
row('info: A-TRC on, grass', 'launch', run('launch', { gnd: ground('grass') }), { right: 0.5, k: 0.2 });
row('info: A-TRC on, 2.5 % crossfall, grass', 'launch', run('launch', { gnd: ground('grass', 0.025) }));

console.log('| case | test | right m | hdg ° | dist m | end km/h | peak driven κ | time κ > 0.2 s | static Fz FL/FR/RL/RR N | target | result |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) console.log(r);
console.log(fails ? `${fails} FAIL` : 'all PASS');
