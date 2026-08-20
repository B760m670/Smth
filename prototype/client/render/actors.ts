/**
 * Bodies: a skinned character, a health bar, and the server ghost.
 *
 * The character is generated (see `humanoid.ts`) and animated procedurally (see
 * `animator.ts`). What lives here is the part that connects them to the
 * network: turning a stream of positions — predicted for you, interpolated for
 * everyone else — into the speed and distance the animator needs.
 *
 * That conversion is the only interesting thing in this file, and it has one
 * trap in it. Positions do not always mean movement: a respawn teleports, a
 * reconciliation can snap, and a late snapshot can arrive as a jump. Feeding
 * those to a stride cycle makes the legs spin. Anything past `TELEPORT` metres
 * in a frame is therefore treated as a cut, not a step.
 *
 * The **server ghost** stays: a wireframe capsule at the position the server
 * last reported for you, next to the position you are predicting. When
 * prediction is healthy it is invisible inside your body; when it is not, you
 * can watch exactly how and when it separates.
 */

import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Camera,
  type Scene
} from 'three';
import { ACTOR_RADIUS, MAX_HP } from '../../shared/constants.ts';
import { createHumanoid, DEFAULT_PROPORTIONS, type Humanoid } from './humanoid.ts';
import { Animator } from './animator.ts';

const BAR_HEIGHT = DEFAULT_PROPORTIONS.height + 0.32;

/** Metres in one frame beyond which a position change is a cut, not a step. */
const TELEPORT = 1.5;

/** How long the throw gesture runs, seconds. */
export const CAST_GESTURE = 0.62;

const SELF_COLOR = new Color('#5fb8e8');
const OTHER_COLOR = new Color('#e0865a');
const BOT_COLOR = new Color('#7c8794');
const DEAD_COLOR = new Color('#3b434d');

export class Actor {
  /** The body. Yawed with the character. */
  readonly group = new Group();
  /** The health bar, billboarded — kept out of the yawed group deliberately. */
  readonly barGroup = new Group();

  private humanoid: Humanoid;
  private animator: Animator;
  private barFill: Mesh;
  private baseColor: Color;

  private lastX = 0;
  private lastZ = 0;
  private seeded = false;
  private castAge = -1;

  alive = true;

  constructor(isSelf: boolean, isBot: boolean) {
    this.baseColor = isSelf ? SELF_COLOR : isBot ? BOT_COLOR : OTHER_COLOR;

    this.humanoid = createHumanoid(this.baseColor);
    this.animator = new Animator(this.humanoid.bones, this.humanoid.proportions);
    this.group.add(this.humanoid.mesh);

    const back = new Mesh(new BoxGeometry(0.78, 0.085, 0.02), new MeshBasicMaterial({ color: '#11161c' }));
    this.barGroup.add(back);

    this.barFill = new Mesh(
      new BoxGeometry(0.78, 0.085, 0.03),
      new MeshBasicMaterial({ color: isSelf ? '#7ef0a8' : '#ff7a6f' })
    );
    this.barFill.position.z = 0.01;
    this.barGroup.add(this.barFill);
  }

  addTo(scene: Scene): void {
    scene.add(this.group, this.barGroup);
  }

  /**
   * Place the body and advance its animation.
   *
   * Speed is derived rather than sent, which is the whole reason animation
   * costs nothing on the wire: a remote body walks because its interpolated
   * position is moving, and the interpolation already had to happen.
   */
  sync(x: number, z: number, yaw: number, dt: number): void {
    if (!this.seeded) {
      this.lastX = x;
      this.lastZ = z;
      this.seeded = true;
    }

    let travelled = Math.hypot(x - this.lastX, z - this.lastZ);
    if (travelled > TELEPORT) travelled = 0;
    this.lastX = x;
    this.lastZ = z;

    this.group.position.set(x, 0, z);
    this.group.rotation.y = yaw;
    this.barGroup.position.set(x, BAR_HEIGHT, z);

    if (this.castAge >= 0) {
      this.castAge += dt;
      if (this.castAge > CAST_GESTURE) this.castAge = -1;
    }

    this.animator.update(dt, {
      speed: dt > 0 ? travelled / dt : 0,
      travelled,
      alive: this.alive,
      castAge: this.castAge,
      castDuration: CAST_GESTURE
    });
  }

  /** Throw the cast gesture. Driven by the `S_CAST` packet, not by a flag. */
  playCast(): void {
    this.castAge = 0;
  }

  setHealth(hp: number, alive: boolean): void {
    const t = Math.max(0, Math.min(1, hp / MAX_HP));
    this.barFill.scale.x = Math.max(0.001, t);
    this.barFill.position.x = -(1 - t) * 0.39;

    if (alive === this.alive) return;
    this.alive = alive;
    this.humanoid.material.color.copy(alive ? this.baseColor : DEAD_COLOR);
    this.barGroup.visible = alive;
    if (alive) this.castAge = -1;
  }

  faceCamera(camera: Camera): void {
    this.barGroup.quaternion.copy(camera.quaternion);
  }

  /** Where this character's casting hand is, in world space. */
  handPosition(out: { x: number; y: number; z: number }): void {
    this.animator.handPosition(out);
  }

  dispose(scene: Scene): void {
    scene.remove(this.group, this.barGroup);
    this.humanoid.dispose();
    for (const node of this.barGroup.children) {
      const mesh = node as Mesh;
      mesh.geometry?.dispose();
      (mesh.material as MeshBasicMaterial | undefined)?.dispose();
    }
  }
}

/** The authoritative position of the local player, drawn as a wireframe. */
export class ServerGhost {
  readonly mesh: Mesh;

  constructor() {
    this.mesh = new Mesh(
      new CapsuleGeometry(ACTOR_RADIUS, 1.1, 4, 10),
      new MeshBasicMaterial({ color: '#ff4d6d', wireframe: true, transparent: true, opacity: 0.55 })
    );
    this.mesh.position.y = ACTOR_RADIUS + 0.55;
    this.mesh.visible = false;
  }

  set(x: number, z: number): void {
    this.mesh.position.x = x;
    this.mesh.position.z = z;
  }
}
