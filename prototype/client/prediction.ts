/**
 * Client-side prediction and reconciliation for the local player.
 *
 * The loop is the standard one and it is short, which is the point: all the
 * subtlety lives in `shared/sim.ts`, imported by both ends, so there is no
 * second implementation to drift.
 *
 *   1. Sample input, apply it locally *now*, keep a copy.
 *   2. Send it. Keep sending unacknowledged copies until the server admits it
 *      has them — that redundancy is what makes a dropped input packet a
 *      non-event rather than a stutter.
 *   3. When a snapshot arrives it carries the authoritative position and the
 *      last input sequence the server applied. Snap to that position, throw
 *      away everything acknowledged, and replay what is left on top.
 *
 * Step 3 is where the feel comes from. Done right, a correction is invisible
 * unless the server actually disagreed with you; done wrong, you rubber-band on
 * every snapshot. `error` below is the size of the disagreement after the
 * replay, and it is on the HUD because a number you cannot see is a number you
 * will not notice creeping upward.
 */

import { INPUT_HISTORY } from '../shared/constants.ts';
import { applyInput } from '../shared/sim.ts';
import type { MoveInput, MoveState } from '../shared/sim.ts';

export class Predictor {
  readonly state: MoveState = { x: 0, z: 0, yaw: 0 };

  /** Authoritative position from the last snapshot, for the ghost. */
  readonly server: MoveState = { x: 0, z: 0, yaw: 0 };

  /** Metres the last reconciliation moved us after replay. */
  error = 0;

  private pending: MoveInput[] = [];
  private seq = 0;

  get pendingCount(): number {
    return this.pending.length;
  }

  /** Take one input, apply it immediately, and remember it for replay. */
  sample(dt: number, moveX: number, moveZ: number, yaw: number): MoveInput {
    const input: MoveInput = { seq: ++this.seq, dt, moveX, moveZ, yaw };

    applyInput(this.state, input);
    this.pending.push(input);

    // A client that has been unable to reach the server for two seconds has
    // bigger problems than a replay queue; cap it rather than grow forever.
    if (this.pending.length > INPUT_HISTORY) this.pending.shift();

    return input;
  }

  /**
   * Fold in an authoritative position.
   *
   * @param x,z    where the server says we are
   * @param ackSeq the last input sequence it had applied when it said so
   */
  reconcile(x: number, z: number, ackSeq: number): void {
    this.server.x = x;
    this.server.z = z;

    const beforeX = this.state.x;
    const beforeZ = this.state.z;

    this.state.x = x;
    this.state.z = z;

    // Everything the server has seen is settled; only what it has not needs
    // replaying on top of its answer.
    while (this.pending.length > 0 && this.pending[0]!.seq <= ackSeq) this.pending.shift();
    for (const input of this.pending) applyInput(this.state, input);

    this.error = Math.hypot(this.state.x - beforeX, this.state.z - beforeZ);
  }

  /** Inputs the server has not acknowledged, re-sent every packet. */
  unacked(): readonly MoveInput[] {
    return this.pending;
  }

  teleport(x: number, z: number): void {
    this.state.x = x;
    this.state.z = z;
    this.server.x = x;
    this.server.z = z;
    this.pending.length = 0;
    this.error = 0;
  }
}
