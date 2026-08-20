/**
 * Allocation-free maths shared by the server and the client.
 *
 * Deliberately free of any THREE import: this module has to run inside Node,
 * where there is no renderer and no reason to pull one in. The client wraps
 * these results into Vector3s at the last possible moment.
 */

export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const saturate = (v: number): number => clamp(v, 0, 1);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** Fast rise off a standstill. Matches `Easing.outQuad` in the sandbox. */
export const outQuad = (t: number): number => t * (2 - t);

/** Frame-rate independent exponential damping. `rate` = fraction left after 1s. */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  lerp(target, current, Math.pow(rate, dt));

/* ---------------------------------------------------------------------- */
/* Quantisation — the protocol speaks integers                             */
/* ---------------------------------------------------------------------- */

/**
 * Yaw ↔ u16. A full turn over 65536 steps is 0.0055°, far below what anyone
 * can see on a character's facing, and it halves the cost against an f32.
 */
export const packYaw = (radians: number): number => {
  const tau = Math.PI * 2;
  let a = radians % tau;
  if (a < 0) a += tau;
  return Math.round((a / tau) * 65535) & 0xffff;
};

export const unpackYaw = (packed: number): number => (packed / 65535) * Math.PI * 2;

/**
 * Metres ↔ i16 at centimetre resolution, valid to ±327 m.
 *
 * The world is 80 m across, so this is four times the headroom we need and
 * still half the bytes of an f32. Positions in snapshots stay f32 — those are
 * reconciled against and a centimetre of quantisation there shows up as a
 * permanent standing error.
 */
export const packCm = (metres: number): number => clamp(Math.round(metres * 100), -32768, 32767);
export const unpackCm = (packed: number): number => packed / 100;

/* ---------------------------------------------------------------------- */
/* Flat 2D helpers. The slice is on a plane; y is nobody's business yet.    */
/* ---------------------------------------------------------------------- */

export interface Vec2 {
  x: number;
  z: number;
}

export const dot2 = (ax: number, az: number, bx: number, bz: number): number => ax * bx + az * bz;

export const length2 = (x: number, z: number): number => Math.hypot(x, z);

export const dist2 = (ax: number, az: number, bx: number, bz: number): number =>
  Math.hypot(ax - bx, az - bz);
