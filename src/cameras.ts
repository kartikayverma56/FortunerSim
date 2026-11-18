import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Vehicle } from './physics/vehicle';
import type { CarVisual } from './vehicle/rig';
import { heightAt } from './world/terrain';

export const CAMS = ['chase', 'cockpit', 'bonnet', 'wheel', 'orbit', 'trackside'] as const;
export type CamMode = typeof CAMS[number];

export class CameraRig {
  cam: THREE.PerspectiveCamera;
  mode: CamMode = 'chase';
  orbit: OrbitControls;
  private pos = new THREE.Vector3(); private look = new THREE.Vector3(); private init = false;
  private trackPt = new THREE.Vector3(); private v = new THREE.Vector3(); private tmp = new THREE.Vector3();
  lookYaw = 0; lookPitch = 0; private dragging = false;

  constructor(dom: HTMLElement) {
    this.cam = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 6000);
    this.orbit = new OrbitControls(this.cam, dom); this.orbit.enabled = false; this.orbit.enableDamping = true; this.orbit.maxPolarAngle = Math.PI * 0.495;
    dom.addEventListener('pointerdown', e => { if (this.mode === 'cockpit' && e.button === 0) this.dragging = true; });
    addEventListener('pointerup', () => { this.dragging = false; });
    addEventListener('pointermove', e => { if (this.dragging) { this.lookYaw = THREE.MathUtils.clamp(this.lookYaw - e.movementX * 0.004, -2.2, 2.2); this.lookPitch = THREE.MathUtils.clamp(this.lookPitch - e.movementY * 0.004, -0.8, 0.6); } });
    dom.addEventListener('dblclick', () => { this.lookYaw = 0; this.lookPitch = 0; });
  }
  get interior() { return this.mode === 'cockpit'; }
  next() { const i = CAMS.indexOf(this.mode); this.set(CAMS[(i + 1) % CAMS.length]); }
  set(m: CamMode) {
    this.mode = m; this.init = false; this.orbit.enabled = m === 'orbit'; this.lookYaw = 0; this.lookPitch = 0;
    this.cam.fov = m === 'cockpit' ? 68 : m === 'bonnet' ? 62 : m === 'wheel' ? 50 : 58; this.cam.near = m === 'cockpit' ? 0.03 : 0.08; this.cam.updateProjectionMatrix();
  }
  update(dt: number, veh: Vehicle, car: CarVisual) {
    const root = car.root; root.updateMatrixWorld();
    const q = root.quaternion, p = root.position;
    const fwd = this.tmp.set(0, 0, 1).applyQuaternion(q);
    const yaw = Math.atan2(fwd.x, fwd.z);
    switch (this.mode) {
      case 'chase': {
        const sp = veh.speed;
        const back = 6.6 + Math.min(2, sp * 0.03), hgt = 2.2 + Math.min(0.8, sp * 0.01);
        const dx = Math.sin(yaw), dz = Math.cos(yaw);
        const want = this.v.set(p.x - dx * back, 0, p.z - dz * back); want.y = Math.max(p.y + hgt, heightAt(want.x, want.z) + 0.6);
        if (!this.init) { this.pos.copy(want); this.init = true; }
        const k = 1 - Math.exp(-dt * 5); this.pos.lerp(want, k);
        this.look.set(p.x + dx * 2.5, p.y + 0.7, p.z + dz * 2.5);
        this.cam.position.copy(this.pos); this.cam.lookAt(this.look); break;
      }
      case 'cockpit': case 'bonnet': {
        const eye = this.mode === 'cockpit' ? car.cockpitEye : new THREE.Vector3(0, 0.62, 1.1);
        this.cam.position.copy(eye).applyQuaternion(q).add(p);
        const dir = new THREE.Vector3(Math.sin(this.lookYaw) * Math.cos(this.lookPitch), Math.sin(this.lookPitch) - 0.06, Math.cos(this.lookYaw) * Math.cos(this.lookPitch));
        this.cam.up.set(0, 1, 0).applyQuaternion(q);
        this.cam.lookAt(dir.applyQuaternion(q).add(this.cam.position)); this.cam.up.set(0, 1, 0); break;
      }
      case 'wheel': {
        const off = new THREE.Vector3(4.2, -0.25, 3.0).applyQuaternion(q).add(p);
        const tgt = new THREE.Vector3(0.6, -0.45, 0.1).applyQuaternion(q).add(p);
        this.cam.position.copy(off); this.cam.lookAt(tgt); break;
      }
      case 'orbit': {
        if (!this.init) { this.cam.position.set(p.x + 5, p.y + 1.8, p.z + 5); this.init = true; }
        const d = this.v.copy(p).sub(this.orbit.target); this.orbit.target.add(d); this.cam.position.add(d); this.orbit.update(); break;
      }
      case 'trackside': {
        if (!this.init || this.trackPt.distanceTo(p) > 70) {
          const dx = Math.sin(yaw), dz = Math.cos(yaw);
          this.trackPt.set(p.x + dx * 40 + dz * 9, 0, p.z + dz * 40 - dx * 9); this.trackPt.y = heightAt(this.trackPt.x, this.trackPt.z) + 1.4; this.init = true;
        }
        this.cam.position.copy(this.trackPt); this.cam.lookAt(p.x, p.y + 0.3, p.z);
        this.cam.fov = THREE.MathUtils.clamp(2 * Math.atan(3.2 / this.trackPt.distanceTo(p)) * 180 / Math.PI, 8, 60); this.cam.updateProjectionMatrix(); break;
      }
    }
  }
}
