/**
 * Stage: renderer, camera, floor, lights.
 *
 * Deliberately plain. The sandbox's environment — HDR probe, contact shadows,
 * the post stack, the procedural floor — is the *next* thing to drop in here,
 * and it drops in without touching anything above this file. What matters at
 * M0/M1 is that two capsules and a field of ice are legible enough to tell
 * whether the netcode is lying to you.
 */

import {
  AmbientLight,
  Color,
  DirectionalLight,
  Fog,
  GridHelper,
  HemisphereLight,
  Mesh,
  MeshStandardMaterial,
  PCFSoftShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  Vector3,
  WebGLRenderer,
  ACESFilmicToneMapping,
  SRGBColorSpace
} from 'three';
import { WORLD_HALF } from '../../shared/constants.ts';
import { damp } from '../../shared/math.ts';
import { mobile, quality } from '../quality.ts';

export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;

  /** Where the rig wants to be looking. Eased toward every frame. */
  private target = new Vector3();
  /**
   * A phone holds less of the world on screen than a laptop does, so the rig
   * sits lower and closer — otherwise the character is a thumbnail and the ice
   * is off the edge. This is framing, not quality: nothing about what the
   * simulation does changes with it.
   */
  private offset = mobile ? new Vector3(0, 8.5, 7.2) : new Vector3(0, 10.5, 9.0);

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: quality.antialias,
      powerPreference: 'high-performance'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = SRGBColorSpace;

    this.scene = new Scene();
    this.scene.background = new Color('#111820');
    this.scene.fog = new Fog('#111820', 40, 120);

    // A phone is held in portrait: tall and narrow, so the limit is how much
    // *width* fits. A wider field of view is what lets you see a cast coming in
    // from the side rather than discovering it when it lands.
    this.camera = new PerspectiveCamera(mobile ? 54 : 48, window.innerWidth / window.innerHeight, 0.1, 300);
    this.camera.position.set(0, 14, 12);

    const floor = new Mesh(
      new PlaneGeometry(WORLD_HALF * 2, WORLD_HALF * 2).rotateX(-Math.PI / 2),
      new MeshStandardMaterial({ color: '#1d242d', roughness: 0.95, metalness: 0 })
    );
    floor.receiveShadow = true;
    this.scene.add(floor);

    // A grid is not art direction, it is instrumentation: without a fixed
    // reference on the ground, prediction error and interpolation lag are very
    // hard to see, and seeing them is the entire job of this build.
    const grid = new GridHelper(WORLD_HALF * 2, WORLD_HALF, 0x2c3947, 0x222c36);
    grid.position.y = 0.01;
    this.scene.add(grid);

    const sun = new DirectionalLight('#e8f3ff', 2.2);
    sun.position.set(-14, 22, 10);
    sun.castShadow = true;
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    sun.shadow.camera.left = -WORLD_HALF;
    sun.shadow.camera.right = WORLD_HALF;
    sun.shadow.camera.top = WORLD_HALF;
    sun.shadow.camera.bottom = -WORLD_HALF;
    sun.shadow.camera.far = 90;
    sun.shadow.bias = -0.0009;
    this.scene.add(sun, sun.target);

    this.scene.add(new HemisphereLight('#bdd7ff', '#39424e', 0.5));
    this.scene.add(new AmbientLight('#8ea8d8', 0.2));

    window.addEventListener('resize', this.onResize, { passive: true });
  }

  private onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, quality.pixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  };

  /** Follow a point on the ground with a fixed offset and a soft lag. */
  follow(x: number, z: number, dt: number): void {
    this.target.set(x, 0, z);
    const wanted = this.target.clone().add(this.offset);
    this.camera.position.set(
      damp(this.camera.position.x, wanted.x, 0.002, dt),
      damp(this.camera.position.y, wanted.y, 0.002, dt),
      damp(this.camera.position.z, wanted.z, 0.002, dt)
    );
    this.camera.lookAt(this.target);
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
