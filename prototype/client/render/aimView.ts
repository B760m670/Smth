/**
 * The aim indicator: the band the cast will actually sweep.
 *
 * Needed for touch — there is no cursor on a phone, so without this you are
 * aiming at nothing — but it was missing on desktop too, and its absence was
 * hiding the most important promise the ability makes.
 *
 * The shape is not a decoration drawn to look roughly right. It is built from
 * `AbilityInstance.halfWidthAt`, the *same* function the server's hit resolver
 * calls and the crystal field places itself with. So the strip on the ground is
 * exactly the region that will take damage, at exactly the width it will take
 * it, and it cannot drift out of agreement with the spell without the spell
 * changing too.
 *
 * That is the lesson the sandbox's far-cast circle is built on: the footprint
 * you measured out before the click is the footprint you get. A targeting aid
 * that merely suggests where a spell lands teaches players to distrust it.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  type Scene
} from 'three';
import type { AbilityProfile } from '../../shared/profiles.ts';
import { lerp, saturate } from '../../shared/math.ts';

/** Samples down the band. Enough to keep a curved taper smooth. */
const STEPS = 20;

const VALID = new Color('#7fd8ff');
const INVALID = new Color('#ff5f6d');

export class AimView {
  private strip: Mesh;
  private ring: Mesh;
  private positions: Float32Array;
  private material: MeshBasicMaterial;
  private ringMaterial: MeshBasicMaterial;

  constructor() {
    this.positions = new Float32Array(STEPS * 2 * 3);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.positions, 3).setUsage(35048));

    const indices: number[] = [];
    for (let i = 0; i < STEPS - 1; i++) {
      const a = i * 2;
      indices.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    geometry.setIndex(indices);

    this.material = new MeshBasicMaterial({
      color: VALID,
      transparent: true,
      opacity: 0.22,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide
    });

    this.strip = new Mesh(geometry, this.material);
    this.strip.frustumCulled = false;
    this.strip.visible = false;
    this.strip.renderOrder = 5;

    this.ringMaterial = new MeshBasicMaterial({
      color: VALID,
      transparent: true,
      opacity: 0.75,
      blending: AdditiveBlending,
      depthWrite: false
    });
    this.ring = new Mesh(new RingGeometry(0.82, 1, 40).rotateX(-Math.PI / 2), this.ringMaterial);
    this.ring.frustumCulled = false;
    this.ring.visible = false;
    this.ring.renderOrder = 6;
  }

  addTo(scene: Scene): void {
    scene.add(this.strip, this.ring);
  }

  hide(): void {
    this.strip.visible = false;
    this.ring.visible = false;
  }

  /**
   * @param valid false when the target is inside the ability's minimum range —
   *              the one aim failure the server refuses rather than clamps, so
   *              the indicator has to say so before the click, not after.
   */
  show(
    profile: AbilityProfile,
    originX: number,
    originZ: number,
    yaw: number,
    distance: number,
    valid: boolean
  ): void {
    const dirX = Math.sin(yaw);
    const dirZ = Math.cos(yaw);
    // direction × up, matching `AbilityInstance`.
    const sideX = dirZ;
    const sideZ = -dirX;

    for (let i = 0; i < STEPS; i++) {
      const t = i / (STEPS - 1);
      // The same expression as `AbilityInstance.halfWidthAt` — see the note at
      // the top of this file about why that matters.
      const halfWidth = lerp(profile.widthNear, profile.width, Math.pow(saturate(t), profile.widthCurve));
      const along = t * distance;

      const cx = originX + dirX * along;
      const cz = originZ + dirZ * along;
      const o = i * 6;

      this.positions[o + 0] = cx - sideX * halfWidth;
      this.positions[o + 1] = 0.03;
      this.positions[o + 2] = cz - sideZ * halfWidth;
      this.positions[o + 3] = cx + sideX * halfWidth;
      this.positions[o + 4] = 0.03;
      this.positions[o + 5] = cz + sideZ * halfWidth;
    }

    this.strip.geometry.attributes.position!.needsUpdate = true;
    this.strip.visible = true;

    const color = valid ? VALID : INVALID;
    this.material.color.copy(color);
    this.ringMaterial.color.copy(color);

    this.ring.position.set(originX + dirX * distance, 0.04, originZ + dirZ * distance);
    this.ring.scale.setScalar(Math.max(0.4, profile.impactRadius));
    this.ring.visible = true;
  }

  dispose(scene: Scene): void {
    scene.remove(this.strip, this.ring);
    this.strip.geometry.dispose();
    this.ring.geometry.dispose();
    this.material.dispose();
    this.ringMaterial.dispose();
  }
}
