// New-road ride checks (phase 1), headless: contextual humps on the village entry, the reference pothole at
// 20/40/60 km/h, and the ride test (RMS seat acceleration, bump-stop events) per road class at 40/60/80 km/h.
import { Vehicle } from '../src/physics/vehicle';
import { TestRunner, type RideClass } from '../src/ui/tests';

const run = (tr: TestRunner, kind: 'hump' | 'pothole' | 'ride') => {
  const v = new Vehicle(); tr.start(kind, v);
  let n = 0; while (tr.active && n < 400000) { const inp = tr.update(1 / 1000, v); Object.assign(v.input, inp); v.step(1 / 1000); n++; }
  return tr.result ? tr.result.rows : [['NO RESULT', String(n)]] as [string, string][];
};
const short = (rows: [string, string][], from: number) => rows.slice(from).map(r => r[0].split(' ').slice(0, 3).join(' ') + '=' + r[1].replace(/ \(.*\)$/, '')).join(' | ');
const tr = new TestRunner();
for (const [id, sp] of [['RS-V', 40], ['VH-1', 15], ['VH-1', 30], ['VH-2', 15], ['VH-2', 30], ['VH-3', 20], ['VH-4', 20]] as [string, number][]) {
  tr.humpId = id; tr.humpSpeed = sp; console.log(id.padEnd(5), String(sp).padStart(2), 'km/h', short(run(tr, 'hump'), 2));
}
for (const sp of [20, 40, 60]) { tr.potholeSpeed = sp; console.log('pothole', String(sp).padStart(2), 'km/h', short(run(tr, 'pothole'), 2)); }
const rms: Record<string, number[]> = {};
for (const c of ['sh', 'district', 'village'] as RideClass[]) for (const sp of [40, 60, 80]) {
  tr.rideClass = c; tr.rideSpeed = sp; const rows = run(tr, 'ride');
  console.log('ride', c.padEnd(8), sp, 'km/h', short(rows, 2));
  const m = rows.find(r => r[0].startsWith('RMS')); (rms[sp] ??= []).push(m ? parseFloat(m[1]) : NaN);
}
for (const [sp, v] of Object.entries(rms)) console.log(`RMS seat accel at ${sp} km/h  SH ${v[0].toFixed(2)}  district ${v[1].toFixed(2)}  village ${v[2].toFixed(2)} m/s²  -> ${v[0] < v[1] && v[1] < v[2] ? 'rises with IRI' : 'NOT monotonic with IRI'}`);
