/**
 * Transport and the tick loop.
 *
 * Node 22 runs this file directly — `node server/main.ts`, no build step, no
 * transpiler, no watch process compiling into a `dist` nobody reads. That is
 * worth a sentence because it is half the argument for putting the server in
 * TypeScript at all: the other half is that it imports `shared/` and therefore
 * cannot drift from the client's idea of how a cast behaves.
 *
 * Everything here is plumbing. The rules live in `world.ts`.
 */

import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';

import { TICK_MS, TICK_RATE, MAX_INPUT_DT } from '../shared/constants.ts';
import { Msg, Reader, Writer, writeCast } from '../shared/protocol.ts';
import { World } from './world.ts';
import type { Player } from './world.ts';

const PORT = Number(process.env.PORT ?? 8080);
const BOTS = Number(process.env.BOTS ?? 0);

const world = new World();
const sockets = new Map<number, WebSocket>();
const bootTime = Date.now();

/** ms since boot — the only clock the protocol speaks. */
const uptime = (): number => Date.now() - bootTime;

for (let i = 0; i < BOTS; i++) world.addPlayer(`Bot ${i + 1}`, true);

/* ---------------------------------------------------------------------- */
/* Sending                                                                 */
/* ---------------------------------------------------------------------- */

function send(socket: WebSocket, bytes: Uint8Array): void {
  if (socket.readyState === socket.OPEN) socket.send(bytes);
}

function broadcast(bytes: Uint8Array, except?: number): void {
  for (const [id, socket] of sockets) {
    if (id === except) continue;
    send(socket, bytes);
  }
}

function joinPacket(player: Player): Uint8Array {
  return new Writer(64).u8(Msg.S_JOIN).u16(player.id).str(player.name).u8(player.isBot ? 1 : 0).finish();
}

/**
 * The snapshot.
 *
 * Built per client rather than once, because each one carries that client's own
 * `lastAppliedSeq` — the number its reconciliation replays from. With a handful
 * of players that is cheaper than the machinery to avoid it; at a few hundred it
 * becomes one shared body plus a per-client header, and that is the moment to
 * write that machinery and not before.
 */
function snapshotFor(player: Player): Uint8Array {
  const w = new Writer(512);
  w.u8(Msg.S_SNAPSHOT).u32(uptime()).u32(player.lastAppliedSeq).u8(world.players.size);

  for (const other of world.players.values()) {
    w.u16(other.id)
      // Positions stay f32. A centimetre of quantisation is invisible on a
      // remote body but it is *not* invisible on your own: reconciliation
      // measures against this number, so rounding it leaves a permanent
      // disagreement the client keeps trying to correct.
      .f32(other.state.x)
      .f32(other.state.z)
      .yaw(other.state.yaw)
      .u16(other.hp)
      .u8(other.alive ? 1 : 0);
  }

  return w.finish();
}

/* ---------------------------------------------------------------------- */
/* Receiving                                                               */
/* ---------------------------------------------------------------------- */

function handleMessage(player: Player, socket: WebSocket, data: Uint8Array): void {
  const r = new Reader(data);
  const type = r.u8();

  switch (type) {
    case Msg.C_INPUT: {
      const count = r.u8();
      for (let i = 0; i < count; i++) {
        world.queueInput(player, {
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
        // The client picks the seed. See the note in `world.ts` — it decides
        // which way the crystals lean and nothing the server has to adjudicate,
        // so letting the client own it is what makes prediction exact.
        seed: r.u32(),
        originX: r.cm(),
        originZ: r.cm(),
        yaw: r.yaw(),
        distance: r.u16() / 100
      };

      const result = world.tryCast(player, attempt);
      if (!result.ok) {
        send(socket, new Writer(16).u8(Msg.S_CAST_REJECT).u32(seq).u8(result.reason).finish());
        break;
      }

      // Broadcast to everyone including the caster: the caster matches it
      // against its predicted copy by seed and adopts the authoritative origin,
      // distance and start time rather than spawning a second effect.
      broadcast(writeCast(new Writer(32), result.cast.instance.cast).finish());
      break;
    }

    case Msg.C_PING: {
      const clientTime = r.f64();
      send(socket, new Writer(16).u8(Msg.S_PONG).f64(clientTime).u32(uptime()).finish());
      break;
    }

    default:
      break;
  }
}

/* ---------------------------------------------------------------------- */
/* Connections                                                             */
/* ---------------------------------------------------------------------- */

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (socket) => {
  socket.binaryType = 'nodebuffer';

  let player: Player | null = null;

  socket.on('message', (raw: Buffer) => {
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);

    if (!player) {
      // The first message must be the greeting; anything else is dropped rather
      // than answered, so an unopened socket cannot queue work. Parsing it is
      // inside the guard for the same reason every other packet is: a truncated
      // greeting is a client bug and must not become a server one.
      let name: string;
      try {
        const r = new Reader(bytes);
        if (r.u8() !== Msg.C_HELLO) return;
        name = r.str();
      } catch {
        socket.close(1002, 'bad greeting');
        return;
      }

      player = world.addPlayer(name.trim() || 'Player');
      sockets.set(player.id, socket);

      const welcome = new Writer(64)
        .u8(Msg.S_WELCOME)
        .u16(player.id)
        .u8(TICK_RATE)
        .u32(uptime())
        .u8(player.loadout.length);
      for (const profileId of player.loadout) welcome.u16(profileId);
      send(socket, welcome.finish());

      // Who is already here...
      for (const other of world.players.values()) send(socket, joinPacket(other));
      broadcast(joinPacket(player), player.id);

      // ... and what is already in the air. This is the mid-cast join: every
      // active cast is replayed as its original packet, `t0` and all, so the
      // new client evaluates it at `now − t0` and picks it up mid-flight in the
      // correct phase instead of watching it start over.
      for (const cast of world.casts) {
        send(socket, writeCast(new Writer(32), cast.instance.cast).finish());
      }

      console.log(`[+] ${player.name} (#${player.id}) — ${world.players.size} in world`);
      return;
    }

    try {
      handleMessage(player, socket, bytes);
    } catch (error) {
      // A malformed packet is a client problem; it must not be a server one.
      console.warn(`[!] bad packet from #${player.id}:`, (error as Error).message);
    }
  });

  socket.on('close', () => {
    if (!player) return;
    console.log(`[-] ${player.name} (#${player.id}) left`);
    sockets.delete(player.id);
    world.removePlayer(player.id);
    broadcast(new Writer(8).u8(Msg.S_LEAVE).u16(player.id).finish());
  });

  socket.on('error', () => socket.terminate());
});

/* ---------------------------------------------------------------------- */
/* The loop                                                                */
/* ---------------------------------------------------------------------- */

let last = uptime();

setInterval(() => {
  const now = uptime();
  const dt = Math.min((now - last) / 1000, 0.25);
  last = now;

  world.update(now, dt);

  for (const hit of world.hits) {
    broadcast(
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

  for (const id of world.deaths) {
    broadcast(new Writer(8).u8(Msg.S_DEATH).u16(id).finish());
  }

  for (const [id, socket] of sockets) {
    const player = world.players.get(id);
    if (player) send(socket, snapshotFor(player));
  }
}, TICK_MS);

console.log(`slice server on ws://localhost:${PORT} — ${TICK_RATE} Hz, ${BOTS} bot(s)`);
