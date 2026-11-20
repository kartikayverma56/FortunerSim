// IRI check of the new road (phase 1). For each class section: the quarter-car IRI (ASTM E1926 golden car)
// of the roughness table along the four wheel paths (pass = mean within ±10 % of the target), and, for
// information, the IRI of the full surface heightAt() along the same paths (adds the vertical profile, potholes,
// patches, manholes, trench cuts and humps), per section and per 100 m. Also the steepest 10 m grade.
import { heightAt } from '../src/world/terrain';
import { MAIN, LINK, CLASSES, type Road } from '../src/world/roads';
import { iri } from '../src/world/roughness';

const dx = 0.05;
let fails = 0;
for (const r of [MAIN, LINK] as Road[]) {
  for (const sec of r.sections) {
    const c = CLASSES[sec.cls]; if (!c.iri) continue;
    const a = Math.max(sec.s0, r.sMin) + 15, b = Math.min(sec.s1, r.sMax) - 15;
    const lc = c.hw / 2, paths = [lc - 0.77, lc + 0.77, -(lc - 0.77), -(lc + 0.77)];
    const A = r.field((a + b) / 2, 13);
    const tab = paths.map(d => iri(i => A * r.unitRough(a + i * dx, d), dx, 0, Math.round((b - a) / dx)));
    const full = paths.map(d => iri(i => heightAt(r.toX(a + i * dx, d), r.toZ(a + i * dx, d)), dx, 0, Math.round((b - a) / dx)));
    const mt = tab.reduce((p, q) => p + q) / 4, mf = full.reduce((p, q) => p + q) / 4;
    const ok = Math.abs(mt / c.iri - 1) <= 0.1; if (!ok) fails++;
    console.log(`${r.name.padEnd(4)} ${sec.cls.padEnd(8)} s ${a}–${b}  target ${c.iri.toFixed(1)}  table IRI ${mt.toFixed(2)} (paths ${tab.map(x => x.toFixed(2)).join('/')}) ${ok ? 'PASS' : 'FAIL'}  |  full surface ${mf.toFixed(2)} (paths ${full.map(x => x.toFixed(2)).join('/')})`);
    if (r === MAIN) {
      const per: string[] = [];
      for (let s = a; s + 100 <= b + 1e-6; s += 100) per.push(iri(i => A * r.unitRough(s + i * dx, lc + 0.77), dx, 0, 2000).toFixed(2) + '/' + iri(i => heightAt(r.toX(s + i * dx, lc + 0.77), r.toZ(s + i * dx, lc + 0.77)), dx, 0, 2000).toFixed(1));
      console.log(`      per 100 m, left lane left wheel path (table/full): ${per.join('  ')}`);
    }
  }
  let g = 0, gs = 0; for (let s = r.sMin + 10; s <= r.sMax; s += 1) { const q = (r.field(s, 0) - r.field(s - 10, 0)) / 10; if (Math.abs(q) > Math.abs(g)) { g = q; gs = s; } }
  console.log(`${r.name} steepest 10 m grade ${(g * 100).toFixed(2)} % at s ${gs}`);
}
console.log(fails ? `${fails} section(s) outside ±10 %` : 'all sections within ±10 % of target IRI');
