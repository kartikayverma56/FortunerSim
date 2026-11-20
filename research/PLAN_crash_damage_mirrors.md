# PLAN: crash physics, damage, crash statistics, world collisions, live mirrors

Planned by a Fable agent on 2026-11-20. It was saved verbatim from the agent's report, because the agent could not write files. Nothing was run to produce it: behaviour claims come from reading the code, and every timing is an estimate.

Tags: **[C]** read in code. **[S]** fetched in the planning session. **[D]** calculated from `params.ts`. **[M]** from memory, verify before relying on it. **[A]** assumption to tune.

## Collider API (exact; the roads/world agent registers objects against it)

```ts
// src/world/colliders.ts — no three.js, no DOM. Imported by physics, world code and node tools.
// Units: metres, kg, seconds, newtons, radians. World frame, +Y up.
// yaw is about +Y; 0 = local +Z along world +Z; positive turns +Z toward +X (same as Vehicle.reset heading).

export type ColliderMaterial = 'wood' | 'steel' | 'concrete' | 'masonry' | 'plastic' | 'rubber' | 'vehicle' | 'animal';
export type ColliderId = number;            // > 0, never reused in a session

export interface ColliderOpts {
  y0?: number;                 // world Y of the bottom. Default heightAt(x, z) - 0.3
  material?: ColliderMaterial; // default 'concrete' (sets friction and sound)
  mu?: number;                 // friction against the car body; overrides the material value
  breakForce?: number;         // N; contact force at which the object fails. Omit = immovable
  breakEnergy?: number;        // J absorbed while failing. Default 0.15 * breakForce
  group?: number;              // same group breaks together (post + board)
  tag?: string;                // owner label: 'tree' | 'lamp' | 'sign' | 'building' | 'traffic' ...
  ref?: number;                // owner's own index (e.g. InstancedMesh instance); returned in events
}
export interface CylinderSpec extends ColliderOpts { x: number; z: number; radius: number; height: number } // vertical axis
export interface BoxSpec extends ColliderOpts { x: number; z: number; halfX: number; halfZ: number; yaw: number; height: number } // vertical sides
export interface MovingSpec extends BoxSpec { mass: number }
export interface PropSpec { x: number; z: number; yaw?: number; kind: 'cone' | 'drum' | 'barricade' | 'crate';
  radius: number; height: number; mass: number; tag?: string; ref?: number }

export interface Collider { readonly id: ColliderId; readonly kind: 'cyl' | 'box' | 'moving';
  x: number; z: number; y0: number; y1: number; radius: number; halfX: number; halfZ: number; cos: number; sin: number;
  material: ColliderMaterial; mu: number; breakForce: number; breakEnergy: number; group: number; tag: string; ref: number;
  enabled: boolean; broken: boolean; vx: number; vz: number; yawRate: number; mass: number }

export interface HitEvent { id: ColliderId; tag: string; ref: number; material: ColliderMaterial;
  px: number; py: number; pz: number;      // world contact point
  nx: number; ny: number; nz: number;      // unit normal, from the collider toward the car
  impulse: number; relSpeed: number; broke: boolean }

export interface MovingHandle { readonly id: ColliderId;
  setPose(x: number, z: number, yaw: number, vx: number, vz: number, yawRate?: number): void; // owner calls each frame until hit
  readonly hit: boolean;                    // true after the car struck it; the registry then owns its motion
  readonly pose: { x: number; z: number; yaw: number; vx: number; vz: number };
  release(): void }
export interface PropHandle { readonly id: ColliderId; readonly moved: boolean;
  readonly pos: { x: number; y: number; z: number }; readonly quat: { x: number; y: number; z: number; w: number };
  reset(): void }

export const colliders: {
  addCylinder(s: CylinderSpec): ColliderId;
  addBox(s: BoxSpec): ColliderId;
  addWall(points: ReadonlyArray<readonly [number, number]>, thickness: number, height: number, o?: ColliderOpts): ColliderId[];
  addMoving(s: MovingSpec): MovingHandle;
  addProp(s: PropSpec): PropHandle;
  remove(id: ColliderId): void;
  removeTag(tag: string): number;
  setEnabled(id: ColliderId, on: boolean): void;
  setTagEnabled(tag: string, on: boolean, refFrom?: number, refTo?: number): void;
  get(id: ColliderId): Collider | undefined;
  queryCircle(x: number, z: number, r: number, out: Collider[]): number; // fills out, returns the count
  isFree(x: number, z: number, r: number): boolean;
  onHit(cb: (e: HitEvent) => void): () => void;    // at most once per collider per 0.1 s; returns unsubscribe
  onBreak(cb: (e: HitEvent) => void): () => void;
  stepProps(dt: number): void;                     // main loop, once per frame
  readonly version: number;                        // bumps on any add / remove / enable
};
```

Rules for registering objects:
- Anything a wheel should climb (kerbs, medians up to 0.30 m) goes in `heightAt` with a face run of at least 0.04 m, not here.
- Taller objects are colliders. Buildings are one or more boxes; curved walls and guard rails use `addWall`. Cylinders are vertical only.
- The owner of the visual listens to `onBreak` and `onHit` to tip, hide or animate it.
- Colliders can be added or removed at any time (chunk streaming is fine).
- Anything that must show in the mirrors needs `obj.layers.enable(MIRROR_LAYER)` on every mesh and light. `MIRROR_LAYER = 1` is exported from a new `src/render/layers.ts`.

## 0. Findings in the current code

| # | Finding [C] | Effect |
|---|---|---|
| F1 | Body contact is 22 belly points (7 × 3 plus the skid plate, `vehicle.ts` 117–122) and the rear diff. `Fn = 6e5·pen`, damping only when `vpy < 0`, μ 0.45, normal is world +Y, not the terrain normal | No roof, pillar or side support |
| F2 | Tyre ring (340–346) puts the ring bottom at world-down from the wheel centre whatever the wheel's orientation | Inverted: no contact until the body is about 1.3 m underground, then the tyre pulls the body up through the rebound stop (2.5e5 N/m) and rim spring (4e6 N/m, no damper). On its side: wheel centre about 0.13 m high gives pen about 0.25 m and about 700 kN per wheel [D] |
| F3 | `mu = muPeak·surf.mu·(1 − 0.12·(Fz/Fz0 − 1))` (389) has no lower clamp | μ is negative above Fz ≈ 51 kN [D], reached 7 mm into rim contact. Tyre friction then accelerates the slide |
| F4 | Tyre force magnitude depends on the wheel-centre height but is applied at `C − up·hL` (424–431) | Non-conservative when the car is far from upright; can add energy each bounce |
| F5 | Angular step is explicit Euler on Euler's equations (491–496) | Angular momentum grows while tumbling, a few percent per second at 6 rad/s [D, rough] |
| F6 | Lateral tyre force enters the body at roll-centre height (0.12 front, 0.45 rear, hard-coded at 419). No jacking reaction goes to the wheels | Body roll angle is right (about 4.7°/g [D]), but tyre load transfer is `Fy·(h − hRC)/t`. Wheel lift needs about 1.4–1.5 g [D] instead of about 0.9 g. The sim car is roughly 50 % too roll-stable |
| F7 | Motion perpendicular to body-up uses mass `mTot`, but gravity on the unsprung mass in that direction is never added (485–487) | Grade force about 11 % low on any slope. On its side the car falls at 0.89 g. The same error gives a small spurious push with squat and dive |
| F8 | Rear-diff contact (463–469) ignores orientation | Wrong force when rolled |
| F9 | `roll = asin(left.y)` (509) | Cannot report beyond ±90° or count rolls |
| F10 | No collision code anywhere. Trees, lamps, boards and cones are visual only (`worldMesh.ts` 156–196). On Low only half the trees are drawn (`treeFrac 0.5`) | Colliders must follow tree visibility |
| F11 | `mergeStatic` merges car meshes per material and drops unused UVs (`rig.ts` 435, 457). All mirror glass is `chrome_only`; all windows are one `windows_glass` material | Mirrors and glass panes must be split into material variants before the merge, as the lamps already are |

## 1. Body collision hull and contact model

**Points.** Body frame is +X left, +Y up, +Z forward, origin at the CG. From `params.ts` [D]: front bumper z = +2.28, rear z = −2.515, half width 0.9275, roof y = +1.035, ground y = −0.80.

| Group | Points (x, y, z), mirrored left/right | Count |
|---|---|---|
| Front | bumper centre (0, −0.15, 2.28); corners (±0.80, −0.20, 2.12); bonnet lip (0, 0.25, 2.22), (±0.75, 0.22, 2.05) | 6 |
| Bonnet, cowl | (0, 0.33, 1.70); (±0.70, 0.35, 1.25) | 3 |
| A-pillar mid | (±0.72, 0.68, 0.85) | 2 |
| Roof | header (0, 1.03, 0.50), (±0.60, 1.00, 0.50); B tops (±0.63, 1.035, −0.35); C tops (±0.63, 1.03, −1.25); D tops (±0.60, 0.98, −2.10); centre (0, 1.035, −0.80); rear header (0, 1.00, −2.15) | 11 |
| Sides | (±0.92, 0.22, 1.00); (±0.9275, 0.20, −0.20); (±0.92, 0.22, −1.40); (±0.88, 0.25, −2.20) | 8 |
| Mirrors | (±1.05, 0.33, 0.95) | 2 |
| Arch flares | (±0.93, −0.02, 1.29); (±0.93, −0.02, −1.455) | 4 |
| Sills | (±0.90, −0.45, 0.50); (±0.90, −0.45, −0.60) | 4 |
| Rear | bumper (0, −0.15, −2.515), (±0.82, −0.20, −2.38); tailgate (0, 0.35, −2.50) | 4 |
| Tyre sidewalls (follow the wheel) | outboard face at wheel centre ±0.27 m fore/aft and +0.30 m up | 12 |

- Positions are [A], from official length, width, height and typical proportions.
- Fit them once to the GLB with a dev helper (`sim.fitHull()` ray-casts each point onto the model and prints JSON), then paste the result into `params.ts` as `hullPoints`, class `estimate`. Physics must stay DOM-free, so there is no runtime fitting.
- The 22 belly points and their code stay exactly as they are, which keeps the hump table's clearance and scrape values identical.

**Contact law per point (ground).** State per point: plastic set `δp` and a friction anchor.

```
P = pos + R·p            cull if P.y > gMax + 0.10   (gMax = highest ground height already sampled this step)
h = heightAt(P.x, P.z);  n = normalAt(P.x, P.z, e = 0.15);  d = (h − P.y)·n.y
x  = d − δp                               // elastic deflection
Fn = ke·x + ce·max(0, −vn)·min(1, x/2mm)  // approach-only damper, never adhesive
if Fn > Fy + kp·δp:   Δ = (Fn − Fy − kp·δp)/(ke + kp);  δp += Δ;  Fn = Fy + kp·δp;  Wcrush += Fn·Δ
Ft = −kt·(Pt − anchor) − ct·vt, clamped to μ·Fn (the anchor slides when clamped)
```

- Unloading follows `ke`, so restitution falls out of the model: about 0.4–0.5 below yield and about 0.1–0.2 in a hard hit. Real restitution falls with speed in the same way [M].
- `δp` is the permanent crush depth. It is both the damage state and the energy sink.
- There is no artificial angular damping. Spin is lost through plastic hits and friction at successive points.
- The friction anchor (a bristle model) lets the car come to rest on a slope instead of creeping.

**Parameters, all [A], with the basis shown:**

| Zone | ke N/m | Fy kN | kp N/m | Max crush m | Basis |
|---|---|---|---|---|---|
| Front | 1.2e7 | 40 | 5e5 | 0.9 | Targets: full frontal 56 km/h gives 0.5–0.7 m crush at 18–25 g mean; pole 50 km/h gives 0.7–1.0 m [M] |
| Roof rails, pillar tops | 1.2e7 | 30 | 7e5 | 0.35 | Roof strength about 3.5 × weight within 127 mm [A, M], so 74 kN at 0.1 m [D] |
| Roof panel centre | 1.2e7 | 8 | 1.5e5 | 0.25 | Sheet metal |
| Doors, quarters | 1.2e7 | 12 | 2e5 | 0.35 | |
| Sills, arches, rear | 1.2e7 | 25 | 5e5 | 0.5 | |
| Mirrors | 1e6 | 0.4 | 1e3 | 0.2 | Fold or break away |
| Tyre sidewall | 2.5e5 | 40 | 4e6 | 0.05 | Carcass, then rim; yield means wheel damage |

- Contact damping `ce` = 6e4 N·s/m; tangential stiffness `kt` = 2e6 N/m.
- Body-on-ground μ: asphalt and concrete 0.40, wet 0.30, gravel 0.55, grass 0.55, mud 0.50, sand 0.65. These sit inside the 0.3–0.6 range recalled from reconstruction literature [M].

**Stability at 1 kHz [D].** A roof-corner contact has an effective mass of about 860 kg; a mirror about 500 kg.
- Worst case, with 10 points in contact: ω = √(1.2e8 / 2100) ≈ 240 rad/s, so ω·dt = 0.24 against a stability limit of 2.
- Damping: `ce·dt/m_eff` ≈ 0.12.
- No sub-stepping or impulse solver is needed. An impulse solver would also clash with the force-based tyre and suspension code.

**Tyre and integrator fixes.** All of these leave upright driving bit-identical.
- **Uprightness gate:** `g = sstep(0.17, 0.5, up·n)` multiplies `Fz`. It is exactly 1 below 60° of tilt, 0 beyond 80°, and 0 when `up.y ≤ 0`. Beyond that, the sidewall points carry the load.
- **Tilted ring radius:** `R_eff = min(R, R·cosθ + (w/2)·sinθ)`. It equals `R` below 37.7° of tilt [D].
- **Load-sensitivity clamp:** the factor is clamped to at least 0.3. It is active only above about 37 kN.
- **Rear diff:** its contact is gated by `up.y > 0.5`.
- **Angular momentum:** integrate it in the world frame (`L += T·dt`, then `ω = R·I⁻¹·Rᵀ·L`). If any printed baseline digit changes, switch it in only above 1 rad/s.
- **Unsprung gravity:** add the missing term `−mU·G·(ŷ − up·up.y)`, weighted by `1 − sstep(0.5, 0.8, up·n)` so it is zero within 37° of upright. Removing that weighting is Fix B in section 2.
- **Rim spring:** if the drop test bounces more than three times, give the rim spring loading-only hysteresis.

**Rest and recovery.**
- `Vehicle.reset` also clears contact anchors, roll counters and the recorder state.
- Backspace keeps the damage, like being towed back onto the wheels. Y repairs. Shift+Backspace does both.
- `reset` nudges the car out with `colliders.isFree` if it would otherwise land inside a collider.

## 2. Rollover realism

**What the numbers say [D].**
- SSF = 1.545 / (2 × 0.80) = 0.97 with the assumed CG height.
- After the F6 fix, load transfer at 0.85 g unloads the inner tyres by 88 %. Peak lateral grip is about 0.95 × 0.907 ≈ 0.86 g, and the tip threshold, with roll and tyre compliance, is about 0.91 g.
- So steady cornering on dry asphalt slides before it tips, with about 5 % margin. A dynamic manoeuvre can overshoot that margin.
- Sideways sliding on asphalt gives about 0.73 g (the Magic Formula sliding value), so a pure slide does not roll unless something trips it.
- The rigid-trip critical sliding velocity is 3.95 m/s (14 km/h) by the standard formula [M for the formula, D for the number]. Real kerb trips need more, because the tyre and suspension give.

**Reference points.**
- 2010 Toyota 4Runner (RWD): SSF 1.12, dynamic test "No-tip" [S]. Scaled to the Fortuner's narrower track, the same CG height (0.717 m) would give SSF 1.08.
- 2016 Hilux (same platform, 265/60 R18) lifted two wheels in Teknikens Värld's moose test with ESC on. Reports give 60–64 km/h. Toyota then changed the tyre pressure and ESC logic [S, press reports].
- No Fortuner rollover data turned up. ANCAP and ASEAN NCAP reports were not searched.
- CG height is therefore the deciding unknown. 0.80 m is on the tippy side; 0.74–0.76 m would be closer to the 4Runner. It is not changed here because it shifts dive and squat; the tests sweep it instead.

**Changes.**
1. **Fix A, jacking forces (approval needed).** Per wheel, `J = Fy_lat·hRC/(t/2)`, signed by side. Subtract it from the wheel's vertical equation and add `up·J` to the body at the roll centre (centreline, axle z). The body roll moment is unchanged; the tyre loads become correct. Move `hRC` and the anti-dive values into `params.ts`. Straight-line tests have `Fy = 0`, so they should not move. The steady-state corner in `simtest` will.
2. **Lateral kerb contact.** When a wheel's lateral speed is above 0.5 m/s, sample `heightAt` at both tyre shoulders. A step of more than 3 cm beside the tyre gives an inboard force: 2e5 N/m for the carcass, then 4e6 N/m for the rim [A]. This costs 8 extra `heightAt` calls, only while sliding.
3. **Soft-ground trip.** Add `plow` to `SURFACES`: asphalt 0, gravel 0.30, grass 0.35, mud 0.70, sand 0.80 [A]. The lateral force limit becomes `(μ + plow)·Fz`, phased in between 20° and 50° slip angle and above 2 m/s lateral speed. Normal driving stays under 10° slip, so it is unaffected.
4. **VSC roll mitigation [A].** Brake the outer front wheel hard when lateral g exceeds 0.75 and the roll rate is high. Needed only if the fishhook with VSC on lifts wheels.
5. **Fix B, optional.** Remove the tilt weighting on the unsprung-gravity term. This corrects hill climbing by 11 %, shifts 0–100 and 100–0 by under 1 % [D, estimate], and needs a small re-trim.

**Validation tests (`tools/crashtest.ts`):**

| Test | Procedure | Expected |
|---|---|---|
| Fishhook | NHTSA Fishhook 1b [M]: find the handwheel angle for 0.3 g at 80 km/h and multiply by 6.5; steer at 720°/s, reverse when the roll rate drops below 1.5°/s, hold 3 s; entry speeds 56, 64, 72, 76, 80 km/h, throttle off. Two-wheel lift means both inner wheels 50 mm clear | VSC on: no lift at any speed. VSC off at CG 0.80: lift likely from 64–72 km/h [D, prediction]. Repeat at CG 0.72, 0.76, 0.84 |
| J-turn | A single 720°/s step to 8 × the 0.3 g angle [M], 56–97 km/h | Same pattern, milder |
| Sideways slide | 15, 20, 25 m/s lateral on asphalt, grass, sand | Asphalt: no roll. Sand and mud above about 40 km/h: trips |
| Kerb trip | Slide sideways into a 150 mm kerb at 10, 25, 40 km/h | 10: no roll. 40: at least one quarter turn. 25: either, reported |
| Drop, wheels down | 0.5 m and 1.0 m | Rest within 3 s, at most 3 rebounds over 2 cm |
| Drop, roof down | 0.5 m | Rest on the roof within 2 s, rebound under 5 cm, crush 3–15 cm |
| Drop, corner with spin | 1 m, 3 rad/s | Rest within 6 s |
| Free tumble | No ground, ω = (1, 6, 2), 10 s | Angular momentum within 0.1 %, rotational energy within 0.5 % |
| Energy audit, all tests | Engine off, sample mechanical energy | Never rises by more than 0.5 % of the start value |
| Ramp roll, ditch | One-side 0.6 m ramp at 60 and 80 km/h | Rolls, rests within 15 s. Mean deceleration from trip to rest reported against the 0.36–0.61 g band [M] |

## 3. World collisions

- **Registry.** `src/world/colliders.ts`, with the API above. It is a spatial hash with 8 m cells; a collider is inserted in every cell its footprint overlaps.
- **Broadphase.** Every 16 physics steps, query the car's position with a radius of 4 m plus 0.05 s of travel, into a cached near list. Each step tests only that list, which is usually empty.
- **Narrowphase.** The car is two body-frame boxes:
  - lower box: x ±0.9275, y −0.50 to +0.30, z −2.515 to +2.28;
  - cabin box: x ±0.80, y +0.30 to +1.035, z −2.45 to +1.25.
  - **Cylinder colliders:** five spheres along the part of the cylinder's axis that overlaps the car's height, each tested against both boxes (closest point, depth = radius − distance). This catches thin poles that would fall between hull points.
  - **Box colliders:** every hull point against the box (minimum-penetration face), plus the box's four vertical edges tested against the car boxes as zero-radius cylinders.
  - **Moving colliders:** same tests, using relative velocity.
- **Response.** The same elastic-plastic law, using the nearest hull point's parameters and sharing its `δp`. Crush from poles and from the ground therefore adds up in one damage state.
- **Frangible objects.** When the contact force exceeds `breakForce`, the collider absorbs `breakEnergy`, is disabled, and `onBreak` fires.
- **Props (cones).** Integrated per frame in `stepProps`. A struck cone takes the car's contact-point velocity × 1.3, then flies, bounces (0.3) and slides (μ 0.6) to rest. The reaction on the car is ignored (4 kg against 2235 kg). Cones hit are counted in the statistics.

**Existing scenery (`worldMesh.ts`).**

| Object | Collider | Values |
|---|---|---|
| Tree trunk | Cylinder, immovable | radius 0.185·s, height 2.4·s·sy, `wood`, `tag 'tree'`, `ref` = instance index. `setGraphics` calls `setTagEnabled('tree', true, 0, count)` so hidden trees don't collide |
| Tree crown | None in v1 | The car passes through foliage; a known gap |
| Lamp post | Cylinder, immovable | radius 0.075, height 8, `steel`. Real columns can shear; immovable is [A] |
| Sign post and board | Cylinder r 0.04 plus a thin box at y0 = ground + 1.5 (the 1.835 m roof reaches it), same `group` | `breakForce` 12 kN [A]; `onBreak` lays the board flat |
| Cones | Props | radius 0.17, height 0.7, mass 4 kg [A] |

## 4. Damage model

**State (`src/physics/damage.ts`, DOM-free):**
- per hull point: `δp`;
- per zone (front, rear, left, right, roof, underbody): damage 0–1, = mean `δp` / max crush;
- per wheel: toe offset, puncture, damper factor, collapsed flag.

**Mechanical consequences:**

| Trigger | Consequence | Basis |
|---|---|---|
| Rim strike or sidewall yield, impulse over threshold | Toe offset up to ±2° (steering pull); damper force × 0.3 | [A] |
| Rim strike above 40 kN or sidewall crush | Puncture: tyre stiffness 290 → 70 kN/m, μ × 0.6, rolling resistance × 4 | [A] |
| Wheel-zone crush over 0.15 m | Suspension collapsed: spring × 0.4, wheel dragged | [A] |
| Front crush over 0.12 m | Coolant leak: temperature climbs with load; torque derate after about 2–5 min, then stall | [A] |
| Front crush over 0.25 m | Intercooler holed: boost 0, torque falls to the 0.42 no-boost fraction already in `params.ts` | [A] |
| Front crush over 0.5 m | Engine dead | [A] |
| ΔV over 6 m/s frontal or 4 m/s lateral within 150 ms | Airbags fire and fuel is cut, so the engine stops; Enter restarts unless the engine is dead. Toyota owner's manuals describe a fuel-pump shut-off on airbag deployment [M]; thresholds are typical must-fire values [M] | |
| Inverted for more than 3 s | Engine stalls (oil starvation) | [A] |

**Visual (`src/vehicle/damageVisual.ts`).** The cost is paid once per impact, not per frame.
- **Deformation.** For each merged body mesh, displace vertices within radius r of the impact point along the inward normal by `depth·(1 − (d/r)²)²`, with ±15 % hash noise. Clamp against a lazily copied rest-position array.
- **Normals.** One index scan per affected mesh, recomputing only flagged vertices.
- **Cost.** Estimated 1.5–3 ms for about 150 k vertices [A]. Queue hits and apply at most one pass per frame; merge hits within 100 ms per zone.
- **Glass.** Split `windows_glass` into windscreen, rear, left and right variants before the merge. Tempered side and rear panes disappear when shattered. The laminated windscreen stays, with a crack normal map on generated planar UVs and a frosted look.
- **Lamps and mirrors.** Broken lamp materials stay dark. Mirror glass is hidden when its hull point yields.
- **Shadow.** The shadow proxy is not deformed.
- **Repair (Y).** Restores rest positions, materials and physics state.

## 5. Crash statistics

**Recorder (`src/physics/crashRecorder.ts`, DOM-free).** An event opens on a body hit above threshold, on more than 3 g, or on tilt beyond 60°. It closes after 1 s at rest, or after 20 s.

Recorded per event:
- speed and slip angle at first contact; impact zone and the clock direction of the impulse;
- ΔV, longitudinal and lateral (maximum over a 150 ms window);
- peak g, as a 10 ms moving average at the CG and at the driver's seat (`accelBody` is filtered at about 3 Hz and is too slow for this);
- quarter turns and full rolls, from integrated body roll rate (this fixes F9); peak roll rate; end-over-end turns;
- airborne time, peak CG height, and distance and time from first contact to rest;
- mean deceleration over the roll, as a drag factor, shown beside the literature band as a self-check;
- energy split: crush by zone, friction, remaining;
- damage % by zone, mechanical faults, objects struck, cones hit;
- no injury figures, because nothing in the model supports them.

**Display.**
- At rest, `hud.showResult` shows the report in the existing `#result` table, with a chart of speed, roll angle and g. This reuses `TestResult` unchanged.
- One line in `#info`, e.g. `Damage F 32 % · Roof 60 % · FL flat`.
- Crash log (P): the last 20 reports, kept in `localStorage` under `fsim.crashlog`, with a Save button that downloads JSON.
- Tests panel (T): Fishhook, Kerb trip, Pole and Drop buttons through `TestRunner`.

**Audio and camera.** Add `BodyImpactEvent { energy, zone, material }` to `audio/types.ts`. Reuse the existing impact voice, and `bellyScrape` for body sliding. Call `camRig.kick` on body hits.

## 6. Live mirrors (Medium and High)

**Approach: three true reflections, one atlas, one mirror per frame.** A single wide rear camera was rejected: it would draw about half the scene backwards and give the wrong parallax. A narrow per-mirror frustum culls most terrain pieces.

**Per mirror.**
- Virtual eye: `E' = E − 2((E − M)·n)·n`.
- The camera looks along the mirror normal, with an off-axis frustum through the mirror's four corners and the near plane on the mirror plane. That clips the car's own body with no oblique-clip maths.
- Convex door mirrors: move the virtual eye toward the mirror by `κ = 1/(1 + 2d/R)`, with R = 1.4 m [A]. The field of view becomes about `w/d + 2w/R`: 30° on the driver's side, 23° on the far side, 31° for the interior mirror [D].
- Mapping is projective (`textureMatrix × world position`, as in three's `Reflector.js`). No mesh UVs and no manual flip are needed. Planar UVs are only the fallback if the atlas approach is dropped.
- One half-float render target: 384×192 on Medium (interior 384×96, doors 192×96 each), 512×256 on High. The mirror material is tone-mapped with the rest of the frame, tint 0.85.

**Mirror meshes.**
- In `materialPass`, give the three `chrome_only` mirror glasses their own variants: the interior one by the existing position test, the door ones by |x| > 0.88. Allow `rigmap.json` overrides.
- After the merge, take each mirror's plane, normal and corners from its vertices.
- The stand-in model has no mirrors, so the system stays off with it.

**What is drawn.**
- Only objects on `MIRROR_LAYER`: terrain, trees, lamps, boards, cones, sky, both lights, traffic.
- Not the car itself. Instead, a paint-coloured shell of two rounded boxes on the mirror layer only, so the door mirrors show a flank. Optionally, a static rear-window mask on the interior mirror.
- Shadows: `renderer.shadowMap.autoUpdate = false` during mirror passes; they reuse the last shadow map.
- Terrain: `camera.userData.lodBias = 4` in `TerrainLOD.update` forces the far twins (a one-line change).
- World matrices are updated once per frame, not per pass.

**Schedule.**
- Cockpit camera: the sequence interior, right, interior, left. The interior mirror updates at 30 Hz and the door mirrors at 15 Hz.
- Other cameras: one mirror every fourth frame within 8 m, otherwise frozen.
- High: two mirrors per frame.

**Cost [A].** About 100–150 k triangles per mirror view (against more than 1 M in the main view), plus about 0.3–0.5 ms of CPU per pass. That is about 1–2 ms per frame on Medium in the cockpit, and about 0 in chase view.

**Quality.** Add `mirrors: 0 | 1 | 2` to `Preset` (Low 0, Medium 1, High 2). It switches live in `applyGfx`.

## 7. Performance budget and verification

| Item | Budget | Check |
|---|---|---|
| Physics, normal driving | Under +2 µs per step (hull cull about 0.3, collider list about 0.1, jacking and gates about 0.3, recorder about 0.2); total at most 85 µs | `tools/bench.ts` before and after, plus a run beside trees |
| Physics, during a crash | At most 140 µs per step, for a few seconds | Bench variant with the car on its roof |
| Baselines | `simtest` (0–100 10.72 s, 100–0 44.7 m), `feeltest` and `humptest` text output identical after P1 and P3 | Save outputs to `tools/baselines/` first; diff after every phase. After Fix A, only the corner section of `simtest` may differ, and that diff gets reviewed |
| Deformation | At most 3 ms, once per impact | `performance.now()` around the pass |
| Mirrors | At most 2 ms per frame on Medium in the cockpit | fps over 2.5 s windows with mirrors on and off; `EXT_disjoint_timer_query_webgl2` if present |
| Draw calls | +3 mirror meshes, +4–6 glass variants, plus mirror-pass calls | `renderer.info`, read per pass because it resets on each render |

## 8. Phases

| Phase | Content | Files | Done when |
|---|---|---|---|
| P0 | Save baselines. `colliders.ts` with the full API and a working registry (no narrowphase yet). `layers.ts`. Crash pad in `terrain.ts` (suggested x −700 to −500, z 0 to 300, clear of the handling pad): apron, 150 mm kerb, sand pit, ramp, ditch. Energy audit helper | `tools/`, `src/world/colliders.ts`, `src/render/layers.ts`, `terrain.ts` | Other code can register colliders |
| P1 | Tyre gates and clamps; upper hull with the contact law and friction anchors; angular-momentum integrator; gated unsprung gravity; reset state; roll counter | `vehicle.ts`, `params.ts`, new `src/physics/hull.ts`, `tools/crashtest.ts` | Drop, tumble and energy tests pass; baselines identical; no endless spin |
| P2 | Fix A (after approval), lateral kerb contact, soft-ground plough, fishhook, J-turn, kerb and slide tests, CG sweep, VSC roll mitigation if needed | `vehicle.ts`, `params.ts`, `terrain.ts`, `ui/tests.ts` | Test table in section 2 reported |
| P3 | Narrowphase, scenery registration, frangible signs, cone props, pole and wall tests | `colliders.ts`, `hull.ts`, `worldMesh.ts`, `main.ts` | Pole at 50 km/h and wall at 56 km/h land inside the crush targets |
| P4 | Crash recorder, result panel, log, audio events, camera kick | new `crashRecorder.ts`, `hud.ts`, `tests.ts`, `index.html`, `audio/types.ts`, `main.ts` | Report appears at rest; log saves |
| P5 | Mechanical damage, deformation, glass, lamps, airbag and fuel cut, repair key | new `damage.ts`, `damageVisual.ts`, `rig.ts`, `vehicle.ts` | Each consequence shown by a scripted hit |
| P6 | Mirrors (independent of P1–P5) | new `src/render/mirrors.ts`, `rig.ts`, `quality.ts`, `terrainLod.ts`, `worldMesh.ts`, `main.ts` | Under 2 ms on the Iris Xe at Medium |

Files shared with the roads work: `terrain.ts`, `worldMesh.ts`, `terrainLod.ts`, `main.ts`, `hud.ts`, `ui/tests.ts`, `index.html`. Whoever creates an object adds its collider and its mirror layer.

## 9. Risks

| Risk | Mitigation |
|---|---|
| Fix A changes limit handling, and the car may feel more tail-happy | Review the `simtest` corner output and handling-pad feel before merging; keep it behind a param flag for one release |
| CG height 0.80 m is an assumption and decides whether the fishhook rolls | Sweep it in the tests; an axle-lift measurement on a real car settles it |
| Hull positions are estimates | `sim.fitHull()` against the GLB; debug spheres in the rig inspector |
| Crush parameters are assumptions | Tune only against the frontal, pole and roof targets, which need checking against published crash data first |
| Kerb contact fires on pothole rims | 3 cm step and 0.5 m/s gates; `humptest` and the pothole test must not change |
| Physics differs by graphics level through hidden trees | Scripted crash tests use the crash pad, not scenery |
| The integrator change alters baseline digits | Fall back to switching it in only above 1 rad/s |
| The mirror pass costs more than estimated, because instanced trees are not culled | Measure first; halve the mirror far plane or skip trees in mirrors on Medium |
| Deformation hitch on the high-poly model | Amortise: one mesh per frame |

## 10. Sources

- 2010 Toyota 4Runner SSF 1.12, "No-tip": https://www.theautochannel.com/buyers-guides/Toyota/safety2.php?autoid=8371
- Hilux moose test, two-wheel lift, and Toyota's ESC and tyre-pressure changes: https://www.topspeed.com/trucks/truck-news/toyota-hilux-fails-sweden-s-moose-test-ar175017.html , https://www.caradvice.com.au/news/toyota-hilux-fails-swedish-moose-test-20161026-gsbqnl/ , https://www.news24.com/life/handling-fail-toyota-repairs-its-hilux-after-moose-test-saga-20170303
- NHTSA NCAP fishhook procedure, March 2013 (located but not readable; the parameters above are from memory): https://webarchive.library.unt.edu/web/20161101030520/http://www.safercar.gov/staticfiles/safercar/NCAP/NCAP_Fishhook_Test_March_2013.pdf
- NHTSA/VRTC presentation confirming the 720°/s handwheel rate: https://www.nhtsa.gov/sites/nhtsa.gov/files/forkenbrock_0.pdf
- Rollover deceleration literature (located but not readable; the 0.36–0.61 g band is from memory): https://www.jsheld.com/uploads/Development-of-a-Variable-Deceleration-Rate-Approach-to-Rollover-Crash.pdf , https://saemobilus.sae.org/papers/reconstruction-rollover-collisions-890857
