/**
 * Tuning constants shared by the server and every client.
 *
 * These are *protocol* values: change one and both ends must agree, so they live
 * here rather than in either half. Ability numbers do not belong in this file —
 * those are per-profile and live in `profiles.ts`, because the whole point of
 * the profile registry is that two casters can disagree about them.
 */

/** Server simulation rate, Hz. Snapshots go out on the same clock. */
export const TICK_RATE = 30;
export const TICK_MS = 1000 / TICK_RATE;

/** Client input sampling rate, Hz. Higher than the tick: the server queues them. */
export const INPUT_RATE = 60;
export const INPUT_DT = 1 / INPUT_RATE;

/**
 * How far behind the server clock remote entities are rendered.
 *
 * Interpolation needs two snapshots bracketing the render time, so this has to
 * exceed one snapshot interval with room for jitter. Two ticks plus change.
 */
export const INTERP_DELAY_MS = 100;

/** Walk speed, metres/second. The server clamps to this — it is authority. */
export const MOVE_SPEED = 5.5;

/** Half-extent of the playable square, metres. */
export const WORLD_HALF = 40;

/** Capsule radius used for both rendering and hit resolution, metres. */
export const ACTOR_RADIUS = 0.42;

export const MAX_HP = 100;

/** Seconds a corpse lies there before it respawns. */
export const RESPAWN_TIME = 3;

/**
 * Largest input delta the server will honour from one command, seconds.
 *
 * A client that lies about `dt` is claiming to have moved further than wall
 * clock allows. Clamping per command plus the per-tick budget below is the
 * cheap 90% of speed-hack protection.
 */
export const MAX_INPUT_DT = 0.05;

/**
 * Seconds of movement one player may consume in a single server tick.
 *
 * Slightly over one tick so a client that stutters can catch up, but not so
 * much that a burst of forged inputs teleports anyone.
 */
export const INPUT_BUDGET_PER_TICK = TICK_MS / 1000 * 1.5;

/** How many unacknowledged inputs a client keeps for replay. */
export const INPUT_HISTORY = 128;
