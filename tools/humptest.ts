import { Vehicle } from '../src/physics/vehicle';
import { TestRunner } from '../src/ui/tests';
const v = new Vehicle(); const tr = new TestRunner();
for (const [id, sp] of [['SB-01', 20], ['SB-01', 40], ['SB-08', 30], ['SB-39', 30], ['SB-X1', 25], ['SB-X1', 45]] as [string, number][]) {
  tr.humpId = id; tr.humpSpeed = sp; tr.start('hump', v);
  let n = 0; while (tr.active && n < 120000) { const inp = tr.update(1/1000, v); Object.assign(v.input, inp); v.step(1/1000); n++; }
  console.log(id, sp + ' km/h', tr.result ? tr.result.rows.slice(2).map(r => r[0].split(' ').slice(0,3).join(' ') + '=' + r[1]).join(' | ') : 'NO RESULT after ' + n);
}
