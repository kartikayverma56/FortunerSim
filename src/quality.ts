// Graphics quality: Low / Medium / High, plus Auto (guess from the GPU, then step down if fps stays low).
// Anti-aliasing, soft shadows and the car model are fixed when the page loads; the rest changes live.

export type Level = 'low' | 'medium' | 'high';
export type Choice = 'auto' | Level;
export const LEVELS: Level[] = ['low', 'medium', 'high'];

export interface Preset {
  model: 'showroom' | 'phone'; // which GLB to load (563 k vs 204 k triangles)
  aa: boolean;                 // MSAA (load time only)
  softShadows: boolean;        // PCFSoft vs PCF (load time only)
  maxPixelRatio: number;       // cap on devicePixelRatio
  renderScale: number;         // < 1 renders below screen resolution
  shadowSize: number;          // sun shadow map, px
  treeShadows: boolean;        // trees and lamp posts cast shadows
  treeFrac: number;            // share of the 1400 trees drawn
  mirrors: 0 | 1 | 2;          // live rear-view mirrors: 0 tinted glass, 1 low-res (384×192 atlas), 2 sharper and faster (512×256)
}

export const PRESETS: Record<Level, Preset> = {
  high: { model: 'showroom', aa: true, softShadows: true, maxPixelRatio: 1.5, renderScale: 1, shadowSize: 2048, treeShadows: true, treeFrac: 1, mirrors: 2 },
  medium: { model: 'phone', aa: true, softShadows: false, maxPixelRatio: 1, renderScale: 1, shadowSize: 1024, treeShadows: false, treeFrac: 1, mirrors: 1 },
  low: { model: 'phone', aa: false, softShadows: false, maxPixelRatio: 1, renderScale: 0.8, shadowSize: 1024, treeShadows: false, treeFrac: 0.5, mirrors: 0 },
};

export const pixelRatioFor = (p: Preset) => Math.min(devicePixelRatio, p.maxPixelRatio) * p.renderScale;
export const lowerLevel = (l: Level): Level | null => (l === 'high' ? 'medium' : l === 'medium' ? 'low' : null);
export const nextChoice = (c: Choice): Choice => (['auto', 'low', 'medium', 'high'] as Choice[])[((['auto', 'low', 'medium', 'high'] as Choice[]).indexOf(c) + 1) % 4];

const KEY = 'fsim.quality';

/** URL ?q= wins (old ?q=phone / ?q=showroom still work), then the saved choice, else Auto. */
export function readChoice(): Choice {
  const q = new URLSearchParams(location.search).get('q');
  if (q === 'phone') return 'low';
  if (q === 'showroom') return 'high';
  if (q === 'auto' || LEVELS.includes(q as Level)) return q as Choice;
  try { const s = localStorage.getItem(KEY); if (s === 'auto' || LEVELS.includes(s as Level)) return s as Choice; } catch { /* storage blocked */ }
  return 'auto';
}
export function saveChoice(c: Choice) { try { localStorage.setItem(KEY, c); } catch { /* storage blocked */ } }

/** Starting level from the GPU name. Integrated graphics start at Medium; Auto then steps down if needed. */
export function detectLevel(): { level: Level; gpu: string } {
  let gpu = '';
  try {
    const c = document.createElement('canvas');
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      gpu = String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  } catch { /* no WebGL info */ }
  if (matchMedia('(pointer:coarse)').matches || /swiftshader|llvmpipe|software|mali|adreno|powervr/i.test(gpu)) return { level: 'low', gpu };
  if (/nvidia|geforce|quadro|radeon rx|radeon pro|arc\(tm\) a|apple m\d (pro|max|ultra)/i.test(gpu)) return { level: 'high', gpu };
  return { level: 'medium', gpu };
}

/** Short GPU label for the start screen, e.g. "Intel(R) Iris(R) Xe Graphics". */
export const gpuLabel = (gpu: string) => (gpu.match(/ANGLE \([^,]*, ([^,]+?)(?: \(0x|,| Direct3D|$)/)?.[1] ?? gpu).trim();
