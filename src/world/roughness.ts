// Road roughness: unit profiles synthesised from the ISO 8608 displacement PSD, and the IRI quarter-car filter
// used to scale and check them. DOM-free (runs in node tools and in the browser).
//   ISO 8608: Gd(n) = Gd(n0) · (n / n0)^-w, n0 = 0.1 cycle/m, w = 2   [S: C-032 Eq 9]
//   IRI: "golden car" quarter car at 80 km/h, ASTM E1926 (k1 653, k2 63.3, c 6.0, mu 0.15, 250 mm moving average).
import { mulberry } from './noise';

/** In-place iterative radix-2 complex FFT (sign −1 forward, +1 inverse, unnormalised). */
function fft(re: Float64Array, im: Float64Array, sign: number) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
}

/**
 * Random profile (metres) with the ISO 8608 slope (w = 2) between wavelengths lMin and lMax, n = 2^k samples at step dx.
 * Gd(n0) = 1e-6 m³; callers rescale to the IRI they want.
 */
export function synthProfile(log2n: number, dx: number, lMin: number, lMax: number, seed: number) {
  const n = 1 << log2n, L = n * dx, rnd = mulberry(seed);
  const re = new Float64Array(n), im = new Float64Array(n);
  const G0 = 1e-6, n0 = 0.1, dn = 1 / L;
  for (let k = 1; k < n / 2; k++) {
    const f = k / L; if (f < 1 / lMax || f > 1 / lMin) continue;
    const edge = Math.max(0, Math.min(1, 2 * Math.log2(f * lMax), 2 * Math.log2(1 / (f * lMin)))); // half-octave fade
    const amp = Math.sqrt(2 * G0 * Math.pow(f / n0, -2) * dn) * edge;
    const ph = rnd() * 2 * Math.PI;
    re[k] = (amp / 2) * Math.cos(ph); im[k] = (amp / 2) * Math.sin(ph);
    re[n - k] = re[k]; im[n - k] = -im[k];
  }
  fft(re, im, +1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = re[i];
  return out;
}

/**
 * IRI (m/km) of a profile sampled at dx from index i0 to i1 (ASTM E1926 style: 250 mm moving average,
 * initial state from the 11 m slope, 4 RK4 sub-steps per sample).
 */
export function iri(get: (i: number) => number, dx: number, i0: number, i1: number) {
  const V = 80 / 3.6, k1 = 653, k2 = 63.3, c = 6.0, mu = 0.15;
  const nb = Math.max(1, Math.round(0.25 / dx));
  const y = (i: number) => { let s = 0; for (let k = 0; k < nb; k++) s += get(i + k); return s / nb; }; // 250 mm moving average
  const n11 = Math.round(11 / dx);
  const slope0 = (y(i0 + n11) - y(i0)) / (n11 * dx);
  let zs = y(i0), vs = slope0 * V, zu = zs, vu = vs, sum = 0;
  const sub = 4, h = dx / V / sub;
  const f = (zs_: number, vs_: number, zu_: number, vu_: number, yr: number) => {
    const as = -k2 * (zs_ - zu_) - c * (vs_ - vu_);
    const au = (k2 * (zs_ - zu_) + c * (vs_ - vu_) - k1 * (zu_ - yr)) / mu;
    return [vs_, as, vu_, au];
  };
  for (let i = i0; i < i1; i++) {
    const ya = y(i), yb = y(i + 1);
    for (let s = 0; s < sub; s++) {
      const r0 = ya + (yb - ya) * (s / sub), rm = ya + (yb - ya) * ((s + 0.5) / sub), r1 = ya + (yb - ya) * ((s + 1) / sub);
      const a = f(zs, vs, zu, vu, r0);
      const b = f(zs + a[0] * h / 2, vs + a[1] * h / 2, zu + a[2] * h / 2, vu + a[3] * h / 2, rm);
      const cc = f(zs + b[0] * h / 2, vs + b[1] * h / 2, zu + b[2] * h / 2, vu + b[3] * h / 2, rm);
      const d = f(zs + cc[0] * h, vs + cc[1] * h, zu + cc[2] * h, vu + cc[3] * h, r1);
      zs += (a[0] + 2 * b[0] + 2 * cc[0] + d[0]) * h / 6; vs += (a[1] + 2 * b[1] + 2 * cc[1] + d[1]) * h / 6;
      zu += (a[2] + 2 * b[2] + 2 * cc[2] + d[2]) * h / 6; vu += (a[3] + 2 * b[3] + 2 * cc[3] + d[3]) * h / 6;
      sum += Math.abs(vs - vu) * h;
    }
  }
  return (sum / ((i1 - i0) * dx)) * 1000;
}
