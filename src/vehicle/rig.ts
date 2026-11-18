// Car visual: loads the rigged Fortuner GLB from /assets (or builds a stand-in with the same node layout)
// and drives wheels, steering, suspension, rear live axle, steering wheel and gauge needles from the physics.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { Vehicle } from '../physics/vehicle';

const CORNERS = ['FL', 'FR', 'RL', 'RR'] as const;
type Corner = typeof CORNERS[number];

interface DrivenNode {
  node: THREE.Object3D; restQ: THREE.Quaternion; restP: THREE.Vector3;
  upPS: THREE.Vector3; leftPS: THREE.Vector3; fwdPS: THREE.Vector3; // body axes expressed in the node's parent space
}
interface CornerRig { spin?: DrivenNode; steer?: DrivenNode; vert?: DrivenNode; caliper?: DrivenNode }

export interface RigReport { source: string; file?: string; nodes: string[]; mapped: Record<string, string>; warnings: string[]; credit?: string }

export class CarVisual {
  root = new THREE.Group();          // follows the physics body (origin = CG, +Z forward, +X left)
  align = new THREE.Group();         // model alignment inside the body frame
  corners: Record<Corner, CornerRig> = { FL: {}, FR: {}, RL: {}, RR: {} };
  rearAxle?: DrivenNode; steeringWheel?: DrivenNode; needleTacho?: DrivenNode; needleSpeed?: DrivenNode;
  steeringAxisPS = new THREE.Vector3(); tachoAxis = new THREE.Vector3(); speedAxis = new THREE.Vector3();
  report: RigReport = { source: 'stand-in', nodes: [], mapped: {}, warnings: [] };
  cockpitEye = new THREE.Vector3(-0.38, 0.78, -0.12); // body frame, RHD driver
  overrides: any = {};
  cockpitHide: THREE.Object3D[] = [];  // stand-in only: roof/glass shells that would enclose the cockpit camera

  constructor() { this.root.add(this.align); }

  async load(veh: Vehicle, quality: 'showroom' | 'phone') {
    let file: string | undefined;
    try {
      const list: string[] = await (await fetch('/__assets')).json();
      const glbs = list.filter(f => f.toLowerCase().endsWith('.glb'));
      const pref = glbs.filter(f => /blender/i.test(f) === false);
      file = pref.find(f => new RegExp(quality, 'i').test(f)) || pref.find(f => /showroom|phone|web|rig/i.test(f)) || pref[0];
      if (list.includes('rigmap.json')) this.overrides = await (await fetch('/assets/rigmap.json')).json();
    } catch { /* no dev listing */ }
    if (file) {
      try {
        const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
        const gltf = await loader.loadAsync('/assets/' + encodeURIComponent(file));
        this.report = { source: 'glb', file, nodes: [], mapped: {}, warnings: [] };
        const asset: any = (gltf as any).parser?.json?.asset;
        const ex = asset?.extras || {};
        if (ex.author || ex.credit || asset?.copyright) this.report.credit = ex.credit || [ex.title ? `"${ex.title}"` : '', ex.author ? 'by ' + String(ex.author).replace(/\s*\(.*\)/, '') : '', ex.license ? '· ' + String(ex.license).replace(/\s*\(.*\)/, '') : '', ex.source ? '· ' + ex.source : ''].filter(Boolean).join(' ') || asset.copyright;
        this.setupModel(gltf.scene, veh);
        return;
      } catch (e: any) { this.report.warnings.push('Failed to load ' + file + ': ' + e.message); }
    }
    const standIn = buildStandIn(veh); this.setupModel(standIn, veh);
    standIn.traverse(o => { if (o.name === 'StandIn_cabin' || o.name === 'StandIn_glass') this.cockpitHide.push(o); });
    this.report.source = 'stand-in';
    this.report.warnings.push('No GLB found in D:\\FortunerSim\\assets — showing the stand-in. Copy the rigged Fortuner GLB there and reload.');
  }

  private setupModel(model: THREE.Object3D, veh: Vehicle) {
    model.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial; if (m && 'envMapIntensity' in m) m.envMapIntensity = 1.2; } });
    const names: string[] = []; model.traverse(o => { if (o.name) names.push(o.name); });
    this.report.nodes = names;
    const ov = this.overrides || {};
    const find = (key: string, res: RegExp[]): THREE.Object3D | undefined => {
      if (ov[key]) { const o = model.getObjectByName(ov[key]); if (o) { this.report.mapped[key] = o.name + ' (rigmap.json)'; return o; } }
      for (const re of res) { let hit: THREE.Object3D | undefined; model.traverse(o => { if (!hit && o.name && re.test(o.name)) hit = o; }); if (hit) { this.report.mapped[key] = hit.name; return hit; } }
      return undefined;
    };
    const cornerRe = (c: Corner) => {
      const f = c[0] === 'F' ? '(f|front)' : '(r|rear|b|back)', s = c[1] === 'L' ? '(l|left)' : '(r|right)';
      return [new RegExp(`[_\\.\\- ]${c}$`, 'i'), new RegExp(`[_\\.\\- ]${c}[_\\.\\- ]`, 'i'), new RegExp(`^${c}[_\\.\\- ]`, 'i'), new RegExp(`${f}[_\\- ]?${s}`, 'i'), new RegExp(`${s}[_\\- ]?${f}`, 'i')];
    };
    const nodeFor = (kind: string, c: Corner) => {
      const k = `${kind}_${c}`; if (ov[k]) { const o = model.getObjectByName(ov[k]); if (o) { this.report.mapped[k] = o.name + ' (rigmap.json)'; return o; } }
      const kinds: Record<string, RegExp> = { hub: /hub|wheel(?!.*steer)|tyre|tire|rim/i, steer: /steer_?axis|knuckle|upright|steer(?!ing)/i, corner: /corner|^front_|^rear_|susp/i, caliper: /caliper/i };
      let hit: THREE.Object3D | undefined;
      for (const re of cornerRe(c)) { model.traverse(o => { if (!hit && o.name && kinds[kind].test(o.name) && re.test(o.name)) hit = o; }); if (hit) break; }
      if (hit) this.report.mapped[k] = hit.name; return hit;
    };
    // ---- orientation: derive body axes from the wheel layout ----
    model.updateMatrixWorld(true);
    const hubs: Partial<Record<Corner, THREE.Object3D>> = {};
    for (const c of CORNERS) { const h = nodeFor('hub', c); if (h) hubs[c] = h; }
    const wp = (o: THREE.Object3D) => { const b = new THREE.Box3().setFromObject(o); return b.isEmpty() ? o.getWorldPosition(new THREE.Vector3()) : b.getCenter(new THREE.Vector3()); };
    let fwd = new THREE.Vector3(0, 0, 1), left = new THREE.Vector3(1, 0, 0), up = new THREE.Vector3(0, 1, 0);
    let wheelMid: THREE.Vector3 | null = null;
    if (hubs.FL && hubs.FR && hubs.RL && hubs.RR) {
      const pFL = wp(hubs.FL), pFR = wp(hubs.FR), pRL = wp(hubs.RL), pRR = wp(hubs.RR);
      fwd = pFL.clone().add(pFR).sub(pRL).sub(pRR).normalize();
      left = pFL.clone().add(pRL).sub(pFR).sub(pRR).normalize();
      up = new THREE.Vector3().crossVectors(fwd, left).normalize();
      left.crossVectors(up, fwd).normalize();
      wheelMid = pFL.add(pFR).add(pRL).add(pRR).multiplyScalar(0.25);
      const wb = wp(hubs.FL).distanceTo(wp(hubs.RL)), sc = veh.P.wheelbase.v / wb;
      if (Math.abs(sc - 1) > 0.005) { this.report.warnings.push(`Model wheelbase ${wb.toFixed(3)} m ≠ ${veh.P.wheelbase.v} m; scaled ×${sc.toFixed(3)}`); model.scale.multiplyScalar(sc); model.updateMatrixWorld(true); wheelMid = null; }
    } else this.report.warnings.push('Could not find all four wheel/hub nodes by name; wheels will not animate. Add assets/rigmap.json (see the rig inspector, key I).');
    // rotation taking model axes (fwd,left,up) → body axes (+Z,+X,+Y)
    const mBasis = new THREE.Matrix4().makeBasis(left, up, fwd);
    const qAlign = new THREE.Quaternion().setFromRotationMatrix(mBasis).invert();
    this.align.quaternion.copy(qAlign);
    this.align.add(model); this.align.updateMatrixWorld(true);
    if (!wheelMid && hubs.FL && hubs.FR && hubs.RL && hubs.RR) { this.align.updateMatrixWorld(true); wheelMid = wp(hubs.FL).add(wp(hubs.FR)).add(wp(hubs.RL)).add(wp(hubs.RR)).multiplyScalar(0.25); this.align.worldToLocal(wheelMid); wheelMid.applyQuaternion(qAlign); }
    else if (wheelMid) { wheelMid.applyQuaternion(qAlign); }
    // position: wheel-centre midpoint → body-frame point (0, yW, (a−b)/2)
    const target = new THREE.Vector3(0, veh.wheels[0].mount.y, (veh.a - veh.b) / 2);
    // if the model's tyres are smaller than the simulated ones, drop the body so the tyres still touch the road
    if (hubs.FL) { this.align.updateMatrixWorld(true); const bb = new THREE.Box3().setFromObject(hubs.FL); const rModel = (bb.max.y - bb.min.y) / 2; const rSim = veh.R - (veh.mTot * 9.81 / 4) / veh.P.tyreVerticalStiffness.v; if (rModel > 0.2 && rModel < 0.6) { target.y -= rSim - rModel; this.report.warnings.push(`Model tyre radius ${(rModel * 1000).toFixed(0)} mm vs simulated ${(rSim * 1000).toFixed(0)} mm (loaded); body lowered to keep contact`); } }
    if (wheelMid) this.align.position.copy(target).sub(wheelMid);
    else { const bb = new THREE.Box3().setFromObject(this.align); this.align.position.set(-(bb.min.x + bb.max.x) / 2, -veh.hcg - bb.min.y + 0.0, -(bb.min.z + bb.max.z) / 2); }
    this.root.updateMatrixWorld(true);

    const mk = (node: THREE.Object3D): DrivenNode => {
      const parent = node.parent!; parent.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(parent.matrixWorld).invert();
      const toPS = (v: THREE.Vector3) => v.clone().transformDirection(inv).normalize();
      return { node, restQ: node.quaternion.clone(), restP: node.position.clone(), upPS: toPS(new THREE.Vector3(0, 1, 0)), leftPS: toPS(new THREE.Vector3(1, 0, 0)), fwdPS: toPS(new THREE.Vector3(0, 0, 1)) };
    };
    this.root.updateMatrixWorld(true);
    for (const c of CORNERS) {
      const hub = hubs[c]; if (!hub) continue;
      const steer = c[0] === 'F' ? nodeFor('steer', c) : undefined;
      const corner = nodeFor('corner', c);
      this.corners[c].spin = mk(hub);
      if (steer && steer !== hub && isAncestor(steer, hub)) this.corners[c].steer = mk(steer);
      const vertNode = (corner && isAncestor(corner, hub)) ? corner : (this.corners[c].steer?.node ?? hub);
      this.corners[c].vert = vertNode === hub ? this.corners[c].spin : (vertNode === this.corners[c].steer?.node ? this.corners[c].steer : mk(vertNode));
    }
    const axle = find('rear_axle', [/rear[_\- ]?axle/i, /axle[_\- ]?r(ear)?$/i]);
    if (axle && hubs.RL && isAncestor(axle, hubs.RL)) this.rearAxle = mk(axle);
    const sw = find('steering_wheel', [/steering[_\- ]?wheel/i, /steer[_\- ]?wheel/i, /^steering$/i]);
    if (sw) { this.steeringWheel = mk(sw); this.steeringAxisPS.copy(discAxis(sw, this.steeringWheel, true)); }
    const nt = find('needle_tacho', [/(tach|rpm).*needle|needle.*(tach|rpm)/i]);
    const ns = find('needle_speed', [/speed.*needle|needle.*speed/i]);
    if (nt) { this.needleTacho = mk(nt); this.tachoAxis.copy(nearestAxisPS(nt, this.needleTacho.fwdPS)); }
    if (ns) { this.needleSpeed = mk(ns); this.speedAxis.copy(nearestAxisPS(ns, this.needleSpeed.fwdPS)); }
    if (ov.cockpitEye) this.cockpitEye.fromArray(ov.cockpitEye);
    else if (sw) { const p = sw.getWorldPosition(new THREE.Vector3()); this.root.worldToLocal(p); this.cockpitEye.set(p.x, p.y + 0.36, p.z - 0.48); }
  }

  private q1 = new THREE.Quaternion(); private q2 = new THREE.Quaternion();
  update(veh: Vehicle) {
    this.root.position.set(veh.pos.x, veh.pos.y, veh.pos.z);
    this.root.quaternion.set(veh.q.x, veh.q.y, veh.q.z, veh.q.w);
    const sgnN = this.overrides.needleSign ?? -1;
    for (let i = 0; i < 4; i++) {
      const c = CORNERS[i], r = this.corners[c], wh = veh.wheels[i];
      if (!r.spin) continue;
      const rearOnAxle = !!this.rearAxle && i >= 2;
      // vertical travel
      if (r.vert && !rearOnAxle) { const d = r.vert; d.node.position.copy(d.restP).addScaledVector(d.upPS, -wh.s / this.align.scale.y / scaleOf(d.node.parent!)); }
      // steering
      if (r.steer) { const d = r.steer; this.q1.setFromAxisAngle(d.upPS, wh.steer); d.node.quaternion.copy(this.q1).multiply(d.restQ); }
      // spin (+ steer if the hub is the only front node)
      const d = r.spin;
      this.q1.setFromAxisAngle(d.leftPS, wh.theta);
      if (!r.steer && wh.front) { this.q2.setFromAxisAngle(d.upPS, wh.steer); this.q1.premultiply(this.q2); }
      d.node.quaternion.copy(this.q1).multiply(d.restQ);
    }
    if (this.rearAxle) {
      const d = this.rearAxle, sL = veh.wheels[2].s, sR = veh.wheels[3].s;
      const track = veh.P.trackRear.v;
      d.node.position.copy(d.restP).addScaledVector(d.upPS, -(sL + sR) / 2 / scaleOf(d.node.parent!));
      this.q1.setFromAxisAngle(d.fwdPS, -Math.atan2(sL - sR, track)); d.node.quaternion.copy(this.q1).multiply(d.restQ);
    }
    if (this.steeringWheel) { const d = this.steeringWheel; this.q1.setFromAxisAngle(this.steeringAxisPS, veh.steerWheelAngle); d.node.quaternion.copy(this.q1).multiply(d.restQ); }
    if (this.needleTacho) { const d = this.needleTacho; this.q1.setFromAxisAngle(this.tachoAxis, sgnN * veh.rpm / 1000 * (this.overrides.tachoDegPer1000 ?? 40) * Math.PI / 180); d.node.quaternion.copy(this.q1).multiply(d.restQ); }
    if (this.needleSpeed) { const d = this.needleSpeed; this.q1.setFromAxisAngle(this.speedAxis, sgnN * veh.kmh / 20 * (this.overrides.speedDegPer20 ?? 13) * Math.PI / 180); d.node.quaternion.copy(this.q1).multiply(d.restQ); }
  }
}

function isAncestor(a: THREE.Object3D, b: THREE.Object3D) { let p: THREE.Object3D | null = b; while (p) { if (p === a) return true; p = p.parent; } return false; }
function scaleOf(o: THREE.Object3D) { const s = new THREE.Vector3(); o.getWorldScale(s); return s.y || 1; }
/** For a disc-shaped node (steering wheel), its rotation axis = thinnest bbox axis, expressed in parent space, pointing toward the driver (−body fwd). */
function discAxis(node: THREE.Object3D, d: DrivenNode, towardDriver: boolean) {
  const box = new THREE.Box3(); const inv = new THREE.Matrix4().copy(node.matrixWorld).invert();
  node.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry) { m.geometry.computeBoundingBox(); const bb = m.geometry.boundingBox!.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld)); box.union(bb); } });
  const s = box.getSize(new THREE.Vector3());
  const ax = s.x <= s.y && s.x <= s.z ? new THREE.Vector3(1, 0, 0) : s.y <= s.z ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  ax.applyQuaternion(node.quaternion).normalize(); // node local → parent space
  if (towardDriver && ax.dot(d.fwdPS) > 0) ax.negate();
  return ax;
}
function nearestAxisPS(node: THREE.Object3D, fwdPS: THREE.Vector3) {
  const axes = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)].map(a => a.applyQuaternion(node.quaternion));
  let best = axes[0], bd = -1; for (const a of axes) { const d = Math.abs(a.dot(fwdPS)); if (d > bd) { bd = d; best = a; } }
  return best.dot(fwdPS) > 0 ? best.clone().negate() : best.clone();
}

// ---------------- stand-in with the same node layout (generic SUV proportions, not a replica) ----------------
function buildStandIn(veh: Vehicle) {
  const P = veh.P;
  const root = new THREE.Group(); root.name = 'StandIn_root';
  const paint = new THREE.MeshPhysicalMaterial({ color: 0x8a1c1c, metalness: 0.6, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 });
  const black = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.8 });
  const glass = new THREE.MeshPhysicalMaterial({ color: 0x1a2630, metalness: 0, roughness: 0.05, transmission: 0.2, transparent: true, opacity: 0.82 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xcccccc, metalness: 1, roughness: 0.15 });
  const L = P.length.v, W = P.width.v, H = P.height.v, wb = P.wheelbase.v;
  const zF = wb / 2 + P.overhangFront.v, zR = -wb / 2 - P.overhangRear.v; // wheel-mid frame (z=0 midway between axles)
  const R = P.tyreRadius.v;
  const chassis = new THREE.Group(); chassis.name = 'Chassis_sprung'; root.add(chassis);
  // lower body
  const lower = new THREE.Mesh(roundedBox(L - 0.1, 0.62, W - 0.04, 0.12), paint); lower.position.set(0, 0.74 - R, (zF + zR) / 2); chassis.add(lower);
  const cabin = new THREE.Mesh(roundedBox(L * 0.6, 0.66, W - 0.16, 0.16), paint); cabin.position.set(0, 1.05 + 0.33 - R, (zF + zR) / 2 - 0.3); cabin.name = 'StandIn_cabin'; chassis.add(cabin);
  const glassBand = new THREE.Mesh(roundedBox(L * 0.6 + 0.02, 0.38, W - 0.13, 0.1), glass); glassBand.position.copy(cabin.position).add(new THREE.Vector3(0, 0.03, 0)); glassBand.name = 'StandIn_glass'; chassis.add(glassBand);
  const hood = new THREE.Mesh(roundedBox(1.25, 0.12, W - 0.1, 0.05), paint); hood.position.set(0, lower.position.y + 0.33, zF - 0.75); hood.rotation.x = 0.06; chassis.add(hood);
  const grille = new THREE.Mesh(new THREE.BoxGeometry(W * 0.62, 0.32, 0.04), black); grille.position.set(0, lower.position.y + 0.12, zF - 0.02); chassis.add(grille);
  for (const s of [-1, 1]) { const hl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.1, 0.05), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff4d6, emissiveIntensity: 0.6 })); hl.position.set(s * W * 0.36, lower.position.y + 0.22, zF - 0.03); chassis.add(hl); const tl = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.32, 0.05), new THREE.MeshStandardMaterial({ color: 0x990000, emissive: 0x550000 })); tl.position.set(s * (W / 2 - 0.08), lower.position.y + 0.2, zR + 0.03); chassis.add(tl); }
  const roofRails = new THREE.Mesh(new THREE.BoxGeometry(W - 0.4, 0.04, L * 0.5), chrome); roofRails.position.set(0, cabin.position.y + 0.33, cabin.position.z); chassis.add(roofRails);
  const skid = new THREE.Mesh(new THREE.BoxGeometry(W * 0.7, 0.05, 1.2), new THREE.MeshStandardMaterial({ color: 0x555555, metalness: 0.5 })); skid.position.set(0, P.groundClearance.v - R + 0.03, wb / 2 - 0.1); chassis.add(skid);
  // interior: dashboard, seats, steering wheel, gauges (RHD: driver on −X)
  const dash = new THREE.Mesh(new THREE.BoxGeometry(W - 0.25, 0.25, 0.4), new THREE.MeshStandardMaterial({ color: 0x2a2522, roughness: 0.9 })); dash.position.set(0, cabin.position.y - 0.12, cabin.position.z + 0.95); chassis.add(dash);
  for (const x of [-0.42, 0.42]) { const seat = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.6, 0.12), new THREE.MeshStandardMaterial({ color: 0x3b2a20 })); seat.position.set(x, cabin.position.y - 0.05, cabin.position.z + 0.05); seat.rotation.x = -0.15; chassis.add(seat); }
  const swPivot = new THREE.Group(); swPivot.name = 'SteeringWheel'; swPivot.position.set(-0.4, cabin.position.y - 0.02, cabin.position.z + 0.68); swPivot.rotation.x = -0.45; chassis.add(swPivot);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.022, 10, 36), black); swPivot.add(ring);
  const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.035, 0.02), black); swPivot.add(spoke); const logo = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 16).rotateX(Math.PI / 2), chrome); swPivot.add(logo);
  const cluster = new THREE.Group(); cluster.position.set(-0.4, cabin.position.y + 0.05, cabin.position.z + 0.88); cluster.rotation.x = -0.35; chassis.add(cluster);
  for (const [nm, x] of [['Needle_tacho', 0.1], ['Needle_speed', -0.1]] as [string, number][]) {
    const dial = new THREE.Mesh(new THREE.CircleGeometry(0.075, 32), new THREE.MeshBasicMaterial({ color: 0x0c0c0c })); dial.position.set(x, 0, 0.001); dial.rotation.y = Math.PI; cluster.add(dial);
    const piv = new THREE.Group(); piv.name = nm; piv.position.set(x, 0, -0.004); cluster.add(piv);
    const nd = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.065, 0.002).translate(0, 0.03, 0), new THREE.MeshBasicMaterial({ color: 0xff4020 })); nd.rotation.z = 2.2; const holder = new THREE.Group(); holder.add(nd); piv.add(holder);
  }
  // wheels
  const tyreMat = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.95 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xb8bcc0, metalness: 0.9, roughness: 0.25 });
  const makeWheel = (name: string, x: number) => {
    const hub = new THREE.Group(); hub.name = name;
    const tyre = new THREE.Mesh(new THREE.CylinderGeometry(R, R, P.tyreWidth.v, 40, 1).rotateZ(Math.PI / 2), tyreMat); hub.add(tyre);
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.62, R * 0.62, P.tyreWidth.v + 0.01, 6, 1).rotateZ(Math.PI / 2), rimMat); hub.add(rim);
    for (let k = 0; k < 6; k++) { const sp = new THREE.Mesh(new THREE.BoxGeometry(0.02, R * 1.1, 0.05), rimMat); sp.position.x = Math.sign(x) * (P.tyreWidth.v / 2 + 0.006); sp.rotation.x = k * Math.PI / 3; hub.add(sp); }
    return hub;
  };
  const tf = P.trackFront.v / 2, trr = P.trackRear.v / 2;
  for (const [c, x] of [['FL', tf], ['FR', -tf]] as [string, number][]) {
    const corner = new THREE.Group(); corner.name = `Corner_${c}`; corner.position.set(x, 0, wb / 2); chassis.add(corner);
    const steer = new THREE.Group(); steer.name = `Steer_axis_${c}`; corner.add(steer);
    const cal = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.16, 0.12), new THREE.MeshStandardMaterial({ color: 0xb01010 })); cal.name = `Caliper_${c}`; cal.position.set(-Math.sign(x) * 0.05, 0.12, -0.08); steer.add(cal);
    steer.add(makeWheel(`Hub_${c}`, x));
  }
  const axle = new THREE.Group(); axle.name = 'Rear_axle'; axle.position.set(0, 0, -wb / 2); root.add(axle);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, P.trackRear.v - 0.2, 10).rotateZ(Math.PI / 2), black); axle.add(beam);
  const diff = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), black); diff.position.y = -(R - P.groundClearance.v) + 0.17; axle.add(diff);
  for (const [c, x] of [['RL', trr], ['RR', -trr]] as [string, number][]) { const h = makeWheel(`Hub_${c}`, x); h.position.x = x; axle.add(h); }
  // rear axle must follow the body (it is a sibling of the chassis here, both children of root which tracks the body)
  root.traverse(o => { o.castShadow = true; });
  return root;
}

function roundedBox(w: number, h: number, d: number, r: number) {
  const s = new THREE.Shape(); const x = -d / 2, y = -h / 2;
  s.moveTo(x + r, y); s.lineTo(x + d - r, y); s.quadraticCurveTo(x + d, y, x + d, y + r); s.lineTo(x + d, y + h - r); s.quadraticCurveTo(x + d, y + h, x + d - r, y + h); s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r); s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: w, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 3 });
  g.translate(0, 0, -w / 2); return g; // shape spans X (width) × Y (height), extruded along Z (length)
}
