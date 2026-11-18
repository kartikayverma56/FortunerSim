# Engine and vehicle sound sources for the Fortuner sim

Compiled 2026-11-18. Every entry below was opened on its own page (Freesound or Wikimedia Commons) during this research, unless it is marked **unverified**. Licences are copied from each sound's page. Check the licence again when you download, because uploaders can change it.

**Licences allowed:** CC0 (no conditions) and CC BY 3.0/4.0 (credit the author). CC BY-NC sounds are listed separately and excluded.

## The main gap

No CC0 or CC-BY recording of a Fortuner, 1GD-FTV, Land Cruiser Prado or 1KD/2KD diesel turned up on Freesound or Wikimedia Commons. The only Toyota diesel recording found is a Hilux start-and-rev (CC0, engine generation not stated). The engine-sound base therefore has to come from other modern 4-cylinder turbo-diesels:

- **Peugeot 1.5 BlueHDi** by Mihacappy (CC0). Its pages give rpm notes, which makes it the best loop source.
- **Renault Master dCi, Audi A4 2.0 TDI and BMW 420d** by Soundholder (CC BY 3.0, 96 kHz/24-bit).
- **Ford Transit 2003 diesel** by Sadiquecat (CC0).

The Hilux recording is useful as a character reference for EQ and pitch.

**What "class" means in the tables:**
- **steady-RPM loop:** a held, constant rpm you can loop directly.
- **rev sweep:** a continuous rpm change; cut short loops from the near-steady parts.
- **pass-by:** a vehicle driving past the mic.
- **start/stop:** a sequence that includes cranking, start or shut-off.
- **one-shot:** a single event.
- **ambience:** a long bed of continuous sound.

---

## Top 10, ranked for a 4-cylinder turbo-diesel SUV engine system

| # | Sound | URL | Author | Licence | Length | Class | Why |
|---|---|---|---|---|---|---|---|
| 1 | bluehdi_rev_hold.wav | https://freesound.org/people/Mihacappy/sounds/827860/ | Mihacappy | CC0 | 0:37 | steady-RPM holds, exterior, off-load | The page says: "2022 Peugeot 1.5 BlueHDI diesel engine idles and holds varying RPMs up to 4,000, then the throttle is dropped." It is the best source for cutting 1500-3500 rpm off-load loops. |
| 2 | 3008-start-idle-rev-shutoff.wav | https://freesound.org/people/Mihacappy/sounds/815853/ | Mihacappy | CC0 | 0:29 | start/stop with rpm markers, exterior (front, hood closed) | The page times the revs at 0:15 ≈ 1500 rpm, 0:17 ≈ 3000 rpm and 0:20 ≈ 2000 rpm, so you can calibrate pitch against it. It also gives a start and a shut-off. |
| 3 | 3008gtrevving.wav | https://freesound.org/people/Mihacappy/sounds/865222/ | Mihacappy | CC0 | 1:15 | rev sweep and holds, under the engine near the radiator | It revs to various rpm and, at 0:52, runs at full throttle "until the injection pump hard-caps at 4000 RPM". Use it for the limiter and the top loop. |
| 4 | 4WD Engine & Rev.wav | https://freesound.org/people/Alex_hears_things/sounds/379914/ | Alex_hears_things | CC0 | 1:07 | start + revs (Toyota Hilux diesel 4x4), likely exterior | This is the only real Toyota diesel found, recorded cleanly on an MKH 805 (48 kHz/16-bit). Use it as the character reference and for start-up. |
| 5 | Renault Master F3500 dCi135 Engine RPM Ramp 2 Mono.wav | https://freesound.org/people/Soundholder/sounds/425846/ | Soundholder | CC BY 3.0 | 0:17 | rev sweep, 96 kHz/24-bit mono | A 2.3 L 4-cylinder diesel van (my inference). Its heavier commercial character is close to a Fortuner. |
| 6 | audi a4 b8 20tdi update engine set1 idle acceleration early gear shifting mono.wav | https://freesound.org/people/Soundholder/sounds/425397/ | Soundholder | CC BY 3.0 | 1:29 | on-load acceleration through the gears | The only clean **on-load** 4-cylinder TDI material found. Use it for the on-load layer. |
| 7 | Renault Master F3500 dCi135 Engine Start Up Idle Gas Pressing And Shut Down Mono.wav | https://freesound.org/people/Soundholder/sounds/425845/ | Soundholder | CC BY 3.0 | 1:31 | start, idle, blips, shut-down | Long idle segment for the idle loop, plus start and stop one-shots, at 96 kHz/24-bit. |
| 8 | Ford 115 T350 - Engine from interior / Engine under exhaust | https://freesound.org/people/Sadiquecat/sounds/819017/ and https://freesound.org/people/Sadiquecat/sounds/819018/ | Sadiquecat | CC0 | 0:33 / 1:12 | interior / exterior exhaust, engine state not stated | A matched interior and exterior pair from the same diesel van (2003 Transit), useful for the camera-position crossfade. |
| 9 | VW_T5_TRANSPORTER_INTERIOR_BUMPY SEALED ROAD.wav | https://freesound.org/people/DangerLaef/sounds/690388/ | DangerLaef | CC0 | 3:11 | ambience, interior, on-load | Diesel van cabin on a rough road. Use it as the interior road and engine bed. |
| 10 | Diesel drive in Belgium | https://freesound.org/people/gecop/sounds/521768/ | gecop | CC0 | 7:47 | ambience, interior, on-load ("1900cc turbo diesel car") | Covers idle, pull-away, cruise and cobblestones (48 kHz/32-bit). Long enough to cut cruise loops from. |

Close alternatives:
- BMW 420D Gran Coupe start, idle, gas pressing and off (https://freesound.org/people/Soundholder/sounds/425495/, CC BY 3.0, 2:26, 4-cylinder).
- Mihacappy bluehdi_idle2.wav (https://freesound.org/people/Mihacappy/sounds/819131/, CC0, 0:19, cold idle near the wheel arch), as a dedicated idle loop.

Mihacappy's pages ask: "PLEASE do not use my sounds to train AI models!" This is a request, not a licence term, and it does not restrict use in an app.

---

## Full candidate list

### (a) Toyota and other diesel SUV, pickup and van recordings

| URL | Title | Author | Licence | Duration | Format | Content | Class |
|---|---|---|---|---|---|---|---|
| https://freesound.org/people/Alex_hears_things/sounds/379914/ | 4WD Engine & Rev.wav | Alex_hears_things | CC0 | 1:07.2 | WAV 48k/16 stereo | "ignition and engine rev of a large Toyota Hilux diesel 4x4". Engine generation not stated. | start + revs |
| https://freesound.org/people/geoffvt/sounds/810717/ | land cruiser drive past | geoffvt | CC0 | 0:16.5 | MP3 48k | Toyota Land Cruiser drive past; engine not stated | pass-by |
| https://freesound.org/people/felix.blume/sounds/668552/ | Car driving in exterior, Toyota Landcruiser 4x4, motor, dirt road, gravel, puddle mud, offroad, microphone outside the window | felix.blume | CC0 | 11:18.9 | WAV 48k/24 stereo (MS) | Off-road on gravel and mud; engine and fuel not stated | ambience (on-load + gravel) |
| https://freesound.org/people/Aldergrove_Studios/sounds/505518/ | Minibus_Drive-bys_EXT | Aldergrove_Studios | CC BY 4.0 | 2:53.8 | WAV 48k/24 | Drive-bys of a diesel Toyota minibus | pass-by |
| https://freesound.org/people/Sadiquecat/sounds/819017/ | Ford 115 T350 - Engine from interior | Sadiquecat | CC0 | 0:32.7 | WAV 192k/24 mono | 2003 Transit diesel, interior | idle/steady, state unknown |
| https://freesound.org/people/Sadiquecat/sounds/819018/ | Ford 115 T350 - Engine under exhaust | Sadiquecat | CC0 | 1:11.9 | WAV 192k/24 mono | Exhaust perspective | exterior engine |
| https://freesound.org/people/Sadiquecat/sounds/819013/ | Ford 115 T350 - Engine from front grill intake | Sadiquecat | CC0 | 0:43.1 | WAV 192k/24 mono | Intake perspective | exterior engine |
| https://freesound.org/people/Soundholder/sounds/425846/ | Renault Master F3500 dCi135 Engine RPM Ramp 2 Mono.wav | Soundholder | CC BY 3.0 | 0:17.5 | WAV 96k/24 mono | rpm ramp | rev sweep |
| https://freesound.org/people/Soundholder/sounds/425845/ | Renault Master F3500 dCi135 Engine Start Up Idle Gas Pressing And Shut Down Mono.wav | Soundholder | CC BY 3.0 | 1:30.7 | WAV 96k/24 mono | start, idle, blips, off | start/stop |
| https://freesound.org/people/Soundholder/sounds/425850/ | Renault Master F3500 dCi135 Exterior Passby Slow Speed Low RPM Mono Follow.wav | Soundholder | CC BY 3.0 | 0:14.4 | WAV 96k/24 mono | slow, low-rpm pass-by | pass-by |
| https://freesound.org/people/DangerLaef/sounds/690388/ | VW_T5_TRANSPORTER_INTERIOR_BUMPY SEALED ROAD.wav | DangerLaef | CC0 | 3:10.9 | WAV 48k/16 stereo | Diesel T5 cabin, on-load | ambience |

Seen in search only (**unverified**):
- Sadiquecat 819015 "Engine from front under".
- Sadiquecat 819016 "Engine from interior passanger leg area (EMF interference)".
- DAVESTALKER 443319 "Diesel Start-Idle-Revs" (F350, probably V8).

### (b) Steady rpm, rev sweeps, idle, on-load and interior (other 4-cylinder turbo-diesels)

| URL | Title | Author | Licence | Duration | Format | Content | Class |
|---|---|---|---|---|---|---|---|
| https://freesound.org/people/Mihacappy/sounds/827860/ | bluehdi_rev_hold.wav | Mihacappy | CC0 | 0:37.4 | WAV 48k/16 stereo (phone) | Peugeot 1.5 BlueHDi: idle, then holds up to 4000 rpm | **steady-RPM holds** |
| https://freesound.org/people/Mihacappy/sounds/865222/ | 3008gtrevving.wav | Mihacappy | CC0 | 1:15.2 | WAV 48k/16 | Revs; 4000 rpm cap at 0:52; mic under the engine | rev sweep / holds |
| https://freesound.org/people/Mihacappy/sounds/815853/ | 3008-start-idle-rev-shutoff.wav | Mihacappy | CC0 | 0:28.8 | WAV 48k/16 | ≈1500 rpm at 0:15, ≈3000 at 0:17, ≈2000 at 0:20 | start/stop + rpm marks |
| https://freesound.org/people/Mihacappy/sounds/819131/ | bluehdi_idle2.wav | Mihacappy | CC0 | 0:19.2 | WAV 48k/16 | Cold idle, near the right wheel arch | steady-RPM loop (idle) |
| https://freesound.org/people/Mihacappy/sounds/845320/ | diesel_start_under1.wav | Mihacappy | CC0 | 0:11.8 | WAV 48k/16 | Diesel start at -12 °C, under the bay | start (cranking) |
| https://freesound.org/people/Mihacappy/sounds/827862/ | skoda_tdi_idle.wav | Mihacappy | CC0 | 0:19.0 | WAV 48k/16 | Early-2000s Octavia TDI idle, about 10 m away | idle loop |
| https://freesound.org/people/Mihacappy/sounds/840649/ | djeep_idle.wav | Mihacappy | CC0 | 0:04.8 | WAV 48k/16 | Grand Cherokee diesel idle, "Loops nicely" (V6, not 4-cylinder) | idle loop |
| https://freesound.org/people/Soundholder/sounds/425397/ | audi a4 b8 20tdi update engine set1 idle acceleration early gear shifting mono.wav | Soundholder | CC BY 3.0 | 1:29.2 | WAV 96k/24 mono | On-load acceleration | on-load |
| https://freesound.org/people/Soundholder/sounds/425394/ | audi a4 b8 20tdi update engine set2 start idle gas pressing off mono.wav | Soundholder | CC BY 3.0 | 1:32.7 | WAV 96k/24 mono | start, idle, revs, off | start/stop |
| https://freesound.org/people/Soundholder/sounds/425386/ | audi a4 b8 20tdi engine start neutral mono.wav | Soundholder | CC BY 3.0 | 0:21.8 | WAV 96k/24 mono | start | one-shot |
| https://freesound.org/people/Soundholder/sounds/425398/ | audi a4 b8 20tdi tyres asphalt medium speed mono.wav | Soundholder | CC BY 3.0 | 0:42.3 | WAV 96k/24 mono | tyre/road layer | ambience |
| https://freesound.org/people/Soundholder/sounds/425495/ | BMW 420D Gran Coupe engine start idle gas pressing and off mono.wav | Soundholder | CC BY 3.0 | 2:25.6 | WAV 96k/24 mono | 2.0 4-cylinder diesel | start/stop + revs |
| https://freesound.org/people/Soundholder/sounds/425502/ | BMW 530D E60 Interior Driving Medium Speed Drivers Perspective 2 Mono.wav | Soundholder | CC BY 3.0 | 0:47.1 | WAV 96k/24 | Inline-6 diesel, interior | interior on-load |
| https://freesound.org/people/Soundholder/sounds/425860/ | Volkswagen Golf II 1.6 Diesel Exterior Engine Multiple Gas Pressing Mono.wav | Soundholder | CC BY 3.0 | 0:10.9 | WAV 96k/24 | Naturally aspirated diesel, not turbo | revs |
| https://freesound.org/people/gecop/sounds/521768/ | Diesel drive in Belgium | gecop | CC0 | 7:46.6 | WAV 48k/32 stereo | Interior, 1.9 L turbo-diesel, country road to highway | ambience (on-load) |
| https://freesound.org/people/gecop/sounds/521766/ | Highway drive interior | gecop | CC0 | 0:50.1 | WAV 48k/32 | Steady highway cruise | ambience (cruise) |
| https://freesound.org/people/philipquintonsound/sounds/820340/ | car interior, diesel, automatic, trip into town | philipquintonsound | CC BY 4.0 | 13:34.3 | FLAC 96k/24 | 2011 diesel automatic: unlock, door, start, town, humps | ambience + one-shots |
| https://freesound.org/people/C-V/sounds/565598/ | Diesel idle 1.wav | C-V | CC0 | 0:43.2 | WAV 48k/24 | "dually diesel" (probably a large US V8) | idle loop |
| https://freesound.org/people/kyles/sounds/453995/ | engine idle van diesel exhaust CBC microwave truck side4 nearby.flac | kyles | CC0 | 0:41.5 | FLAC 48k/16 | Diesel van idle, exterior | idle loop |
| https://freesound.org/people/phenoxy/sounds/195451/ | Diesel_start_idle2.wav | phenoxy | CC BY 4.0 | 0:49.4 | WAV 44.1k/16 | "Modern Diesel engine starts and then idle" | start + idle |
| https://freesound.org/people/soundjoao/sounds/325809/ | Motor Loop 3.wav | soundjoao | CC0 | 0:02.0 | WAV 44.1k/24 | Diesel van, "suitable as a loop"; rpm unknown | steady-RPM loop |
| https://freesound.org/people/soundjoao/sounds/325810/ | Motor Loop 2.wav | soundjoao | CC0 | 0:03.6 | WAV 44.1k/24 | as above | steady-RPM loop |
| https://freesound.org/people/Loffy/sounds/89948/ | car_inside_start_idle_diesel_engine.wav | Loffy | CC BY 3.0 | 0:11.0 | WAV 44.1k/16 mono | 2007 Passat diesel, interior | start + idle |

**Wikimedia Commons.** These are audio tracks ripped from YouTube: lossy Opus, focused on the exhaust, and every page is flagged "License review needed". All are **CC BY 3.0 Unported**; credit the YouTube author named on each page.
- https://commons.wikimedia.org/wiki/File:Audi_A3_-_engine_and_exhaust_sound_(YouTube_W2wEDlZSw3Q).opus (1:58; A3 2.0 TDI)
- https://commons.wikimedia.org/wiki/File:Chevrolet_Cruze_-_engine_and_exhaust_sound_(YouTube_4thPAL-pLXc).opus (7:55; Cruze 2.0 diesel, manual)
- https://commons.wikimedia.org/wiki/File:Seat_Toledo_-_engine_and_exhaust_sound_(YouTube_zxgRsS4UvfM).opus (1:17; 2004 Toledo diesel)
- https://commons.wikimedia.org/wiki/File:Land_Rover_Defender_-_engine_and_exhaust_sound_(YouTube_7xkpPsM_DWM).opus (0:51; Defender Td5, turbo audible)

### (c) One-shots and ambiences

| Need | URL | Title | Author | Licence | Duration | Notes |
|---|---|---|---|---|---|---|
| Turbo whistle | https://freesound.org/people/digifishmusic/sounds/28641/ | Opel Astra Diesel 19CDTi Start Idle Rev Off.wav | digifishmusic | CC BY 4.0 | 0:28.7 | "You can hear the turbo whistle when it revs." No standalone CC0 diesel spool one-shot was found; synthesise one (band-passed noise or sine at roughly 3-8 kHz, rising with boost). |
| Diesel idle clatter | https://freesound.org/people/Mihacappy/sounds/819131/ | bluehdi_idle2.wav | Mihacappy | CC0 | 0:19.2 | Cold idle, close mic: strongest clatter |
| Starter cranking | https://freesound.org/people/Mihacappy/sounds/845320/ | diesel_start_under1.wav | Mihacappy | CC0 | 0:11.8 | Cold start at -12 °C |
| Starter cranking (alternative) | https://freesound.org/people/Mullumbimby/sounds/622829/ | Cold start of old diesel car | Mullumbimby | CC0 | 0:31.4 | Old Transit, reluctant crank, belt screech |
| Door close (Toyota) | https://freesound.org/people/Alex_hears_things/sounds/379912/ | Close Car Door in Shed.wav | Alex_hears_things | CC0 | 0:02.4 | Old Hilux door; shed reverb |
| Door close (SUV) | https://freesound.org/people/Mihacappy/sounds/868257/ | 3008_drclose1.wav | Mihacappy | CC0 | 0:00.3 | Same pack has drclose2/3 and dropen1-3 (868258-868262, **unverified**) |
| Door close (interior) | https://freesound.org/people/zoombackcamera/sounds/689225/ | Car door closing from inside 1.wav | zoombackcamera | CC0 | 0:04.6 | Interior perspective, SUV tag |
| Door close (exterior) | https://freesound.org/people/greatsoundstube/sounds/629315/ | car door close from outside.wav | greatsoundstube | CC0 | 0:03.5 | From the pack "Diesel Car" |
| Door open + close | https://freesound.org/people/NachtmahrTV/sounds/556689/ | Car Door open and close.wav | NachtmahrTV | CC0 | 0:04.0 | |
| Gravel tyre noise | https://freesound.org/people/felix.blume/sounds/685231/ | Car driving on a gravel dirt road, close recording of front wheel from outside | felix.blume | CC0 | 1:44.5 | 96k/24; also the 11-minute Landcruiser off-road recording above |
| Tyre squeal | https://freesound.org/people/audible-edge/sounds/71736/ | Chrysler LHS tire squeal 01 (04-25-2009).wav | audible-edge | CC0 | 0:10.0 | Real car, hard cornering |
| Tyre squeal (Foley) | https://freesound.org/people/iainmccurdy/sounds/650934/ | Screeching Tyres | iainmccurdy | CC BY 4.0 | 0:25.3 | 16 separated squeals |
| Suspension creak/clunk | https://freesound.org/people/nmscher/sounds/86234/ | Car_Suspension_Creak.aif | nmscher | CC0 | 0:22.5 | Creak as weight shifts. Speed-bump/pothole clips (Breviceps 508170, minimumlabyrinth 620706/620701, Stephane_Carreau 505565) are **unverified**. |
| Cabin wind | https://freesound.org/people/ra_gun/sounds/82267/ | Wind-inside car-091007.wav | ra_gun | CC0 | 2:33.6 | Storm wind heard from inside a car |
| Cabin road/wind bed | https://freesound.org/people/squareal/sounds/237374/ | Car Driving Interior | squareal | CC0 | 1:26.2 | VW Tiguan, highway |

### Excluded: non-commercial (NC) licences

- https://freesound.org/people/olliegw/sounds/843865/ "Diesel Car Idling" (Skoda 2.0 TDI): **CC BY-NC 4.0**, verified.
- https://freesound.org/people/robin.kaf/sounds/711875/ "Mercedes Benz G500 - RPM Runup Slow 01": **CC BY-NC 4.0**, verified.
- These appeared under Freesound's NonCommercial filter; their licence versions are **unverified**:
  - chungus43A 846352/846353 (synthetic diesel loops)
  - Unlistenable 423605-423607 (Xsara Picasso diesel)
  - cdltbz 143970
  - tom_woysky 703191, 254145
  - Robinhood76 70225
  - Jorge_M_Rodrigues 522581
  - audio_sgn_a 839680-839682

### Other libraries: licence notes

- **Sonniss GDC bundles** (https://sonniss.com/gameaudiogdc). This is Sonniss's own royalty-free licence, **not CC**:
  - Commercial use is allowed, no attribution is required, and the licence covers unlimited projects.
  - You may not resell or redistribute the files as sound effects or as a pack. Shipping them inside an app is fine.
  - AI/ML training is prohibited.
  - Bundles exist for 2015 to 2024. Their contents were not checked for diesel or SUV material, so search the downloaded bundles for "diesel", "pickup", "4x4" and "truck".
- **BBC Sound Effects** (https://sound-effects.bbcrewind.co.uk). The **RemArc licence allows personal, educational or research use only, with no commercial use.** The site blocked automated fetching, so these terms come from secondary sources. Use it only if the app stays strictly personal or educational.
  - One relevant clip found: "1967 Land Rover Series 2A Safari Diesel driven on a rough track", ID 07050084 (https://bbcsfx.acropolis.org.uk/assets/07050084.wav, as linked by The Drive; duration **unverified**).

---

## How to download from Freesound and build the manifest

1. Create a free account at https://freesound.org/home/register/, confirm the email, and log in.
2. Open each URL above and click **Download** on the right side of the page. You get the original file (WAV, FLAC, AIFF or MP3).
3. Put the originals in a scratch folder outside the repo, for example `D:\FortunerSim\raw_audio\`. Keep the original filename, and keep a note of the URL for attribution.
4. Cut and convert with ffmpeg (install it from https://ffmpeg.org), for example:
   ```
   ffmpeg -i bluehdi_rev_hold.wav -ss 12.30 -t 2.00 -ac 1 -ar 48000 -c:a libvorbis -q:a 6 public/audio/engine/ext_off_2000.ogg
   ```
   - Pick a segment where the pitch is steady.
   - Trim loop ends at zero crossings, or apply a 10-20 ms crossfade in Audacity before exporting.
   - Normalise all loops to the same loudness, for example `-af loudnorm=I=-20`.
5. **Measure the real rpm of each loop** instead of trusting labels. A 4-cylinder four-stroke has firing frequency `f = rpm / 30` Hz: 750 rpm gives 25 Hz, 1500 gives 50 Hz, 3000 gives 100 Hz. In Audacity, select the loop and use Analyze > Plot Spectrum, find the lowest strong peak (or the spacing between harmonics), and multiply by 30. Put the result in the manifest `rpm` field.

### Suggested target files

The `rpm` values below are **targets until measured**. Replace each with the value from step 5.

| Target file | Cut from | Manifest entry |
|---|---|---|
| `public/audio/engine/ext_off_idle.ogg` | Mihacappy 819131 (bluehdi_idle2) or the idle part of 827860 | `{ "rpm": 800, "load": "off", "position": "exterior" }` |
| `public/audio/engine/ext_off_1500.ogg` | Mihacappy 815853 around 0:15 (page: ≈1500 rpm) | `{ "rpm": 1500, "load": "off", "position": "exterior" }` |
| `public/audio/engine/ext_off_2000.ogg` | Mihacappy 815853 around 0:20 (page: ≈2000 rpm) or a hold in 827860 | `{ "rpm": 2000, "load": "off", "position": "exterior" }` |
| `public/audio/engine/ext_off_2500.ogg` | Mihacappy 827860 hold | `{ "rpm": 2500, "load": "off", "position": "exterior" }` |
| `public/audio/engine/ext_off_3000.ogg` | Mihacappy 815853 around 0:17 (page: ≈3000 rpm) or 827860 | `{ "rpm": 3000, "load": "off", "position": "exterior" }` |
| `public/audio/engine/ext_off_3500.ogg` | Mihacappy 827860 / 865222 hold | `{ "rpm": 3500, "load": "off", "position": "exterior" }` |
| `public/audio/engine/ext_off_limiter.ogg` | Mihacappy 865222 at 0:52 (page: pump caps at 4000 rpm) | `{ "rpm": 4000, "load": "off", "position": "exterior" }` |
| `public/audio/engine/ext_on_1500.ogg`, `ext_on_2500.ogg`, `ext_on_3500.ogg` | Soundholder 425397 (A4 TDI acceleration), in-gear pulls | `{ "rpm": <measured>, "load": "on", "position": "exterior" }` |
| `public/audio/engine/int_on_cruise.ogg` | gecop 521766 / 521768, steady cruise | `{ "rpm": <measured>, "load": "on", "position": "interior" }` |
| `public/audio/engine/int_off_idle.ogg` | Sadiquecat 819017 (Transit interior) | `{ "rpm": <measured>, "load": "off", "position": "interior" }` |
| `public/audio/engine/start.ogg` | Alex_hears_things 379914 (Hilux) start section, or Soundholder 425845 | one-shot, not in the rpm manifest |
| `public/audio/engine/stop.ogg` | Soundholder 425845 shut-down | one-shot |
| `public/audio/fx/door_close.ogg`, `door_open.ogg` | Alex_hears_things 379912 / Mihacappy 868257 / NachtmahrTV 556689 | one-shot |
| `public/audio/fx/gravel_loop.ogg` | felix.blume 685231 | loop |
| `public/audio/fx/tyre_squeal.ogg` | audible-edge 71736 | loop |
| `public/audio/fx/wind_cabin.ogg` | ra_gun 82267 / squareal 237374 | loop |
| `public/audio/fx/suspension_clunk.ogg` | nmscher 86234 | one-shot |

Mixing note: most good 4-cylinder material here is **off-load**. You can fake the on-load layer from off-load loops by:
- adding low-mid gain (about 150-400 Hz);
- adding a turbo whine layer that scales with load;
- crossfading in Soundholder 425397 when throttle is above about 50%.

The Toyota 2.8 is larger and slower-revving than the 1.5 BlueHDi, so pitch BlueHDi loops by their measured rpm, not by their names, and add a little low-end EQ to match the Hilux reference (379914).

### Attribution (needed only for the CC BY files you actually ship)

Put this in an in-app credits screen or `public/audio/CREDITS.txt`, with the sound name, URL and licence for each file:
- Soundholder (freesound.org), CC BY 3.0
- Loffy, CC BY 3.0
- phenoxy, CC BY 4.0
- digifishmusic, CC BY 4.0
- iainmccurdy, CC BY 4.0
- Aldergrove_Studios, CC BY 4.0
- philipquintonsound, CC BY 4.0
- YouTube authors of the Commons files, CC BY 3.0

CC0 files need no credit, but crediting them is good practice.
