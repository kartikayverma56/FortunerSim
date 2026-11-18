import * as THREE from 'three';
import { FORTUNER, applyOverrides, type VehicleParams } from './physics/params';
import { Vehicle, type DriveMode } from './physics/vehicle';
import { buildWorld } from './world/worldMesh';
import { CarVisual } from './vehicle/rig';
import { CameraRig } from './cameras';
import { Input } from './input';
import { TestRunner } from './ui/tests';
import { Hud } from './ui/hud';
import { humps, IROAD, PAD, OFFROAD } from './world/terrain';
import { VehicleAudio } from './audio/VehicleAudio';
import type { AudioState } from './audio/types';

const PHYS_DT = 1 / 1000;
const quality = (new URLSearchParams(location.search).get('q') as 'showroom' | 'phone') || (matchMedia('(pointer:coarse)').matches ? 'phone' : 'showroom');

const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'phone' ? 1 : 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 0.9;
document.getElementById('app')!.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const status = (s: string) => { const el = document.getElementById('loading'); if (el) el.textContent = s; };

async function boot() {
  status('Building test ground…');
  await new Promise(r => setTimeout(r, 20));
  const world = buildWorld(scene, renderer);
  // parameters (+ research overrides if present)
  const P: VehicleParams = structuredClone(FORTUNER);
  let research: Record<string, any> = {};
  try { const r = await fetch('/research/fortuner_params.json'); if (r.ok) { research = await r.json(); applyOverrides(P, research); } } catch { /* optional */ }
  const veh = new Vehicle(P);
  veh.reset(0, -40, 0);
  status('Loading Fortuner model…');
  const car = new CarVisual(); await car.load(veh, quality); scene.add(car.root);
  const camRig = new CameraRig(renderer.domElement);
  const input = new Input();
  const tests = new TestRunner();
  tests.ref = refsFrom(research);
  const hud = new Hud(tests);
  const audio = new VehicleAudio();
  addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camRig.cam.aspect = innerWidth / innerHeight; camRig.cam.updateProjectionMatrix(); });
  document.getElementById('loading')!.style.display = 'none';
  const startEl = document.getElementById('start')!; startEl.style.display = 'flex';
  if (car.report.source === 'stand-in') document.getElementById('modelNote')!.textContent = car.report.warnings.at(-1) || '';
  else document.getElementById('modelNote')!.textContent = `Model: ${car.report.file}${car.report.credit ? ' — ' + car.report.credit : ''}`;
  startEl.onclick = async () => {
    startEl.style.display = 'none';
    try { await audio.start(); const ok = await audio.loadSampleSet('/audio/engine/manifest.json'); audio.setMode(ok ? 'hybrid' : 'synth'); } catch (e) { console.warn('audio', e); }
    veh.startEngine(); veh.setSelector('P');
    hud.toast('Engine starting… Press G for D, then W to drive. H for help.', 4);
  };

  const TELE: Record<string, [number, number, number, string]> = {
    Digit5: [0, -40, 0, 'Runway (0–100 / braking)'], Digit6: [IROAD.x0 + 5.8, -10, 0, 'Indian road strip'],
    Digit7: [IROAD.x0 + 5.8, humps[0].z - 60, 0, 'Speed-breaker section'], Digit8: [OFFROAD.x0 + 14, OFFROAD.z0 + 4, 0, 'Off-road park'], Digit9: [PAD.cx, PAD.cz - 100, 0, 'Handling pad'],
  };

  const clock = new THREE.Clock(); let acc = 0, fpsS = 60, frame = 0;
  const handleKeys = () => {
    const keys = input.takePressed();
    const pad = input.padPressed;
    for (const k of keys) {
      if (TELE[k]) { tests.stop(); const [x, z, h, n] = TELE[k]; veh.reset(x, z, h); camRig.set(camRig.mode); hud.toast('Teleported: ' + n); continue; }
      switch (k) {
        case 'Enter': if (veh.ignition) { veh.stopEngine(); hud.toast('Engine off'); } else { veh.startEngine(); hud.toast('Cranking…'); } break;
        case 'KeyG': { const order = ['P', 'R', 'N', 'D'] as const; const i = order.indexOf(veh.selector as any); const nx = order[(i + 1) % 4]; if (!veh.setSelector(nx)) hud.toast('Stop the vehicle first'); else hud.toast('Selector ' + nx); break; }
        case 'KeyR': { const nx = veh.selector === 'R' ? 'D' : 'R'; if (!veh.setSelector(nx)) hud.toast('Stop the vehicle first'); else hud.toast('Selector ' + nx); break; }
        case 'KeyX': veh.shiftManual(+1); hud.toast('Manual ' + veh.manualGear); break;
        case 'KeyZ': veh.shiftManual(-1); hud.toast('Manual ' + veh.manualGear); break;
        case 'Digit1': case 'Digit2': case 'Digit3': { const m = (['2H', '4H', '4L'] as DriveMode[])[+k.slice(-1) - 1]; const err = veh.setDriveMode(m); hud.toast(err || 'Transfer case ' + m); break; }
        case 'KeyL': { const err = veh.toggleLocker(); hud.toast(err || (veh.rearLocker ? 'Rear diff LOCKED' : 'Rear diff unlocked')); break; }
        case 'KeyK': if (veh.driveMode !== '4L') hud.toast('DAC works in 4L'); else { veh.dacOn = !veh.dacOn; hud.toast('DAC ' + (veh.dacOn ? 'ON' : 'OFF')); } break;
        case 'KeyV': veh.vscOn = !veh.vscOn; hud.toast('VSC ' + (veh.vscOn ? 'ON' : 'OFF')); break;
        case 'KeyC': camRig.next(); hud.toast('Camera: ' + camRig.mode); break;
        case 'KeyF': hud.showChart = !hud.showChart; document.getElementById('chart')!.style.display = hud.showChart ? 'block' : 'none'; break;
        case 'KeyH': toggle('help'); break;
        case 'KeyT': toggle('testsPanel'); break;
        case 'KeyI': hud.inspector(car); break;
        case 'KeyM': { const m = !(audio as any)._muted; (audio as any)._muted = m; audio.setMuted(m); hud.toast(m ? 'Muted' : 'Sound on'); break; }
        case 'KeyB': { const order = ['synth', 'samples', 'hybrid'] as const; const nx = order[(order.indexOf(audio.mode) + 1) % 3]; audio.setMode(nx); hud.toast('Sound: ' + nx); break; }
        case 'Backspace': { tests.stop(); const hx = 2 * (veh.q.x * veh.q.z + veh.q.w * veh.q.y), hz = 1 - 2 * (veh.q.x ** 2 + veh.q.y ** 2); veh.reset(veh.pos.x, veh.pos.z, Math.atan2(hx, hz)); hud.toast('Recovered'); break; }
        case 'Escape': tests.stop(); break;
      }
    }
    for (const b of pad) { if (b === 3) camRig.next(); if (b === 2) veh.ignition ? veh.stopEngine() : veh.startEngine(); if (b === 5) veh.shiftManual(+1); if (b === 4) veh.shiftManual(-1); if (b === 9) { const order = ['P', 'R', 'N', 'D'] as const; veh.setSelector(order[(order.indexOf(veh.selector as any) + 1) % 4]); } }
  };
  const toggle = (id: string) => { const el = document.getElementById(id)!; el.style.display = el.style.display === 'block' ? 'none' : 'block'; };
  (window as any).runTest = (k: 'acc' | 'brake' | 'hump') => { tests.start(k, veh); document.getElementById('testsPanel')!.style.display = 'none'; camRig.set(k === 'hump' ? 'wheel' : 'chase'); };
  (window as any).sim = { veh, car, camRig, tests, audio };

  const aState: AudioState = { ignition: false, rpm: 0, throttle: 0, load: 0, boost: 0, speed: 0, gear: 0, shifting: false, tcSlip: 0, wheelSpeed: 0, tyreSlip: [0, 0, 0, 0], tyreLoad: [0, 0, 0, 0], surface: ['asphalt', 'asphalt', 'asphalt', 'asphalt'], brake: 0, absActive: false, impacts: [], bellyScrape: 0, camera: 'exterior', driveMode: '2H' };
  let wasTesting = false;
  function loop() {
    requestAnimationFrame(loop);
    const dt = Math.min(0.05, clock.getDelta());
    fpsS += (1 / Math.max(dt, 1e-3) - fpsS) * 0.05; frame++;
    handleKeys();
    const userIn = input.update(dt, veh.kmh);
    // physics at 1 kHz
    acc += dt; let n = 0; const impacts: AudioState['impacts'] = []; let scrape = 0;
    while (acc >= PHYS_DT && n < 60) {
      const tIn = tests.update(PHYS_DT, veh);
      Object.assign(veh.input, tIn ?? userIn);
      veh.step(PHYS_DT); acc -= PHYS_DT; n++;
      if (veh.impacts.length) impacts.push(...veh.impacts);
      scrape = Math.max(scrape, veh.bellyScrape);
    }
    if (n >= 60) acc = 0;
    if (wasTesting && !tests.active && tests.result) { hud.showResult(tests.result); }
    wasTesting = !!tests.active;
    car.update(veh);
    camRig.update(dt, veh, car);
    for (const o of car.cockpitHide) o.visible = !camRig.interior;
    document.body.classList.toggle('cockpit', camRig.interior);
    world.updateShadow(car.root.position);
    // audio
    const P = veh.P; const tq = P.torqueCurve.v; const tMax = Math.max(...tq.map(x => x[1]));
    Object.assign(aState, {
      ignition: veh.ignition || veh.crankT > 0, rpm: veh.rpm, throttle: veh.input.throttle, load: Math.max(-1, Math.min(1, veh.engineTorque / tMax)), boost: veh.boost, speed: veh.speed,
      gear: veh.selector === 'R' ? -1 : veh.selector === 'P' || veh.selector === 'N' ? 0 : veh.gear, shifting: veh.shiftT > 0, tcSlip: veh.tcSlip,
      wheelSpeed: (Math.abs(veh.wheels[2].omega) + Math.abs(veh.wheels[3].omega)) / 2 * veh.R,
      absActive: veh.absActive, brake: veh.input.brake, bellyScrape: scrape, camera: camRig.interior ? 'interior' : 'exterior', driveMode: veh.driveMode,
    });
    for (let i = 0; i < 4; i++) { aState.tyreSlip[i] = veh.wheels[i].slip; aState.tyreLoad[i] = veh.wheels[i].Fz; }
    aState.surface = veh.audioSurface(); aState.impacts = impacts;
    if (audio.started) audio.update(aState, dt);
    hud.update(dt, veh, { cam: camRig.mode, fps: fpsS, audioMode: audio.started ? audio.mode : 'off', car });
    renderer.render(scene, camRig.cam);
  }
  loop();
}

function refsFrom(research: Record<string, any>) {
  // Collect every measured figure so the test result shows the real spread, not one cherry-picked number.
  const acc: number[] = [], b100: number[] = [], b80: number[] = [];
  for (const [k, v] of Object.entries(research)) {
    if (!v || v.class === 'official' && /hilux/i.test(k)) continue;
    const val = v.value;
    if (typeof val === 'number') {
      if (/^perf_0_100/i.test(k) && !/carwale_listed/i.test(k)) acc.push(val);
      if (/braking_100_0/i.test(k)) b100.push(val);
      if (/braking_80_0/i.test(k) && !/older/i.test(k)) b80.push(val);
    } else if (val && typeof val === 'object' && !Array.isArray(val) && /^perf_/i.test(k)) {
      if (typeof val['0_100'] === 'number') acc.push(val['0_100']);
      if (typeof val['100_0_m'] === 'number') b100.push(val['100_0_m']);
    }
  }
  const rng = (a: number[], u: string) => a.length ? { value: a.length > 1 ? `${Math.min(...a)}–${Math.max(...a)}` : String(a[0]), source: `${a.length} road test${a.length > 1 ? 's' : ''}, research/fortuner_params.json` , unit: u } : undefined;
  return { zeroTo100: rng(acc, 's'), brake100: rng(b100, 'm'), brake80: rng(b80, 'm') } as any;
}

boot().catch(e => { console.error(e); status('Error: ' + e.message); });
