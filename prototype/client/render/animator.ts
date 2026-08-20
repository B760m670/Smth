/**
 * Procedural animation — no clips, no mixer, no animation data at all.
 *
 * Every pose below is a function of three things: how fast the body is moving,
 * how far it has moved, and how long ago it cast. That is a deliberate echo of
 * the rule the whole project runs on — the sandbox's abilities hold no
 * dimensions and resolve everything per frame from live settings, and this
 * holds no keyframes and resolves everything per frame from live state.
 *
 * It buys three things that matter here specifically:
 *
 *   1. **Animation costs zero bytes on the wire.** Remote bodies walk because
 *      their interpolated position is moving, and they cast because the
 *      `S_CAST` packet already arrived. There is no animation state to
 *      replicate, no clip index, no normalised time — and therefore nothing
 *      that can desynchronise from what the body is actually doing.
 *   2. **No foot sliding at any speed.** The stride phase advances by *distance
 *      travelled*, not by time, so the feet are planted against the ground the
 *      character is actually crossing. Time-driven cycles slide the moment
 *      anything changes the movement speed — a slow, a buff, a slope — and
 *      players read sliding feet as cheapness faster than they read anything
 *      else about a character.
 *   3. **It is replaceable at one seam.** Bones are driven by name, and an
 *      authored `AnimationClip` binds by name too. When these poses stop being
 *      good enough, an `AnimationMixer` takes over this file and nothing above
 *      it changes.
 *
 * What it does not buy: authored personality. A hand-animated cast has timing
 * and weight that a sine wave does not, and eventually a real MMO wants both —
 * procedural locomotion underneath, authored one-shots on top. The structure
 * here already allows that; only this file's contents would change.
 */

import type { Bone } from 'three';
import type { BoneMap, Proportions } from './humanoid.ts';
import { clamp, lerp, saturate } from '../../shared/math.ts';

/** Metres of ground covered by one full two-step stride cycle. */
const STRIDE = 1.55;
/** Speed at which the gait is fully a run rather than a walk, m/s. */
const RUN_SPEED = 4.6;

export interface AnimatorState {
  /** Ground speed, m/s. */
  speed: number;
  /** Metres travelled since the last frame — what advances the stride. */
  travelled: number;
  alive: boolean;
  /** Seconds since the last cast began, or a negative number for "not casting". */
  castAge: number;
  /** How long the cast gesture lasts, seconds. */
  castDuration: number;
}

export class Animator {
  private bones: BoneMap;
  private p: Proportions;

  /** Stride phase, radians. Advanced by distance, never by time. */
  private phase = Math.random() * Math.PI * 2;
  /** Smoothed speed, so a snapped-to position does not snap the gait. */
  private gait = 0;
  private clock = Math.random() * 100;
  /** 0 standing, 1 flat on the floor. */
  private fallen = 0;

  constructor(bones: BoneMap, proportions: Proportions) {
    this.bones = bones;
    this.p = proportions;
  }

  update(dt: number, state: AnimatorState): void {
    this.clock += dt;

    // Reconciliation and interpolation both produce position jumps; the gait
    // must not flicker between walk and run because one snapshot arrived late.
    this.gait = lerp(this.gait, state.speed, 1 - Math.pow(0.0001, dt));

    // Distance, not time. This is the line that stops the feet sliding.
    this.phase = (this.phase + (state.travelled / STRIDE) * Math.PI * 2) % (Math.PI * 2);

    const target = state.alive ? 0 : 1;
    this.fallen = lerp(this.fallen, target, 1 - Math.pow(0.0008, dt));

    this.rest();
    this.idle();

    const moving = saturate(this.gait / 0.7);
    if (moving > 0.001) this.locomotion(moving);

    if (state.castAge >= 0 && state.castAge < state.castDuration) {
      this.cast(state.castAge / state.castDuration);
    }

    if (this.fallen > 0.001) this.collapse();
  }

  /* ------------------------------------------------------------------ */

  /** The pose everything else is a deviation from. */
  private rest(): void {
    const b = this.bones;
    for (const name of Object.keys(b) as (keyof BoneMap)[]) {
      const bone = b[name];
      bone.rotation.set(0, 0, 0);
    }
    b.hips.position.y = this.p.hipHeight;

    // Arms hang slightly away from the body so they do not intersect the chest,
    // and the elbows carry a little bend — a perfectly straight arm reads as a
    // mannequin at any distance.
    b.upperArmL.rotation.z = 0.13;
    b.upperArmR.rotation.z = -0.13;
    b.forearmL.rotation.x = -0.12;
    b.forearmR.rotation.x = -0.12;
  }

  /** Breathing and weight shift. What stops a standing body looking paused. */
  private idle(): void {
    const b = this.bones;
    const t = this.clock;
    const still = 1 - saturate(this.gait / 1.2);
    if (still <= 0.001) return;

    const breath = Math.sin(t * 1.35);
    b.chest.rotation.x += breath * 0.022 * still;
    b.head.rotation.x -= breath * 0.014 * still;

    const sway = Math.sin(t * 0.62);
    b.hips.rotation.y += sway * 0.035 * still;
    b.chest.rotation.y -= sway * 0.05 * still;
    b.hips.position.y += Math.sin(t * 1.35 + 0.4) * 0.006 * still;

    b.upperArmL.rotation.x += sway * 0.05 * still;
    b.upperArmR.rotation.x -= sway * 0.05 * still;
  }

  /**
   * The walk / run cycle.
   *
   * One `phase` drives everything, and the relationships between the parts are
   * what sell it: the knee only ever bends backward, the arms swing opposite
   * their own leg, the shoulders counter-rotate against the hips, and the pelvis
   * drops twice per cycle — once for each footfall.
   */
  private locomotion(weight: number): void {
    const b = this.bones;
    const p = this.phase;
    const run = saturate(this.gait / RUN_SPEED);

    const thighSwing = lerp(0.52, 0.86, run) * weight;
    const kneeBend = lerp(0.85, 1.45, run) * weight;
    const armSwing = lerp(0.36, 0.72, run) * weight;
    const bob = lerp(0.022, 0.055, run) * weight;

    const sin = Math.sin(p);
    const sinOpposite = Math.sin(p + Math.PI);

    // Forward is +Z and limbs point −Y, so a forward swing is a *negative*
    // rotation about X. Getting this backwards makes a character moonwalk,
    // which is the single most common tell of a hand-rolled walk cycle.
    b.thighL.rotation.x -= sin * thighSwing;
    b.thighR.rotation.x -= sinOpposite * thighSwing;

    // The knee flexes on the swing-through and straightens before the heel
    // lands. Offsetting the phase is what puts the bend in the right half.
    b.shinL.rotation.x += Math.max(0, Math.sin(p - 0.85)) * kneeBend;
    b.shinR.rotation.x += Math.max(0, Math.sin(p + Math.PI - 0.85)) * kneeBend;

    // Ankles roughly cancel the leg's rotation so the sole stays near flat.
    b.footL.rotation.x += (sin * thighSwing - Math.max(0, Math.sin(p - 0.85)) * kneeBend) * 0.55;
    b.footR.rotation.x +=
      (sinOpposite * thighSwing - Math.max(0, Math.sin(p + Math.PI - 0.85)) * kneeBend) * 0.55;

    b.upperArmL.rotation.x += sin * armSwing;
    b.upperArmR.rotation.x += sinOpposite * armSwing;
    b.forearmL.rotation.x -= (0.25 + 0.35 * Math.max(0, sin)) * weight;
    b.forearmR.rotation.x -= (0.25 + 0.35 * Math.max(0, sinOpposite)) * weight;

    // Twice per cycle — one dip per footfall.
    b.hips.position.y -= (0.5 - 0.5 * Math.cos(p * 2)) * bob;
    b.hips.rotation.z += sin * 0.05 * weight;
    b.hips.rotation.y -= sin * 0.09 * weight;
    b.chest.rotation.y += sin * 0.13 * weight;

    // Lean into the run. A body sprinting bolt upright reads as gliding.
    const lean = lerp(0.04, 0.2, run) * weight;
    b.spine.rotation.x += lean;
    b.head.rotation.x -= lean * 0.7;
  }

  /**
   * The cast: wind the arm back, throw it forward, recover.
   *
   * Layered on top of whatever the legs are doing rather than replacing it, so
   * casting while running still runs. In a real build this is where an authored
   * upper-body clip goes, masked to the spine and above — the structure is
   * already the one that expects it.
   */
  private cast(t: number): void {
    const b = this.bones;
    const u = saturate(t);

    // Fast in, slow out: the throw has to land on the frame the effect starts,
    // and the recovery does not.
    const windup = Math.sin(Math.min(u / 0.34, 1) * Math.PI * 0.5);
    const release = u < 0.34 ? 0 : 1 - Math.pow(1 - (u - 0.34) / 0.66, 3);
    const weight = u < 0.85 ? 1 : 1 - (u - 0.85) / 0.15;

    // Back on the windup, then hard forward — the arm passes through the rest
    // pose rather than starting from it, which is where the sense of throw is.
    const armX = (windup * 0.85 - release * 2.55) * weight;
    const shoulderTwist = (windup * 0.3 - release * 0.55) * weight;

    b.upperArmR.rotation.x += armX;
    b.upperArmR.rotation.z += (-0.25 - release * 0.2) * weight;
    b.forearmR.rotation.x += (-0.9 + release * 0.65) * weight;
    b.handR.rotation.x += (-0.4 + release * 0.3) * weight;

    b.chest.rotation.y += shoulderTwist;
    b.hips.rotation.y += shoulderTwist * 0.35;
    b.spine.rotation.x += (-windup * 0.12 + release * 0.22) * weight;
    b.head.rotation.y += shoulderTwist * 0.4;

    // The off hand comes up to brace, which is most of what makes a one-armed
    // gesture look like it took effort.
    b.upperArmL.rotation.x += (-0.5 - release * 0.35) * weight;
    b.upperArmL.rotation.z += 0.35 * weight;
    b.forearmL.rotation.x += -1.0 * weight;

    // A short lunge onto the front foot. Lifted straight from the sandbox's
    // `castLunge`, which exists for the same reason: the body has to commit.
    const lunge = (windup * -0.05 + release * 0.13) * weight;
    b.hips.position.y -= Math.abs(lunge) * 0.4;
  }

  /** Death: fold at the hips and go down. */
  private collapse(): void {
    const b = this.bones;
    const f = this.fallen;

    b.hips.rotation.x += f * Math.PI * 0.5;
    b.hips.position.y = lerp(b.hips.position.y, this.p.limb * 0.6, f);
    b.spine.rotation.x -= f * 0.35;
    b.chest.rotation.x -= f * 0.3;
    b.head.rotation.x += f * 0.5;
    b.thighL.rotation.x -= f * 0.6;
    b.thighR.rotation.x -= f * 0.45;
    b.shinL.rotation.x += f * 0.9;
    b.shinR.rotation.x += f * 1.1;
    b.upperArmL.rotation.x += f * 0.7;
    b.upperArmR.rotation.x += f * 0.5;
  }

  /* ------------------------------------------------------------------ */

  /**
   * Where the caster's hand is, in world space.
   *
   * The seam VFX attach to: the sandbox's bolt leaves a hand, not a pair of
   * feet, and it currently reads that point out of a settings block. Once the
   * real abilities are ported, this is what feeds them.
   */
  handPosition(out: { x: number; y: number; z: number }): void {
    const hand: Bone = this.bones.handR;
    hand.updateWorldMatrix(true, false);
    out.x = hand.matrixWorld.elements[12]!;
    out.y = hand.matrixWorld.elements[13]!;
    out.z = hand.matrixWorld.elements[14]!;
  }

  /** Speed the gait is currently reading, for the HUD and for debugging. */
  get currentGait(): number {
    return clamp(this.gait, 0, 99);
  }
}
