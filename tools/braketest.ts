// Road-test baselines through the in-app TestRunner: 0–100 (acc) and 80–0 (brake), exactly as the T panel runs them.
// Measured references: 0–100 9.79–11.2 s; 80–0 28.08 m; 100–0 45.23 m (simtest prints 100–0).
import { Vehicle } from '../src/physics/vehicle';
import { TestRunner } from '../src/ui/tests';
for (const kind of ['acc', 'brake'] as const) {
  const v = new Vehicle(); const tr = new TestRunner();
  tr.start(kind, v);
  let n = 0; while (tr.active && n < 120000) { const inp = tr.update(1 / 1000, v); if (inp) Object.assign(v.input, inp); v.step(1 / 1000); n++; }
  console.log(kind, tr.result ? tr.result.rows.map(r => r[0] + '=' + r[1]).join(' | ') : 'NO RESULT after ' + n);
}
