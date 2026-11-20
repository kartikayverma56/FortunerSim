// Roadside layout of the new road (phase 1): generic Indian village/town buildings, boundary walls, electric
// poles, avenue trees, a shrine, milestones and boards. Pure data (DOM-free, deterministic), shared by the
// mesh builder (roadsideMesh.ts) and the collider export (roadsideColliders.ts).
// Everything stands clear of the carriageway and the shoulders: the nearest face is the minimum `d` below.
import { heightAt } from './terrain';
import { MAIN, MAIN_X } from './roads';
import { mulberry } from './noise';

export type SignId = 'kirana' | 'tea' | 'medical' | 'auto' | 'puncture' | 'dhaba' | 'mobile' | 'hardware' | 'sweets' | 'tailor' | 'welcome' | 'chakki';
export interface Building {
  kind: 'house' | 'shop' | 'stall' | 'dhaba' | 'shrine';
  x: number; z: number; yaw: number;   // front-centre of the facade (world) and heading of the facade normal (three.js rotation.y)
  w: number; depth: number;            // facade width, depth (m)
  floors: number; base: number; floor: number; // ground (lowest corner) and ground-floor level (top of the plinth), m
  paint: number; side: number;         // front paint (sRGB); side/back walls
  sign?: SignId; shops: number;        // ground-floor shop bays (shutters)
  tank: boolean; mumty: boolean; rebar: boolean; balcony: boolean; seed: number;
}
export interface WallSeg { x0: number; z0: number; x1: number; z1: number; h: number; t: number; base: number; paint: number; brick: boolean }
export interface Pole { x: number; z: number; base: number; h: number; arm: number; transformer?: boolean }
export interface Tree { x: number; z: number; base: number; s: number; painted: boolean; kind: 'neem' | 'peepal' }
export interface Stone { x: number; z: number; base: number; yaw: number; kind: 'sh' | 'district' | 'hm'; label: string }
export interface Board { x: number; z: number; base: number; yaw: number; w: number; h: number; sign: SignId; post: number }
export interface Cot { x: number; z: number; base: number; yaw: number }

export const LAYOUT = { buildings: [] as Building[], walls: [] as WallSeg[], poles: [] as Pole[], trees: [] as Tree[], stones: [] as Stone[], boards: [] as Board[], cots: [] as Cot[], wires: [] as [number, number, number, number, number, number][] };

const rnd = mulberry(20261120);
const R = (a: number, b: number) => a + rnd() * (b - a);
const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
const PAINT = [0xe9a6b5, 0x9cc9e8, 0xf1dc7d, 0xa9dbb5, 0xf2c79a, 0xc9b6e4, 0xefe8d8, 0x7fc4c0, 0xe8875f, 0xd9e8a8, 0xf4f1ea, 0xb8b4ac, 0xb8b4ac];
const CEMENT = 0xb3ada3;
// world position of road coordinates (main road: x = 420 + d, z = s)
const wx = (d: number) => MAIN_X + d, wz = (s: number) => s;
const yawFor = (sg: number) => (sg > 0 ? -Math.PI / 2 : Math.PI / 2); // facade normal points back at the road

function ground(x0: number, z0: number, x1: number, z1: number) {
  let lo = Infinity, hi = -Infinity;
  for (const [x, z] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1], [(x0 + x1) / 2, (z0 + z1) / 2]]) { const h = heightAt(x, z); lo = Math.min(lo, h); hi = Math.max(hi, h); }
  return { lo, hi };
}
/** A building whose facade (width w, along the road) faces the road at |d| = dFront on side sg (+1 = left/+X). */
function building(kind: Building['kind'], s: number, sg: number, dFront: number, w: number, depth: number, floors: number, o: Partial<Building> = {}): Building {
  const xa = wx(sg * dFront), xb = wx(sg * (dFront + depth));
  const g = ground(Math.min(xa, xb), s - w / 2, Math.max(xa, xb), s + w / 2);
  const b: Building = {
    kind, x: xa, z: wz(s), yaw: yawFor(sg), w, depth, floors, base: g.lo, floor: g.hi + (kind === 'stall' ? 0.15 : R(0.3, 0.55)),
    paint: pick(PAINT), side: rnd() < 0.6 ? CEMENT : 0, shops: 0, tank: floors >= 1 && rnd() < 0.75, mumty: floors >= 2 && rnd() < 0.6,
    rebar: rnd() < 0.35, balcony: floors >= 2 && rnd() < 0.45, seed: Math.floor(rnd() * 1e6), ...o,
  };
  if (!b.side) b.side = b.paint;
  LAYOUT.buildings.push(b);
  return b;
}
function wall(sA: number, dA: number, sB: number, dB: number, h = 1.5, paint = pick(PAINT), brick = rnd() < 0.35) {
  const x0 = wx(dA), z0 = wz(sA), x1 = wx(dB), z1 = wz(sB);
  LAYOUT.walls.push({ x0, z0, x1, z1, h, t: 0.23, base: Math.min(heightAt(x0, z0), heightAt(x1, z1)) - 0.15, paint, brick });
}
const tree = (s: number, d: number, sc: number, painted: boolean, kind: Tree['kind'] = 'neem') => LAYOUT.trees.push({ x: wx(d), z: wz(s), base: heightAt(wx(d), wz(s)), s: sc, painted, kind });
const stone = (s: number, d: number, kind: Stone['kind'], label: string) => LAYOUT.stones.push({ x: wx(d), z: wz(s), base: heightAt(wx(d), wz(s)), yaw: d > 0 ? -Math.PI / 2 : Math.PI / 2, kind, label });
const board = (s: number, d: number, sign: SignId, w: number, h: number, post: number) => LAYOUT.boards.push({ x: wx(d), z: wz(s), base: heightAt(wx(d), wz(s)), yaw: d > 0 ? -Math.PI / 2 : Math.PI / 2, w, h, sign, post });

// ---------------- state highway: avenue trees with painted trunks, milestones ----------------
for (const sg of [1, -1]) for (let s = 20 + R(0, 10); s < 495; s += R(14, 26)) if (rnd() < 0.85) tree(s, sg * R(8.2, 9.6), R(0.9, 1.35), true);
stone(40, 5.3, 'sh', 'SONPUR|1');
for (const [s, n] of [[240, '2'], [440, '4'], [640, '6'], [840, '8']] as [number, string][]) stone(s, s < 500 ? 5.25 : 4.9, 'hm', n);

// ---------------- district road: a tea stall, a dhaba, a farm house, a tyre shop; poles; scattered trees ----------------
for (const sg of [1, -1]) for (let s = 515; s < 990; s += R(18, 45)) if (rnd() < 0.7) tree(s, sg * R(8.5, 15), R(0.9, 1.5), rnd() < 0.3, rnd() < 0.3 ? 'peepal' : 'neem');
building('stall', 562, -1, 8.6, 3.2, 2.6, 1, { sign: 'tea', paint: 0x8fb8c9, tank: false, mumty: false, rebar: false, balcony: false });
LAYOUT.cots.push({ x: wx(-7.9), z: 557.5, base: heightAt(wx(-7.9), 557.5), yaw: Math.PI / 2 });
{ // dhaba: open shed on poles with a tin roof, a kitchen block behind, cots in front
  const b = building('dhaba', 760, 1, 11.5, 13, 9, 1, { sign: 'dhaba', paint: 0xf2c79a, tank: true, mumty: false, rebar: false, balcony: false });
  for (let k = 0; k < 4; k++) LAYOUT.cots.push({ x: wx(9.6), z: 754 + k * 3.6, base: heightAt(wx(9.6), 754 + k * 3.6), yaw: 0 });
  void b;
}
{ const b = building('house', 880, -1, 15.5, 8.5, 9, 1, { paint: 0xf1dc7d, rebar: true });
  wall(874, -13, 886, -13, 1.4, b.paint); wall(874, -13, 874, -26, 1.4, b.paint); wall(886, -13, 886, -26, 1.4, b.paint); }
building('shop', 966, 1, 9.0, 7.5, 8, 1, { sign: 'puncture', shops: 2, paint: 0x9cc9e8 });
building('shop', 975, 1, 9.0, 6.0, 8, 1, { sign: 'auto', shops: 2, paint: 0xe9a6b5 });
// 11 kV line on the left side, 40 m spans (concrete poles, three wires)
const poleLine = (s0: number, s1: number, d: number, span: number, h: number) => {
  const ps: Pole[] = [];
  for (let s = s0; s <= s1; s += span) { const p = { x: wx(d), z: wz(s), base: heightAt(wx(d), wz(s)), h, arm: 1.6 }; ps.push(p); LAYOUT.poles.push(p); }
  return ps;
};
const wires = (ps: Pole[], offs: number[], sag: number) => {
  for (let k = 0; k < ps.length - 1; k++) for (const o of offs) {
    const a = ps[k], b = ps[k + 1], ya = a.base + a.h - 0.15, yb = b.base + b.h - 0.15;
    const ax = a.x + o, bx = b.x + o; let px = ax, py = ya, pz = a.z;
    for (let i = 1; i <= 10; i++) { const t = i / 10, x = ax + (bx - ax) * t, z = a.z + (b.z - a.z) * t, y = ya + (yb - ya) * t - sag * 4 * t * (1 - t); LAYOUT.wires.push([px, py, pz, x, y, z]); px = x; py = y; pz = z; }
  }
};
wires(poleLine(520, 1000, 8.0, 40, 9), [-0.75, 0, 0.75], 0.55);

// ---------------- village entry: welcome board, shrine, market street, houses with walls ----------------
board(1016, 6.4, 'welcome', 3.6, 1.4, 1.8);
stone(1048, -6.2, 'district', 'SONPUR|0');
{ // shrine under a peepal tree on a raised platform (chabutra)
  building('shrine', 1062, 1, 9.5, 2.6, 2.6, 1, { paint: 0xf08a3c, tank: false, mumty: false, rebar: false, balcony: false });
  tree(1068, 13.5, 1.9, false, 'peepal');
}
const marketSide = (sg: number, s0: number, s1: number) => {
  let s = s0;
  while (s < s1) {
    const w = R(4, 7.5), gap = rnd() < 0.18 ? R(1.2, 3) : R(0, 0.15);
    if (s + w > s1) break;
    const floors = rnd() < 0.25 ? 1 : rnd() < 0.7 ? 2 : 3;
    const shops = w > 6 ? 2 : 1;
    building('shop', s + w / 2, sg, R(7.6, 8.6), w, R(9, 13), floors, { sign: pick(['kirana', 'medical', 'mobile', 'hardware', 'sweets', 'tailor', 'chakki', 'kirana', 'tea'] as SignId[]), shops });
    s += w + gap;
  }
};
marketSide(1, 1080, 1300); marketSide(-1, 1074, 1296);
const houseSide = (sg: number, s0: number, s1: number) => {
  let s = s0;
  while (s < s1) {
    const plot = R(11, 17); if (s + plot > s1) break;
    if (rnd() < 0.2) { s += plot; continue; }                     // empty plot
    const w = plot - R(2.5, 4), dF = R(10.5, 13), depth = R(8, 11), floors = rnd() < 0.5 ? 1 : 2;
    const b = building('house', s + plot / 2, sg, dF, w, depth, floors);
    if (rnd() < 0.75) { // boundary wall: front with a gate gap, and the two sides
      const dW = sg * (dF - R(2.5, 3.5)), sA = s + 0.3, sB = s + plot - 0.3, gate = s + plot / 2, gw = 1.6;
      const brick = rnd() < 0.35, h = R(1.2, 1.7), col = rnd() < 0.5 ? b.paint : CEMENT;
      wall(sA, dW, gate - gw, dW, h, col, brick); wall(gate + gw, dW, sB, dW, h, col, brick);
      wall(sA, dW, sA, sg * (dF + depth + 1), h, col, brick); wall(sB, dW, sB, sg * (dF + depth + 1), h, col, brick);
    }
    if (rnd() < 0.4) tree(s + R(1, plot - 1), sg * R(dF - 2, dF - 1.2) , R(0.7, 1.1), false);
    s += plot;
  }
};
houseSide(1, 1305, 1445); houseSide(-1, 1302, 1440);
building('stall', 1478, -1, 8.2, 3.0, 2.5, 1, { sign: 'tea', paint: 0xa9dbb5, tank: false, mumty: false, rebar: false, balcony: false });
building('house', 1492, 1, 10, 9, 9, 2, { paint: 0xc9b6e4 });
for (const sg of [1, -1]) for (let s = 1450; s < 1515; s += R(12, 20)) tree(s, sg * R(15, 22), R(0.9, 1.4), false);
// LT poles on both sides of the village street, 32 m spans, with drops to some houses
{
  const L = poleLine(1010, 1490, 6.6, 32, 8), Rr = poleLine(1026, 1490, -6.6, 32, 8);
  LAYOUT.poles[LAYOUT.poles.indexOf(L[5])].transformer = true;
  wires(L, [-0.5, 0, 0.5], 0.45); wires(Rr, [-0.45, 0.45], 0.4);
  for (const b of LAYOUT.buildings) {
    if (b.z < 1080 || rnd() > 0.35) continue;
    const ps = Math.sign(b.x - MAIN_X) > 0 ? L : Rr, p = ps.reduce((a, c) => Math.abs(c.z - b.z) < Math.abs(a.z - b.z) ? c : a);
    const hx = b.x + Math.sign(b.x - MAIN_X) * 0.1, hy = b.floor + Math.min(b.floors, 2) * 3 - 0.4, px = p.x, py = p.base + p.h - 0.9;
    let ox = px, oy = py, oz = p.z;
    for (let i = 1; i <= 6; i++) { const t = i / 6, x = px + (hx - px) * t, z = p.z + (b.z - p.z) * t, y = py + (hy - py) * t - 0.35 * 4 * t * (1 - t); LAYOUT.wires.push([ox, oy, oz, x, y, z]); ox = x; oy = y; oz = z; }
  }
}
void MAIN;
