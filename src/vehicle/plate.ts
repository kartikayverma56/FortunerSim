// Indian high-security registration plate (HSRP) as a canvas texture: white reflective plate, black embossed
// characters, raised black rim, blue "IND" strip with a chakra hologram on the left. The registration is made up.
import * as THREE from 'three';

export const PLATE_TEXT = 'MH 12 AB 1234';
export const PLATE_ASPECT = 500 / 120; // standard car plate, mm

export function hsrpTexture(text = PLATE_TEXT) {
  const W = 1024, H = Math.round(W / PLATE_ASPECT);
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d')!;
  // reflective sheet: faint diagonal sheen + a fine dotted retro-reflective pattern
  const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, '#f4f5f2'); bg.addColorStop(0.5, '#ffffff'); bg.addColorStop(1, '#e9eae6');
  g.fillStyle = bg; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(0,0,0,0.035)'; for (let y = 6; y < H; y += 12) for (let x = (y / 12) % 2 ? 6 : 12; x < W; x += 12) g.fillRect(x, y, 2, 2);
  // embossed rim
  const r = 18; g.lineWidth = 9; g.strokeStyle = '#151515';
  g.beginPath(); g.roundRect(8, 8, W - 16, H - 16, r); g.stroke();
  // IND strip
  const sx = 16, sw = 70;
  g.fillStyle = '#1f4fb4'; g.beginPath(); g.roundRect(sx, 14, sw, H - 28, 8); g.fill();
  // chakra hologram (24-spoke wheel)
  const cx = sx + sw / 2, cy = 56, cr = 23;
  g.strokeStyle = '#d7e3ff'; g.lineWidth = 3; g.beginPath(); g.arc(cx, cy, cr, 0, Math.PI * 2); g.stroke();
  g.lineWidth = 1.5; for (let k = 0; k < 24; k++) { const a = k * Math.PI / 12; g.beginPath(); g.moveTo(cx, cy); g.lineTo(cx + Math.cos(a) * cr, cy + Math.sin(a) * cr); g.stroke(); }
  g.save(); g.translate(cx + 2, H - 40); g.rotate(-Math.PI / 2); g.fillStyle = '#ffffff'; g.font = 'bold 34px Arial, sans-serif'; g.textBaseline = 'middle'; g.fillText('IND', 0, 0); g.restore();
  // characters: condensed, embossed (light top-left edge, dark shadow bottom-right)
  const x0 = sx + sw + 18, x1 = W - 34, tw = x1 - x0;
  g.textBaseline = 'middle'; g.textAlign = 'center';
  let size = 176; g.font = `bold ${size}px "Arial Narrow", "Roboto Condensed", Arial, sans-serif`;
  const meas = g.measureText(text).width; const sxs = Math.min(1, tw / meas);
  g.save(); g.translate(x0 + tw / 2, H / 2 + 6); g.scale(sxs, 1);
  g.fillStyle = 'rgba(0,0,0,0.35)'; g.fillText(text, 3, 4);
  g.fillStyle = '#111111'; g.fillText(text, 0, 0);
  g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillText(text, -1.5, -2);
  g.restore();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
