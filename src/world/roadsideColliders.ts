// Collider registry for the roadside objects of the new road (roadside.ts), for the collision system being built
// separately. Data only: nothing here touches the physics.
//
// Conventions (world frame: +Y up, metres):
//  * box:      footprint centre (cx, cz), half extents (halfX, halfZ) in the box's own frame, rotated by `yaw` about +Y
//              (three.js rotation.y: world = R_y(yaw) · local, so yaw 0 means halfX runs along world X).
//              Boxes whose yaw is a multiple of 90° are given with yaw 0 and the half extents swapped to world axes.
//  * cylinder: vertical, axis at (cx, cz), `radius`.
//    This is the same yaw convention as src/world/colliders.ts (yaw 0 = local +Z along world +Z, + turns +Z toward +X),
//    so each entry maps 1:1 onto addBox / addCylinder there (x = cx, z = cz).
//  * y0 = bottom (lowest ground under the footprint, or the foundation), height = top − y0. `tag` says what it is,
//    `material` is a hint for colliders.ts (ColliderMaterial).
import { LAYOUT } from './roadside';

export type RoadsideMaterial = 'masonry' | 'concrete' | 'wood' | 'steel';
export type RoadsideCollider =
  | { kind: 'box'; cx: number; cz: number; halfX: number; halfZ: number; height: number; yaw: number; y0: number; tag: string; material: RoadsideMaterial }
  | { kind: 'cylinder'; cx: number; cz: number; radius: number; height: number; y0: number; tag: string; material: RoadsideMaterial };
const MAT: Record<string, RoadsideMaterial> = { house: 'masonry', shop: 'masonry', stall: 'wood', dhaba: 'masonry', shrine: 'masonry', 'boundary-wall': 'masonry', pole: 'concrete', 'pole-transformer': 'concrete', tree: 'wood', milestone: 'concrete', 'board-post': 'steel', cot: 'wood' };

function box(cx: number, cz: number, hx: number, hz: number, yaw: number, y0: number, top: number, tag: string): RoadsideCollider {
  const q = yaw / (Math.PI / 2), r = Math.round(q);
  if (Math.abs(q - r) < 1e-6) { const odd = Math.abs(r) % 2 === 1; return { kind: 'box', cx, cz, halfX: odd ? hz : hx, halfZ: odd ? hx : hz, height: top - y0, yaw: 0, y0, tag, material: MAT[tag] }; }
  return { kind: 'box', cx, cz, halfX: hx, halfZ: hz, height: top - y0, yaw, y0, tag, material: MAT[tag] };
}

export const ROADSIDE_COLLIDERS: RoadsideCollider[] = [];
{
  const C = ROADSIDE_COLLIDERS;
  for (const b of LAYOUT.buildings) {
    // footprint centre: the facade is at (b.x, b.z) facing the road; the building extends `depth` behind it
    const sx = Math.sin(b.yaw), cz = Math.cos(b.yaw); // facade normal = (sin yaw, 0, cos yaw)
    const cx = b.x - sx * b.depth / 2, czz = b.z - cz * b.depth / 2;
    const top = b.kind === 'stall' ? b.floor + 2.6 : b.kind === 'shrine' ? b.floor + 4.6 : b.kind === 'dhaba' ? b.floor + 3.6 : b.floor + b.floors * 3.0 + 0.3 + 0.9;
    C.push(box(cx, czz, b.w / 2, b.depth / 2, b.yaw, b.base - 0.3, top, b.kind));
  }
  for (const w of LAYOUT.walls) {
    const dx = w.x1 - w.x0, dz = w.z1 - w.z0, len = Math.hypot(dx, dz);
    C.push(box((w.x0 + w.x1) / 2, (w.z0 + w.z1) / 2, len / 2 + w.t / 2, w.t / 2, Math.atan2(-dz, dx), w.base, w.base + 0.15 + w.h, 'boundary-wall'));
  }
  for (const p of LAYOUT.poles) C.push({ kind: 'cylinder', cx: p.x, cz: p.z, radius: 0.15, height: p.h, y0: p.base, tag: p.transformer ? 'pole-transformer' : 'pole', material: 'concrete' });
  for (const t of LAYOUT.trees) C.push({ kind: 'cylinder', cx: t.x, cz: t.z, radius: 0.22 * t.s * (t.kind === 'peepal' ? 1.8 : 1), height: 2.4 * t.s, y0: t.base - 0.1, tag: 'tree', material: 'wood' });
  for (const s of LAYOUT.stones) C.push(box(s.x, s.z, s.kind === 'hm' ? 0.13 : 0.3, s.kind === 'hm' ? 0.08 : 0.13, s.yaw, s.base - 0.1, s.base + (s.kind === 'hm' ? 0.55 : 1.0), 'milestone'));
  for (const b of LAYOUT.boards) for (const o of [-1, 1]) C.push({ kind: 'cylinder', cx: b.x + (b.yaw ? 0 : o * b.w * 0.4), cz: b.z + (b.yaw ? o * b.w * 0.4 : 0), radius: 0.05, height: b.post + b.h, y0: b.base, tag: 'board-post', material: 'steel' });
  for (const c of LAYOUT.cots) C.push(box(c.x, c.z, 0.95, 0.45, c.yaw, c.base, c.base + 0.5, 'cot'));
}
