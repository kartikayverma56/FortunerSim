// Road paths (phase 1: straight legs only). A road maps world (x, z) to road coordinates (s along, d across,
// + = the driver's left) and owns a cross-section that varies with s: carriageway with crown, scalloped tarmac
// edge with a 0.2 m drop ramp, earth shoulder, side drain, flat frontage, then a blend into the base terrain.
// Height = vertical profile G(s) + crown + IRI-scaled roughness + discrete features. DOM-free.
// Numbers tagged [A] are assumptions to tune; [S: …] are from D:\TharSim\research (see research/PLAN_indian_roads.md).
import { fbm, vnoise, smooth, hash } from './noise';
import { synthProfile, iri } from './roughness';
import { FeatureIndex, potholeClusters, pothole, patch, trench, manhole, hump, rumble, type RoadFeature } from './roadFeatures';

export type RoadClass = 'apron' | 'join' | 'link' | 'sh' | 'district' | 'village';
export type RoadSurface = 'asphalt' | 'broken' | 'concrete' | 'rumble' | 'grass';

interface ClassSpec {
  label: string; surface: RoadSurface;
  hw: number;      // carriageway half width (m)
  sh: number;      // shoulder width beyond the nominal edge (m)
  cf: number;      // carriageway crossfall (crown)        [S: C-007/008/009]
  sf: number;      // shoulder crossfall                    [S: C-009: pavement + 0.5 %, min 3–4 %]
  drop: [number, number]; // tarmac edge drop over 0.2 m   [A: 30–100 mm]
  scallop: number; breaks: number; // edge wander and broken-edge bites (m) [A]
  ditchD: number; ditchW: number; front: number; blend: number; // side drain, flat frontage, blend to terrain (m) [A]
  iri: number;     // target IRI, m/km                      [S: C-006, C-029, C-030]
  earth: number;   // shoulder/frontage unevenness scale [A]
}
export const CLASSES: Record<RoadClass, ClassSpec> = {
  apron: { label: 'Junction', surface: 'asphalt', hw: 5, sh: 0, cf: 0, sf: 0.04, drop: [0, 0], scallop: 0, breaks: 0, ditchD: 0, ditchW: 0, front: 0, blend: 12, iri: 0, earth: 0 },
  join: { label: 'Link road', surface: 'asphalt', hw: 6, sh: 0, cf: 0, sf: 0.04, drop: [0, 0], scallop: 0, breaks: 0, ditchD: 0, ditchW: 0, front: 0, blend: 6, iri: 0, earth: 0 },
  link: { label: 'Link road (7 m, IRI 3.0)', surface: 'asphalt', hw: 3.5, sh: 1.5, cf: 0.025, sf: 0.04, drop: [0.02, 0.04], scallop: 0.04, breaks: 0, ditchD: 0.25, ditchW: 1.5, front: 0.5, blend: 6, iri: 3.0, earth: 1 },
  sh: { label: 'State highway (7 m, IRI 3.5)', surface: 'asphalt', hw: 3.5, sh: 1.5, cf: 0.025, sf: 0.04, drop: [0.03, 0.05], scallop: 0.05, breaks: 0.05, ditchD: 0.35, ditchW: 2.0, front: 1.0, blend: 12, iri: 3.5, earth: 1 },
  district: { label: 'District road (5.5 m, IRI 4.5, potholes, edge drop)', surface: 'broken', hw: 2.75, sh: 1.0, cf: 0.03, sf: 0.045, drop: [0.03, 0.10], scallop: 0.12, breaks: 0.22, ditchD: 0.4, ditchW: 1.6, front: 1.0, blend: 12, iri: 4.5, earth: 1.3 },
  village: { label: 'Village entry (7 m, IRI 5.0, humps, patches, manholes)', surface: 'asphalt', hw: 3.5, sh: 2.0, cf: 0.025, sf: 0.04, drop: [0.02, 0.04], scallop: 0.08, breaks: 0.08, ditchD: 0, ditchW: 0, front: 26, blend: 14, iri: 5.0, earth: 1.5 },
};

export interface Section { cls: RoadClass; s0: number; s1: number; tw: number } // tw = half-length of the transition into this section
const RAMP = 0.2;              // tarmac edge drop ramp width (m) [A]
const STEP = 0.25;             // cross-section table step along s (m)
const K = 15;                  // table fields
const F_G = 0, F_HW = 1, F_SH = 2, F_CF = 3, F_SF = 4, F_DL = 5, F_DR = 6, F_EL = 7, F_ER = 8, F_DD = 9, F_DW = 10, F_FR = 11, F_BL = 12, F_A = 13, F_EA = 14;
const RDX = 0.05, RLOG2 = 15;  // roughness tables: 0.05 m step, 32768 samples (1638 m)
const C_D = 1 / 3;             // roughness lateral term: h = A·[P1(s) + (d/3 m)·P2(s)]

// unit-roughness tables shared by all roads (P1 wavelengths 0.3–50 m; P2 is the left/right difference, 0.3–8 m)
const P1 = synthProfile(RLOG2, RDX, 0.3, 50, 1101);
const P2 = synthProfile(RLOG2, RDX, 0.3, 8, 2203);
{ // P2 at ~45 % of P1's short-wave level: wheel paths differ, long waves stay coherent across the road [A]
  let a = 0, b = 0; for (let i = 0; i < P1.length; i += 7) { a += Math.abs(P1[i] - (P1[i + 1] ?? 0)); b += Math.abs(P2[i] - (P2[i + 1] ?? 0)); }
  const k = (0.45 * a) / b; for (let i = 0; i < P2.length; i++) P2[i] *= k;
}

export const RS = { h: 0, core: false, w: 0 }; // scratch result of Road.sample (no allocation in the physics loop)

export class Road {
  readonly T: Float32Array; readonly n: number;
  readonly feats: FeatureIndex;
  readonly bbox: { x0: number; x1: number; z0: number; z1: number };
  readonly iriScale = new Map<Section, number>();
  constructor(
    public name: string, public axis: 'z' | 'x', public ox: number, public oz: number,
    public sMin: number, public sMax: number, public sections: Section[], public rOff: number,
    public endBlend: [number, number], profile: (s: number) => number, features: RoadFeature[], seed: number,
  ) {
    this.n = Math.round((sMax - sMin) / STEP) + 2;
    this.T = new Float32Array(this.n * K);
    // per-class values blended across section boundaries (weights sum to 1)
    const wts = (s: number) => sections.map((sec, k) => (k === 0 ? 1 : smooth(sec.s0 - sec.tw, sec.s0 + sec.tw, s)) * (k === sections.length - 1 ? 1 : 1 - smooth(sections[k + 1].s0 - sections[k + 1].tw, sections[k + 1].s0 + sections[k + 1].tw, s)));
    for (let i = 0; i < this.n; i++) {
      const s = sMin + i * STEP, w = wts(s), o = i * K;
      const mix = (f: (c: ClassSpec) => number) => { let v = 0; for (let k = 0; k < sections.length; k++) if (w[k] > 0) v += w[k] * f(CLASSES[sections[k].cls]); return v; };
      // slowly varying edge drop (per side) and a scalloped edge: wander plus bites where the edge has broken away
      const nL = 0.5 + 0.5 * fbm(s * 0.03 + seed, 3.7, 2), nR = 0.5 + 0.5 * fbm(s * 0.03 + seed, 9.1, 2);
      const scL = vnoise(s * 0.55 + seed, 1.3) * 0.6 + vnoise(s * 1.6 + seed, 2.9) * 0.4, scR = vnoise(s * 0.55 + seed, 5.3) * 0.6 + vnoise(s * 1.6 + seed, 7.9) * 0.4;
      const bL = Math.max(0, vnoise(s * 0.22 + seed, 11.5) - 0.35) / 0.65, bR = Math.max(0, vnoise(s * 0.22 + seed, 13.5) - 0.35) / 0.65;
      this.T[o + F_G] = profile(s);
      this.T[o + F_HW] = mix(c => c.hw); this.T[o + F_SH] = mix(c => c.sh); this.T[o + F_CF] = mix(c => c.cf); this.T[o + F_SF] = mix(c => c.sf);
      this.T[o + F_DL] = mix(c => c.drop[0] + (c.drop[1] - c.drop[0]) * nL); this.T[o + F_DR] = mix(c => c.drop[0] + (c.drop[1] - c.drop[0]) * nR);
      this.T[o + F_EL] = mix(c => c.scallop * scL - c.breaks * bL); this.T[o + F_ER] = mix(c => c.scallop * scR - c.breaks * bR);
      this.T[o + F_DW] = mix(c => c.ditchW); this.T[o + F_DD] = mix(c => c.ditchD) * Math.min(1, this.T[o + F_DW]) ** 2; this.T[o + F_FR] = mix(c => c.front); this.T[o + F_BL] = mix(c => c.blend);
      this.T[o + F_EA] = mix(c => c.earth); // (a drain narrowing out also gets shallow: depth × min(1, width)²)
    }
    // IRI scale per section: the unit table's mean wheel-path IRI over the section → amplitude for the target
    for (const sec of sections) {
      const c = CLASSES[sec.cls]; if (!c.iri) { this.iriScale.set(sec, 0); continue; }
      const a = Math.max(sec.s0, sMin) + 15, b = Math.min(sec.s1, sMax) - 15;
      const lc = c.hw / 2; let sum = 0;
      for (const d of [lc - 0.77, lc + 0.77, -(lc - 0.77), -(lc + 0.77)]) sum += iri(i => this.unitRough(sMin + 0 + i * RDX, d), RDX, Math.round((a - sMin) / RDX), Math.round((b - sMin) / RDX));
      this.iriScale.set(sec, c.iri / (sum / 4));
    }
    for (let i = 0; i < this.n; i++) {
      const s = sMin + i * STEP, w = wts(s); let v = 0;
      sections.forEach((sec, k) => { v += w[k] * this.iriScale.get(sec)!; });
      this.T[i * K + F_A] = v;
    }
    this.feats = new FeatureIndex(features, sMin - 1, sMax + 1);
    // world bounding box of everything this road can touch (core + blend + end blends)
    let half = 0; for (let i = 0; i < this.n; i++) { const o = i * K; half = Math.max(half, this.T[o + F_HW] + this.T[o + F_SH] + this.T[o + F_DW] + this.T[o + F_FR] + this.T[o + F_BL] + 0.4); }
    const a0 = sMin - endBlend[0], a1 = sMax + endBlend[1];
    if (axis === 'z') this.bbox = { x0: ox - half, x1: ox + half, z0: oz + a0, z1: oz + a1 };
    else this.bbox = { x0: ox + a0, x1: ox + a1, z0: oz - half, z1: oz + half };
  }
  /** Roughness of the unit table (IRI ≈ 1 before scaling by F_A) at (s, d). */
  unitRough(s: number, d: number) {
    const q = (s + this.rOff) / RDX, j = q | 0, g = q - j;
    const p1 = P1[j] + (P1[j + 1] - P1[j]) * g, p2 = P2[j] + (P2[j + 1] - P2[j]) * g;
    return p1 + d * C_D * p2;
  }
  toS(x: number, z: number) { return this.axis === 'z' ? z - this.oz : x - this.ox; }
  toD(x: number, z: number) { return this.axis === 'z' ? x - this.ox : this.oz - z; }
  toX(s: number, d: number) { return this.axis === 'z' ? this.ox + d : this.ox + s; }
  toZ(s: number, d: number) { return this.axis === 'z' ? this.oz + s : this.oz - d; }
  /** Interpolated table field at s (clamped to the road). */
  field(s: number, f: number) {
    const p = (Math.min(this.sMax, Math.max(this.sMin, s)) - this.sMin) / STEP, i = p | 0, g = p - i, o = i * K + f;
    return this.T[o] + (this.T[o + K] - this.T[o]) * g;
  }
  hw(s: number) { return this.field(s, F_HW); }
  /** Tarmac edge position on the side of d (m from the centre line). */
  edge(s: number, d: number) { return this.field(s, F_HW) + this.field(s, d >= 0 ? F_EL : F_ER); }
  /** Outer limit of the road's own surface (core), and of its blend into the terrain. */
  coreHalf(s: number) { return this.field(s, F_HW) + this.field(s, F_SH) + this.field(s, F_DW) + this.field(s, F_FR); }
  blendW(s: number) { return this.field(s, F_BL); }
  sectionAt(s: number): Section { const S = this.sections; for (let k = S.length - 1; k > 0; k--) if (s >= S[k].s0) return S[k]; return S[0]; }

  /** Height of the road's surface at (s, d); returns the weight of the road there (1 = road surface only). Writes RS. */
  sample(s: number, d: number): number {
    let ws = 1;
    if (s < this.sMin) { if (this.endBlend[0] <= 0) return (RS.w = 0); ws = 1 - smooth(0, this.endBlend[0], this.sMin - s); }
    else if (s > this.sMax) { if (this.endBlend[1] <= 0) return (RS.w = 0); ws = 1 - smooth(0, this.endBlend[1], s - this.sMax); }
    if (ws <= 0) return (RS.w = 0);
    const sc = s < this.sMin ? this.sMin : s > this.sMax ? this.sMax : s;
    const p = (sc - this.sMin) / STEP, i = p | 0, g = p - i, o = i * K, T = this.T;
    const L = (f: number) => T[o + f] + (T[o + K + f] - T[o + f]) * g;
    const hw = L(F_HW), sh = L(F_SH), dw = L(F_DW), fr = L(F_FR), ad = d < 0 ? -d : d;
    const outer = hw + sh + dw + fr;
    let w = ws;
    if (ad > outer) { const bl = L(F_BL); if (ad >= outer + bl) return (RS.w = 0); w *= 1 - smooth(outer, outer + bl, ad); }
    const G = L(F_G), cf = L(F_CF), A = L(F_A);
    const e = hw + L(d >= 0 ? F_EL : F_ER);
    const dc = ad < e ? d : d < 0 ? -e : e;                       // roughness/crown are continued flat beyond the edge
    const q = (sc + this.rOff) / RDX, j = q | 0, gg = q - j;
    const rough = A * (P1[j] + (P1[j + 1] - P1[j]) * gg + dc * C_D * (P2[j] + (P2[j + 1] - P2[j]) * gg));
    let h = G - cf * (ad < e ? ad : e) + rough;
    if (ad > e) {
      const drop = L(d >= 0 ? F_DL : F_DR), sf = L(F_SF);
      if (ad < e + RAMP) h -= drop * (ad - e) / RAMP;
      else {
        const so = hw + sh;                                         // shoulder outer edge
        h -= drop + sf * ((ad < so ? ad : so) - e - RAMP > 0 ? (ad < so ? ad : so) - e - RAMP : 0);
        if (ad > so && dw > 0) { const t = (ad - so) / dw; if (t < 1) { const u = 2 * t - 1, b = 1 - u * u; h -= L(F_DD) * b * b; } }
        if (ad > e + RAMP) { const ea = L(F_EA) * smooth(e + RAMP, e + RAMP + 0.3, ad); h += ea * (0.012 * vnoise(s * 1.1, d * 1.1 + 50) + 0.005 * vnoise(s * 3.7, d * 3.7 + 9)); }
      }
    }
    if (ad < hw + 1) h += this.feats.height(s, d);
    RS.h = h; RS.core = w >= 1 && ad <= outer; RS.w = w;
    return w;
  }
  surface(s: number, d: number): RoadSurface | null {
    if (s < this.sMin || s > this.sMax) return null;
    const ad = Math.abs(d);
    if (ad > this.coreHalf(s)) return null;
    if (ad > this.edge(s, d) + 0.1) return 'grass';                   // earth shoulder, drain and frontage
    const f = this.feats.top(s, d);
    if (f && f.surface) return f.surface;
    return CLASSES[this.sectionAt(s).cls].surface;
  }
}

// ---------------- layout ----------------
// raw terrain field (the same noise baseHeight uses, unweighted) and a ±40 m twice-box-filtered copy along a line
const rawTerrain = (x: number, z: number) => 2.2 * fbm(x * 0.004 + 3, z * 0.004, 4) + 0.25 * fbm(x * 0.05, z * 0.05, 2);
function filteredLine(fx: (s: number) => number, fz: (s: number) => number, a: number, b: number) {
  const n = Math.round(b - a) + 1, raw = new Float64Array(n);
  for (let i = 0; i < n; i++) raw[i] = rawTerrain(fx(a + i), fz(a + i));
  const box = (src: Float64Array, r: number) => { const o = new Float64Array(n); for (let i = 0; i < n; i++) { let s = 0, c = 0; for (let k = -r; k <= r; k++) { const q = Math.min(n - 1, Math.max(0, i + k)); s += src[q]; c++; } o[i] = s / c; } return o; };
  const f = box(box(raw, 40), 40);
  return (s: number) => { const p = Math.min(n - 1.001, Math.max(0, s - a)), i = p | 0, g = p - i; return f[i] + (f[i + 1] - f[i]) * g; };
}

export const MAIN_X = 420;                        // the new road runs along +Z at x = 420
export const LINK_Z = -14;                        // link road along +X at z = −14 (extends Connector2)
const mainF = filteredLine(() => MAIN_X, s => s, -80, 1600);
const G0 = mainF(-14);
const mainProfile = (s: number) => s <= 0 ? G0 : G0 + (mainF(s) - G0) * smooth(0, 80, s);
const linkF = filteredLine(s => 110 + s, () => LINK_Z, -60, 380);
const linkProfile = (s: number) => { const a = linkF(s) * smooth(0, 70, s); return a + (G0 - a) * smooth(235, 300, s); };

export const MAIN_SECTIONS: Section[] = [
  { cls: 'apron', s0: -20, s1: 4, tw: 0 }, { cls: 'sh', s0: 4, s1: 500, tw: 4 },
  { cls: 'district', s0: 500, s1: 1000, tw: 10 }, { cls: 'village', s0: 1000, s1: 1520, tw: 10 },
];
const LINK_SECTIONS: Section[] = [
  { cls: 'join', s0: 0, s1: 18, tw: 0 }, { cls: 'link', s0: 18, s1: 292, tw: 8 }, { cls: 'apron', s0: 292, s1: 305, tw: 6 },
];

// ---- discrete features on the main road ----
/** Reference pothole for the pothole test: district road, left lane, left wheel path. 0.7 m across, 60 mm deep [A]. */
export const REF_POTHOLE = { s: 650, d: 2.15, dia: 0.7, depth: 0.06 };
const mainFeatures: RoadFeature[] = [];
{
  const F = mainFeatures;
  // state highway: a few patches and two shallow potholes (it is maintained, but not well)
  F.push(patch(62, 3.2, 0.4, 2.6, 0.012, true), patch(188, 1.8, -3.1, 1.5, -0.01, false), patch(305, 6.0, -2.9, 2.6, 0.015, false), patch(431, 2.4, 1.2, 1.8, 0.01, true));
  F.push(pothole(247, 2.6, 0.45, 0.02, 0.9), pothole(372, -1.0, 0.35, 0.03, 1.2));
  // district road: pothole clusters in wheel paths, at the edge and the crown, plus the reference pothole with a clear run-up
  const clear = (s: number, d: number) => (s > REF_POTHOLE.s - 45 && s < REF_POTHOLE.s + 12 && d > 0) || s < 506 || s > 994;
  F.push(...potholeClusters(500, 1000, CLASSES.district.hw, 4242, clear));
  F.push(pothole(REF_POTHOLE.s, REF_POTHOLE.d, REF_POTHOLE.dia, REF_POTHOLE.depth, 1));
  F.push(patch(540, 4.0, -2.4, 2.2, 0.018, false), patch(712, 2.2, 0.3, 2.0, 0.022, true), patch(803, 7.5, -2.5, 5.0, 0.012, false), patch(911, 1.6, 1.0, 1.4, -0.015, false));
  // village entry: rumble set, an unpainted hump pair [S: C-024/C-025 chords and heights], patches, manholes, trench cuts
  F.push(rumble('RS-V', 1004, 4.1));
  F.push(hump('VH-1', 'Village entry hump 1: unpainted, h 85 mm, chord 1.9 m (Bhubaneswar-type)', 1030, 1.9, 0.085, 4.1, 'C-024'));
  F.push(hump('VH-2', 'Village entry hump 2: unpainted, h 100 mm, chord 2.4 m (Hyderabad-type)', 1042, 2.4, 0.10, 4.1, 'C-025'));
  F.push(hump('VH-3', 'Village exit hump: unpainted, h 110 mm, chord 3.0 m (Hyderabad-type)', 1452, 3.0, 0.11, 4.1, 'C-025'));
  F.push(hump('VH-4', 'Village exit hump: unpainted, h 90 mm, chord 2.1 m', 1464, 2.1, 0.09, 4.1, 'C-024'));
  F.push(patch(1075, 2.5, -1.2, 2.4, 0.02, true), patch(1121, 5.5, 0.2, 3.1, -0.012, false), patch(1188, 1.4, -3.0, 1.2, 0.025, true), patch(1262, 3.6, -0.6, 2.8, 0.015, false), patch(1338, 2.0, 1.6, 1.6, -0.02, false), patch(1404, 6.5, -3.2, 3.0, 0.01, true));
  F.push(manhole(1097, 0.4, -0.03), manhole(1158, -1.6, 0.035), manhole(1219, 1.9, -0.025), manhole(1301, -0.3, 0.025), manhole(1378, 1.5, -0.04));
  F.push(trench(1140, 0.8, -3.6, 3.6, 0.03), trench(1245, 0.6, 0.0, 3.6, 0.025), trench(1322, 1.0, -3.6, -0.2, 0.04));
}
const linkFeatures: RoadFeature[] = [patch(96, 3.0, -2.8, 2.5, 0.012, false), patch(201, 2.0, 0.6, 2.2, -0.01, true)];

export const MAIN = new Road('main', 'z', MAIN_X, 0, -20, 1520, MAIN_SECTIONS, 30, [10, 15], mainProfile, mainFeatures, 17.3);
export const LINK = new Road('link', 'x', 110, LINK_Z, 0, 305, LINK_SECTIONS, 700, [0, 6], linkProfile, linkFeatures, 61.7);
export const ROADS: Road[] = [MAIN, LINK]; // order = priority where cores meet

/** Humps on the new road for the hump test (x = left-lane centre, heading +Z). */
export const ROAD_HUMPS = mainFeatures.filter(f => f.id).map(f => ({ id: f.id!, name: f.name!, z: MAIN.toZ(f.s0, 0), len: f.s1 - f.s0, h: f.depth, R: f.kind === 'hump' ? f.rs : undefined, source: f.source ?? '', x: MAIN_X + CLASSES[MAIN.sectionAt(f.s0).cls].hw / 2 }));

/** Lane centre (d) of the left lane at s on the main road. */
export const leftLane = (s: number) => MAIN.hw(s) / 2;

export const RQ = { h: 0 };
/**
 * Road contribution at (x, z): returns the blend weight (0 = no road, 1 = road surface only) and writes RQ.h.
 * A point inside a road's core takes that road's surface (roads earlier in ROADS win); in the blend zones the roads'
 * surfaces are averaged by weight so the result is continuous.
 */
export function roadSample(x: number, z: number): number {
  let sw = 0, swh = 0, wmax = 0;
  for (let k = 0; k < ROADS.length; k++) {
    const r = ROADS[k], b = r.bbox;
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
    const w = r.sample(r.toS(x, z), r.toD(x, z));
    if (w <= 0) continue;
    if (RS.core) { RQ.h = RS.h; return 1; }
    sw += w; swh += w * RS.h; if (w > wmax) wmax = w;
  }
  if (wmax > 0) RQ.h = swh / sw;
  return wmax;
}

export function roadSurfaceAt(x: number, z: number): RoadSurface | null {
  for (const r of ROADS) { const b = r.bbox; if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue; const s = r.surface(r.toS(x, z), r.toD(x, z)); if (s) return s; }
  return null;
}

export function roadLabelAt(x: number, z: number): string | null {
  for (const r of ROADS) {
    const b = r.bbox; if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
    const s = r.toS(x, z), d = r.toD(x, z);
    if (s < r.sMin || s > r.sMax || Math.abs(d) > r.coreHalf(s)) continue;
    for (const f of r.feats.at(s)) if (f.name && s >= f.s0 - 1 && s <= f.s1 + 1) return f.name;
    const sec = r.sectionAt(s);
    if (r === MAIN && sec.cls === 'apron') return 'Junction: link road → state highway';
    if (Math.abs(d) > r.edge(s, d) + 0.1) return CLASSES[sec.cls].label.split(' (')[0] + ' — earth shoulder';
    return CLASSES[sec.cls].label;
  }
  return null;
}

/** Distance-style mask used to sink the coarse base terrain under the road meshes (0 outside). */
export function corridorSink(x: number, z: number): number {
  let best = 0;
  for (const r of ROADS) {
    const b = r.bbox; if (x < b.x0 - 4 || x > b.x1 + 4 || z < b.z0 - 4 || z > b.z1 + 4) continue;
    const s = r.toS(x, z), d = Math.abs(r.toD(x, z));
    if (s < r.sMin - 2 || s > r.sMax + 2) continue;
    const ext = meshHalf(r, s);
    best = Math.max(best, 1 - smooth(ext - 4, ext, d));
  }
  return best;
}
/** Half width of the road's detailed mesh at s (core + most of the blend). */
export function meshHalf(r: Road, s: number) { const c = Math.min(r.sMax, Math.max(r.sMin, s)); return r.coreHalf(c) + Math.min(r.blendW(c), 12); }
export function inCorridor(x: number, z: number, margin: number) {
  for (const r of ROADS) {
    const s = r.toS(x, z); if (s < r.sMin - margin || s > r.sMax + margin) continue;
    if (Math.abs(r.toD(x, z)) < r.coreHalf(Math.min(r.sMax, Math.max(r.sMin, s))) + margin) return true;
  }
  return false;
}
void hash;

/**
 * Which road's mesh draws the ground at (x, z): the first road whose core contains the point, else the first whose
 * detailed mesh (core + blend, end blends included) does. Other ground meshes skip cells owned by a road.
 */
export function roadOwner(x: number, z: number): Road | null {
  for (const r of ROADS) { const b = r.bbox; if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue; const s = r.toS(x, z); if (s >= r.sMin && s <= r.sMax && Math.abs(r.toD(x, z)) <= r.coreHalf(s)) return r; }
  for (const r of ROADS) {
    const b = r.bbox; if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue; const s = r.toS(x, z);
    if (s < r.sMin - r.endBlend[0] || s > r.sMax + r.endBlend[1]) continue;
    if (Math.abs(r.toD(x, z)) <= meshHalf(r, s)) return r;
  }
  return null;
}
/** True when a road mesh draws the whole cell centred at (cx, cz) with half size h (its centre and four corners are owned). */
export function cellCovered(cx: number, cz: number, h: number) {
  return !!roadOwner(cx, cz) && !!roadOwner(cx - h, cz - h) && !!roadOwner(cx + h, cz - h) && !!roadOwner(cx - h, cz + h) && !!roadOwner(cx + h, cz + h);
}
