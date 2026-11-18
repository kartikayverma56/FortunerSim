// Driver for audio-test.html: manual sliders, rev sweep, scripted 0-100 auto drive, tuning panel.
import { VehicleAudio, FORTUNER_DRIVELINE } from './VehicleAudio';
import { TUNING_SPEC, defaultTuning } from './tuning';
import type { AudioState, ImpactEvent, Surface } from './types';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const audio = new VehicleAudio();
(window as unknown as { fortunerAudio: VehicleAudio }).fortunerAudio = audio;

const st: AudioState = {
  ignition: false, rpm: 750, throttle: 0, load: 0.08, boost: 0, speed: 0, gear: 0, shifting: false,
  tcSlip: 0, wheelSpeed: 0, tyreSlip: [0, 0, 0, 0], tyreLoad: [5600, 5600, 5000, 5000],
  surface: ['asphalt', 'asphalt', 'asphalt', 'asphalt'], brake: 0, absActive: false, impacts: [],
  bellyScrape: 0, camera: 'exterior', driveMode: '2H',
};
const pendingImpacts: ImpactEvent[] = [];

// ---------------- sliders
interface SliderDef { key: string; label: string; min: number; max: number; step: number; value: number; fmt?: (v: number) => string }
const SLIDERS: SliderDef[] = [
  { key: 'rpm', label: 'rpm', min: 0, max: 4600, step: 10, value: 750 },
  { key: 'throttle', label: 'throttle', min: 0, max: 1, step: 0.01, value: 0 },
  { key: 'load', label: 'load', min: -1, max: 1, step: 0.01, value: 0.08 },
  { key: 'boost', label: 'boost', min: 0, max: 1, step: 0.01, value: 0 },
  { key: 'speed', label: 'speed', min: 0, max: 50, step: 0.1, value: 0, fmt: (v) => `${(v * 3.6).toFixed(0)} km/h` },
  { key: 'gear', label: 'gear', min: -1, max: 6, step: 1, value: 0, fmt: (v) => (v < 0 ? 'R' : v === 0 ? 'N' : String(v)) },
  { key: 'tcSlip', label: 'TC slip', min: 0, max: 1, step: 0.01, value: 0 },
  { key: 'slip', label: 'tyre slip', min: 0, max: 1, step: 0.01, value: 0 },
  { key: 'scrape', label: 'belly scrape', min: 0, max: 1, step: 0.01, value: 0 },
];
const sliderEls: Record<string, { input: HTMLInputElement; out: HTMLOutputElement; def: SliderDef }> = {};
const manual: Record<string, number> = {};

function makeRow(parent: HTMLElement, label: string, min: number, max: number, step: number, value: number,
  fmt: (v: number) => string, onInput: (v: number) => void): { input: HTMLInputElement; out: HTMLOutputElement } {
  const row = document.createElement('div');
  row.className = 'row';
  const lab = document.createElement('label');
  lab.textContent = label;
  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min); input.max = String(max); input.step = String(step); input.value = String(value);
  const out = document.createElement('output');
  out.textContent = fmt(value);
  input.addEventListener('input', () => { const v = Number(input.value); out.textContent = fmt(v); onInput(v); });
  row.append(lab, input, out);
  parent.append(row);
  return { input, out };
}

const defaultFmt = (step: number) => (v: number) => (step >= 1 ? v.toFixed(0) : v.toFixed(2));
for (const d of SLIDERS) {
  manual[d.key] = d.value;
  const fmt = d.fmt ?? defaultFmt(d.step);
  const els = makeRow($('sliders'), d.label, d.min, d.max, d.step, d.value, fmt, (v) => {
    if (d.key === 'speed' || d.key === 'gear') stopAuto(); // manual control takes over
    manual[d.key] = v;
  });
  sliderEls[d.key] = { ...els, def: d };
}
function showSlider(key: string, v: number): void {
  const e = sliderEls[key];
  if (!e) return;
  e.input.value = String(v);
  e.out.textContent = (e.def.fmt ?? defaultFmt(e.def.step))(v);
}

// ---------------- tuning panel
function buildTuning(): void {
  const host = $('tuning');
  host.innerHTML = '';
  const groups = new Map<string, HTMLElement>();
  const cur = audio.getTuning();
  for (const s of TUNING_SPEC) {
    let g = groups.get(s.group);
    if (!g) {
      const det = document.createElement('details');
      if (s.group === 'Mix') det.open = true;
      const sum = document.createElement('summary');
      sum.textContent = s.group;
      det.append(sum);
      host.append(det);
      groups.set(s.group, det);
      g = det;
    }
    const fmt = (v: number) => (s.step >= 1 ? v.toFixed(0) : s.step >= 0.1 ? v.toFixed(1) : v.toFixed(2));
    makeRow(g, s.label, s.min, s.max, s.step, cur[s.key] ?? s.def, fmt, (v) => audio.setTuning({ [s.key]: v }));
  }
}
buildTuning();
$('dumpBtn').addEventListener('click', async () => {
  const json = JSON.stringify(audio.getTuning(), null, 1);
  try { await navigator.clipboard.writeText(json); } catch { /* clipboard blocked */ }
  console.info('[fortuner-audio] tuning', json);
});
$('resetBtn').addEventListener('click', () => { audio.setTuning(defaultTuning()); buildTuning(); });

// ---------------- buttons
let surface: Surface = 'asphalt';
$<HTMLSelectElement>('surfaceSel').addEventListener('change', (e) => { surface = (e.target as HTMLSelectElement).value as Surface; });
$<HTMLSelectElement>('driveSel').addEventListener('change', (e) => { st.driveMode = (e.target as HTMLSelectElement).value as AudioState['driveMode']; });
$<HTMLInputElement>('absChk').addEventListener('change', (e) => { st.absActive = (e.target as HTMLInputElement).checked; });
$<HTMLSelectElement>('modeSel').addEventListener('change', (e) => audio.setMode((e.target as HTMLSelectElement).value as 'synth' | 'samples' | 'hybrid'));

$('startBtn').addEventListener('click', async () => {
  await audio.start();
  $('startBtn').textContent = 'Audio running';
  $('startBtn').classList.remove('primary');
  audio.setMasterVolume(0.8);
});
$('ignBtn').addEventListener('click', () => {
  st.ignition = !st.ignition;
  $('ignBtn').textContent = st.ignition ? 'Ignition ON' : 'Ignition OFF';
  $('ignBtn').classList.toggle('on', st.ignition);
});
$('camBtn').addEventListener('click', () => {
  st.camera = st.camera === 'exterior' ? 'interior' : 'exterior';
  $('camBtn').textContent = `Camera: ${st.camera}`;
});
let muted = false;
$('muteBtn').addEventListener('click', () => {
  muted = !muted;
  audio.setMuted(muted);
  $('muteBtn').classList.toggle('on', muted);
});
$('thumpBtn').addEventListener('click', () => pendingImpacts.push({ wheel: 0, velocity: 1.6, bumpStop: false }));
$('bumpStopBtn').addEventListener('click', () => pendingImpacts.push({ wheel: 1, velocity: 2.5, bumpStop: true }));
$('potholeBtn').addEventListener('click', () => {
  // front pair now, rear pair after the wheelbase has passed
  pendingImpacts.push({ wheel: 0, velocity: 1.9, bumpStop: false }, { wheel: 1, velocity: 1.7, bumpStop: false });
  const v = Math.max(2, st.speed);
  setTimeout(() => pendingImpacts.push({ wheel: 2, velocity: 1.6, bumpStop: false }, { wheel: 3, velocity: 1.5, bumpStop: false }), (2.745 / v) * 1000);
});
$('loadBtn').addEventListener('click', async () => {
  const url = $<HTMLInputElement>('manifestUrl').value;
  $('sampleStatus').textContent = 'loading…';
  const ok = await audio.loadSampleSet(url);
  $('sampleStatus').textContent = ok ? `Loaded loops from ${url}` : `No usable loops at ${url} — synth carries on.`;
});

// ---------------- scripted drivers
type Auto = { kind: 'sweep' | 'drive'; t: number; phase: string; v: number; gear: number; rpm: number; boost: number; shiftT: number } | null;
let auto: Auto = null;
function stopAuto(): void {
  if (!auto) return;
  // leave the sliders where the script ended
  manual.rpm = st.rpm; manual.throttle = st.throttle; manual.load = st.load; manual.boost = st.boost;
  manual.speed = st.speed; manual.gear = st.gear; manual.tcSlip = st.tcSlip;
  auto = null;
}
function ensureRunning(): void {
  if (!st.ignition) $('ignBtn').click();
}
$('sweepBtn').addEventListener('click', () => {
  ensureRunning();
  auto = { kind: 'sweep', t: 0, phase: 'up', v: manual.speed, gear: 0, rpm: 750, boost: 0, shiftT: 0 };
});
$('driveBtn').addEventListener('click', () => {
  ensureRunning();
  auto = { kind: 'drive', t: 0, phase: 'launch', v: 0, gear: 1, rpm: 750, boost: 0, shiftT: 0 };
});
$('stopAutoBtn').addEventListener('click', stopAuto);

const DL = FORTUNER_DRIVELINE;
const MASS = 2350; // kg incl. driver
function torqueNm(rpm: number): number { // 1GD-FTV AT: 500 Nm 1600-2400
  const pts: [number, number][] = [[600, 260], [1000, 330], [1400, 450], [1600, 500], [2400, 500], [3000, 450], [3400, 400], [4000, 330], [4600, 200]];
  if (rpm <= pts[0][0]) return pts[0][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [r0, t0] = pts[i], [r1, t1] = pts[i + 1];
    if (rpm <= r1) return t0 + (t1 - t0) * (rpm - r0) / (r1 - r0);
  }
  return pts[pts.length - 1][1];
}
const coupledRpm = (v: number, gear: number) => (v / (2 * Math.PI * DL.tyreRadius)) * DL.finalDrive * DL.gearRatios[gear - 1] * 60;

function stepAuto(dt: number): void {
  if (!auto) return;
  auto.t += dt;
  if (auto.kind === 'sweep') {
    // idle -> 4400 -> idle over ~6 s, in neutral
    const t = auto.t;
    let rpm: number, thr: number, load: number;
    if (t < 2.4) { const x = t / 2.4; rpm = 750 + (4400 - 750) * (x * x * (3 - 2 * x)); thr = 1; load = 0.45; }
    else if (t < 2.8) { rpm = 4400; thr = 0.6; load = 0.25; }
    else { rpm = 750 + (4400 - 750) * Math.exp(-(t - 2.8) / 0.75); thr = 0; load = rpm > 900 ? -0.3 : 0.08; }
    const bT = thr * 0.35 * Math.min(1, Math.max(0, (rpm - 1400) / 1500));
    auto.boost += (bT - auto.boost) * (1 - Math.exp(-dt / (bT > auto.boost ? 0.5 : 0.25)));
    Object.assign(st, { rpm, throttle: thr, load, boost: auto.boost, gear: 0, tcSlip: 0, shifting: false });
    st.speed = auto.v; st.wheelSpeed = auto.v;
    if (t > 6) stopAuto();
    return;
  }
  // ---- 0-100 km/h, full throttle, 6AT upshift ~3500 rpm, then lift and brake to a stop
  const a = auto;
  let thr = 0, load = 0, brake = 0, tcSlip = 0, shifting = false;
  if (a.phase === 'launch' || a.phase === 'accel') {
    thr = 1;
    const coupled = coupledRpm(a.v, a.gear);
    if (a.shiftT > 0) {
      a.shiftT -= dt;
      shifting = true;
      a.rpm += (coupled - a.rpm) * (1 - Math.exp(-dt / 0.12)); // rpm pulled down to the new gear
    } else {
      // torque converter: stall ~2300 rpm at launch, locks up from 3rd gear
      const stall = a.gear >= 3 ? 0 : 2300 * Math.max(0, 1 - a.v / (a.gear === 1 ? 9 : 16));
      const target = Math.max(coupled + (a.gear >= 3 ? 30 : 120), stall, 800);
      a.rpm += (target - a.rpm) * (1 - Math.exp(-dt / 0.15));
      if (coupled > 3500 && a.gear < 6) { a.gear++; a.shiftT = 0.35; }
    }
    tcSlip = Math.max(0, Math.min(1, 1 - coupled / Math.max(1, a.rpm)));
    const tq = torqueNm(a.rpm) * (0.55 + 0.45 * a.boost) * (shifting ? 0.35 : 1) * (1 + 0.9 * tcSlip);
    const F = (tq * DL.gearRatios[a.gear - 1] * DL.finalDrive * 0.88) / DL.tyreRadius;
    const drag = 0.5 * 1.2 * 1.05 * a.v * a.v + MASS * 9.81 * 0.013;
    a.v = Math.max(0, a.v + ((F - drag) / MASS) * dt);
    load = (torqueNm(a.rpm) * (0.55 + 0.45 * a.boost)) / 500;
    if (a.v >= 100 / 3.6) { a.phase = 'coast'; a.t = 0; }
  } else if (a.phase === 'coast') {
    // lift off: engine braking, turbo hiss
    thr = 0; load = -0.35;
    const drag = 0.5 * 1.2 * 1.05 * a.v * a.v + MASS * 9.81 * 0.013 + 900;
    a.v = Math.max(0, a.v - (drag / MASS) * dt);
    if (coupledRpm(a.v, a.gear) < 1300 && a.gear > 1) a.gear--;
    a.rpm += (Math.max(coupledRpm(a.v, a.gear), 750) - a.rpm) * (1 - Math.exp(-dt / 0.2));
    if (a.t > 3) { a.phase = 'brake'; a.t = 0; }
  } else if (a.phase === 'brake') {
    thr = 0; brake = 0.6; load = a.v > 3 ? -0.2 : 0.05;
    a.v = Math.max(0, a.v - 5.5 * dt);
    if (coupledRpm(a.v, a.gear) < 1100 && a.gear > 1) a.gear--;
    const c = coupledRpm(a.v, a.gear);
    a.rpm += (Math.max(c, 750) - a.rpm) * (1 - Math.exp(-dt / 0.2));
    tcSlip = c < 750 ? Math.min(1, 1 - c / 750) : 0;
    if (a.v <= 0) { a.phase = 'done'; a.t = 0; }
  } else {
    thr = 0; load = 0.08; a.rpm += (750 - a.rpm) * (1 - Math.exp(-dt / 0.3));
    if (a.t > 1.5) { stopAuto(); return; }
  }
  // VNT turbo: spools with rpm and throttle, lags
  const bT = thr * Math.min(1, Math.max(0, (a.rpm - 1200) / 1000));
  a.boost += (bT - a.boost) * (1 - Math.exp(-dt / (bT > a.boost ? 0.6 : 0.3)));
  Object.assign(st, { rpm: a.rpm, throttle: thr, load, boost: a.boost, speed: a.v, wheelSpeed: a.v, gear: a.gear, shifting, tcSlip, brake });
}

// ---------------- frame loop
const canvas = $<HTMLCanvasElement>('spec');
const c2d = canvas.getContext('2d')!;
let specData: Float32Array | null = null;
let lastT = performance.now();

function frame(now: number): void {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  if (auto) {
    stepAuto(dt);
    showSlider('rpm', st.rpm); showSlider('throttle', st.throttle); showSlider('load', st.load);
    showSlider('boost', st.boost); showSlider('speed', st.speed); showSlider('gear', st.gear); showSlider('tcSlip', st.tcSlip);
  } else {
    st.rpm = manual.rpm; st.throttle = manual.throttle; st.load = manual.load; st.boost = manual.boost;
    st.speed = manual.speed; st.gear = manual.gear; st.tcSlip = manual.tcSlip; st.shifting = false; st.brake = 0;
    st.wheelSpeed = manual.speed;
  }
  const slip = manual.slip;
  for (let w = 0; w < 4; w++) { st.tyreSlip[w] = slip; st.surface[w] = surface; }
  // wheelspin: on loose surfaces the driven wheels spin up
  if (slip > 0.05) st.wheelSpeed = st.speed * (1 + slip);
  st.bellyScrape = manual.scrape;
  st.impacts = pendingImpacts.splice(0, pendingImpacts.length);
  audio.update(st, dt);
  draw();
  requestAnimationFrame(frame);
}

function draw(): void {
  const an = audio.analyser;
  const W = canvas.width, H = canvas.height;
  c2d.fillStyle = '#0b0d0f';
  c2d.fillRect(0, 0, W, H);
  c2d.strokeStyle = '#1f262c';
  c2d.fillStyle = '#56616c';
  c2d.font = '20px system-ui';
  const fx = (f: number) => (Math.log(f / 20) / Math.log(16000 / 20)) * W;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = fx(f);
    c2d.beginPath(); c2d.moveTo(x, 0); c2d.lineTo(x, H); c2d.stroke();
    c2d.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x + 4, H - 6);
  }
  if (an) {
    if (!specData || specData.length !== an.frequencyBinCount) specData = new Float32Array(an.frequencyBinCount);
    an.getFloatFrequencyData(specData);
    const sr = audio.audioContext?.sampleRate ?? 48000;
    c2d.strokeStyle = '#e0a040';
    c2d.lineWidth = 2;
    c2d.beginPath();
    let started = false;
    for (let i = 1; i < specData.length; i++) {
      const f = (i * sr) / (2 * specData.length);
      if (f < 20 || f > 16000) continue;
      const db = Math.max(-110, specData[i]);
      const y = H - ((db + 110) / 100) * H;
      const x = fx(f);
      if (!started) { c2d.moveTo(x, y); started = true; } else c2d.lineTo(x, y);
    }
    c2d.stroke();
  }
  const status = [
    `engine ${audio.engineState.padEnd(5)}  audible rpm ${audio.audibleRpm.toFixed(0).padStart(4)}  fire ${(audio.audibleRpm / 30).toFixed(1)} Hz`,
    `gear ${st.gear < 0 ? 'R' : st.gear === 0 ? 'N' : st.gear}${st.shifting ? ' (shifting)' : ''}  ${(st.speed * 3.6).toFixed(0)} km/h  thr ${st.throttle.toFixed(2)}  load ${st.load.toFixed(2)}  boost ${st.boost.toFixed(2)}  tc ${st.tcSlip.toFixed(2)}`,
    `mode ${audio.mode}  samples ${audio.samplesLoaded ? 'loaded' : 'none'}  camera ${st.camera}  ${st.driveMode}  ${surface}${auto ? `  [auto ${auto.kind}: ${auto.phase}]` : ''}`,
  ];
  $('status').textContent = status.join('\n');
}
requestAnimationFrame(frame);
