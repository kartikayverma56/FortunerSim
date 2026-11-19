# Fortuner Drive Lab (local)

A browser-based driving simulator of the **Toyota Fortuner 2.8 diesel AT 4×4**. It runs physics at 1 kHz, synthesises diesel engine sound, and includes an Indian test ground with IRC speed breakers, potholes, gravel, mud, sand and off-road obstacles.

## Run it

1. Copy the rigged model files from your Claude chat into `assets\`:
   - `Fortuner 2021 rig showroom web.glb` (desktop)
   - `Fortuner 2021 rig phone web.glb` (optional, used automatically on touch devices or with `?q=phone`)

   File names don't matter much: the app picks the GLB whose name contains `showroom` / `phone`, and ignores `…blender…` files.
2. Double-click **`start.bat`**, or run `npm install` once and then `npm run dev`.
3. Open http://127.0.0.1:5791/ and click **Start**. Press `G` until the selector shows **D**, then hold `W`.

Until a GLB is present, a stand-in SUV with the same rig layout is shown.

## Controls

Press `H` in the app for the full list.

| Key | Action |
|---|---|
| `W`/`↑` (`Shift` = half pedal), `S`/`↓`, `A` `D`, `Space` | Throttle, brake, steer, handbrake |
| `Enter` | Start / stop the engine (starter cranking is simulated) |
| `G` | Selector P → R → N → D |
| `R` | Toggle D ↔ R |
| `Z` / `X` | Manual down / up (M mode) |
| `1` `2` `3` | Transfer case: 2H / 4H / 4L. 4L needs the car stopped and in N. |
| `L` / `K` / `V` | Rear diff lock (4L) / DAC (4L) / VSC on-off |
| `C` | Cameras: chase, cockpit (drag to look), bonnet, wheel/suspension, orbit, trackside |
| `5` – `9` | Teleport: runway, Indian road, speed breakers, off-road, handling pad |
| `Backspace` | Recover / upright the car |
| `T` | Standard tests: 0–100, 80–0 braking, speed breaker at chosen speed |
| `,` / `.` | Left / right indicator (cancels itself once the wheel comes back after the turn) |
| `/` | Hazard lights |
| `N` (hold) | Horn |
| `F` | Telemetry: chart and wheel loads |
| `U` | HUD size: compact (default) → full → off |
| `I` | Rig inspector |
| `M` | Mute |
| `B` | Sound mode (synth / samples / hybrid) |
| `Q` | Graphics: Auto → Low → Medium → High (saved; the car model and anti-aliasing change on reload) |

Gamepad: RT/LT pedals, left stick steering, Y camera, X engine, LB/RB shift, B handbrake, D-pad left/right indicators, L3 horn.

## Graphics quality and speed (`src/quality.ts`)

- **Auto (default)** picks a level from the GPU: integrated graphics (Intel Iris Xe/UHD, AMD integrated) start at **Medium**, NVIDIA/Radeon RX at **High**, phones and software rendering at **Low**. If the frame rate stays under 40 fps for 3 s it steps down one level.
- Force a level with `?q=low|medium|high` (old `?q=phone` = low, `?q=showroom` = high) or press `Q`.

| Level | Car model | Resolution | Shadows | Trees |
|---|---|---|---|---|
| High | showroom (563 k tris), MSAA | up to 1.5× | soft, 2048 px, trees cast | all |
| Medium | phone (204 k tris), MSAA | 1× | 1024 px, car only | all |
| Low | phone, no MSAA | 0.8× | 1024 px, car only | half |

**Speed fixes (2026-11-18, measured on Intel Iris Xe at 1536×960):**
- The car's ~260 static meshes are merged per material at load (`mergeStatic` in `rig.ts`, 310 → 104 meshes). Only parts larger than 0.35 m radius cast shadows.
- Together these took frame submission from 10.3 ms to 2.6 ms and draw calls from 580 to 157: Medium went from ~50 to a steady 60 fps.
- Physics now catches up to 0.1 s per frame, so a slow frame no longer turns into slow motion above 10 fps.

## Realism pass (2026-11-20)

Items 1–4 of `research/REALISM_REVIEW.md`. None of them adds a render pass. The physics is unchanged (`tools/simtest.ts`, `humptest.ts` and `feeltest.ts` give identical output).

- **Car materials** (`tuneMaterial` / `materialPass` in `src/vehicle/rig.ts`): plastics, leather and rubber set to metalness 0 (the export had them at 40–90 % metal); matte tyres; grey-metallic paint with a clear coat; tinted glass at 50 % opacity outside, near-clear from the driver's seat (no `transmission`); door mirrors as a tinted, slightly soft mirror (no mirror render); a dark interior mirror; the headliner no longer glows.
- **Reflections with a ground** (`src/world/carLighting.ts`): the PMREM environment is rebuilt from the sky plus a grass disc, a road strip and a tree line, so the lower half of reflections is no longer bright haze. The hemisphere fill drops from 0.55 to 0.4. Built once at load.
- **Shadows:** the sun's shadow box follows the car at ±12 m (±16 m on High) instead of ±30 m, i.e. 2.3 cm per texel instead of 5.9, snapped to whole texels so edges do not crawl, with a 60 m depth range so the bias is 2.4 cm instead of 12 cm. A soft contact shadow under the body and at each tyre (`src/vehicle/contactShadow.ts`, 2 draw calls) stops the car from floating.
- **Lamps and plates:** brake lamps and the high-mount stop lamp light with the brake pedal (and DAC), reverse lamps in R, indicators and hazards blink at 90 per minute with a relay tick, and the indicator cancels itself after the turn. Indian HSRP plates front and rear (`src/vehicle/plate.ts`; white plate, black characters, blue IND strip; made-up number "MH 12 AB 1234") replace the model's "NEW FORTUNER" decals.
- **Horn** on `N`: a synthesised twin-tone disc horn (≈415 + 500 Hz) through `VehicleAudio`'s new `fxBus` (follows mute and volume), muffled in the cockpit (`src/vehicle/signals.ts`).
- **Camera feel** (`src/cameras.ts`): in the cockpit the head lags the body under acceleration and braking (≈3 cm at 0.8 g), bobs on the seat from the seat acceleration, glances into turns, and the eyes keep about half of quick roll and pitch level. A short 11–13 Hz frame shake follows big suspension impacts (chase, cockpit and bonnet). The chase camera follows on a spring instead of a lerp. The field of view widens slightly with speed (+6° chase, +4° cockpit/bonnet).
- **Smaller HUD:** the dial cluster sits small at the bottom right so it no longer covers the car; the chart and wheel panels show with `F`; `U` switches compact / full (the old layout) / off.
- **Fewer car draw calls** (`rig.ts`): every shadow-casting car part is folded into one position-only proxy that is drawn only in the shadow pass (146 casters → 1 draw), the wheels, steering wheel and needles are merged per material inside themselves, unused UV/colour attributes are dropped so more parts merge, and double-sided transparent parts draw in one pass. Car draws went from ~167 (121 main + 46 shadow) to ~83. Measured on Medium (Iris Xe, 1536×826) driving at teleports 5–9: 57.5–59.2 fps (vsync-capped, median frame 16.7–17.1 ms), GPU 12–13.6 ms per frame, 233–328 draw calls in total, of which ~240 are world meshes (terrain pieces and boards).
- **Terrain LOD:** fine ground meshes are cut into ~60–100 m pieces (`src/world/terrainLod.ts`). Each piece shows its original grid within 100 m of the camera (250 m for the open field) and a coarser twin beyond, built from a subset of the same height samples (error under ~1.5 px at the switch distance). Skirts hide seams. Physics still reads `heightAt()`/`surfaceAt()` directly, so driving is unaffected. Ground triangles per frame drop from ~2.3 M to ~0.3–0.4 M.

## Driving feel (India)

- **Right-hand drive:** the cockpit camera sits behind the RHD wheel. The Indian road strip, speed-breaker tests and the runway spawn use the **left lane**.
- **Pedal map (drive-by-wire):**
  - The pedal requests a share of full-load torque, with a gentle tip-in curve (pedal^0.8) added on top of the idle governor. Turbo boost only caps that request.
  - Full throttle is unchanged (0–100 still 10.7 s), but part throttle now pulls: 15 % pedal is about 11 km/h after 6 s, 30 % about 35 km/h.
  - Creep in D is 7.6 km/h.
- **Keyboard pedals press in progressively:**
  - W reaches 50 % in 0.45 s and 100 % 0.9 s later; S reaches 50 % in 0.25 s and 100 % 0.6 s later.
  - `Shift+W` holds 35 % for gentle city driving.
- **Keyboard steering:**
  - Hand-over-hand at parking speed: full lock in about 1.1 s. Inputs get smaller and slower at highway speed.
  - Caster self-centring: the wheel barely returns at a standstill and returns quickly once above about 25 km/h.
- `tools/feeltest.ts` prints creep, part-throttle response and the steering lock.

## What is simulated (`src/physics/vehicle.ts`)

- **Body and suspension:** a 6-DOF sprung body plus 4 unsprung vertical DOFs.
  - Springs and dampers have a bump/rebound split and digressive valving.
  - Progressive bump stops, rebound stops and anti-roll bars.
  - Lateral forces act at the roll-centre height and longitudinal forces at anti-dive/anti-squat heights.
- **Tyres:** transient-slip model (relaxation length) with Magic-Formula combined slip, load sensitivity, and per-surface μ and rolling resistance.
  - **Rigid-ring contact on the true road profile**, so speed breakers, potholes, joints and rocks push the wheel the way a real tyre feels them.
- **Engine and gearbox:** the 1GD-FTV torque curve, turbo spool lag, motoring friction and an idle governor.
  - Torque converter (K-factor/torque ratio) with lock-up clutch.
  - 6AT shift schedule with kickdown and manual mode.
- **Drivetrain:** part-time transfer case with **driveline wind-up in 4H/4L**, open diffs and an electronic rear locker.
- **Braking and driver aids:** brakes with **ABS**, **A-TRC** (brake-based traction control), **VSC** (yaw-rate), **HAC** and **DAC**.
- **Body contact and aero:** underbody contact (bumpers, mid-wheelbase, front skid plate, rear diff on the live axle) with scrape sound, plus aero drag.

### Calibration against Indian road tests (2026-11-18)

| Test | Simulated | Measured (research/fortuner_params.json) |
|---|---|---|
| 0–100 km/h | **10.7 s** | 9.79 – 11.2 s (Autocar India 9.96, ZigWheels 10.58, Autocar 2021 11.2, SA 9.79) |
| 100–0 km/h | **44.7 m** | 45.23 m (CarDekho, pre-facelift AT) |
| 80–0 km/h (in-app test) | **28.6 m** | 28.08 m (CarDekho, pre-facelift AT) |
| Brake dive | 3.7° | not published |
| Roll gradient | ≈4°/g | not published |
| Speed breaker SB-01 (IRC R 11 m) | loaded at 20, lifts at 40 km/h | √(gR) predicts 37 km/h |

To re-run the checks, rebuild with `./node_modules/.bin/esbuild tools/simtest.ts --bundle --platform=node --format=esm --outfile=tools/.simtest.mjs`, then run `node tools/.simtest.mjs`. `tools/humptest.ts` works the same way.

**Honesty note:** Toyota does not publish CG height, inertia, spring/damper rates, tyre model or most driveline details. `src/physics/params.ts` tags every value as `official` / `independent` / `estimate` / `assumption`. Treat the assumptions as starting points to calibrate against real tests (see the TharSim research Doc H for the test plan). The research file `research/fortuner_params.json` overrides matching keys at start-up.

## Sound (`src/audio/`)

- **Synth (default):** an AudioWorklet in-line-4 diesel with:
  - firing pulses at rpm/30 Hz, pilot-injection clatter and cylinder imbalance;
  - exhaust and intake paths and turbo whistle;
  - gear and transfer whine, starter;
  - tyre noise per surface, squeal, wind, suspension thumps, bump-stop clunks, underbody scrape and ABS buzz;
  - a cabin filter in cockpit view.
- **Recorded loops (most realistic):** put CC0/CC-BY steady-rpm loops in `public/audio/engine/` with a `manifest.json` (format in `public/audio/engine/README.md`). They are crossfaded by rpm × load × interior/exterior. Candidate free recordings are listed in `research/SOUNDS.md`.
- **Free recorded set (2026-11-18):** 7 off-load exterior loops from 775 to 4,317 rpm, cut from free Freesound diesel recordings: Renault Master 2.3 dCi idle and top end, Audi 2.0 TDI, Peugeot 1.5 BlueHDi holds.
  - No free recording of the 1GD-FTV exists.
  - Sources and licences: `public/audio/engine/CREDITS.md`.
  - Rebuild with `python -I tools/audio/makeloops.py tools/audio/loops_free.json`. Inspect a recording's rpm with `tools/audio/rpmtrack.py`.
  - The manifest's `tuning` sets a ±40 % pitch range, because the free holds are far apart.
  - Hybrid mode is the default when the loops load. The synth adds turbo, whine, starter and road; press `B` to compare synth, samples and hybrid.
- **Tuning by ear:** open http://127.0.0.1:5791/audio-test.html for the audio bench (sliders, rev sweep, auto 0–100, live tuning, "Copy tuning JSON").

## The Fortuner model (installed 2026-11-18)

- **Source:** ["Toyota Fortuner 2021"](https://sketchfab.com/3d-models/toyota-fortuner-2021-a70b997f11b7482e9affbf318a508f85) by [Asadawut.Kaewma](https://sketchfab.com/Asadawut.Kaewma), licensed [CC BY 4.0](http://creativecommons.org/licenses/by/4.0/). Modified: unused UV sets removed, simplified, meshopt-compressed and scaled ×1.019. The original 143 MB / 1.83 M-triangle file is not in the repo; download it from Sketchfab into `assets_src/` to re-process. Toyota names, badges and design are trademarks of Toyota and are not covered by this licence.
- **Processing:** gltf-transform. Every node is kept, so the wheels, steering wheel and needles stay separate.
  1. `prune --keep-attributes false` drops 9 unused UV sets: 143 → 66 MB.
  2. `dedup`, then `weld`.
  3. `simplify`, then `meshopt`:
     - **Showroom:** `--ratio 0.3 --error 0.0006` gives 563 k triangles, 15.6 MB (`assets/fortuner_2021_showroom.glb`).
     - **Phone:** `--ratio 0.1 --error 0.002` gives 204 k triangles, 12.6 MB (`assets/fortuner_2021_phone.glb`, used with `?q=phone`).
- **Texture step skipped:** WebP/resize fails on one texture's colour space (a libvips bug), so textures are left as-is.
- **Rig mapping:** `assets/rigmap.json` maps the parts below.
  - `WHEEL_LF/RF/LR/RR` → wheels (spin, steer, suspension travel).
  - `STEER_HR` → steering wheel.
  - `ARROW_RPM` / `ARROW_SPEED` → the real dashboard needles, checked against the dial at idle and at 4600 rpm.
- **Scale and fit:** the model is scaled ×1.019 so its wheelbase is exactly 2745 mm, and the body is lowered so the tyres touch the road.
- **Known model limits:**
  - The interior shows a manual gear lever, though the sim is the AT.
  - There is no suspension or underbody geometry. The rear axle has no separate node, so each rear wheel moves on its own.
  - The doors and tailgate are static.

## Model rig

- `I` opens the rig inspector, which shows which nodes were mapped to wheels, steering, rear axle, steering wheel and needles.
- If a mapping is wrong, add `assets/rigmap.json`, for example:
  ```json
  { "hub_FL": "Hub_FL", "steer_FL": "Steer_axis_FL", "rear_axle": "Rear_axle", "steering_wheel": "SteeringWheel", "needleSign": -1, "cockpitEye": [-0.38, 0.78, -0.12] }
  ```
- **Credit:** the Fortuner mesh is "Toyota Fortuner 2021" by Asadawut.Kaewma (Sketchfab, CC BY 4.0). CC BY needs visible credit, which the start screen shows when the GLB carries it.
- The licence covers the modeller's rights only, not Toyota's trademarks or design. Keep this local or get clearance before publishing.

## Layout

```
src/physics/   params.ts (tagged parameters), vehicle.ts (dynamics)
src/world/     terrain.ts (analytic ground + IRC humps), worldMesh.ts (meshes, sky, scenery), carLighting.ts (reflection env, sun-shadow box)
src/vehicle/   rig.ts (GLB loader, rig mapping, materials, lamps, stand-in), plate.ts (HSRP plate), contactShadow.ts, signals.ts (indicators, horn)
src/audio/     VehicleAudio.ts, engine-worklet.js, SampleLayer.ts, tuning.ts
src/ui/        hud.ts, tests.ts
research/      fortuner_params.json, SOUNDS.md, SOURCES.md
```
