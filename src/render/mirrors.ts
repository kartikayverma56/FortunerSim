// Live rear-view mirrors (Medium and High; Low keeps the tinted glass).
// Each mirror is a true reflection: a camera at the eye's mirror image looks through the glass rectangle with an
// off-axis frustum whose near plane is the mirror plane. The three views share one half-float atlas, and each glass
// samples its part projectively (texture matrix × object position, as three's Reflector does), so the glass needs no
// UVs and the image comes out mirrored exactly as a real mirror's would. The texture matrix is frozen together with
// the image, in the car's frame, so a mirror updated at 15 Hz still sits right on the glass while the car moves.
// The door mirrors are convex (R 1.4 m): the virtual eye moves toward the glass by 1 / (1 + 2d/R), which widens the view.
// The car itself is hidden during the passes; a plain paint-coloured shell, visible only to the mirror cameras
// (MIRROR_LAYER), gives the door mirrors the car's flank.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { MIRROR_LAYER } from './layers';
import type { CarVisual, MirrorId } from '../vehicle/rig';

const CONVEX_R = 1.4;       // door mirror radius of curvature, m
const TINT = 0.85;          // mirror glass reflectance
// Mirror far plane by level, m. Beyond it the sky shows through (the sky draws at the far plane whatever this is);
// at 800 m that strip is 0.11° high, under 2 px of the interior view and 1 px of a door view, and fog already
// hides 18 % there. It halves the draw calls when the road behind is long.
const FAR: Record<1 | 2, number> = { 1: 800, 2: 1500 };
const NEAR_VIEW = 8;        // outside the cockpit, mirrors update only while the camera is this close, m
// TerrainLOD scales camera distance by tan(fov/2) / tan(34°). The mirror views are a few degrees wide but low-res, so
// they report a fov that makes every piece look 4× farther: far terrain twins, as a lodBias of 4 would.
const LOD_FOV = THREE.MathUtils.radToDeg(2 * Math.atan(4 * Math.tan(THREE.MathUtils.degToRad(34))));
const ATLAS: Record<1 | 2, [number, number]> = { 1: [384, 192], 2: [512, 256] }; // interior on the top half, doors below
const COCKPIT_SEQ: MirrorId[] = ['interior', 'right', 'interior', 'left']; // right = driver's side on this RHD car

interface Glass {
  id: MirrorId; mesh: THREE.Mesh; lowMat: THREE.Material; mat: THREE.ShaderMaterial; convex: boolean;
  // body frame: centre, aimed normal (toward the eye), in-plane up; the glass rectangle's corners as modelled
  c: THREE.Vector3; n: THREE.Vector3; u: THREE.Vector3; corners: THREE.Vector3[]; radius: number;
  px: [number, number, number, number]; // atlas viewport, px (x, y from the bottom, w, h)
  last: number;                         // time of the last update, s (−1 = never)
}
export interface MirrorPassStat { id: MirrorId; ms: number; calls: number; tris: number }

const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

export class Mirrors {
  level: 0 | 1 | 2 = 0;
  glasses: Glass[] = [];
  rt: THREE.WebGLRenderTarget | null = null;
  cam = new THREE.PerspectiveCamera(LOD_FOV, 1, 0.1, 1500);
  shell = new THREE.Group();
  /** last few passes, and the render-CPU time of the mirror passes per frame (smoothed), for window.sim.mirrors */
  stats = { passes: [] as MirrorPassStat[], msPerFrame: 0, passesPerFrame: 0, frames: 0, setupMs: 0 };
  private seq = 0; private frame = 0; private lastPass = -1; private robin = 0;
  private rearWin: THREE.Vector3[] = [];
  private toCar = new THREE.Matrix4(); private frustum = new THREE.Frustum(); private sphere = new THREE.Sphere(); private m4 = new THREE.Matrix4();
  private v = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private car: CarVisual) {
    this.cam.matrixAutoUpdate = false; this.cam.matrixWorldAutoUpdate = false;
    this.cam.layers.enable(0); this.cam.layers.enable(MIRROR_LAYER);
    car.root.updateMatrixWorld(true);
    const toBody = new THREE.Matrix4().copy(car.root.matrixWorld).invert();
    for (const { id, mesh } of car.mirrorMeshes()) this.glasses.push(this.measure(id, mesh, toBody));
    if (car.rearWindow) { const b = car.rearWindow; for (let i = 0; i < 8; i++) this.rearWin.push(new THREE.Vector3(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z)); }
    if (this.glasses.length) this.buildShell(toBody);
  }

  /** Plane, normal (toward the driver's eye) and rectangle of a mirror glass, from its vertices, in the body frame. */
  private measure(id: MirrorId, mesh: THREE.Mesh, toBody: THREE.Matrix4): Glass {
    const g = mesh.geometry, p = g.attributes.position, idx = g.index;
    const m = new THREE.Matrix4().multiplyMatrices(toBody, mesh.matrixWorld);
    const pts: THREE.Vector3[] = []; for (let i = 0; i < p.count; i++) pts.push(new THREE.Vector3().fromBufferAttribute(p, i).applyMatrix4(m));
    const n = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), cen = new THREE.Vector3(); let area = 0;
    const cnt = idx ? idx.count : p.count;
    for (let i = 0; i + 2 < cnt; i += 3) {
      const A = pts[idx ? idx.getX(i) : i], B = pts[idx ? idx.getX(i + 1) : i + 1], C = pts[idx ? idx.getX(i + 2) : i + 2];
      const s = a.subVectors(B, A).cross(b.subVectors(C, A)); const ar = s.length();
      n.add(s); area += ar; cen.addScaledVector(A, ar).addScaledVector(B, ar).addScaledVector(C, ar);
    }
    cen.divideScalar(3 * area || 1);
    if (n.length() < 0.3 * area && g.attributes.normal) { // two-sided glass: the faces cancel; use the vertex normals' side instead
      n.set(0, 0, 0); const nm = new THREE.Matrix3().getNormalMatrix(m);
      for (let i = 0; i < p.count; i++) { a.fromBufferAttribute(g.attributes.normal, i).applyMatrix3(nm); if (a.dot(this.car.cockpitEye.clone().sub(cen)) > 0) n.add(a); }
    }
    n.normalize();
    if (n.dot(a.subVectors(this.car.cockpitEye, cen)) < 0) n.negate();
    const u = new THREE.Vector3(0, 1, 0).addScaledVector(n, -n.y).normalize(); // body-up, in the plane
    const r = new THREE.Vector3().crossVectors(u, n);
    let r0 = Infinity, r1 = -Infinity, u0 = Infinity, u1 = -Infinity;
    for (const q of pts) { a.subVectors(q, cen); const x = a.dot(r), y = a.dot(u); r0 = Math.min(r0, x); r1 = Math.max(r1, x); u0 = Math.min(u0, y); u1 = Math.max(u1, y); }
    const c = cen.clone().addScaledVector(r, (r0 + r1) / 2).addScaledVector(u, (u0 + u1) / 2);
    const hw = (r1 - r0) / 2, hh = (u1 - u0) / 2;
    const corners = [0, 1, 2, 3].map(i => c.clone().addScaledVector(r, (i & 1 ? 1 : -1) * hw).addScaledVector(u, (i & 2 ? 1 : -1) * hh));
    // The model's glasses face straight back (interior) or at a fixed angle that suits no particular eye; aim each one
    // as a driver would: the interior at the middle of the rear window, the doors straight back and slightly down,
    // turned out just enough that the inner edge still shows a strip of the car's flank. Only the image follows
    // the aim; the glass stays where the model has it.
    const eye = this.car.cockpitEye, inc = a.subVectors(c, eye).normalize();
    let t: THREE.Vector3;
    if (id === 'interior') { // across to the rear window's middle, about level (horizon a little above the centre)
      t = this.car.rearWindow ? this.car.rearWindow.getCenter(new THREE.Vector3()).sub(c) : new THREE.Vector3(0, 0, -1);
      t.y = 0; t.normalize(); t.y = -Math.sin(THREE.MathUtils.degToRad(1)); t.normalize();
    } else {
      const d = Math.max(0.2, b.subVectors(eye, c).dot(n)), half = Math.atan(hw * (1 + 2 * d / CONVEX_R) / d);
      const out = Math.max(0, half - THREE.MathUtils.degToRad(2)), side = Math.sign(c.x), down = THREE.MathUtils.degToRad(2);
      t = new THREE.Vector3(side * Math.sin(out), -Math.sin(down), -Math.cos(out)).normalize();
    }
    n.subVectors(t, inc).normalize(); // reflects the eye ray `inc` into `t`
    u.set(0, 1, 0).addScaledVector(n, -n.y).normalize();
    const mat = new THREE.ShaderMaterial({
      name: 'mirror_live_' + id,
      uniforms: {
        map: { value: null }, texMat: { value: new THREE.Matrix4() }, toCar: { value: m.clone() }, eyeC: { value: this.car.cockpitEye.clone() },
        plane: { value: new THREE.Vector4(n.x, n.y, n.z, -n.dot(c)) }, rect: { value: new THREE.Vector4(0, 0, 1, 1) }, halfTexel: { value: new THREE.Vector2() },
        tint: { value: TINT }, mask: { value: new THREE.Vector4(-1, -1, 2, 2) }, maskOn: { value: 0 }, cabin: { value: new THREE.Color(0.016, 0.015, 0.014) },
      },
      vertexShader: MIRROR_VS, fragmentShader: MIRROR_FS,
    });
    return { id, mesh, lowMat: mesh.material as THREE.Material, mat, convex: id !== 'interior', c, n, u, corners, radius: Math.hypot(hw, hh) + 0.02, px: [0, 0, 1, 1], last: -1 };
  }

  /** Two rounded boxes in the paint colour (lower body, darker greenhouse) that only the mirror cameras see. */
  private buildShell(toBody: THREE.Matrix4) {
    const bb = new THREE.Box3().setFromObject(this.car.align).applyMatrix4(toBody);
    let paint = new THREE.Color(0x5b5f63);
    this.car.root.traverse(o => { const mm = (o as THREE.Mesh).material as THREE.MeshStandardMaterial; if ((o as THREE.Mesh).isMesh && mm?.name === 'carpaint') paint = mm.color.clone(); });
    const doors = this.glasses.filter(g => g.convex);
    const halfW = (bb.max.x - bb.min.x) / 2 - 0.09; // the box includes the door mirrors
    const belt = doors.length ? doors.reduce((s, g) => s + g.c.y, 0) / doors.length - 0.08 : bb.min.y + 0.68 * (bb.max.y - bb.min.y);
    const zA = doors.length ? doors.reduce((s, g) => s + g.c.z, 0) / doors.length : bb.max.z - 1.8; // A-pillar, about at the door mirrors
    const bottom = bb.min.y + 0.32, roof = bb.max.y - 0.04;
    const lowerMat = new THREE.MeshStandardMaterial({ color: paint, metalness: 0.45, roughness: 0.4, name: 'mirror_shell_paint' });
    const upperMat = new THREE.MeshStandardMaterial({ color: 0x10161a, metalness: 0, roughness: 0.08, name: 'mirror_shell_glass' });
    const L = bb.max.z - bb.min.z - 0.04;
    const lower = new THREE.Mesh(new RoundedBoxGeometry(2 * halfW, belt - bottom, L, 2, 0.1), lowerMat);
    lower.position.set(0, (belt + bottom) / 2, (bb.max.z + bb.min.z) / 2);
    const Lu = zA - bb.min.z - 0.12;
    const upper = new THREE.Mesh(new RoundedBoxGeometry(2 * (halfW - 0.15), roof - belt, Lu, 2, 0.12), upperMat);
    upper.position.set(0, (roof + belt) / 2, bb.min.z + 0.1 + Lu / 2);
    for (const m of [lower, upper]) { m.layers.set(MIRROR_LAYER); m.castShadow = false; m.receiveShadow = true; this.shell.add(m); }
    this.shell.name = 'Mirror_body_shell'; this.shell.matrixAutoUpdate = false; this.shell.visible = false;
    this.scene.add(this.shell);
  }

  /** 0: tinted glass (no passes); 1: 384×192 atlas, interior 30 Hz, doors 15 Hz; 2: 512×256, interior 60 Hz, doors 30 Hz. */
  setLevel(lv: 0 | 1 | 2) {
    if (lv === this.level || !this.glasses.length) { this.level = lv; return; }
    this.level = lv;
    this.rt?.dispose(); this.rt = null;
    if (lv === 0) { for (const g of this.glasses) g.mesh.material = g.lowMat; this.shell.visible = false; return; }
    const [W, H] = ATLAS[lv], ext = this.renderer.extensions;
    const half = ext.has('EXT_color_buffer_float') || ext.has('EXT_color_buffer_half_float');
    this.rt = new THREE.WebGLRenderTarget(W, H, { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.rt.texture.name = 'mirror_atlas';
    const px: Record<MirrorId, [number, number, number, number]> = { interior: [0, H / 2, W, H / 2], right: [0, 0, W / 2, H / 2], left: [W / 2, 0, W / 2, H / 2] };
    for (const g of this.glasses) {
      g.px = px[g.id]; g.last = -1;
      const u = g.mat.uniforms; u.map.value = this.rt.texture;
      u.rect.value.set(g.px[0] / W, g.px[1] / H, g.px[2] / W, g.px[3] / H); u.halfTexel.value.set(0.5 / W, 0.5 / H);
      u.maskOn.value = g.id === 'interior' && this.rearWin.length ? 1 : 0;
      g.mesh.material = g.mat;
    }
    // neutral grey-blue until each mirror's first pass; then compile the scene's render-target shader variants now
    // (no tone mapping inside the target) rather than with a hitch on the first pass
    const r = this.renderer, cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setRenderTarget(this.rt); r.setClearColor(new THREE.Color(0.25, 0.3, 0.36), 1); r.clear(true, true, false); r.setClearColor(cc, ca);
    const vis = this.car.root.visible; this.car.root.visible = false; this.shell.visible = true;
    try { void r.compileAsync(this.scene, this.cam).catch(() => { /* compiled lazily instead */ }); } catch { /* compiled lazily instead */ }
    this.car.root.visible = vis; this.shell.visible = false;
    r.setRenderTarget(null);
  }

  /** Call once per frame after the car and camera have moved, right before the main render. */
  update(main: THREE.PerspectiveCamera, cockpit: boolean) {
    if (!this.level || !this.rt || !this.glasses.length) return;
    this.frame++;
    const now = performance.now() / 1000;
    main.updateMatrixWorld();
    const eye = this.v[6].setFromMatrixPosition(main.matrixWorld);
    const rw = this.car.root.matrixWorld;
    const pick: Glass[] = [];
    if (cockpit) {
      if (now - this.lastPass < 1 / 75) return; // high-refresh screens: keep 30 / 15 Hz (Medium), not 72 / 36
      this.frustum.setFromProjectionMatrix(this.m4.multiplyMatrices(main.projectionMatrix, main.matrixWorldInverse));
      for (let k = 0; k < this.level; k++) {
        for (let s = 0; s < COCKPIT_SEQ.length; s++) {
          const g = this.glasses.find(q => q.id === COCKPIT_SEQ[this.seq % COCKPIT_SEQ.length]); this.seq++;
          if (!g || pick.includes(g) || !g.mesh.visible) continue; // a broken door mirror (damageVisual) is not drawn
          this.sphere.center.copy(g.c).applyMatrix4(rw); this.sphere.radius = g.radius;
          if (this.frustum.intersectsSphere(this.sphere) && this.facing(g, eye) > 0.02) { pick.push(g); break; }
        }
      }
    } else if (this.frame % 4 === 0) {
      // one mirror every 4th frame: first any that were never drawn, then in turn those within 8 m
      let g = this.glasses.find(q => q.last < 0 && q.mesh.visible && this.facing(q, eye) > 0.02);
      for (let s = 0; !g && s < this.glasses.length; s++) {
        const q = this.glasses[this.robin++ % this.glasses.length];
        if (q.mesh.visible && this.facing(q, eye) > 0.02 && this.v[0].copy(q.c).applyMatrix4(rw).distanceTo(eye) < NEAR_VIEW) g = q;
      }
      if (g) pick.push(g);
    }
    if (!pick.length) { this.smooth(0, 0); return; }
    // ---- passes: car hidden (shell instead), last frame's shadow map, world matrices updated once ----
    const r = this.renderer, scene = this.scene;
    const t0 = performance.now();
    this.shell.matrix.copy(rw); this.shell.visible = true; this.shell.updateMatrixWorld(true);
    const carVis = this.car.root.visible; this.car.root.visible = false;
    // the world's matrices are the ones the last main render computed (the car, the only fast mover, is hidden);
    // a full scene.updateMatrixWorld() per frame would cost more than a mirror pass
    const autoMat = scene.matrixWorldAutoUpdate; scene.matrixWorldAutoUpdate = false;
    const autoShadow = r.shadowMap.autoUpdate; r.shadowMap.autoUpdate = false;
    this.stats.setupMs = performance.now() - t0;
    let ms = 0;
    try {
      for (const g of pick) {
        const ta = performance.now();
        if (!this.place(g, eye)) continue;
        const rt = this.rt; rt.viewport.set(...g.px); rt.scissor.set(...g.px); rt.scissorTest = true;
        r.setRenderTarget(rt); r.render(scene, this.cam);
        const dt = performance.now() - ta; ms += dt;
        g.last = now;
        this.stats.passes.push({ id: g.id, ms: dt, calls: r.info.render.calls, tris: r.info.render.triangles });
        if (this.stats.passes.length > 12) this.stats.passes.shift();
      }
    } finally {
      r.setRenderTarget(null);
      r.shadowMap.autoUpdate = autoShadow; scene.matrixWorldAutoUpdate = autoMat;
      this.car.root.visible = carVis; this.shell.visible = false;
    }
    this.lastPass = now;
    this.smooth(ms + this.stats.setupMs, pick.length);
  }

  private smooth(ms: number, n: number) {
    const s = this.stats, k = s.frames < 30 ? 1 / ++s.frames : 0.03;
    s.msPerFrame += (ms - s.msPerFrame) * k; s.passesPerFrame += (n - s.passesPerFrame) * k;
  }

  /** Distance of the eye in front of the glass (negative: behind it, the glass cannot be seen). */
  private facing(g: Glass, eye: THREE.Vector3) {
    const rw = this.car.root.matrixWorld;
    const c = this.v[0].copy(g.c).applyMatrix4(rw), n = this.v[1].copy(g.n).transformDirection(rw);
    return this.v[2].subVectors(eye, c).dot(n);
  }

  /** Mirror camera for glass g seen from `eye`; freezes the glass's texture matrix (and cabin mask) with it. */
  private place(g: Glass, eye: THREE.Vector3) {
    const rw = this.car.root.matrixWorld, [c, n, u, q, ev, tmp] = this.v;
    c.copy(g.c).applyMatrix4(rw); n.copy(g.n).transformDirection(rw); u.copy(g.u).transformDirection(rw);
    const d = tmp.subVectors(eye, c).dot(n); if (d < 0.02) return false;
    const k = g.convex ? 1 / (1 + 2 * d / CONVEX_R) : 1, dv = k * d;
    // the eye's mirror image; for the convex doors, pulled toward the glass centre by κ (keeps the centre ray, widens the view)
    ev.copy(eye).addScaledVector(n, -2 * d).sub(c).multiplyScalar(k).add(c);
    const right = tmp.crossVectors(n, u); // camera basis: right, up, back = −n (right-handed)
    const cam = this.cam;
    cam.matrixWorld.makeBasis(right, u, n.clone().negate()).setPosition(ev);
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    // Off-axis frustum through the glass as the eye sees it on the aimed plane: each modelled corner is carried along
    // its eye ray onto that plane (the shader does the same per pixel), so the near plane is the mirror plane.
    const p = tmp; // (free again once the basis is set)
    const near = dv * 0.999, s = near / dv;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const k of g.corners) {
      q.copy(k).applyMatrix4(rw).sub(eye); // eye ray to the corner
      p.copy(eye).addScaledVector(q, d / -q.dot(n)).applyMatrix4(cam.matrixWorldInverse); // where it meets the plane
      x0 = Math.min(x0, p.x * s); x1 = Math.max(x1, p.x * s); y0 = Math.min(y0, p.y * s); y1 = Math.max(y1, p.y * s);
    }
    cam.projectionMatrix.makePerspective(x0, x1, y1, y0, near, FAR[this.level as 1 | 2]);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    // car frame → atlas uv of this view (as three's Reflector), frozen with the image, together with the eye it was for
    const vp = this.m4.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    g.mat.uniforms.texMat.value.multiplyMatrices(BIAS, vp).multiply(rw);
    g.mat.uniforms.eyeC.value.copy(eye).applyMatrix4(this.toCar.copy(rw).invert());
    if (g.mat.uniforms.maskOn.value) { // rear window outline in the same uv space; the cabin around it is dark
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const q of this.rearWin) { p.copy(q).applyMatrix4(rw).applyMatrix4(vp); const x = p.x * 0.5 + 0.5, y = p.y * 0.5 + 0.5; a0 = Math.min(a0, x); a1 = Math.max(a1, x); b0 = Math.min(b0, y); b1 = Math.max(b1, y); }
      g.mat.uniforms.mask.value.set(a0, b0, a1, b1);
    }
    return true;
  }

  dispose() {
    this.setLevel(0);
    for (const g of this.glasses) g.mat.dispose();
    this.shell.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } });
    this.shell.removeFromParent();
  }
}

const MIRROR_VS = /* glsl */`
uniform mat4 toCar;      // glass object space -> car frame
varying vec3 vCar;
void main() {
  vCar = (toCar * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const MIRROR_FS = /* glsl */`
uniform sampler2D map;
uniform vec4 rect;       // atlas sub-rectangle: offset, size
uniform vec2 halfTexel;
uniform float tint;
uniform vec4 mask;       // rear window in this view's uv (min, max)
uniform float maskOn;
uniform vec3 cabin;
uniform mat4 texMat;     // car frame -> this view's clip space (frozen with the image)
uniform vec3 eyeC;       // eye the image was made for, car frame
uniform vec4 plane;      // aimed mirror plane, car frame
varying vec3 vCar;
void main() {
  // carry the glass point along the eye ray onto the aimed mirror plane, then project it like the mirror camera did
  vec3 dir = vCar - eyeC;
  vec3 onPlane = eyeC - dir * (dot(plane.xyz, eyeC) + plane.w) / dot(plane.xyz, dir);
  vec4 q = texMat * vec4(onPlane, 1.0);
  vec2 uv = q.xy / q.w;
  vec2 a = clamp(rect.xy + uv * rect.zw, rect.xy + halfTexel, rect.xy + rect.zw - halfTexel);
  vec3 col = texture2D(map, a).rgb * tint;
  if (maskOn > 0.5) {
    vec2 e = min(uv - mask.xy, mask.zw - uv);
    float k = smoothstep(-0.01, 0.05, min(e.x, e.y));
    col = mix(cabin + col * 0.1, col, k);
  }
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;
