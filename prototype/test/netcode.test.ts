/**
 * The two properties the whole slice rests on.
 *
 *   1. **Client and server agree about movement.** Prediction is only invisible
 *      if replaying unacknowledged inputs on top of an authoritative position
 *      lands exactly where the server will land. One shared `applyInput` is
 *      supposed to guarantee that; this proves it rather than assuming it.
 *   2. **The server decides.** A client cannot name a profile it does not own,
 *      cannot beat its cooldown, and cannot move further than wall clock allows
 *      by lying about `dt`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../server/world.ts';
import { Predictor } from '../client/prediction.ts';
import { applyInput } from '../shared/sim.ts';
import type { MoveState } from '../shared/sim.ts';
import { MOVE_SPEED, MAX_INPUT_DT, TICK_MS } from '../shared/constants.ts';
import { RejectReason } from '../shared/protocol.ts';
import { profileById } from '../shared/profiles.ts';

test('replayed prediction lands where the server lands', () => {
  const world = new World();
  const player = world.addPlayer('Test');
  player.state.x = 0;
  player.state.z = 0;

  const predictor = new Predictor();
  predictor.teleport(0, 0);

  // Twenty inputs of running north-east, of which the server has seen twelve.
  const inputs = [];
  for (let i = 0; i < 20; i++) {
    inputs.push(predictor.sample(1 / 60, 1, -1, 0));
  }

  for (const input of inputs.slice(0, 12)) world.queueInput(player, input);

  // Let the server chew through them; the per-tick budget means this takes
  // several ticks, which is exactly the situation reconciliation exists for.
  for (let i = 0; i < 10; i++) world.update(i * TICK_MS, TICK_MS / 1000);

  predictor.reconcile(player.state.x, player.state.z, player.lastAppliedSeq);

  // Now feed the server the rest and let it catch up.
  for (const input of inputs.slice(12)) world.queueInput(player, input);
  for (let i = 10; i < 24; i++) world.update(i * TICK_MS, TICK_MS / 1000);

  assert.equal(player.lastAppliedSeq, 20, 'the server should have consumed every input');
  assert.ok(
    Math.abs(player.state.x - predictor.state.x) < 1e-9,
    `x: server ${player.state.x} vs predicted ${predictor.state.x}`
  );
  assert.ok(
    Math.abs(player.state.z - predictor.state.z) < 1e-9,
    `z: server ${player.state.z} vs predicted ${predictor.state.z}`
  );
});

test('a diagonal is not faster than a straight line', () => {
  const straight: MoveState = { x: 0, z: 0, yaw: 0 };
  const diagonal: MoveState = { x: 0, z: 0, yaw: 0 };

  applyInput(straight, { seq: 1, dt: 1 / 60, moveX: 1, moveZ: 0, yaw: 0 });
  applyInput(diagonal, { seq: 1, dt: 1 / 60, moveX: 1, moveZ: 1, yaw: 0 });

  const a = Math.hypot(straight.x, straight.z);
  const b = Math.hypot(diagonal.x, diagonal.z);
  assert.ok(Math.abs(a - b) < 1e-12, `${a} vs ${b}`);
  assert.ok(Math.abs(a - MOVE_SPEED / 60) < 1e-12);
});

test('an oversized dt buys no extra distance', () => {
  const honest: MoveState = { x: 0, z: 0, yaw: 0 };
  const liar: MoveState = { x: 0, z: 0, yaw: 0 };

  applyInput(honest, { seq: 1, dt: MAX_INPUT_DT, moveX: 1, moveZ: 0, yaw: 0 });
  applyInput(liar, { seq: 1, dt: 10, moveX: 1, moveZ: 0, yaw: 0 });

  assert.equal(honest.x, liar.x, 'dt is clamped inside the shared step');
});

test('a flood of forged inputs is capped by the per-tick budget', () => {
  const world = new World();
  const player = world.addPlayer('Cheat');
  player.state.x = 0;
  player.state.z = 0;

  for (let i = 1; i <= 200; i++) {
    world.queueInput(player, { seq: i, dt: MAX_INPUT_DT, moveX: 1, moveZ: 0, yaw: 0 });
  }

  world.update(0, TICK_MS / 1000);

  // One tick may not yield much more than one tick's worth of travel.
  const ceiling = MOVE_SPEED * (TICK_MS / 1000) * 1.6;
  assert.ok(player.state.x <= ceiling, `moved ${player.state.x} m in one tick, ceiling ${ceiling}`);
});

test('a client cannot cast a profile it does not own', () => {
  const world = new World();
  const player = world.addPlayer('Test');
  player.loadout = [1];

  const good = world.tryCast(player, base(0));
  assert.equal(good.ok, true);

  const bad = world.tryCast(player, base(4));
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.equal(bad.reason, RejectReason.UNKNOWN_SLOT);
});

test('cooldowns are held by the server', () => {
  const world = new World();
  const player = world.addPlayer('Test');
  const profile = profileById(1)!;

  world.update(0, 0);
  assert.equal(world.tryCast(player, base(0)).ok, true);

  const immediate = world.tryCast(player, base(0));
  assert.equal(immediate.ok, false);
  if (!immediate.ok) assert.equal(immediate.reason, RejectReason.COOLDOWN);

  world.update(profile.cooldown * 1000 + 1, 0);
  assert.equal(world.tryCast(player, base(0)).ok, true);
});

test('casting inside the minimum range is refused, not nudged outward', () => {
  const world = new World();
  const player = world.addPlayer('Test');
  const profile = profileById(1)!;

  const attempt = { ...base(0), distance: profile.minRange - 0.2 };
  const result = world.tryCast(player, attempt);

  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, RejectReason.TOO_CLOSE);
});

test('a far-away claimed origin is replaced by the server position', () => {
  const world = new World();
  const player = world.addPlayer('Test');
  player.state.x = 0;
  player.state.z = 0;

  const result = world.tryCast(player, { ...base(0), originX: 30, originZ: 30 });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.cast.instance.cast.originX, 0);
    assert.equal(result.cast.instance.cast.originZ, 0);
  }

  // ... but a plausible one, inside the latency tolerance, is honoured.
  world.update(5000, 0);
  const near = world.tryCast(player, { ...base(0), originX: 0.9, originZ: 0 });
  assert.equal(near.ok, true);
  if (near.ok) assert.equal(near.cast.instance.cast.originX, 0.9);
});

test('the front hits what it sweeps over, once, and the impact hits again', () => {
  const world = new World();
  const caster = world.addPlayer('Caster');
  const victim = world.addPlayer('Victim');
  const profile = profileById(1)!;

  caster.state.x = 0;
  caster.state.z = 0;
  // Straight down +Z, right in the middle of the band, and at the far end so
  // the terminal cluster catches them too.
  victim.state.x = 0;
  victim.state.z = 10;

  world.update(0, 0);
  const result = world.tryCast(caster, { ...base(0), yaw: 0, distance: 10 });
  assert.equal(result.ok, true);

  let sweepHits = 0;
  let totalDamage = 0;

  for (let tick = 1; tick < 200; tick++) {
    world.update(tick * TICK_MS, TICK_MS / 1000);
    for (const hit of world.hits) {
      if (hit.targetId !== victim.id) continue;
      sweepHits++;
      totalDamage += hit.damage;
    }
  }

  // One sweep hit and one impact hit — never a hit per tick.
  assert.equal(sweepHits, 2, 'expected exactly one sweep hit and one impact hit');
  assert.equal(totalDamage, profile.damage + profile.impactDamage);
});

test('someone standing outside the band is not hit', () => {
  const world = new World();
  const caster = world.addPlayer('Caster');
  const bystander = world.addPlayer('Bystander');

  caster.state.x = 0;
  caster.state.z = 0;
  // Well off the axis and short of the impact cluster.
  bystander.state.x = 9;
  bystander.state.z = 5;

  world.update(0, 0);
  assert.equal(world.tryCast(caster, { ...base(0), yaw: 0, distance: 12 }).ok, true);

  for (let tick = 1; tick < 200; tick++) {
    world.update(tick * TICK_MS, TICK_MS / 1000);
    for (const hit of world.hits) {
      assert.notEqual(hit.targetId, bystander.id, 'a bystander outside the band took damage');
    }
  }
});

test('a caster is not caught by their own cast', () => {
  const world = new World();
  const caster = world.addPlayer('Caster');
  caster.state.x = 0;
  caster.state.z = 0;

  world.update(0, 0);
  world.tryCast(caster, { ...base(0), yaw: 0, distance: 12 });

  for (let tick = 1; tick < 200; tick++) {
    world.update(tick * TICK_MS, TICK_MS / 1000);
    assert.equal(world.hits.length, 0);
  }
});

/* ---------------------------------------------------------------------- */

function base(slot: number) {
  return {
    slot,
    seed: 42,
    originX: 0,
    originZ: 0,
    yaw: 0,
    distance: 12
  };
}
