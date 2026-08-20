/**
 * The server, running inside the tab.
 *
 * `world.ts` and `session.ts` never imported anything Node-specific, so the
 * whole authoritative simulation runs in a browser unchanged. This wires it to
 * an in-memory pipe instead of a socket.
 *
 * It is not a mock and not an offline stub with different rules. It is the same
 * `Session`, the same `World`, the same binary protocol, the same 30 Hz tick —
 * the client cannot tell the difference, and neither can the network simulator,
 * which still sits in front of it. That means:
 *
 *   - a phone with no server to talk to still gets the real game against bots;
 *   - the client half of the netcode can be exercised with no infrastructure at
 *     all, including under 250 ms of simulated latency;
 *   - and if the two ever diverge, it is because someone put a rule in the
 *     transport layer, which is exactly the mistake this arrangement is meant
 *     to make impossible.
 *
 * What it is not: multiplayer. Two phones cannot see each other this way — that
 * needs the process in `server/main.ts` somewhere they can both reach.
 */

import { TICK_MS } from '../shared/constants.ts';
import { Session } from '../server/session.ts';
import type { Transport } from '../server/session.ts';

/** The single connection a local session ever has. */
const CONNECTION = 1;

export class LocalServer implements Transport {
  private session: Session;
  private deliver: ((bytes: Uint8Array) => void) | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private startedAt = performance.now();
  private last = 0;
  private greeted = false;

  constructor(bots = 3) {
    this.session = new Session(this, { bots });
  }

  /** ms since this session started — the clock the protocol speaks. */
  private now(): number {
    return performance.now() - this.startedAt;
  }

  /* --- Transport: the session sending to the client --- */
  send(_connectionId: number, bytes: Uint8Array): void {
    // Copied because the session reuses its writers' buffers, and the client
    // may hold onto this for a while under simulated latency.
    this.deliver?.(bytes.slice());
  }

  /* --- the client sending to the session --- */
  fromClient(bytes: Uint8Array): void {
    if (!this.greeted) {
      this.greeted = this.session.greet(CONNECTION, bytes, this.now()) !== null;
      return;
    }
    try {
      this.session.message(CONNECTION, bytes, this.now());
    } catch {
      // Same posture as the real server: a bad packet is the client's problem.
    }
  }

  open(onMessage: (bytes: Uint8Array) => void): void {
    this.deliver = onMessage;
    this.last = this.now();
    this.timer = setInterval(() => {
      const now = this.now();
      const dt = Math.min((now - this.last) / 1000, 0.25);
      this.last = now;
      this.session.tick(now, dt);
    }, TICK_MS);
  }

  close(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.session.drop(CONNECTION);
    this.deliver = null;
    this.greeted = false;
  }

  get population(): number {
    return this.session.population;
  }
}
