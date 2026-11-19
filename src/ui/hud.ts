import type { Vehicle } from '../physics/vehicle';
import { zoneLabelAt, SURFACES, humps } from '../world/terrain';
import type { TestRunner, TestResult } from './tests';
import type { CarVisual } from '../vehicle/rig';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class Hud {
  dial = $('dial') as HTMLCanvasElement; g = this.dial.getContext('2d')!;
  chart = $('chart') as HTMLCanvasElement; cg = this.chart.getContext('2d')!;
  gm = $('gmeter') as HTMLCanvasElement; gg = this.gm.getContext('2d')!;
  hist: number[][] = []; showChart = false; private toastT = 0; private acc = 0;

  constructor(private tests: TestRunner) {
    const sel = $('humpSel') as HTMLSelectElement;
    sel.innerHTML = humps.map(h => `<option value="${h.id}">${h.id} · ${h.name}</option>`).join('');
    sel.onchange = () => { tests.humpId = sel.value; };
    const sp = $('humpSpeed') as HTMLInputElement; sp.oninput = () => { tests.humpSpeed = +sp.value; $('humpSpeedV').textContent = sp.value + ' km/h'; };
  }
  /** HUD size: compact (small cluster bottom-right, telemetry panels behind F) → full (original layout) → off. */
  static MODES = ['compact', 'full', 'off'] as const;
  mode: typeof Hud.MODES[number] = 'compact';
  cycleMode() {
    this.mode = Hud.MODES[(Hud.MODES.indexOf(this.mode) + 1) % Hud.MODES.length];
    for (const m of Hud.MODES) document.body.classList.toggle('hud-' + m, m === this.mode);
    return this.mode;
  }
  toast(msg: string, t = 2.5) { const el = $('toast'); el.textContent = msg; el.style.opacity = '1'; this.toastT = t; }

  update(dt: number, veh: Vehicle, extra: { cam: string; fps: number; audioMode: string; car: CarVisual; gfx?: string; indL?: boolean; indR?: boolean }) {
    $('l-indl').classList.toggle('lit', !!extra.indL); $('l-indr').classList.toggle('lit', !!extra.indR);
    if (this.toastT > 0) { this.toastT -= dt; if (this.toastT <= 0) $('toast').style.opacity = '0'; }
    this.acc += dt;
    // telemetry history (20 Hz)
    if (this.acc > 0.05) {
      this.acc = 0;
      this.hist.push([veh.kmh, veh.rpm, veh.accelBody.z / 9.81, veh.accelBody.x / 9.81, -veh.wheels[0].s * 1000, veh.pitch * 57.3, veh.roll * 57.3]);
      if (this.hist.length > 300) this.hist.shift();
      this.drawPanels(veh, extra);
      if (this.showChart) this.drawChart();
    }
    this.drawDial(veh);
    this.drawG(veh);
  }

  private drawPanels(veh: Vehicle, extra: { cam: string; fps: number; audioMode: string; car: CarVisual; gfx?: string }) {
    const w = veh.wheels;
    $('zone').textContent = zoneLabelAt(veh.pos.x, veh.pos.z);
    $('info').innerHTML = [
      `<b>${veh.P.name}</b>`,
      `Mode <b>${veh.driveMode}</b>${veh.rearLocker ? ' · <b class="on">REAR LOCK</b>' : ''} · Selector <b>${veh.selector}</b>${veh.lockup ? ' · TC lock-up' : ''}`,
      `Boost ${(veh.boost * 100).toFixed(0)} % · TC slip ${(veh.tcSlip * 100).toFixed(0)} % · Engine ${veh.engineTorque.toFixed(0)} N·m`,
      `Pitch ${(veh.pitch * 57.3).toFixed(1)}° · Roll ${(veh.roll * 57.3).toFixed(1)}° · Yaw ${(veh.yawRate * 57.3).toFixed(0)}°/s`,
      `Underbody clearance ${(veh.bellyMinClear * 1000).toFixed(0)} mm${veh.bellyScrape > 0 ? ' <b class="warn">SCRAPE</b>' : ''}`,
      `Odometer ${(veh.odometer / 1000).toFixed(2)} km · Cam ${extra.cam} · Sound ${extra.audioMode} · ${extra.fps.toFixed(0)} fps${extra.gfx ? ' · Gfx ' + extra.gfx : ''}`,
    ].join('<br>');
    $('wheels').innerHTML = w.map(x => {
      const travel = x.travelFrac, slip = x.slip;
      const col = slip > 0.55 ? '#ff4d4d' : slip > 0.3 ? '#ffb020' : '#4ade80';
      return `<div class="wh"><div class="wn">${x.name}</div><div class="bar"><div style="height:${(travel * 100).toFixed(0)}%;background:${x.bumpStop ? '#ff4d4d' : '#60a5fa'}"></div></div>
        <div class="wv">${(x.Fz / 1000).toFixed(1)} kN<br><span style="color:${col}">slip ${(slip * 100).toFixed(0)}%</span><br>${SURFACES[x.surface].label.split(' ')[0]}${x.Fz <= 0 ? '<br><b class="warn">AIR</b>' : ''}</div></div>`;
    }).join('');
    const lamp = (id: string, on: boolean) => $(id).classList.toggle('lit', on);
    lamp('l-abs', veh.absActive); lamp('l-vsc', veh.vscActive); lamp('l-trc', veh.trcActive); lamp('l-dac', veh.dacActive || veh.dacOn); lamp('l-hac', veh.hacT > 0);
    lamp('l-4l', veh.driveMode === '4L'); lamp('l-4h', veh.driveMode === '4H'); lamp('l-lock', veh.rearLocker); lamp('l-vscoff', !veh.vscOn);
    $('test-status').textContent = this.tests.status;
  }

  showResult(r: TestResult) {
    const el = $('result');
    el.innerHTML = `<div class="rt">${r.title}<button id="rclose">✕</button></div><table>${r.rows.map(([a, b]) => `<tr><td>${a}</td><td><b>${b}</b></td></tr>`).join('')}</table>
      ${r.series ? `<canvas id="rchart" width="520" height="170"></canvas>` : ''}${r.note ? `<p class="note">${r.note}</p>` : ''}`;
    el.style.display = 'block';
    $('rclose').onclick = () => { el.style.display = 'none'; };
    if (r.series) {
      const c = $('rchart') as HTMLCanvasElement, g = c.getContext('2d')!; const cols = ['#60a5fa', '#f97316', '#4ade80', '#e879f9'];
      g.fillStyle = '#0b0f14'; g.fillRect(0, 0, c.width, c.height);
      const tmax = Math.max(...r.series.flatMap(s => s.t), 0.1);
      r.series.forEach((s, k) => {
        const lo = Math.min(...s.y), hi = Math.max(...s.y), span = hi - lo || 1;
        g.strokeStyle = cols[k]; g.lineWidth = 1.6; g.beginPath();
        s.t.forEach((t, i) => { const x = 8 + t / tmax * (c.width - 16), y = c.height - 18 - (s.y[i] - lo) / span * (c.height - 40); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
        g.fillStyle = cols[k]; g.font = '11px system-ui'; g.fillText(`${s.name} (${lo.toFixed(1)}…${hi.toFixed(1)} ${s.unit})`, 8 + k * 128, 13);
      });
      g.fillStyle = '#94a3b8'; g.fillText(`0 … ${tmax.toFixed(1)} s`, c.width - 70, c.height - 4);
    }
  }

  private drawDial(veh: Vehicle) {
    const g = this.g, W = this.dial.width, H = this.dial.height; g.clearRect(0, 0, W, H);
    const arc = (cx: number, cy: number, r: number, frac: number, max: number, step: number, label: string, value: string, red?: number) => {
      const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
      g.lineWidth = 7; g.strokeStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.arc(cx, cy, r, a0, a1); g.stroke();
      if (red) { g.strokeStyle = 'rgba(239,68,68,0.6)'; g.beginPath(); g.arc(cx, cy, r, a0 + (a1 - a0) * red, a1); g.stroke(); }
      g.strokeStyle = '#38bdf8'; g.beginPath(); g.arc(cx, cy, r, a0, a0 + (a1 - a0) * Math.min(1, frac)); g.stroke();
      g.fillStyle = '#cbd5e1'; g.font = '10px system-ui'; g.textAlign = 'center';
      for (let v = 0; v <= max; v += step) { const a = a0 + (a1 - a0) * v / max; g.fillText(String(v >= 1000 ? v / 1000 : v), cx + Math.cos(a) * (r - 16), cy + Math.sin(a) * (r - 16) + 3); }
      const a = a0 + (a1 - a0) * Math.min(1, frac); g.strokeStyle = '#f97316'; g.lineWidth = 3; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * (r - 4), cy + Math.sin(a) * (r - 4)); g.stroke();
      g.fillStyle = '#fff'; g.font = 'bold 24px system-ui'; g.fillText(value, cx, cy + 34); g.fillStyle = '#94a3b8'; g.font = '11px system-ui'; g.fillText(label, cx, cy + 50);
    };
    arc(92, 92, 76, veh.rpm / 5000, 5000, 1000, 'rpm ×1000', (veh.rpm / 1000).toFixed(1), veh.P.redlineRpm.v / 5000);
    arc(W - 92, 92, 76, veh.kmh / 200, 200, 20, 'km/h', veh.kmh.toFixed(0));
    const gearTxt = veh.selector === 'D' ? `D${veh.gear}` : veh.selector === 'M' ? `M${veh.gear}` : veh.selector;
    g.fillStyle = veh.shiftT > 0 ? '#facc15' : '#fff'; g.font = 'bold 40px system-ui'; g.textAlign = 'center'; g.fillText(gearTxt, W / 2, 80);
    g.font = 'bold 15px system-ui'; g.fillStyle = veh.driveMode === '2H' ? '#94a3b8' : '#4ade80'; g.fillText(veh.driveMode, W / 2, 104);
    g.fillStyle = '#94a3b8'; g.font = '11px system-ui'; g.fillText(veh.ignition ? 'ENGINE ON' : 'ENGINE OFF · Enter', W / 2, 124);
    // pedals
    const ped = (x: number, v: number, col: string, l: string) => { g.fillStyle = 'rgba(255,255,255,0.1)'; g.fillRect(x, 136, 10, 40); g.fillStyle = col; g.fillRect(x, 176 - 40 * v, 10, 40 * v); g.fillStyle = '#94a3b8'; g.fillText(l, x + 5, 188); };
    ped(W / 2 - 34, veh.input.throttle, '#4ade80', 'T'); ped(W / 2 - 5, veh.input.brake, '#ef4444', 'B');
    g.save(); g.translate(W / 2 + 32, 156); g.rotate(-veh.steerWheelAngle); g.strokeStyle = '#cbd5e1'; g.lineWidth = 3; g.beginPath(); g.arc(0, 0, 16, 0, Math.PI * 2); g.moveTo(-16, 0); g.lineTo(16, 0); g.moveTo(0, 0); g.lineTo(0, 16); g.stroke(); g.restore();
  }
  private drawG(veh: Vehicle) {
    const g = this.gg, W = this.gm.width; g.clearRect(0, 0, W, W); const c = W / 2, r = W / 2 - 4;
    g.strokeStyle = 'rgba(255,255,255,0.18)'; g.lineWidth = 1; for (const f of [0.5, 1]) { g.beginPath(); g.arc(c, c, r * f, 0, Math.PI * 2); g.stroke(); }
    g.beginPath(); g.moveTo(c - r, c); g.lineTo(c + r, c); g.moveTo(c, c - r); g.lineTo(c, c + r); g.stroke();
    const ax = -veh.accelBody.x / 9.81, az = veh.accelBody.z / 9.81; // screen: right = car right; up = accel
    g.fillStyle = '#f97316'; g.beginPath(); g.arc(c + ax * r, c - az * r, 5, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#94a3b8'; g.font = '10px system-ui'; g.fillText(`${Math.hypot(ax, az).toFixed(2)} g`, 4, W - 4);
  }
  private drawChart() {
    const g = this.cg, W = this.chart.width, H = this.chart.height; g.fillStyle = 'rgba(8,12,18,0.75)'; g.fillRect(0, 0, W, H);
    const ser = [{ i: 0, name: 'km/h', lo: 0, hi: 160, col: '#60a5fa' }, { i: 1, name: 'rpm', lo: 0, hi: 4500, col: '#f97316' }, { i: 2, name: 'ax g', lo: -1, hi: 1, col: '#4ade80' }, { i: 3, name: 'ay g', lo: -1, hi: 1, col: '#e879f9' }, { i: 4, name: 'FL comp mm', lo: -120, hi: 120, col: '#facc15' }];
    ser.forEach((s, k) => {
      g.strokeStyle = s.col; g.lineWidth = 1.3; g.beginPath();
      this.hist.forEach((h, j) => { const x = j / 300 * W, y = H - 6 - (h[s.i] - s.lo) / (s.hi - s.lo) * (H - 22); j ? g.lineTo(x, y) : g.moveTo(x, y); }); g.stroke();
      g.fillStyle = s.col; g.font = '10px system-ui'; g.fillText(s.name, 6 + k * 64, 11);
    });
  }

  inspector(car: CarVisual) {
    const el = $('inspector'); const r = car.report;
    el.innerHTML = `<div class="rt">Rig inspector<button onclick="this.parentElement.parentElement.style.display='none'">✕</button></div>
      <p>Source: <b>${r.source}</b>${r.file ? ' · ' + r.file : ''}</p>${r.credit ? `<p>Credit: ${r.credit}</p>` : ''}
      ${r.warnings.map(w => `<p class="warn">${w}</p>`).join('')}
      <p><b>Mapped</b></p><pre>${Object.entries(r.mapped).map(([k, v]) => k.padEnd(16) + ' → ' + v).join('\n') || '(none)'}</pre>
      <p><b>All nodes (${r.nodes.length})</b> — to fix a mapping, create <code>assets/rigmap.json</code>, e.g. <code>{"hub_FL":"WheelFrontLeft","steer_FL":"KnuckleFL","rear_axle":"AxleRear","steering_wheel":"SW","needleSign":-1}</code></p>
      <pre style="max-height:220px;overflow:auto">${r.nodes.join('\n')}</pre>`;
    el.style.display = el.style.display === 'block' ? 'none' : 'block';
  }
}
