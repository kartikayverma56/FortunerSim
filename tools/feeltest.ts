import { Vehicle } from '../src/physics/vehicle';
const mk = () => { const v = new Vehicle(); v.reset(0, 0, 0); v.ignition = true; v.omegaE = 750 * Math.PI / 30; v.input.brake = 1; v.setSelector('D'); for (let i = 0; i < 2000; i++) v.step(0.001); v.input.brake = 0; return v; };
// creep on flat
{ const v = mk(); for (let t = 0; t < 15; t += 0.001) v.step(0.001); console.log('creep after 15 s:', v.kmh.toFixed(1), 'km/h, gear', v.gear, 'rpm', v.rpm.toFixed(0)); }
// part throttle response
for (const th of [0.15, 0.3, 0.5]) { const v = mk(); v.input.throttle = th; let t = 0; const out: string[] = []; for (; t < 8; t += 0.001) { v.step(0.001); if (Math.abs(t - 1) < 5e-4 || Math.abs(t - 3) < 5e-4 || Math.abs(t - 6) < 5e-4) out.push(`${t.toFixed(0)}s ${v.kmh.toFixed(0)}km/h ${(v.accelBody.z/9.81).toFixed(2)}g`); } console.log('throttle', th, out.join(' | ')); }
// steering: lock and turning circle at 5 km/h
{ const v = mk(); v.input.steer = 1; for (let t = 0; t < 12; t += 0.001) { const e = 5/3.6 - v.speed; v.input.throttle = Math.max(0, Math.min(0.3, e)); v.input.brake = e < -0.3 ? 0.2 : 0; v.step(0.001); } console.log('full lock: wheel', (v.steerWheelAngle*57.3).toFixed(0), 'deg, road', (v.wheels[0].steer*57.3).toFixed(1), '/', (v.wheels[1].steer*57.3).toFixed(1), 'radius', (v.speed / Math.max(1e-3, Math.abs(v.yawRate))).toFixed(2), 'm'); }
