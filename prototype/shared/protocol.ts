/**
 * The wire format.
 *
 * Binary, hand-rolled, little-endian. JSON would have been two hours cheaper to
 * write and is the right first move for most prototypes — it is not the right
 * move here, because the whole argument for this architecture rests on one
 * claim: **a cast fits in about twenty bytes**, and a claim like that has to be
 * checkable. `test/protocol.test.ts` asserts the exact size of `S_CAST`, so the
 * number in the documentation cannot quietly stop being true.
 *
 * Server time is milliseconds since the server booted, as u32 — 49 days of
 * uptime before it wraps, which is a real limit and the right kind of debt for a
 * slice: visible, documented, and one field-width change away from gone.
 */

import { packCm, packYaw, unpackCm, unpackYaw } from './math.ts';

export const Msg = {
  /* client → server */
  C_HELLO: 1,
  C_INPUT: 2,
  C_CAST: 3,
  C_PING: 4,

  /* server → client */
  S_WELCOME: 128,
  S_SNAPSHOT: 129,
  S_CAST: 130,
  S_CAST_REJECT: 131,
  S_HIT: 132,
  S_JOIN: 133,
  S_LEAVE: 134,
  S_PONG: 135,
  S_DEATH: 136
} as const;

export const RejectReason = {
  COOLDOWN: 1,
  TOO_CLOSE: 2,
  UNKNOWN_SLOT: 3,
  DEAD: 4
} as const;

export const REJECT_TEXT: Record<number, string> = {
  [RejectReason.COOLDOWN]: 'Not ready',
  [RejectReason.TOO_CLOSE]: 'Too close — aim further out',
  [RejectReason.UNKNOWN_SLOT]: 'Nothing in that slot',
  [RejectReason.DEAD]: 'You are dead'
};

/* ---------------------------------------------------------------------- */
/* Cursors                                                                 */
/* ---------------------------------------------------------------------- */

export class Writer {
  private view: DataView;
  private offset = 0;

  constructor(capacity = 1024) {
    this.view = new DataView(new ArrayBuffer(capacity));
  }

  private need(bytes: number): void {
    if (this.offset + bytes <= this.view.byteLength) return;
    let size = this.view.byteLength * 2;
    while (size < this.offset + bytes) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(new Uint8Array(this.view.buffer, 0, this.offset));
    this.view = new DataView(grown.buffer);
  }

  u8(v: number): this {
    this.need(1);
    this.view.setUint8(this.offset, v & 0xff);
    this.offset += 1;
    return this;
  }

  i8(v: number): this {
    this.need(1);
    this.view.setInt8(this.offset, Math.max(-128, Math.min(127, v | 0)));
    this.offset += 1;
    return this;
  }

  u16(v: number): this {
    this.need(2);
    this.view.setUint16(this.offset, v & 0xffff, true);
    this.offset += 2;
    return this;
  }

  i16(v: number): this {
    this.need(2);
    this.view.setInt16(this.offset, v, true);
    this.offset += 2;
    return this;
  }

  u32(v: number): this {
    this.need(4);
    this.view.setUint32(this.offset, v >>> 0, true);
    this.offset += 4;
    return this;
  }

  f32(v: number): this {
    this.need(4);
    this.view.setFloat32(this.offset, v, true);
    this.offset += 4;
    return this;
  }

  f64(v: number): this {
    this.need(8);
    this.view.setFloat64(this.offset, v, true);
    this.offset += 8;
    return this;
  }

  str(v: string): this {
    const bytes = new TextEncoder().encode(v.slice(0, 32));
    this.u8(bytes.length);
    this.need(bytes.length);
    new Uint8Array(this.view.buffer).set(bytes, this.offset);
    this.offset += bytes.length;
    return this;
  }

  /** Metres → centimetre i16. See `math.ts` for why. */
  cm(v: number): this {
    return this.i16(packCm(v));
  }

  yaw(radians: number): this {
    return this.u16(packYaw(radians));
  }

  finish(): Uint8Array {
    return new Uint8Array(this.view.buffer, 0, this.offset);
  }
}

export class Reader {
  private view: DataView;
  private offset = 0;

  constructor(data: ArrayBuffer | Uint8Array) {
    this.view =
      data instanceof Uint8Array
        ? new DataView(data.buffer, data.byteOffset, data.byteLength)
        : new DataView(data);
  }

  get remaining(): number {
    return this.view.byteLength - this.offset;
  }

  u8(): number {
    const v = this.view.getUint8(this.offset);
    this.offset += 1;
    return v;
  }

  i8(): number {
    const v = this.view.getInt8(this.offset);
    this.offset += 1;
    return v;
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }

  i16(): number {
    const v = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return v;
  }

  f64(): number {
    const v = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return v;
  }

  str(): string {
    const len = this.u8();
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, len);
    this.offset += len;
    return new TextDecoder().decode(bytes);
  }

  cm(): number {
    return unpackCm(this.i16());
  }

  yaw(): number {
    return unpackYaw(this.u16());
  }
}

/* ---------------------------------------------------------------------- */
/* S_CAST — the packet the whole design is arguing for                     */
/* ---------------------------------------------------------------------- */

export interface CastWire {
  casterId: number;
  profileId: number;
  seed: number;
  /** Server time the cast began, ms since boot. */
  t0: number;
  originX: number;
  originZ: number;
  yaw: number;
  distance: number;
}

/**
 * 21 bytes: type, caster, profile, seed, start time, origin, heading, reach.
 *
 * Note what is *not* in here. No particle state, no positions of any crystal, no
 * per-frame anything — the effect is a pure function of these fields and the
 * profile they name, so every viewer derives the identical bolt of ice. A
 * viewer who arrives late derives it from the right phase by evaluating at
 * `now − t0`, which is the property that makes this whole approach worth the
 * trouble.
 */
export function writeCast(w: Writer, c: CastWire): Writer {
  return w
    .u8(Msg.S_CAST)
    .u16(c.casterId)
    .u16(c.profileId)
    .u32(c.seed)
    .u32(c.t0)
    .cm(c.originX)
    .cm(c.originZ)
    .yaw(c.yaw)
    .u16(Math.round(c.distance * 100));
}

export function readCast(r: Reader): CastWire {
  return {
    casterId: r.u16(),
    profileId: r.u16(),
    seed: r.u32(),
    t0: r.u32(),
    originX: r.cm(),
    originZ: r.cm(),
    yaw: r.yaw(),
    distance: r.u16() / 100
  };
}

/** The size `writeCast` produces, asserted by the tests. */
export const CAST_PACKET_BYTES = 21;
