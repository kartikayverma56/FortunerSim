// Car visual: loads the rigged Fortuner GLB from /assets (or builds a stand-in with the same node layout)
// and drives wheels, steering, suspension, rear live axle, steering wheel and gauge needles from the physics.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Vehicle } from '../physics/vehicle';
import { hsrpTexture, PLATE_ASPECT } from './plate';

const CORNERS = ['FL', 'FR', 'RL', 'RR'] as const;
type Corner = typeof CORNERS[number];

interface DrivenNode {
  node: THREE.Object3D; restQ: THREE.Quaternion; restP: THREE.Vector3;
  upPS: THREE.Vector3; leftPS: THREE.Vector3; fwdPS: THREE.Vector3; // body axes expressed in the node's parent space
}
interface CornerRig { spin?: DrivenNode; steer?: DrivenNode; vert?: DrivenNode; caliper?: DrivenNode }

/** interior, left (+X, passenger side on this RHD car), right (−X, driver side) */
export type MirrorId = 'interior' | 'left' | 'right';
/** Window glass panes split before the merge so they can shatter separately (damageVisual.ts). */
export type GlassPane = 'front' | 'rear' | 'left' | 'right';
/** Where a lamp material sits: side (left = +X) and end. */
export interface LampSpot { side: 'left' | 'right' | 'centre' | 'both'; front: boolean }

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
  // lamps: emissive materials split per function / side before the draw-call merge (empty on the stand-in)
  lampMats = { brake: [] as THREE.MeshStandardMaterial[], left: [] as THREE.MeshStandardMaterial[], right: [] as THREE.MeshStandardMaterial[] };
  reverseLamps?: THREE.Mesh; plates?: THREE.Mesh;
  /** Mirror glasses, each on its own material so the merge keeps it a separate mesh (src/render/mirrors.ts finds them
   *  again by material). Empty on the stand-in. */
  mirrorMats: Partial<Record<MirrorId, THREE.MeshStandardMaterial>> = {};
  /** Rear window box in the body frame (for the interior mirror's cabin mask), if found. */
  rearWindow?: THREE.Box3;
  private glassMats: THREE.MeshStandardMaterial[] = [];
  /** Window glass by pane (empty on the stand-in). */
  glassPane: Partial<Record<GlassPane, THREE.MeshStandardMaterial>> = {};
  /** Lamp materials → position, and the ones smashed in a crash (they stay dark). */
  lampSpot = new Map<THREE.Material, LampSpot>(); brokenLamps = new Set<THREE.Material>();
  private shadowProxyMat: THREE.Material | null = null;
  private lampState = { brake: -1, reverse: false, left: false, right: false, interior: false };

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
        this.materialPass(gltf.scene, veh);
        this.addPlatesAndReverseLamps(gltf.scene, veh);
        limitShadowCasters(this.root);
        const casters = buildShadowProxy(this.root); this.shadowProxyMat = casters.mat; // one shadow-only mesh instead of ~45 shadow-pass draws
        const merged = this.mergeStatic(gltf.scene);
        this.report.warnings.push(`Draw-call merge: ${merged.before} static meshes → ${merged.after}; ${casters.n} shadow casters → 1 proxy`);
        return;
      } catch (e: any) { this.report.warnings.push('Failed to load ' + file + ': ' + e.message); }
    }
    const standIn = buildStandIn(veh); this.setupModel(standIn, veh);
    standIn.traverse(o => { if (o.name === 'StandIn_cabin' || o.name === 'StandIn_glass') this.cockpitHide.push(o); });
    this.report.source = 'stand-in';
    this.report.warnings.push('No GLB found in D:\\FortunerSim\\assets — showing the stand-in. Copy the rigged Fortuner GLB there and reload.');
  }

  /** Merge every static mesh per material: ~310 car meshes → a few dozen draw calls (each was drawn twice with shadows). */
  private mergeStatic(model: THREE.Object3D) {
    const keep = new Set<THREE.Object3D>();
    const add = (d?: DrivenNode) => { if (d) keep.add(d.node); };
    for (const c of CORNERS) { const r = this.corners[c]; add(r.spin); add(r.steer); add(r.vert); add(r.caliper); }
    add(this.rearAxle); add(this.steeringWheel); add(this.needleTacho); add(this.needleSpeed);
    for (const o of this.cockpitHide) keep.add(o);
    const total = bakeInto(model, keep);
    // the moving parts (wheels, steering wheel, needles) are merged per material inside themselves too
    for (const node of keep) { const r = bakeInto(node, keep); total.before += r.before; total.after += r.after; }
    return total;
  }

  private setupModel(model: THREE.Object3D, veh: Vehicle) {
    model.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
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
    // position: wheel-centre midpoint → body-frame point (centreline −xcg, yW, (a−b)/2)
    const target = new THREE.Vector3(-veh.xcg, veh.wheels[0].mount.y, (veh.a - veh.b) / 2);
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

  /** Realism pass on the GLB's materials (the Sketchfab export marks most plastics as 40–90 % metal, the glass as a
   *  mirror and the tyres as shiny plastic), and split the lamp materials by function and side so they can light up.
   *  Runs in the body frame (root still at the origin), before the draw-call merge. */
  private materialPass(model: THREE.Object3D, veh: Vehicle) {
    const yWheel = veh.wheels[0].mount.y, zRear = -veh.b;
    const variants = new Map<string, THREE.MeshStandardMaterial>();
    const variant = (m: THREE.MeshStandardMaterial, tag: string, setup: (c: THREE.MeshStandardMaterial) => void) => {
      const k = m.uuid + '|' + tag; let c = variants.get(k);
      if (!c) { c = m.clone(); c.name = m.name + '_' + tag; setup(c); variants.set(k, c); }
      return c;
    };
    const lamp = (c: THREE.MeshStandardMaterial, hex: number) => { c.emissive.setHex(hex); c.emissiveIntensity = 0; c.emissiveMap = null; c.userData.offColor = c.color.clone(); c.toneMapped = false; return c; }; // untone-mapped: lit LEDs stay red / amber instead of washing to salmon
    const meshes: THREE.Mesh[] = []; model.traverse(o => { const m = o as THREE.Mesh; if (m.isMesh && !Array.isArray(m.material)) meshes.push(m); });
    const tuned = new Set<THREE.Material>(); const box = new THREE.Box3(), c = new THREE.Vector3();
    model.updateMatrixWorld(true);
    // mirror glass: rigmap.json may name the meshes ("mirror_interior" / "mirror_left" / "mirror_right": a mesh or
    // node name, or a list of them); otherwise the chrome_only glasses are found by position and shape
    const ov = this.overrides || {};
    const named = (id: MirrorId, mesh: THREE.Mesh) => { const v = ov['mirror_' + id]; if (!v) return false; const list: string[] = Array.isArray(v) ? v : [v]; return list.includes(mesh.name) || (!!mesh.parent && list.includes(mesh.parent.name)); };
    const hasOv = (['interior', 'left', 'right'] as MirrorId[]).some(id => ov['mirror_' + id]);
    const mirrorMat = (m: THREE.MeshStandardMaterial, id: MirrorId, cabin: boolean) => variant(m, 'mirror_' + id, v => { if (cabin) cabinMirror(v); this.mirrorMats[id] = v; });
    const cabinMirror = (v: THREE.MeshStandardMaterial) => { v.color.setHex(0x2b3036); v.roughness = 0.3; v.envMapIntensity = 0.45; };
    for (const mesh of meshes) {
      const m = mesh.material as THREE.MeshStandardMaterial; if (!('metalness' in m)) continue;
      if (!tuned.has(m)) { tuned.add(m); tuneMaterial(m); if (m.name === 'windows_glass') this.glassMats.push(m); }
      box.setFromObject(mesh).getCenter(c);
      const n = m.name;
      if (hasOv) { const id = (['interior', 'left', 'right'] as MirrorId[]).find(i => named(i, mesh)); if (id) { mesh.material = mirrorMat(m, id, id === 'interior'); this.report.mapped['mirror_' + id] = mesh.name + ' (rigmap.json)'; continue; } }
      if (n === 'windows_glass' && c.z < zRear - 0.5) { const b = new THREE.Box3().setFromObject(mesh); if (b.max.x - b.min.x > 0.8) (this.rearWindow ??= new THREE.Box3()).union(b); }
      if (n === 'windows_glass') { // split by pane (wide panes are the windscreen / rear window; the rest go by side)
        const b = new THREE.Box3().setFromObject(mesh), wide = b.max.x - b.min.x > 0.9;
        const pane: GlassPane = wide ? (c.z > 0 ? 'front' : 'rear') : c.x > 0 ? 'left' : 'right';
        mesh.material = variant(m, 'glass_' + pane, v => { this.glassPane[pane] = v; this.glassMats.push(v); });
        continue;
      }
      const sideOf = (): 'left' | 'right' => c.x > 0 ? 'left' : 'right';
      // a lamp mesh that spans both sides (one tail-lamp mesh on this model) breaks with either rear corner
      const spans = () => { const bb = new THREE.Box3().setFromObject(mesh); return bb.min.x < -0.3 && bb.max.x > 0.3; };
      if (n === 'r_tailight' && c.z < zRear - 0.4) { const side = spans() ? 'both' : sideOf(); mesh.material = variant(m, 'brake_' + side, v => { this.lampMats.brake.push(lamp(v, 0xff0000)); this.lampSpot.set(v, { side, front: false }); }); }
      else if (n === 'r_glass' && c.y > yWheel + 1.0) mesh.material = variant(m, 'hmsl', v => { this.lampMats.brake.push(lamp(v, 0xff0000)); this.lampSpot.set(v, { side: 'centre', front: false }); }); // high-mount stop lamp
      else if (n === 'ind_tailighjt' || n === 'indicator_signal') { const side = sideOf(), front = c.z > 0; mesh.material = variant(m, side + (front ? '_f' : '_r'), v => { this.lampMats[side].push(lamp(v, 0xff6a00)); this.lampSpot.set(v, { side, front }); }); }
      else if (n === 'chrome_only' && Math.abs(c.x) < 0.4 && c.y > yWheel + 0.95) { // interior mirror area
        // the glass is the flat, rear-facing part; the rest (housing, roof console) keeps the dark cabin finish
        const glass = !hasOv && facing(mesh) > 0.6;
        mesh.material = glass ? mirrorMat(m, 'interior', true) : variant(m, 'cabin', cabinMirror);
        if (glass) this.report.mapped.mirror_interior = mesh.name;
      } else if (n === 'chrome_only' && !hasOv && Math.abs(c.x) > 0.88) { // door mirror glass
        const id: MirrorId = c.x > 0 ? 'left' : 'right';
        mesh.material = mirrorMat(m, id, false); this.report.mapped['mirror_' + id] = mesh.name;
      }
    }
  }

  /** Meshes now carrying the mirror materials (call after load; the merge may have replaced the original meshes). */
  mirrorMeshes() {
    const out: { id: MirrorId; mesh: THREE.Mesh }[] = [];
    const byMat = new Map<THREE.Material, MirrorId>(); for (const [id, m] of Object.entries(this.mirrorMats)) byMat.set(m!, id as MirrorId);
    this.root.traverse(o => { const m = o as THREE.Mesh; const id = m.isMesh && byMat.get(m.material as THREE.Material); if (id) out.push({ id, mesh: m }); });
    return out;
  }

  /** HSRP plates over the model's own plate decals, and white reverse lamps on the inner (tailgate) tail-lamp sections. */
  private addPlatesAndReverseLamps(model: THREE.Object3D, veh: Vehicle) {
    const yWheel = veh.wheels[0].mount.y;
    model.updateMatrixWorld(true);
    const decals: THREE.Mesh[] = [], inds: THREE.Mesh[] = [];
    model.traverse(o => {
      const m = o as THREE.Mesh; if (!m.isMesh || Array.isArray(m.material)) return;
      if (m.material.name === 'decal_int') decals.push(m);
      if (/^ind_tailighjt/.test(m.material.name)) inds.push(m);
    });
    const rc = new THREE.Raycaster(), o = new THREE.Vector3(), d = new THREE.Vector3(), nW = new THREE.Vector3();
    // plates: the model has flat "NEW FORTUNER" plate decals; find each one by casting rays at the bumpers
    const geos: THREE.BufferGeometry[] = [];
    for (const sgn of [1, -1]) {
      const pts: THREE.Vector3[] = []; d.set(0, 0, -sgn);
      for (let x = -0.5; x <= 0.5; x += 0.025) for (let y = yWheel - 0.4; y <= yWheel + 0.9; y += 0.02) {
        rc.set(o.set(x, y, sgn * 6), d); rc.far = 12;
        const h = rc.intersectObjects(decals, false)[0];
        if (h?.face && Math.abs(nW.copy(h.face.normal).transformDirection(h.object.matrixWorld).z) > 0.9) pts.push(h.point.clone());
      }
      if (pts.length < 12) continue;
      const zx = sgn > 0 ? Math.max(...pts.map(p => p.z)) : Math.min(...pts.map(p => p.z));
      const bb = new THREE.Box3(); for (const p of pts) if (Math.abs(p.z - zx) < 0.02) bb.expandByPoint(p);
      const ctr = bb.getCenter(new THREE.Vector3()), w = THREE.MathUtils.clamp(bb.max.x - bb.min.x + 0.025, 0.38, 0.52);
      const g = new THREE.PlaneGeometry(w, w / PLATE_ASPECT); if (sgn < 0) g.rotateY(Math.PI);
      g.translate(ctr.x, ctr.y, zx + sgn * 0.003); geos.push(g);
    }
    if (geos.length) {
      const mat = new THREE.MeshStandardMaterial({ map: hsrpTexture(), roughness: 0.45, metalness: 0, envMapIntensity: 0.6, name: 'hsrp_plate' });
      this.plates = new THREE.Mesh(mergeGeometries(geos, false)!, mat); this.plates.name = 'HSRP_plates'; this.plates.receiveShadow = true;
      this.root.add(this.plates);
    } else this.report.warnings.push('Plate decals not found: no number plates added');
    // reverse lamps: just below the indicator strip on the innermost three segments of each side
    const quads: THREE.BufferGeometry[] = [];
    for (const side of [1, -1]) {
      const segs = inds.map(m => ({ m, c: new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3()) }))
        .filter(e => Math.sign(e.c.x) === side && e.c.z < 0).sort((a, b) => Math.abs(a.c.x) - Math.abs(b.c.x)).slice(0, 3);
      if (segs.length < 2) continue;
      const bb = new THREE.Box3(); for (const e of segs) bb.expandByObject(e.m);
      const ctr = bb.getCenter(new THREE.Vector3());
      const g = new THREE.PlaneGeometry(Math.max(0.08, bb.max.x - bb.min.x) + 0.02, 0.034).rotateY(Math.PI); // faces rearward
      g.translate(ctr.x, bb.min.y - REV_DROP, bb.min.z - 0.004); quads.push(g);
    }
    if (quads.length) {
      this.reverseLamps = new THREE.Mesh(mergeGeometries(quads, false)!, new THREE.MeshBasicMaterial({ map: lampGlowTexture(), color: 0xfffaf0, transparent: true, depthWrite: false, toneMapped: false, name: 'reverse_lamp' }));
      this.reverseLamps.name = 'Reverse_lamps'; this.reverseLamps.visible = false; this.root.add(this.reverseLamps);
    }
  }

  /** Brake 0..1, reverse, left/right indicator lamp state (only touches materials when something changes). */
  private forceLamps = false;
  setLamps(brake: number, reverse: boolean, left: boolean, right: boolean) {
    const s = this.lampState; brake = Math.round(brake * 20) / 20;
    if (this.forceLamps) { this.forceLamps = false; s.left = !left; s.right = !right; s.reverse = !reverse; }
    // lit: the lens colour gives way to the LED colour (clear indicator strips turn amber, not pale orange)
    const light = (mats: THREE.MeshStandardMaterial[], on: number, k: number, litColor: number) => { for (const m of mats) { if (this.brokenLamps.has(m)) continue; m.emissiveIntensity = on * k; if (on) m.color.setHex(litColor); else m.color.copy(m.userData.offColor); } };
    if (brake !== s.brake) { s.brake = brake; light(this.lampMats.brake, brake, 2.4, 0x300000); }
    if (left !== s.left) { s.left = left; light(this.lampMats.left, left ? 1 : 0, 2.6, 0x201000); }
    if (right !== s.right) { s.right = right; light(this.lampMats.right, right ? 1 : 0, 2.6, 0x201000); }
    if (reverse !== s.reverse) { s.reverse = reverse; if (this.reverseLamps) this.reverseLamps.visible = reverse && !this.reverseBroken; }
  }
  reverseBroken = false;
  /** Smashes (dark, cracked lens) or restores a lamp material. */
  breakLamp(m: THREE.MeshStandardMaterial, broken: boolean) {
    if (broken === this.brokenLamps.has(m)) return;
    if (broken) { this.brokenLamps.add(m); m.emissiveIntensity = 0; m.color.copy(m.userData.offColor).multiplyScalar(0.35); m.roughness = 0.7; }
    else { this.brokenLamps.delete(m); m.color.copy(m.userData.offColor); m.roughness = 0.25; }
    this.lampState.brake = -1; this.forceLamps = true; // refresh on the next setLamps
  }
  /** From the driver's seat the windows look nearly clear; from outside the tinted glass hides most of the cabin. */
  setInterior(on: boolean) {
    if (on === this.lampState.interior) return; this.lampState.interior = on;
    for (const m of this.glassMats) { m.opacity = on ? 0.12 : GLASS_OUT; m.color.setHex(on ? 0x56625c : 0x1c2622); }
  }

  private q1 = new THREE.Quaternion(); private q2 = new THREE.Quaternion();
  update(veh: Vehicle) {
    if (this.shadowProxyMat) this.shadowProxyMat.visible = false; // in case last frame skipped the shadow pass
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

const PAINT = 0x5b5f63;   // close to Toyota's "Grey Metallic"
const GLASS_OUT = 0.5;    // window opacity seen from outside
const REV_DROP = 0.022;   // reverse lamp centre below the indicator strip, m
/** Fix the export's material values: non-metals at metalness 0, rubber matte, glass clear-ish, paint with depth. */
function tuneMaterial(m: THREE.MeshStandardMaterial) {
  const n = m.name;
  if (!/^(chrome|chrome_int|chrome_only|material|carpaint|Material_20|indicator_arrow)$/.test(n)) m.metalness = 0;
  m.envMapIntensity = /_int$|leather|egg|stitch|seat|plastic_1/.test(n) ? 0.3 : 1;
  switch (n) {
    case 'carpaint': {
      const p = m as THREE.MeshPhysicalMaterial; p.color.setHex(PAINT); p.metalness = 0.45; p.roughness = 0.4;
      if (p.isMeshPhysicalMaterial) { p.clearcoat = 1; p.clearcoatRoughness = 0.03; }
      break;
    }
    case 'tire': case 'Material_18': m.roughness = 0.92; m.envMapIntensity = 0.35; break; // tread / sidewall rubber
    case 'windows_glass': m.color.setHex(0x1c2622); m.roughness = 0.04; m.transparent = true; m.opacity = GLASS_OUT; m.depthWrite = false; m.envMapIntensity = 1.6; break;
    case 'Material_8': case 'r_glass': case 'glass_decal': m.roughness = 0.05; m.depthWrite = false; break; // lamp lenses
    case 'chrome_only': m.color.setHex(0x7c848c); m.roughness = 0.1; break; // door mirrors on Low: tinted, slightly soft (Medium / High: live, src/render/mirrors.ts)
    case 'plastic_egg': case 'leather_egg': m.color.multiplyScalar(0.78); m.roughness = 0.9; m.envMapIntensity = 0.22; break; // headliner, pillars
    case 'r_tailight': case 'ind_tailighjt': m.roughness = 0.25; break;
    case 'black': case 'Material_4': m.roughness = Math.max(m.roughness, 0.5); break;
  }
  if (m.transparent && m.side === THREE.DoubleSide) m.forceSinglePass = true; // one draw instead of back + front passes
  m.needsUpdate = true;
}

/** Soft-edged white bar for the reverse lamps (bright core, blurred rim). */
function lampGlowTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 32;
  const g = c.getContext('2d')!; g.filter = 'blur(3px)'; g.fillStyle = '#fff';
  g.beginPath(); g.roundRect(6, 6, 116, 20, 8); g.fill();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

/** How flat and fore/aft-facing a mesh is: |Σ area·n_z| / Σ area in the body frame (1 = flat panel facing ±Z). */
function facing(mesh: THREE.Mesh) {
  const g = mesh.geometry, p = g.attributes.position, idx = g.index; if (!p) return 0;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), s = new THREE.Vector3();
  let sz = 0, area = 0; const n = idx ? idx.count : p.count;
  for (let i = 0; i + 2 < n; i += 3) {
    const i0 = idx ? idx.getX(i) : i, i1 = idx ? idx.getX(i + 1) : i + 1, i2 = idx ? idx.getX(i + 2) : i + 2;
    a.fromBufferAttribute(p, i0).applyMatrix4(mesh.matrixWorld); b.fromBufferAttribute(p, i1).applyMatrix4(mesh.matrixWorld); c.fromBufferAttribute(p, i2).applyMatrix4(mesh.matrixWorld);
    s.crossVectors(b.sub(a), c.sub(a)); sz += s.z; area += s.length();
  }
  return area > 0 ? Math.abs(sz) / area : 0;
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

/** Copy of a geometry with every attribute as plain Float32 (meshopt GLBs store quantised Int16/Int8 attributes,
 *  which can't be transformed in place or merged with float ones). */
function toFloat(g: THREE.BufferGeometry, only?: string[]) {
  const out = new THREE.BufferGeometry();
  const get = ['getX', 'getY', 'getZ', 'getW'] as const;
  for (const [name, a] of Object.entries(g.attributes)) {
    if (only && !only.includes(name)) continue;
    const n = a.count, k = a.itemSize, arr = new Float32Array(n * k);
    for (let i = 0; i < n; i++) for (let c = 0; c < k; c++) arr[i * k + c] = (a as any)[get[c]](i); // getX… de-normalise
    out.setAttribute(name, new THREE.BufferAttribute(arr, k));
  }
  if (g.index) out.setIndex(new THREE.BufferAttribute(Uint32Array.from(g.index.array as ArrayLike<number>), 1));
  return out;
}

/** Meshes the rig moves or hides; everything else on the model is static relative to the model root. */
function bakeInto(root: THREE.Object3D, keep: Set<THREE.Object3D>) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const groups = new Map<string, { mat: THREE.Material; cast: boolean; recv: boolean; geos: THREE.BufferGeometry[]; meshes: THREE.Mesh[] }>();
  root.traverse(o => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material) || m.children.length || (m as any).isSkinnedMesh || (m as any).isInstancedMesh) return;
    for (let p: THREE.Object3D | null = m; p && p !== root; p = p.parent) if (keep.has(p)) return;
    const g = m.geometry;
    if (Object.keys(g.morphAttributes).length) return;
    const attrs = usedAttributes(m.material, g); // drop unused uv / colour so meshes of one material share a key
    const key = [m.material.uuid, attrs.join(','), !!g.index, m.castShadow, m.receiveShadow].join('|');
    let e = groups.get(key); if (!e) groups.set(key, e = { mat: m.material, cast: m.castShadow, recv: m.receiveShadow, geos: [], meshes: [] });
    const mat = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    const geo = toFloat(g, attrs).applyMatrix4(mat);
    if (mat.determinant() < 0 && geo.index) { const a = geo.index.array; for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; } }
    e.geos.push(geo); e.meshes.push(m);
  });
  let before = 0, after = 0;
  for (const e of groups.values()) {
    before += e.meshes.length;
    if (e.meshes.length < 2) { after += e.meshes.length; continue; }
    const geo = mergeGeometries(e.geos, false);
    if (!geo) { after += e.meshes.length; continue; }
    const mesh = new THREE.Mesh(geo, e.mat); mesh.castShadow = e.cast; mesh.receiveShadow = e.recv; mesh.name = 'merged_' + (e.mat.name || 'mat');
    root.add(mesh); after++;
    for (const m of e.meshes) { m.removeFromParent(); m.geometry.dispose(); }
  }
  return { before, after };
}

/** Attributes the material actually reads (sorted). */
function usedAttributes(mat: THREE.Material, g: THREE.BufferGeometry) {
  const m = mat as THREE.MeshPhysicalMaterial;
  const mapped = !!(m.map || m.normalMap || m.roughnessMap || m.metalnessMap || m.aoMap || m.emissiveMap || m.alphaMap || m.bumpMap || m.lightMap || m.clearcoatNormalMap || m.clearcoatMap || m.specularIntensityMap || m.specularColorMap);
  return Object.keys(g.attributes).filter(n => n === 'position' || n === 'normal' || (n === 'uv' && mapped) || (n === 'color' && m.vertexColors) || (n === 'tangent' && !!m.normalMap)).sort();
}

/** Replace every shadow-casting car part with one position-only mesh drawn only in the shadow pass. The wheels are
 *  baked at rest (a tyre's shadow looks the same while it spins). Returns how many casters were folded in.
 *  three tests the same camera layers in the main and the shadow pass, so "shadow only" works through the
 *  material's visible flag: off while the main render list is built, switched on by a gate object that three
 *  visits right after the proxy (it poses as an LOD, whose update() runs during list building), off again after
 *  the proxy's shadow draw. */
function buildShadowProxy(root: THREE.Object3D) {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const geos: THREE.BufferGeometry[] = []; let n = 0;
  root.traverse(o => {
    const m = o as THREE.Mesh; if (!m.isMesh || !m.castShadow) return;
    m.castShadow = false; n++;
    const mat = new THREE.Matrix4().multiplyMatrices(inv, m.matrixWorld);
    const g = toFloat(m.geometry, ['position']).applyMatrix4(mat);
    if (!g.index) { const c = g.attributes.position.count, idx = new Uint32Array(c); for (let i = 0; i < c; i++) idx[i] = i; g.setIndex(new THREE.BufferAttribute(idx, 1)); }
    else if (mat.determinant() < 0) { const a = g.index.array; for (let i = 0; i < a.length; i += 3) { const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t; } }
    geos.push(g);
  });
  if (!geos.length) return { n: 0, mat: null };
  const mat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, visible: false });
  const proxy = new THREE.Mesh(mergeGeometries(geos, false)!, mat);
  proxy.name = 'Car_shadow_proxy'; proxy.castShadow = true; proxy.receiveShadow = false;
  proxy.onAfterShadow = () => { mat.visible = false; };
  const gate = new THREE.Object3D() as THREE.Object3D & { isLOD: boolean; autoUpdate: boolean; update(): void };
  gate.name = 'Car_shadow_gate'; gate.isLOD = true; gate.autoUpdate = true; gate.update = () => { mat.visible = true; };
  root.add(proxy, gate); // order matters: the gate must come after the proxy
  for (const g of geos) g.dispose();
  return { n, mat };
}

/** Only parts bigger than ~0.35 m radius cast a shadow. Bolts, badges and trim make no visible shadow but each
 *  costs a draw call in the shadow pass (310 → 134 casters on the Sketchfab model; ~+10 fps on Iris Xe). */
function limitShadowCasters(root: THREE.Object3D, minRadius = 0.35) {
  root.updateMatrixWorld(true);
  root.traverse(o => {
    const m = o as THREE.Mesh; if (!m.isMesh || !m.geometry) return;
    if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere();
    m.castShadow = m.geometry.boundingSphere!.radius * m.matrixWorld.getMaxScaleOnAxis() > minRadius;
  });
}
