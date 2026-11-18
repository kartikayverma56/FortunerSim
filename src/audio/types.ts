// Contract between the vehicle simulation and the audio engine.
// The sim fills one AudioState per rendered frame; VehicleAudio.update() consumes it.

export type Surface = 'asphalt' | 'concrete' | 'broken' | 'gravel' | 'mud' | 'sand' | 'wet' | 'rumble';

export interface ImpactEvent {
  wheel: 0 | 1 | 2 | 3;      // 0 FL, 1 FR, 2 RL, 3 RR
  velocity: number;          // m/s, suspension closing speed at the impact (positive = compression)
  bumpStop: boolean;         // true when the bump stop was reached
}

export interface AudioState {
  ignition: boolean;         // engine running
  rpm: number;               // crankshaft rpm (idle ≈ 750, redline ≈ 4400 for the 1GD-FTV)
  throttle: number;          // 0..1 pedal position
  load: number;              // -1..1  engine torque / max torque at this rpm (negative = engine braking)
  boost: number;             // 0..1  turbo boost fraction (lags throttle; spools with rpm)
  speed: number;             // m/s, vehicle speed
  gear: number;              // -1 R, 0 N/P, 1..6
  shifting: boolean;         // true during a gear change (torque interruption)
  tcSlip: number;            // 0..1 torque-converter slip (high at launch)
  wheelSpeed: number;        // m/s, average driven-wheel surface speed
  tyreSlip: number[];        // 4 values 0..1, combined slip (0 = rolling, 1 = fully sliding)
  tyreLoad: number[];        // 4 values, N
  surface: Surface[];        // 4 values, surface under each wheel
  brake: number;             // 0..1
  absActive: boolean;
  impacts: ImpactEvent[];    // suspension impacts since the last frame
  bellyScrape: number;       // 0..1 underbody contact intensity this frame
  camera: 'exterior' | 'interior';
  driveMode: '2H' | '4H' | '4L';
}

export interface VehicleAudioApi {
  /** Must be called from a user gesture (browser autoplay policy). */
  start(): Promise<void>;
  update(s: AudioState, dt: number): void;
  setMode(mode: 'synth' | 'samples' | 'hybrid'): void;
  /** Loads recorded loops described by a manifest (see public/audio/engine/README.md). Resolves false if missing. */
  loadSampleSet(manifestUrl: string): Promise<boolean>;
  setMasterVolume(v: number): void;
  setMuted(m: boolean): void;
  readonly started: boolean;
  readonly mode: 'synth' | 'samples' | 'hybrid';
}
