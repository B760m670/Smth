/**
 * Movement, in one place, called by both halves.
 *
 * Client-side prediction only works if the client and the server compute the
 * *same* position from the same input. The usual way this goes wrong is two
 * implementations that agree until someone fixes a clamp on one side; the fix is
 * to have one implementation and import it twice.
 *
 * Everything here is a pure function of `(state, input)` with no clock of its
 * own, which is what lets the client replay a queue of unacknowledged inputs on
 * top of an authoritative position and land exactly where the server will.
 */

import { MOVE_SPEED, WORLD_HALF, MAX_INPUT_DT } from './constants.ts';
import { clamp } from './math.ts';

/** One sampled frame of player intent. */
export interface MoveInput {
  /** Monotonic per-client sequence number. The server echoes the last it applied. */
  seq: number;
  /** Seconds this input covers. Clamped on the server — see `MAX_INPUT_DT`. */
  dt: number;
  /** Intent on the ground plane, each -1..1. Normalised below, not here. */
  moveX: number;
  moveZ: number;
  /** Where the player is looking, radians about +Y. Not simulated, just carried. */
  yaw: number;
}

export interface MoveState {
  x: number;
  z: number;
  yaw: number;
}

/**
 * Advance one actor by one input.
 *
 * Mutates `state` in place: this runs in the client's replay loop up to
 * `INPUT_HISTORY` times per snapshot, and allocating a state object per step
 * there is exactly the kind of per-frame garbage the sandbox spends effort
 * avoiding elsewhere.
 */
export function applyInput(state: MoveState, input: MoveInput): void {
  const dt = clamp(input.dt, 0, MAX_INPUT_DT);

  let mx = clamp(input.moveX, -1, 1);
  let mz = clamp(input.moveZ, -1, 1);

  const len = Math.hypot(mx, mz);
  if (len > 1e-4) {
    // Normalise so diagonals are not faster — and so a client that sends
    // (1, 1) gains nothing by it.
    mx /= len;
    mz /= len;
    state.x = clamp(state.x + mx * MOVE_SPEED * dt, -WORLD_HALF, WORLD_HALF);
    state.z = clamp(state.z + mz * MOVE_SPEED * dt, -WORLD_HALF, WORLD_HALF);
  }

  state.yaw = input.yaw;
}
