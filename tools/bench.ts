import { Vehicle } from '../src/physics/vehicle';
import { heightAt } from '../src/world/terrain';
const v = new Vehicle(); v.reset(36 + 5.8, -10, 0); v.ignition = true; v.omegaE = 80; v.setSelector('D');
v.input.throttle = 0.6;
for (let i = 0; i < 2000; i++) v.step(0.001);
const N = 20000; const t0 = performance.now();
for (let i = 0; i < N; i++) { v.input.steer = Math.sin(i / 3000) * 0.2; v.step(0.001); }
const ms = performance.now() - t0;
console.log(`physics: ${(ms / N * 1000).toFixed(1)} us/step -> ${(ms / N * 1000).toFixed(2)} ms per simulated second... per 60fps frame (16.7 steps): ${(ms / N * 16.7).toFixed(2)} ms`);
// per teleport spot: µs per physics step (median of 3 runs, 10 s at 30 % throttle, light weave) and heightAt ns near the car
const spots: [string, number, number][] = [['5 runway', 3.5, -40], ['6 Indian strip', 39.8, -10], ['7 speed breakers', 39.8, 420], ['8 off-road', 124, 4], ['9 pad', -260, 280],
  ['4 new road (SH)', 421.75, 30], ['district potholes', 421.4, 600], ['village', 421.75, 1100]];
for (const [name, x, z] of spots) {
  if (Number.isNaN(heightAt(x, z))) continue;
  const runs: number[] = [];
  for (let r = 0; r < 3; r++) {
    const u = new Vehicle(); u.reset(x, z, 0); u.ignition = true; u.omegaE = 80; u.setSelector('D'); u.input.throttle = 0.3;
    for (let i = 0; i < 1000; i++) u.step(0.001);
    const M = 10000, a = performance.now();
    for (let i = 0; i < M; i++) { u.input.steer = Math.sin(i / 2500) * 0.05; u.step(0.001); }
    runs.push((performance.now() - a) / M * 1000);
  }
  runs.sort((p, q) => p - q);
  let s = 0; const K = 200000, b = performance.now();
  for (let i = 0; i < K; i++) s += heightAt(x + (i % 37) * 0.05, z + (i % 101) * 0.1);
  const ns = (performance.now() - b) / K * 1e6;
  console.log(`spot ${name.padEnd(18)} ${runs[1].toFixed(1)} us/step  heightAt ${ns.toFixed(0)} ns${s === 1e99 ? '' : ''}`);
}
// ---- Stage 2: world colliders. Normal driving through the village with its 278 colliders registered, and two crashes ----
{
  const { colliders } = await import('../src/world/colliders');
  const { ROADSIDE_COLLIDERS } = await import('../src/world/roadsideColliders');
  const med = (f: () => number) => { const r = [f(), f(), f()].sort((a, b) => a - b); return r[1]; };
  // straight down the village street's left lane (the weave above would drift into an LT pole once they are solid)
  const village = (stub: boolean) => {
    const u = new Vehicle(); u.reset(421.75, 1060, 0); u.ignition = true; u.omegaE = 80; u.setSelector('D'); u.input.throttle = 0.3;
    if (stub) { (u.collide as any).step = () => {}; (u.damage as any).update = () => null; (u.recorder as any).update = () => {}; }
    for (let i = 0; i < 1000; i++) u.step(0.001);
    const M = 10000, a = performance.now(); let near = 0;
    for (let i = 0; i < M; i++) { u.step(0.001); near += u.collide.nNear; }
    if (!stub) { nearAvg = near / M; hits = u.collide.struck.size + u.recorder.done.length; }
    return (performance.now() - a) / M * 1000;
  };
  let nearAvg = 0, hits = 0;
  const ab = (label: string) => { const A: number[] = [], B: number[] = []; for (let r = 0; r < 5; r++) { A.push(village(true)); B.push(village(false)); } A.sort((p, q) => p - q); B.sort((p, q) => p - q);
    console.log(`${label}: Stage 2 off ${A[2].toFixed(2)} us/step, on ${B[2].toFixed(2)} us/step (+${(B[2] - A[2]).toFixed(2)}), near list avg ${nearAvg.toFixed(2)}, objects hit ${hits}`); };
  ab('village street, no colliders registered');
  for (const c of ROADSIDE_COLLIDERS) c.kind === 'box' ? colliders.addBox({ x: c.cx, z: c.cz, halfX: c.halfX, halfZ: c.halfZ, yaw: c.yaw, height: c.height, y0: c.y0, material: c.material, tag: c.tag })
    : colliders.addCylinder({ x: c.cx, z: c.cz, radius: c.radius, height: c.height, y0: c.y0, material: c.material, tag: c.tag });
  ab(`village street, ${colliders.size} roadside colliders`);
  // lamp posts every 30 m and a 60 m wall, ~2 m beside the car: the near list is never empty
  colliders.clear();
  for (let z = 1000; z < 1300; z += 30) colliders.addCylinder({ x: 421.75 - 3.0, z, radius: 0.075, height: 8, material: 'steel', tag: 'lamp' });
  colliders.addBox({ x: 421.75 + 3.2, z: 1150, halfX: 0.15, halfZ: 60, yaw: 0, height: 2, material: 'masonry', tag: 'wall' });
  ab('village street, posts 2 m + wall 2 m beside the car (always in the near list)');
  // crash cost: in-contact steps only, after a warm-up run
  const crash = (setup: (u: Vehicle) => void, steps: number) => {
    const u = new Vehicle(); setup(u); let t = 0, n = 0;
    for (let i = 0; i < steps; i++) { const a = performance.now(); u.step(0.001); const b = performance.now(); if (u.hull.contacts || u.collide.contacts) { t += b - a; n++; } }
    return n ? t / n * 1000 : NaN;
  };
  const pole = (u: Vehicle) => { colliders.clear(); colliders.addCylinder({ x: -680, z: 200, radius: 0.127, height: 6, material: 'steel' }); u.reset(-680, 200 - 0.127 - 2.28 - 0.5, 0); u.setSelector('N'); u.vel.z = 50 / 3.6; for (const w of u.wheels) w.omega = 50 / 3.6 / u.R; };
  const wall = (u: Vehicle) => { colliders.clear(); colliders.addBox({ x: -670, z: 285, halfX: 8, halfZ: 0.5, yaw: 0, height: 1.8, material: 'concrete' }); u.reset(-670, 284.5 - 2.28 - 0.5, 0); u.setSelector('N'); u.vel.z = 56 / 3.6; for (const w of u.wheels) w.omega = 56 / 3.6 / u.R; };
  const roof = (u: Vehicle) => { colliders.clear(); u.reset(-600, 150, 0); u.q.w = 0; u.q.z = 1; u.pos.y += 0.45; u.setSelector('N'); u.vel.z = 40 / 3.6; };
  for (const [name, f, n] of [['pole 50 km/h', pole, 800], ['wall 56 km/h', wall, 800], ['on its roof, sliding from 40 km/h', roof, 3000]] as [string, (u: Vehicle) => void, number][]) {
    crash(f, n); crash(f, n); const us = med(() => crash(f, n));
    console.log(`crash: ${name.padEnd(34)} ${us.toFixed(1)} us/step in contact`);
  }
  colliders.clear();
}
