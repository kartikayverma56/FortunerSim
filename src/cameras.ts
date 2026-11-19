import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { Vehicle } from './physics/vehicle';
import type { CarVisual } from './vehicle/rig';
import { heightAt } from './world/terrain';

export const CAMS = ['chase', 'cockpit', 'bonnet', 'wheel', 'orbit', 'trackside'] as const;
export type CamMode = typeof CAMS[number];

const BASE_FOV: Record<CamMode, number> = { chase: 58, cockpit: 68, bonnet: 62, wheel: 50, orbit: 58, trackside: 58 };
const SPEED_FOV: Partial<Record<CamMode, number>> = { chase: 6, cockpit: 4, bonnet: 4 }; // extra degrees, reached at ~145 km/h

/** Damped spring for one axis: x'' = −ω²(x − target) − 2ζωx'. */
class Spring {
  x = 0; v = 0;
  constructor(public w: number, public z: number) {}
  step(target: number, dt: number) {
    const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n; // sub-steps keep it stable at any frame time
    for (let i = 0; i < n; i++) { this.v += (-this.w * this.w * (this.x - target) - 2 * this.z * this.w * this.v) * h; this.x += this.v * h; }
    return this.x;
  }
  reset() { this.x = 0; this.v = 0; }
}

export class CameraRig {
  cam: THREE.PerspectiveCamera;
  mode: CamMode = 'chase';
  orbit: OrbitControls;
  /** Frame-averaged vertical acceleration at the driver's seat (m/s²), set by main from veh.seatAz. */
  seatAz = 0;
  private pos = new THREE.Vector3(); private init = false;
  private trackPt = new THREE.Vector3(); private v = new THREE.Vector3(); private tmp = new THREE.Vector3();
  lookYaw = 0; lookPitch = 0; private dragging = false;
  // feel: head motion against g-forces (body frame), seat vibration, frame shake after impacts, horizon levelling
  private headX = new Spring(2 * Math.PI * 1.5, 0.55); private headZ = new Spring(2 * Math.PI * 1.5, 0.55);
  private headY = new Spring(2 * Math.PI * 2.2, 0.3);
  private seatLP = 0; private shakeA = 0; private shakeT = 9; private turnYaw = 0;
  private lpUp = new THREE.Vector3(0, 1, 0); private bodyUp = new THREE.Vector3(); private wantUp = new THREE.Vector3();
  private qCorr = new THREE.Quaternion(); private qLook = new THREE.Quaternion(); private eul = new THREE.Euler(0, 0, 0, 'YXZ');
  private velC = new THREE.Vector3(); private eye = new THREE.Vector3(); private lookS = new THREE.Vector3();

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
    this.cam.fov = BASE_FOV[m]; this.cam.near = m === 'cockpit' ? 0.03 : 0.08; this.cam.updateProjectionMatrix();
    this.headX.reset(); this.headY.reset(); this.headZ.reset(); this.turnYaw = 0;
  }
  /** Suspension impact (closing speed, m/s): starts a short 11–13 Hz body-on-frame shake. */
  kick(v: number) {
    const now = this.shakeA * Math.exp(-this.shakeT / 0.16);
    this.shakeA = Math.min(0.022, now + Math.max(0, v - 0.3) * 0.006); this.shakeT = 0;
  }

  update(dt: number, veh: Vehicle, car: CarVisual) {
    const root = car.root; root.updateMatrixWorld();
    const q = root.quaternion, p = root.position;
    const fwd = this.tmp.set(0, 0, 1).applyQuaternion(q);
    const yaw = Math.atan2(fwd.x, fwd.z);
    // shared feel signals
    this.shakeT += dt;
    const sh = this.shakeA * Math.exp(-this.shakeT / 0.16);
    const shY = sh * Math.sin(2 * Math.PI * 13 * this.shakeT), shR = sh * 0.5 * Math.sin(2 * Math.PI * 11 * this.shakeT + 1);
    this.seatLP += (this.seatAz - this.seatLP) * Math.min(1, dt / 0.08);
    const vib = THREE.MathUtils.clamp((this.seatAz - this.seatLP) * 0.0007, -0.006, 0.006); // road texture through the seat
    const sp = veh.speed;
    const extra = SPEED_FOV[this.mode];
    if (extra) {
      const want = BASE_FOV[this.mode] + extra * THREE.MathUtils.smoothstep(sp, 5, 40);
      if (Math.abs(want - this.cam.fov) > 0.01) { this.cam.fov += (want - this.cam.fov) * Math.min(1, dt * 2); this.cam.updateProjectionMatrix(); }
    }
    switch (this.mode) {
      case 'chase': {
        const back = 6.6 + Math.min(2, sp * 0.03), hgt = 2.2 + Math.min(0.8, sp * 0.01);
        const dx = Math.sin(yaw), dz = Math.cos(yaw);
        const want = this.v.set(p.x - dx * back, 0, p.z - dz * back); want.y = Math.max(p.y + hgt, heightAt(want.x, want.z) + 0.6);
        const lookW = this.tmp.set(p.x + dx * 2.5, p.y + 0.7, p.z + dz * 2.5);
        if (!this.init || this.pos.distanceTo(want) > 30) { this.pos.copy(want); this.velC.set(0, 0, 0); this.lookS.copy(lookW); this.init = true; }
        // spring follow (ω 4.5 rad/s, ζ 0.85): drops back under acceleration, closes in under braking, swings wide in turns
        const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n, w = 4.5, z = 0.85;
        for (let i = 0; i < n; i++) {
          this.velC.x += (-w * w * (this.pos.x - want.x) - 2 * z * w * this.velC.x) * h;
          this.velC.y += (-w * w * (this.pos.y - want.y) - 2 * z * w * this.velC.y) * h;
          this.velC.z += (-w * w * (this.pos.z - want.z) - 2 * z * w * this.velC.z) * h;
          this.pos.addScaledVector(this.velC, h);
        }
        this.pos.y = Math.max(this.pos.y, heightAt(this.pos.x, this.pos.z) + 0.4);
        this.lookS.lerp(lookW, 1 - Math.exp(-dt * 12));
        this.cam.position.copy(this.pos); this.cam.position.y += shY * 0.35;
        this.cam.up.set(0, 1, 0); this.cam.lookAt(this.lookS); break;
      }
      case 'cockpit': {
        // head: lags the body under acceleration (≈3 cm at 0.8 g), bobs on the seat cushion, shakes after impacts
        const a = veh.accelBody;
        const hx = THREE.MathUtils.clamp(this.headX.step(-a.x * 0.0042, dt), -0.035, 0.035);
        const hz = THREE.MathUtils.clamp(this.headZ.step(-a.z * 0.0042, dt), -0.035, 0.035);
        const hy = THREE.MathUtils.clamp(this.headY.step(-this.seatAz / (this.headY.w * this.headY.w), dt), -0.04, 0.04);
        this.eye.copy(car.cockpitEye); this.eye.x += hx; this.eye.y += hy + vib + shY; this.eye.z += hz;
        this.cam.position.copy(this.eye).applyQuaternion(q).add(p);
        // the eyes keep the horizon: remove about half of quick roll/pitch (slow slopes are still followed fully)
        this.bodyUp.set(0, 1, 0).applyQuaternion(q);
        this.lpUp.lerp(this.bodyUp, Math.min(1, dt / 0.6)).normalize();
        this.wantUp.copy(this.bodyUp).add(this.lpUp).normalize();
        this.qCorr.setFromUnitVectors(this.bodyUp, this.wantUp);
        // glance into the turn
        const tgt = THREE.MathUtils.clamp(veh.yawRate * 0.13, -0.1, 0.1) * Math.min(1, sp / 5);
        this.turnYaw += (tgt - this.turnYaw) * Math.min(1, dt * 3);
        this.eul.set(this.lookPitch - 0.06, this.lookYaw + this.turnYaw + Math.PI, shR * 0.4);
        this.qLook.setFromEuler(this.eul);
        this.cam.quaternion.copy(this.qCorr).multiply(q).multiply(this.qLook);
        this.cam.up.set(0, 1, 0); break;
      }
      case 'bonnet': {
        this.eye.set(0, 0.62 + shY * 0.6 + vib * 0.5, 1.1);
        this.cam.position.copy(this.eye).applyQuaternion(q).add(p);
        this.eul.set(-0.06, Math.PI, shR * 0.3); this.qLook.setFromEuler(this.eul);
        this.cam.quaternion.copy(q).multiply(this.qLook); this.cam.up.set(0, 1, 0); break;
      }
      case 'wheel': {
        const off = new THREE.Vector3(4.2, -0.25, 3.0).applyQuaternion(q).add(p);
        const tgt = new THREE.Vector3(0.6, -0.45, 0.1).applyQuaternion(q).add(p);
        this.cam.position.copy(off); this.cam.up.set(0, 1, 0); this.cam.lookAt(tgt); break;
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
        this.cam.position.copy(this.trackPt); this.cam.up.set(0, 1, 0); this.cam.lookAt(p.x, p.y + 0.3, p.z);
        this.cam.fov = THREE.MathUtils.clamp(2 * Math.atan(3.2 / this.trackPt.distanceTo(p)) * 180 / Math.PI, 8, 60); this.cam.updateProjectionMatrix(); break;
      }
    }
  }
}
