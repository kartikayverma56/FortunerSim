// Visuals for the roadside layout (roadside.ts): generic Indian village buildings and street furniture as merged
// low-poly geometry with ONE material (canvas texture atlas × vertex colour), split into 4 chunks along the road for
// culling, plus one line mesh for the overhead wires. Signboards use made-up generic shop names, no brands or logos.
import * as THREE from 'three';
import { LAYOUT, type Building, type SignId } from './roadside';
import { mulberry } from './noise';

// ---------------- texture atlas (2048², 8 × 8 cells of 256 px) ----------------
const CELL = 256, N = 8;
type Cell = [number, number, number, number]; // col, row, cols wide, rows tall
const C = {
  plaster: [0, 0, 1, 1], window: [1, 0, 1, 1], door: [2, 0, 1, 1], shutter: [3, 0, 1, 1], shopOpen: [4, 0, 1, 1], brick: [5, 0, 1, 1], white: [6, 0, 1, 1], tin: [7, 0, 1, 1],
  gate: [0, 1, 1, 1], templeDoor: [1, 1, 1, 1], charpai: [2, 1, 1, 1], tank: [3, 1, 1, 1], stoneSH: [4, 1, 1, 1], stoneDistrict: [5, 1, 1, 1], ad: [7, 1, 1, 1],
} satisfies Record<string, Cell>;
const HM: Record<string, Cell> = { '2': [6, 1, 0.5, 0.5], '4': [6.5, 1, 0.5, 0.5], '6': [6, 1.5, 0.5, 0.5], '8': [6.5, 1.5, 0.5, 0.5] };
const SIGNS: SignId[] = ['kirana', 'tea', 'medical', 'auto', 'puncture', 'dhaba', 'mobile', 'hardware', 'sweets', 'tailor', 'welcome', 'chakki'];
const signCell = (id: SignId): Cell => { const k = SIGNS.indexOf(id); return [(k % 2) * 4, 2 + Math.floor(k / 2), 4, 1]; };
const SIGN_STYLE: Record<SignId, [string, string, string, string]> = { // bg, fg, Hindi/first line, second line
  kirana: ['#c62828', '#ffe14d', 'किराना स्टोर', 'KIRANA STORE'], tea: ['#1b5e20', '#ffffff', 'चाय · नाश्ता', 'TEA STALL'],
  medical: ['#f5f5f2', '#0d47a1', 'MEDICAL STORE', 'दवाइयाँ'], auto: ['#0d47a1', '#ffffff', 'AUTO PARTS', 'ऑटो पार्ट्स'],
  puncture: ['#f9a825', '#111111', 'TYRE PUNCTURE', 'पंक्चर की दुकान'], dhaba: ['#e65100', '#fff3c4', 'HIGHWAY DHABA', 'शुद्ध शाकाहारी भोजन'],
  mobile: ['#6a1b9a', '#ffffff', 'MOBILE RECHARGE', 'मोबाइल · रिचार्ज'], hardware: ['#37474f', '#ffd54f', 'HARDWARE & PAINTS', 'हार्डवेयर'],
  sweets: ['#ad1457', '#ffffff', 'मिठाई भंडार', 'SWEETS'], tailor: ['#00695c', '#ffffff', 'TAILOR', 'दर्जी'],
  welcome: ['#1565c0', '#ffffff', 'सोनपुर में आपका स्वागत है', 'WELCOME TO SONPUR'], chakki: ['#ffeb3b', '#b71c1c', 'आटा चक्की', 'FLOUR MILL'],
};
const FONT = '"Nirmala UI", "Mangal", "Noto Sans Devanagari", "Segoe UI", sans-serif';

function makeAtlas(): THREE.CanvasTexture {
  const cv = document.createElement('canvas'); cv.width = cv.height = CELL * N;
  const g = cv.getContext('2d')!, rnd = mulberry(5);
  const at = (c: Cell, f: (w: number, h: number) => void) => { g.save(); g.translate(c[0] * CELL, c[1] * CELL); g.beginPath(); g.rect(0, 0, c[2] * CELL, c[3] * CELL); g.clip(); f(c[2] * CELL, c[3] * CELL); g.restore(); };
  const grime = (w: number, h: number, k = 1) => { // rain streaks from the top, splash dirt at the bottom, blotches
    for (let i = 0; i < 40 * k; i++) { g.fillStyle = `rgba(60,55,45,${0.04 + rnd() * 0.06})`; const x = rnd() * w, ww = 2 + rnd() * 10; g.fillRect(x, 0, ww, h * (0.15 + rnd() * 0.5)); }
    const gr = g.createLinearGradient(0, h * 0.8, 0, h); gr.addColorStop(0, 'rgba(110,90,60,0)'); gr.addColorStop(1, 'rgba(110,90,60,0.35)'); g.fillStyle = gr; g.fillRect(0, h * 0.8, w, h * 0.2);
    for (let i = 0; i < 25 * k; i++) { g.fillStyle = `rgba(${rnd() < 0.5 ? '90,85,75' : '255,255,250'},${0.04 + rnd() * 0.05})`; g.beginPath(); g.ellipse(rnd() * w, rnd() * h, 6 + rnd() * 30, 4 + rnd() * 20, rnd() * 3, 0, 7); g.fill(); }
  };
  const plaster = (w: number, h: number) => { g.fillStyle = '#ececea'; g.fillRect(0, 0, w, h); for (let i = 0; i < 2500; i++) { g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.08)'; g.fillRect(rnd() * w, rnd() * h, 2, 2); } grime(w, h); };
  at(C.plaster, plaster);
  at(C.window, (w, h) => { plaster(w, h); // window with a steel grille and a frame; the chhajja shadow on top
    g.fillStyle = '#2b3a40'; g.fillRect(w * 0.22, h * 0.25, w * 0.56, h * 0.42);
    g.fillStyle = 'rgba(140,190,200,0.35)'; g.fillRect(w * 0.24, h * 0.27, w * 0.24, h * 0.38); g.fillRect(w * 0.52, h * 0.27, w * 0.24, h * 0.38);
    g.strokeStyle = '#5b6b70'; g.lineWidth = 3; for (let x = w * 0.26; x < w * 0.78; x += w * 0.06) { g.beginPath(); g.moveTo(x, h * 0.25); g.lineTo(x, h * 0.67); g.stroke(); }
    g.strokeStyle = '#d9d4c7'; g.lineWidth = 8; g.strokeRect(w * 0.2, h * 0.23, w * 0.6, h * 0.46);
    const sh = g.createLinearGradient(0, 0, 0, h * 0.25); sh.addColorStop(0, 'rgba(0,0,0,0.35)'); sh.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = sh; g.fillRect(0, 0, w, h * 0.25); });
  at(C.door, (w, h) => { plaster(w, h); g.fillStyle = '#6d3f22'; g.fillRect(w * 0.25, h * 0.18, w * 0.5, h * 0.82); g.strokeStyle = '#4a2914'; g.lineWidth = 4; g.strokeRect(w * 0.3, h * 0.24, w * 0.18, h * 0.3); g.strokeRect(w * 0.52, h * 0.24, w * 0.18, h * 0.3); g.strokeRect(w * 0.3, h * 0.6, w * 0.18, h * 0.32); g.strokeRect(w * 0.52, h * 0.6, w * 0.18, h * 0.32); g.fillStyle = '#c9a54a'; g.fillRect(w * 0.47, h * 0.58, 8, 8); });
  at(C.shutter, (w, h) => { // rolling shutter, painted, with rust and a padlock
    g.fillStyle = '#9aa3a6'; g.fillRect(0, 0, w, h); for (let y = 0; y < h; y += 7) { g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(0, y, w, 2); g.fillStyle = 'rgba(255,255,255,0.15)'; g.fillRect(0, y + 3, w, 1); }
    g.fillStyle = '#5c6366'; g.fillRect(0, 0, 10, h); g.fillRect(w - 10, 0, 10, h); g.fillRect(0, h - 14, w, 14); g.fillStyle = '#c9a54a'; g.fillRect(w * 0.48, h - 26, 12, 14);
    for (let i = 0; i < 18; i++) { g.fillStyle = `rgba(120,60,20,${0.1 + rnd() * 0.2})`; g.fillRect(rnd() * w, h * (0.6 + rnd() * 0.4), 4 + rnd() * 20, 3 + rnd() * 18); } });
  at(C.shopOpen, (w, h) => { // open shop: dark interior, shelves of goods, a counter
    g.fillStyle = '#1c1915'; g.fillRect(0, 0, w, h);
    for (let y = h * 0.12; y < h * 0.7; y += h * 0.14) { g.fillStyle = '#5a4630'; g.fillRect(0, y + h * 0.1, w, 4); for (let x = 4; x < w - 8; x += 7 + rnd() * 8) { g.fillStyle = `hsl(${rnd() * 360},${50 + rnd() * 40}%,${30 + rnd() * 35}%)`; const bh = h * (0.04 + rnd() * 0.06); g.fillRect(x, y + h * 0.1 - bh, 5 + rnd() * 6, bh); } }
    g.fillStyle = '#7a5a3a'; g.fillRect(0, h * 0.72, w, h * 0.28); g.fillStyle = '#5c4329'; g.fillRect(0, h * 0.72, w, 6);
    for (let i = 0; i < 6; i++) { g.fillStyle = `hsl(${rnd() * 360},70%,50%)`; g.fillRect(w * (0.05 + rnd() * 0.85), h * 0.02, 10, h * 0.1); } }); // hanging sachets
  at(C.brick, (w, h) => { g.fillStyle = '#8a8070'; g.fillRect(0, 0, w, h); for (let y = 0, r = 0; y < h; y += 16, r++) for (let x = (r % 2) * -16; x < w; x += 32) { g.fillStyle = `hsl(${12 + rnd() * 10},${45 + rnd() * 15}%,${33 + rnd() * 12}%)`; g.fillRect(x + 1, y + 1, 30, 13); } grime(w, h, 0.5); });
  at(C.white, (w, h) => { g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, w, h); for (let i = 0; i < 800; i++) { g.fillStyle = 'rgba(0,0,0,0.04)'; g.fillRect(rnd() * w, rnd() * h, 3, 3); } });
  at(C.tin, (w, h) => { g.fillStyle = '#9aa4ab'; g.fillRect(0, 0, w, h); for (let x = 0; x < w; x += 12) { g.fillStyle = 'rgba(255,255,255,0.18)'; g.fillRect(x, 0, 4, h); g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(x + 7, 0, 3, h); } for (let i = 0; i < 30; i++) { g.fillStyle = `rgba(130,60,20,${0.15 + rnd() * 0.3})`; g.beginPath(); g.ellipse(rnd() * w, rnd() * h, 4 + rnd() * 18, 3 + rnd() * 10, 0, 0, 7); g.fill(); } });
  at(C.gate, (w, h) => { g.fillStyle = '#2f3b33'; g.fillRect(0, 0, w, h); g.fillStyle = '#4d6b58'; for (let x = 6; x < w; x += 18) g.fillRect(x, 0, 6, h); g.fillRect(0, h * 0.1, w, 8); g.fillRect(0, h * 0.85, w, 8); });
  at(C.templeDoor, (w, h) => { g.fillStyle = '#f08a3c'; g.fillRect(0, 0, w, h); g.fillStyle = '#7a1e12'; g.beginPath(); g.moveTo(w * 0.28, h); g.lineTo(w * 0.28, h * 0.4); g.quadraticCurveTo(w * 0.5, h * 0.12, w * 0.72, h * 0.4); g.lineTo(w * 0.72, h); g.fill(); g.fillStyle = '#ffcc33'; g.beginPath(); g.arc(w * 0.5, h * 0.62, 10, 0, 7); g.fill(); g.strokeStyle = '#ffffff'; g.lineWidth = 6; g.beginPath(); g.moveTo(w * 0.22, h); g.lineTo(w * 0.22, h * 0.38); g.quadraticCurveTo(w * 0.5, h * 0.04, w * 0.78, h * 0.38); g.lineTo(w * 0.78, h); g.stroke(); });
  at(C.charpai, (w, h) => { g.fillStyle = '#c9b27a'; g.fillRect(0, 0, w, h); g.strokeStyle = '#8c7448'; g.lineWidth = 3; for (let k = -w; k < w * 2; k += 10) { g.beginPath(); g.moveTo(k, 0); g.lineTo(k + h, h); g.stroke(); g.beginPath(); g.moveTo(k, h); g.lineTo(k + h, 0); g.stroke(); } });
  at(C.tank, (w, h) => { g.fillStyle = '#1e1f21'; g.fillRect(0, 0, w, h); for (let y = 10; y < h; y += 28) { g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, y, w, 6); } });
  const stoneFace = (top: string, l1: string, l2: string) => (w: number, h: number) => {
    g.fillStyle = '#f4f2ea'; g.fillRect(0, 0, w, h); g.fillStyle = top; g.fillRect(0, 0, w, h * 0.38);
    g.fillStyle = top === '#1f6b2e' || top === '#1d2a6b' ? '#ffffff' : '#111'; g.textAlign = 'center'; g.font = `bold ${h * 0.13}px ${FONT}`; g.fillText(l1, w / 2, h * 0.27);
    g.fillStyle = '#111'; g.font = `bold ${h * 0.16}px ${FONT}`; g.fillText(l2.split('|')[0], w / 2, h * 0.6); g.font = `bold ${h * 0.22}px ${FONT}`; g.fillText(l2.split('|')[1] ?? '', w / 2, h * 0.86); grime(w, h, 0.4);
  };
  at(C.stoneSH, stoneFace('#1f6b2e', 'SH 12', 'SONPUR|1'));
  at(C.stoneDistrict, stoneFace('#1d2a6b', 'MDR', 'SONPUR|0'));
  for (const [n, c] of Object.entries(HM)) at(c, (w, h) => { g.fillStyle = '#f4f2ea'; g.fillRect(0, 0, w, h); g.fillStyle = '#111'; g.textAlign = 'center'; g.font = `bold ${h * 0.55}px ${FONT}`; g.fillText(n, w / 2, h * 0.72); });
  at(C.ad, (w, h) => { plaster(w, h); g.fillStyle = '#b71c1c'; g.textAlign = 'center'; g.font = `bold ${h * 0.15}px ${FONT}`; g.fillText('ट्यूशन सेंटर', w / 2, h * 0.3); g.fillStyle = '#0d47a1'; g.font = `bold ${h * 0.12}px ${FONT}`; g.fillText('TUITION CENTRE', w / 2, h * 0.5); g.fillStyle = '#1b5e20'; g.font = `bold ${h * 0.1}px ${FONT}`; g.fillText('CLASS 1 – 10', w / 2, h * 0.68); grime(w, h, 0.6); });
  for (const id of SIGNS) at(signCell(id), (w, h) => { // hand-painted signboard
    const [bg, fg, a, b] = SIGN_STYLE[id];
    g.fillStyle = bg; g.fillRect(0, 0, w, h); g.strokeStyle = fg; g.lineWidth = 10; g.strokeRect(12, 12, w - 24, h - 24);
    g.fillStyle = fg; g.textAlign = 'center'; g.textBaseline = 'middle';
    const fit = (t: string, px: number, y: number) => { g.font = `bold ${px}px ${FONT}`; const m = g.measureText(t).width; if (m > w - 70) g.font = `bold ${px * (w - 70) / m}px ${FONT}`; g.fillText(t, w / 2, y); };
    fit(a, h * 0.36, h * 0.38); fit(b, h * 0.24, h * 0.73);
    if (id === 'medical') { g.fillStyle = '#2e7d32'; g.fillRect(40, h * 0.3, 60, 20); g.fillRect(60, h * 0.3 - 20, 20, 60); g.fillRect(w - 100, h * 0.3, 60, 20); g.fillRect(w - 80, h * 0.3 - 20, 20, 60); }
    g.textBaseline = 'alphabetic'; grime(w, h, 0.5);
  });
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.generateMipmaps = true;
  return t;
}

// ---------------- geometry builder ----------------
type V3 = [number, number, number];
const hexLin = (hex: number): V3 => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255].map(c => Math.pow(c, 2.2)) as V3;
const COL: Record<string, V3> = {};
const col = (hex: number) => (COL[hex] ??= hexLin(hex));
const INSET = 3 / (CELL * N);

class GB {
  pos: number[] = []; nor: number[] = []; uv: number[] = []; col: number[] = [];
  mark() { return this.pos.length / 3; }
  /** Quad a→b→c→d counter-clockwise seen from the front; the cell's (0,0)…(1,1) maps a→b→c→d. */
  quad(a: V3, b: V3, c: V3, d: V3, cell: Cell, colour: V3, uvs: [number, number, number, number] = [0, 0, 1, 1]) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const u0 = (cell[0] + uvs[0] * cell[2]) / N, u1 = (cell[0] + uvs[2] * cell[2]) / N, v0 = 1 - (cell[1] + (1 - uvs[1]) * cell[3]) / N, v1 = 1 - (cell[1] + (1 - uvs[3]) * cell[3]) / N;
    const U0 = u0 + INSET, U1 = u1 - INSET, V0 = v0 + INSET, V1 = v1 - INSET;
    const P = [a, b, c, a, c, d], T = [[U0, V0], [U1, V0], [U1, V1], [U0, V0], [U1, V1], [U0, V1]];
    for (let i = 0; i < 6; i++) { this.pos.push(...P[i]); this.nor.push(nx, ny, nz); this.uv.push(T[i][0], T[i][1]); this.col.push(...colour); }
  }
  /** Axis-aligned box; `face(k)` gives [cell, colour] for faces +X −X +Y −Y +Z −Z, or null to leave a face out. */
  box(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, face: (k: number) => [Cell, V3] | null) {
    const F: [V3, V3, V3, V3][] = [
      [[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]],
      [[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
      [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]],
    ];
    for (let k = 0; k < 6; k++) { const f = face(k); if (f) this.quad(...F[k], f[0], f[1]); }
  }
  solid(x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, colour: V3, cell: Cell = C.white, bottom = false) { this.box(x0, x1, y0, y1, z0, z1, k => (k === 3 && !bottom ? null : [cell, colour])); }
  /** Vertical cylinder (flat-ish shading per segment), optional top cap. */
  cyl(cx: number, cz: number, y0: number, y1: number, r0: number, r1: number, seg: number, cell: Cell, colour: V3, cap = true) {
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2, b = ((i + 1) / seg) * Math.PI * 2;
      this.quad([cx + Math.sin(a) * r0, y0, cz + Math.cos(a) * r0], [cx + Math.sin(b) * r0, y0, cz + Math.cos(b) * r0], [cx + Math.sin(b) * r1, y1, cz + Math.cos(b) * r1], [cx + Math.sin(a) * r1, y1, cz + Math.cos(a) * r1], cell, colour, [i / seg, 0, (i + 1) / seg, 1]);
      if (cap && r1 > 0) { const c: V3 = [cx, y1, cz]; this.tri(c, [cx + Math.sin(a) * r1, y1, cz + Math.cos(a) * r1], [cx + Math.sin(b) * r1, y1, cz + Math.cos(b) * r1], cell, colour); }
    }
  }
  tri(a: V3, b: V3, c: V3, cell: Cell, colour: V3) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
    const u = (cell[0] + 0.5 * cell[2]) / N, v = 1 - (cell[1] + 0.5 * cell[3]) / N;
    for (const p of [a, b, c]) { this.pos.push(...p); this.nor.push(nx, ny, nz); this.uv.push(u, v); this.col.push(...colour); }
  }
  /** Square frustum / pyramid (r1 = 0) on y0..y1. */
  frustum(cx: number, cz: number, y0: number, y1: number, h0: number, h1: number, colour: V3) {
    const c0: V3[] = [[cx - h0, y0, cz + h0], [cx + h0, y0, cz + h0], [cx + h0, y0, cz - h0], [cx - h0, y0, cz - h0]];
    const c1: V3[] = [[cx - h1, y1, cz + h1], [cx + h1, y1, cz + h1], [cx + h1, y1, cz - h1], [cx - h1, y1, cz - h1]];
    for (let i = 0; i < 4; i++) { const j = (i + 1) % 4; if (h1 > 0) this.quad(c0[i], c0[j], c1[j], c1[i], C.white, colour); else this.tri(c0[i], c0[j], [cx, y1, cz], C.white, colour); }
    if (h1 > 0) this.quad(c1[0], c1[1], c1[2], c1[3], C.white, colour);
  }
  /** Low-poly crown: a flat-shaded icosahedron. */
  blob(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, colour: V3, rnd: () => number) {
    const ico = new THREE.IcosahedronGeometry(1, 0), p = ico.getAttribute('position');
    for (let i = 0; i < p.count; i += 3) {
      const v: V3[] = [0, 1, 2].map(k => { const j = (i + k); return [cx + p.getX(j) * sx, cy + p.getY(j) * sy, cz + p.getZ(j) * sz] as V3; });
      const s = 0.85 + rnd() * 0.3; this.tri(v[0], v[1], v[2], C.white, [colour[0] * s, colour[1] * s, colour[2] * s]);
    }
    ico.dispose();
  }
  /** Rotate (about +Y) and move the vertices added since mark m. */
  place(m: number, x: number, y: number, z: number, yaw: number) {
    const c = Math.cos(yaw), s = Math.sin(yaw);
    for (let i = m * 3; i < this.pos.length; i += 3) {
      const px = this.pos[i], pz = this.pos[i + 2]; this.pos[i] = x + px * c + pz * s; this.pos[i + 1] += y; this.pos[i + 2] = z - px * s + pz * c;
      const nx = this.nor[i], nz = this.nor[i + 2]; this.nor[i] = nx * c + nz * s; this.nor[i + 2] = -nx * s + nz * c;
    }
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere(); return g;
  }
}

// ---------------- structures (local frame: facade at z = 0 facing +Z, building behind it, y relative to the floor) ----------------
const CEMENT = col(0xb3ada3), CONCRETE = col(0x9d978d), DARK = col(0x3a3a3a), RUST = col(0x7a4426), WHITE = col(0xf2f2f2), BARK = col(0x5b4330);
const SHUTTER_PAINT = [0xb8c4c8, 0x8fb39a, 0x8aa6c4, 0xc9c1a0, 0xa0a8ac];
function shade(c: V3, k: number): V3 { return [c[0] * k, c[1] * k, c[2] * k]; }

function house(gb: GB, b: Building) {
  const rnd = mulberry(b.seed), paint = col(b.paint), side = col(b.side), w = b.w, D = b.depth, hw = w / 2;
  const fl = (i: number) => (i === 0 ? 0 : 3.2 + (i - 1) * 3.0), fh = (i: number) => (i === 0 ? 3.2 : 3.0);
  const H = fl(b.floors);
  const m = gb.mark(), y0 = b.base - 0.3 - b.floor; // plinth from below the lowest ground to the floor
  const otla = b.kind === 'shop' ? 0.9 : 0;
  gb.solid(-hw - 0.05, hw + 0.05, y0, 0, -D - 0.05, 0.05 + otla, CONCRETE, C.plaster);
  if (!otla) { gb.solid(-0.7, 0.7, y0, -0.15, 0.05, 0.4, CONCRETE, C.plaster); gb.solid(-0.7, 0.7, y0, -0.3, 0.4, 0.75, CONCRETE, C.plaster); } // two steps up to the door
  for (let i = 0; i < b.floors; i++) {
    const ya = fl(i), yb = ya + fh(i), nb = Math.max(1, Math.round(w / 2.6)), bw = w / nb;
    for (let k = 0; k < nb; k++) {
      let cell: Cell = C.window, c = paint;
      if (i === 0) {
        if (b.kind === 'shop' && k < b.shops) { const open = rnd() < 0.55; cell = open ? C.shopOpen : C.shutter; c = open ? WHITE : col(SHUTTER_PAINT[Math.floor(rnd() * SHUTTER_PAINT.length)]); }
        else cell = k === (b.kind === 'shop' ? b.shops : Math.floor(nb / 2)) ? C.door : rnd() < 0.7 ? C.window : C.plaster;
      } else cell = rnd() < 0.8 ? C.window : C.plaster;
      const xa = -hw + k * bw, xb = xa + bw;
      gb.quad([xa, ya, 0], [xb, ya, 0], [xb, yb, 0], [xa, yb, 0], cell, c);
    }
    // side and back walls: unpainted cement on many houses (only the front is painted)
    const adHere = i === b.floors - 1 && rnd() < 0.12;
    gb.quad([hw, ya, 0], [hw, ya, -D], [hw, yb, -D], [hw, yb, 0], adHere ? C.ad : b.side === b.paint ? C.plaster : rnd() < 0.3 ? C.brick : C.plaster, adHere || (b.side !== b.paint && rnd() < 0.3) ? WHITE : side);
    gb.quad([-hw, ya, -D], [-hw, ya, 0], [-hw, yb, 0], [-hw, yb, -D], C.plaster, side);
    gb.quad([hw, ya, -D], [-hw, ya, -D], [-hw, yb, -D], [hw, yb, -D], C.plaster, side);
    // chhajja (concrete sunshade) over the openings, or a tin awning over the shop shutters
    if (i === 0 && b.kind === 'shop') {
      if (rnd() < 0.55) { const tc = col([0x7f8c94, 0x3f6f8f, 0x8a4b2a, 0x4f7a54][Math.floor(rnd() * 4)]); gb.quad([-hw, 2.35, 0], [hw, 2.35, 0], [hw, 2.15, 1.25], [-hw, 2.15, 1.25], C.tin, shade(tc, 0.6)); gb.quad([-hw, 2.15, 1.25], [hw, 2.15, 1.25], [hw, 2.35, 0], [-hw, 2.35, 0], C.tin, tc); } // underside, top
      else gb.solid(-hw - 0.05, hw + 0.05, 2.28, 2.36, 0, 0.6, shade(paint, 0.9), C.plaster, true);
      if (b.sign) gb.box(-hw + 0.1, hw - 0.1, 2.42, 3.12, 0, 0.08, k => k === 4 ? [signCell(b.sign!), WHITE] : [C.plaster, shade(paint, 0.8)]);
    } else gb.solid(-hw - 0.05, hw + 0.05, ya + 2.22, ya + 2.3, 0, 0.5, shade(paint, 0.92), C.plaster, true);
    // floor slab edge band between storeys
    gb.solid(-hw - 0.04, hw + 0.04, yb - 0.02, yb + 0.15, -D - 0.04, 0.04, shade(paint, 0.85), C.plaster, i > 0);
    if (i > 0 && b.balcony && rnd() < 0.7) { const bwid = w * 0.6; gb.solid(-bwid / 2, bwid / 2, ya - 0.05, ya + 0.08, 0, 1.0, shade(paint, 0.85), C.plaster, true); gb.solid(-bwid / 2, bwid / 2, ya + 0.08, ya + 1.0, 0.92, 1.02, paint, C.plaster); gb.solid(-bwid / 2, -bwid / 2 + 0.1, ya + 0.08, ya + 1.0, 0, 0.92, paint); gb.solid(bwid / 2 - 0.1, bwid / 2, ya + 0.08, ya + 1.0, 0, 0.92, paint); }
  }
  // roof: slab top, parapet, then a stair cabin (mumty), a black water tank, and rebar left for the next floor
  gb.quad([-hw, H + 0.15, 0], [hw, H + 0.15, 0], [hw, H + 0.15, -D], [-hw, H + 0.15, -D], C.plaster, CEMENT);
  const pt = 0.12, ph = H + 0.15 + 0.9, pc = b.side;
  gb.solid(-hw, hw, H + 0.15, ph, -pt, 0, paint); gb.solid(-hw, hw, H + 0.15, ph, -D, -D + pt, col(pc));
  gb.solid(-hw, -hw + pt, H + 0.15, ph, -D, 0, col(pc)); gb.solid(hw - pt, hw, H + 0.15, ph, -D, 0, col(pc));
  let tx = hw - 1.0, tz = -D + 1.0, ty = H + 0.15;
  if (b.mumty) {
    const mx0 = -hw + 0.15, mx1 = Math.min(hw - 0.15, mx0 + 2.6), mz0 = -D + 0.15, mz1 = mz0 + 2.8;
    gb.box(mx0, mx1, H + 0.15, H + 2.65, mz0, mz1, k => k === 3 ? null : k === 4 ? [C.door, col(pc)] : k === 2 ? [C.plaster, CEMENT] : [C.plaster, col(pc)]);
    tx = (mx0 + mx1) / 2; tz = (mz0 + mz1) / 2; ty = H + 2.65;
  }
  if (b.tank) { gb.solid(tx - 0.45, tx + 0.45, ty, ty + 0.35, tz - 0.45, tz + 0.45, DARK); gb.cyl(tx, tz, ty + 0.35, ty + 1.45, 0.55, 0.55, 10, C.tank, WHITE); gb.cyl(tx, tz, ty + 1.45, ty + 1.6, 0.55, 0.2, 10, C.tank, WHITE); }
  if (b.rebar) for (const [cx, cz] of [[-hw + 0.25, -0.25], [hw - 0.25, -0.25], [-hw + 0.25, -D + 0.25], [hw - 0.25, -D + 0.25], [0, -0.25]] as [number, number][]) {
    gb.solid(cx - 0.15, cx + 0.15, H + 0.15, H + 0.45, cz - 0.15, cz + 0.15, CONCRETE);
    for (const [ox, oz] of [[-0.09, -0.09], [0.09, -0.09], [-0.09, 0.09], [0.09, 0.09]]) gb.solid(cx + ox - 0.012, cx + ox + 0.012, H + 0.45, H + 1.15 + rnd() * 0.3, cz + oz - 0.012, cz + oz + 0.012, RUST);
  }
  gb.place(m, b.x, b.floor, b.z, b.yaw);
}

function stall(gb: GB, b: Building) {
  const m = gb.mark(), w = b.w, D = b.depth, hw = w / 2, paint = col(b.paint);
  gb.solid(-hw, hw, b.base - 0.3 - b.floor, 0, -D, 0.1, CONCRETE);
  gb.box(-hw, hw, 0, 2.3, -D, 0, k => k === 4 ? [C.shopOpen, WHITE] : k === 2 ? null : [C.plaster, paint]);
  gb.quad([-hw - 0.3, 2.5, -D - 0.2], [-hw - 0.3, 2.3, 1.0], [hw + 0.3, 2.3, 1.0], [hw + 0.3, 2.5, -D - 0.2], C.tin, col(0x8a9399));
  gb.quad([hw + 0.3, 2.5, -D - 0.2], [hw + 0.3, 2.3, 1.0], [-hw - 0.3, 2.3, 1.0], [-hw - 0.3, 2.5, -D - 0.2], C.tin, col(0x5a6066));
  if (b.sign) gb.box(-hw, hw, 2.5, 3.05, 0.9, 1.0, k => (k === 4 ? [signCell(b.sign!), WHITE] : [C.white, DARK]));
  for (const x of [-hw - 0.2, hw + 0.2]) gb.solid(x - 0.04, x + 0.04, 0, 2.5, 0.9, 0.98, DARK);
  gb.solid(-hw + 0.2, hw - 0.2, 0, 0.45, 1.3, 1.65, col(0x7a5a3a)); // bench
  gb.place(m, b.x, b.floor, b.z, b.yaw);
}

function dhaba(gb: GB, b: Building) {
  const m = gb.mark(), w = b.w, D = b.depth, hw = w / 2, paint = col(b.paint), rnd = mulberry(b.seed);
  gb.solid(-hw - 0.1, hw + 0.1, b.base - 0.3 - b.floor, 0, -D, 0.1, CONCRETE, C.plaster);
  const kd = 3.4; // kitchen block at the back
  gb.box(-hw, hw, 0, 3.0, -D, -D + kd, k => k === 4 ? [C.door, paint] : k === 3 ? null : k === 2 ? [C.plaster, CEMENT] : [rnd() < 0.5 ? C.brick : C.plaster, rnd() < 0.5 ? WHITE : paint]);
  for (let x = -hw; x <= hw + 1e-6; x += w / 4) for (const z of [-0.2, -(D - kd) / 2 - 0.2]) gb.solid(x - 0.06, x + 0.06, 0, 3.3, z - 0.06, z + 0.06, DARK);
  const tc = col(0x8f9aa1);
  gb.quad([-hw - 0.4, 3.3, 0.6], [hw + 0.4, 3.3, 0.6], [hw + 0.4, 3.7, -D + kd], [-hw - 0.4, 3.7, -D + kd], C.tin, tc);
  gb.quad([-hw - 0.4, 3.7, -D + kd], [hw + 0.4, 3.7, -D + kd], [hw + 0.4, 3.3, 0.6], [-hw - 0.4, 3.3, 0.6], C.tin, shade(tc, 0.55));
  gb.box(-hw * 0.8, hw * 0.8, 3.75, 4.75, 0.45, 0.55, k => (k === 4 ? [signCell('dhaba'), WHITE] : [C.white, DARK]));
  for (const x of [-hw * 0.6, hw * 0.6]) gb.solid(x - 0.04, x + 0.04, 3.3, 3.8, 0.46, 0.54, DARK);
  gb.cyl(hw - 1.2, -D + kd + 0.8, 0, 0.8, 0.45, 0.35, 10, C.white, col(0xa0603a)); // tandoor
  gb.solid(-hw + 0.5, -hw + 2.5, 0, 0.8, -D + kd + 0.3, -D + kd + 1.0, col(0x6b5a48)); // counter
  for (let k = 0; k < 4; k++) { const x = -hw + 2 + k * 2.6; gb.solid(x - 0.6, x + 0.6, 0, 0.75, -3.4, -2.6, col(0x7a5a3a)); } // tables
  gb.place(m, b.x, b.floor, b.z, b.yaw);
}

function shrine(gb: GB, b: Building) {
  const m = gb.mark(), saffron = col(b.paint);
  gb.solid(-2.0, 2.0, b.base - 0.3 - b.floor, 0, -3.3, 0.7, WHITE, C.plaster);
  gb.solid(-0.6, 0.6, b.base - 0.3 - b.floor, -0.3, 0.7, 1.2, WHITE); // step
  gb.box(-1.3, 1.3, 0, 2.2, -2.6, 0, k => k === 4 ? [C.templeDoor, WHITE] : k === 3 ? null : [C.plaster, saffron]);
  gb.solid(-1.45, 1.45, 2.2, 2.38, -2.75, 0.15, WHITE);
  gb.frustum(0, -1.3, 2.38, 3.6, 1.2, 0.75, saffron); gb.frustum(0, -1.3, 3.6, 4.4, 0.75, 0, WHITE);
  gb.cyl(0, -1.3, 4.3, 4.6, 0.12, 0.05, 6, C.white, col(0xd4a017));
  gb.solid(1.6, 1.66, 0, 4.5, -2.9, -2.84, DARK); // flag pole and a saffron pennant
  gb.tri([1.63, 4.5, -2.87], [1.63, 3.95, -2.87], [2.6, 4.25, -2.87], C.white, col(0xff8c1a)); gb.tri([1.63, 4.5, -2.87], [2.6, 4.25, -2.87], [1.63, 3.95, -2.87], C.white, col(0xff8c1a));
  gb.place(m, b.x, b.floor, b.z, b.yaw);
}

export interface RoadsideVisual { group: THREE.Group; stats: { meshes: number; tris: number; buildings: number } }

export function buildRoadside(): RoadsideVisual {
  const group = new THREE.Group(); group.name = 'roadside';
  const chunkOf = (z: number) => (z < 500 ? 0 : z < 1000 ? 1 : z < 1210 ? 2 : 3);
  const gbs = [new GB(), new GB(), new GB(), new GB()];
  const rnd = mulberry(77);
  for (const b of LAYOUT.buildings) { const gb = gbs[chunkOf(b.z)]; if (b.kind === 'stall') stall(gb, b); else if (b.kind === 'dhaba') dhaba(gb, b); else if (b.kind === 'shrine') shrine(gb, b); else house(gb, b); }
  for (const w of LAYOUT.walls) {
    const gb = gbs[chunkOf((w.z0 + w.z1) / 2)], m = gb.mark(), len = Math.hypot(w.x1 - w.x0, w.z1 - w.z0), c = w.brick ? WHITE : col(w.paint), cell = w.brick ? C.brick : C.plaster;
    gb.box(-len / 2, len / 2, 0, 0.15 + w.h, -w.t / 2, w.t / 2, k => (k === 3 ? null : k === 2 ? [C.plaster, CEMENT] : [cell, c]));
    gb.solid(-len / 2 - 0.02, len / 2 + 0.02, 0.15 + w.h, 0.22 + w.h, -w.t / 2 - 0.03, w.t / 2 + 0.03, CEMENT);
    for (const e of [-len / 2, len / 2]) gb.solid(e - 0.18, e + 0.18, 0, w.h + 0.45, -0.18, 0.18, c, cell);
    gb.place(m, (w.x0 + w.x1) / 2, w.base, (w.z0 + w.z1) / 2, Math.atan2(-(w.z1 - w.z0), w.x1 - w.x0));
  }
  for (const p of LAYOUT.poles) {
    const gb = gbs[chunkOf(p.z)], m = gb.mark();
    gb.solid(-0.09, 0.09, -0.3, p.h, -0.12, 0.12, CONCRETE, C.plaster);
    gb.solid(-p.arm / 2 - 0.2, p.arm / 2 + 0.2, p.h - 0.35, p.h - 0.25, -0.05, 0.05, DARK);
    for (const o of [-0.75, 0, 0.75]) gb.solid(o - 0.04, o + 0.04, p.h - 0.25, p.h - 0.1, -0.04, 0.04, WHITE);
    if (p.transformer) { gb.solid(-0.9, 0.9, 3.2, 3.3, -0.6, 0.6, DARK); gb.solid(-0.55, 0.55, 3.3, 4.5, -0.4, 0.4, col(0x7d8a7a)); for (const o of [-0.3, 0, 0.3]) gb.solid(o - 0.04, o + 0.04, 4.5, 4.8, -0.04, 0.04, WHITE); }
    gb.place(m, p.x, p.base, p.z, 0);
  }
  for (const t of LAYOUT.trees) {
    const gb = gbs[chunkOf(t.z)], s = t.s, big = t.kind === 'peepal', h = (big ? 3.2 : 2.4) * s, r = (big ? 0.38 : 0.18) * s;
    if (t.painted) { gb.cyl(t.x, t.z, t.base - 0.1, t.base + 1.0, r, r * 0.97, 7, C.white, WHITE, false); gb.cyl(t.x, t.z, t.base + 1.0, t.base + 1.2, r * 0.97, r * 0.96, 7, C.white, col(0xc62828), false); gb.cyl(t.x, t.z, t.base + 1.2, t.base + h, r * 0.96, r * 0.6, 7, C.white, BARK, false); }
    else gb.cyl(t.x, t.z, t.base - 0.1, t.base + h, r * 1.1, r * 0.6, 7, C.white, BARK, false);
    const green = col(big ? 0x3d6b2a : rnd() < 0.5 ? 0x46702c : 0x557a33);
    gb.blob(t.x, t.base + h + 1.3 * s, t.z, 2.3 * s * (big ? 1.6 : 1), 1.6 * s * (big ? 1.3 : 1), 2.3 * s * (big ? 1.6 : 1), green, rnd);
    gb.blob(t.x + 0.9 * s, t.base + h + 0.6 * s, t.z - 0.7 * s, 1.5 * s * (big ? 1.5 : 1), 1.1 * s, 1.5 * s * (big ? 1.5 : 1), shade(green, 0.9), rnd);
    if (big) { gb.cyl(t.x, t.z, t.base - 0.2, t.base + 0.5, 2.4, 2.4, 10, C.plaster, CEMENT, true); } // chabutra platform
  }
  for (const st of LAYOUT.stones) {
    const gb = gbs[chunkOf(st.z)], m = gb.mark();
    if (st.kind === 'hm') { gb.solid(-0.14, 0.14, -0.15, 0.32, -0.08, 0.08, WHITE); gb.box(-0.13, 0.13, 0.05, 0.31, -0.081, 0.081, k => (k === 4 || k === 5 ? [HM[st.label], WHITE] : null)); gb.solid(-0.14, 0.14, 0.32, 0.4, -0.08, 0.08, col(0xd84315)); }
    else {
      const face = st.kind === 'sh' ? C.stoneSH : C.stoneDistrict, top = col(st.kind === 'sh' ? 0x1f6b2e : 0x1d2a6b);
      gb.solid(-0.4, 0.4, -0.2, 0.08, -0.22, 0.22, CONCRETE);
      gb.box(-0.27, 0.27, 0.08, 0.68, -0.12, 0.12, k => (k === 4 || k === 5 ? [face, WHITE] : k === 2 || k === 3 ? null : [C.white, WHITE]));
      for (let i = 0; i < 8; i++) { const a = (i / 8) * Math.PI, b2 = ((i + 1) / 8) * Math.PI; const p = (aa: number, z: number): V3 => [-Math.cos(aa) * 0.27, 0.68 + Math.sin(aa) * 0.27, z]; gb.quad(p(a, 0.12), p(b2, 0.12), p(b2, -0.12), p(a, -0.12), C.white, top); gb.tri([0, 0.68, 0.12], p(b2, 0.12), p(a, 0.12), C.white, top); gb.tri([0, 0.68, -0.12], p(a, -0.12), p(b2, -0.12), C.white, top); }
    }
    gb.place(m, st.x, st.base, st.z, st.yaw);
  }
  for (const bd of LAYOUT.boards) {
    const gb = gbs[chunkOf(bd.z)], m = gb.mark();
    for (const x of [-bd.w * 0.4, bd.w * 0.4]) gb.cyl(x, 0, -0.2, bd.post + bd.h, 0.05, 0.05, 6, C.white, col(0x9aa0a6), false);
    gb.box(-bd.w / 2, bd.w / 2, bd.post, bd.post + bd.h, -0.04, 0.04, k => (k === 4 || k === 5 ? [signCell(bd.sign), WHITE] : [C.white, col(0x9aa0a6)]));
    gb.place(m, bd.x, bd.base, bd.z, bd.yaw);
  }
  for (const c of LAYOUT.cots) {
    const gb = gbs[chunkOf(c.z)], m = gb.mark(), wood = col(0x6b4a2a);
    for (const [x, z] of [[-0.9, -0.4], [0.9, -0.4], [-0.9, 0.4], [0.9, 0.4]]) gb.solid(x - 0.04, x + 0.04, 0, 0.45, z - 0.04, z + 0.04, wood);
    gb.solid(-0.95, 0.95, 0.4, 0.46, -0.45, -0.39, wood); gb.solid(-0.95, 0.95, 0.4, 0.46, 0.39, 0.45, wood);
    gb.quad([-0.9, 0.44, 0.4], [0.9, 0.44, 0.4], [0.9, 0.44, -0.4], [-0.9, 0.44, -0.4], C.charpai, WHITE);
    gb.place(m, c.x, c.base, c.z, c.yaw);
  }
  const mat = new THREE.MeshStandardMaterial({ map: makeAtlas(), vertexColors: true, roughness: 0.9, metalness: 0 });
  let tris = 0;
  for (const gb of gbs) { if (!gb.pos.length) continue; const mesh = new THREE.Mesh(gb.geometry(), mat); mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh); tris += gb.pos.length / 9; }
  // overhead wires: one line mesh
  const wp = new Float32Array(LAYOUT.wires.length * 6); LAYOUT.wires.forEach((s, i) => wp.set(s, i * 6));
  const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.BufferAttribute(wp, 3)); wg.computeBoundingSphere();
  group.add(new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x1b1b1b })));
  return { group, stats: { meshes: group.children.length, tris: Math.round(tris), buildings: LAYOUT.buildings.length } };
}
