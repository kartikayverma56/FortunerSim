// Steady-state cornering balance: slow ramp steer at constant 60 km/h on a flat synthetic pad (no edge to run off).
// Prints lateral g, handwheel, understeer gradient, roll, measured front share of lateral load transfer (LLTD).
// Usage: node tools/.balance.mjs ['{"arbFront":60000,...}'] [vsc=0|1]
import { Vehicle } from '../src/physics/vehicle';
import { FORTUNER, type VehicleParams } from '../src/physics/params';

const over = JSON.parse(process.argv[2] || '{}') as Record<string, number | boolean>;
const vsc = process.argv[3] !== '0';
const P: VehicleParams = { ...FORTUNER };
for (const [k, v] of Object.entries(over)) (P as any)[k] = { ...(FORTUNER as any)[k], v };
const v = new Vehicle(P, { heightAt: () => 0, surfaceAt: () => 'asphalt' }); v.reset(0, 0, 0); v.ignition = true; v.omegaE = 80; v.setSelector('D'); v.vscOn = vsc;
const target = 60 / 3.6, L = P.wheelbase.v, G = 9.81;
let t = 0; const rows: string[] = []; let spun = false, maxAy = 0, rollGrad = NaN;
const acc: { ay: number; roll: number; K: number; lltd: number }[] = [];
for (let i = 0; i < 45000; i++) {
  const e = target - v.speed; v.input.throttle = Math.max(0, Math.min(1, e * 0.6 + 0.25)); v.input.brake = e < -1 ? 0.2 : 0;
  v.input.steer = t < 4 ? 0 : Math.min(0.6, (t - 4) * 0.012);
  v.step(0.001); t += 0.001;
  const q = v.q, fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y), sp = Math.hypot(v.vel.x, v.vel.z);
  const beta = Math.acos(Math.max(-1, Math.min(1, (fx * v.vel.x + fz * v.vel.z) / (Math.hypot(fx, fz) * sp || 1)))) * 57.3;
  if (beta > 20 && sp > 3) spun = true;
  if (i % 50 === 0 && t > 6) {
    const ay = v.accelBody.x / G; maxAy = Math.max(maxAy, ay);
    const w = v.wheels, dF = Math.abs(w[1].Fz - w[0].Fz) / 2, dR = Math.abs(w[3].Fz - w[2].Fz) / 2;
    const d = (w[0].steer + w[1].steer) / 2, K = (d - L * v.yawRate / Math.max(1, v.speed)) * 57.3 / Math.max(0.05, ay);
    if (!spun && ay > 0.1) acc.push({ ay, roll: v.roll * 57.3, K, lltd: dF / (dF + dR) });
  }
  if (i % 2500 === 0 && t > 6) rows.push(`| ${t.toFixed(1)} | ${v.kmh.toFixed(1)} | ${(v.accelBody.x / G).toFixed(2)} | ${v.steerWheelAngle * 57.3 | 0} | ${(v.roll * 57.3).toFixed(2)} | ${beta.toFixed(1)} | ${v.vscActive ? 'VSC' : ''}${v.vscRollActive ? '+roll' : ''} | ${v.wheels.map(w => w.Fz.toFixed(0)).join(',')} |`);
}
const pick = (lo: number, hi: number) => { const s = acc.filter(a => a.ay >= lo && a.ay < hi); const m = (f: (a: typeof s[0]) => number) => s.reduce((x, a) => x + f(a), 0) / (s.length || 1); return s.length ? `${m(a => a.K).toFixed(2)} °/g, LLTD front ${(m(a => a.lltd) * 100).toFixed(1)} %, roll ${(m(a => a.roll) / m(a => a.ay)).toFixed(2)} °/g` : '–'; };
console.log(`overrides ${JSON.stringify(over)}  VSC ${vsc ? 'on' : 'off'}`);
console.log('| t s | km/h | ay g | handwheel ° | roll ° | sideslip ° | assist | Fz FL,FR,RL,RR |\n|---|---|---|---|---|---|---|---|');
console.log(rows.join('\n'));
console.log(`understeer gradient / LLTD / roll gradient: 0.2–0.4 g: ${pick(0.2, 0.4)} · 0.4–0.6 g: ${pick(0.4, 0.6)}; max ay ${maxAy.toFixed(2)} g; spun ${spun}`);
void rollGrad;
