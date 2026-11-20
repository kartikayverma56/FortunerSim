// Tyre smoke and dust: emitted per wheel at the contact patch while the tyre really slides (wheelspin, lock-up, drift,
// burnout). White/grey smoke on sealed surfaces, tan/brown dust on loose ones, nothing on wet.
// One THREE.Points draw call; soft round sprites drawn in the shader (no texture), no depth write, pooled particles.
import * as THREE from 'three';
import type { Vehicle } from '../physics/vehicle';
import { MIRROR_LAYER } from '../render/layers';

export type SmokeLevel = 'low' | 'medium' | 'high';
const CAP: Record<SmokeLevel, number> = { low: 150, medium: 300, high: 500 };
const MAX = 500;

// sliding thresholds, consistent with skidMarks.ts (|κ| > 0.12, |α| > 0.10 there) plus a real sliding speed
const SLIDE_MIN = 2.0;     // m/s sliding speed at the contact patch before any smoke
const SLIDE_FULL = 8.0;    // m/s for full emission
const RATE = 70;           // particles / s per wheel at full emission (before the level cap)

interface Look { rgb: [number, number, number]; alpha: number; life: [number, number]; size0: number; grow: number; rise: number; dust: boolean }
const SMOKE: Look = { rgb: [0.86, 0.86, 0.88], alpha: 0.42, life: [2.2, 4.0], size0: 0.55, grow: 1.0, rise: 0.55, dust: false };
const LOOKS: Record<string, Look | null> = {
  asphalt: SMOKE, concrete: SMOKE, broken: SMOKE, rumble: SMOKE, smooth: SMOKE,
  wet: null,
  gravel: { rgb: [0.62, 0.56, 0.46], alpha: 0.38, life: [1.5, 2.6], size0: 0.5, grow: 0.8, rise: 0.25, dust: true },
  grass: { rgb: [0.52, 0.45, 0.32], alpha: 0.34, life: [1.5, 2.4], size0: 0.45, grow: 0.7, rise: 0.2, dust: true },
  mud: { rgb: [0.40, 0.31, 0.22], alpha: 0.30, life: [1.5, 2.2], size0: 0.4, grow: 0.6, rise: 0.15, dust: true },
  sand: { rgb: [0.78, 0.68, 0.50], alpha: 0.34, life: [1.8, 3.0], size0: 0.55, grow: 0.9, rise: 0.3, dust: true },
};

const vert = /* glsl */`
  attribute float aSize; attribute float aAlpha; attribute vec3 aColor;
  uniform float uScale;
  varying float vAlpha; varying vec3 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = clamp(aSize * uScale / max(0.1, -mv.z), 1.0, 512.0);
    vAlpha = aAlpha; vColor = aColor;
  }`;
const frag = /* glsl */`
  varying float vAlpha; varying vec3 vColor;
  void main() {
    vec2 d = gl_PointCoord - 0.5; float r = dot(d, d) * 4.0;   // 0 centre … 1 edge
    if (r > 1.0) discard;
    float a = vAlpha * (1.0 - r) * (1.0 - r);                   // soft round puff
    gl_FragColor = vec4(vColor, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }`;

export class TyreSmoke {
  readonly points: THREE.Points;
  /** Live particle count (for tests / HUD). */
  count = 0;
  private cap = CAP.medium;
  private px = new Float32Array(MAX * 3); private pv = new Float32Array(MAX * 3);
  private age = new Float32Array(MAX); private life = new Float32Array(MAX); private s0 = new Float32Array(MAX); private gr = new Float32Array(MAX);
  private a0 = new Float32Array(MAX); private rise = new Float32Array(MAX); private col = new Float32Array(MAX * 3);
  private aPos = new Float32Array(MAX * 3); private aSize = new Float32Array(MAX); private aAlpha = new Float32Array(MAX); private aCol = new Float32Array(MAX * 3);
  private geo = new THREE.BufferGeometry();
  private acc = [0, 0, 0, 0];
  private wind = new THREE.Vector3(0.7, 0, 0.35);  // gentle breeze, m/s
  private tmpSize = new THREE.Vector2();
  private seed = 12345;

  constructor() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.aPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.aAlpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.aCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({ vertexShader: vert, fragmentShader: frag, uniforms: { uScale: { value: 500 } },
      transparent: true, depthWrite: false, depthTest: true, blending: THREE.NormalBlending });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false; this.points.renderOrder = 2; this.points.name = 'TyreSmoke';
    this.points.layers.enable(MIRROR_LAYER);
    // per camera (main view or a mirror): pixels per metre at 1 m distance
    this.points.onBeforeRender = (renderer, _scene, camera) => {
      const cam = camera as THREE.PerspectiveCamera; const rt = renderer.getRenderTarget();
      const h = rt ? rt.height : renderer.getDrawingBufferSize(this.tmpSize).y;
      const fov = cam.isPerspectiveCamera ? cam.fov : 60;
      mat.uniforms.uScale.value = h / (2 * Math.tan(fov * Math.PI / 360));
    };
  }

  /** Particle cap from the graphics level (Low 150, Medium 300, High 500). */
  setLevel(level: SmokeLevel) { this.cap = CAP[level] ?? CAP.medium; }
  clear() { this.count = 0; this.geo.setDrawRange(0, 0); this.acc.fill(0); }

  private rnd() { this.seed = (this.seed * 1664525 + 1013904223) >>> 0; return this.seed / 4294967296; }

  /** Call once per rendered frame after physics. */
  update(veh: Vehicle, dt: number) {
    if (dt <= 0) return;
    dt = Math.min(dt, 0.1);
    // ---- emit ----
    veh.wheels.forEach((w, i) => {
      const look = LOOKS[w.surface] ?? SMOKE;
      if (!look || !w.grounded || w.Fz < 600) { this.acc[i] = 0; return; }
      const slide = Math.hypot(w.vLong, w.vLat);                                   // sliding speed over the ground
      const sliding = Math.abs(w.kappa) > 0.12 || Math.abs(w.alpha) > 0.10;        // same gate as the tyre marks
      if (!sliding || slide < SLIDE_MIN) { this.acc[i] = 0; return; }
      const k = Math.min(1, (slide - SLIDE_MIN) / (SLIDE_FULL - SLIDE_MIN)) * Math.min(1.2, w.Fz / 5500);
      this.acc[i] += RATE * k * dt * (this.cap / CAP.medium);
      while (this.acc[i] >= 1) { this.acc[i] -= 1; this.spawn(w.contact, w.contactN, veh, look, k); }
    });
    // ---- integrate, age, compact ----
    let n = this.count;
    const wx = this.wind.x, wz = this.wind.z;
    for (let i = 0; i < n; i++) {
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) { n--; this.move(n, i); i--; continue; }
      const j = i * 3, drag = Math.min(1, 2.2 * dt);
      this.pv[j] += (wx - this.pv[j]) * drag; this.pv[j + 2] += (wz - this.pv[j + 2]) * drag;
      this.pv[j + 1] += (this.rise[i] - this.pv[j + 1]) * drag;
      this.px[j] += this.pv[j] * dt; this.px[j + 1] += this.pv[j + 1] * dt; this.px[j + 2] += this.pv[j + 2] * dt;
      const t = this.age[i] / this.life[i];
      this.aPos[j] = this.px[j]; this.aPos[j + 1] = this.px[j + 1]; this.aPos[j + 2] = this.px[j + 2];
      this.aSize[i] = this.s0[i] * (1 + this.gr[i] * this.age[i] * 2.2);
      this.aAlpha[i] = this.a0[i] * Math.min(1, t * 8) * (1 - t) * (1 - t);    // quick fade-in, slow fade-out
      this.aCol[j] = this.col[j]; this.aCol[j + 1] = this.col[j + 1]; this.aCol[j + 2] = this.col[j + 2];
    }
    this.count = n;
    this.geo.setDrawRange(0, n);
    for (const a of ['position', 'aSize', 'aAlpha', 'aColor']) (this.geo.attributes[a] as THREE.BufferAttribute).needsUpdate = true;
  }

  private spawn(c: { x: number; y: number; z: number }, nrm: { x: number; y: number; z: number }, veh: Vehicle, look: Look, k: number) {
    let i = this.count;
    if (i >= this.cap) { // pool full: recycle the oldest-looking slot (highest age fraction)
      let best = 0, bt = -1; for (let q = 0; q < this.count; q++) { const t = this.age[q] / this.life[q]; if (t > bt) { bt = t; best = q; } }
      i = best;
    } else this.count++;
    const j = i * 3, r = () => this.rnd() - 0.5;
    this.px[j] = c.x + r() * 0.3 + nrm.x * 0.1; this.px[j + 1] = c.y + 0.12 + this.rnd() * 0.1; this.px[j + 2] = c.z + r() * 0.3 + nrm.z * 0.1;
    // smoke leaves with a little of the car's motion and spreads; dust is thrown up harder but rises less
    const carry = look.dust ? 0.35 : 0.2;
    this.pv[j] = veh.vel.x * carry + r() * 1.2; this.pv[j + 1] = (look.dust ? 1.2 : 0.6) + this.rnd() * 0.6; this.pv[j + 2] = veh.vel.z * carry + r() * 1.2;
    this.age[i] = 0; this.life[i] = look.life[0] + this.rnd() * (look.life[1] - look.life[0]);
    this.s0[i] = look.size0 * (0.8 + 0.4 * this.rnd()); this.gr[i] = look.grow * (0.8 + 0.4 * this.rnd());
    this.a0[i] = look.alpha * (0.6 + 0.4 * k); this.rise[i] = look.rise * (0.7 + 0.6 * this.rnd());
    const sh = 0.94 + 0.12 * this.rnd();
    this.col[j] = look.rgb[0] * sh; this.col[j + 1] = look.rgb[1] * sh; this.col[j + 2] = look.rgb[2] * sh;
  }

  private move(from: number, to: number) {
    if (from === to) return;
    const a = from * 3, b = to * 3;
    for (let q = 0; q < 3; q++) { this.px[b + q] = this.px[a + q]; this.pv[b + q] = this.pv[a + q]; this.col[b + q] = this.col[a + q]; }
    this.age[to] = this.age[from]; this.life[to] = this.life[from]; this.s0[to] = this.s0[from]; this.gr[to] = this.gr[from];
    this.a0[to] = this.a0[from]; this.rise[to] = this.rise[from];
  }
}
