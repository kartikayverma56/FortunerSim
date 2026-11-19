# PLAN: Indian roads (road and world side)

Planned by a Fable agent on 2026-11-18. **Status: approved 2026-11-18.** User decisions: one closed loop; ghat 60 m with 5 hairpins; simple low-poly traffic and cows in v1; yes, re-mesh the existing Indian strip and off-road park onto the chunk system (physics unchanged). Defaults taken for the rest: assumed numbers are tunable [A] values; keys 4 / 0 / N; generic India look.

Scope: road geometry, surfaces, world layout, ambient traffic and its sounds. Steering feel, pedals and right-hand drive are done separately.
Tags: **[S: doc/id]** = sourced from `D:\TharSim\research`; **[A]** = assumption to tune; **[E]** = estimate from reading the code, not measured.

## 0. Findings in the current code that shape the plan

- `heightAt` is called about 75 times per physics step **[E]**: 4 wheels × 9 ring samples, up to 4 × 4 for flat-contact normals, about 22 belly points, 1 diff (`src/physics/vehicle.ts` lines 332–466).
- `baseHeight` computes 6 noise octaves on every call, even on pavement where its weight is 0. An early-out is a free saving.
- Features are axis-aligned boxes in a 20 m grid (`terrain.ts`). That cannot express curved roads; the paved-area list in `baseHeight` and the holes in `worldMesh.ts` are hard-coded.
- `buildGrid` is a tensor grid in world x/z. Current triangle use **[E]**: Indian strip about 0.9 M (cement zone at 0.03 m steps and pothole zone at 0.1 m dominate), off-road park about 0.93 M, base terrain about 0.28 M. Measured 2026-11-18: about 2.4 M terrain triangles in 48 meshes.
- Each sign board is 2 draw calls and there are about 65 boards **[E]**.
- `TestRunner` assumes heading +Z and holds a fixed x. `Vehicle.reset(x, z, heading)` already accepts a heading.
- `VehicleAudio` exposes `audioContext` and `analyser`; `master` is private; there is no horn or one-shot.
- Free keys: Digit4, Digit0, KeyN, KeyE, KeyJ, KeyO, KeyP, KeyU, KeyY (KeyQ is now graphics quality).

## 1. What a driver feels, ranked by felt realism per effort

| # | Feature | Why it reads as Indian | Numbers | Effort |
|---|---|---|---|---|
| 1 | IRI roughness by road class | Felt every second; separates NH from city from village | See table below | Medium (once, reused everywhere) |
| 2 | Non-standard humps in context: unpainted, in pairs at village entry, rumble sets before junctions | The defining Indian obstacle | Bhubaneswar chord 0.98–2.25 m (mean 1.88), h 0.06–0.10 m; Hyderabad chord 1.93–3.02 m, h 0.06–0.115 m; cars cross at 10–19 km/h **[S: C-024, C-025]**. Rumble: 6 bars, 20–30 mm × 200–300 mm at 1 m **[S: C-001]**. No humps on NH; hump 8–12 m from NH edge on minor approaches **[S: C-020, C-004]** | Low (profile builders exist) |
| 3 | Camber, earth shoulder, tarmac edge drop | Constant steering pull; dropping two wheels off for an oncoming truck | Crossfall 2.5 % bituminous SH, 3–3.5 % thin bituminous rural, 4–5 % earth; shoulder = pavement + 0.5 %, min 3–4 % **[S: C-007/008/009]**. Edge drop 30–100 mm over a 0.2 m ramp **[A; doc C says "not found"]** | Low |
| 4 | Pothole clusters | Potholes come in groups in wheel paths and at low spots | Depth classes < 25 / 25–50 / > 50 mm **[S: C-014/C-015]**; diameter 0.3–1.2 m and cluster density **[A; gap H6.5]** | Low–medium |
| 5 | Patch repairs and utility trench cuts | Thump-thump of patched city streets | Patch ±10–25 mm, trench 0.5–1 m wide, sunk 20–40 mm **[A]** | Low |
| 6 | Bridge approach bump, flyover expansion joints | Rhythmic joints on flyovers | Joint gap 20–25 mm **[S: C-011/C-012]**; step ±5–10 mm, span 25 m **[A]** | Low |
| 7 | Concrete street joints with faulting | White-topped city and village streets | Spacing 2.5–4 m, groove 3–5 mm, fault 4–12 mm **[S: C-012/C-013]** | Exists; reuse |
| 8 | Manhole covers, raised or sunk | City streets | 0.6 m dia, ±20–40 mm **[A; doc C "not found"]** | Low |
| 9 | Gravel spill on tarmac at bends and edges | Sudden grip loss in the ghat | μ 0.62 (existing `gravel`) | Very low |
| 10 | Waterlogged dips | Monsoon | `wet` μ 0.62 plus extra rolling resistance **[A]**; no aquaplaning **[gap C-10]** | Low physics, medium visual |
| 11 | Rail level crossing | Common, harsh | Rail steps ±30 mm **[A]** | Medium, later |
| – | Cattle grids | Not a feature of Indian public roads; **excluded** (planner's judgement, not from the docs) | – | – |

Roughness targets:

| Class | Target IRI (m/km) | Basis |
|---|---|---|
| NH 4-lane | 2.2 typical, with real bad patches | NSV medians 2.10 (NH-03) and 2.29 (NH-248A); p90 5.83, p99 16.09 on NH-248A **[S: C-030]**; new-build limit 2.81 **[S: C-004]** |
| State highway | 3.5 | IRC poor limit 3.30 **[S: C-006]**; app-measured 4.25 **[S: C-029, low confidence]** |
| District road | 4.5 | IRC limits 3.05–4.98 **[S: C-006]** |
| City street | 5.5 | 5.6 app-measured Bengaluru **[S: C-029]** |
| Village paved | 5.0 | Limits 4.27–4.98 **[S: C-006]** |
| Village kachcha | 8–12 | **[A]**; no gravel IRI found (gap C-8); ISO class D–E boundary 9.96 **[S: C-EE-004, low]** |

Decision: IRI is **computed and checked**, not inferred from an ISO class. The ISO-to-IRI mapping is low confidence **[S: C-033]**.

## 2. World layout

Keep all existing zones. Add a loop east of the off-road park, inside the existing ±1400 m base terrain.

| Leg | Length | Cross-section | Character |
|---|---|---|---|
| Link | 0.3 km | 7 m | Extend Connector2 east along z = −14 from x = 110 to x = 420 |
| A. NH 4-lane divided | 1.6 km, x ≈ 420, z 0 → 1600, one 800 m radius bend | 2 × 7 m + 4.5 m median **[A]** | IRI replayed from 16 consecutive NSV segments; one 200 m flyover with 3.3 % ramps **[S: ruling grade, C-007]** and joints; rumble set before the town; no humps |
| B. Town street | 0.6 km, turning east | 7 m undivided, kerbs, parked vehicles | One T-junction and one 4-way; humps, manholes, trench cuts, 150 m of jointed concrete; IRI 5.5 |
| C. District road | 1.5 km, heading south-east | 5.5 m **[A]** + 1 m earth shoulders | IRI 4.5, edge breaks and drop, pothole clusters, two culvert bumps, crossfall 3 % |
| D. Ghat | 1.8 km over a saddle: 1.0 km up, 0.8 km down | 5.5–7 m, widened at hairpins **[A]** | Analytic hill about 60 m high, 400 m radius, centred near (1000, 600). Grade 5 % ruling, 6 % limiting; hairpins inner radius 14 m, grade ≤ 2.5 %, superelevation up to 10 % **[S: C-007, C-009]**; 3 hairpins up, 2 down; gravel spill; "SOUND HORN" boards |
| E. Village kachcha road | 0.8 km, west to the off-road park east edge (x = 300) | 3.75 m single lane **[S: C-RT13, 3.0–3.75 m]** | Earth and gravel, ruts, one muddy dip, camber 4–5 % **[S: C-009]**; a short 200 m paved village stretch with a hump pair |

Total about 6.5 km, a 7–9 minute lap. Rise of 60 m in 1 km respects the 100 m per 2 km limit **[S: C-007]**.

## 3. Traffic and ambience

**v1 (cheap):**
- Up to 24 kinematic agents within ±400 m of the player (12 on Low), pooled and respawned out of view. Each follows a road path at a lane offset, keeping left.
- Speed rule: class cruise speed; slow to 10–19 km/h at humps **[S: C-024/025]**; follow the vehicle ahead, including the player; no overtaking.
- Types: truck, bus, car, auto-rickshaw, motorcycle, tractor-trolley. Procedural boxes under 300 triangles each, one `InstancedMesh` per type with instance colour. No wheel spin, no shadows on Low/Medium.
- Scripted Indian moments that cost nothing: an oncoming truck straddling the centre on the district road (forces the edge drop), a bus stopped half on the carriageway in town, two-wheelers hugging the left edge, a tractor to follow on the village road.
- Static: cows sitting on the road (3–4 fixed spots), parked vehicles, handcarts, roadside shop boxes, milestones.
- Sound: player horn on N; traffic honks when blocked for more than 2 s and before hairpins. A pool of 4 positional voices, synthesised (two detuned oscillators per horn type) **[A: pitches]**.
- No collision response: agents brake for the player. Overlap shows a toast only.

**Later:** contact forces (needs an external-force hook in `vehicle.ts`), overtaking, wrong-side riders, wandering animals, junction right-of-way, GLB models, musical truck horns from samples, night lighting.

**Audio hook:** new `src/audio/AmbientAudio.ts` built on `audio.audioContext`. Add one getter to `VehicleAudio` returning a gain node that feeds `master`, so the existing mute and volume apply. If that getter is refused, mirror mute in the `KeyM` handler in `main.ts`. Nothing else in `VehicleAudio` changes.

## 4. Implementation approach

**4.1 Road paths (`src/world/roads.ts`, new, DOM-free).**
- A road is a list of straight and circular-arc segments with a vertical profile y(s), crossfall/superelevation(s), width(s) and class(s).
- `project(x, z) → (s, d)` is closed-form per segment. Segments register their bounding boxes in the existing 20 m grid. A "last segment hit" hint makes the 9 ring samples of one wheel nearly free.
- Phase 1 uses one straight along +Z, where (s, d) = (z − z0, x − xc), so existing tests work unchanged.

**4.2 Height composition in `heightAt`.**
- Corridor blend: inside the carriageway and shoulder the height is the road's own surface; beyond it, blend to terrain over 10–15 m. With several segments in range (hairpins), use normalised weights so the result is continuous.
- Skip `baseHeight` when the road weight is 1. Replace the hard-coded paved list with the same corridor mechanism.
- Road surface = y(s) + crown/superelevation + roughness + features.

**4.3 Roughness.**
- At load, synthesise one unit-IRI profile table per class from the ISO 8608 spectrum form **[S: C-032 Eq 9]**, 0.05 m step, wavelengths 0.3–50 m. About 1 MB for the whole loop.
- h(s, d) = A(s) · [P1(s) + (d / halfWidth) · P2(s)], which gives separate left and right wheel-path content and some roll input. A(s) is the per-100 m IRI target.
- The NH leg takes A(s) from a 16-row extract of `C_nsv_iri_100m_segments.csv` copied into `src/data/`.
- Lookup is linear interpolation: no trig in the physics loop.

**4.4 Discrete features (`src/world/roadFeatures.ts`, new).**
- Humps, rumble sets, joints, trench cuts and culvert bumps are 1-D in s: reuse `circHump` and `trapHump`, binary search on sorted s.
- Potholes, patches and manholes use a spatial hash in (s, d) like the existing rock garden: 3 × 3 cells per query. Clusters come from a low-frequency mask, biased to wheel paths and low spots.
- Edge: 0.2 m ramp down to the shoulder, with scalloped edge breaks from 1-D noise on the edge position.
- `surfaceAt`: road class surface, then patches (wet, gravel, mud) by the existing smallest-area rule. No new audio surface types; earth shoulder maps to `grass`.

**4.5 Meshing (`src/world/roadMesh.ts`, new, DOM-free geometry; materials stay in `worldMesh.ts`).**
- 100 m chunks along s. Vertices are placed in (s, d), mapped to world, and their height read from `heightAt`. That keeps mesh and physics identical at every vertex.
- Sample lines are the base step merged with feature breaklines (hump ends, pothole rims, tarmac edge), following the existing `mergeRanges` pattern. Rule: mesh step ≤ a quarter of the feature length.
- Near mesh: 0.25 m × 0.25 m on the carriageway, about 25k triangles per chunk, built lazily (at most one chunk per frame) when within 120 m of the car and disposed beyond 150 m. At most 3–4 exist at once.
- Far mesh: one merged mesh per leg at 4 m steps, about 25k triangles for the whole loop.
- Cracks: each near chunk carries a 0.3 m vertical curtain at both ends; the far mesh has per-chunk index groups hidden while the near chunk is shown.
- Selection is a manual window along s, not `THREE.LOD`, because `THREE.LOD` cannot build lazily.
- Base terrain: sink base vertices 0.5 m inside road corridors and make the road skirt at least 12 m wide, so the 8 m base grid never pokes through. No stitching.
- Materials: one road material with vertex colours (patches dark, worn grey, dusty edges) and one verge material: at most 2 draws per chunk. Markings and faded centre dashes go in the existing instanced dash mesh with random gaps.

## 5. Performance budget and verification

| Item | Budget | How to check |
|---|---|---|
| Physics | < 100 µs per step total (measured 78–82 µs today); roads add ≤ 10 µs | Extend `tools/bench.ts` to run at 4 spots (runway, district road, hairpin, pothole cluster). Bundle with esbuild, run in node |
| `heightAt` | ≤ 150 ns average on road | Micro-benchmark in the same tool |
| Triangles in view | New roads ≤ 150k; whole scene under 1 M after phase 2 | `renderer.info.render.triangles` in the HUD |
| Draw calls | New roads and traffic ≤ 45; total < 250 (157 today at Medium) | `renderer.info.render.calls` in the HUD |
| Frame rate | About 60 fps on Iris Xe at Medium | Drive the full loop with the HUD counter; log minimum fps per leg |
| Chunk build hitch | < 8 ms per chunk | `performance.now()` around the build; move to idle time if over |
| Mesh vs physics | < 10 mm error on carriageway | New `tools/meshcheck.ts`: random points on near-mesh triangles vs `heightAt` |

## 6. Phases

**Phase 0: baseline and free wins (half a day).**
- Add triangle and draw counts to the HUD; record fps, calls, triangles and µs per step at each teleport.
- `baseHeight` early-out. Merge sign boards into one atlas-instanced mesh if draw calls are near the limit.
- Test: `simtest`, `humptest` and `feeltest` outputs unchanged.

**Phase 1: one straight road with everything a driver feels (smallest valuable slice).**
- Link road plus a straight 1.5 km road at x = 420 along +Z: 500 m state highway (IRI 3.5), 500 m district road (IRI 4.5, pothole clusters, edge drop), 500 m village entry (unpainted hump pair, rumble set, patches, manholes, trench cuts).
- Includes road paths (straight only), roughness tables, features, chunked near/far meshing.
- Teleport on Digit4.
- Files: `terrain.ts`, `worldMesh.ts`, new `roads.ts`, `roadFeatures.ts`, `roadMesh.ts`, `src/data/` extract, `main.ts`, `ui/tests.ts`, `ui/hud.ts`, `index.html` help text, tools.
- Tests:
  - `tools/roadtest.ts`: quarter-car IRI filter over each class table; pass if within ±10 % of target.
  - `ui/tests.ts`: give `humps` entries a lane x so contextual humps run in the existing hump test; add `pothole` (left wheel path through a reference pothole at 20/40/60 km/h: peak seat g, rim contact, bump stop, airborne time) and `ride` (constant 40/60/80 km/h over 500 m: RMS seat acceleration, bump-stop count).
  - Extend `tools/humptest.ts`; add `tools/ridetest.ts`. Expect RMS seat acceleration to rise monotonically with class IRI.
  - Bench, mesh check, and a drive in wheel camera to confirm tyres sit on the surface.

**Phase 2: curves, NH, town, and paying back triangles.**
- Arc segments and the path-following autopilot (shared by tests and traffic). NH leg with flyover and NSV replay; town street with two junctions.
- Move the existing Indian strip and off-road park onto the chunk system (physics unchanged).
- Tests: projection unit test (round trip (s, d) → world → (s, d)); height continuity scan across segment joins; ride test on NH; old hump results identical before and after the re-mesh.

**Phase 3: ghat and village road.**
- Analytic hill, hairpins, superelevation, corridor blending with multiple legs, kachcha road, loop closure at the off-road park.
- Tests: grade scan (no section over 6 %, hairpins ≤ 2.5 %); a node climb test in D and in 4L; height continuity scan between hairpin legs; fps on the hill, where the most terrain is in view.

**Phase 4: traffic, horn, ambience.**
- Agents, instanced meshes, `AmbientAudio`, static props and cows.
- Tests: agent count and draw calls in HUD; a 10-minute soak for pool leaks; fps with 24 agents.

**Phase 5: polish.**
- Water planes in dips, level crossing, faded paint, signs, optional contact forces.

## 7. Risks

| Risk | Mitigation |
|---|---|
| Lateral edge drop is not really modelled: the tyre ring samples only along the wheel heading | Use a 0.2 m ramp so the surface normal tilts and gives a tug; say so in the test note |
| Hairpin legs 30–40 m apart at different heights produce terrain steps | Normalised multi-segment blend; keep blend width under half the leg spacing; continuity scan in phase 3 |
| Lazy chunk builds cause hitches on the laptop | One chunk per frame, look-ahead by speed, fall back to a 0.35 m near mesh on Low |
| Linear table interpolation adds force noise at 1 kHz | Table step 0.05 m; check wheel load spectrum in the ride test; switch to cubic if visible |
| Assumed dimensions (edge drop, potholes, manholes, kachcha IRI) feel wrong | Keep them in one parameter block with [A] tags; tune by driving |
| Phase 2 re-mesh changes old test results | Physics functions untouched; compare `humptest` output before and after |

## 8. Open questions for the user

1. Loop or network? (assumed: one closed loop with two town junctions; a network is roughly twice the work of phase 2)
2. Ghat scale: 60 m climb with 5 hairpins, or a longer hill road?
3. Collisions with traffic in v2? (v1 has none: vehicles yield and honk)
4. Procedural low-poly boxes for vehicles and cows in v1, or real GLB models?
5. May phase 2 re-mesh the existing Indian strip and off-road park (same physics, new LOD meshes)?
6. Accept the assumed numbers (edge drop 30–100 mm, potholes 0.3–1.2 m, manholes ±20–40 mm, kachcha IRI 8–12) as tunable, or are there measurements?
7. Keys: 4 = loop teleport, 0 = cycle waypoints, N = horn?
8. Region flavour: generic India, or a specific look (Western Ghats, Himachal, Deccan town)?
