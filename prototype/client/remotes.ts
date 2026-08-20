/**
 * Snapshot interpolation for everybody who is not you.
 *
 * Remote bodies are drawn `INTERP_DELAY_MS` behind the server clock, between
 * the two snapshots that bracket that moment. Rendering them at "now" instead
 * would mean extrapolating, and extrapolation is a guess that gets corrected —
 * which is visible as a twitch every time someone changes direction. Trading a
 * tenth of a second of staleness for motion that never lies is the right trade
 * for everything except the body you are steering yourself.
 *
 * The buffer is per entity rather than a list of whole snapshots, because
 * players join, leave and die at different times and a missing entry in one
 * snapshot must not be read as "teleported to the origin".
 */

import { INTERP_DELAY_MS } from '../shared/constants.ts';

export interface RemoteSample {
  time: number;
  x: number;
  z: number;
  yaw: number;
  hp: number;
  alive: boolean;
}

/** How much history to keep, ms. Comfortably more than the render delay. */
const HISTORY_MS = 1200;

export class RemoteBuffer {
  private tracks = new Map<number, RemoteSample[]>();

  push(id: number, sample: RemoteSample): void {
    let track = this.tracks.get(id);
    if (!track) {
      track = [];
      this.tracks.set(id, track);
    }

    // Jitter can reorder arrivals. A sample older than one we already hold is
    // not news — dropping it is cheaper and steadier than re-sorting.
    const last = track[track.length - 1];
    if (last && sample.time <= last.time) return;

    track.push(sample);

    const cutoff = sample.time - HISTORY_MS;
    while (track.length > 2 && track[0]!.time < cutoff) track.shift();
  }

  remove(id: number): void {
    this.tracks.delete(id);
  }

  ids(): IterableIterator<number> {
    return this.tracks.keys();
  }

  /**
   * Where entity `id` was at `serverNow - INTERP_DELAY_MS`.
   *
   * Returns the newest sample when the render time runs past the end of the
   * buffer — which happens whenever snapshots stop arriving. Holding the last
   * known pose is the right failure: the body freezes rather than drifting off
   * on a stale velocity, and it snaps back the moment packets resume.
   */
  sampleAt(id: number, serverNow: number): RemoteSample | null {
    const track = this.tracks.get(id);
    if (!track || track.length === 0) return null;

    const renderTime = serverNow - INTERP_DELAY_MS;

    if (track.length === 1 || renderTime >= track[track.length - 1]!.time) {
      return track[track.length - 1]!;
    }
    if (renderTime <= track[0]!.time) return track[0]!;

    for (let i = track.length - 1; i > 0; i--) {
      const b = track[i]!;
      const a = track[i - 1]!;
      if (renderTime < a.time) continue;

      const span = b.time - a.time;
      const t = span > 0 ? (renderTime - a.time) / span : 0;

      return {
        time: renderTime,
        x: a.x + (b.x - a.x) * t,
        z: a.z + (b.z - a.z) * t,
        yaw: lerpAngle(a.yaw, b.yaw, t),
        // State, not motion: interpolating a health bar would show damage
        // arriving gradually, and interpolating "alive" is meaningless.
        hp: b.hp,
        alive: b.alive
      };
    }

    return track[track.length - 1]!;
  }

  clear(): void {
    this.tracks.clear();
  }
}

/** Shortest-arc angle interpolation, so a body never spins the long way round. */
function lerpAngle(a: number, b: number, t: number): number {
  const tau = Math.PI * 2;
  let delta = (b - a) % tau;
  if (delta > Math.PI) delta -= tau;
  if (delta < -Math.PI) delta += tau;
  return a + delta * t;
}
