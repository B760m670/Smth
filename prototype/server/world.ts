/**
 * The authoritative simulation.
 *
 * No rendering, no THREE, no browser globals — this is the whole game as the
 * server sees it, and it imports the *same* `applyInput` the client predicts
 * with and the *same* `AbilityInstance` the client draws with. That shared
 * import is the point: when the server says the front reached you at 1.4 s into
 * the cast, it reached you at 1.4 s into the cast on your screen too, because
 * both numbers came out of one function reading one profile.
 *
 * Authority is enforced in exactly four places, and it is worth naming them
 * because everything else here is deliberately trusting:
 *
 *   1. `applyInput` clamps dt, and each player gets a movement budget per tick,
 *      so forged input floods buy no extra distance.
 *   2. The cast origin is the server's position, not the client's claim —
 *      unless the claim is close enough to be honest latency.
 *   3. The profile comes from the player's loadout, resolved from a slot index.
 *      A client cannot name a profile it does not own.
 *   4. Cooldowns are held here. The client predicts them and is corrected.
 *
 * The cast *seed* is deliberately **not** on that list. It decides which way the
 * crystals lean and nothing else, so letting the client choose it costs nothing
 * and buys the thing prediction exists for: the caster's own effect starts on
 * the frame they pressed the key, and the server's confirmation matches it
 * exactly instead of replacing it.
 */

import {
  ACTOR_RADIUS,
  INPUT_BUDGET_PER_TICK,
  MAX_HP,
  RESPAWN_TIME,
  WORLD_HALF
} from '../shared/constants.ts';
import { AbilityInstance } from '../shared/ability.ts';
import type { CastData } from '../shared/ability.ts';
import { applyInput } from '../shared/sim.ts';
import type { MoveInput, MoveState } from '../shared/sim.ts';
import { clamp, dist2 } from '../shared/math.ts';
import { DEFAULT_LOADOUT, resolveSlot } from '../shared/profiles.ts';
import type { AbilityProfile } from '../shared/profiles.ts';
import { RejectReason } from '../shared/protocol.ts';

/**
 * How far the server will let a client's claimed cast origin sit from the
 * position the server has for it, metres.
 *
 * This is the cheapest possible lag compensation and it is worth being explicit
 * about the trade. Under 200 ms a running player is about a metre ahead of where
 * the server last saw them; refusing that difference makes every cast fire from
 * behind you, which feels broken. Accepting it lets a cheater start a cast up to
 * `ORIGIN_TOLERANCE` away from their real position — a metre and a half of free
 * reach. Worth it here, and the knob to turn when it stops being worth it.
 */
const ORIGIN_TOLERANCE = 1.5;

export interface Player {
  readonly id: number;
  readonly name: string;
  readonly isBot: boolean;

  state: MoveState;
  hp: number;
  alive: boolean;
  respawnAt: number;

  loadout: readonly number[];
  /** profileId → server time (ms) the slot becomes usable again. */
  cooldowns: Map<number, number>;

  inputs: MoveInput[];
  lastAppliedSeq: number;

  /** Bot wander state. Unused for humans. */
  botTargetX: number;
  botTargetZ: number;
  botNextCast: number;
}

export interface ActiveCast {
  readonly instance: AbilityInstance;
  readonly profile: AbilityProfile;
  /** Who the travelling front has already caught. One hit per cast per target. */
  readonly hit: Set<number>;
  impactApplied: boolean;
}

export interface HitEvent {
  casterId: number;
  targetId: number;
  damage: number;
  hpAfter: number;
  x: number;
  z: number;
  killed: boolean;
}

export interface CastAttempt {
  slot: number;
  seed: number;
  originX: number;
  originZ: number;
  yaw: number;
  distance: number;
}

export type CastResult =
  | { ok: true; cast: ActiveCast }
  | { ok: false; reason: number };

export class World {
  readonly players = new Map<number, Player>();
  readonly casts: ActiveCast[] = [];

  /** Events produced by the last `update`, drained by the transport layer. */
  readonly hits: HitEvent[] = [];
  readonly deaths: number[] = [];

  private nextId = 1;
  /** Server clock: ms since boot. The only clock anything here reads. */
  now = 0;

  private scratch = { x: 0, z: 0 };

  /* ------------------------------------------------------------------ */
  /* Membership                                                          */
  /* ------------------------------------------------------------------ */

  addPlayer(name: string, isBot = false): Player {
    const id = this.nextId++;
    const player: Player = {
      id,
      name,
      isBot,
      state: { ...this.spawnPoint(), yaw: Math.random() * Math.PI * 2 },
      hp: MAX_HP,
      alive: true,
      respawnAt: 0,
      loadout: DEFAULT_LOADOUT,
      cooldowns: new Map(),
      inputs: [],
      lastAppliedSeq: 0,
      botTargetX: 0,
      botTargetZ: 0,
      botNextCast: 0
    };
    this.players.set(id, player);
    return player;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
  }

  private spawnPoint(): { x: number; z: number } {
    const r = WORLD_HALF * 0.45;
    const a = Math.random() * Math.PI * 2;
    return { x: Math.cos(a) * r, z: Math.sin(a) * r };
  }

  /* ------------------------------------------------------------------ */
  /* Input                                                               */
  /* ------------------------------------------------------------------ */

  queueInput(player: Player, input: MoveInput): void {
    // Clients re-send unacknowledged inputs, so most of what arrives is already
    // applied. Dropping by sequence here is what makes that redundancy free.
    if (input.seq <= player.lastAppliedSeq) return;
    player.inputs.push(input);
    // A client that floods gets its backlog trimmed rather than the server's
    // memory. The budget below already caps what it can do with them.
    if (player.inputs.length > 256) player.inputs.splice(0, player.inputs.length - 256);
  }

  /* ------------------------------------------------------------------ */
  /* Casting                                                             */
  /* ------------------------------------------------------------------ */

  tryCast(player: Player, attempt: CastAttempt): CastResult {
    if (!player.alive) return { ok: false, reason: RejectReason.DEAD };

    const profile = resolveSlot(player.loadout, attempt.slot);
    if (!profile) return { ok: false, reason: RejectReason.UNKNOWN_SLOT };

    const readyAt = player.cooldowns.get(profile.id) ?? 0;
    if (this.now < readyAt) return { ok: false, reason: RejectReason.COOLDOWN };

    // Aiming inside the minimum range is the one aim failure the sandbox
    // refuses rather than clamps, and it is right to: silently pushing the cast
    // outward would land it somewhere the player did not point.
    if (attempt.distance < profile.minRange) {
      return { ok: false, reason: RejectReason.TOO_CLOSE };
    }

    // (2) Authority over the origin — see ORIGIN_TOLERANCE.
    let originX = player.state.x;
    let originZ = player.state.z;
    if (dist2(attempt.originX, attempt.originZ, originX, originZ) <= ORIGIN_TOLERANCE) {
      originX = attempt.originX;
      originZ = attempt.originZ;
    }

    const distance = clamp(attempt.distance, profile.minRange, profile.range);

    const data: CastData = {
      casterId: player.id,
      profileId: profile.id,
      seed: attempt.seed >>> 0,
      t0: this.now,
      originX,
      originZ,
      yaw: attempt.yaw,
      distance
    };

    const cast: ActiveCast = {
      instance: new AbilityInstance(profile, data),
      profile,
      hit: new Set(),
      impactApplied: false
    };

    this.casts.push(cast);
    player.cooldowns.set(profile.id, this.now + profile.cooldown * 1000);

    return { ok: true, cast };
  }

  /* ------------------------------------------------------------------ */
  /* The tick                                                            */
  /* ------------------------------------------------------------------ */

  update(now: number, dt: number): void {
    this.now = now;
    this.hits.length = 0;
    this.deaths.length = 0;

    for (const player of this.players.values()) {
      if (!player.alive && now >= player.respawnAt) this.respawn(player);
      if (player.isBot) this.driveBot(player, dt);
      else this.consumeInputs(player);
    }

    this.updateCasts();
  }

  private respawn(player: Player): void {
    const point = this.spawnPoint();
    player.state.x = point.x;
    player.state.z = point.z;
    player.hp = MAX_HP;
    player.alive = true;
    player.cooldowns.clear();
  }

  /** (1) Movement authority: a per-tick budget over clamped inputs. */
  private consumeInputs(player: Player): void {
    let budget = INPUT_BUDGET_PER_TICK;

    while (player.inputs.length > 0 && budget > 0) {
      const input = player.inputs[0]!;
      // A dead player's inputs are still drained so their sequence keeps
      // advancing — otherwise the client's replay queue grows without bound
      // while it waits to respawn.
      if (player.alive) applyInput(player.state, input);
      else player.state.yaw = input.yaw;

      budget -= Math.min(input.dt, budget);
      player.lastAppliedSeq = input.seq;
      player.inputs.shift();
    }
  }

  private updateCasts(): void {
    for (let i = this.casts.length - 1; i >= 0; i--) {
      const cast = this.casts[i]!;
      const age = (this.now - cast.instance.cast.t0) / 1000;

      this.resolveSweep(cast, age);

      if (!cast.impactApplied && age >= cast.instance.travelEnd) {
        cast.impactApplied = true;
        this.resolveImpact(cast);
      }

      if (cast.instance.isDone(age)) this.casts.splice(i, 1);
    }
  }

  /** Anything the travelling band has passed over takes the sweep damage once. */
  private resolveSweep(cast: ActiveCast, age: number): void {
    for (const target of this.players.values()) {
      if (!target.alive) continue;
      if (target.id === cast.instance.cast.casterId) continue;
      if (cast.hit.has(target.id)) continue;

      if (cast.instance.sweptOver(target.state.x, target.state.z, age, ACTOR_RADIUS)) {
        cast.hit.add(target.id);
        this.damage(target, cast.instance.cast.casterId, cast.profile.damage);
      }
    }
  }

  /** ... and everything standing in the terminal cluster takes it again. */
  private resolveImpact(cast: ActiveCast): void {
    const centre = cast.instance.pointAt(1, this.scratch);
    const reach = cast.profile.impactRadius + ACTOR_RADIUS;

    for (const target of this.players.values()) {
      if (!target.alive) continue;
      if (target.id === cast.instance.cast.casterId) continue;
      if (dist2(target.state.x, target.state.z, centre.x, centre.z) > reach) continue;

      this.damage(target, cast.instance.cast.casterId, cast.profile.impactDamage);
    }
  }

  private damage(target: Player, casterId: number, amount: number): void {
    target.hp = Math.max(0, target.hp - amount);
    const killed = target.hp === 0 && target.alive;

    if (killed) {
      target.alive = false;
      target.respawnAt = this.now + RESPAWN_TIME * 1000;
      target.inputs.length = 0;
      this.deaths.push(target.id);
    }

    this.hits.push({
      casterId,
      targetId: target.id,
      damage: amount,
      hpAfter: target.hp,
      x: target.state.x,
      z: target.state.z,
      killed
    });
  }

  /* ------------------------------------------------------------------ */
  /* Bots — so one browser tab is still a multiplayer test               */
  /* ------------------------------------------------------------------ */

  /**
   * Deliberately stupid: wander to a point, cast at whoever is nearest when the
   * timer comes up. They exist to put bodies and casts on the wire, which is
   * what the netcode needs to be exercised against, and to make the M3 load
   * question ("what happens at twenty casters") a flag rather than a rewrite.
   */
  private driveBot(bot: Player, dt: number): void {
    if (!bot.alive) return;

    if (dist2(bot.state.x, bot.state.z, bot.botTargetX, bot.botTargetZ) < 1.2) {
      const r = WORLD_HALF * 0.6 * Math.sqrt(Math.random());
      const a = Math.random() * Math.PI * 2;
      bot.botTargetX = Math.cos(a) * r;
      bot.botTargetZ = Math.sin(a) * r;
    }

    const dx = bot.botTargetX - bot.state.x;
    const dz = bot.botTargetZ - bot.state.z;
    const len = Math.hypot(dx, dz) || 1;

    applyInput(bot.state, {
      seq: 0,
      dt,
      moveX: dx / len,
      moveZ: dz / len,
      yaw: Math.atan2(dx, dz)
    });

    if (this.now < bot.botNextCast) return;
    bot.botNextCast = this.now + 2200 + Math.random() * 2600;

    const victim = this.nearestOther(bot);
    if (!victim) return;

    const vx = victim.state.x - bot.state.x;
    const vz = victim.state.z - bot.state.z;
    const distance = Math.hypot(vx, vz);
    const slot = Math.random() < 0.35 ? 1 : 0;

    this.tryCast(bot, {
      slot,
      seed: (Math.random() * 0xffffffff) >>> 0,
      originX: bot.state.x,
      originZ: bot.state.z,
      yaw: Math.atan2(vx, vz),
      distance
    });
  }

  private nearestOther(from: Player): Player | null {
    let best: Player | null = null;
    let bestDist = Infinity;
    for (const other of this.players.values()) {
      if (other.id === from.id || !other.alive) continue;
      const d = dist2(from.state.x, from.state.z, other.state.x, other.state.z);
      if (d < bestDist) {
        bestDist = d;
        best = other;
      }
    }
    return best;
  }
}
