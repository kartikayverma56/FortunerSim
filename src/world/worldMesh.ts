import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { heightAt, surfaceAt, WORLD, RUNWAY, IROAD, PAD, OFFROAD, humps, type SurfaceKey } from './terrain';

// ---------------- procedural textures (CC0 by construction) ----------------
function canvasTex(size: number, draw: (g: CanvasRenderingContext2D, s: number) => void, repeat = true) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d')!; draw(g, size);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; } t.anisotropy = 8; return t;
}
function speckle(g: CanvasRenderingContext2D, s: number, base: string, cols: string[], n: number, rmin: number, rmax: number) {
  g.fillStyle = base; g.fillRect(0, 0, s, s);
  for (let i = 0; i < n; i++) { g.fillStyle = cols[i % cols.length]; const r = rmin + Math.random() * (rmax - rmin); g.globalAlpha = 0.25 + Math.random() * 0.6; g.beginPath(); g.arc(Math.random() * s, Math.random() * s, r, 0, Math.PI * 2); g.fill(); }
  g.globalAlpha = 1;
}
const TEX = () => ({
  asphalt: canvasTex(512, (g, s) => speckle(g, s, '#3b3d40', ['#2a2b2d', '#55575a', '#47494c', '#6a6b6d'], 9000, 0.5, 2.2)),
  broken: canvasTex(512, (g, s) => { speckle(g, s, '#45464a', ['#2e2f31', '#5b5c5f', '#6f6e6a'], 8000, 0.5, 2.6); g.strokeStyle = '#1c1c1d'; g.lineWidth = 2; for (let i = 0; i < 14; i++) { g.beginPath(); let x = Math.random() * s, y = Math.random() * s; g.moveTo(x, y); for (let k = 0; k < 8; k++) { x += (Math.random() - 0.5) * 60; y += (Math.random() - 0.5) * 60; g.lineTo(x, y); } g.stroke(); } g.fillStyle = '#7d6a52'; for (let i = 0; i < 6; i++) { g.globalAlpha = 0.35; g.beginPath(); g.ellipse(Math.random() * s, Math.random() * s, 20 + Math.random() * 40, 10 + Math.random() * 30, Math.random() * 3, 0, Math.PI * 2); g.fill(); } g.globalAlpha = 1; }),
  concrete: canvasTex(512, (g, s) => { speckle(g, s, '#a9a69e', ['#9b988f', '#b7b4ac', '#8f8c84'], 6000, 0.6, 1.8); }),
  gravel: canvasTex(512, (g, s) => speckle(g, s, '#8a7a63', ['#6d6150', '#a39176', '#5a5045', '#b8a88c', '#7a6e60'], 16000, 1, 4)),
  mud: canvasTex(512, (g, s) => { speckle(g, s, '#5a4632', ['#4a3828', '#6b5640', '#3e2f22'], 7000, 2, 9); }),
  sand: canvasTex(512, (g, s) => speckle(g, s, '#d6bd8a', ['#c9ae7a', '#e2cc9b', '#bfa16d'], 14000, 0.5, 2)),
  grass: canvasTex(512, (g, s) => { speckle(g, s, '#5d7238', ['#4f6630', '#6f8444', '#7a7a46', '#56693a', '#8b7d55'], 18000, 1, 3.5); }),
  hump: canvasTex(256, (g, s) => { // IRC-style alternating black / white-yellow diagonal bands
    g.fillStyle = '#1b1b1b'; g.fillRect(0, 0, s, s); g.fillStyle = '#f1d23a';
    for (let i = -s; i < 2 * s; i += s / 2) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + s / 4, 0); g.lineTo(i + s / 4 - s, s); g.lineTo(i - s, s); g.fill(); }
  }),
});

type Mats = Record<SurfaceKey | 'hump', THREE.MeshStandardMaterial>;
function makeMats(): Mats {
  const t = TEX();
  const m = (map: THREE.Texture, rough: number, rep: number, color = 0xffffff, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) => { map.repeat.set(rep, rep); return new THREE.MeshStandardMaterial({ map, roughness: rough, metalness: 0, color, ...extra }); };
  return {
    asphalt: m(t.asphalt, 0.92, 1), broken: m(t.broken, 0.95, 1), concrete: m(t.concrete, 0.85, 1),
    rumble: m(t.asphalt, 0.9, 1, 0xe8e8e8), wet: m(t.asphalt.clone(), 0.18, 1, 0x8a8f96, { envMapIntensity: 1.6 }),
    gravel: m(t.gravel, 1, 1), mud: m(t.mud, 0.55, 1), sand: m(t.sand, 1, 1), grass: m(t.grass, 1, 1),
    hump: m(t.hump, 0.8, 1),
  } as Mats;
}

// ---------------- grid builder with arbitrary sample lines ----------------
function buildGrid(xs: number[], zs: number[], keep?: (cx: number, cz: number) => boolean, surfOf?: (cx: number, cz: number) => SurfaceKey | 'hump') {
  const nx = xs.length, nz = zs.length;
  const pos = new Float32Array(nx * nz * 3), uv = new Float32Array(nx * nz * 2);
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i, x = xs[i], z = zs[j];
    pos[k * 3] = x; pos[k * 3 + 1] = heightAt(x, z); pos[k * 3 + 2] = z;
    uv[k * 2] = x / 6; uv[k * 2 + 1] = z / 6;
  }
  const groups = new Map<string, number[]>();
  for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
    const cx = (xs[i] + xs[i + 1]) / 2, cz = (zs[j] + zs[j + 1]) / 2;
    if (keep && !keep(cx, cz)) continue;
    const s = surfOf ? surfOf(cx, cz) : surfaceAt(cx, cz);
    if (!groups.has(s)) groups.set(s, []);
    const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
    groups.get(s)!.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  let total = 0; for (const arr of groups.values()) total += arr.length;
  const idx = new Uint32Array(total); const order: string[] = []; let off = 0;
  for (const [s, arr] of groups) { geo.addGroup(off, arr.length, order.length); order.push(s); idx.set(arr, off); off += arr.length; }
  geo.setIndex(new THREE.BufferAttribute(idx, 1)); geo.computeVertexNormals();
  return { geo, order };
}
function range(a: number, b: number, step: number) { const r: number[] = []; for (let x = a; x < b; x += step) r.push(x); r.push(b); return r; }
function mergeRanges(parts: [number, number, number][]) { const r: number[] = []; for (const [a, b, s] of parts) for (const v of range(a, b, s)) if (!r.length || v > r[r.length - 1] + 1e-6) r.push(v); return r; }

function isHumpPaint(x: number, z: number) {
  if (x < IROAD.x0 || x > IROAD.x1) return false;
  for (const h of humps) if (z >= h.z && z <= h.z + h.len) return true;
  return false;
}

export interface WorldVisual { group: THREE.Group; sun: THREE.DirectionalLight; sky: Sky; updateShadow(target: THREE.Vector3): void }

export function buildWorld(scene: THREE.Scene, renderer: THREE.WebGLRenderer): WorldVisual {
  const group = new THREE.Group(); scene.add(group);
  const mats = makeMats();
  const mesh = (geo: THREE.BufferGeometry, order: string[], shadow = true) => { const mm = new THREE.Mesh(geo, order.map(s => (mats as any)[s] ?? mats.grass)); mm.receiveShadow = shadow; group.add(mm); return mm; };

  // ---- coarse base terrain (holes where detailed meshes go) ----
  const holes = [
    { x0: RUNWAY.x0 - 3, x1: RUNWAY.x1 + 3, z0: RUNWAY.z0 - 3, z1: RUNWAY.z1 + 3 },
    { x0: IROAD.x0 - 3, x1: IROAD.x1 + 3, z0: IROAD.z0 - 3, z1: IROAD.z1 + 3 },
    { x0: 4, x1: 113, z0: -23, z1: -5 },
    { x0: OFFROAD.x0 - 3, x1: OFFROAD.x1 + 3, z0: OFFROAD.z0 - 3, z1: OFFROAD.z1 + 3 },
    { x0: PAD.cx - PAD.r - 3, x1: PAD.cx + PAD.r + 3, z0: PAD.cz - PAD.r - 3, z1: PAD.cz + PAD.r + 3 },
  ];
  const inHole = (x: number, z: number) => holes.some(h => x > h.x0 && x < h.x1 && z > h.z0 && z < h.z1);
  {
    const xs = range(-1400, 1400, 8), zs = range(-900, 2300, 8);
    const { geo, order } = buildGrid(xs, zs, (x, z) => !inHole(x, z), () => 'grass');
    const m = mesh(geo, order);
    (m.material as THREE.Material[]).forEach(mt => { mt.polygonOffset = true; mt.polygonOffsetFactor = 2; mt.polygonOffsetUnits = 2; });
  }
  const M = 12; // skirt margin blending detailed meshes into the base
  // ---- runway (flat) ----
  {
    const xs = mergeRanges([[RUNWAY.x0 - M, RUNWAY.x0, 2], [RUNWAY.x0, RUNWAY.x1, 1], [RUNWAY.x1, RUNWAY.x1 + M, 2]]);
    const zs = range(RUNWAY.z0 - M, RUNWAY.z1 + M, 2);
    const { geo, order } = buildGrid(xs, zs); mesh(geo, order);
  }
  // ---- connectors ----
  { const xs = range(4 - M, 113 + M, 1.5), zs = range(-23 - M, -5 + M, 1.5); const { geo, order } = buildGrid(xs, zs); mesh(geo, order); }
  // ---- handling pad ----
  { const xs = range(PAD.cx - PAD.r - M, PAD.cx + PAD.r + M, 2.5), zs = range(PAD.cz - PAD.r - M, PAD.cz + PAD.r + M, 2.5); const { geo, order } = buildGrid(xs, zs); mesh(geo, order); }
  // ---- Indian road: adaptive resolution along z per zone ----
  {
    const xFine = (fine: number) => mergeRanges([[IROAD.x0 - M, IROAD.x0, 1.5], [IROAD.x0, IROAD.x1, fine], [IROAD.x1, IROAD.x1 + M, 1.5]]);
    const chunks: [number, number, number, number][] = []; // z0, z1, zStep, xStep
    for (const zn of WORLD.zones) {
      const xStep = zn.label.startsWith('Potholes') ? 0.1 : zn.label.startsWith('Broken') || zn.label.startsWith('Mud') || zn.label.startsWith('Loose') ? 0.18 : zn.label.startsWith('Cement') ? 0.5 : 1.0;
      const zStep = zn.label.startsWith('Potholes') ? 0.1 : zn.label.startsWith('Broken') || zn.label.startsWith('Mud') || zn.label.startsWith('Loose') ? 0.18 : zn.label.startsWith('Cement') ? 0.03 : 0.5;
      if (zn.label.startsWith('Speed')) {
        // fine only across humps
        let z = zn.z0;
        for (const h of humps.filter(h => h.z >= zn.z0 && h.z < zn.z1).sort((a, b) => a.z - b.z)) {
          if (h.z - 0.5 > z) chunks.push([z, h.z - 0.5, 0.5, 1]);
          chunks.push([h.z - 0.5, h.z + h.len + 0.5, h.id === 'RS' ? 0.02 : 0.04, 0.5]); z = h.z + h.len + 0.5;
        }
        if (z < zn.z1) chunks.push([z, zn.z1, 0.5, 1]);
      } else chunks.push([zn.z0, zn.z1, zStep, xStep]);
    }
    chunks[0][0] -= M; chunks[chunks.length - 1][1] += M;
    for (const [z0, z1, zs, xsS] of chunks) {
      const { geo, order } = buildGrid(xFine(xsS), range(z0, z1, zs), undefined, (x, z) => isHumpPaint(x, z) ? 'hump' : surfaceAt(x, z));
      mesh(geo, order);
    }
  }
  // ---- off-road park ----
  {
    const xs = range(OFFROAD.x0 - M, OFFROAD.x1 + M, 0.5), zs = range(OFFROAD.z0 - M, OFFROAD.z1 + M, 0.5);
    // split into strips to keep index buffers moderate
    for (let k = 0; k < zs.length - 1; k += 120) { const sub = zs.slice(k, Math.min(zs.length, k + 121)); const { geo, order } = buildGrid(xs, sub); mesh(geo, order); }
  }

  // ---- markings, boards, cones ----
  const white = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });
  const yellow = new THREE.MeshBasicMaterial({ color: 0xf3c623 });
  const dashGeo = new THREE.PlaneGeometry(0.15, 3).rotateX(-Math.PI / 2);
  const dashes = new THREE.InstancedMesh(dashGeo, white, 600); let di = 0; const tmp = new THREE.Object3D();
  for (let z = RUNWAY.z0 + 5; z < RUNWAY.z1 - 5 && di < 600; z += 9) { tmp.position.set(0, 0.006, z); tmp.updateMatrix(); dashes.setMatrixAt(di++, tmp.matrix); }
  for (let z = IROAD.z0 + 5; z < IROAD.z1 - 5 && di < 600; z += 9) { if (isHumpPaint(38, z) || isHumpPaint(38, z + 1.5) || isHumpPaint(38, z - 1.5)) continue; tmp.position.set(38, heightAt(38, z) + 0.01, z); tmp.updateMatrix(); dashes.setMatrixAt(di++, tmp.matrix); }
  dashes.count = di; group.add(dashes);
  // edge lines runway
  for (const x of [RUNWAY.x0 + 0.4, RUNWAY.x1 - 0.4]) { const g = new THREE.PlaneGeometry(0.15, RUNWAY.z1 - RUNWAY.z0 - 4).rotateX(-Math.PI / 2); const m = new THREE.Mesh(g, white); m.position.set(x, 0.006, (RUNWAY.z0 + RUNWAY.z1) / 2); group.add(m); }
  // start line + distance boards
  { const m = new THREE.Mesh(new THREE.PlaneGeometry(RUNWAY.x1 - RUNWAY.x0 - 1, 0.4).rotateX(-Math.PI / 2), yellow); m.position.set(0, 0.007, 0); group.add(m); }
  const board = (text: string, sub: string, x: number, z: number, rotY = 0, w = 2.4, h = 1.2, bg = '#0b5d2a') => {
    const t = canvasTex(256, (g, s) => { g.fillStyle = bg; g.fillRect(0, 0, s, s); g.strokeStyle = '#fff'; g.lineWidth = 8; g.strokeRect(6, 6, s - 12, s - 12); g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = 'bold 64px system-ui'; g.fillText(text, s / 2, s * 0.48); g.font = '26px system-ui'; wrap(g, sub, s / 2, s * 0.68, s - 30, 28); }, false);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide }));
    const y = heightAt(x, z); plane.position.set(x, y + 1.5 + h / 2, z); plane.rotation.y = rotY; group.add(plane);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.5 + h / 2), new THREE.MeshStandardMaterial({ color: 0x777777 })); post.position.set(x, y + (1.5 + h / 2) / 2, z); post.castShadow = true; group.add(post);
  };
  function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number) { const words = text.split(' '); let line = ''; for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { g.fillText(line, x, y); line = w; y += lh; } else line = t; } if (line) g.fillText(line, x, y); }
  for (let z = 50; z <= 1700; z += 50) board(`${z} m`, z === 400 ? '¼ mile ≈ 402 m' : '', RUNWAY.x1 + 2.5, z, -Math.PI / 2, 1.6, 0.8);
  board('START', '0–100 / braking strip', RUNWAY.x1 + 2.5, 0, -Math.PI / 2);
  for (const zn of WORLD.zones) board(zn.label.split('(')[0].trim(), zn.label.includes('(') ? '(' + zn.label.split('(')[1] : '', IROAD.x1 + 2.5, zn.z0 + 2, -Math.PI / 2, 3, 1.5, '#1d3f73');
  for (const h of humps) board('⚠ ' + h.id, h.name, IROAD.x0 - 2.0, h.z - 25, Math.PI / 2, 2.6, 1.3, '#b5121b');
  board('OFF-ROAD', 'ramps · moguls · side slope · sand · rocks · ditch', OFFROAD.x0 + 2, 5, Math.PI, 3.2, 1.6, '#6b3a12');
  board('HANDLING PAD', 'Ø 260 m · cones', PAD.cx + PAD.r - 5, PAD.cz - PAD.r + 5, Math.PI * 0.75, 3, 1.5);
  for (const f of WORLD.features) if (f.info && f.x0 >= OFFROAD.x0 && f.name !== 'offroad-base') board(f.name, f.info, f.x0 - 1, f.z0 - 3, Math.PI, 2.6, 1.3, '#6b3a12');
  // cones on the pad: ISO 3888-style lane-change gates (approx.)
  const coneGeo = new THREE.ConeGeometry(0.17, 0.7, 12).translate(0, 0.35, 0);
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xff5a14, roughness: 0.6 });
  const cones = new THREE.InstancedMesh(coneGeo, coneMat, 200); let ci = 0;
  const gate = (z: number, xc: number, w: number, n = 3, step = 4) => { for (let k = 0; k < n; k++) for (const s of [-1, 1]) { tmp.position.set(PAD.cx + xc + s * w / 2, 0, PAD.cz - 80 + z + k * step); tmp.updateMatrix(); cones.setMatrixAt(ci++, tmp.matrix); } };
  gate(0, 0, 2.9, 4, 4); gate(12 + 13.5, 3.5, 3.1, 3, 5.5); gate(12 + 13.5 + 11 + 12.5, 0, 3.0, 3, 4.3);
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 18) { tmp.position.set(PAD.cx + Math.cos(a) * 40, 0, PAD.cz + 40 + Math.sin(a) * 40); tmp.updateMatrix(); cones.setMatrixAt(ci++, tmp.matrix); }
  cones.count = ci; cones.castShadow = true; group.add(cones);

  // ---- scenery: trees and lamp posts (instanced) ----
  const trunkGeo = new THREE.CylinderGeometry(0.15, 0.22, 2.4, 6).translate(0, 1.2, 0);
  const crownGeo = new THREE.IcosahedronGeometry(1.8, 0).translate(0, 3.6, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5b4330 }), 1400);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0x3f6b2a, flatShading: true }), 1400);
  let ti = 0; const rnd = mulberry(7);
  while (ti < 1400) {
    const x = (rnd() - 0.5) * 1600, z = -300 + rnd() * 2300;
    if (inHole(x, z) || (Math.abs(x) < 30) || (x > IROAD.x0 - 15 && x < IROAD.x1 + 15)) continue;
    const s = 0.7 + rnd() * 0.9; tmp.position.set(x, heightAt(x, z) - 0.1, z); tmp.scale.set(s, s * (0.8 + rnd() * 0.5), s); tmp.rotation.y = rnd() * 6; tmp.updateMatrix();
    trunks.setMatrixAt(ti, tmp.matrix); crowns.setMatrixAt(ti, tmp.matrix); ti++;
  }
  trunks.castShadow = crowns.castShadow = true; group.add(trunks, crowns);
  tmp.scale.set(1, 1, 1); tmp.rotation.set(0, 0, 0);
  const lampGeo = new THREE.CylinderGeometry(0.06, 0.09, 8, 6).translate(0, 4, 0);
  const lamps = new THREE.InstancedMesh(lampGeo, new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 }), 200); let li = 0;
  for (let z = 0; z < 1700 && li < 200; z += 30) { for (const x of [RUNWAY.x0 - 3, IROAD.x1 + 4]) { tmp.position.set(x, heightAt(x, z), z); tmp.updateMatrix(); lamps.setMatrixAt(li++, tmp.matrix); } }
  lamps.count = li; lamps.castShadow = true; group.add(lamps);

  // ---- sky, sun, fog, environment ----
  const sky = new Sky(); sky.scale.setScalar(20000); scene.add(sky);
  const su = sky.material.uniforms; su.turbidity.value = 6; su.rayleigh.value = 1.6; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.8;
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 38), THREE.MathUtils.degToRad(140));
  su.sunPosition.value.copy(sunDir);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene(); const sky2 = new Sky(); sky2.scale.setScalar(1000); envScene.add(sky2);
  Object.assign(sky2.material.uniforms.turbidity, { value: 6 }); sky2.material.uniforms.rayleigh.value = 1.6; sky2.material.uniforms.sunPosition.value.copy(sunDir);
  scene.environment = pmrem.fromScene(envScene as any, 0.02).texture;
  scene.fog = new THREE.Fog(0xb9c8d6, 400, 2600);
  const hemi = new THREE.HemisphereLight(0xcfe3ff, 0x5a5040, 0.55); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff1dd, 2.6);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera as THREE.OrthographicCamera; sc.left = -30; sc.right = 30; sc.top = 30; sc.bottom = -30; sc.near = 1; sc.far = 300;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
  scene.add(sun, sun.target);
  const updateShadow = (t: THREE.Vector3) => { sun.position.copy(t).addScaledVector(sunDir, 120); sun.target.position.copy(t); };
  return { group, sun, sky, updateShadow };
}

function mulberry(a: number) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
