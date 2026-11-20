// Damage consequences (PLAN_crash_damage_mirrors.md §4), each triggered by a scripted hit and measured afterwards.
// Build: ./node_modules/.bin/esbuild tools/damagetest.ts --bundle --platform=node --format=esm --outfile=tools/.damagetest.mjs && node tools/.damagetest.mjs
import { Vehicle, type GroundProvider } from '../src/physics/vehicle';
import { colliders } from '../src/world/colliders';

const DT = 0.001;
const flat: GroundProvider = { heightAt: () => 0, surfaceAt: () => 'asphalt' };
const rows: string[][] = [];
function mk(running = false) {
  const v = new Vehicle(undefined, flat); v.reset(0, 0, 0);
  if (running) { v.ignition = true; v.omegaE = 80; v.engineRunning = true; v.setSelector('D'); } else v.setSelector('N');
  return v;
}
function launch(v: Vehicle, kmh: number, lateral = false) { const s = kmh / 3.6; if (lateral) v.vel.x = s; else { v.vel.z = s; for (const w of v.wheels) w.omega = s / v.R; } }
function steps(v: Vehicle, n: number, f?: () => void) { for (let i = 0; i < n; i++) { f?.(); v.step(DT); } }
const heading = (v: Vehicle) => Math.atan2(2 * (v.q.x * v.q.z + v.q.w * v.q.y), 1 - 2 * (v.q.x ** 2 + v.q.y ** 2));
/** Straight-ahead drive at 50 km/h with the wheel held centred for 5 s: heading change (deg) and lateral drift (m). */
function pullTest(v: Vehicle) {
  colliders.clear(); const x0 = v.pos.x, z0 = v.pos.z, h0 = heading(v);
  v.reset(x0, z0, h0); v.ignition = true; v.omegaE = 200; v.engineRunning = true; v.setSelector('D'); v.vel.x = Math.sin(h0) * 50 / 3.6; v.vel.z = Math.cos(h0) * 50 / 3.6; for (const w of v.wheels) w.omega = 50 / 3.6 / v.R;
  steps(v, 5000, () => { const e = 50 / 3.6 - v.speed; v.input.throttle = Math.max(0, Math.min(1, 0.3 + e * 0.3)); v.input.steer = 0; v.input.brake = 0; });
  const dh = (heading(v) - h0) * 57.3, lat = (v.pos.x - x0) * Math.cos(h0) - (v.pos.z - z0) * Math.sin(h0);
  return { dh, lat: -lat };
}
/** Coast-down from 60 km/h in N for 5 s: speed lost (km/h). */
function coast(v: Vehicle) {
  const h0 = heading(v); v.reset(v.pos.x, v.pos.z, h0); v.setSelector('N'); v.vel.x = Math.sin(h0) * 60 / 3.6; v.vel.z = Math.cos(h0) * 60 / 3.6; for (const w of v.wheels) w.omega = 60 / 3.6 / v.R;
  steps(v, 5000, () => { v.input.throttle = 0; v.input.brake = 0; v.input.steer = 0; });
  return 60 - v.kmh;
}
const row = (c: string, trig: string, res: string) => rows.push([c, trig, res]);

// ---- 0. reference (undamaged) ----
const ref = mk(); const refPull = pullTest(ref); const refCoast = coast(mk());
const refH = ref.pos.y;

// ---- 1. toe offset / steering pull, damper 30 %: sliding sideways into a 150 mm kerb at 20 km/h ----
{
  const x0 = 0.7725 + 0.1325 + 0.05;
  const kerb: GroundProvider = { heightAt: (x) => x <= x0 ? 0 : x >= x0 + 0.04 ? 0.15 : 0.15 * (x - x0) / 0.04, surfaceAt: () => 'asphalt' };
  const v = new Vehicle(undefined, kerb); v.reset(0, 0, 0); v.setSelector('N'); colliders.clear();
  launch(v, 20, true); for (const w of v.wheels) w.omega = 0; steps(v, 3000);
  const kp = v.wheels.map(w => (w.kerbPeak / 1000).toFixed(0)).join(' / ');
  const bent = v.damage.wheels.map((d, i) => d.bent ? `${v.wheels[i].name} toe ${(d.toe * 57.3).toFixed(1)}°` : '').filter(Boolean).join(', ');
  v.setGround(flat); const p = pullTest(v);
  row('Toe offset → steering pull; damper × 0.3', 'sliding sideways at 20 km/h into a 150 mm kerb (rim on the face)', `lateral kerb force FL/FR/RL/RR ${kp} kN → ${bent || 'no wheel bent'}, damper ×${v.damage.damperK.join('/')}; hands-off at 50 km/h for 5 s: heading change ${p.dh.toFixed(1)}° (undamaged ${refPull.dh.toFixed(2)}°), drift ${p.lat.toFixed(1)} m (undamaged ${refPull.lat.toFixed(2)} m)`);
}
// ---- 2. puncture: rim strike in a deep square-edged pothole at 50 km/h ----
{
  colliders.clear();
  const step: GroundProvider = { heightAt: (_x, z) => (z > 3 && z < 4.2 ? -0.15 : 0), surfaceAt: () => 'asphalt' };
  const v = new Vehicle(undefined, step); v.reset(0, 0, 0); v.setSelector('N'); launch(v, 50); let rimF = 0;
  steps(v, 1500, () => { for (const w of v.wheels) rimF = Math.max(rimF, 4e6 * Math.max(0, w.pen - 0.09)); });
  const punct = v.damage.wheels.map((w, i) => w.puncture ? v.wheels[i].name : '').filter(Boolean);
  const u = v; u.setGround(flat); const c = coast(u); steps(u, 2000);
  const i = v.damage.wheels.findIndex(w => w.puncture);
  row('Puncture: tyre 290 → 70 kN/m, μ × 0.6, rolling resistance × 4', '50 km/h through a 1.2 m long, 150 mm deep square-edged pothole', `peak rim force ${(rimF / 1000).toFixed(0)} kN; punctured: ${punct.join(', ') || 'none'}${i >= 0 ? `; parked, that tyre is squashed ${(u.wheels[i].pen * 1000).toFixed(0)} mm (intact ${(ref.wheels[i].pen * 1000).toFixed(0)} mm)` : ''}; 60 km/h coast-down in N loses ${c.toFixed(1)} km/h in 5 s (undamaged ${refCoast.toFixed(1)})`);
}
// ---- 3. collapsed suspension: side pole at the front-left wheel arch, 32 km/h ----
{
  const v = mk(); colliders.clear(); colliders.addCylinder({ x: 0.9275 + 0.6, z: v.a, radius: 0.127, height: 6, y0: -0.3, material: 'steel', tag: 'pole' });
  launch(v, 32, true); steps(v, 3000); colliders.clear();
  const d = v.damage.wheels[0]; v.reset(0, 0, 0); v.setSelector('N'); steps(v, 3000);
  row('Suspension collapsed: spring × 0.4, wheel dragged', 'sliding sideways at 32 km/h into a Ø 254 mm pole at the FL arch', `FL collapsed: ${d.collapsed ? 'yes' : 'no'} (arch crush ${(v.hull.dp[v.damage.archPt[0]] * 100).toFixed(0)} cm); parked: FL suspension at ${(v.wheels[0].s * 1000).toFixed(0)} mm (undamaged ${(ref.wheels[0].s * 1000).toFixed(0)} mm), body roll ${(v.roll * 57.3).toFixed(1)}°, pitch ${(v.pitch * 57.3).toFixed(1)}°`);
}
// ---- 4. coolant leak → derate → stall: rigid wall at 22 km/h (front crush 0.12–0.25 m), then driving on ----
{
  const v = mk(true); colliders.clear(); colliders.addBox({ x: 0, z: 2.28 + 1.0 + 0.5, halfX: 4, halfZ: 0.5, yaw: 0, height: 2.5, y0: -0.3, material: 'concrete', tag: 'wall' });
  v.input.throttle = 0; v.setSelector('N'); launch(v, 16); steps(v, 2000); colliders.clear();
  let front = 0; for (const i of v.damage.zonePts.front) front = Math.max(front, v.hull.dp[i]);
  const air = v.damage.airbags;
  v.reset(0, 0, 0); if (!v.ignition) v.startEngine(); steps(v, 1500); v.setSelector('D');
  let t = 0, tDerate = NaN, tStall = NaN; const maxT = 900;
  while (t < maxT) { // a hard drive: 70 % throttle, speed held near 60 km/h with the brake
    const e = 60 / 3.6 - v.speed; v.input.throttle = 0.7; v.input.brake = e < -1 ? 0.25 : 0; v.input.steer = 0;
    steps(v, 100); t += 0.1; if (v.pos.z > 3000) v.pos.z -= 3000;
    if (Number.isNaN(tDerate) && v.damage.derate < 0.99) tDerate = t; if (Number.isNaN(tStall) && !v.ignition) { tStall = t; break; }
  }
  row('Coolant leak → temperature → derate → stall', 'rigid wall at 16 km/h (engine running, N), then 70 % throttle at ~60 km/h', `front crush ${(front * 100).toFixed(0)} cm, leak ${v.damage.coolantLeak ? 'yes' : 'no'}, intercooler ${v.damage.intercooler ? 'holed' : 'ok'}, airbags ${air ? 'fired' : 'no'}; derate from ${tDerate.toFixed(0)} s (112 °C), stall at ${tStall.toFixed(0)} s (${v.damage.coolantT.toFixed(0)} °C); restart blocked: "${v.startBlock()}"`);
}
// ---- 5. intercooler holed → no boost: wall at 40 km/h ----
{
  const v = mk(); colliders.clear(); colliders.addBox({ x: 0, z: 2.28 + 1.0 + 0.5, halfX: 4, halfZ: 0.5, yaw: 0, height: 2.5, y0: -0.3, material: 'concrete', tag: 'wall' });
  launch(v, 40); steps(v, 2000); colliders.clear();
  let front = 0; for (const i of v.damage.zonePts.front) front = Math.max(front, v.hull.dp[i]);
  const acc = (u: Vehicle) => { u.reset(0, 0, 0); u.startEngine(); steps(u, 2000); u.setSelector('D'); let t = 0, bMax = 0; while (u.kmh < 60 && t < 40) { u.input.throttle = 1; u.input.brake = 0; steps(u, 10); t += 0.01; bMax = Math.max(bMax, u.boost); } return { t, bMax, Te: u.engineTorque }; };
  const a = acc(v), r = acc(mk());
  row('Intercooler holed → no boost (0.42 no-boost torque)', 'rigid wall at 40 km/h', `front crush ${(front * 100).toFixed(0)} cm, intercooler ${v.damage.intercooler ? 'holed' : 'ok'}, engine dead ${v.damage.engineDead ? 'yes' : 'no'}; 0–60 km/h full throttle ${a.t.toFixed(1)} s (undamaged ${r.t.toFixed(1)} s), peak boost ${(a.bMax * 100).toFixed(0)} % (undamaged ${(r.bMax * 100).toFixed(0)} %)`);
}
// ---- 6. engine dead + 7. airbags/fuel cut: pole at 50 km/h, engine running ----
{
  const v = mk(true); v.setSelector('N'); colliders.clear(); colliders.addCylinder({ x: 0, z: 2.28 + 1.0 + 0.127, radius: 0.127, height: 6, y0: -0.3, material: 'steel', tag: 'pole' });
  launch(v, 50); let tOff = NaN; for (let i = 0; i < 2000; i++) { v.step(DT); if (Number.isNaN(tOff) && !v.ignition) tOff = i * DT; }
  colliders.clear(); let front = 0; for (const i of v.damage.zonePts.front) front = Math.max(front, v.hull.dp[i]);
  v.startEngine(); steps(v, 3000);
  row('Engine dead', 'Ø 254 mm pole at 50 km/h, engine running', `front crush ${(front * 100).toFixed(0)} cm → engine dead ${v.damage.engineDead ? 'yes' : 'no'}; Enter cranks: ignition after 3 s ${v.ignition ? 'ON' : 'off'} ("${v.startBlock()}")`);
  const w = mk(true); w.setSelector('N'); colliders.addBox({ x: 0, z: 2.28 + 1.0 + 0.5, halfX: 4, halfZ: 0.5, yaw: 0, height: 2.5, y0: -0.3, material: 'concrete', tag: 'wall' });
  launch(w, 32); let t2 = NaN; for (let i = 0; i < 2000; i++) { w.step(DT); if (Number.isNaN(t2) && !w.ignition) t2 = i * DT; } colliders.clear();
  const dv = w.damage.peakDvLong; const dead = w.damage.engineDead; w.startEngine(); steps(w, 2500);
  row('Airbags + fuel cut on ΔV (6 m/s frontal, 4 m/s lateral, 150 ms)', 'rigid wall at 32 km/h, engine running', `ΔV ${dv.toFixed(1)} m/s → airbags ${w.damage.airbags ? 'fired' : 'no'}, engine off after ${(t2 * 1000).toFixed(0)} ms; Enter: ${dead ? 'dead' : w.ignition ? `restarted (${w.rpm.toFixed(0)} rpm)` : 'did not restart'}`);
  void tOff;
}
// ---- 8. inverted > 3 s → stall ----
{
  const v = mk(true); v.setSelector('P');
  v.q.w = 0; v.q.x = 0; v.q.y = 0; v.q.z = 1; v.pos.y = 1.1; // upside down on the roof
  let tStall = NaN; for (let i = 0; i < 6000; i++) { v.step(DT); if (Number.isNaN(tStall) && !v.ignition) tStall = i * DT; }
  row('Engine stalls when inverted > 3 s (oil starvation)', 'car placed on its roof with the engine idling', `stalled after ${tStall.toFixed(2)} s; reason ${v.engineStopReason ?? '-'}; crush ${(v.hull.maxCrush('roofRail') * 100).toFixed(1)} cm`);
}
// ---- 9. repair ----
{
  const v = mk(); colliders.clear(); colliders.addCylinder({ x: 0, z: 2.28 + 1.0 + 0.127, radius: 0.127, height: 6, y0: -0.3, material: 'steel', tag: 'pole' });
  launch(v, 50); steps(v, 2000); colliders.clear(); const before = v.damage.summary();
  v.repair(); v.reset(0, 0, 0);
  row('Repair (Y)', 'after the 50 km/h pole', `before: ${before}; after: "${v.damage.summary() || 'no damage'}", max crush ${v.hull.maxCrush()} m`);
}
console.log(`| Consequence | Triggered by | Result |\n|---|---|---|`);
for (const r of rows) console.log(`| ${r.join(' | ')} |`);
void refH;
