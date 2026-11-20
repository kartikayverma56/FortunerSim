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
  driverSeatX: p(0, 'assumption', 'driver mass position across the car for the CG, m from the centreline (+ = left). 0 = lumped on the centreline (default, symmetric car). The real RHD seat is at −0.38: the CG then sits 13 mm right of centre, the right wheels carry ~160 N more at rest, and the drive force (on the centreline) yaws the car right: 1.3 m in a 10 s full-throttle launch, 0.17 m in 10 s at 100 km/h (tools/straighttest.ts). Real drivers trim that with < 1° of handwheel; keyboard steering cannot, so it reads as bad alignment'),
  frontAxleShare: p(0.53, 'assumption'),
  cgHeight: p(0.74, 'assumption', 'not published; axle-lift test needed. 0.74 = user decision (Stage 1b): the 2010 4Runner "no-tip" class and the crashtest CG sweep 0.72–0.84 (0.80 and up rolled in J-turns with VSC off)'),
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
  arbFront: p(80000, 'assumption', 'N/m equivalent wheel-rate difference. Re-tuned with Fix A for a ~60 % front share of lateral load transfer (mild understeer), roll ≈ 4.8°/g; was 26000'),
  arbRear: p(0, 'assumption', 'none: the lateral-rod roll centre already gives the rear its geometric share; was 9000'),
  bumpTravelFront: p(0.085, 'assumption', 'm from static to bump-stop contact'),
  droopTravelFront: p(0.105, 'assumption'),
  bumpTravelRear: p(0.115, 'assumption'),
  droopTravelRear: p(0.125, 'assumption'),
  bumpStopRate: p(2.5e6, 'assumption', 'N/m², progressive k·x²'),
  // ---- suspension geometry (were hard-coded in vehicle.ts) ----
  rollCentreFront: p(0.18, 'assumption', 'm above ground; double wishbone (was 0.12)'),
  rollCentreRear: p(0.30, 'assumption', 'm above ground; 4-link live axle + lateral rod (was 0.45: the rear then took most of the geometric transfer and the car spun at 0.55 g)'),
  antiDiveFront: p(0.25, 'assumption', 'longitudinal force applied at this fraction of CG height'),
  antiSquatRear: p(0.35, 'assumption', 'longitudinal force applied at this fraction of CG height'),
  jackingForces: p(true, 'assumption', 'Fix A: geometric load transfer Fy·hRC/(t/2) through the links. Flag kept for one release so it can be compared off/on'),
  vscRollG: p(0.75, 'assumption', 'VSC roll mitigation: lateral g above which the outer front is braked while the body rolls outward'),
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
  loadSensitivityMin: p(0.3, 'assumption', 'floor of the load-sensitivity factor; active above ~37 kN (rim contact), keeps μ positive'),
  rimRadius: p(0.24, 'estimate', 'm, 18 in rim incl. flange; a kerb taller than the rim bottom strikes the rim'),
  kerbCarcassRate: p(2e5, 'assumption', 'N/m lateral, tyre sidewall pressed by a step beside the tyre'),
  kerbRimRate: p(4e6, 'assumption', 'N/m lateral, rim flange on the step face'),
  kerbSidewallBulge: p(0.03, 'assumption', 'm of sidewall deflection before the rim flange touches the face'),
  // soft-ground plough: extra lateral force limit (μ + plough)·Fz when the tyre slides sideways (slip 20–50°, > 2 m/s lateral)
  plough: p<Record<string, number>>({ asphalt: 0, concrete: 0, broken: 0, rumble: 0, wet: 0, gravel: 0.10, grass: 0.15, mud: 0.70, sand: 0.80 },
    'assumption', 'soil berm in front of a sideways-sliding tyre; trips the car in sand and mud. Gravel/grass lowered from 0.30/0.35 (Stage 1b): a 38 km/h handbrake turn on gravel rolled the car'),
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
  // ---- body collision hull (upper body; the 22 belly points stay in vehicle.ts) ----
  // Body frame: +X left, +Y up, +Z forward, origin at the CG. Positions from official L/W/H and typical proportions;
  // to be fitted once to the GLB (Stage 2: sim.fitHull()) and pasted back here.
  hullPoints: p<[number, number, number, HullZone][]>([
    // front: bumper centre, corners, bonnet lip
    [0, -0.15, 2.28, 'front'], [0.80, -0.20, 2.12, 'front'], [-0.80, -0.20, 2.12, 'front'],
    [0, 0.25, 2.22, 'front'], [0.75, 0.22, 2.05, 'front'], [-0.75, 0.22, 2.05, 'front'],
    // bonnet, cowl
    [0, 0.33, 1.70, 'front'], [0.70, 0.35, 1.25, 'front'], [-0.70, 0.35, 1.25, 'front'],
    // A-pillar mid
    [0.72, 0.68, 0.85, 'roofRail'], [-0.72, 0.68, 0.85, 'roofRail'],
    // roof: header, B / C / D tops, centre panel, rear header
    [0, 1.03, 0.50, 'roofRail'], [0.60, 1.00, 0.50, 'roofRail'], [-0.60, 1.00, 0.50, 'roofRail'],
    [0.63, 1.035, -0.35, 'roofRail'], [-0.63, 1.035, -0.35, 'roofRail'],
    [0.63, 1.03, -1.25, 'roofRail'], [-0.63, 1.03, -1.25, 'roofRail'],
    [0.60, 0.98, -2.10, 'roofRail'], [-0.60, 0.98, -2.10, 'roofRail'],
    [0, 1.035, -0.80, 'roofPanel'], [0, 1.00, -2.15, 'roofRail'],
    // sides: doors and quarters
    [0.92, 0.22, 1.00, 'door'], [-0.92, 0.22, 1.00, 'door'], [0.9275, 0.20, -0.20, 'door'], [-0.9275, 0.20, -0.20, 'door'],
    [0.92, 0.22, -1.40, 'door'], [-0.92, 0.22, -1.40, 'door'], [0.88, 0.25, -2.20, 'door'], [-0.88, 0.25, -2.20, 'door'],
    // mirrors
    [1.05, 0.33, 0.95, 'mirror'], [-1.05, 0.33, 0.95, 'mirror'],
    // arch flares
    [0.93, -0.02, 1.29, 'sill'], [-0.93, -0.02, 1.29, 'sill'], [0.93, -0.02, -1.455, 'sill'], [-0.93, -0.02, -1.455, 'sill'],
    // sills
    [0.90, -0.45, 0.50, 'sill'], [-0.90, -0.45, 0.50, 'sill'], [0.90, -0.45, -0.60, 'sill'], [-0.90, -0.45, -0.60, 'sill'],
    // rear: bumper, corners, tailgate
    [0, -0.15, -2.515, 'sill'], [0.82, -0.20, -2.38, 'sill'], [-0.82, -0.20, -2.38, 'sill'], [0, 0.35, -2.50, 'sill'],
  ], 'estimate', 'from official length/width/height and typical proportions; fit to the GLB'),
  // tyre sidewall points per wheel, on the outboard face: [fore/aft offset along the wheel heading, up offset] from the wheel centre
  hullTyrePoints: p<[number, number][]>([[0.27, 0], [-0.27, 0], [0, 0.30]], 'assumption'),
  // elastic-plastic contact law per zone: ke elastic N/m, Fy yield N, kp plastic hardening N/m, maxCrush m (then rigid at ke)
  hullZones: p<Record<HullZone, HullZoneSpec>>({
    front: { ke: 1.2e7, Fy: 20e3, kp: 2.5e5, maxCrush: 0.9 },    // per point; a rigid wall loads ~6 of them: 56 km/h → 0.5–0.7 m at 18–25 g mean [M]
    roofRail: { ke: 1.2e7, Fy: 30e3, kp: 7e5, maxCrush: 0.35 },  // roof ≈ 3.5 × weight within 127 mm [A, M]
    roofPanel: { ke: 1.2e7, Fy: 8e3, kp: 1.5e5, maxCrush: 0.25 }, // sheet metal
    door: { ke: 1.2e7, Fy: 12e3, kp: 2e5, maxCrush: 0.35 },
    sill: { ke: 1.2e7, Fy: 25e3, kp: 5e5, maxCrush: 0.5 },        // sills, arches, rear
    mirror: { ke: 1e6, Fy: 0.4e3, kp: 1e3, maxCrush: 0.2 },       // folds / breaks away
    tyre: { ke: 2.5e5, Fy: 40e3, kp: 4e6, maxCrush: 0.05 },       // carcass, then rim; yield means wheel damage
  }, 'assumption', 'targets: frontal 56 km/h 0.5–0.7 m, pole 50 km/h 0.7–1.0 m, roof 74 kN at 0.1 m [M]'),
  // concentrated load (pole, box edge) on a zone: the bumper beam spreads it over the structure, so a single contact
  // point yields at this multiple of the per-point values. Front 2.0: a 254 mm pole at 50 km/h -> 0.7-1.0 m crush [M]
  hullConcentrated: p<Record<HullZone, number>>({ front: 2.0, roofRail: 1, roofPanel: 1, door: 1, sill: 1, mirror: 1, tyre: 1 }, 'assumption'),
  hullContactDamping: p(6e4, 'assumption', 'N·s/m, approach only, never adhesive'),
  hullTyreDamping: p(3e3, 'assumption', 'N·s/m for tyre sidewall points: they load a 55–65 kg unsprung mass (c·dt/m must stay well below 2)'),
  hullTangentialStiffness: p(2e6, 'assumption', 'N/m friction-anchor (bristle) stiffness'),
  hullTangentialDamping: p(2e4, 'assumption', 'N·s/m'),
  // body sliding on the ground [M: 0.3–0.6 in reconstruction literature]
  bodyGroundMu: p<Record<string, number>>({ asphalt: 0.40, concrete: 0.40, broken: 0.40, rumble: 0.40, wet: 0.30, gravel: 0.55, grass: 0.55, mud: 0.50, sand: 0.65 }, 'assumption'),
};

export type HullZone = 'front' | 'roofRail' | 'roofPanel' | 'door' | 'sill' | 'mirror' | 'tyre';
export interface HullZoneSpec { ke: number; Fy: number; kp: number; maxCrush: number }

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
