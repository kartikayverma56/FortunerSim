// Vehicle parameters: Toyota Fortuner 2.8 diesel AT 4x4 (India, 2021 facelift onward).
// Every value carries a class: official | independent | estimate | assumption.
// Sources: research/fortuner_params.json and research/SOURCES.md.
// "assumption" values are typical of body-on-frame SUVs and should be tuned against measured tests.

export type ParamClass = 'official' | 'independent' | 'estimate' | 'assumption';
export interface P<T = number> { v: T; cls: ParamClass; note?: string }
const p = <T,>(v: T, cls: ParamClass, note?: string): P<T> => ({ v, cls, note });

export const FORTUNER = {
  name: 'Toyota Fortuner 2.8 D AT 4x4',
  // ---- geometry (m) ----
  wheelbase: p(2.745, 'official'),
  trackFront: p(1.545, 'official'),
  trackRear: p(1.555, 'official'),
  length: p(4.795, 'official'),
  width: p(1.855, 'official'),
  height: p(1.835, 'official'),
  overhangFront: p(0.99, 'official'),
  overhangRear: p(1.06, 'official'),
  groundClearance: p(0.225, 'independent', 'Autocar India; PK/MY official 279 mm is a different measure'),
  approachDeg: p(29.2, 'official'),
  departureDeg: p(25.2, 'official'),
  rampOverDeg: p(23.5, 'independent'),
  // ---- mass ----
  kerbMass: p(2160, 'official', 'Toyota Malaysia 4x4 AT; range across markets 2100–2220 kg; India publishes GVW 2735 only'),
  driverMass: p(75, 'assumption'),
  frontAxleShare: p(0.53, 'assumption'),
  cgHeight: p(0.80, 'assumption', 'not published; axle-lift test needed'),
  unsprungFront: p(55, 'assumption', 'per corner: wheel, tyre, knuckle, brake, half arms'),
  unsprungRear: p(130, 'assumption', 'whole live axle incl. both wheels'),
  inertiaRoll: p(850, 'estimate', 'k-factor method (Doc D §2.2), kg·m²'),
  inertiaPitch: p(3900, 'estimate'),
  inertiaYaw: p(4200, 'estimate'),
  // ---- suspension (wheel rates) ----
  springFront: p(40000, 'estimate', 'N/m wheel rate for ~1.4 Hz ride'),
  springRear: p(46000, 'estimate', 'N/m wheel rate for ~1.6 Hz ride'),
  damperBumpFront: p(2000, 'assumption', 'N·s/m, low-speed'),
  damperReboundFront: p(4600, 'assumption'),
  damperBumpRear: p(2300, 'assumption'),
  damperReboundRear: p(5200, 'assumption'),
  damperKneeVel: p(0.25, 'assumption', 'm/s; digressive above'),
  arbFront: p(26000, 'assumption', 'N/m equivalent wheel-rate difference'),
  arbRear: p(9000, 'assumption'),
  bumpTravelFront: p(0.085, 'assumption', 'm from static to bump-stop contact'),
  droopTravelFront: p(0.105, 'assumption'),
  bumpTravelRear: p(0.115, 'assumption'),
  droopTravelRear: p(0.125, 'assumption'),
  bumpStopRate: p(2.5e6, 'assumption', 'N/m², progressive k·x²'),
  // ---- tyres: 265/60 R18 ----
  tyreRadius: p(0.3876, 'estimate', 'unloaded, from 265/60 R18'),
  tyreVerticalStiffness: p(290000, 'assumption', 'N/m at ~2.2 bar'),
  tyreVerticalDamping: p(400, 'assumption'),
  tyreWidth: p(0.265, 'official'),
  wheelInertia: p(2.2, 'assumption', 'kg·m² wheel+tyre+disc'),
  muPeak: p(0.95, 'assumption', 'HT tyre on dry asphalt, scaled per surface'),
  slipPeak: p(0.11, 'assumption'),
  slipAnglePeakDeg: p(8, 'assumption'),
  mfC: p(1.35, 'assumption', 'Magic Formula shape factor'),
  relaxLenLong: p(0.30, 'assumption', 'm'),
  relaxLenLat: p(0.55, 'assumption', 'm'),
  loadSensitivity: p(0.12, 'assumption'),
  rollingResistance: p(0.012, 'assumption', 'on asphalt'),
  // ---- engine 1GD-FTV ----
  idleRpm: p(750, 'assumption'),
  redlineRpm: p(4600, 'independent', 'max engine speed, low confidence'),
  // [rpm, full-load torque N·m]; AT peak 500 N·m @1600–2800, 204 PS @3000–3400
  torqueCurve: p<[number, number][]>([
    [600, 190], [750, 220], [1000, 330], [1200, 411], [1400, 460], [1600, 500], [2800, 500],
    [3000, 477], [3200, 448], [3400, 421], [3800, 360], [4200, 285], [4600, 200],
  ], 'estimate', 'official 500 N·m @1600–2800 and 150 kW @3000–3400; below 1200 / above 3400 assumed'),
  naTorqueFraction: p(0.42, 'assumption', 'torque available with zero boost'),
  engineInertia: p(0.28, 'assumption', 'kg·m² incl. flexplate & TC pump'),
  frictionTorque0: p(22, 'assumption', 'N·m motoring at idle'),
  frictionTorquePerKrpm: p(14, 'assumption'),
  turboSpoolRpm: p<[number, number]>([1100, 1800], 'assumption'),
  turboLagLow: p(0.55, 'assumption', 's time constant at low rpm'),
  turboLagHigh: p(0.18, 'assumption'),
  // ---- transmission 6AT ----
  gearRatios: p([3.600, 2.090, 1.488, 1.000, 0.687, 0.580], 'official', 'Aisin AC60F (Toyota Hilux spec; drom.ru confirms for Fortuner)'),
  reverseRatio: p(3.732, 'official'),
  finalDrive: p(3.909, 'independent'),
  lowRange: p(2.566, 'estimate', 'from published 36.1:1 crawl ratio'),
  driveEff: p(0.90, 'assumption'),
  tcStallRpm: p(2400, 'assumption'),
  tcStallTorqueRatio: p(2.0, 'assumption'),
  tcCouplingPoint: p(0.85, 'assumption'),
  shiftTime: p(0.32, 'assumption', 's'),
  // ---- brakes ----
  brakeTorqueFront: p(3300, 'estimate', 'N·m per wheel at full pedal'),
  brakeTorqueRear: p(1900, 'estimate', 'ventilated rear discs (official); 312 mm low confidence'),
  // ---- steering ----
  steerRatio: p(19.5, 'assumption'),
  steerLockToLock: p(3.5, 'assumption', 'turns'),
  maxRoadWheelDeg: p(33, 'estimate', 'inner wheel, from 5.8 m turning radius'),
  turningRadius: p(5.8, 'official'),
  // ---- aero ----
  cd: p(0.394, 'estimate', 'Hilux official Cd used as proxy'),
  frontalArea: p(2.89, 'estimate'),
  // ---- fuel ----
  fuelTank: p(80, 'official', 'L'),
};

export type VehicleParams = typeof FORTUNER;

/** Merge numeric overrides from research/fortuner_params.json when keys match (value only). */
export function applyOverrides(target: VehicleParams, json: Record<string, { value: unknown; class?: string }>) {
  const map: Record<string, keyof VehicleParams> = {
    final_drive_AT: 'finalDrive', transfer_low_ratio: 'lowRange', gear_ratios_AT: 'gearRatios', reverse_ratio_AT: 'reverseRatio',
    drag_coefficient_Cd: 'cd', frontal_area_m2: 'frontalArea', turning_radius_m: 'turningRadius', approach_angle_deg: 'approachDeg',
    departure_angle_deg: 'departureDeg', rampover_angle_deg: 'rampOverDeg', steering_ratio_overall: 'steerRatio',
  };
  for (const [k, key] of Object.entries(map)) {
    const e = json[k]; if (!e || e.value == null || typeof e.value === 'string') continue;
    (target as any)[key] = { v: e.value, cls: (e.class as ParamClass) || 'independent', note: 'from research json' };
  }
}
