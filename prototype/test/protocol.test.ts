/**
 * The wire format, and the one number the architecture is arguing for.
 *
 * If `S_CAST` ever quietly grows past what the documentation claims, this test
 * is what says so. That matters more than it looks: the whole reason the sandbox
 * approach is worth porting into a networked game is that a cast replicates as a
 * handful of bytes, and a claim nobody checks stops being true.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CAST_PACKET_BYTES, Reader, Writer, readCast, writeCast } from '../shared/protocol.ts';
import { packYaw, unpackYaw, packCm, unpackCm } from '../shared/math.ts';

test('a cast fits in 21 bytes', () => {
  const bytes = writeCast(new Writer(64), {
    casterId: 7,
    profileId: 2,
    seed: 0xdeadbeef,
    t0: 1234567,
    originX: -12.34,
    originZ: 5.67,
    yaw: 2.1,
    distance: 15.5
  }).finish();

  assert.equal(bytes.byteLength, CAST_PACKET_BYTES);
  assert.equal(bytes.byteLength, 21);
});

test('a cast round-trips inside its quantisation budget', () => {
  const original = {
    casterId: 7,
    profileId: 2,
    seed: 0xdeadbeef,
    t0: 1234567,
    originX: -12.34,
    originZ: 5.67,
    yaw: 2.1,
    distance: 15.5
  };

  const bytes = writeCast(new Writer(64), original).finish();
  const reader = new Reader(bytes);
  assert.equal(reader.u8(), 130); // Msg.S_CAST
  const decoded = readCast(reader);

  assert.equal(decoded.casterId, original.casterId);
  assert.equal(decoded.profileId, original.profileId);
  assert.equal(decoded.seed, original.seed, 'the seed must survive exactly — it is the field');
  assert.equal(decoded.t0, original.t0);

  // Positions are centimetre-quantised; headings are a 65536th of a turn.
  assert.ok(Math.abs(decoded.originX - original.originX) <= 0.005);
  assert.ok(Math.abs(decoded.originZ - original.originZ) <= 0.005);
  assert.ok(Math.abs(decoded.distance - original.distance) <= 0.005);
  assert.ok(Math.abs(decoded.yaw - original.yaw) < 0.0002);
});

test('quantisation is stable across the whole range it claims', () => {
  for (let i = 0; i < 360; i++) {
    const radians = (i / 360) * Math.PI * 2;
    const back = unpackYaw(packYaw(radians));
    assert.ok(Math.abs(back - radians) < 0.0002, `yaw ${radians} came back as ${back}`);
  }

  for (const metres of [-320, -40.5, -0.01, 0, 0.01, 12.34, 40.5, 320]) {
    assert.ok(Math.abs(unpackCm(packCm(metres)) - metres) <= 0.005);
  }
});

test('negative yaw normalises rather than wrapping to nonsense', () => {
  const back = unpackYaw(packYaw(-Math.PI / 2));
  assert.ok(Math.abs(back - (Math.PI * 1.5)) < 0.0002);
});

test('the writer grows past its initial capacity without corrupting', () => {
  const w = new Writer(4);
  for (let i = 0; i < 300; i++) w.u32(i);

  const r = new Reader(w.finish());
  for (let i = 0; i < 300; i++) assert.equal(r.u32(), i);
  assert.equal(r.remaining, 0);
});

test('strings round-trip', () => {
  const w = new Writer(8).str('Player 42').str('шестая абилка');
  const r = new Reader(w.finish());
  assert.equal(r.str(), 'Player 42');
  assert.equal(r.str(), 'шестая абилка');
});
