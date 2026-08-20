/**
 * The claims this file exists to keep honest:
 *
 *   1. Replacing the sandbox's per-frame integration with a closed form did not
 *      change the motion. If it did, the ability would *feel* different, and
 *      "network-safe" would have been bought with the thing that made it good.
 *   2. `ageAtDistance` really inverts `frontAt`, because the crystal field's
 *      whole "pure function of age" property rests on it.
 *   3. The same seed produces the same field on every machine.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { AbilityInstance, Phase, ageAtDistance, _internal } from '../shared/ability.ts';
import type { CastData } from '../shared/ability.ts';
import { profileById } from '../shared/profiles.ts';
import { mulberry32 } from '../shared/rng.ts';
import { saturate, outQuad } from '../shared/math.ts';

const profile = profileById(1)!;

function castAt(distance: number, yaw = 0): CastData {
  return {
    casterId: 1,
    profileId: profile.id,
    seed: 12345,
    t0: 0,
    originX: 0,
    originZ: 0,
    yaw,
    distance
  };
}

test('the closed form matches the sandbox integration it replaced', () => {
  const speed = profile.speed;
  const T = _internal.EASE_IN_TIME;

  // The original: front += speed * outQuad(saturate(age / 0.08)) * dt, stepped.
  const dt = 1 / 20000;
  let front = 0;
  let age = 0;

  for (let i = 0; i < 20000; i++) {
    age += dt;
    front += speed * outQuad(saturate(age / T)) * dt;
  }

  const closed = _internal.rawFrontAt(speed, age);
  // A Riemann sum this fine should agree to well under a millimetre.
  assert.ok(
    Math.abs(closed - front) < 0.001,
    `closed form ${closed.toFixed(6)} vs integrated ${front.toFixed(6)}`
  );
});

test('ageAtDistance inverts frontAt across both regimes', () => {
  const speed = profile.speed;

  // Inside the ease-in (solved by bisection) and well past it (solved by hand).
  for (const distance of [0.05, 0.3, 0.9, 1.4, 5, 15, 40]) {
    const age = ageAtDistance(speed, distance);
    const back = _internal.rawFrontAt(speed, age);
    assert.ok(
      Math.abs(back - distance) < 1e-4,
      `distance ${distance}: age ${age} put the front at ${back}`
    );
  }
});

test('the front never overshoots the cast and the phases run in order', () => {
  const instance = new AbilityInstance(profile, castAt(12));

  assert.equal(instance.phaseAt(0), Phase.TRAVEL);
  assert.equal(instance.progressAt(0), 0);

  assert.ok(instance.progressAt(instance.travelEnd - 0.001) < 1);
  assert.equal(instance.progressAt(instance.travelEnd), 1);
  assert.equal(instance.progressAt(instance.travelEnd + 5), 1, 'the front is clamped to the line');

  assert.equal(instance.phaseAt(instance.travelEnd + 0.01), Phase.IMPACT);
  assert.equal(instance.phaseAt(instance.impactEnd + 0.01), Phase.FADE);
  assert.equal(instance.phaseAt(instance.fadeEnd + 0.01), Phase.DONE);
  assert.ok(instance.isDone(instance.fadeEnd));
});

test('evaluating at an age is the same however you got there — mid-cast join', () => {
  // The property a late viewer depends on: no history, so no way to disagree
  // with a client that has been watching since the start.
  const a = new AbilityInstance(profile, castAt(15));
  const b = new AbilityInstance(profile, castAt(15));

  for (const age of [0.05, 0.21, 0.4, 0.73, 1.1]) {
    assert.equal(a.frontAt(age), b.frontAt(age));
    assert.equal(a.fadeParamAt(age), b.fadeParamAt(age));
  }
});

test('the band widens along the cast and the hit test agrees with it', () => {
  const instance = new AbilityInstance(profile, castAt(15));

  assert.ok(instance.halfWidthAt(0) < instance.halfWidthAt(1));
  assert.equal(instance.halfWidthAt(0), profile.widthNear);
  assert.equal(instance.halfWidthAt(1), profile.width);

  const late = instance.travelEnd;

  // Dead centre, halfway down: hit.
  assert.ok(instance.sweptOver(0, 7.5, late, 0));
  // Just outside the band at the same distance: missed.
  const halfWidth = instance.halfWidthAt(0.5);
  assert.ok(!instance.sweptOver(halfWidth + 0.4, 7.5, late, 0));
  // Behind the caster: never.
  assert.ok(!instance.sweptOver(0, -3, late, 0));
  // Past the end of the line: not by the sweep (the impact cluster covers it).
  assert.ok(!instance.sweptOver(0, 18, late, 0));
});

test('the front has not reached a distant target early', () => {
  const instance = new AbilityInstance(profile, castAt(15));
  // At a tenth of a second the front is a few metres out, so the far end of the
  // cast must still be untouched.
  assert.ok(instance.frontAt(0.1) < 14);
  assert.ok(!instance.sweptOver(0, 14, 0.1, 0));
  assert.ok(instance.sweptOver(0, 14, instance.travelEnd, 0));
});

test('a seed reproduces the same rolls anywhere', () => {
  const a = mulberry32(0xc0ffee);
  const b = mulberry32(0xc0ffee);
  for (let i = 0; i < 64; i++) assert.equal(a(), b());

  const c = mulberry32(0xc0ffef);
  assert.notEqual(mulberry32(0xc0ffee)(), c());
});

test('the local frame is orthonormal for any heading', () => {
  for (const yaw of [0, 0.7, Math.PI / 2, 3.9, -2.2]) {
    const instance = new AbilityInstance(profile, castAt(10, yaw));
    const dirLength = Math.hypot(instance.dirX, instance.dirZ);
    const sideLength = Math.hypot(instance.sideX, instance.sideZ);
    const dotted = instance.dirX * instance.sideX + instance.dirZ * instance.sideZ;

    assert.ok(Math.abs(dirLength - 1) < 1e-9);
    assert.ok(Math.abs(sideLength - 1) < 1e-9);
    assert.ok(Math.abs(dotted) < 1e-9);
  }
});
