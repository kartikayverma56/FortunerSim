import { Vehicle } from '../src/physics/vehicle';
const v = new Vehicle(); v.reset(36 + 5.8, -10, 0); v.ignition = true; v.omegaE = 80; v.setSelector('D');
v.input.throttle = 0.6;
for (let i = 0; i < 2000; i++) v.step(0.001);
const N = 20000; const t0 = performance.now();
for (let i = 0; i < N; i++) { v.input.steer = Math.sin(i / 3000) * 0.2; v.step(0.001); }
const ms = performance.now() - t0;
console.log(`physics: ${(ms / N * 1000).toFixed(1)} us/step -> ${(ms / N * 1000).toFixed(2)} ms per simulated second... per 60fps frame (16.7 steps): ${(ms / N * 16.7).toFixed(2)} ms`);
