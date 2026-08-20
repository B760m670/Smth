/**
 * Bodies: a capsule, a facing wedge, a health bar.
 *
 * Plus one thing that is not decoration — the **server ghost**. It is a
 * wireframe capsule drawn at the position the server last reported for *you*,
 * next to the position you are predicting. When prediction is healthy the ghost
 * sits inside your body and is invisible; when the reconciliation is wrong, or
 * the input budget is clipping you, or the latency slider goes up, the ghost
 * separates and you can watch exactly how and when. Every networked game grows
 * this eventually; growing it on day one is cheaper than debugging without it.
 */

import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Camera,
  type Scene
} from 'three';
import { ACTOR_RADIUS, MAX_HP } from '../../shared/constants.ts';

const BODY_HEIGHT = 1.15;
const BAR_HEIGHT = ACTOR_RADIUS * 2 + BODY_HEIGHT + 0.35;

const SELF_COLOR = new Color('#6fd3ff');
const OTHER_COLOR = new Color('#ffb27a');
const BOT_COLOR = new Color('#9aa6b4');
const DEAD_COLOR = new Color('#39414c');

export class Actor {
  /** Body and facing wedge. Yawed with the character. */
  readonly group = new Group();
  /**
   * The health bar, kept *out* of the yawed group on purpose: it is billboarded
   * to the camera, and a billboard parented to a rotating node has to undo its
   * parent's rotation every frame to stay flat. Separating them costs one
   * position copy and removes the whole class of bug.
   */
  readonly barGroup = new Group();

  private body: Mesh;
  private wedge: Mesh;
  private barFill: Mesh;
  private baseColor: Color;

  alive = true;

  constructor(isSelf: boolean, isBot: boolean) {
    this.baseColor = isSelf ? SELF_COLOR : isBot ? BOT_COLOR : OTHER_COLOR;

    this.body = new Mesh(
      new CapsuleGeometry(ACTOR_RADIUS, BODY_HEIGHT, 6, 14),
      new MeshStandardMaterial({ color: this.baseColor, roughness: 0.55, metalness: 0.05 })
    );
    this.body.position.y = ACTOR_RADIUS + BODY_HEIGHT * 0.5;
    this.body.castShadow = true;
    this.group.add(this.body);

    // Which way they are facing. Capsules are rotationally symmetric, and a
    // cast that comes out of a featureless pill is impossible to read.
    this.wedge = new Mesh(
      new ConeGeometry(0.16, 0.5, 4).rotateX(Math.PI / 2),
      new MeshStandardMaterial({ color: '#ffffff', roughness: 0.4 })
    );
    this.wedge.position.set(0, 1.0, ACTOR_RADIUS + 0.2);
    this.group.add(this.wedge);

    const back = new Mesh(new BoxGeometry(1.0, 0.11, 0.02), new MeshBasicMaterial({ color: '#11161c' }));
    this.barGroup.add(back);

    this.barFill = new Mesh(
      new BoxGeometry(1.0, 0.11, 0.03),
      new MeshBasicMaterial({ color: isSelf ? '#7ef0a8' : '#ff7a6f' })
    );
    this.barFill.position.z = 0.01;
    this.barGroup.add(this.barFill);
  }

  addTo(scene: Scene): void {
    scene.add(this.group, this.barGroup);
  }

  setTransform(x: number, z: number, yaw: number): void {
    this.group.position.set(x, 0, z);
    this.group.rotation.y = yaw;
    this.barGroup.position.set(x, BAR_HEIGHT, z);
  }

  setHealth(hp: number, alive: boolean): void {
    const t = Math.max(0, Math.min(1, hp / MAX_HP));
    this.barFill.scale.x = Math.max(0.001, t);
    // Drain from the right edge rather than from the middle.
    this.barFill.position.x = -(1 - t) * 0.5;

    if (alive === this.alive) return;
    this.alive = alive;

    const material = this.body.material as MeshStandardMaterial;
    material.color.copy(alive ? this.baseColor : DEAD_COLOR);
    this.wedge.visible = alive;
    this.barGroup.visible = alive;
    // A corpse lies down. Cheapest possible death animation, and it reads
    // instantly from a top-down camera where a colour change does not.
    this.body.rotation.z = alive ? 0 : Math.PI * 0.5;
    this.body.position.y = alive ? ACTOR_RADIUS + BODY_HEIGHT * 0.5 : ACTOR_RADIUS;
  }

  faceCamera(camera: Camera): void {
    this.barGroup.quaternion.copy(camera.quaternion);
  }

  dispose(scene: Scene): void {
    scene.remove(this.group, this.barGroup);
    for (const root of [this.group, this.barGroup]) {
      root.traverse((node) => {
        const mesh = node as Mesh;
        mesh.geometry?.dispose();
        (mesh.material as MeshStandardMaterial | undefined)?.dispose();
      });
    }
  }
}

/** The authoritative position of the local player, drawn as a wireframe. */
export class ServerGhost {
  readonly mesh: Mesh;

  constructor() {
    this.mesh = new Mesh(
      new CapsuleGeometry(ACTOR_RADIUS, BODY_HEIGHT, 4, 10),
      new MeshBasicMaterial({ color: '#ff4d6d', wireframe: true, transparent: true, opacity: 0.55 })
    );
    this.mesh.position.y = ACTOR_RADIUS + BODY_HEIGHT * 0.5;
    this.mesh.visible = false;
  }

  set(x: number, z: number): void {
    this.mesh.position.x = x;
    this.mesh.position.z = z;
  }
}
