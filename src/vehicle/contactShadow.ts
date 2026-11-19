// Soft contact shadow (ambient occlusion) under the car: one dark quad under the body and four small blobs at the
// tyre contact patches, laid on the ground with heightAt. 2 draw calls, no shadow-map cost. Fades as the car lifts.
import * as THREE from 'three';
import type { Vehicle } from '../physics/vehicle';
import { heightAt } from '../world/terrain';

function blobTexture(w: number, h: number, inset: number, blur: number, alpha: number) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!; g.filter = `blur(${blur}px)`; g.fillStyle = `rgba(0,0,0,${alpha})`;
  g.beginPath(); g.roundRect(inset, inset, w - 2 * inset, h - 2 * inset, Math.min(w, h) / 2 - inset); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; return t;
}

export class ContactShadow {
  body: THREE.Mesh; wheels: THREE.InstancedMesh;
  private L: number; private W: number; private zMid: number; private h0: number;
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private s = new THREE.Vector3();
  private p = new THREE.Vector3(); private n = new THREE.Vector3(); private f = new THREE.Vector3(); private x = new THREE.Vector3();
  private basis = new THREE.Matrix4();

  constructor(scene: THREE.Scene, veh: Vehicle) {
    const P = veh.P;
    this.L = P.length.v; this.W = P.width.v;
    this.zMid = (veh.a - veh.b) / 2 + (P.overhangFront.v - P.overhangRear.v) / 2; // body centre ahead of the CG
    this.h0 = veh.hcg;
    const mat = (map: THREE.Texture, opacity: number) => new THREE.MeshBasicMaterial({ map, color: 0x000000, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, toneMapped: false, fog: false });
    const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.body = new THREE.Mesh(quad, mat(blobTexture(96, 224, 18, 14, 1), 0.62)); this.body.name = 'ContactShadow_body';
    this.body.renderOrder = 1; this.body.frustumCulled = false; this.body.matrixAutoUpdate = false;
    this.wheels = new THREE.InstancedMesh(quad, mat(blobTexture(64, 96, 10, 9, 1), 0.7), 4); this.wheels.name = 'ContactShadow_wheels';
    this.wheels.renderOrder = 1; this.wheels.frustumCulled = false;
    scene.add(this.body, this.wheels);
  }

  update(veh: Vehicle) {
    const q = veh.q, fwdx = 2 * (q.x * q.z + q.w * q.y), fwdz = 1 - 2 * (q.x * q.x + q.y * q.y);
    const hl = Math.hypot(fwdx, fwdz) || 1, fx = fwdx / hl, fz = fwdz / hl;
    // body: centre of the footprint, ground normal from the slope across the car
    const cx = veh.pos.x + fx * this.zMid, cz = veh.pos.z + fz * this.zMid;
    const gy = heightAt(cx, cz);
    const ex = 0.9, ez = 1.8;
    const hx = heightAt(cx + ex, cz) - heightAt(cx - ex, cz), hz = heightAt(cx, cz + ez) - heightAt(cx, cz - ez);
    this.n.set(-hx / (2 * ex), 1, -hz / (2 * ez)).normalize();
    const lift = veh.pos.y - gy - this.h0; // > 0 when the body is above its static height (crest, jump)
    const fade = THREE.MathUtils.clamp(1 - lift / 0.7, 0, 1);
    this.place(this.body.matrix, cx, gy + 0.025, cz, fx, fz, this.W * 1.08, this.L * 1.02, 0.6 + 0.4 * fade);
    (this.body.material as THREE.MeshBasicMaterial).opacity = 0.62 * fade;
    this.body.visible = fade > 0.01;
    // wheels: blob at each contact patch, turned with the steer angle, shrinking as the tyre leaves the ground
    for (let i = 0; i < 4; i++) {
      const wh = veh.wheels[i];
      const gap = wh.centre.y - veh.R - wh.contact.y;
      const k = THREE.MathUtils.clamp(1 - gap / 0.35, 0, 1);
      const cs = Math.cos(wh.steer), sn = Math.sin(wh.steer);
      const wfx = fx * cs + fz * sn, wfz = fz * cs - fx * sn; // rotate heading by the steer angle (+ = left)
      this.n.set(wh.contactN.x, wh.contactN.y, wh.contactN.z); if (this.n.y < 0.5) this.n.set(0, 1, 0);
      this.place(this.m, wh.contact.x, wh.contact.y + 0.02, wh.contact.z, wfx, wfz, 0.46 * k + 1e-4, 0.78 * k + 1e-4, 1);
      this.wheels.setMatrixAt(i, this.m);
    }
    this.wheels.instanceMatrix.needsUpdate = true;
  }

  /** Matrix for a ground quad: centre, heading (fx, fz), size across × along, laid on normal this.n. */
  private place(out: THREE.Matrix4, x: number, y: number, z: number, fx: number, fz: number, w: number, l: number, sc: number) {
    const n = this.n, f = this.f.set(fx, 0, fz); f.addScaledVector(n, -f.dot(n)).normalize();
    const xa = this.x.crossVectors(n, f).normalize();
    this.basis.makeBasis(xa, n, f); this.q.setFromRotationMatrix(this.basis);
    out.compose(this.p.set(x, y, z), this.q, this.s.set(w * sc, 1, l * sc));
  }
}
