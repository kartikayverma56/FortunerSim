// Analytic test ground: the physics samples heightAt()/surfaceAt() directly, so geometry is exact
// (speed breakers are true IRC profiles, not a coarse mesh). Visual meshes are built from the same functions.
// World: +Y up, the main runway runs along +Z.

import type { Surface } from '../audio/types';

export interface SurfaceProps { mu: number; rr: number; sink: number; label: string }
export const SURFACES: Record<Surface | 'grass', SurfaceProps> = {
  asphalt: { mu: 1.00, rr: 0.011, sink: 0, label: 'Smooth asphalt' },
  concrete: { mu: 0.95, rr: 0.011, sink: 0, label: 'Concrete (jointed)' },
  broken: { mu: 0.85, rr: 0.016, sink: 0, label: 'Broken asphalt' },
  rumble: { mu: 0.95, rr: 0.013, sink: 0, label: 'Rumble strips' },
  wet: { mu: 0.62, rr: 0.013, sink: 0, label: 'Wet asphalt' },
  gravel: { mu: 0.62, rr: 0.030, sink: 0.01, label: 'Loose gravel' },
  mud: { mu: 0.33, rr: 0.080, sink: 0.05, label: 'Mud' },
  sand: { mu: 0.50, rr: 0.120, sink: 0.07, label: 'Loose sand' },
  grass: { mu: 0.55, rr: 0.040, sink: 0.01, label: 'Grass / dirt' },
} as any;
// μ values: dry/wet/gravel from the Indian road database (Doc C) ranges; mud/sand are assumptions.

export type SurfaceKey = keyof typeof SURFACES;

interface Box { x0: number; x1: number; z0: number; z1: number }
interface Feature extends Box {
  name: string;
  h?: (x: number, z: number) => number;      // height contribution (m), added
  surface?: SurfaceKey;                        // surface override inside box
  paint?: 'hump' | 'none';
  info?: string;
  lod?: number;                                // visual mesh spacing (m)
}

// ---------- deterministic noise ----------
function hash(i: number, j: number) { let h = (i * 374761393 + j * 668265263) | 0; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
function vnoise(x: number, z: number) {
  const i = Math.floor(x), j = Math.floor(z), fx = x - i, fz = z - j;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  return (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v) * 2 - 1;
}
function fbm(x: number, z: number, oct: number, lac = 2.03, gain = 0.5) { let s = 0, a = 1, f = 1, n = 0; for (let k = 0; k < oct; k++) { s += a * vnoise(x * f, z * f); n += a; a *= gain; f *= lac; } return s / n; }
const smooth = (e0: number, e1: number, x: number) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

// ---------- profile builders ----------
/** Circular-arc hump of height h and radius R (IRC:99), across the road (varies with z). */
function circHump(z0: number, h: number, R: number) {
  const half = Math.sqrt(Math.max(0, R * R - (R - h) * (R - h)));
  return { len: 2 * half, fn: (z: number) => { const d = z - z0 - half; return Math.abs(d) >= half ? 0 : Math.sqrt(R * R - d * d) - (R - h); } };
}
function trapHump(z0: number, h: number, ramp: number, top: number) {
  return { len: 2 * ramp + top, fn: (z: number) => { const d = z - z0; if (d <= 0 || d >= 2 * ramp + top) return 0; if (d < ramp) return h * d / ramp; if (d > ramp + top) return h * (2 * ramp + top - d) / ramp; return h; } };
}

// ---------- layout ----------
export const RUNWAY = { x0: -7, x1: 7, z0: -60, z1: 1750 };          // 0–100 & braking strip
export const IROAD = { x0: 34, x1: 42, z0: -20, z1: 1520 };           // Indian road strip
export const PAD = { cx: -260, cz: 380, r: 130 };                     // handling pad
export const OFFROAD = { x0: 110, x1: 300, z0: 0, z1: 520 };

const features: Feature[] = [];
export const humps: { id: string; name: string; z: number; len: number; h: number; R?: number; source: string }[] = [];

function addHump(id: string, name: string, z: number, kind: 'circ' | 'trap', a: number, b: number, c = 0, source = '') {
  const prof = kind === 'circ' ? circHump(z, a, b) : trapHump(z, a, b, c);
  // slight crown across the road so humps taper at the edges (real humps are built kerb-to-kerb; we taper the last 0.3 m)
  features.push({ name: id, x0: IROAD.x0, x1: IROAD.x1, z0: z, z1: z + prof.len, lod: 0.04, paint: 'hump', info: name,
    h: (x, zz) => prof.fn(zz) * smooth(IROAD.x0, IROAD.x0 + 0.3, x) * (1 - smooth(IROAD.x1 - 0.3, IROAD.x1, x)) });
  humps.push({ id, name, z, len: prof.len, h: a, R: kind === 'circ' ? b : undefined, source });
}

// --- Indian road strip zones ---
const zones: { z0: number; z1: number; surface: SurfaceKey; label: string }[] = [];
function zone(z0: number, z1: number, surface: SurfaceKey, label: string, h?: Feature['h'], lod = 0.25) {
  zones.push({ z0, z1, surface, label });
  features.push({ name: label, x0: IROAD.x0, x1: IROAD.x1, z0, z1, surface, h, lod, info: label });
}
zone(-20, 100, 'asphalt', 'Smooth urban asphalt');
zone(100, 300, 'broken', 'Broken asphalt (ISO 8608 class ~D, assumed)', (x, z) =>
  0.012 * fbm(x * 0.9, z * 0.9, 4) + 0.006 * fbm(x * 4.1, z * 4.1, 2) - 0.02 * Math.max(0, fbm(x * 0.35 + 7, z * 0.35, 3) - 0.35), 0.1);
// potholes: dimensions are assumptions (no Indian distribution published — Doc H H6.5)
const potholes: { x: number; z: number; r: number; d: number }[] = [];
for (let k = 0; k < 26; k++) {
  const z = 310 + k * 5.4 + hash(k, 3) * 3, x = IROAD.x0 + 1.2 + hash(k, 5) * (IROAD.x1 - IROAD.x0 - 2.4);
  potholes.push({ x, z, r: 0.25 + hash(k, 7) * 0.5, d: 0.04 + hash(k, 9) * 0.10 });
}
zone(300, 460, 'broken', 'Potholes (depth 40–140 mm, assumed)', (x, z) => {
  let s = 0.006 * fbm(x, z, 3);
  for (const p of potholes) { const dx = x - p.x, dz = z - p.z, r = Math.hypot(dx, dz); if (r < p.r) { const t = r / p.r; s -= p.d * (t < 0.7 ? 1 : 1 - smooth(0.7, 1, t)); } }
  return s;
}, 0.08);
zone(460, 980, 'asphalt', 'Speed breakers (IRC:99-2018 designs + measured Indian humps)');
zone(980, 1120, 'concrete', 'Cement concrete, joints every 4.5 m', (x, z) => {
  const d = (z - 980) % 4.5; const slab = Math.floor((z - 980) / 4.5);
  return (d < 0.012 ? -0.006 : 0) + (hash(slab, 1) - 0.5) * 0.008;   // joint groove + slab faulting ±4 mm (assumed)
}, 0.05);
zone(1120, 1260, 'gravel', 'Loose gravel', (x, z) => 0.025 * fbm(x * 1.7, z * 1.7, 3) + 0.006 * fbm(x * 9, z * 9, 2), 0.12);
zone(1260, 1380, 'wet', 'Wet asphalt (monsoon)');
zone(1380, 1520, 'mud', 'Mud with ruts', (x, z) => {
  const c = (IROAD.x0 + IROAD.x1) / 2, t1 = c - 0.78, t2 = c + 0.78;
  const rut = (xx: number) => -0.09 * Math.exp(-((xx) ** 2) / 0.06);
  return rut(x - t1) + rut(x - t2) + 0.03 * fbm(x * 0.8, z * 0.8, 3);
}, 0.12);

// Speed breakers (IRC:99-2018 circular designs SB-01..07, legacy 1988 SB-08, trapezoid SB-13, speed table SB-18, measured SB-*)
let zz = 480;
const HUMPSPEC: [string, string, 'circ' | 'trap', number, number, number, string][] = [
  ['SB-01', 'IRC:99-2018 hump, 20 km/h (h 100 mm, R 11 m)', 'circ', 0.10, 11, 0, 'C-001'],
  ['SB-02', 'IRC:99-2018 hump, 25 km/h (R 15 m)', 'circ', 0.10, 15, 0, 'C-001'],
  ['SB-03', 'IRC:99-2018 hump, 30 km/h (R 20 m)', 'circ', 0.10, 20, 0, 'C-001'],
  ['SB-05', 'IRC:99-2018 hump, 40 km/h (R 53 m)', 'circ', 0.10, 53, 0, 'C-001'],
  ['SB-08', 'IRC:99-1988 hump (R 17 m, legacy)', 'circ', 0.10, 17, 0, 'C-002'],
  ['SB-13', 'IRC:99-2018 flat-top hump, 30 km/h', 'trap', 0.10, 1.0, 2.5, 'C-001'],
  ['SB-18', 'IRC:99-2018 speed table', 'trap', 0.10, 1.7, 5.0, 'C-001'],
  ['SB-26', 'Measured: Bhubaneswar #5 (h 70 mm, chord 0.98 m)', 'circ', 0.07, 1.75, 0, 'C-024'],
  ['SB-28', 'Measured: Bhubaneswar #7 (h 100 mm, chord 2.23 m)', 'circ', 0.10, 6.27, 0, 'C-024'],
  ['SB-37', 'Measured: Hyderabad #4 (h 100 mm, chord 2.97 m)', 'circ', 0.10, 11.08, 0, 'C-025'],
  ['SB-39', 'Measured: Hyderabad #6 (h 115 mm, chord 2.42 m)', 'circ', 0.115, 6.4, 0, 'C-025'],
  ['SB-X1', 'Unmarked steep hump (h 150 mm, R 2.5 m) — non-standard, assumed', 'circ', 0.15, 2.5, 0, 'assumption'],
];
for (const [id, name, kind, a, b, c, src] of HUMPSPEC) { addHump(id, name, zz, kind, a, b, c, src); zz += 40; }
// rumble strip set: 6 bars, 25 mm × 250 mm, ~1 m apart (IRC:99-2018)
features.push({ name: 'Rumble strips', x0: IROAD.x0, x1: IROAD.x1, z0: zz, z1: zz + 6, lod: 0.025, paint: 'hump', surface: 'rumble', info: 'Rumble strips (IRC:99-2018)',
  h: (x, z) => { const d = z - zz; const k = Math.floor(d); const f = d - k; return k >= 0 && k < 6 && f < 0.25 ? 0.025 * smooth(0, 0.04, f) * (1 - smooth(0.21, 0.25, f)) : 0; } });
humps.push({ id: 'RS', name: 'Rumble strips (6 × 25 mm)', z: zz, len: 6, h: 0.025, source: 'C-001' });

// --- Off-road park ---
const OR = OFFROAD;
features.push({ name: 'offroad-base', ...OR, surface: 'grass', lod: 0.5, h: (x, z) => 0.15 * fbm(x * 0.06, z * 0.06, 3) });
function rampFeature(x0: number, x1: number, z0: number, rise: number, grade: number, plateau: number, label: string) {
  const run = rise / grade;
  features.push({ name: label, x0, x1, z0, z1: z0 + 2 * run + plateau, surface: 'concrete', lod: 0.2, info: label,
    h: (x, z) => { const d = z - z0; if (d < run) return rise * smooth(0, 1, d / run) * 0 + rise * (d / run); if (d < run + plateau) return rise; return rise * Math.max(0, 1 - (d - run - plateau) / run); } });
}
rampFeature(120, 128, 20, 3.0, 0.30, 8, 'Ramp 30 % (≈16.7°) up / down');
rampFeature(134, 142, 20, 2.0, 0.20, 6, 'Ramp 20 % up / down');
features.push({ name: 'Cross-axle moguls', x0: 150, x1: 162, z0: 30, z1: 80, surface: 'grass', lod: 0.15, info: 'Cross-axle moguls (articulation)',
  h: (x, z) => { const u = (z - 30) / 50 * Math.PI * 6, v = (x - 156) / 6 * Math.PI; return 0.32 * Math.sin(u) * Math.sin(v) * smooth(150, 151.5, x) * (1 - smooth(160.5, 162, x)); } });
features.push({ name: 'Side slope 20 %', x0: 170, x1: 190, z0: 30, z1: 110, surface: 'grass', lod: 0.3, info: 'Side slope (20 % cross-fall)',
  h: (x, z) => 0.20 * (x - 170) * smooth(30, 36, z) * (1 - smooth(104, 110, z)) });
features.push({ name: 'Sand bowl', x0: 200, x1: 270, z0: 40, z1: 140, surface: 'sand', lod: 0.3, info: 'Loose sand (desert)',
  h: (x, z) => 0.5 * fbm(x * 0.05, z * 0.05, 3) + 0.08 * fbm(x * 0.5, z * 0.5, 2) });
features.push({ name: 'Rock garden', x0: 150, x1: 168, z0: 140, z1: 220, surface: 'gravel', lod: 0.08, info: 'Rock garden',
  h: (x, z) => { let s = 0; const gx = Math.floor(x / 1.6), gz = Math.floor(z / 1.6); for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) { const cx = (gx + i + 0.5) * 1.6 + (hash(gx + i, gz + j) - 0.5) * 0.8, cz = (gz + j + 0.5) * 1.6 + (hash(gx + i + 9, gz + j) - 0.5) * 0.8; const r = 0.25 + hash(gx + i, gz + j + 4) * 0.45, hh = 0.08 + hash(gx + i + 3, gz + j) * 0.22; const d = Math.hypot(x - cx, z - cz); if (d < r) s = Math.max(s, hh * Math.sqrt(1 - (d / r) ** 2)); } return s * smooth(150, 151, x) * (1 - smooth(167, 168, x)); } });
features.push({ name: 'Water ditch', x0: 200, x1: 214, z0: 200, z1: 214, surface: 'mud', lod: 0.2, info: 'Ditch (0.45 m deep)',
  h: (x, z) => -0.45 * Math.max(0, 1 - Math.hypot(x - 207, z - 207) / 7) ** 1.5 });

// --- Handling pad (flat asphalt disk) and runway ---
features.push({ name: 'Handling pad', x0: PAD.cx - PAD.r, x1: PAD.cx + PAD.r, z0: PAD.cz - PAD.r, z1: PAD.cz + PAD.r, lod: 2,
  surface: 'asphalt' });
features.push({ name: 'Runway', ...RUNWAY, surface: 'asphalt', lod: 2 });
// connector roads (asphalt) from runway to Indian road and to the pad
features.push({ name: 'Connector', x0: 7, x1: 34, z0: -20, z1: -8, surface: 'asphalt', lod: 1 });
features.push({ name: 'Connector2', x0: 42, x1: 110, z0: -20, z1: -8, surface: 'asphalt', lod: 1 });

// ---------- queries ----------
const flatFeatures = features.filter(f => !f.h);
const heightFeatures = features.filter(f => f.h);
// spatial grid for fast lookup
const CELL = 20; const grid = new Map<number, Feature[]>();
const key = (i: number, j: number) => i * 100003 + j;
for (const f of features) for (let i = Math.floor(f.x0 / CELL); i <= Math.floor(f.x1 / CELL); i++) for (let j = Math.floor(f.z0 / CELL); j <= Math.floor(f.z1 / CELL); j++) { const k = key(i, j); if (!grid.has(k)) grid.set(k, []); grid.get(k)!.push(f); }
const near = (x: number, z: number) => grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) || [];

/** Base terrain (gentle rolling field), zero on and near the paved areas. */
function baseHeight(x: number, z: number) {
  const inPaved = (b: Box, m: number) => x > b.x0 - m && x < b.x1 + m && z > b.z0 - m && z < b.z1 + m;
  let w = 1;
  for (const b of [RUNWAY, IROAD, { x0: 7, x1: 110, z0: -20, z1: -8 }]) if (inPaved(b, 25)) { const dx = Math.max(b.x0 - x, x - b.x1, 0), dz = Math.max(b.z0 - z, z - b.z1, 0); w = Math.min(w, smooth(4, 25, Math.hypot(dx, dz))); }
  const dp = Math.hypot(x - PAD.cx, z - PAD.cz); w = Math.min(w, smooth(PAD.r + 4, PAD.r + 30, dp));
  if (x > OFFROAD.x0 - 20 && x < OFFROAD.x1 + 20 && z > OFFROAD.z0 - 20 && z < OFFROAD.z1 + 20) { const dx = Math.max(OFFROAD.x0 - x, x - OFFROAD.x1, 0), dz = Math.max(OFFROAD.z0 - z, z - OFFROAD.z1, 0); w = Math.min(w, smooth(0, 20, Math.hypot(dx, dz))); }
  return w * (2.2 * fbm(x * 0.004 + 3, z * 0.004, 4) + 0.25 * fbm(x * 0.05, z * 0.05, 2));
}

export function heightAt(x: number, z: number): number {
  let h = baseHeight(x, z);
  for (const f of near(x, z)) if (f.h && x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1) h += f.h(x, z);
  return h;
}

export function surfaceAt(x: number, z: number): SurfaceKey {
  let s: SurfaceKey = 'grass'; let area = Infinity;
  const dp = Math.hypot(x - PAD.cx, z - PAD.cz); if (dp < PAD.r) { s = 'asphalt'; area = Math.PI * PAD.r * PAD.r; }
  for (const f of near(x, z)) {
    if (!f.surface || f.name === 'Handling pad' || x < f.x0 || x > f.x1 || z < f.z0 || z > f.z1) continue;
    const a = (f.x1 - f.x0) * (f.z1 - f.z0); if (a < area) { area = a; s = f.surface; }
  }
  return s;
}

export function normalAt(x: number, z: number, out: { x: number; y: number; z: number }, e = 0.05) {
  const hx = heightAt(x + e, z) - heightAt(x - e, z), hz = heightAt(x, z + e) - heightAt(x, z - e);
  const nx = -hx / (2 * e), nz = -hz / (2 * e), l = Math.hypot(nx, 1, nz);
  out.x = nx / l; out.y = 1 / l; out.z = nz / l; return out;
}

export function zoneLabelAt(x: number, z: number): string {
  for (const f of near(x, z)) if (f.info && x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1 && f.paint === 'hump') return f.info;
  for (const f of near(x, z)) if (f.info && x >= f.x0 && x <= f.x1 && z >= f.z0 && z <= f.z1) return f.info;
  if (x >= RUNWAY.x0 && x <= RUNWAY.x1) return 'Runway (0–100 / braking)';
  if (Math.hypot(x - PAD.cx, z - PAD.cz) < PAD.r) return 'Handling pad';
  return SURFACES[surfaceAt(x, z)].label;
}

export const WORLD = { features, zones, potholes, flatFeatures, heightFeatures };
