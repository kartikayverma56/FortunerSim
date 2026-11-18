// Tuning knobs for the Fortuner audio engine. Everything here can be changed live with
// VehicleAudio.setTuning({...}); audio-test.html builds its tuning panel from TUNING_SPEC.
//
// target 'worklet' -> sent to engine-worklet.js (DSP constants)
// target 'main'    -> applied on the main thread (native node gains/filters, state machine, sample mixing)

export interface TuningSpec {
  key: string;
  label: string;
  group: string;
  min: number;
  max: number;
  step: number;
  def: number;
  target: 'worklet' | 'main';
}

const W = 'worklet' as const;
const M = 'main' as const;

export const TUNING_SPEC: readonly TuningSpec[] = [
  // ---- layer mix (native gains)
  { key: 'coreGain', label: 'Engine core (synth)', group: 'Mix', min: 0, max: 2, step: 0.01, def: 1, target: M },
  { key: 'detailGain', label: 'Clatter / mech detail', group: 'Mix', min: 0, max: 3, step: 0.01, def: 1, target: M },
  { key: 'turboGain', label: 'Turbo', group: 'Mix', min: 0, max: 3, step: 0.01, def: 1, target: M },
  { key: 'drivelineGain', label: 'Driveline / starter', group: 'Mix', min: 0, max: 3, step: 0.01, def: 1, target: M },
  { key: 'roadGain', label: 'Road / chassis', group: 'Mix', min: 0, max: 3, step: 0.01, def: 1, target: M },
  { key: 'sampleGain', label: 'Recorded loops', group: 'Mix', min: 0, max: 3, step: 0.01, def: 1, target: M },
  { key: 'hybridSynthCore', label: 'Hybrid: synth core under samples', group: 'Mix', min: 0, max: 1, step: 0.01, def: 0.25, target: M },
  { key: 'hybridDetail', label: 'Hybrid: synth clatter over samples', group: 'Mix', min: 0, max: 1.5, step: 0.01, def: 0.8, target: M },

  // ---- combustion + exhaust
  { key: 'exhaustLevel', label: 'Exhaust level', group: 'Engine', min: 0, max: 2, step: 0.01, def: 1, target: W },
  { key: 'exhaustPipeMs', label: 'Header comb delay (ms)', group: 'Engine', min: 0.5, max: 12, step: 0.1, def: 3.4, target: W },
  { key: 'exhaustPipeFb', label: 'Header comb feedback', group: 'Engine', min: 0, max: 0.9, step: 0.01, def: 0.42, target: W },
  { key: 'tailpipeMs', label: 'Tailpipe 1/4-wave delay (ms)', group: 'Engine', min: 1, max: 25, step: 0.1, def: 7.6, target: W },
  { key: 'tailpipeFb', label: 'Tailpipe feedback', group: 'Engine', min: 0, max: 0.9, step: 0.01, def: 0.4, target: W },
  { key: 'mufflerHz', label: 'Muffler low-pass (Hz)', group: 'Engine', min: 120, max: 2000, step: 5, def: 360, target: W },
  { key: 'bodyRes1Hz', label: 'Body mode 1 (Hz)', group: 'Engine', min: 40, max: 200, step: 1, def: 88, target: W },
  { key: 'bodyRes2Hz', label: 'Body mode 2 (Hz)', group: 'Engine', min: 100, max: 400, step: 1, def: 168, target: W },
  { key: 'bodyRes3Hz', label: 'Body mode 3 (Hz)', group: 'Engine', min: 200, max: 800, step: 1, def: 305, target: W },
  { key: 'bodyResDb', label: 'Body mode gain (dB)', group: 'Engine', min: 0, max: 12, step: 0.1, def: 5, target: W },
  { key: 'growl', label: 'On-load growl (saturation)', group: 'Engine', min: 0, max: 2, step: 0.01, def: 0.6, target: W },
  { key: 'flowNoise', label: 'Exhaust gas-flow noise', group: 'Engine', min: 0, max: 1.5, step: 0.01, def: 0.35, target: W },
  { key: 'blockLevel', label: 'Block radiation (mid band)', group: 'Engine', min: 0, max: 2, step: 0.01, def: 0.55, target: W },
  { key: 'structLevel', label: 'Structure-borne orders', group: 'Engine', min: 0, max: 2, step: 0.01, def: 0.5, target: W },
  { key: 'intakeLevel', label: 'Intake level', group: 'Engine', min: 0, max: 2, step: 0.01, def: 0.6, target: W },
  { key: 'intakeResHz', label: 'Airbox resonance (Hz)', group: 'Engine', min: 60, max: 400, step: 1, def: 145, target: W },
  { key: 'imbalance', label: 'Cylinder imbalance', group: 'Engine', min: 0, max: 3, step: 0.01, def: 1, target: W },
  { key: 'jitter', label: 'Cycle-to-cycle jitter', group: 'Engine', min: 0, max: 3, step: 0.01, def: 1, target: W },
  { key: 'burble', label: 'Overrun burble', group: 'Engine', min: 0, max: 1.5, step: 0.01, def: 0.5, target: W },

  // ---- diesel clatter
  { key: 'pilotGapMs', label: 'Pilot -> main gap (ms)', group: 'Clatter', min: 0.2, max: 2.5, step: 0.05, def: 0.8, target: W },
  { key: 'pilotLevel', label: 'Pilot injection knock', group: 'Clatter', min: 0, max: 1.5, step: 0.01, def: 0.5, target: W },
  { key: 'clatterHz', label: 'Block resonance base (Hz)', group: 'Clatter', min: 500, max: 2500, step: 10, def: 1150, target: W },
  { key: 'clatterDecayMs', label: 'Clatter ring (ms)', group: 'Clatter', min: 0.2, max: 4, step: 0.05, def: 1.1, target: W },
  { key: 'clatterLoadFactor', label: 'Clatter reduction under load', group: 'Clatter', min: 0, max: 1, step: 0.01, def: 0.45, target: W },
  { key: 'valveTick', label: 'Valvetrain tick', group: 'Clatter', min: 0, max: 1.5, step: 0.01, def: 0.25, target: W },

  // ---- turbo
  { key: 'whistleMinHz', label: 'Whistle @ 0 boost (Hz)', group: 'Turbo', min: 800, max: 6000, step: 10, def: 2300, target: W },
  { key: 'whistleMaxHz', label: 'Whistle @ full boost (Hz)', group: 'Turbo', min: 2000, max: 14000, step: 10, def: 7400, target: W },
  { key: 'whistleLevel', label: 'Whistle level', group: 'Turbo', min: 0, max: 2, step: 0.01, def: 0.5, target: W },
  { key: 'hissLevel', label: 'Lift-off hiss', group: 'Turbo', min: 0, max: 2, step: 0.01, def: 0.6, target: W },

  // ---- driveline
  { key: 'whineLevel', label: 'Gear / diff whine', group: 'Driveline', min: 0, max: 3, step: 0.01, def: 0.5, target: W },
  { key: 'pinionTeeth', label: 'Diff pinion teeth', group: 'Driveline', min: 6, max: 16, step: 1, def: 10, target: W },
  { key: 'transTeeth', label: 'Gearbox mesh teeth', group: 'Driveline', min: 15, max: 60, step: 1, def: 31, target: W },
  { key: 'tcaseTeeth', label: 'Transfer (4L) teeth', group: 'Driveline', min: 12, max: 50, step: 1, def: 24, target: W },
  { key: 'tcChurnLevel', label: 'Torque-converter churn', group: 'Driveline', min: 0, max: 2, step: 0.01, def: 0.5, target: W },
  { key: 'tcFlareRpm', label: 'TC flare (rpm @ full slip)', group: 'Driveline', min: 0, max: 800, step: 10, def: 0, target: M },
  { key: 'starterLevel', label: 'Starter motor', group: 'Driveline', min: 0, max: 2, step: 0.01, def: 0.8, target: W },
  { key: 'crankTime', label: 'Crank time (s)', group: 'Driveline', min: 0.3, max: 2.5, step: 0.05, def: 0.9, target: M },
  { key: 'catchFlareRpm', label: 'Start flare (rpm)', group: 'Driveline', min: 0, max: 900, step: 10, def: 380, target: M },

  // ---- road / chassis
  { key: 'tyreLevel', label: 'Tyre rolling', group: 'Road', min: 0, max: 3, step: 0.01, def: 1, target: W },
  { key: 'squealLevel', label: 'Tyre squeal', group: 'Road', min: 0, max: 3, step: 0.01, def: 1, target: W },
  { key: 'windLevel', label: 'Wind', group: 'Road', min: 0, max: 3, step: 0.01, def: 1, target: W },
  { key: 'gustDepth', label: 'Wind gust depth', group: 'Road', min: 0, max: 0.9, step: 0.01, def: 0.3, target: W },
  { key: 'impactLevel', label: 'Suspension impacts', group: 'Road', min: 0, max: 3, step: 0.01, def: 1, target: W },
  { key: 'scrapeLevel', label: 'Underbody scrape', group: 'Road', min: 0, max: 3, step: 0.01, def: 1, target: W },
  { key: 'absLevel', label: 'ABS buzz', group: 'Road', min: 0, max: 3, step: 0.01, def: 0.6, target: W },
  { key: 'grainRate', label: 'Gravel grain density', group: 'Road', min: 0.1, max: 4, step: 0.01, def: 1, target: W },
  { key: 'jointSpacing', label: 'Concrete joint spacing (m)', group: 'Road', min: 1, max: 15, step: 0.1, def: 4.5, target: W },
  { key: 'rumbleSpacing', label: 'Rumble strip pitch (m)', group: 'Road', min: 0.1, max: 1, step: 0.01, def: 0.3, target: W },

  // ---- cabin vs exterior
  { key: 'cabinLowpassHz', label: 'Cabin engine low-pass (Hz)', group: 'Cabin', min: 300, max: 6000, step: 10, def: 1700, target: M },
  { key: 'cabinRoadLowpassHz', label: 'Cabin road low-pass (Hz)', group: 'Cabin', min: 200, max: 6000, step: 10, def: 950, target: M },
  { key: 'cabinBoomHz', label: 'Cabin boom (Hz)', group: 'Cabin', min: 30, max: 90, step: 1, def: 50, target: M },
  { key: 'cabinBoomDb', label: 'Cabin boom gain (dB)', group: 'Cabin', min: 0, max: 15, step: 0.1, def: 7, target: M },
  { key: 'cabinGainDb', label: 'Cabin overall (dB)', group: 'Cabin', min: -20, max: 6, step: 0.1, def: -6, target: M },
  { key: 'extBrightDb', label: 'Exterior brightness (dB @3k)', group: 'Cabin', min: -6, max: 9, step: 0.1, def: 2, target: M },

  // ---- sample layer crossfade
  { key: 'sampleOffLoad', label: 'Samples: 100% off-load at load', group: 'Samples', min: -1, max: 0.5, step: 0.01, def: -0.1, target: M },
  { key: 'sampleOnLoad', label: 'Samples: 100% on-load at load', group: 'Samples', min: 0, max: 1, step: 0.01, def: 0.6, target: M },
  { key: 'samplePitchClamp', label: 'Samples: max pitch shift', group: 'Samples', min: 0.02, max: 0.5, step: 0.01, def: 0.2, target: M },

  { key: 'idleRpm', label: 'Idle rpm (fallback)', group: 'Engine', min: 500, max: 1100, step: 10, def: 750, target: M },
];

export type Tuning = Record<string, number>;

export function defaultTuning(): Tuning {
  const t: Tuning = {};
  for (const s of TUNING_SPEC) t[s.key] = s.def;
  return t;
}

export function workletTuning(t: Tuning): Tuning {
  const out: Tuning = {};
  for (const s of TUNING_SPEC) if (s.target === 'worklet' && s.key in t) out[s.key] = t[s.key];
  return out;
}
