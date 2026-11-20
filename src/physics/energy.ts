// Mechanical-energy audit for the vehicle model (DOM-free; used by tools/crashtest.ts and the Stage-2 crash recorder).
// Matches the model's own mass split: along body-up the sprung body moves with mS and each wheel with its unsprung mass;
// perpendicular to up the whole car moves with mTot (the unsprung masses ride along at the CG).
// With the engine off, a correct model never gains energy: every contact is either elastic (stored here) or dissipative.
import type { Vehicle } from './vehicle';

export interface EnergyBreakdown {
  total: number;      // J
  kinetic: number;    // body translation
  rotation: number;   // body rotation ½ωᵀIω
  wheels: number;     // unsprung vertical motion + wheel spin
  gravity: number;    // relative to yRef
  elastic: number;    // springs, ARBs, stops, tyres, belly, hull contacts
}

const G = 9.81;

export function mechanicalEnergy(v: Vehicle, yRef = 0): EnergyBreakdown {
  const P = v.P, q = v.q;
  // basis
  const upx = 2 * (q.x * q.y - q.w * q.z), upy = 1 - 2 * (q.x * q.x + q.z * q.z), upz = 2 * (q.y * q.z + q.w * q.x);
  const vu = v.vel.x * upx + v.vel.y * upy + v.vel.z * upz;
  const v2 = v.vel.x * v.vel.x + v.vel.y * v.vel.y + v.vel.z * v.vel.z;
  const kinetic = 0.5 * v.mS * vu * vu + 0.5 * v.mTot * (v2 - vu * vu);
  // rotation in the body frame: ω_b = Rᵀω
  const w = v.w, cx = -q.x, cy = -q.y, cz = -q.z, cw = q.w;
  const ix = cw * w.x + cy * w.z - cz * w.y, iy = cw * w.y + cz * w.x - cx * w.z, iz = cw * w.z + cx * w.y - cy * w.x, iw = -cx * w.x - cy * w.y - cz * w.z;
  const bx = ix * cw + iw * -cx + iy * -cz - iz * -cy, by = iy * cw + iw * -cy + iz * -cx - ix * -cz, bz = iz * cw + iw * -cz + ix * -cy - iy * -cx;
  const rotation = 0.5 * (v.I.x * bx * bx + v.I.y * by * by + v.I.z * bz * bz);
  let wheels = 0, gravity = v.mS * G * (v.pos.y - yRef), elastic = 0;
  const L = P.wheelbase.v;
  for (let i = 0; i < 4; i++) {
    const wh = v.wheels[i], front = wh.front;
    const mU = front ? P.unsprungFront.v : P.unsprungRear.v / 2;
    // unsprung velocity relative to the body point along up is (vw − vMount·up); its absolute along-up speed is vw.
    // The body's along-up KE already uses mS only, so the wheel carries ½·mU·vw².
    wheels += 0.5 * mU * wh.vw * wh.vw + 0.5 * (P.wheelInertia.v + (wh.driven || v.driveMode !== '2H' ? 0.35 : 0)) * wh.omega * wh.omega;
    gravity += mU * G * (wh.centre.y - yRef);
    const k = front ? P.springFront.v : P.springRear.v;
    const cornerS = v.mS * G * (front ? (1 - v.a / L) : (v.a / L)) / 2;
    const sTop = cornerS / k; // spring force reaches 0 at this extension
    const dm = v.damage, sk = dm.wheelFault ? dm.springK[i] : 1, kt = dm.wheelFault ? dm.kTyre[i] : 1; // damaged wheel (collapsed spring, flat tyre)
    elastic += sk * (wh.s < sTop ? -cornerS * wh.s + 0.5 * k * wh.s * wh.s : -cornerS * sTop + 0.5 * k * sTop * sTop);
    const bumpT = front ? P.bumpTravelFront.v : P.bumpTravelRear.v, droopT = front ? P.droopTravelFront.v : P.droopTravelRear.v;
    const bpen = -wh.s - bumpT; if (bpen > 0) elastic += P.bumpStopRate.v * bpen * bpen * bpen / 3 + (bpen > 0.035 ? 1.5e6 * (bpen - 0.035) ** 2 : 0);
    const rpen = wh.s - droopT; if (rpen > 0) elastic += 1.25e5 * rpen * rpen;
    if (wh.Fz > 0 && wh.pen > 0) elastic += 0.5 * P.tyreVerticalStiffness.v * kt * wh.pen * wh.pen + wh.rimE;
  }
  // anti-roll bars: V = ¼·k·(sL − sR)²
  elastic += 0.25 * P.arbFront.v * (v.wheels[0].s - v.wheels[1].s) ** 2 + 0.25 * P.arbRear.v * (v.wheels[2].s - v.wheels[3].s) ** 2;
  elastic += v.hull.elasticEnergy() + v.kerbElastic + v.collide.elasticEnergy();
  // belly points (6e5 N/m against world +Y) and the rear diff housing (3e5 N/m)
  const g = v.ground;
  for (const bp of v.bellyPoints) {
    const ix2 = q.w * bp.x + q.y * bp.z - q.z * bp.y, iy2 = q.w * bp.y + q.z * bp.x - q.x * bp.z, iz2 = q.w * bp.z + q.x * bp.y - q.y * bp.x, iw2 = -q.x * bp.x - q.y * bp.y - q.z * bp.z;
    const rx = ix2 * q.w + iw2 * -q.x + iy2 * -q.z - iz2 * -q.y, ry = iy2 * q.w + iw2 * -q.y + iz2 * -q.x - ix2 * -q.z, rz = iz2 * q.w + iw2 * -q.z + ix2 * -q.y - iy2 * -q.x;
    const clr = v.pos.y + ry - g.heightAt(v.pos.x + rx, v.pos.z + rz); if (clr < 0) elastic += 3e5 * clr * clr;
  }
  if (upy > 0.5) {
    const cL = v.wheels[2].centre, cR = v.wheels[3].centre;
    const clr = (cL.y + cR.y) / 2 - (v.R - P.groundClearance.v) - g.heightAt((cL.x + cR.x) / 2, (cL.z + cR.z) / 2); if (clr < 0) elastic += 1.5e5 * clr * clr;
  }
  const total = kinetic + rotation + wheels + gravity + elastic;
  return { total, kinetic, rotation, wheels, gravity, elastic };
}

/** Tracks the largest rise of mechanical energy above its running minimum (J). Feed it every step. */
export class EnergyAudit {
  start = NaN; min = Infinity; maxRise = 0; maxRiseT = 0; last = 0;
  update(E: number, t: number) {
    if (Number.isNaN(this.start)) this.start = E;
    if (E < this.min) this.min = E;
    const r = E - this.min; if (r > this.maxRise) { this.maxRise = r; this.maxRiseT = t; }
    this.last = E;
  }
  /** Largest rise as a fraction of the start value measured above the final rest level (the energy that was available). */
  riseFrac(restLevel = this.min) { const avail = Math.max(1, this.start - restLevel); return this.maxRise / avail; }
}
