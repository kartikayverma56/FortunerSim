# Engine loops for the Fortuner 2.8 (1GD-FTV)

The simulator runs without any files: the procedural synth in `src/audio/engine-worklet.js` is the default.
If you put recorded loops here and describe them in `manifest.json`, `VehicleAudio.loadSampleSet('/audio/engine/manifest.json')`
crossfades them for the engine core. In `hybrid` mode the synth still supplies the layers that recordings lack:
clatter detail, turbo whistle and hiss, driveline whine, starter, road and chassis.

If `manifest.json` is missing, invalid, or none of its files decode, `loadSampleSet` resolves `false` and the synth carries on.

## How the loops are used

For each frame the engine picks:

- **Position:** the `interior` set when the camera is inside the cabin, otherwise the `exterior` set. If only one set exists, it is used for both cameras, and exterior recordings then pass through the cabin filter.
- **The two nearest rpm loops** around the current rpm, with an equal-power crossfade between them.
- **On-load and off-load loops** at that rpm, with an equal-power crossfade by engine `load`. The tuning keys `sampleOffLoad` (default -0.1) and `sampleOnLoad` (default 0.6) set the crossfade range.
- **Pitch:** each loop plays at `rpm / recordedRpm`, clamped to ±20 % (tuning key `samplePitchClamp`).

That adds up to four voices at once (two rpm loops × on/off load), or eight briefly while the camera switches.

## Recording

1. **Use steady rpm.** Hold each rpm within about ±20 rpm for at least 4 seconds. Use a chassis dyno, a long steady hill, or an engine-brake run for off-load loops. Read the rpm from OBD (PID 0C) and log it.
2. **Record on-load and off-load at each rpm:**
   - `on`: under real load, at full or near-full throttle against the dyno, a hill or a held brake. This gives the growl and the boost.
   - `off`: with the throttle closed and the vehicle coasting in gear (fuel cut, engine braking). At idle, record the plain idle in N or P as `off`.
3. **Pick an rpm grid.** Use a spacing that keeps pitch shifts under ±20 %. This grid works well:
   `750 (idle), 1000, 1300, 1600, 2000, 2400, 2800, 3200, 3600, 4000, 4400`.
4. **Mic positions:**
   - `exterior`: about 1 m behind and to the side of the tailpipe, plus one mic at the front grille. Mix them roughly 60/40, because a turbo diesel's engine-bay clatter matters as much as the exhaust.
   - `interior`: at the driver's head height, with the windows closed and the HVAC fan off.
5. **Keep the vehicle stationary or on a dyno.** Tyre and wind noise in the loops would double up with the synth's road layer. Record at 48 kHz, 24-bit.

## Preparing the loops

- **Trim to whole engine cycles.** One 4-stroke cycle takes `120 / rpm` seconds, so at 2000 rpm a cycle lasts 60 ms. Cut the loop on a zero crossing at the same crank phase at each end. An easy method is to align the loop on two pressure peaks one or more cycles apart. Aim for a loop of 1 to 3 s, which is many cycles long, so that cylinder-to-cycle variation is kept.
- **Make the seam inaudible.** Apply a 20 to 50 ms crossfade loop in your editor (in Audacity, select the region, then Effect → Crossfade Clips; or use any looper plugin), then listen to it looping for 30 seconds.
- **Remove any rpm drift** inside the loop. A drifting loop warbles every time it wraps.
- **Normalise loudness across each set.** Do not normalise each file to peak, or the loudness rise with rpm and load is lost. Use the manifest's `gain` to trim individual loops instead.
- **Remove DC and high-pass at about 20 Hz.**
- **Export as Ogg Vorbis** (q6 or higher) or as WAV. Avoid MP3, because its encoder padding breaks seamless loops.

## Naming

`<rpm>_<load>_<position>.ogg`, for example `0750_off_ext.ogg`, `2000_on_ext.ogg`, `2000_off_int.ogg`.
The names are only a convention. The manifest is what the loader reads.

## manifest.json

The manifest is either an array, or `{ "loops": [...] }`. File paths are relative to the manifest.

```json
[
  { "file": "0750_off_ext.ogg", "rpm": 750,  "load": "off", "position": "exterior" },
  { "file": "0750_on_ext.ogg",  "rpm": 750,  "load": "on",  "position": "exterior", "gain": 0.9 },
  { "file": "1600_off_ext.ogg", "rpm": 1600, "load": "off", "position": "exterior" },
  { "file": "1600_on_ext.ogg",  "rpm": 1600, "load": "on",  "position": "exterior" },
  { "file": "2800_off_ext.ogg", "rpm": 2800, "load": "off", "position": "exterior" },
  { "file": "2800_on_ext.ogg",  "rpm": 2800, "load": "on",  "position": "exterior" },
  { "file": "4000_on_ext.ogg",  "rpm": 4000, "load": "on",  "position": "exterior" },
  { "file": "2000_on_int.ogg",  "rpm": 2000, "load": "on",  "position": "interior", "loopStart": 0.12, "loopEnd": 2.52 }
]
```

| field | required | meaning |
|---|---|---|
| `file` | yes | audio file, relative to the manifest |
| `rpm` | yes | steady crank rpm during the recording |
| `load` | yes | `"on"` (pulling) or `"off"` (closed throttle / idle) |
| `position` | yes | `"exterior"` or `"interior"` |
| `gain` | no | linear level trim, default 1 |
| `loopStart`, `loopEnd` | no | loop points in seconds; the default is the whole file |

A set can contain only `on` loops, or only `off` loops. Whichever side exists is then used for every load.

## Checking

Open `/audio-test.html`, press **Start audio**, then **Load**, and switch the mode to `samples` to hear the loops alone.
Run **Rev sweep** and listen for steps between rpm points. A step means a loop has the wrong `rpm` value, or its level is out of line with its neighbours, which `gain` can fix.
