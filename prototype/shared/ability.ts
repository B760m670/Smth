/**
 * The headless ability core — one phase machine, run by both halves of the game.
 *
 * This is the piece of the sandbox that turned out to be worth more than it
 * looks. `Ability#advance` there is not a rendering concern at all: it is the
 * gameplay timeline. When the front reaches the end of the line is when the
 * impact happens, how wide the band is at a given distance is where the ice
 * comes up, and both are pure functions of the profile. So the server runs this
 * exact class with no renderer attached to decide who got hit and when, and the
 * client runs it to decide what to draw — out of the same numbers, so the damage
 * lands exactly where the crystals erupt.
 *
 * One deliberate change from the sandbox, and it is the change that makes the
 * thing network-safe:
 *
 *   **The front's position is closed form, not integrated.**
 *
 * The sandbox accumulates `front += speed * easeIn * dt` every frame. That is
 * correct locally and useless over a wire: two machines stepping with different
 * frame times drift apart, and a client that comes into view halfway through a
 * cast has no way to catch up except to replay the whole thing. Integrating the
 * sandbox's own ease analytically gives a `frontAt(age)` that any machine can
 * evaluate at any age and get the same metre:
 *
 *     easeIn(a) = outQuad(min(a / T, 1))          T = 0.08 s
 *     front(a)  = speed · ∫₀ᵃ easeIn             (exactly the same curve)
 *               = speed · (a²/T − a³/(3T²))                     a ≤ T
 *               = speed · (2T/3 + (a − T))                      a > T
 *
 * Nothing about the feel changes — it is the same ease off the standstill — but
 * the cast becomes a function of `(profile, cast, age)` with no history, which
 * is what lets a 21-byte packet reconstruct it anywhere.
 */

import type { AbilityProfile } from './profiles.ts';
import { clamp, lerp, saturate } from './math.ts';

export const Phase = {
  TRAVEL: 0,
  IMPACT: 1,
  FADE: 2,
  DONE: 3
} as const;

export type PhaseValue = (typeof Phase)[keyof typeof Phase];

/** Everything that travels on the wire to describe one cast. */
export interface CastData {
  casterId: number;
  profileId: number;
  seed: number;
  /** Server time the cast began, ms. Ages are measured against this. */
  t0: number;
  originX: number;
  originZ: number;
  /** Flat heading, radians about +Y. */
  yaw: number;
  /** How far it reaches, metres. Already clamped by the server. */
  distance: number;
}

/** Seconds the front takes to come off a standstill. Matches the sandbox. */
const EASE_IN_TIME = 0.08;

export class AbilityInstance {
  readonly profile: AbilityProfile;
  readonly cast: CastData;

  /** Unit heading on the ground plane. */
  readonly dirX: number;
  readonly dirZ: number;
  /** Unit lateral, `direction × up`. */
  readonly sideX: number;
  readonly sideZ: number;
  readonly length: number;

  /** Seconds from the start of travel to the impact. Solved once, at build. */
  readonly travelEnd: number;
  readonly impactEnd: number;
  readonly fadeEnd: number;

  constructor(profile: AbilityProfile, cast: CastData) {
    this.profile = profile;
    this.cast = cast;

    this.dirX = Math.sin(cast.yaw);
    this.dirZ = Math.cos(cast.yaw);
    // direction × up, matching `Ability#spawn`'s `side`.
    this.sideX = this.dirZ;
    this.sideZ = -this.dirX;

    this.length = Math.max(0.1, cast.distance);

    this.travelEnd = solveTravelEnd(profile.speed, this.length);
    this.impactEnd = this.travelEnd + Math.max(0.05, profile.lifetime);
    this.fadeEnd = this.impactEnd + Math.max(0.05, profile.fadeTime);
  }

  /* ------------------------------------------------------------------ */
  /* Pure functions of age — no state, no history, no drift              */
  /* ------------------------------------------------------------------ */

  /** Metres the front has travelled at `age` seconds. Clamped to the line. */
  frontAt(age: number): number {
    return Math.min(this.length, rawFrontAt(this.profile.speed, age));
  }

  /** That front as a fraction of the cast's length, 0..1. */
  progressAt(age: number): number {
    return saturate(this.frontAt(age) / this.length);
  }

  phaseAt(age: number): PhaseValue {
    if (age < this.travelEnd) return Phase.TRAVEL;
    if (age < this.impactEnd) return Phase.IMPACT;
    if (age < this.fadeEnd) return Phase.FADE;
    return Phase.DONE;
  }

  isDone(age: number): boolean {
    return age >= this.fadeEnd;
  }

  /**
   * 0..1 through the impact phase, then 1..2 through the fade — the same `t`
   * the sandbox hands `onFade`, so a ported render layer needs no translation.
   */
  fadeParamAt(age: number): number {
    if (age < this.travelEnd) return 0;
    if (age < this.impactEnd) {
      return saturate((age - this.travelEnd) / Math.max(0.05, this.profile.lifetime));
    }
    return 1 + saturate((age - this.impactEnd) / Math.max(0.05, this.profile.fadeTime));
  }

  /** A point on the cast line. `s` is 0..1 along it. */
  pointAt(s: number, out: { x: number; z: number }): { x: number; z: number } {
    const d = s * this.length;
    out.x = this.cast.originX + this.dirX * d;
    out.z = this.cast.originZ + this.dirZ * d;
    return out;
  }

  /**
   * Half-width of the band at `s` along the line, metres.
   *
   * The one function the hit resolver and the crystal field both call. If these
   * ever disagree the damage stops landing where the ice is, which is the single
   * most common way a spell stops feeling fair.
   */
  halfWidthAt(s: number): number {
    const p = this.profile;
    return lerp(p.widthNear, p.width, Math.pow(saturate(s), p.widthCurve));
  }

  /**
   * Where a world point sits relative to the cast, in the cast's own frame.
   *
   * `along` is metres down the line (may be negative or past the end),
   * `lateral` is unsigned metres off the axis.
   */
  project(x: number, z: number): { along: number; lateral: number } {
    const rx = x - this.cast.originX;
    const rz = z - this.cast.originZ;
    return {
      along: rx * this.dirX + rz * this.dirZ,
      lateral: Math.abs(rx * this.sideX + rz * this.sideZ)
    };
  }

  /**
   * Has the travelling front swept over this point by `age`?
   *
   * `padding` is the target's own radius: a capsule is caught by the band when
   * its *edge* is inside it, not its centre.
   */
  sweptOver(x: number, z: number, age: number, padding: number): boolean {
    const { along, lateral } = this.project(x, z);
    if (along < 0 || along > this.length) return false;
    if (this.frontAt(age) < along) return false;
    const s = saturate(along / this.length);
    return lateral <= this.halfWidthAt(s) + padding;
  }
}

/* ---------------------------------------------------------------------- */

/**
 * Age at which the front has travelled `distance` metres.
 *
 * The inverse of `rawFrontAt`, and the reason the crystal field can be a pure
 * function of age like everything else: each spike asks once, at spawn, "when
 * does the front reach me", and from then on its emergence is `age − answer`.
 * No per-frame trigger check, no stored flags, and a client that joins late
 * gets a half-grown field rather than one that starts over.
 */
export function ageAtDistance(speed: number, distance: number): number {
  return solveTravelEnd(speed, Math.max(0, distance));
}

/** The closed-form integral of the sandbox's ease-in. Unclamped. */
function rawFrontAt(speed: number, age: number): number {
  if (age <= 0) return 0;
  const T = EASE_IN_TIME;
  if (age <= T) {
    // speed · (a²/T − a³/(3T²))
    return speed * ((age * age) / T - (age * age * age) / (3 * T * T));
  }
  return speed * ((2 / 3) * T + (age - T));
}

/**
 * Age at which the front reaches `length`.
 *
 * The linear regime inverts by hand; the ease-in regime is a cubic, and rather
 * than carry Cardano around for a case that only fires on very short casts,
 * bisect it. Thirty halvings of an eighty-millisecond window resolve it far
 * below anything a 30 Hz tick can observe, and it runs once per cast.
 */
function solveTravelEnd(speed: number, length: number): number {
  if (speed <= 0) return Infinity;
  const T = EASE_IN_TIME;
  const atEase = rawFrontAt(speed, T);

  if (length >= atEase) return T + (length - atEase) / speed;

  let lo = 0;
  let hi = T;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) * 0.5;
    if (rawFrontAt(speed, mid) < length) lo = mid;
    else hi = mid;
  }
  return (lo + hi) * 0.5;
}

/** Exported for the tests, which check it against a numerically integrated ease. */
export const _internal = { rawFrontAt, solveTravelEnd, EASE_IN_TIME, clamp };
