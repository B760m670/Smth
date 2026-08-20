/**
 * The visible half of a cast: a field of procedural ice.
 *
 * This is a deliberately small stand-in for `IceAbility` — one instanced mesh of
 * crystals and a marker riding the front, where the sandbox has three meshes, a
 * patched standard material, three particle systems and fifty-odd ground decals.
 * The point of the slice is not to reproduce the look; it is to prove the seam.
 * Everything below reads its dimensions out of the profile it was handed and
 * resolves them against an age it is given, so dropping the real ability in
 * later is a swap at this file and nothing above it.
 *
 * Two properties are load-bearing and worth keeping through that swap:
 *
 *   1. **Dice only.** A spike record holds a fraction along the line, a signed
 *      fraction across it and a few unitless jitters — no metres, no seconds.
 *      Every dimension is resolved per frame from the profile, which is what
 *      lets a profile edit reshape a field that is already standing.
 *   2. **A pure function of age.** No accumulated state, no per-frame trigger
 *      flags. `update(age)` with any age produces the correct frame, so a
 *      viewer who arrives two seconds into a cast draws a two-second-old field
 *      instead of starting it over.
 */

import {
  AdditiveBlending,
  Color,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  RingGeometry,
  type Scene
} from 'three';

import { AbilityInstance, ageAtDistance } from '../../shared/ability.ts';
import type { CastData } from '../../shared/ability.ts';
import type { AbilityProfile } from '../../shared/profiles.ts';
import { mulberry32 } from '../../shared/rng.ts';
import { lerp, saturate } from '../../shared/math.ts';
import { quality } from '../quality.ts';

/** Hard ceiling on crystals per cast, whatever the profile asks for. */
const MAX_SPIKES = 320;
/** Seconds of random delay spread across the field's rise. */
const RISE_STAGGER = 0.09;

const _dummy = new Object3D();

interface SpikeDice {
  along: number;
  lateral: number;
  heightJitter: number;
  radiusJitter: number;
  yaw: number;
  stagger: number;
}

export class CastView {
  readonly instance: AbilityInstance;
  readonly profile: AbilityProfile;
  /** True until the server confirms this cast. Only ever set on your own. */
  predicted: boolean;

  private mesh: InstancedMesh;
  private material: MeshStandardMaterial;
  private front: Mesh;
  private dice: SpikeDice[] = [];

  /**
   * When the front reaches each spike, seconds. Derived from the profile, so it
   * is cached against the two numbers it depends on and re-derived if either
   * moves — which is what keeps `speed` and the cast's reach live sliders
   * rather than values frozen at spawn.
   */
  private eruptAges: number[] = [];
  private eruptKey = '';

  constructor(profile: AbilityProfile, cast: CastData, geometry: InstancedMesh['geometry']) {
    this.profile = profile;
    this.predicted = false;
    this.instance = new AbilityInstance(profile, cast);

    // Cosmetic only: how *many* crystals draw the band, never how wide it is or
    // where it lands. A phone and a desktop must agree about the second even
    // when they disagree about the first.
    const count = Math.min(MAX_SPIKES, Math.max(8, Math.round(profile.spikeCount * quality.spikeScale)));

    // One material per cast. That is what makes a per-profile palette work at
    // all — two players on two ranks have two different colours on screen at
    // once, which is precisely what a single global settings object could not
    // express. Folding these into per-instance attributes so the whole world's
    // ice is one draw call is the obvious next move, and it does not change
    // anything about where the colours come from.
    this.material = new MeshStandardMaterial({
      color: new Color(profile.colorIce),
      emissive: new Color(profile.colorCore),
      emissiveIntensity: 0.55,
      roughness: 0.18,
      metalness: 0,
      transparent: true,
      opacity: 0.92,
      flatShading: true
    });

    this.mesh = new InstancedMesh(geometry, this.material, count);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.count = count;

    this.front = new Mesh(
      new RingGeometry(0.35, 0.62, 24).rotateX(-Math.PI / 2),
      new MeshBasicMaterial({
        color: new Color(profile.colorRim),
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false
      })
    );

    this.roll(cast.seed, count);
  }

  /**
   * Roll the field.
   *
   * Seeded, so every client that receives this cast rolls the identical field
   * from the same 32-bit number on the wire. `Math.random()` here would give
   * each viewer a different-looking spell.
   */
  private roll(seed: number, count: number): void {
    const rand = mulberry32(seed);
    this.dice.length = 0;

    for (let i = 0; i < count; i++) {
      // Evenly stepped down the line with a jittered stride, so the field has
      // no gaps but never looks stamped.
      this.dice.push({
        along: saturate((i + rand()) / count),
        lateral: rand() * 2 - 1,
        heightJitter: rand() * 2 - 1,
        radiusJitter: rand() * 2 - 1,
        yaw: rand() * Math.PI * 2,
        stagger: rand()
      });
    }
  }

  addTo(scene: Scene): void {
    scene.add(this.mesh, this.front);
  }

  /**
   * Adopt the server's version of a cast this client predicted.
   *
   * The seed already matched — the client chose it — so the field does not
   * reshuffle. What can differ is the origin (the server may have used its own
   * position), the clamped distance and `t0`. Rebuilding the instance against
   * those is the whole of the correction.
   *
   * @returns metres the correction moved the cast, for the HUD readout
   */
  adopt(authoritative: CastData): number {
    const dx = authoritative.originX - this.instance.cast.originX;
    const dz = authoritative.originZ - this.instance.cast.originZ;
    const moved = Math.hypot(dx, dz) + Math.abs(authoritative.distance - this.instance.cast.distance);

    const replacement = new AbilityInstance(this.profile, authoritative);
    // `instance` is readonly to everything else on purpose; this is the one
    // place a cast is allowed to change identity, and only into the server's.
    (this as { instance: AbilityInstance }).instance = replacement;
    this.predicted = false;
    this.eruptKey = '';

    return moved;
  }

  private syncEruptAges(): void {
    const key = `${this.profile.speed.toFixed(4)}|${this.instance.length.toFixed(4)}`;
    if (key === this.eruptKey) return;
    this.eruptKey = key;

    this.eruptAges.length = 0;
    for (const die of this.dice) {
      this.eruptAges.push(ageAtDistance(this.profile.speed, die.along * this.instance.length));
    }
  }

  /**
   * Draw the field as it stands at `age` seconds into the cast.
   * @returns false once the cast is over and the view can be reaped
   */
  update(age: number): boolean {
    if (this.instance.isDone(age)) return false;

    this.syncEruptAges();

    const p = this.profile;
    const fade = this.instance.fadeParamAt(age);
    // The field withdraws over the back half of the fade rather than the whole
    // of it, so it stands for a beat after the impact ends instead of sinking
    // the instant the timer flips.
    const retract = fade > 1 ? saturate((fade - 1) * 1.6) : 0;

    const progress = this.instance.progressAt(age);
    const travelling = age < this.instance.travelEnd;

    this.front.visible = travelling;
    if (travelling) {
      const point = this.instance.pointAt(progress, { x: 0, z: 0 });
      this.front.position.set(point.x, 0.05, point.z);
      const material = this.front.material as MeshBasicMaterial;
      material.opacity = 0.85;
      const swell = 1 + 0.35 * Math.sin(age * 22);
      this.front.scale.setScalar(Math.max(0.4, this.instance.halfWidthAt(progress) * swell));
    }

    for (let i = 0; i < this.dice.length; i++) {
      const die = this.dice[i]!;
      const emerge = this.emergence(age - this.eruptAges[i]! - die.stagger * RISE_STAGGER);

      if (emerge < 0) {
        // Still buried. Park it out of sight rather than drawing a degenerate
        // matrix at the origin.
        _dummy.position.set(0, -999, 0);
        _dummy.scale.setScalar(0.0001);
        _dummy.rotation.set(0, 0, 0);
        _dummy.updateMatrix();
        this.mesh.setMatrixAt(i, _dummy.matrix);
        continue;
      }

      const halfWidth = this.instance.halfWidthAt(die.along);
      const height = this.spikeHeight(die);
      const radius = Math.max(0.02, p.crystalRadius * (1 + die.radiusJitter * 0.3));

      const point = this.instance.pointAt(die.along, { x: 0, z: 0 });
      const offset = die.lateral * halfWidth;

      _dummy.position.set(
        point.x + this.instance.sideX * offset,
        (Math.min(emerge, 1.35) - 1) * height * 0.85 - retract * (height + 0.4),
        point.z + this.instance.sideZ * offset
      );
      _dummy.rotation.set(0, die.yaw, 0);
      _dummy.scale.set(radius, height, radius);
      _dummy.updateMatrix();
      this.mesh.setMatrixAt(i, _dummy.matrix);
    }

    this.mesh.instanceMatrix.needsUpdate = true;
    this.material.opacity = 0.92 * (1 - saturate(retract * 0.8));
    return true;
  }

  /** Full height of a spike, metres. Resolved from the profile every frame. */
  private spikeHeight(die: SpikeDice): number {
    const p = this.profile;
    let h = lerp(p.heightNear, p.height, Math.pow(saturate(die.along), p.heightCurve));
    // Domed silhouette: blades on the flanks are shorter than the spine.
    h *= lerp(1, 0.45, Math.pow(Math.abs(die.lateral), 1.4));
    h *= 1 + die.heightJitter * 0.35;
    return Math.max(0.05, h);
  }

  /**
   * How far out of the ground a spike is: 0 → 1 with a springy overshoot.
   * Negative while it is still buried and waiting.
   */
  private emergence(elapsed: number): number {
    if (elapsed < 0) return -1;
    const riseTime = Math.max(0.02, this.profile.riseTime);
    const rise = 1 - Math.pow(1 - saturate(elapsed / riseTime), 5);
    if (elapsed <= riseTime) return rise;

    // The punch-through carries past full height and settles back.
    const after = elapsed - riseTime;
    return 1 + 0.22 * Math.sin(after * 14) * Math.exp(-after / 0.35);
  }

  dispose(scene: Scene): void {
    scene.remove(this.mesh, this.front);
    this.mesh.dispose();
    this.material.dispose();
    this.front.geometry.dispose();
    (this.front.material as MeshBasicMaterial).dispose();
  }
}
