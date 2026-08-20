/**
 * The server, minus the transport.
 *
 * Everything that decides what a packet *means* lives here; `main.ts` only owns
 * sockets and a timer. That split exists for one concrete reason: the same
 * session has to run inside a browser tab.
 *
 * `world.ts` never imported anything Node-specific, so the whole simulation was
 * already portable — the only thing tying it to a server process was the
 * `ws`-shaped code wrapped around it. Pulling that apart means a phone with no
 * server to talk to can host the session itself (`client/localServer.ts`) and
 * play against bots, running byte-for-byte the same protocol it would speak to a
 * real server. Not a mock, not a stub: the same file.
 *
 * The transport supplies connection ids and a way to send bytes. It is not told
 * what any of them mean.
 */

import { MAX_INPUT_DT, TICK_RATE } from '../shared/constants.ts';
import { Msg, Reader, Writer, writeCast } from '../shared/protocol.ts';
import { World } from './world.ts';
import type { Player } from './world.ts';

export interface Transport {
  send(connectionId: number, bytes: Uint8Array): void;
  /** Drop a connection that sent something unusable. Optional. */
  close?(connectionId: number, reason: string): void;
}

export class Session {
  readonly world = new World();

  private transport: Transport;
  private players = new Map<number, Player>();
  private connections = new Map<number, number>();

  constructor(transport: Transport, options: { bots?: number } = {}) {
    this.transport = transport;
    for (let i = 0; i < (options.bots ?? 0); i++) this.world.addPlayer(`Bot ${i + 1}`, true);
  }

  get population(): number {
    return this.world.players.size;
  }

  /* ------------------------------------------------------------------ */
  /* Connections                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Handle the first message on a connection, which must be the greeting.
   *
   * @returns the player's name if accepted, null if the greeting was unusable
   */
  greet(connectionId: number, bytes: Uint8Array, now: number): string | null {
    let name: string;
    try {
      const r = new Reader(bytes);
      if (r.u8() !== Msg.C_HELLO) return null;
      name = r.str();
    } catch {
      this.transport.close?.(connectionId, 'bad greeting');
      return null;
    }

    const player = this.world.addPlayer(name.trim() || 'Player');
    this.players.set(connectionId, player);
    this.connections.set(player.id, connectionId);

    const welcome = new Writer(64)
      .u8(Msg.S_WELCOME)
      .u16(player.id)
      .u8(TICK_RATE)
      .u32(now)
      .u8(player.loadout.length);
    for (const profileId of player.loadout) welcome.u16(profileId);
    this.transport.send(connectionId, welcome.finish());

    // Who is already here...
    for (const other of this.world.players.values()) {
      this.transport.send(connectionId, joinPacket(other));
    }
    this.broadcast(joinPacket(player), player.id);

    // ... and what is already in the air. The mid-cast join: every active cast
    // is replayed as its original packet, `t0` and all, so the new client
    // evaluates it at `now − t0` and picks it up in the correct phase instead of
    // watching it start over.
    for (const cast of this.world.casts) {
      this.transport.send(connectionId, writeCast(new Writer(32), cast.instance.cast).finish());
    }

    return player.name;
  }

  /** A connection went away. */
  drop(connectionId: number): Player | null {
    const player = this.players.get(connectionId);
    if (!player) return null;

    this.players.delete(connectionId);
    this.connections.delete(player.id);
    this.world.removePlayer(player.id);
    this.broadcast(new Writer(8).u8(Msg.S_LEAVE).u16(player.id).finish());
    return player;
  }

  isConnected(connectionId: number): boolean {
    return this.players.has(connectionId);
  }

  /* ------------------------------------------------------------------ */
  /* Packets                                                             */
  /* ------------------------------------------------------------------ */

  message(connectionId: number, bytes: Uint8Array, now: number): void {
    const player = this.players.get(connectionId);
    if (!player) return;

    const r = new Reader(bytes);
    const type = r.u8();

    switch (type) {
      case Msg.C_INPUT: {
        const count = r.u8();
        for (let i = 0; i < count; i++) {
          this.world.queueInput(player, {
            seq: r.u32(),
            dt: Math.min(r.u16() / 1000, MAX_INPUT_DT),
            moveX: r.i8() / 127,
            moveZ: r.i8() / 127,
            yaw: r.yaw()
          });
        }
        break;
      }

      case Msg.C_CAST: {
        const seq = r.u32();
        const attempt = {
          slot: r.u8(),
          // The client picks the seed — see the note in `world.ts`. It decides
          // which way the crystals lean and nothing the server adjudicates, so
          // letting the client own it is what makes prediction exact.
          seed: r.u32(),
          originX: r.cm(),
          originZ: r.cm(),
          yaw: r.yaw(),
          distance: r.u16() / 100
        };

        const result = this.world.tryCast(player, attempt);
        if (!result.ok) {
          this.transport.send(
            connectionId,
            new Writer(16).u8(Msg.S_CAST_REJECT).u32(seq).u8(result.reason).finish()
          );
          break;
        }

        // To everyone including the caster: they match it against their
        // predicted copy by seed and adopt the authoritative origin, distance
        // and start time rather than spawning a second effect.
        this.broadcast(writeCast(new Writer(32), result.cast.instance.cast).finish());
        break;
      }

      case Msg.C_PING: {
        const clientTime = r.f64();
        this.transport.send(
          connectionId,
          new Writer(16).u8(Msg.S_PONG).f64(clientTime).u32(now).finish()
        );
        break;
      }

      default:
        break;
    }
  }

  /* ------------------------------------------------------------------ */
  /* The tick                                                            */
  /* ------------------------------------------------------------------ */

  tick(now: number, dt: number): void {
    this.world.update(now, dt);

    for (const hit of this.world.hits) {
      this.broadcast(
        new Writer(24)
          .u8(Msg.S_HIT)
          .u16(hit.casterId)
          .u16(hit.targetId)
          .u16(hit.damage)
          .u16(hit.hpAfter)
          .cm(hit.x)
          .cm(hit.z)
          .u8(hit.killed ? 1 : 0)
          .finish()
      );
    }

    for (const id of this.world.deaths) {
      this.broadcast(new Writer(8).u8(Msg.S_DEATH).u16(id).finish());
    }

    for (const [connectionId, player] of this.players) {
      this.transport.send(connectionId, this.snapshotFor(player, now));
    }
  }

  /**
   * The snapshot.
   *
   * Built per client rather than once, because each carries that client's own
   * `lastAppliedSeq` — the number its reconciliation replays from. With a
   * handful of players that is cheaper than the machinery to avoid it; at a few
   * hundred it becomes one shared body plus a per-client header, and that is the
   * moment to write that machinery and not before.
   */
  private snapshotFor(player: Player, now: number): Uint8Array {
    const w = new Writer(512);
    w.u8(Msg.S_SNAPSHOT).u32(now).u32(player.lastAppliedSeq).u8(this.world.players.size);

    for (const other of this.world.players.values()) {
      w.u16(other.id)
        // Positions stay f32. A centimetre of quantisation is invisible on a
        // remote body but not on your own: reconciliation measures against this
        // number, so rounding it leaves a standing disagreement the client keeps
        // trying to correct.
        .f32(other.state.x)
        .f32(other.state.z)
        .yaw(other.state.yaw)
        .u16(other.hp)
        .u8(other.alive ? 1 : 0);
    }

    return w.finish();
  }

  private broadcast(bytes: Uint8Array, exceptPlayerId?: number): void {
    for (const [connectionId, player] of this.players) {
      if (player.id === exceptPlayerId) continue;
      this.transport.send(connectionId, bytes);
    }
  }
}

function joinPacket(player: Player): Uint8Array {
  return new Writer(64).u8(Msg.S_JOIN).u16(player.id).str(player.name).u8(player.isBot ? 1 : 0).finish();
}
