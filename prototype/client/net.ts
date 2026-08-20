/**
 * Transport, the network simulator, and the clock.
 *
 * The simulator is not a debugging afterthought — it is the reason this
 * milestone exists. A client that feels good on localhost tells you nothing;
 * every networked game feels good on localhost. The sliders in the HUD put
 * latency, jitter and loss between you and the server, and the whole of M0 is
 * the question "does this still feel like a game at 150 ms".
 *
 * One honest caveat about the loss slider. WebSocket runs on TCP, so in
 * production a lost packet is not lost — it is retransmitted, and what you
 * actually experience is a stall while the stream waits for it. Dropping
 * messages here therefore models the *unreliable* transport this would move to
 * (WebRTC data channels, unordered and unreliable) rather than what WebSocket
 * does today. Both are worth testing against, which is why jitter is a separate
 * slider: jitter is TCP's version of the same problem.
 */

import { Msg, Reader, Writer } from '../shared/protocol.ts';

export interface NetSim {
  /** One-way delay, ms. Round trip is roughly twice this. */
  latency: number;
  /** Random extra delay on top, ms. Can reorder — which unreliable transports do. */
  jitter: number;
  /** Probability a message is dropped, 0..1. */
  loss: number;
}

interface Queued {
  due: number;
  data: Uint8Array;
}

export type PacketHandler = (type: number, reader: Reader) => void;

export class Net {
  readonly sim: NetSim = { latency: 0, jitter: 0, loss: 0 };

  playerId = 0;
  loadout: number[] = [];
  tickRate = 30;

  /** Best round-trip observed, ms. */
  rtt = Infinity;
  /** performance.now() + offset ≈ the server's uptime clock. */
  private offset = 0;
  private clockReady = false;

  private socket: WebSocket | null = null;
  private inbound: Queued[] = [];
  private outbound: Queued[] = [];
  private handler: PacketHandler = () => {};

  /** Counters for the HUD. */
  readonly stats = { sent: 0, received: 0, dropped: 0, bytesIn: 0, bytesOut: 0 };

  onPacket(handler: PacketHandler): void {
    this.handler = handler;
  }

  get connected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  get clockSynced(): boolean {
    return this.clockReady;
  }

  /** The server's clock, in its own ms-since-boot units. */
  serverNow(): number {
    return performance.now() + this.offset;
  }

  connect(url: string, name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      socket.onopen = () => {
        // The greeting bypasses the simulator. Dropping it would leave the
        // socket open and the session unstarted, which is a simulator bug
        // wearing a network bug's clothes.
        socket.send(new Writer(64).u8(Msg.C_HELLO).str(name).finish());
        resolve();
      };

      socket.onerror = () => reject(new Error(`cannot reach ${url}`));

      socket.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        const data = new Uint8Array(event.data);
        this.stats.bytesIn += data.byteLength;

        if (Math.random() < this.sim.loss) {
          this.stats.dropped++;
          return;
        }
        this.inbound.push({ due: performance.now() + this.delay(), data });
      };

      socket.onclose = () => {
        this.socket = null;
      };
    });
  }

  private delay(): number {
    return this.sim.latency + Math.random() * this.sim.jitter;
  }

  send(bytes: Uint8Array): void {
    if (!this.connected) return;
    this.stats.sent++;

    if (Math.random() < this.sim.loss) {
      this.stats.dropped++;
      return;
    }
    this.outbound.push({ due: performance.now() + this.delay(), data: bytes });
  }

  /**
   * Deliver everything whose time has come, in due order.
   *
   * Called once per frame rather than driven by timers: it keeps delivery
   * aligned to the render loop, and it means a paused tab does not wake up and
   * dump four seconds of backlog in one frame.
   */
  pump(): void {
    const now = performance.now();

    if (this.outbound.length > 0) {
      this.outbound.sort((a, b) => a.due - b.due);
      while (this.outbound.length > 0 && this.outbound[0]!.due <= now) {
        const packet = this.outbound.shift()!;
        this.stats.bytesOut += packet.data.byteLength;
        this.socket?.send(packet.data);
      }
    }

    if (this.inbound.length === 0) return;
    this.inbound.sort((a, b) => a.due - b.due);

    while (this.inbound.length > 0 && this.inbound[0]!.due <= now) {
      const packet = this.inbound.shift()!;
      this.stats.received++;
      const reader = new Reader(packet.data);
      const type = reader.u8();

      if (type === Msg.S_PONG) {
        // Measured at the moment the packet became deliverable, not at the
        // moment we got round to delivering it. Packets are drained once per
        // frame on purpose, and folding that wait into the RTT readout would
        // report a slow renderer as a slow network — which is exactly the
        // confusion this whole panel exists to prevent.
        this.absorbPong(reader, packet.due);
        continue;
      }
      if (type === Msg.S_WELCOME) {
        this.playerId = reader.u16();
        this.tickRate = reader.u8();
        // The welcome carries the server's clock; seed the offset from it so
        // the very first frames have something usable, then let the pings
        // refine it.
        const serverTime = reader.u32();
        if (!this.clockReady) {
          this.offset = serverTime - performance.now();
          this.clockReady = true;
        }
        const slots = reader.u8();
        this.loadout = [];
        for (let i = 0; i < slots; i++) this.loadout.push(reader.u16());
        continue;
      }

      this.handler(type, reader);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Clock                                                               */
  /* ------------------------------------------------------------------ */

  ping(): void {
    this.send(new Writer(16).u8(Msg.C_PING).f64(performance.now()).finish());
  }

  /**
   * Absorb a pong.
   *
   * Keeps the sample with the **lowest** round trip rather than averaging.
   * Latency has a floor and a long tail — the floor is the real distance to the
   * server and the tail is queuing — so the minimum is the least contaminated
   * estimate of the offset, and it is what every clock sync worth the name does.
   */
  private absorbPong(reader: Reader, arrivedAt: number): void {
    const sentAt = reader.f64();
    const serverTime = reader.u32();
    const rtt = arrivedAt - sentAt;

    if (rtt >= this.rtt) return;
    this.rtt = rtt;
    // The reply was written half a round trip ago.
    this.offset = serverTime + rtt / 2 - arrivedAt;
    this.clockReady = true;
  }

  /** Let the estimate re-converge after a route change or a slider move. */
  resetClock(): void {
    this.rtt = Infinity;
  }
}
