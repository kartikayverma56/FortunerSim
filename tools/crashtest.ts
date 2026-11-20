// Crash / rollover validation (PLAN_crash_damage_mirrors.md §2 table). Node only, synthetic ground, engine off.
// Build: ./node_modules/.bin/esbuild tools/crashtest.ts --bundle --platform=node --format=esm --outfile=tools/.crashtest.mjs && node tools/.crashtest.mjs [quick]
import { Vehicle, type GroundProvider } from '../src/physics/vehicle';
import { FORTUNER, type VehicleParams } from '../src/physics/params';
import { mechanicalEnergy, EnergyAudit } from '../src/physics/energy';
import type { SurfaceKey } from '../src/world/terrain';
import { colliders } from '../src/world/colliders';

const DT = 0.001, G = 9.81, D2R = Math.PI / 180;
const QUICK = process.argv.includes('quick');
const NL = String.fromCharCode(10);
const NODMG = process.argv.includes('nodamage');

// ---------------- synthetic ground ----------------
const flat = (s: SurfaceKey = 'asphalt'): GroundProvider => ({ heightAt: () => 0, surfaceAt: () => s });
const noGround: GroundProvider = { heightAt: () => -1e9, surfaceAt: () => 'asphalt' };
/** Kerb of height hk along x = x0 (face run 0.04 m, as the terrain rules require), higher side at x > x0. */
const kerb = (x0: number, hk: number): GroundProvider => ({
  heightAt: (x) => x <= x0 ? 0 : x >= x0 + 0.04 ? hk : hk * (x - x0) / 0.04, surfaceAt: () => 'asphalt' });
/** One-side ramp under the left wheels: x in [xa, xb], z from z0 rising to hr over len, then a sharp drop. */
const ramp = (xa: number, xb: number, z0: number, len: number, hr: number, s: SurfaceKey = 'asphalt'): GroundProvider => ({
  heightAt: (x, z) => {
    if (z < z0 || z > z0 + len + 0.04) return 0;
    const ex = Math.min(1, Math.max(0, Math.min(x - xa, xb - x) / 0.04)); if (ex <= 0) return 0;
    const hz = z <= z0 + len ? hr * (z - z0) / len : hr * (1 - (z - z0 - len) / 0.04);
    return hz * ex;
  }, surfaceAt: () => s });
/** Road (asphalt, x < x0) then a 30° slope into a 0.6 m deep ditch with a 1 m flat bottom and a 45° far bank, grass. */
const ditch = (x0: number): GroundProvider => {
  const d = 0.6, s1 = d / Math.tan(30 * D2R), s2 = d / Math.tan(45 * D2R);
  return {
    heightAt: (x) => x <= x0 ? 0 : x <= x0 + s1 ? -(x - x0) * Math.tan(30 * D2R) : x <= x0 + s1 + 1 ? -d : x <= x0 + s1 + 1 + s2 ? -d + (x - x0 - s1 - 1) : 0,
    surfaceAt: (x) => x <= x0 ? 'asphalt' : 'grass' };
};

// ---------------- vehicle helpers ----------------
const CG0 = FORTUNER.cgHeight.v;
function params(cg = CG0, jack = true): VehicleParams {
  return { ...FORTUNER, cgHeight: { ...FORTUNER.cgHeight, v: cg }, jackingForces: { ...FORTUNER.jackingForces, v: jack } };
}
function mk(ground: GroundProvider, cg = CG0, jack = true, sel: 'N' | 'P' = 'N') {
  const v = new Vehicle(params(cg, jack), ground); v.reset(0, 0, 0); v.ignition = false; v.setSelector(sel);
  if (NODMG) (v.damage as any).update = () => null; // 'nodamage': Stage 1 behaviour (no wheel / engine faults after hits)
  return v;
}
type Q = { w: number; x: number; y: number; z: number };
const qmul = (a: Q, b: Q): Q => ({ w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z, x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x, z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w });
/** yaw about +Y, then pitch about body +X (left; + = nose down), then roll about body +Z (fwd; + = left side up). */
function orient(v: Vehicle, yaw: number, pitch: number, roll: number) {
  const qy = { w: Math.cos(yaw / 2), x: 0, y: Math.sin(yaw / 2), z: 0 }, qp = { w: Math.cos(pitch / 2), x: Math.sin(pitch / 2), y: 0, z: 0 }, qr = { w: Math.cos(roll / 2), x: 0, y: 0, z: Math.sin(roll / 2) };
  const q = qmul(qmul(qy, qp), qr); v.q.w = q.w; v.q.x = q.x; v.q.y = q.y; v.q.z = q.z;
}
const rot = (q: Q, x: number, y: number, z: number) => { const p = qmul(qmul(q, { w: 0, x, y, z }), { w: q.w, x: -q.x, y: -q.y, z: -q.z }); return { x: p.x, y: p.y, z: p.z }; };
const bodyUp = (v: Vehicle) => rot(v.q, 0, 1, 0), bodyFwd = (v: Vehicle) => rot(v.q, 0, 0, 1), bodyLeft = (v: Vehicle) => rot(v.q, 1, 0, 0);
/** Lowest world Y of the body (belly + hull points), for placing a drop. */
function lowestPoint(v: Vehicle) {
  let m = Infinity; const pts: [number, number, number][] = [...v.P.hullPoints.v.map(p => [p[0], p[1], p[2]] as [number, number, number]), ...v.bellyPoints.map(b => [b.x, b.y, b.z] as [number, number, number])];
  for (const w of v.wheels) pts.push([w.mount.x, w.mount.y - v.R, w.mount.z]);
  for (const [x, y, z] of pts) { const p = rot(v.q, x, y, z); m = Math.min(m, v.pos.y + p.y); }
  return m;
}
function setSpeed(v: Vehicle, V: number, lateral = 0) {
  const f = bodyFwd(v), l = bodyLeft(v);
  v.vel.x = f.x * V + l.x * lateral; v.vel.y = 0; v.vel.z = f.z * V + l.z * lateral;
  for (const w of v.wheels) w.omega = V / v.R;
}
const hwToSteer = (v: Vehicle, deg: number) => deg / (v.P.maxRoadWheelDeg.v * 0.88 * v.P.steerRatio.v);
const speedOf = (v: Vehicle) => Math.hypot(v.vel.x, v.vel.y, v.vel.z);
const angRate = (v: Vehicle) => Math.hypot(v.w.x, v.w.y, v.w.z);

interface Run { tRest: number; energy: EnergyAudit; E0: number; Eend: number; maxUs: number; usCrash: number[] }
/** Steps until rest (|v| < 0.1 m/s and |ω| < 0.1 rad/s for 0.5 s) or tMax. onStep gets t; returns false to stop. */
function run(v: Vehicle, tMax: number, onStep?: (t: number) => void, yRef = 0): Run {
  const audit = new EnergyAudit(); let rest = 0, tRest = NaN, t = 0; const usCrash: number[] = [];
  // wheel centres and contact states are only refreshed inside step(): take E0 after the first step
  onStep?.(0); v.step(DT); t = DT;
  const E0 = mechanicalEnergy(v, yRef).total; audit.update(E0, t);
  let chunkT = 0, chunkN = 0;
  while (t < tMax) {
    onStep?.(t);
    const a = performance.now(); v.step(DT); const b = performance.now(); t += DT;
    if (v.hull.contacts || v.collide.contacts) { chunkT += b - a; if (++chunkN === 50) { usCrash.push(chunkT / 50 * 1000); chunkT = 0; chunkN = 0; } }
    audit.update(mechanicalEnergy(v, yRef).total, t);
    // at rest, or (after a crash) back on its wheels with no body contact, not rotating, just rolling on (< 3 m/s, in N)
    const settled = angRate(v) < 0.1 && (speedOf(v) < 0.1 || (bodyUp(v).y > 0.9 && v.hull.contacts === 0 && speedOf(v) < 3 && t > 1));
    if (settled) { rest += DT; if (rest >= 0.5 && Number.isNaN(tRest)) { tRest = t - rest; break; } } else rest = 0;
  }
  return { tRest, energy: audit, E0, Eend: mechanicalEnergy(v, yRef).total, maxUs: 0, usCrash };
}
const restState = (v: Vehicle) => { const u = bodyUp(v).y; return (u > 0.7 ? 'wheels' : u < -0.7 ? 'roof' : 'side') + (speedOf(v) > 0.1 ? ` (rolling ${speedOf(v).toFixed(1)} m/s)` : ''); };
const pct = (x: number) => (x * 100).toFixed(2) + ' %';
const rows: string[][] = [];
const energyRows: [string, number, number, number, number][] = [];
const crashUs: number[] = [];
function row(test: string, expected: string, result: string, pass: boolean | null) { rows.push([test, expected, result, pass === null ? 'report' : pass ? 'PASS' : 'FAIL']); }
function noteEnergy(name: string, r: Run) { energyRows.push([name, r.E0, r.energy.maxRise, r.energy.maxRise / Math.abs(r.E0), r.energy.maxRiseT]); crashUs.push(...r.usCrash); if (process.argv.includes("us") && r.usCrash.length) { const u = [...r.usCrash].sort((a, b) => a - b); console.log(`  ${name}: ${u.length} chunks, median ${u[u.length >> 1].toFixed(1)} us/step, max ${u[u.length - 1].toFixed(1)}`); } }

// ---------------- 1. drops ----------------
function dropWheels(h: number) {
  const v = mk(flat(), CG0, true, 'P'); const yStatic = v.pos.y; v.pos.y += h;
  const ys: number[] = []; let impacted = false;
  const r = run(v, 10, () => { if (!impacted && v.wheels.some(w => w.Fz > 0)) impacted = true; if (impacted) ys.push(v.pos.y); });
  // rebound = a local maximum of the CG more than 2 cm above its final rest height (after the first impact)
  const yRest = v.pos.y; let rebounds = 0, maxB = 0;
  for (let i = 1; i + 1 < ys.length; i++) if (ys[i] >= ys[i - 1] && ys[i] > ys[i + 1]) { const b = ys[i] - yRest; maxB = Math.max(maxB, b); if (b > 0.02) rebounds++; }
  noteEnergy(`drop wheels-down ${h} m`, r);
  row(`Drop, wheels down ${h} m`, 'rest ≤ 3 s, ≤ 3 rebounds > 2 cm', `rest ${r.tRest.toFixed(2)} s, rebounds > 2 cm above rest: ${rebounds}, highest ${(maxB * 100).toFixed(1)} cm, rests on ${restState(v)} (CG ${((yRest - yStatic) * 1000).toFixed(0)} mm vs static)`, r.tRest <= 3 && rebounds <= 3);
}
function dropRoof(h: number) {
  const v = mk(flat(), CG0, true, 'P'); orient(v, 0, 0, Math.PI); v.pos.y = 0; v.pos.y = -lowestPoint(v) + h;
  let firstT = NaN, yAtImpact = 0, maxAfter = -Infinity, minY = Infinity, bottomed = false;
  const r = run(v, 10, (t) => {
    if (Number.isNaN(firstT) && v.hull.contacts) { firstT = t; }
    if (!Number.isNaN(firstT)) { if (!bottomed) { if (v.vel.y >= 0) { bottomed = true; yAtImpact = v.pos.y; } minY = Math.min(minY, v.pos.y); } else maxAfter = Math.max(maxAfter, v.pos.y); }
  });
  const crush = Math.max(v.hull.maxCrush('roofRail'), v.hull.maxCrush('roofPanel'));
  const rebound = Math.max(0, maxAfter - yAtImpact);
  noteEnergy(`drop roof-down ${h} m`, r);
  row(`Drop, roof down ${h} m`, 'rest on roof ≤ 2 s, rebound < 5 cm, crush 3–15 cm',
    `rest ${(r.tRest - firstT).toFixed(2)} s after contact on ${restState(v)}, rebound ${(rebound * 100).toFixed(1)} cm, roof crush ${(crush * 100).toFixed(1)} cm (rail ${(v.hull.maxCrush('roofRail') * 100).toFixed(1)}, panel ${(v.hull.maxCrush('roofPanel') * 100).toFixed(1)}), crush energy ${(v.hull.Wcrush / 1000).toFixed(1)} kJ`,
    r.tRest - firstT <= 2 && restState(v).startsWith('roof') && rebound < 0.05 && crush >= 0.03 && crush <= 0.15);
}
function dropCorner() {
  const v = mk(flat(), CG0, true, 'P'); orient(v, 0, 20 * D2R, 35 * D2R); v.pos.y = 0; v.pos.y = -lowestPoint(v) + 1.0;
  const f = bodyFwd(v); v.w.x = f.x * 3; v.w.y = f.y * 3; v.w.z = f.z * 3; // 3 rad/s about the roll axis
  const r = run(v, 20);
  noteEnergy('drop corner + spin', r);
  row('Drop, corner with spin (1 m, 3 rad/s roll)', 'rest ≤ 6 s', `rest ${r.tRest.toFixed(2)} s on ${restState(v)}, quarter turns ${v.quarterTurns}, crush ${(v.hull.maxCrush() * 100).toFixed(1)} cm`, r.tRest <= 6);
}

// ---------------- 2. free tumble ----------------
function tumble() {
  // (a) the integrator alone (zero torque), against the old explicit-Euler step
  const v = mk(noGround); orient(v, 0.3, 0.2, 0.1);
  const wb = { x: 1, y: 6, z: 2 }; const w0 = rot(v.q, wb.x, wb.y, wb.z); v.w.x = w0.x; v.w.y = w0.y; v.w.z = w0.z;
  const I = v.I;
  const Lw = (q: Q, w: { x: number; y: number; z: number }) => { const b = rot({ w: q.w, x: -q.x, y: -q.y, z: -q.z }, w.x, w.y, w.z); return rot(q, I.x * b.x, I.y * b.y, I.z * b.z); };
  const Er = (q: Q, w: { x: number; y: number; z: number }) => { const b = rot({ w: q.w, x: -q.x, y: -q.y, z: -q.z }, w.x, w.y, w.z); return 0.5 * (I.x * b.x * b.x + I.y * b.y * b.y + I.z * b.z * b.z); };
  const q0 = { ...v.q }, wInit = { ...v.w };
  const L0 = Lw(v.q, v.w), E0 = Er(v.q, v.w), L0m = Math.hypot(L0.x, L0.y, L0.z);
  const Z = { x: 0, y: 0, z: 0 };
  let dL = 0, dE = 0;
  for (let i = 0; i < 10000; i++) {
    (v as any).integrateL(Z, DT);
    const L = Lw(v.q, v.w); dL = Math.max(dL, Math.hypot(L.x - L0.x, L.y - L0.y, L.z - L0.z) / L0m); dE = Math.max(dE, Math.abs(Er(v.q, v.w) - E0) / E0);
  }
  // old step for comparison (body-frame explicit Euler + first-order quaternion), same start
  const q = { ...q0 }, w = { ...wInit }; let dLo = 0, dEo = 0;
  for (let i = 0; i < 10000; i++) {
    const b = rot({ w: q.w, x: -q.x, y: -q.y, z: -q.z }, w.x, w.y, w.z);
    const gx = b.y * I.z * b.z - b.z * I.y * b.y, gy = b.z * I.x * b.x - b.x * I.z * b.z, gz = b.x * I.y * b.y - b.y * I.x * b.x;
    b.x -= gx / I.x * DT; b.y -= gy / I.y * DT; b.z -= gz / I.z * DT;
    const nw = rot(q, b.x, b.y, b.z); w.x = nw.x; w.y = nw.y; w.z = nw.z;
    const hw = 0.5 * DT;
    const qw = q.w - hw * (w.x * q.x + w.y * q.y + w.z * q.z), qx = q.x + hw * (w.x * q.w + w.y * q.z - w.z * q.y), qy = q.y + hw * (w.y * q.w + w.z * q.x - w.x * q.z), qz = q.z + hw * (w.z * q.w + w.x * q.y - w.y * q.x);
    const l = Math.hypot(qw, qx, qy, qz); q.w = qw / l; q.x = qx / l; q.y = qy / l; q.z = qz / l;
    const L = Lw(q, w); dLo = Math.max(dLo, Math.hypot(L.x - L0.x, L.y - L0.y, L.z - L0.z) / L0m); dEo = Math.max(dEo, Math.abs(Er(q, w) - E0) / E0);
  }
  row('Free tumble, integrator only (ω_body = (1, 6, 2), 10 s)', 'L within 0.1 %, E_rot within 0.5 %', `new: |ΔL| ${pct(dL)}, ΔE_rot ${pct(dE)} · old Euler step: |ΔL| ${pct(dLo)}, ΔE_rot ${pct(dEo)}`, dL < 0.001 && dE < 0.005);
  // (b) the whole vehicle tumbling in free fall (wheels on their springs exchange momentum with the body)
  const u = mk(noGround); u.pos.y = 0; orient(u, 0.3, 0.2, 0.1); const w1 = rot(u.q, 1, 6, 2); u.w.x = w1.x; u.w.y = w1.y; u.w.z = w1.z;
  const Lb0 = Lw(u.q, u.w), Lb0m = Math.hypot(Lb0.x, Lb0.y, Lb0.z); let dLb = 0;
  const audit = new EnergyAudit();
  // in free fall gravity is uniform, so audit the internal energy: rotation + springs + wheel motion relative to the body
  const Eint = (vv: Vehicle) => {
    const e = mechanicalEnergy(vv); let rel = 0; const up = bodyUp(vv);
    for (const wh of vv.wheels) { const rm = rot(vv.q, wh.mount.x, wh.mount.y, wh.mount.z);
      const vmx = vv.vel.x + vv.w.y * rm.z - vv.w.z * rm.y, vmy = vv.vel.y + vv.w.z * rm.x - vv.w.x * rm.z, vmz = vv.vel.z + vv.w.x * rm.y - vv.w.y * rm.x;
      const dv = wh.vw - (vmx * up.x + vmy * up.y + vmz * up.z); rel += 0.5 * (wh.front ? vv.P.unsprungFront.v : vv.P.unsprungRear.v / 2) * dv * dv; }
    return e.rotation + e.elastic + rel;
  };
  const Eint0 = Eint(u); let wEnd = 0;
  for (let i = 0; i < 10000; i++) { u.step(DT); u.vel.x = u.vel.y = u.vel.z = 0; /* tumble in place: no aero */ const L = Lw(u.q, u.w); dLb = Math.max(dLb, Math.hypot(L.x - Lb0.x, L.y - Lb0.y, L.z - Lb0.z) / Lb0m);
    audit.update(Eint(u), i * DT); wEnd = angRate(u); }
  row('Free tumble, whole vehicle (suspension live), 10 s', 'report (body L is shared with the wheels)', `body |ΔL| max ${pct(dLb)}; internal energy (rotation + springs) start ${(Eint0 / 1000).toFixed(2)} kJ, max rise ${pct(audit.maxRise / Eint0)}, end |ω| ${wEnd.toFixed(2)} rad/s (start ${Math.hypot(1, 6, 2).toFixed(2)})`, audit.maxRise / Eint0 < 0.005);
}

// ---------------- 3. fishhook / J-turn ----------------
/** Handwheel angle (deg) for 0.3 g steady state at 80 km/h: slowly increasing steer (13.5°/s), speed held. */
function angle03g(cg: number, jack: boolean) {
  const v = new Vehicle(params(cg, jack), flat()); v.reset(0, 0, 0); v.ignition = true; v.omegaE = 80; v.setSelector('D');
  setSpeed(v, 80 / 3.6); let t = 0, hw = 0;
  for (; t < 60; t += DT) {
    const e = 80 / 3.6 - v.speed; v.input.throttle = Math.max(0, Math.min(1, 0.35 + e * 0.5)); v.input.brake = 0;
    hw = t < 1 ? 0 : (t - 1) * 13.5; v.input.steer = hwToSteer(v, hw); v.step(DT);
    if (t > 1.5 && v.accelBody.x / G >= 0.3) break;
  }
  return hw;
}
interface Man { lift: number; twoWheelLift: boolean; maxRoll: number; rolled: boolean; spin: boolean; energyRise: number; E0: number }
function manoeuvre(kind: 'fishhook' | 'jturn', kmh: number, cg: number, vsc: boolean, A: number, jack = true): Man {
  const v = mk(flat(), cg, jack); v.vscOn = vsc; setSpeed(v, kmh / 3.6);
  // settle 1 s at speed (speed held), then the steering input with throttle off
  for (let i = 0; i < 1000; i++) { v.step(DT); const s = speedOf(v); const k = (kmh / 3.6) / s; v.vel.x *= k; v.vel.z *= k; }
  const rate = 720; // °/s handwheel
  let phase = 0, hw = 0, tPh = 0, t = 0, lift = 0, maxRoll = 0, rolled = false, twl = false; const yaw0 = Math.atan2(bodyFwd(v).x, bodyFwd(v).z);
  v.step(DT); const audit = new EnergyAudit(); const E0 = mechanicalEnergy(v).total; audit.update(E0, 0);
  let spin = false;
  const target = kind === 'fishhook' ? 6.5 * A : 8 * A;
  while (t < 9) {
    tPh += DT;
    if (kind === 'jturn') { hw = Math.min(target, hw + rate * DT); if (t > 4) hw = Math.max(0, hw - rate * DT * 2); }
    else if (phase === 0) { hw = Math.min(target, hw + rate * DT); if (hw >= target) { phase = 1; tPh = 0; } }
    else if (phase === 1) { const rr = Math.abs(v.w.x * bodyFwd(v).x + v.w.y * bodyFwd(v).y + v.w.z * bodyFwd(v).z) / D2R; if ((tPh > 0.05 && rr < 1.5) || tPh > 1.5) { phase = 2; tPh = 0; } }
    else if (phase === 2) { hw = Math.max(-target, hw - rate * DT); if (hw <= -target) { phase = 3; tPh = 0; } }
    else if (phase === 3) { if (tPh > 3) { phase = 4; tPh = 0; } }
    else if (phase === 4) { hw = Math.min(0, hw + rate * DT); }
    v.input.steer = Math.max(-1, Math.min(1, hwToSteer(v, hw)));
    v.step(DT); t += DT;
    audit.update(mechanicalEnergy(v).total, t);
    const cl = v.wheels.map(w => -w.pen);
    const l = Math.max(Math.min(cl[0], cl[2]), Math.min(cl[1], cl[3]));
    if (l > lift) lift = l; if (l >= 0.05) twl = true;
    maxRoll = Math.max(maxRoll, Math.abs(v.rollFull) / D2R); if (Math.abs(v.rollFull) > Math.PI / 2) rolled = true;
    const f = bodyFwd(v), sp = Math.hypot(v.vel.x, v.vel.z);
    if (sp > 3) { const beta = Math.acos(Math.max(-1, Math.min(1, (f.x * v.vel.x + f.z * v.vel.z) / (Math.hypot(f.x, f.z) * sp)))); if (beta > 30 * D2R) spin = true; }
    if (speedOf(v) < 0.5 && t > 2) break;
  }
  void yaw0;
  return { lift, twoWheelLift: twl, maxRoll, rolled, spin, energyRise: audit.maxRise, E0 };
}

// ---------------- 4. slides, kerb, ramp, ditch ----------------
function slide(kmh: number, s: SurfaceKey) {
  const v = mk(flat(s)); setSpeed(v, 0, kmh / 3.6); for (const w of v.wheels) w.omega = 0;
  let maxRoll = 0, rolled = false; const x0 = v.pos.x;
  const r = run(v, 15, () => { maxRoll = Math.max(maxRoll, Math.abs(v.rollFull) / D2R); if (Math.abs(v.rollFull) > Math.PI / 2) rolled = true; });
  noteEnergy(`slide ${kmh} km/h ${s}`, r);
  return { maxRoll, rolled, qt: v.quarterTurns, rest: restState(v), tRest: r.tRest, dist: Math.abs(v.pos.x - x0) };
}
function kerbTrip(kmh: number) {
  const x0 = 0.7725 + 0.1325 + 0.05; // leading tyre shoulder 5 cm from the face
  const v = mk(kerb(x0, 0.15)); setSpeed(v, 0, kmh / 3.6); for (const w of v.wheels) w.omega = 0;
  let maxRoll = 0, rolled = false;
  const r = run(v, 15, () => { maxRoll = Math.max(maxRoll, Math.abs(v.rollFull) / D2R); if (Math.abs(v.rollFull) > Math.PI / 2) rolled = true; });
  noteEnergy(`kerb trip ${kmh} km/h`, r);
  return { maxRoll, rolled, qt: v.quarterTurns, rest: restState(v), tRest: r.tRest, rimCrush: v.hull.maxCrush('tyre') };
}
function rampRoll(kmh: number) {
  const v = mk(ramp(0.25, 1.45, 15, 3.5, 0.6)); setSpeed(v, kmh / 3.6);
  let tTrip = NaN, vTrip = 0, zTrip = 0, maxRoll = 0, air = 0, peakH = 0; const p0 = { ...v.pos };
  const r = run(v, 25, (t) => {
    if (Number.isNaN(tTrip) && v.pos.z + v.a > 15) { tTrip = t; vTrip = speedOf(v); zTrip = v.pos.z; }
    maxRoll = Math.max(maxRoll, Math.abs(v.rollFull) / D2R);
    if (!Number.isNaN(tTrip) && v.wheels.every(w => w.Fz === 0) && !v.hull.contacts) air += DT;
    peakH = Math.max(peakH, v.pos.y);
  });
  const d = Math.hypot(v.pos.x - p0.x, v.pos.z - zTrip);
  noteEnergy(`ramp ${kmh} km/h`, r);
  const tr = r.tRest - tTrip;
  return { rolled: v.rollMaxAbs > Math.PI / 2, qt: v.quarterTurns, rolls: v.fullRolls, rest: restState(v), tRest: tr, decelT: vTrip / tr / G, decelD: vTrip * vTrip / (2 * d) / G, d, air, peakH, crush: v.hull.maxCrush(), roof: Math.max(v.hull.maxCrush('roofRail'), v.hull.maxCrush('roofPanel')) };
}
function ditchRun(kmh: number) {
  const v = mk(ditch(2.2)); setSpeed(v, 0, kmh / 3.6); for (const w of v.wheels) w.omega = 0;
  const r = run(v, 20);
  noteEnergy(`ditch ${kmh} km/h`, r);
  return { qt: v.quarterTurns, rest: restState(v), tRest: r.tRest, x: v.pos.x };
}

// ---------------- 5. world objects (P3): pole, wall, frangible sign, cones ----------------
interface Hit { crush: number; meanG: number; meanGt: number; cDyn: number; peakG: number; dv: number; tPulse: number; rebound: number; restOn: string; dpZone: string; faults: string[]; report?: string; airbags: boolean; cones?: number; broke?: boolean }
/** Drives the car (engine off, N) at kmh straight into whatever is registered ahead, steps until rest. */
function objectRun(kmh: number, lateral = false): Hit & { v: Vehicle } {
  const v = mk(flat()); if (lateral) { setSpeed(v, 0, kmh / 3.6); for (const w of v.wheels) w.omega = 0; } else setSpeed(v, kmh / 3.6);
  const V0 = kmh / 3.6; let tFirst = NaN, tSep = NaN, vMin = Infinity, gPk = 0; const vs: number[] = [], ps: number[] = [];
  const dir = lateral ? bodyLeft(v) : bodyFwd(v);
  const r = run(v, 15, (t) => {
    const along = v.vel.x * dir.x + v.vel.z * dir.z;
    if (Number.isNaN(tFirst) && v.collide.contacts) tFirst = t;
    if (!Number.isNaN(tFirst) && Number.isNaN(tSep)) { vs.push(along); ps.push(v.pos.x * dir.x + v.pos.z * dir.z); if (along < vMin) vMin = along; if (!v.collide.contacts && t - tFirst > 0.02) tSep = t; }
  });
  // mean deceleration over the pulse: from first contact until the velocity along the impact stops falling
  let iMin = 0; for (let i = 0; i < vs.length; i++) if (vs[i] < vs[iMin]) iMin = i;
  const tP = Math.max(1e-3, iMin * DT), dv = V0 - vs[iMin];
  for (let i = 10; i < vs.length; i++) gPk = Math.max(gPk, (vs[i - 10] - vs[i]) / (0.01 * G));
  noteEnergy(`object ${kmh} km/h${lateral ? ' lateral' : ''}`, r);
  const rep = v.recorder.done.at(-1);
  // mean g from the dynamic crush (CG travel from first contact until the closing speed reaches zero): v0^2 / (2 g c)
  let iz = vs.findIndex(x => x <= 0); if (iz < 0) iz = iMin; const cDyn = ps[iz] - ps[0];
  return { v, crush: v.hull.maxCrush(), meanG: V0 * V0 / (2 * G * Math.max(0.01, cDyn)), meanGt: dv / (G * tP), cDyn, peakG: gPk, dv, tPulse: tP, rebound: Math.max(0, -vs[vs.length - 1] || 0), restOn: restState(v),
    dpZone: (['front', 'rear', 'left', 'right', 'roof'] as const).map(z => `${z} ${(v.damage.zone[z] * 100).toFixed(0)}%`).join(' '), faults: v.damage.faults(), airbags: v.damage.airbags,
    report: rep ? rep.rows.map(([a, b]) => `${a}: ${b}`).join(NL) : undefined };
}
function poleTest(kmh: number, offset = 0) {
  colliders.clear(); colliders.addCylinder({ x: offset, z: 2.28 + 1.0 + 0.127, radius: 0.127, height: 8, y0: -0.3, material: 'steel', tag: 'pole' });
  const h = objectRun(kmh);
  row(`Pole, frontal, ${kmh} km/h${offset ? `, ${offset} m off centre` : ''} (Ø 254 mm, rigid)`, 'crush 0.7–1.0 m [M]',
    `crush ${(h.crush * 100).toFixed(0)} cm (dynamic ${(h.cDyn * 100).toFixed(0)} cm), mean ${h.meanG.toFixed(1)} g (v²/2c; ΔV/t ${h.meanGt.toFixed(1)} g over ${(h.tPulse * 1000).toFixed(0)} ms, ΔV ${h.dv.toFixed(1)} m/s), peak 10 ms ${h.peakG.toFixed(1)} g, rebound ${h.rebound.toFixed(2)} m/s; damage ${h.dpZone}; faults: ${h.faults.join(', ') || 'none'}`,
    offset || kmh !== 50 ? null : h.crush >= 0.7 && h.crush <= 1.0);
  return h;
}
function sidePole(kmh: number) {
  colliders.clear(); colliders.addCylinder({ x: 0.9275 + 1.0 + 0.127, z: 0.35, radius: 0.127, height: 8, y0: -0.3, material: 'steel', tag: 'pole' });
  const h = objectRun(kmh, true);
  row(`Side pole at the driver's door line, ${kmh} km/h sideways (Ø 254 mm)`, 'report (UN R135 / Euro NCAP: 32 km/h)', `crush ${(h.crush * 100).toFixed(0)} cm (dynamic ${(h.cDyn * 100).toFixed(0)} cm), mean ${h.meanG.toFixed(1)} g (ΔV/t ${h.meanGt.toFixed(1)} g, ΔV ${h.dv.toFixed(1)} m/s), peak ${h.peakG.toFixed(1)} g; damage ${h.dpZone}; faults: ${h.faults.join(', ') || 'none'}`, null);
}
function wallTest(kmh: number) {
  colliders.clear(); colliders.addBox({ x: 0, z: 2.28 + 1.0 + 0.5, halfX: 4, halfZ: 0.5, yaw: 0, height: 2.5, y0: -0.3, material: 'concrete', tag: 'wall' });
  const h = objectRun(kmh);
  row(`Rigid wall, full frontal, ${kmh} km/h`, 'crush 0.5–0.7 m at 18–25 g mean [M]', `crush ${(h.crush * 100).toFixed(0)} cm (dynamic ${(h.cDyn * 100).toFixed(0)} cm), mean ${h.meanG.toFixed(1)} g (v²/2c; ΔV/t ${h.meanGt.toFixed(1)} g over ${(h.tPulse * 1000).toFixed(0)} ms, ΔV ${h.dv.toFixed(1)} m/s), peak 10 ms ${h.peakG.toFixed(1)} g, rebound ${h.rebound.toFixed(2)} m/s; damage ${h.dpZone}; airbags ${h.airbags ? 'fired' : 'no'}; faults: ${h.faults.join(', ') || 'none'}`,
    kmh === 56 ? h.crush >= 0.5 && h.crush <= 0.7 && h.meanG >= 18 && h.meanG <= 25 : null);
  return h;
}
function signTest(kmh: number) {
  colliders.clear(); const g = 77;
  colliders.addCylinder({ x: 0.3, z: 3.5, radius: 0.04, height: 2.1, y0: -0.3, material: 'steel', breakForce: 12e3, group: g, tag: 'sign' });
  colliders.addBox({ x: 0.3, z: 3.5, halfX: 0.6, halfZ: 0.02, yaw: 0, height: 0.6, y0: 1.5, material: 'steel', breakForce: 12e3, group: g, tag: 'sign' });
  for (let k = 0; k < 3; k++) colliders.addProp({ x: -0.5 + k * 0.5, z: 8 + k, kind: 'cone', radius: 0.17, height: 0.7, mass: 4, tag: 'cone' });
  const v = mk(flat()); setSpeed(v, kmh / 3.6); let broke = false;
  const off = colliders.onBreak(() => { broke = true; });
  const r = run(v, 4); off();
  noteEnergy(`sign + cones ${kmh} km/h`, r);
  row(`Frangible sign post (12 kN) then 3 cones, ${kmh} km/h`, 'post breaks, car barely slows, no crush', `broke ${broke ? 'yes' : 'NO'}, speed after ${(speedOf(v) * 3.6).toFixed(1)} km/h, crush ${(v.hull.maxCrush() * 1000).toFixed(0)} mm, cones knocked ${v.collide.propsHit + (v.recorder.done.at(-1)?.data.cones as number ?? 0)}`, broke && v.hull.maxCrush() < 0.01);
}

// ================= run =================
const t0 = performance.now();
if (process.argv.includes('objects')) {
  for (const k of [50, 64]) poleTest(k); poleTest(50, 0.5); sidePole(32); for (const k of [40, 56]) wallTest(k); signTest(50);
  colliders.clear();
  console.log('| Test | Expected | Result | Pass |' + NL + '|---|---|---|---|'); for (const r of rows) console.log(`| ${r.join(' | ')} |`);
  console.log(NL + '| Test | E start kJ | max rise J | at t s | rise / start | ≤ 0.5 % |' + NL + '|---|---|---|---|---|---|');
  for (const [n, e0, rise, f, tr] of energyRows) console.log(`| ${n} | ${(e0 / 1000).toFixed(1)} | ${rise.toFixed(1)} | ${tr.toFixed(2)} | ${pct(f)} | ${f <= 0.005 ? 'PASS' : 'FAIL'} |`);
  crashUs.sort((a, b) => a - b);
  if (crashUs.length) console.log(NL + `Physics cost in contact: median ${crashUs[crashUs.length >> 1].toFixed(1)} µs/step, 90th pct ${crashUs[Math.floor(crashUs.length * 0.9)].toFixed(1)} µs/step`);
  if (process.argv.includes('report')) { rows.length = 0; const v = poleTest(50).v; console.log(NL + (v.recorder.done.at(-1)?.rows.map(([a, b]) => `| ${a} | ${b} |`).join(NL))); }
  process.exit(0);
}
dropWheels(0.5); dropWheels(1.0); dropRoof(0.5); dropCorner(); tumble();

for (const kmh of [54, 72, 90]) for (const s of ['asphalt', 'grass', 'sand', 'mud'] as SurfaceKey[]) {
  const r = slide(kmh, s);
  const exp = s === 'asphalt' ? 'no roll' : (s === 'sand' || s === 'mud') ? 'trips (> 40 km/h)' : 'report';
  const pass = s === 'asphalt' ? !r.rolled : (s === 'sand' || s === 'mud') ? r.rolled : null;
  row(`Sideways slide ${kmh} km/h (${(kmh / 3.6).toFixed(0)} m/s) on ${s}`, exp, `max roll ${r.maxRoll.toFixed(0)}°, quarter turns ${r.qt}, rest ${r.tRest.toFixed(1)} s on ${r.rest}, slid ${r.dist.toFixed(1)} m`, pass);
}
for (const kmh of [10, 25, 40]) {
  const r = kerbTrip(kmh);
  const exp = kmh === 10 ? 'no roll' : kmh === 40 ? '≥ 1 quarter turn' : 'either (report)';
  const pass = kmh === 10 ? !r.rolled : kmh === 40 ? r.qt >= 1 : null;
  row(`Kerb trip 150 mm, ${kmh} km/h sideways`, exp, `max roll ${r.maxRoll.toFixed(0)}°, quarter turns ${r.qt}, rest ${r.tRest.toFixed(1)} s on ${r.rest}, sidewall/rim crush ${(r.rimCrush * 1000).toFixed(0)} mm`, pass);
}
for (const kmh of [60, 80]) {
  const r = rampRoll(kmh);
  row(`Ramp roll, one-side 0.6 m ramp (3.5 m long), ${kmh} km/h`, 'rolls, rest ≤ 15 s; mean decel vs 0.36–0.61 g',
    `quarter turns ${r.qt} (full rolls ${r.rolls}), rest ${r.tRest.toFixed(1)} s after the ramp on ${r.rest}, ${r.d.toFixed(0)} m; mean decel ${r.decelT.toFixed(2)} g (time) / ${r.decelD.toFixed(2)} g (distance); airborne ${r.air.toFixed(2)} s, peak CG ${r.peakH.toFixed(2)} m; crush max ${(r.crush * 100).toFixed(1)} cm, roof ${(r.roof * 100).toFixed(1)} cm`,
    r.rolled && r.tRest <= 15);
}
for (const kmh of [30, 50]) { const r = ditchRun(kmh); row(`Ditch: sideways off the road into a 0.6 m ditch (grass), ${kmh} km/h`, 'report', `quarter turns ${r.qt}, rest ${r.tRest.toFixed(1)} s on ${r.rest}, x ${r.x.toFixed(1)} m`, null); }

// ---- handbrake spin at 90 km/h in M4 (user-reported stall), then full throttle ----
const spinRows: string[] = [];
{
  const v = new Vehicle(params(), flat()); v.reset(0, 0, 0); v.ignition = true; v.omegaE = 80; v.setSelector('D'); v.input.throttle = 1;
  while (v.kmh < 90) v.step(DT);
  v.input.throttle = 0.3; v.shiftManual(0); for (let i = 0; i < 400; i++) v.step(DT);
  while (v.manualGear > 4) { v.shiftManual(-1); for (let i = 0; i < 500; i++) v.step(DT); }
  let t = 0, minRpm = 1e9, stalled = false, tStop = NaN, tFwd = NaN; const sel0 = v.selector + v.gear;
  for (let i = 0; i <= 9000; i++) {
    if (t < 2) { v.input.throttle = 0; v.input.handbrake = 1; v.input.steer = 1; } else { v.input.handbrake = 0; v.input.steer = 0; v.input.throttle = 1; }
    const f = bodyFwd(v), l = bodyLeft(v), vl = v.vel.x * f.x + v.vel.z * f.z, vs = v.vel.x * l.x + v.vel.z * l.z;
    if (i % 500 === 0) spinRows.push(`| ${t.toFixed(1)} | ${t < 2 ? 'handbrake + full lock' : 'full throttle, straight'} | ${(vl * 3.6).toFixed(1)} | ${v.rpm.toFixed(0)} | ${v.selector}${v.gear} | ${v.lockup ? 'on' : 'off'} | ${v.wheels.map(w => (w.omega * v.R * 3.6).toFixed(0)).join(' / ')} | ${v.wheels.map(w => (-w.vLong * 3.6).toFixed(0)).join(' / ')} | ${(Math.atan2(vs, vl) / D2R).toFixed(0)} |`);
    if (t > 0.2) minRpm = Math.min(minRpm, v.rpm); if (v.stalled) stalled = true;
    if (t > 2 && Number.isNaN(tStop) && vl > -0.1) tStop = t; if (t > 2 && Number.isNaN(tFwd) && vl > 5) tFwd = t;
    v.step(DT); t += DT;
  }
  row(`Handbrake spin, 90 km/h in ${sel0}, 2 s handbrake + full lock, then full throttle`, 'engine keeps running; stops sliding back and drives off forwards',
    `min rpm after 0.2 s: ${minRpm.toFixed(0)}, stalled: ${stalled ? 'YES' : 'no'}; backward motion ended at ${tStop.toFixed(2)} s, 18 km/h forwards at ${tFwd.toFixed(2)} s`, !stalled && !Number.isNaN(tFwd));
  const u = new Vehicle(params(), flat()); u.reset(0, 0, 0); u.ignition = true; u.omegaE = 80; u.setSelector('D'); u.input.brake = 1;
  for (let i = 0; i < 1500; i++) u.step(DT);
  u.lockupOverride = true; let tSt = NaN; for (let i = 0; i < 2000; i++) { u.step(DT); if (u.stalled && Number.isNaN(tSt)) tSt = i * DT; }
  row('Lock-up forced on at a dead stop (D, foot brake)', 'engine stalls', u.stalled ? `stalled after ${tSt.toFixed(2)} s` : 'did not stall', u.stalled);
  const w2 = new Vehicle(params(), flat()); w2.reset(0, 0, 0); w2.ignition = true; w2.omegaE = 80; w2.setSelector('D'); w2.input.throttle = 1;
  while (w2.kmh < 90) w2.step(DT);
  w2.input.throttle = 0; w2.input.brake = 1; while (w2.speed > 0.05) w2.step(DT); for (let i = 0; i < 2000; i++) w2.step(DT);
  for (const sel of ['P', 'N'] as const) for (const restart of [false, true]) {
    const c = new Vehicle(params(), flat()); c.reset(0, 0, 0); c.setSelector(sel);
    if (restart) { c.ignition = true; c.omegaE = 80; for (let i = 0; i < 2000; i++) c.step(DT); c.stopEngine(); for (let i = 0; i < 3000; i++) c.step(DT); }
    c.startEngine(); let tIdle = NaN, minAfter = 1e9;
    for (let i = 1; i <= 3000; i++) { c.step(DT); if (Number.isNaN(tIdle) && i > 900 && Math.abs(c.rpm - 750) < 60) tIdle = i * DT; if (!Number.isNaN(tIdle)) minAfter = Math.min(minAfter, c.rpm); }
    row(`Crank → idle in ${sel} (${restart ? 'restart after stop' : 'first start'})`, 'stable idle (750 ± 60 rpm) within 1.5 s', `idle at ${tIdle.toFixed(2)} s, then ≥ ${minAfter.toFixed(0)} rpm, at 3 s ${c.rpm.toFixed(0)} rpm, stalled ${c.stalled ? 'YES' : 'no'}`, tIdle <= 1.5 && !c.stalled && minAfter > 690);
  }
  row('Panic stop 90–0 in D, then 2 s held', 'engine idles', `${w2.stalled ? 'STALLED' : 'running'} at ${w2.rpm.toFixed(0)} rpm`, !w2.stalled && w2.rpm > 600);
}

// fishhook / J-turn matrix
const cgs = QUICK ? [CG0] : [CG0, 0.72, 0.80];
const fhSpeeds = [56, 64, 72, 76, 80], jtSpeeds = [56, 64, 72, 80, 88, 97];
const matrix: string[] = []; let fhRise = 0, fhE0 = 1;
for (const [kind, speeds] of [['fishhook', fhSpeeds], ['jturn', jtSpeeds]] as ['fishhook' | 'jturn', number[]][]) {
  for (const cg of cgs) for (const jack of cg === CG0 ? [true, false] : [true]) {
    const A = angle03g(cg, jack);
    for (const vsc of [true, false]) {
      const cells = speeds.map(kmh => {
        const m = manoeuvre(kind, kmh, cg, vsc, A, jack);
        if (m.energyRise / m.E0 > fhRise / fhE0) { fhRise = m.energyRise; fhE0 = m.E0; }
        return `${(m.lift * 1000).toFixed(0)}${m.twoWheelLift ? ' 2WL' : ''}${m.rolled ? ' ROLL' : ''}${m.spin ? ' spin' : ''} (${m.maxRoll.toFixed(0)}°)`;
      });
      matrix.push(`| ${kind} | ${cg.toFixed(2)} | ${jack ? 'on' : 'OFF'} | ${A.toFixed(0)}° → ${(kind === 'fishhook' ? 6.5 * A : 8 * A).toFixed(0)}° | ${vsc ? 'on' : 'off'} | ${cells.join(' | ')} |`);
    }
  }
}
energyRows.push(['fishhook/J-turn (worst)', fhE0, fhRise, fhRise / fhE0, NaN]);

console.log('\n## Crash tests\n');
console.log('| Test | Expected | Result | Pass |\n|---|---|---|---|');
for (const r of rows) console.log(`| ${r.join(' | ')} |`);
console.log('\n## Handbrake spin timeline (speed along the car, + = forwards; wheels FL / FR / RL / RR)\n');
console.log('| t s | input | v along car km/h | rpm | gear | lock-up | wheel surface speed ωR km/h | slip vs ground ωR − v km/h | sideslip ° |\n|---|---|---|---|---|---|---|---|---|');
for (const r of spinRows) console.log(r);
console.log('\n## Fishhook / J-turn: largest same-side two-wheel lift (mm), 2WL = both wheels ≥ 50 mm, (max roll)\n');
console.log(`| Test | CG m | Fix A | 0.3 g angle → input | VSC | ${fhSpeeds.map(s => s + ' km/h').join(' | ')} |\n|---|---|---|---|---|${fhSpeeds.map(() => '---').join('|')}|`);
for (const m of matrix.filter(m => m.startsWith('| fishhook'))) console.log(m);
console.log(`\n| Test | CG m | Fix A | 0.3 g angle → input | VSC | ${jtSpeeds.map(s => s + ' km/h').join(' | ')} |\n|---|---|---|---|---|${jtSpeeds.map(() => '---').join('|')}|`);
for (const m of matrix.filter(m => m.startsWith('| jturn'))) console.log(m);
console.log('\n## Energy audit (engine off): largest rise above the running minimum\n');
console.log('| Test | E start kJ | max rise J | at t s | rise / start | ≤ 0.5 % |\n|---|---|---|---|---|---|');
for (const [n, e0, rise, f, tr] of energyRows) console.log(`| ${n} | ${(e0 / 1000).toFixed(1)} | ${rise.toFixed(1)} | ${tr.toFixed(2)} | ${pct(f)} | ${f <= 0.005 ? 'PASS' : 'FAIL'} |`);
crashUs.sort((a, b) => a - b);
if (crashUs.length) console.log(`\nPhysics cost while the hull is in ground contact: median ${crashUs[crashUs.length >> 1].toFixed(1)} µs/step, 90th pct ${crashUs[Math.floor(crashUs.length * 0.9)].toFixed(1)} µs/step (${crashUs.length} chunks of 250 steps)`);
console.log(`\ntotal ${((performance.now() - t0) / 1000).toFixed(1)} s`);
