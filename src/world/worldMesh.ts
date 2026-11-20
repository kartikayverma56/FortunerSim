import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { heightAt, surfaceAt, WORLD, RUNWAY, IROAD, PAD, OFFROAD, CRASH, CRASHPAD, humps, type SurfaceKey } from './terrain';
import { colliders, type PropHandle, type ColliderId } from './colliders';
import { ROADSIDE_COLLIDERS } from './roadsideColliders';
import { buildLodTerrain, type LodSpec } from './terrainLod';
import { ROADS, cellCovered, corridorSink, inCorridor } from './roads';
import { RoadLod, buildMarkings } from './roadMesh';
import { buildRoadside } from './roadsideMesh';

// Distance LOD for the ground. Near pieces are the original grids; far twins keep a subset of the same
// sample lines (error <= tol) and switch in no closer than near[0] metres from the camera.
const LOD_BASE: LodSpec = { piece: 700, maxStep: [32, 32], tol: 0.3, near: [250, 500], normalStep: 8 };
const LOD_RUNWAY: LodSpec = { piece: 300, maxStep: [4, 8], tol: 0.05, near: [100, 220], normalStep: 2 };
const LOD_ROAD: LodSpec = { piece: 60, maxStep: [2, 2], tol: 0.08, near: [100, 220], normalStep: 1 };
const LOD_OFFROAD: LodSpec = { piece: 72, maxStep: [2, 2], tol: 0.08, near: [100, 220], normalStep: 1 };
const LOD_CRASH: LodSpec = { piece: 100, maxStep: [8, 8], tol: 0.02, near: [120, 260], normalStep: 1 };

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

// neutral (grey) textures for the new roads: colour comes from vertex colours (roadMesh.colourAt); means match ROAD_TEX_MEAN / VERGE_TEX_MEAN
const TEX_ROAD = () => ({
  asphalt: canvasTex(512, (g, s) => { speckle(g, s, '#bdbdbd', ['#9a9a9a', '#d6d6d6', '#adadad', '#e0e0e0', '#8e8e8e'], 14000, 0.5, 2.0); g.strokeStyle = 'rgba(60,60,60,0.35)'; g.lineWidth = 1.5; for (let i = 0; i < 6; i++) { g.beginPath(); let x = Math.random() * s, y = Math.random() * s; g.moveTo(x, y); for (let k = 0; k < 6; k++) { x += (Math.random() - 0.5) * 50; y += (Math.random() - 0.5) * 50; g.lineTo(x, y); } g.stroke(); } }),
  earth: canvasTex(512, (g, s) => { speckle(g, s, '#c8c8c8', ['#a8a8a8', '#dcdcdc', '#b4b4b4', '#e6e6e6', '#9c9c9c'], 9000, 1, 5); for (let i = 0; i < 1600; i++) { g.fillStyle = Math.random() < 0.5 ? 'rgba(90,90,90,0.5)' : 'rgba(240,240,240,0.6)'; g.fillRect(Math.random() * s, Math.random() * s, 1.5, 1.5); } }),
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
  for (const h of humps) if (h.x === undefined && z >= h.z && z <= h.z + h.len) return true;
  return false;
}

export interface WorldGraphics { shadowSize: number; treeShadows: boolean; treeFrac: number }
export interface WorldVisual { group: THREE.Group; sun: THREE.DirectionalLight; sky: Sky; updateShadow(target: THREE.Vector3): void; setGraphics(g: WorldGraphics): void; roadLods: RoadLod[]; roadside: ReturnType<typeof buildRoadside>['stats'];
  /** Per frame: knocked cones follow their prop poses, broken signs fall over. */
  updateObjects(dt: number): void;
  /** Stands every knocked cone and broken sign back up (teleport). */
  restoreObjects(): void;
  colliderCount: number }

export function buildWorld(scene: THREE.Scene, renderer: THREE.WebGLRenderer): WorldVisual {
  const group = new THREE.Group(); scene.add(group);
  const mats = makeMats();
  const mesh = (geo: THREE.BufferGeometry, order: string[], shadow = true) => { const mm = new THREE.Mesh(geo, order.map(s => (mats as any)[s] ?? mats.grass)); mm.receiveShadow = shadow; group.add(mm); return mm; };

  // ---- ground: the fine grids are cut into LOD pieces (terrainLod.ts); far pieces drop sample lines only
  // where the surface stays within tol, so the roads up close are the same meshes as before ----
  const lodMats = (order: string[]) => order.map(s => (mats as any)[s] ?? mats.grass);
  const lod = (xs: number[], zs: number[], spec: LodSpec, keep?: (x: number, z: number) => boolean, surfOf?: (x: number, z: number) => string, hFn?: (x: number, z: number) => number) => {
    for (const o of buildLodTerrain(xs, zs, spec, lodMats, keep, surfOf, hFn).objects) group.add(o);
  };
  // ---- coarse base terrain (holes where detailed meshes go) ----
  const holes = [
    { x0: RUNWAY.x0 - 3, x1: RUNWAY.x1 + 3, z0: RUNWAY.z0 - 3, z1: RUNWAY.z1 + 3 },
    { x0: IROAD.x0 - 3, x1: IROAD.x1 + 3, z0: IROAD.z0 - 3, z1: IROAD.z1 + 3 },
    { x0: 4, x1: 113, z0: -23, z1: -5 },
    { x0: OFFROAD.x0 - 3, x1: OFFROAD.x1 + 3, z0: OFFROAD.z0 - 3, z1: OFFROAD.z1 + 3 },
    { x0: PAD.cx - PAD.r - 3, x1: PAD.cx + PAD.r + 3, z0: PAD.cz - PAD.r - 3, z1: PAD.cz + PAD.r + 3 },
  ];
  const inHole = (x: number, z: number) => holes.some(h => x > h.x0 && x < h.x1 && z > h.z0 && z < h.z1);
  const inCrash = (x: number, z: number, m = 3) => x > CRASH.x0 - m && x < CRASH.x1 + m && z > CRASH.z0 - m && z < CRASH.z1 + m;
  // cells under the new roads' own meshes are dropped, and base vertices near them sink 0.5 m so the 8 m grid never pokes through
  lod(range(-1400, 1400, 8), range(-900, 2300, 8), LOD_BASE, (x, z) => !inHole(x, z) && !inCrash(x, z) && !cellCovered(x, z, 4), () => 'grass', (x, z) => heightAt(x, z) - 0.5 * corridorSink(x, z));
  mats.grass.polygonOffset = true; mats.grass.polygonOffsetFactor = 2; mats.grass.polygonOffsetUnits = 2; // as before: base grass sits behind the detailed meshes
  const M = 12; // skirt margin blending detailed meshes into the base
  // ---- runway (flat) ----
  lod(mergeRanges([[RUNWAY.x0 - M, RUNWAY.x0, 2], [RUNWAY.x0, RUNWAY.x1, 1], [RUNWAY.x1, RUNWAY.x1 + M, 2]]), range(RUNWAY.z0 - M, RUNWAY.z1 + M, 2), LOD_RUNWAY);
  // ---- connectors ----
  { const xs = range(4 - M, 113 + M, 1.5), zs = range(-23 - M, -5 + M, 1.5); const { geo, order } = buildGrid(xs, zs, (x, z) => !cellCovered(x, z, 0.75)); mesh(geo, order); }
  // ---- handling pad ----
  { const xs = range(PAD.cx - PAD.r - M, PAD.cx + PAD.r + M, 2.5), zs = range(PAD.cz - PAD.r - M, PAD.cz + PAD.r + M, 2.5); const { geo, order } = buildGrid(xs, zs); mesh(geo, order); }
  // ---- Indian road: adaptive resolution along z per zone ----
  {
    const xFine = (fine: number) => mergeRanges([[IROAD.x0 - M, IROAD.x0, 1.5], [IROAD.x0, IROAD.x1, fine], [IROAD.x1, IROAD.x1 + M, 1.5]]);
    const surf = (x: number, z: number) => isHumpPaint(x, z) ? 'hump' : surfaceAt(x, z);
    const zones = WORLD.zones;
    zones.forEach((zn, k) => {
      const z0 = k === 0 ? zn.z0 - M : zn.z0, z1 = k === zones.length - 1 ? zn.z1 + M : zn.z1;
      const xStep = zn.label.startsWith('Potholes') ? 0.1 : zn.label.startsWith('Broken') || zn.label.startsWith('Mud') || zn.label.startsWith('Loose') ? 0.18 : zn.label.startsWith('Cement') ? 0.5 : 1.0;
      const zStep = zn.label.startsWith('Potholes') ? 0.1 : zn.label.startsWith('Broken') || zn.label.startsWith('Mud') || zn.label.startsWith('Loose') ? 0.18 : zn.label.startsWith('Cement') ? 0.03 : 0.5;
      if (zn.label.startsWith('Speed')) {
        // fine only across humps; one grid for the whole section (0.5 m across, as the humps had) so it splits into few pieces
        const parts: [number, number, number][] = []; let z = z0;
        for (const h of humps.filter(h => h.z >= zn.z0 && h.z < zn.z1).sort((a, b) => a.z - b.z)) {
          if (h.z - 0.5 > z) parts.push([z, h.z - 0.5, 0.5]);
          parts.push([h.z - 0.5, h.z + h.len + 0.5, h.id === 'RS' ? 0.02 : 0.04]); z = h.z + h.len + 0.5;
        }
        if (z < z1) parts.push([z, z1, 0.5]);
        lod(xFine(0.5), mergeRanges(parts), LOD_ROAD, undefined, surf);
      } else lod(xFine(xStep), range(z0, z1, zStep), LOD_ROAD, undefined, surf);
    });
  }
  // ---- crash pad (key 0): fine sample lines across the kerb faces, the ramp and the ditch ----
  {
    const C = CRASH, K = CRASHPAD, k = K.kerb, r = K.ramp, d = K.ditch;
    const xs = mergeRanges([[C.x0 - M, k.x - 0.6, 1], [k.x - 0.6, k.x + 0.6, 0.02], [k.x + 0.6, k.x + k.w - 0.6, 1], [k.x + k.w - 0.6, k.x + k.w + 0.7, 0.02],
      [k.x + k.w + 0.7, r.x0 - 0.3, 1], [r.x0 - 0.3, r.x1 + 0.3, 0.04], [r.x1 + 0.3, d.x - 0.3, 1], [d.x - 0.3, d.x + 3.0, 0.1], [d.x + 3.0, C.x1 + M, 1]]);
    const zs = mergeRanges([[C.z0 - M, k.z0 - 0.2, 1], [k.z0 - 0.2, k.z0 + 0.7, 0.1], [k.z0 + 0.7, r.z0 - 0.2, 1], [r.z0 - 0.2, r.z0 + r.len + 0.3, 0.04],
      [r.z0 + r.len + 0.3, k.z1 - 0.7, 1], [k.z1 - 0.7, k.z1 + 0.2, 0.1], [k.z1 + 0.2, C.z1 + M, 1]]);
    lod(xs, zs, LOD_CRASH);
  }
  // ---- off-road park ----
  lod(range(OFFROAD.x0 - M, OFFROAD.x1 + M, 0.5), range(OFFROAD.z0 - M, OFFROAD.z1 + M, 0.5), LOD_OFFROAD, (x, z) => !cellCovered(x, z, 0.25)); // its south skirt gives way to the link road

  // ---- new roads (roads.ts): near pieces built lazily around the camera, merged far mesh, draped markings; roadside village ----
  const roadTex = TEX_ROAD();
  const roadMat = new THREE.MeshStandardMaterial({ map: roadTex.asphalt, vertexColors: true, roughness: 0.93, metalness: 0 });
  const vergeMat = new THREE.MeshStandardMaterial({ map: roadTex.earth, vertexColors: true, roughness: 1, metalness: 0 });
  const roadLods = ROADS.map(r => { const l = new RoadLod(r, [roadMat, vergeMat]); group.add(l); return l; });
  const marks = new THREE.Mesh(buildMarkings(ROADS, mulberry(31)), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 }));
  marks.receiveShadow = true; group.add(marks);
  const roadside = buildRoadside(); group.add(roadside.group);

  // ---- markings, boards, cones ----
  const white = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });
  const yellow = new THREE.MeshBasicMaterial({ color: 0xf3c623 });
  const dashGeo = new THREE.PlaneGeometry(0.15, 3).rotateX(-Math.PI / 2);
  // own material: sharing one between instanced and plain meshes makes three.js swap shader programs every frame
  const dashes = new THREE.InstancedMesh(dashGeo, white.clone(), 600); let di = 0; const tmp = new THREE.Object3D();
  for (let z = RUNWAY.z0 + 5; z < RUNWAY.z1 - 5 && di < 600; z += 9) { tmp.position.set(0, 0.006, z); tmp.updateMatrix(); dashes.setMatrixAt(di++, tmp.matrix); }
  for (let z = IROAD.z0 + 5; z < IROAD.z1 - 5 && di < 600; z += 9) { if (isHumpPaint(38, z) || isHumpPaint(38, z + 1.5) || isHumpPaint(38, z - 1.5)) continue; tmp.position.set(38, heightAt(38, z) + 0.01, z); tmp.updateMatrix(); dashes.setMatrixAt(di++, tmp.matrix); }
  dashes.count = di; group.add(dashes);
  // edge lines runway
  for (const x of [RUNWAY.x0 + 0.4, RUNWAY.x1 - 0.4]) { const g = new THREE.PlaneGeometry(0.15, RUNWAY.z1 - RUNWAY.z0 - 4).rotateX(-Math.PI / 2); const m = new THREE.Mesh(g, white); m.position.set(x, 0.006, (RUNWAY.z0 + RUNWAY.z1) / 2); group.add(m); }
  // start line + distance boards
  { const m = new THREE.Mesh(new THREE.PlaneGeometry(RUNWAY.x1 - RUNWAY.x0 - 1, 0.4).rotateX(-Math.PI / 2), yellow); m.position.set(0, 0.007, 0); group.add(m); }
  // Sign boards: a post and a board in one pivot group at the base. Both are frangible colliders in one group (12 kN [A]);
  // when struck they fail together and the sign falls flat away from the car.
  const signs: { piv: THREE.Group; ids: ColliderId[]; ang: number; rate: number; ax: THREE.Vector3; falling: boolean }[] = [];
  const postMat = new THREE.MeshStandardMaterial({ color: 0x777777 });
  let signGroup = 9000;
  const board = (text: string, sub: string, x: number, z: number, rotY = 0, w = 2.4, h = 1.2, bg = '#0b5d2a') => {
    const t = canvasTex(256, (g, s) => { g.fillStyle = bg; g.fillRect(0, 0, s, s); g.strokeStyle = '#fff'; g.lineWidth = 8; g.strokeRect(6, 6, s - 12, s - 12); g.fillStyle = '#fff'; g.textAlign = 'center'; g.font = 'bold 64px system-ui'; g.fillText(text, s / 2, s * 0.48); g.font = '26px system-ui'; wrap(g, sub, s / 2, s * 0.68, s - 30, 28); }, false);
    const y = heightAt(x, z);
    const piv = new THREE.Group(); piv.position.set(x, y, z); group.add(piv);
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide }));
    plane.position.set(0, 1.5 + h / 2, 0); plane.rotation.y = rotY; piv.add(plane);
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.5 + h / 2), postMat); post.position.set(0, (1.5 + h / 2) / 2, 0); post.castShadow = true; piv.add(post);
    const gid = signGroup++, ref = signs.length;
    const ids = [
      colliders.addCylinder({ x, z, radius: 0.04, height: 1.5 + h / 2 + 0.3, y0: y - 0.3, material: 'steel', breakForce: 12e3, group: gid, tag: 'sign', ref }),
      colliders.addBox({ x, z, halfX: w / 2, halfZ: 0.02, yaw: rotY, height: h, y0: y + 1.5, material: 'steel', breakForce: 12e3, group: gid, tag: 'sign', ref }),
    ];
    signs.push({ piv, ids, ang: 0, rate: 0, ax: new THREE.Vector3(1, 0, 0), falling: false });
  };
  function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number) { const words = text.split(' '); let line = ''; for (const w of words) { const t = line ? line + ' ' + w : w; if (g.measureText(t).width > maxW && line) { g.fillText(line, x, y); line = w; y += lh; } else line = t; } if (line) g.fillText(line, x, y); }
  for (let z = 50; z <= 1700; z += 50) board(`${z} m`, z === 400 ? '¼ mile ≈ 402 m' : '', RUNWAY.x1 + 2.5, z, -Math.PI / 2, 1.6, 0.8);
  board('START', '0–100 / braking strip', RUNWAY.x1 + 2.5, 0, -Math.PI / 2);
  for (const zn of WORLD.zones) board(zn.label.split('(')[0].trim(), zn.label.includes('(') ? '(' + zn.label.split('(')[1] : '', IROAD.x1 + 2.5, zn.z0 + 2, -Math.PI / 2, 3, 1.5, '#1d3f73');
  for (const h of humps) if (h.x === undefined) board('⚠ ' + h.id, h.name, IROAD.x0 - 2.0, h.z - 25, Math.PI / 2, 2.6, 1.3, '#b5121b');
  board('OFF-ROAD', 'ramps · moguls · side slope · sand · rocks · ditch', OFFROAD.x0 + 2, 5, Math.PI, 3.2, 1.6, '#6b3a12');
  board('HANDLING PAD', 'Ø 260 m · cones', PAD.cx + PAD.r - 5, PAD.cz - PAD.r + 5, Math.PI * 0.75, 3, 1.5);
  for (const f of WORLD.features) if (f.info && f.x0 >= OFFROAD.x0 && f.name !== 'offroad-base') board(f.name, f.info, f.x0 - 1, f.z0 - 3, Math.PI, 2.6, 1.3, '#6b3a12');
  // cones on the pad: ISO 3888-style lane-change gates (approx.)
  const coneGeo = new THREE.ConeGeometry(0.17, 0.7, 12).translate(0, 0.35, 0);
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xff5a14, roughness: 0.6 });
  const cones = new THREE.InstancedMesh(coneGeo, coneMat, 200); let ci = 0;
  // every cone is a prop (4 kg): a struck cone flies, bounces and slides; its instance follows the prop pose
  const coneProps: PropHandle[] = [];
  const cone = (x: number, z: number) => {
    tmp.position.set(x, heightAt(x, z), z); tmp.updateMatrix(); cones.setMatrixAt(ci, tmp.matrix);
    coneProps.push(colliders.addProp({ x, z, kind: 'cone', radius: 0.17, height: 0.7, mass: 4, tag: 'cone', ref: ci })); ci++;
  };
  const gate = (z: number, xc: number, w: number, n = 3, step = 4) => { for (let k = 0; k < n; k++) for (const s of [-1, 1]) cone(PAD.cx + xc + s * w / 2, PAD.cz - 80 + z + k * step); };
  gate(0, 0, 2.9, 4, 4); gate(12 + 13.5, 3.5, 3.1, 3, 5.5); gate(12 + 13.5 + 11 + 12.5, 0, 3.0, 3, 4.3);
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 18) cone(PAD.cx + Math.cos(a) * 40, PAD.cz + 40 + Math.sin(a) * 40);
  for (let z = CRASHPAD.cones.z0; z <= CRASHPAD.cones.z1; z += 10) for (const s of [-1.6, 1.6]) cone(CRASHPAD.cones.x + s, z);
  cones.count = ci; cones.castShadow = true; group.add(cones);
  cones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  const coneMoved = new Uint8Array(ci);

  // ---- scenery: trees and lamp posts (instanced) ----
  const trunkGeo = new THREE.CylinderGeometry(0.15, 0.22, 2.4, 6).translate(0, 1.2, 0);
  const crownGeo = new THREE.IcosahedronGeometry(1.8, 0).translate(0, 3.6, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: 0x5b4330 }), 1400);
  const crowns = new THREE.InstancedMesh(crownGeo, new THREE.MeshStandardMaterial({ color: 0x3f6b2a, flatShading: true }), 1400);
  let ti = 0; const rnd = mulberry(7);
  while (ti < 1400) {
    const x = (rnd() - 0.5) * 1600, z = -300 + rnd() * 2300;
    if (inHole(x, z) || (Math.abs(x) < 30) || (x > IROAD.x0 - 15 && x < IROAD.x1 + 15) || inCorridor(x, z, 6)) continue;
    const s = 0.7 + rnd() * 0.9, sy = 0.8 + rnd() * 0.5, ry = rnd() * 6;
    if (inCrash(x, z, 6)) continue; // after the draws, so every other tree keeps its place
    tmp.position.set(x, heightAt(x, z) - 0.1, z); tmp.scale.set(s, s * sy, s); tmp.rotation.y = ry; tmp.updateMatrix();
    trunks.setMatrixAt(ti, tmp.matrix); crowns.setMatrixAt(ti, tmp.matrix);
    // trunk collider (immovable, wood); the crown has none (the car passes through foliage: known gap)
    colliders.addCylinder({ x, z, radius: 0.185 * s, height: 2.4 * s * sy, material: 'wood', tag: 'tree', ref: ti });
    ti++;
  }
  trunks.castShadow = crowns.castShadow = true; group.add(trunks, crowns);
  tmp.scale.set(1, 1, 1); tmp.rotation.set(0, 0, 0);
  const lampGeo = new THREE.CylinderGeometry(0.06, 0.09, 8, 6).translate(0, 4, 0);
  const lamps = new THREE.InstancedMesh(lampGeo, new THREE.MeshStandardMaterial({ color: 0x9aa0a6, metalness: 0.6, roughness: 0.4 }), 200); let li = 0;
  for (let z = 0; z < 1700 && li < 200; z += 30) { for (const x of [RUNWAY.x0 - 3, IROAD.x1 + 4]) { tmp.position.set(x, heightAt(x, z), z); tmp.updateMatrix(); colliders.addCylinder({ x, z, radius: 0.075, height: 8, material: 'steel', tag: 'lamp', ref: li }); lamps.setMatrixAt(li++, tmp.matrix); } }
  lamps.count = li; lamps.castShadow = true; group.add(lamps);

  // ---- crash pad objects: test pole, rigid wall, two trees, frangible signs (above), info board ----
  {
    const K = CRASHPAD, steel = new THREE.MeshStandardMaterial({ color: 0x8d949b, metalness: 0.5, roughness: 0.45 });
    const ph = 6, py = heightAt(K.pole.x, K.pole.z);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(K.pole.r, K.pole.r, ph, 16).translate(0, ph / 2, 0), steel); pole.position.set(K.pole.x, py - 0.3, K.pole.z); pole.castShadow = true; group.add(pole);
    colliders.addCylinder({ x: K.pole.x, z: K.pole.z, radius: K.pole.r, height: ph, y0: py - 0.3, material: 'steel', tag: 'test pole' });
    const W = K.wall, wy = heightAt(W.x, W.z);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0xb9b5ac, roughness: 0.9 });
    const wall = new THREE.Mesh(new THREE.BoxGeometry(2 * W.halfX, W.h + 0.3, 2 * W.halfZ).translate(0, (W.h + 0.3) / 2, 0), wallMat); wall.position.set(W.x, wy - 0.3, W.z); wall.castShadow = wall.receiveShadow = true; group.add(wall);
    const stripes = new THREE.Mesh(new THREE.PlaneGeometry(2 * W.halfX, 0.4), new THREE.MeshBasicMaterial({ color: 0xf3c623 })); stripes.position.set(W.x, wy + 0.9, W.z - W.halfZ - 0.005); stripes.rotation.y = Math.PI; group.add(stripes);
    colliders.addBox({ x: W.x, z: W.z, halfX: W.halfX, halfZ: W.halfZ, yaw: 0, height: W.h + 0.3, y0: wy - 0.3, material: 'concrete', tag: 'wall' });
    const tGeo = new THREE.CylinderGeometry(0.17, 0.24, 2.6, 8).translate(0, 1.3, 0), cGeo = new THREE.IcosahedronGeometry(2.0, 0).translate(0, 3.8, 0);
    for (const [x, z] of K.trees) {
      const y = heightAt(x, z) - 0.1;
      const tr = new THREE.Mesh(tGeo, trunks.material as THREE.Material); tr.position.set(x, y, z); tr.castShadow = true; group.add(tr);
      const cr = new THREE.Mesh(cGeo, crowns.material as THREE.Material); cr.position.set(x, y, z); cr.castShadow = true; group.add(cr);
      colliders.addCylinder({ x, z, radius: 0.205, height: 2.6, material: 'wood', tag: 'tree' });
    }
    for (const z of K.signs.z) board('STOP', 'frangible sign', K.signs.x, z, Math.PI / 2, 1.2, 0.6, '#b5121b');
    board('CRASH PAD', 'kerb · sand · ramp · ditch · pole · wall', CRASH.x0 + 30, CRASH.z0 + 4, Math.PI, 3.2, 1.6, '#7a1f1f');
  }

  // ---- roadside village colliders (roadsideColliders.ts): buildings, boundary walls, poles, trees, milestones, posts, cots ----
  const cotIds: ColliderId[] = [];
  for (const c of ROADSIDE_COLLIDERS) {
    const tag = c.tag;
    if (c.kind === 'box') { const id = colliders.addBox({ x: c.cx, z: c.cz, halfX: c.halfX, halfZ: c.halfZ, yaw: c.yaw, height: c.height, y0: c.y0, material: c.material, tag,
      ...(c.tag === 'cot' ? { breakForce: 5e3, breakEnergy: 400 } : {}) }); if (c.tag === 'cot') cotIds.push(id); } // a charpai gets shoved aside / smashed [A]
    else colliders.addCylinder({ x: c.cx, z: c.cz, radius: c.radius, height: c.height, y0: c.y0, material: c.material, tag });
  }

  // ---- knocked and broken objects ----
  const cosAx = new THREE.Vector3(), q = new THREE.Quaternion();
  colliders.onBreak(e => {
    if (e.tag !== 'sign' || !signs[e.ref]) return;
    const sg = signs[e.ref]; if (sg.falling) return;
    // pushed along −n (the normal points from the sign toward the car); fall axis = up × push
    const px = -e.nx, pz = -e.nz, l = Math.hypot(px, pz) || 1;
    sg.ax.set(pz / l, 0, -px / l); sg.falling = true; sg.rate = Math.min(6, 0.5 + e.relSpeed * 0.25); sg.ang = 0;
  });
  const updateObjects = (dt: number) => {
    for (const sg of signs) {
      if (!sg.falling || sg.ang >= Math.PI / 2 - 1e-3) continue;
      sg.rate += 9.81 / 1.2 * Math.max(0.3, Math.sin(sg.ang)) * dt * 1.5; sg.ang = Math.min(Math.PI / 2, sg.ang + sg.rate * dt);
      sg.piv.quaternion.setFromAxisAngle(sg.ax, sg.ang);
    }
    let dirty = false;
    for (let i = 0; i < coneProps.length; i++) {
      const h = coneProps[i]; if (!h.moved) { if (coneMoved[i]) { coneMoved[i] = 0; } continue; }
      const p = h.pos, qq = h.quat; q.set(qq.x, qq.y, qq.z, qq.w);
      // lift by the base radius times the tilt so a cone lying on its side rests on its flank, not half underground
      cosAx.set(0, 1, 0).applyQuaternion(q); const uy = cosAx.y; const lift = Math.max(0, 0.17 * Math.sqrt(Math.max(0, 1 - uy * uy)), -0.7 * uy); // lowest point (base rim or tip) on the ground
      tmp.position.set(p.x, p.y + lift, p.z); tmp.quaternion.copy(q); tmp.scale.set(1, 1, 1); tmp.updateMatrix(); cones.setMatrixAt(i, tmp.matrix); coneMoved[i] = 1; dirty = true;
    }
    if (dirty) { cones.instanceMatrix.needsUpdate = true; cones.computeBoundingSphere(); }
  };
  const restoreObjects = () => {
    let any = false;
    for (let i = 0; i < coneProps.length; i++) { const h = coneProps[i]; if (!h.moved && !coneMoved[i]) continue; h.reset(); const p = h.pos; tmp.position.set(p.x, p.y, p.z); tmp.quaternion.set(0, 0, 0, 1); tmp.updateMatrix(); cones.setMatrixAt(i, tmp.matrix); coneMoved[i] = 0; any = true; }
    if (any) { cones.instanceMatrix.needsUpdate = true; cones.computeBoundingSphere(); }
    for (const sg of signs) { if (!sg.falling) continue; sg.falling = false; sg.ang = 0; sg.rate = 0; sg.piv.quaternion.identity(); for (const id of sg.ids) { const c = colliders.get(id); if (c) c.broken = false; } }
    for (const id of cotIds) { const c = colliders.get(id); if (c) c.broken = false; }
    colliders.version++;
  };

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
  const setGraphics = (g: WorldGraphics) => {
    if (sun.shadow.mapSize.x !== g.shadowSize) { sun.shadow.mapSize.set(g.shadowSize, g.shadowSize); sun.shadow.map?.dispose(); (sun.shadow as { map: unknown }).map = null; }
    trunks.castShadow = crowns.castShadow = lamps.castShadow = g.treeShadows;
    const nT = Math.round(ti * g.treeFrac);
    trunks.count = crowns.count = nT; // trees are placed at random, so the first N are an even thinning
    colliders.setTagEnabled('tree', true, 0, nT); colliders.setTagEnabled('tree', false, nT, ti); // hidden trees don't collide
  };
  return { group, sun, sky, updateShadow, setGraphics, roadLods, roadside: roadside.stats, updateObjects, restoreObjects, colliderCount: colliders.size };
}

function mulberry(a: number) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
