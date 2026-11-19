// Lighting for the car that lives outside worldMesh.ts:
//  - a reflection environment with a ground in it (worldMesh's PMREM holds only the sky, so the lower half of every
//    reflection on paint, glass and mirrors was bright haze), built once at load: zero per-frame cost;
//  - a tighter sun-shadow box that follows the car and snaps to whole shadow texels (no shimmer).
import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';

/** Rebuilds scene.environment from the world's sky plus a sun-lit ground disc, a darker road patch and a tree line. */
export function buildReflectionEnvironment(scene: THREE.Scene, renderer: THREE.WebGLRenderer, sky: Sky) {
  const env = new THREE.Scene();
  const sky2 = new Sky(); sky2.scale.setScalar(1000); env.add(sky2);
  const su = sky.material.uniforms, s2 = sky2.material.uniforms;
  for (const k of ['turbidity', 'rayleigh', 'mieCoefficient', 'mieDirectionalG']) s2[k].value = su[k].value;
  s2.sunPosition.value.copy(su.sunPosition.value);
  // PMREM renders from the origin with far = 100 m; the probe sits ~1.3 m above the ground, like the car's waist line.
  // Colours are linear radiance, chosen to match how the sunlit ground renders in the scene (before tone mapping).
  const disposables: { dispose(): void }[] = [];
  const flat = (geo: THREE.BufferGeometry, color: THREE.ColorRepresentation, y: number) => {
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }); const m = new THREE.Mesh(geo.rotateX(-Math.PI / 2), mat);
    m.position.y = y; env.add(m); disposables.push(geo, mat); return m;
  };
  flat(new THREE.CircleGeometry(96, 64), new THREE.Color(0.20, 0.25, 0.10), -1.3);      // dry grass
  flat(new THREE.PlaneGeometry(9, 190), new THREE.Color(0.075, 0.078, 0.082), -1.29);   // the road the car is on
  // tree line and scattered blocks near the horizon (dark, so the horizon in reflections is not a hard white edge)
  const treeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.05, 0.08, 0.035) }); disposables.push(treeMat);
  const treeGeo = new THREE.BoxGeometry(1, 1, 1); disposables.push(treeGeo);
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 70; i++) {
    const a = rnd() * Math.PI * 2, r = 55 + rnd() * 35, w = 4 + rnd() * 9, h = 3 + rnd() * 6;
    const b = new THREE.Mesh(treeGeo, treeMat); b.scale.set(w, h, w); b.position.set(Math.cos(a) * r, -1.3 + h / 2, Math.sin(a) * r); env.add(b);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  const rt = pmrem.fromScene(env as unknown as THREE.Scene, 0.02);
  const old = scene.environment; scene.environment = rt.texture;
  if (old && old !== rt.texture) old.dispose();
  pmrem.dispose(); sky2.geometry.dispose(); sky2.material.dispose(); for (const d of disposables) d.dispose();
  // the hemisphere fill partly double-counts the environment's diffuse light; now that the environment has a darker
  // ground half, keep only a little of it
  scene.traverse(o => { const h = o as THREE.HemisphereLight; if (h.isHemisphereLight) h.intensity = HEMI; });
  return rt;
}
const HEMI = 0.4;

/** Keeps the sun's shadow box small and centred on the car: ±12 m on 1024 px = 2.3 cm per texel (was ±30 m = 5.9 cm),
 *  ±16 m on 2048 px (High). The box is snapped to whole texels so the shadow edges do not crawl as the car moves. */
export class SunShadowFollower {
  private dir = new THREE.Vector3(); private right = new THREE.Vector3(); private up = new THREE.Vector3();
  private t = new THREE.Vector3(); private extent = 0;
  constructor(private sun: THREE.DirectionalLight, sunDir: THREE.Vector3) {
    this.dir.copy(sunDir).normalize();
    this.right.crossVectors(new THREE.Vector3(0, 1, 0), this.dir).normalize(); // matches the shadow camera's own x axis
    this.up.crossVectors(this.dir, this.right).normalize();
  }
  update(target: THREE.Vector3) {
    const sun = this.sun, size = sun.shadow.mapSize.x, ext = size >= 2048 ? 16 : 12;
    const cam = sun.shadow.camera as THREE.OrthographicCamera;
    if (ext !== this.extent) {
      this.extent = ext; cam.left = cam.bottom = -ext; cam.right = cam.top = ext;
      // light 50 m from the car, depth range 60 m: the depth bias (−0.0004 of the range) is now 2.4 cm, not 12 cm,
      // so shadows no longer start a hand-width away from the tyres
      cam.near = 20; cam.far = 80; cam.updateProjectionMatrix();
    }
    const texel = 2 * ext / size;
    const r = target.dot(this.right), u = target.dot(this.up);
    this.t.copy(target).addScaledVector(this.right, Math.round(r / texel) * texel - r).addScaledVector(this.up, Math.round(u / texel) * texel - u);
    sun.target.position.copy(this.t); sun.position.copy(this.t).addScaledVector(this.dir, 50);
    sun.target.updateMatrixWorld();
  }
}
