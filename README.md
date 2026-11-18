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
| `F` | Telemetry chart |
| `I` | Rig inspector |
| `M` | Mute |
| `B` | Sound mode (synth / samples / hybrid) |

Gamepad: RT/LT pedals, left stick steering, Y camera, X engine, LB/RB shift, B handbrake.

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
src/world/     terrain.ts (analytic ground + IRC humps), worldMesh.ts (meshes, sky, scenery)
src/vehicle/   rig.ts (GLB loader, rig mapping, stand-in)
src/audio/     VehicleAudio.ts, engine-worklet.js, SampleLayer.ts, tuning.ts
src/ui/        hud.ts, tests.ts
research/      fortuner_params.json, SOUNDS.md, SOURCES.md
```
