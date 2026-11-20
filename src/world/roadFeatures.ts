// Discrete road features in road coordinates (s along the road, d across it, + = left): potholes, patches,
// manholes, trench cuts, humps and rumble sets. DOM-free. Heights are exact functions sampled by the physics;
// the mesh adds sample lines at each feature (meshLines) so the drawn road matches them.
// Dimensions marked [A] are assumptions to tune; the plan's sources are in research/PLAN_indian_roads.md.
import { mulberry, smooth } from './noise';

export type FeatureKind = 'pothole' | 'patch' | 'manhole' | 'trench' | 'hump' | 'rumble';
export type FeatureSurface = 'broken' | 'asphalt' | 'concrete' | 'rumble';
export interface RoadFeature {
  kind: FeatureKind;
  s0: number; s1: number; d0: number; d1: number; // bounding box (road coordinates, m)
  cs: number; cd: number;                         // centre
  rs: number; rd: number;                         // pothole semi-axes / manhole radius (rs)
  depth: number;                                  // + raises, − sinks (m)
  ramp: number;                                   // edge ramp (m)
  prof?: (u: number) => number;                   // hump: height along s from s0
  surface?: FeatureSurface;
  id?: string; name?: string; source?: string;    // humps listed in the hump test
  tint: number;                                   // vertex colour multiplier key (see roadMesh.ts)
}

/** Circular-arc hump from its chord and height (measured Indian humps are given that way). */
export function chordHump(chord: number, h: number) {
  const R = (chord * chord / 4 + h * h) / (2 * h), half = chord / 2;
  return { R, len: chord, fn: (u: number) => { const x = u - half; return Math.abs(x) >= half ? 0 : Math.sqrt(R * R - x * x) - (R - h); } };
}

export function featureHeight(f: RoadFeature, s: number, d: number): number {
  switch (f.kind) {
    case 'pothole': {
      const u = (s - f.cs) / f.rs, v = (d - f.cd) / f.rd, t2 = u * u + v * v;
      if (t2 >= 1) return 0;
      const t = Math.sqrt(t2);
      return f.depth * (t < 0.5 ? 1 : 1 - smooth(0.5, 1, t)); // flat floor, steep (but finite) wall over the outer half radius
    }
    case 'patch': case 'trench': {
      const e = Math.min(s - f.s0, f.s1 - s, d - f.d0, f.d1 - d) / f.ramp;
      return f.depth * smooth(0, 1, e);
    }
    case 'manhole': {
      const ds = s - f.cs, dd = d - f.cd, r = Math.sqrt(ds * ds + dd * dd);
      if (f.depth < 0) return r >= f.rs ? 0 : f.depth * (1 - smooth(f.rs - f.ramp, f.rs, r));   // sunk cover, short rim
      if (r <= f.rs) return f.depth;                                                            // raised frame
      return r >= f.rs + f.ramp ? 0 : f.depth * (1 - (r - f.rs) / f.ramp);                      // patched-up asphalt ring around it
    }
    case 'hump': case 'rumble': {
      const taper = smooth(f.d0, f.d0 + 0.3, d) * (1 - smooth(f.d1 - 0.3, f.d1, d));
      return f.prof!(s - f.s0) * taper;
    }
  }
}

/** Mesh sample-line ranges [a, b, step] in s and in d needed to draw a feature within ~10 mm. */
export function meshLines(f: RoadFeature): { s: [number, number, number][]; d: [number, number, number][] } {
  switch (f.kind) {
    case 'pothole': return { s: [[f.s0, f.s1, 0.03]], d: [[f.d0, f.d1, 0.03]] };
    case 'manhole': return { s: [[f.s0, f.s1, 0.02]], d: [[f.d0, f.d1, 0.02]] };
    case 'patch': case 'trench': {
      const r = f.ramp, st = r / 4;
      return { s: [[f.s0, f.s0 + r, st], [f.s0 + r, f.s1 - r, Math.min(0.25, (f.s1 - f.s0 - 2 * r) / 2)], [f.s1 - r, f.s1, st]], d: [[f.d0, f.d0 + r, st], [f.d1 - r, f.d1, st]] };
    }
    case 'hump': return { s: [[f.s0, f.s1, 0.04]], d: [[f.d0, f.d0 + 0.3, 0.05], [f.d1 - 0.3, f.d1, 0.05]] };
    case 'rumble': return { s: [[f.s0, f.s1, 0.02]], d: [[f.d0, f.d0 + 0.3, 0.05], [f.d1 - 0.3, f.d1, 0.05]] };
  }
}

/** s-cell index (4 m cells) so a query looks at a handful of features. */
export class FeatureIndex {
  static CELL = 4;
  private cells: RoadFeature[][] = [];
  constructor(public list: RoadFeature[], private sMin: number, sMax: number) {
    const n = Math.ceil((sMax - sMin) / FeatureIndex.CELL) + 1;
    for (let i = 0; i < n; i++) this.cells.push([]);
    for (const f of list) for (let i = Math.max(0, this.cell(f.s0)); i <= Math.min(n - 1, this.cell(f.s1)); i++) this.cells[i].push(f);
  }
  private cell(s: number) { return Math.floor((s - this.sMin) / FeatureIndex.CELL); }
  at(s: number): RoadFeature[] { return this.cells[this.cell(s)] ?? EMPTY; }
  /** Sum of patches/manholes/trenches/humps plus the deepest pothole (overlapping potholes do not add up). */
  height(s: number, d: number): number {
    const c = this.cells[this.cell(s)]; if (!c || c.length === 0) return 0;
    let add = 0, hole = 0;
    for (let k = 0; k < c.length; k++) {
      const f = c[k];
      if (s <= f.s0 || s >= f.s1 || d <= f.d0 || d >= f.d1) continue;
      const v = featureHeight(f, s, d);
      if (f.kind === 'pothole') { if (v < hole) hole = v; } else add += v;
    }
    return add + hole;
  }
  /** Feature on top at (s, d), for surface and colour: pothole > manhole > trench > rumble > patch. */
  top(s: number, d: number): RoadFeature | null {
    const c = this.cells[this.cell(s)]; if (!c) return null;
    let best: RoadFeature | null = null, rank = -1;
    for (const f of c) {
      if (s <= f.s0 || s >= f.s1 || d <= f.d0 || d >= f.d1) continue;
      if (f.kind === 'pothole' || f.kind === 'manhole') {
        const u = (s - f.cs) / f.rs, v = (d - f.cd) / (f.kind === 'pothole' ? f.rd : f.rs);
        if (u * u + v * v >= 1) continue;
      }
      const r = RANK[f.kind]; if (r > rank) { rank = r; best = f; }
    }
    return best;
  }
}
const EMPTY: RoadFeature[] = [];
const RANK: Record<FeatureKind, number> = { pothole: 5, manhole: 4, trench: 3, rumble: 2, patch: 1, hump: 0 };

// ---------------- generators ----------------
const box = (f: Omit<RoadFeature, 's0' | 's1' | 'd0' | 'd1'> & Partial<RoadFeature>): RoadFeature => f as RoadFeature;

export function pothole(cs: number, cd: number, dia: number, depth: number, aspect = 1): RoadFeature {
  const rs = dia / 2 * aspect, rd = dia / 2 / aspect;
  return box({ kind: 'pothole', cs, cd, rs, rd, depth: -depth, ramp: 0, s0: cs - rs, s1: cs + rs, d0: cd - rd, d1: cd + rd, surface: 'broken', tint: 1 });
}
export function patch(s0: number, len: number, d0: number, w: number, off: number, fresh: boolean): RoadFeature {
  return box({ kind: 'patch', cs: s0 + len / 2, cd: d0 + w / 2, rs: 0, rd: 0, depth: off, ramp: 0.04, s0, s1: s0 + len, d0, d1: d0 + w, surface: 'asphalt', tint: fresh ? 2 : 3 });
}
export function trench(s0: number, w: number, d0: number, d1: number, depth: number): RoadFeature {
  return box({ kind: 'trench', cs: s0 + w / 2, cd: (d0 + d1) / 2, rs: 0, rd: 0, depth: -depth, ramp: 0.03, s0, s1: s0 + w, d0, d1, surface: 'broken', tint: 4 });
}
export function manhole(cs: number, cd: number, off: number): RoadFeature {
  const r = 0.3, ramp = off < 0 ? 0.04 : 0.35, m = off < 0 ? r : r + ramp; // 0.6 m cover [A]
  return box({ kind: 'manhole', cs, cd, rs: r, rd: r, depth: off, ramp, s0: cs - m, s1: cs + m, d0: cd - m, d1: cd + m, surface: 'concrete', tint: 5 });
}
export function hump(id: string, name: string, s0: number, chord: number, h: number, halfW: number, source: string): RoadFeature {
  const p = chordHump(chord, h);
  return box({ kind: 'hump', cs: s0 + chord / 2, cd: 0, rs: p.R, rd: 0, depth: h, ramp: 0, s0, s1: s0 + chord, d0: -halfW, d1: halfW, prof: p.fn, id, name, source, tint: 0 });
}
/** IRC:99-2018 rumble set: 6 bars, 25 mm × 250 mm, 1 m apart [S: C-001]. */
export function rumble(id: string, s0: number, halfW: number): RoadFeature {
  const prof = (u: number) => { const k = Math.floor(u), f = u - k; return k >= 0 && k < 6 && f < 0.25 ? 0.025 * smooth(0, 0.04, f) * (1 - smooth(0.21, 0.25, f)) : 0; };
  return box({ kind: 'rumble', cs: s0 + 3, cd: 0, rs: 0, rd: 0, depth: 0.025, ramp: 0, s0, s1: s0 + 5.25, d0: -halfW, d1: halfW, prof, id, name: 'Rumble set before the village (6 × 25 mm, IRC:99)', source: 'C-001', surface: 'rumble', tint: 6 });
}

/**
 * Pothole clusters [A: gap H6.5]: a cluster every 25–55 m, 2–6 holes within ±2.5 m along and ±0.5 m across,
 * centred on a wheel path (60 %), the edge (25 %) or the crown (15 %). Diameter 0.3–1.2 m (skewed small);
 * depth classes < 25 / 25–50 / > 50 mm [S: C-014/C-015] in 40 / 40 / 20 %.
 */
export function potholeClusters(s0: number, s1: number, hw: number, seed: number, keepClear: (s: number, d: number) => boolean): RoadFeature[] {
  const rnd = mulberry(seed), out: RoadFeature[] = [];
  const lc = hw / 2, paths = [lc - 0.77, lc + 0.77, -(lc - 0.77), -(lc + 0.77)];
  for (let s = s0 + 10 + rnd() * 20; s < s1 - 6; s += 25 + rnd() * 30) {
    const r = rnd();
    const cd = r < 0.6 ? paths[Math.floor(rnd() * 4)] : r < 0.85 ? (rnd() < 0.5 ? 1 : -1) * (hw - 0.45) : (rnd() - 0.5) * 0.6;
    const n = 2 + Math.floor(rnd() * 5);
    for (let k = 0; k < n; k++) {
      const dia = 0.3 + Math.pow(rnd(), 1.8) * 0.9, q = rnd();
      const depth = q < 0.4 ? 0.012 + rnd() * 0.013 : q < 0.8 ? 0.025 + rnd() * 0.025 : 0.05 + rnd() * 0.04;
      const cs = s + (rnd() - 0.5) * 5, d = Math.max(-hw + dia / 2 + 0.05, Math.min(hw - dia / 2 - 0.05, cd + (rnd() - 0.5) * 1.0));
      if (keepClear(cs, d)) continue;
      out.push(pothole(cs, d, dia, depth, 0.75 + rnd() * 0.5));
    }
  }
  return out;
}
