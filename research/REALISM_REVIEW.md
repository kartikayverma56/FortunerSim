# Realism review: look, drive, sound (2026-11-20)

Read-only review of the code plus one live session on the target laptop (Intel Iris Xe, Medium, 1536×770 window, port 5792). No code was changed. Roads and world layout are out of scope, as instructed.

Tags used below: **[measured]** = measured in that session; **[code]** = read in the source; **[sourced]** = fetched web page; **[snippet]** = seen in a search result only; **[assumption]** = my estimate, verify before relying on it.

## 0. What the measurements say about the GPU budget

| Measurement [measured] | Result | Meaning |
|---|---|---|
| Medium, chase cam | 60 fps, ~310–350 draw calls incl. shadow pass, 2.6–2.7 M triangles per frame | at the cap |
| Triangles by owner | terrain meshes 2.3 M, car 232 k, trees 62 k | terrain is 90 % of the load |
| Rendering the scene 2× / 3× / 4× per frame | 43 / 30 / 23 fps | one full scene render ≈ 11 ms, so headroom is about 5 ms |
| Same with the sun shadow off (4×) | 23 → 24.7 fps | the shadow pass costs only ≈ 1 ms |
| Pixel ratio 1.0 → 1.25 (+56 % pixels), 2× render | 43.2 → 40.9 fps | ≈ +0.6 ms: the frame is vertex-bound, not pixel-bound |

Each figure is one 2.5 s run, so treat them as ±10 %.

Consequences:
- Anything that draws the scene a second time (glass `transmission`, mirrors, planar reflections) costs about 11 ms and does not fit.
- Per-pixel upgrades on existing surfaces (normal maps, better materials, native resolution) are cheap.
- The biggest lever is the 2.3 M terrain triangles. The largest fine meshes are the Indian-road pothole/broken zones (300 k each) and nine off-road strips (103 k each), and they are drawn at full density even 1 km away.

## 1. Top 10 changes, ranked by realism per effort

| # | Change | Effort | GPU/CPU cost | Level | Files |
|---|---|---|---|---|---|
| 1 | Car material pass + a ground in the reflection environment | S | 0 ms | all | `src/vehicle/rig.ts` `setupModel`, `src/world/worldMesh.ts` (env) |
| 2 | Contact shadow under the car + tighter sun shadow | S | ≈ 0 ms (1–5 draw calls) | all | `worldMesh.ts` `updateShadow`, `rig.ts` |
| 3 | Working brake/reverse/indicator lamps, Indian number plate, horn and indicator tick | S–M | 0 ms | all | `rig.ts`, `main.ts`, `src/audio/` |
| 4 | Camera feel: head motion from g-forces, seat vibration, speed FOV, less HUD | S | 0 ms | all | `src/cameras.ts`, `src/ui/hud.ts` |
| 5 | Terrain distance LOD (same roads, coarser far meshes) | M | saves an estimated 3–6 ms [assumption] | all | `worldMesh.ts` `buildGrid` / `mesh` |
| 6 | CC0 ground textures with normal maps, macro variation, wear tint | M | < 1 ms on Medium [assumption]; ~5 MB download | Medium/High; Low colour only | `worldMesh.ts` `TEX`, `makeMats` |
| 7 | Sound: stereo, synthetic cabin/outdoor reverb, shift thunk, trackside Doppler | M | negligible (native nodes) | all | `src/audio/VehicleAudio.ts`, `engine-worklet.js` |
| 8 | Driving feel: AT kickdown delay and skip-shifts, shift jerk, aligning-torque steering return, gamepad rumble | M | negligible | all | `src/physics/vehicle.ts`, `params.ts`, `src/input.ts` |
| 9 | Dust, tyre smoke, skid marks | M | 0.3–1 ms [assumption] | Medium reduced, High full, Low marks only | new `src/world/effects.ts`, `main.ts` |
| 10 | Model geometry: re-decimate so panels stay smooth, AT selector, code-built axle/underbody | M–L | 0 to +10 k triangles | all | `tools/` gltf-transform step, `rig.ts` |

Do 1–4 first: about two days of work, zero frame cost, and they fix the things that most make it look like a game. Do 5 before any visual item that adds load.

### Details and how to verify

**1. Car materials and reflections.** Found in the loaded model [measured]: 40 materials, none with a normal map.
- Tyres are `metalness 0.55, roughness 0.36`, so they look like plastic. Set 0 / 0.9.
- `windows_glass` is `metalness 1, opacity 0.84`, an opaque mirror. Use metalness 0, roughness 0.05, opacity ~0.35, dark green-grey tint, `depthWrite false`. Do not use `transmission`.
- `chrome_only` (all three mirrors) is a perfect mirror of a featureless sky, so the mirrors render as blank white panels. Interim fix: darker tint and roughness 0.15.
- Almost every plastic and leather has metalness 0.4–0.8 (an export artefact). The headliner (`plastic_egg`) glows white in the cockpit. Set non-metals to metalness 0 and give interior materials `envMapIntensity ≈ 0.3`.
- Paint is `#b0b0b0, metalness 0.84`, which reads as flat white. Pick a real colour, metalness 0.2–0.5, clearcoat 1, clearcoat roughness 0.03, and a 256 px canvas-noise normal map at `normalScale 0.15` for flakes. Clearcoat is already paid for.
- The PMREM environment contains only `Sky`, so the lower half of every reflection is bright haze. Add a ground-coloured disc and a few dark blocks to `envScene` before `pmrem.fromScene`. Then lower `HemisphereLight` (0.55 double-counts the environment) and try `NeutralToneMapping` or `AgXToneMapping` in place of ACES at exposure ~1.0.
- Later option: a Poly Haven CC0 1k HDRI through `RGBELoader` (already in three's examples, no install) as the environment only. Per-frame cost is zero, download ~1.5 MB. Align `sunDir` to the HDRI sun.
- Verify: orbit-camera screenshots before/after; `renderer.info` unchanged.

**2. Shadows.** The sun shadow covers 60 m on 1024 px (5.9 cm per texel) with hard PCF, so the shadow is a faint blur and the car floats [measured, screenshot].
- Shrink the ortho box to ±12 m (2.3 cm per texel) and snap the light position to whole texels to stop shimmer.
- Add a soft dark quad under the body plus four small wheel blobs, placed with `heightAt`.
- Skip cascaded shadows on Medium: the world is flat and sparse, so the gain is small.

**3. Lamps, plate, cabin sounds.**
- `r_tailight` has no emissive: drive `emissiveIntensity` from `veh.brakePressure`. Reverse lamp when the selector is R. `ind_tailighjt` / `indicator_signal` blink for indicators and hazards. No real light sources are needed.
- `mergeStatic` merges by material, so left and right lamps share one material. Clone the material per side before the merge if they must blink separately.
- `Material_167` (512×256 texture on 2 triangles) is probably the plate [assumption, check in the rig inspector]. Replace its map with a canvas texture in Indian HSRP layout (white, black characters, blue IND strip) and a fictional number.
- Add horn, indicator relay tick, seatbelt chime and a VSC buzzer as tiny synth voices.

**4. Camera.** Today the cockpit eye is rigid to the body and the chase cam is a plain lerp [code].
- Cockpit: shift the head up to ±3 cm against `veh.accelBody`, remove about half of body roll/pitch (eyes stabilise the horizon), add a small yaw into the turn from `veh.yawRate`, and add vertical jitter from `veh.seatAz` (already computed, unused).
- Add a 12–15 Hz damped "frame shake" after impacts. Body-on-frame jiggle is the Fortuner's signature ride trait.
- FOV: cockpit 68° is a fair compromise; add +4° with speed. Chase 58° plus speed widening and a spring instead of the lerp.
- HUD: the dial cluster covers the car in chase view and the model has real needles. Shrink it, and hide the debug panels unless `F` is on.
- Rear-view mirror with a real image: only after item 5, as a 256×96 target, far plane 150 m, no shadows, updated every third frame. High only. Estimated 2–4 ms when it updates [assumption].

**5. Terrain LOD.** Physics uses `heightAt` analytically, so the visual mesh can change freely without touching the roads.
- Cut the fine grids into 40–60 m chunks, build a 2 m twin for each, and show the twin beyond ~150 m from the camera.
- Verify: `renderer.info.render.triangles` should fall from 2.6 M to under 1 M; re-run the "render N times" benchmark from section 0.
- With the saved time, raise Medium `maxPixelRatio` from 1 to 1.25 (native). It measured at only +0.6 ms and removes the soft upscaled look.

**6. Ground visuals.**
- Use ambientCG / Poly Haven CC0 sets at 1K, colour + normal only, for asphalt, concrete, gravel, soil/mud, sand, dry grass.
- The 6 m UV tile repeats visibly. Multiply by a 256 px low-frequency noise at ~80 m scale (one extra sample).
- Add vertex colours in `buildGrid` for tyre-track darkening and dusty edges (free). The asphalt base `#3b3d40` reads blue; use a warm grey.
- Zero-download fallback: derive normal maps from the existing canvases with a Sobel filter.
- Grass tufts: instanced crossed quads in a 40 m ring around the camera, alpha-tested, 1,500 on Medium, 4,000 on High, off on Low. Estimated 0.5–1.5 ms [assumption].
- Trees: per-instance colour and three crown shapes are free. Add a low hill silhouette ring so the horizon is not a flat line.

**7. Sound, keeping the current engine voice and levels.**
- Every worklet output is mono (`outputChannelCount: [1,1,1,1,1]`) [code]. Pan tyre and impact sounds by wheel side and decorrelate wind left/right. This is the largest cheap gain.
- Reverb without recordings: generate impulse responses as filtered decaying noise in an `OfflineAudioContext`. Cabin: 40–60 ms. Outside: ground slap plus a 0.4 s tail at about −18 dB. One `ConvolverNode` each, on a send.
- Trackside and orbit cameras: one `DelayNode` set to distance/343 s gives true Doppler on the whole mix; add 1/r gain and a distance low-pass. Chase cam needs no Doppler.
- Shift thunk and P→R→D engagement clunk through the existing `voice()` impact path, scaled by load.
- Squeal: add broadband scrub below the squeal threshold (tyres "talk" before they howl), split lateral howl from lock-up scrub, and gate squeal below ~15 km/h. Keep `squealLevel 1.8`.
- Lift-off `hissLevel 0.6` is a blow-off sound that a VNT diesel does not really make [assumption]. Try 0.2.
- In the cabin above 100 km/h, wind and tyres should dominate; the cabin currently cuts wind by 65 %.
- Verify on `/audio-test.html`; check `AudioContext.baseLatency` and that the worklet does not glitch.

**8. Driving feel.** See section 3.

**9. Effects.**
- One pooled sprite system (150 on Medium, 400 on High): dust on gravel/sand/mud from `slip × speed`, smoke on paved slip above ~0.3. Cap sprite size to limit overdraw.
- Skid marks: a ring-buffer ribbon, 4 × 512 quads, one draw call, on all levels.
- Skip motion blur. Camera shake and speed FOV give the speed cue for free.

**10. Model geometry.** See section 2.

## 2. The 3D model: "can't you build a real Fortuner yourself?"

**(a) Code-built geometry.** Honest answer: not the body.
- Can do well: wheels and tread, AT selector, number plates, lamps, ladder frame, rear axle and diff, coil springs, wishbones, Panhard rod, exhaust, skid plate. These are simple shapes, and the current model has none of the underbody parts.
- Cannot do to a recognisable standard: the Fortuner's compound-curved panels, light internals, grille and interior. Without blueprints and a visual feedback loop the result is the existing stand-in: a generic SUV.

**(b) Ready-made models.**

| Model | Price | Size | Licence | Interior / parts | Status |
|---|---|---|---|---|---|
| **Current:** Sketchfab "Toyota Fortuner 2021", Asadawut.Kaewma | free | 1.8 M tris | CC BY 4.0: allowed in a public repo with credit | interior yes; wheels separate; doors and tailgate are separate named nodes without hinges | [sourced] |
| RenderHub "Toyota Fortuner 2021", SQUIR | $129 | 642 k polys | Extended Use, IP-restricted (editorial-use restriction) | not stated; FBX/OBJ/MAX; not PBR, not rigged | [sourced] |
| Sketchfab store "Toyota Fortuner TRD 2021", SQUIR3D | not shown | 1.1 M tris | store licence | not stated | [sourced] |
| RenderHub "Toyota Fortuner 2021", BUG-IRL | $59 | unknown | RenderHub licence | unknown | [snippet] |
| CGTrader "Toyota Fortuner 2022" | $80 | unknown | Royalty Free | interior yes, rigged; blend/FBX/OBJ | [snippet] |
| CGTrader "Fortuner Legender 2022" | $49 | unknown | Royalty Free | rigged; interior not stated | [snippet] |
| CGTrader "Toyota Fortuner Rigged" (Rigacar) | $40 | unknown | Royalty Free | unknown | [snippet] |
| Hum3D (now 3dmodels.org) | n/a | n/a | n/a | only a 2012 Fortuner turned up; the 2021 URL returned 403 | not found |

- Licence point that decides it: store licences (Sketchfab, CGTrader, RenderHub) allow use inside a product but not redistributing the model file where others can extract it. A GLB in a public GitHub repo, or served by a public web build, is exactly that. A bought model would have to stay in a private, git-ignored `assets/` folder. Read the exact licence text on the item page before buying.
- The CC BY model is the only option here that may live in a public repo. Toyota's trademarks and design are a separate issue for every option.
- No listing is clearly more accurate than the current model. SQUIR's is probably cleaner topology [assumption], but it needs conversion and a full material rebuild.

**(c) Phone scanning.**
- Photogrammetry (Polycam, RealityScan): glossy paint and glass are the worst case. Expect lumpy panels, holes at the windows and baked-in reflections. The output is one fused mesh, so wheels, doors and interior must be cut out and rebuilt in Blender: days of skilled work.
- Gaussian splats (Luma, Polycam, Scaniverse): photoreal as a static object, but lighting is baked, it casts no proper shadows, wheels cannot spin or steer without segmenting the splat, and a 1–2 M splat render is likely under 30 fps on Iris Xe [assumption]. It also needs a new npm package.
- Good use of a real car and a phone: reference photos for paint colour, plate, badges, tyre sidewall and the AT console, and the measurements in section 3.

**(d) Improve the existing model.** Recommended.
- Materials, lamps, plate: items 1 and 3 above.
- Dented door panels on Medium [measured, screenshot]: the phone GLB was simplified uniformly at ratio 0.1 / error 0.002. Re-run from `assets_src/toyota_fortuner_2021.glb` with per-material ratios: paint and glass ~0.35, interior and hidden parts lower, same ~200 k total.
- AT selector: no node is named gear/shift/lever [measured], so find the manual lever mesh in Blender or the rig inspector, hide it, and add a code-built gated selector (~300 triangles) driven by `veh.selector`.
- Add the code-built rear axle, diff and front arms from (a). The wheel camera then shows a real suspension and the rear wheels move as one axle.
- Doors: they are named nodes, so hinge pivots can be added later. Low priority.

**Recommendation: path (d) plus the code-built parts from (a).** Cost is zero, it stays legal for a public repo, and it removes the visible faults. Buy a store model only if the project stays private and the re-decimated panels still look wrong.

## 3. Physics and driving feel

Assumption-tagged values that matter most, with what to change and what can calibrate them:

| Area | Now [code] | Issue | Calibrate with |
|---|---|---|---|
| CG height, roll | `cgHeight 0.80`; roll-centre heights 0.12 / 0.45 and anti-dive 0.25 / 0.35 are hard-coded in `vehicle.ts`, not in `params.ts`; roll ≈ 4°/g | 4°/g is probably stiff for a body-on-frame SUV (5–6°/g expected) [assumption]. Move the hard-coded values into `params.ts`; sweep CG 0.76–0.85 | NHTSA NCAP static stability factor for the 4Runner (not fetched); LVVTA sheet lists Hilux KUN26 SSF 0.91 [snippet], which implies CG ≈ 0.83 m; a phone inclinometer on a steady circle in a real car |
| Steering | `steerRatio 19.5`; the code gives 3.15 turns lock to lock, while `steerLockToLock 3.5` is never used | the two disagree; no aligning torque exists, so keyboard self-centring is a speed heuristic in `input.ts` | no published figure found; count turns lock to lock on a real Fortuner (2 minutes) |
| AT shift logic | `autoShift`: thresholds on turbine rpm and throttle only; kickdown is instant and one gear at a time; `shiftTime 0.32 s` | too crisp for this gearbox. Add 0.6–1.0 s kickdown delay [assumption], skip-shifts (6→3), minimum time in gear, a torque dip then overshoot so the body nods on shifts | ZigWheels 20–80 km/h kickdown 6.7 s (already in `fortuner_params.json`): add it to `tools/simtest.ts`; an OBD-II logger gives the real shift map and lock-up points |
| Torque converter | stall 2400 rpm, torque ratio 2.0, lock-up from 3rd above 48 km/h | launch feel depends on these | SA road test in the JSON: 0–60 in 4.26 s, 0–120 in 13.24 s, 0–160 in 24.36 s. Add all three to `simtest` if not there |
| Brakes | pedal → torque is linear, 0.12 s lag; dive 3.7° | add a booster curve (soft first travel, then firm); no fade needed | 100–0 and 80–0 already match |
| VSC / ABS | yaw-rate band with `Kus 0.0035`; ABS uses true vehicle speed | plausible; add the buzzer and a flashing slip lamp | the 2016 Hilux moose-test result (Teknikens Värld, same platform and tyre size; from memory, not fetched) as a qualitative check on the handling pad |
| Rear axle | two independent 65 kg wheels | a one-wheel bump does not tilt the axle, so the head-toss of a live axle is missing. M–L to add | none needed; standard beam-axle model |
| Tyres | one Magic Formula shape for all surfaces | on gravel and sand the peak should sit at higher slip, and locked wheels should dig in | no public tyre data for 265/60 R18 H/T; tune by feel |

Missing items worth adding:
- Aligning torque: `Mz = −Fy × trail`, with pneumatic trail ≈ 4 cm falling to zero at the grip peak, plus ~3 cm caster trail [assumption]. Use it for the keyboard return rate, the steering-wheel visual, and gamepad rumble (`vibrationActuator.playEffect('dual-rumble')`) on ABS, kerbs and slip.
- True force feedback for a wheel is not available in browsers: the Gamepad API only exposes vibration.

Not worth adding for a road SUV: aero lift (negligible below 140 km/h), tyre temperature and pressure, structural body flex in the physics. Do frame shake as a camera and sound effect instead (item 4).

Verify every physics change with `tools/simtest.ts`, `tools/feeltest.ts` and the in-app `T` tests. 0–100 must stay at 10.7 s and 100–0 at 44.7 m.

## 4. What not to do on this laptop

- `MeshPhysicalMaterial.transmission` on glass, planar or cube-camera reflections, or full-resolution mirrors. Each is another scene render at about 11 ms.
- An `EffectComposer` chain on Medium: SSAO/GTAO, SSR, motion blur, depth of field. It also drops the free MSAA of the default framebuffer. Half-resolution GTAO plus bloom could be a High-only option for discrete GPUs.
- Cascaded shadow maps on Medium, or `PCFSoftShadowMap` on Medium.
- 2K/4K ground textures, full PBR sets (roughness, AO, displacement), or a 4K+ HDRI background. Use 1K colour + normal.
- A Gaussian-splat or raw photogrammetry car.
- More terrain triangles of any kind before item 5 is done.
- New engine recordings from YouTube (already rejected), or making the engine louder.
- Any change to road or world layout (excluded by the user; see `PLAN_indian_roads.md`).

## 5. Sources

- Sketchfab, current model (licence, 1.8 M triangles, 33.5 k downloads): https://sketchfab.com/3d-models/toyota-fortuner-2021-a70b997f11b7482e9affbf318a508f85
- RenderHub, SQUIR Fortuner 2021: https://www.renderhub.com/squir/toyota-fortuner-2021
- Sketchfab, SQUIR3D Fortuner TRD 2021: https://sketchfab.com/3d-models/toyota-fortuner-trd-2021-439cc01cee7746ce8eccf705a339e01f
- CGTrader listings (snippets only; the pages returned empty to the fetcher): https://www.cgtrader.com/3d-models/car/suv/toyota-fortuner-2022 , https://cgtrader.com/3d-models/exterior/public/toyota-fortuner-legender-2022 , https://www.cgtrader.com/3d-models/car/suv/toyota-fortuner-rigged
- RenderHub, BUG-IRL (snippet): https://www.renderhub.com/bug-irl/toyota-fortuner-2021
- Sketchfab licences and store FAQ: https://sketchfab.com/licenses , https://help.sketchfab.com/en/articles/16152225-store-license-usage-faq
- LVVTA Hilux SSF (snippet): https://www.lvvta.org.nz/documents/infosheets/LVVTA_Info_09-2021_raised_vehicle_stability_calculation.pdf
- Road-test figures: `research/fortuner_params.json` and `research/SOURCES.md`.
- CC0 assets: https://polyhaven.com (HDRIs, textures), https://ambientcg.com (textures). Specific asset names were not checked; choose on the sites.
