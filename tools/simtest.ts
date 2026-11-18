import { Vehicle } from '../src/physics/vehicle';
const v = new Vehicle();
const dt = 1 / 1000;
v.reset(0, 0, 0);
v.ignition = true; v.omegaE = 750 * Math.PI / 30;
// settle
v.input.brake = 1; v.setSelector('D');
for (let i = 0; i < 3000; i++) v.step(dt);
const w = v.wheels;
console.log('settle: y', v.pos.y.toFixed(3), 'pitch', (v.pitch*57.3).toFixed(2), 'roll', (v.roll*57.3).toFixed(2), 'Fz', w.map(x => x.Fz.toFixed(0)).join(','), 's', w.map(x => (x.s*1000).toFixed(1)).join(','), 'rpm', v.rpm.toFixed(0));
// 0-100
v.input.brake = 0; v.input.throttle = 1;
const marks = [20, 40, 60, 80, 100]; const res: string[] = []; let t = 0; let last = -1;
while (t < 30 && v.kmh < 101) { v.step(dt); t += dt; for (const m of marks) if (v.kmh >= m && !res.find(r => r.startsWith(m + ':'))) res.push(`${m}:${t.toFixed(2)}s g${v.gear} ${v.rpm.toFixed(0)}rpm`);
  if (Math.floor(t * 2) !== last) { last = Math.floor(t * 2); if (last % 2 === 0) console.log(` t=${t.toFixed(1)} v=${v.kmh.toFixed(1)} g=${v.gear} rpm=${v.rpm.toFixed(0)} slip=${v.tcSlip.toFixed(2)} boost=${v.boost.toFixed(2)} Te=${v.engineTorque.toFixed(0)} pitch=${(v.pitch*57.3).toFixed(2)} lock=${v.lockup}`); } }
console.log('0-x', res.join(' | '), 'dist', v.odometer.toFixed(1));
// top up to 100 and brake
v.input.throttle = 0; v.input.brake = 1; const d0 = v.odometer; t = 0; let maxPitch = 0;
while (v.speed > 0.05 && t < 15) { v.step(dt); t += dt; maxPitch = Math.max(maxPitch, v.pitch); }
console.log('100-0: dist', (v.odometer - d0).toFixed(1), 'm time', t.toFixed(2), 'dive', (maxPitch*57.3).toFixed(2), 'deg', 'abs used');
// steady-state cornering: ramp steer at constant 60 km/h
{
  const u = new Vehicle(); u.reset(-260, 380, 0); u.ignition = true; u.omegaE = 80; u.setSelector('D');
  let tt = 0; const target = 60 / 3.6;
  for (let i = 0; i < 40000; i++) {
    const e = target - u.speed; u.input.throttle = Math.max(0, Math.min(1, e * 0.6 + 0.25)); u.input.brake = e < -1 ? 0.2 : 0;
    u.input.steer = tt < 8 ? 0 : Math.min(0.5, (tt - 8) * 0.02);
    u.step(1 / 1000); tt += 1 / 1000;
    if (tt > 8 && Math.round(tt * 1000) % 2500 === 0) console.log(`corner t=${tt.toFixed(1)} v=${u.kmh.toFixed(1)} steer=${u.input.steer.toFixed(2)} ay=${(u.accelBody.x/9.81).toFixed(2)}g roll=${(u.roll*57.3).toFixed(2)}° yaw=${u.yawRate.toFixed(3)} vsc=${u.vscActive} Fz=${u.wheels.map(w=>w.Fz.toFixed(0)).join(',')}`);
  }
}
