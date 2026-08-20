/**
 * A character, built in code.
 *
 * No FBX, no Mixamo, no download, no licence to read. The body is a real
 * `SkinnedMesh` over a real eighteen-bone skeleton, generated from a proportion
 * table — which means two things that matter beyond "it is not a capsule":
 *
 *   1. **One draw call per character.** Eighteen separate limb meshes would be
 *      eighteen draw calls each, and at forty players that is the decal problem
 *      all over again. Skinning them into one buffer is the same cost as a real
 *      authored character, because it *is* the same thing.
 *   2. **It is the seam an authored rig drops into.** The animator below drives
 *      bones by name, and an `AnimationClip` authored elsewhere binds to bones
 *      by name too. Swapping this for a modelled character later replaces this
 *      file and nothing above it — which is exactly how the sandbox loads its
 *      Mixamo rig and plays clips exported from three other files onto it.
 *
 * Proportions are a parameter block rather than constants, because races,
 * silhouettes and "this one is a dwarf" are the same knob, and because the
 * project's whole argument is that generated content is cheaper to vary than
 * authored content.
 *
 * Bind convention, chosen to keep the animator readable: **torso bones point
 * +Y, limb bones point −Y**, so a bind pose needs no rotations at all and every
 * joint angle in `animator.ts` is a rotation away from a clean T-less rest pose.
 */

import {
  BufferAttribute,
  BufferGeometry,
  Bone,
  Color,
  Matrix4,
  MeshStandardMaterial,
  Skeleton,
  SkinnedMesh,
  Vector3
} from 'three';

export interface Proportions {
  /** Overall height, metres. Everything below scales to hit it. */
  height: number;
  hipHeight: number;
  thigh: number;
  shin: number;
  foot: number;
  pelvis: number;
  spine: number;
  chest: number;
  neck: number;
  head: number;
  upperArm: number;
  forearm: number;
  hand: number;
  /** Half the distance between the hip joints. */
  hipWidth: number;
  shoulderWidth: number;
  /** Limb thickness, metres. */
  limb: number;
  torsoDepth: number;
}

export const DEFAULT_PROPORTIONS: Proportions = {
  height: 1.78,
  hipHeight: 1.0,
  thigh: 0.5,
  shin: 0.44,
  foot: 0.17,
  pelvis: 0.1,
  spine: 0.2,
  chest: 0.24,
  neck: 0.06,
  head: 0.21,
  upperArm: 0.28,
  forearm: 0.26,
  hand: 0.11,
  hipWidth: 0.105,
  // The shoulder joint sits at the edge of the ribcage, not inside it. Set this
  // narrower than half the chest and the arms disappear into the torso — which
  // is the first thing that happened here.
  shoulderWidth: 0.21,
  limb: 0.115,
  torsoDepth: 0.19
};

/** Sum of the segments that stack from the floor to the crown. */
function naturalHeight(p: Proportions): number {
  return p.hipHeight + p.pelvis + p.spine + p.chest + p.neck + p.head;
}

/** Every bone the animator knows about, in skeleton order. */
export const BONES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'upperArmL',
  'forearmL',
  'handL',
  'upperArmR',
  'forearmR',
  'handR',
  'thighL',
  'shinL',
  'footL',
  'thighR',
  'shinR',
  'footR'
] as const;

export type BoneName = (typeof BONES)[number];

export type BoneMap = Record<BoneName, Bone>;

/** One limb segment, described in the bone's own space before skinning. */
interface Segment {
  bone: BoneName;
  /** Length along the bone's axis. Negative for limbs (they point −Y). */
  along: number;
  /** Cross-section at the root and at the tip, metres. */
  wide: [number, number];
  deep: [number, number];
  /** Axis the segment extends along. Feet point +Z; everything else is ±Y. */
  axis?: 'y' | 'z';
  /** Offset of the segment's start, in bone space. */
  offset?: [number, number, number];
}

export interface Humanoid {
  mesh: SkinnedMesh;
  bones: BoneMap;
  proportions: Proportions;
  material: MeshStandardMaterial;
  dispose(): void;
}

/**
 * Build a character.
 *
 * @param color   body colour — one material per character for now, which is the
 *                same trade `castView.ts` makes and has the same upgrade path
 *                (per-instance attributes) when the crowd gets big.
 */
export function createHumanoid(color: Color, proportions: Proportions = DEFAULT_PROPORTIONS): Humanoid {
  const p = proportions;

  /* ------------------------------------------------------------------ */
  /* 1. The skeleton                                                     */
  /* ------------------------------------------------------------------ */

  const bones = {} as BoneMap;
  const make = (name: BoneName, x: number, y: number, z: number, parent?: BoneName): Bone => {
    const bone = new Bone();
    bone.name = name;
    bone.position.set(x, y, z);
    bones[name] = bone;
    if (parent) bones[parent].add(bone);
    return bone;
  };

  make('hips', 0, p.hipHeight, 0);
  make('spine', 0, p.pelvis, 0, 'hips');
  make('chest', 0, p.spine, 0, 'spine');
  make('neck', 0, p.chest, 0, 'chest');
  make('head', 0, p.neck, 0, 'neck');

  // Arms hang from the top of the chest, pointing down.
  make('upperArmL', -p.shoulderWidth, p.chest * 0.86, 0, 'chest');
  make('forearmL', 0, -p.upperArm, 0, 'upperArmL');
  make('handL', 0, -p.forearm, 0, 'forearmL');

  make('upperArmR', p.shoulderWidth, p.chest * 0.86, 0, 'chest');
  make('forearmR', 0, -p.upperArm, 0, 'upperArmR');
  make('handR', 0, -p.forearm, 0, 'forearmR');

  make('thighL', -p.hipWidth, 0, 0, 'hips');
  make('shinL', 0, -p.thigh, 0, 'thighL');
  make('footL', 0, -p.shin, 0, 'shinL');

  make('thighR', p.hipWidth, 0, 0, 'hips');
  make('shinR', 0, -p.thigh, 0, 'thighR');
  make('footR', 0, -p.shin, 0, 'shinR');

  const boneList = BONES.map((name) => bones[name]);

  /* ------------------------------------------------------------------ */
  /* 2. The skin                                                         */
  /* ------------------------------------------------------------------ */

  const limb = p.limb;
  const segments: Segment[] = [
    { bone: 'hips', along: p.pelvis, wide: [p.hipWidth * 2 + limb, p.hipWidth * 2 + limb * 0.9], deep: [p.torsoDepth, p.torsoDepth] },
    { bone: 'spine', along: p.spine, wide: [p.hipWidth * 2 + limb * 0.9, p.shoulderWidth * 1.5], deep: [p.torsoDepth, p.torsoDepth * 1.02] },
    { bone: 'chest', along: p.chest, wide: [p.shoulderWidth * 1.5, p.shoulderWidth * 1.72], deep: [p.torsoDepth * 1.02, p.torsoDepth * 0.94] },
    { bone: 'neck', along: p.neck, wide: [limb * 0.9, limb * 0.85], deep: [limb * 0.9, limb * 0.85] },
    { bone: 'head', along: p.head, wide: [limb * 1.7, limb * 1.45], deep: [limb * 1.95, limb * 1.6] },

    { bone: 'upperArmL', along: -p.upperArm, wide: [limb * 0.92, limb * 0.78], deep: [limb * 0.92, limb * 0.78] },
    { bone: 'forearmL', along: -p.forearm, wide: [limb * 0.78, limb * 0.62], deep: [limb * 0.78, limb * 0.62] },
    { bone: 'handL', along: -p.hand, wide: [limb * 0.66, limb * 0.5], deep: [limb * 0.4, limb * 0.34] },

    { bone: 'upperArmR', along: -p.upperArm, wide: [limb * 0.92, limb * 0.78], deep: [limb * 0.92, limb * 0.78] },
    { bone: 'forearmR', along: -p.forearm, wide: [limb * 0.78, limb * 0.62], deep: [limb * 0.78, limb * 0.62] },
    { bone: 'handR', along: -p.hand, wide: [limb * 0.66, limb * 0.5], deep: [limb * 0.4, limb * 0.34] },

    { bone: 'thighL', along: -p.thigh, wide: [limb * 1.15, limb * 0.95], deep: [limb * 1.15, limb * 0.95] },
    { bone: 'shinL', along: -p.shin, wide: [limb * 0.95, limb * 0.7], deep: [limb * 0.95, limb * 0.7] },
    { bone: 'footL', along: p.foot, wide: [limb * 0.9, limb * 0.8], deep: [limb * 0.62, limb * 0.5], axis: 'z', offset: [0, -limb * 0.3, 0] },

    { bone: 'thighR', along: -p.thigh, wide: [limb * 1.15, limb * 0.95], deep: [limb * 1.15, limb * 0.95] },
    { bone: 'shinR', along: -p.shin, wide: [limb * 0.95, limb * 0.7], deep: [limb * 0.95, limb * 0.7] },
    { bone: 'footR', along: p.foot, wide: [limb * 0.9, limb * 0.8], deep: [limb * 0.62, limb * 0.5], axis: 'z', offset: [0, -limb * 0.3, 0] }
  ];

  // Bind-pose world matrices. The geometry is authored in world space, and the
  // skeleton's bone inverses undo exactly this — which is what "bind pose"
  // means and why the rest pose needs no rotations anywhere.
  bones.hips.updateMatrixWorld(true);

  const positions: number[] = [];
  const normals: number[] = [];
  const skinIndices: number[] = [];
  const skinWeights: number[] = [];

  const _v = new Vector3();
  const _n = new Vector3();
  const _normalMatrix = new Matrix4();

  for (const segment of segments) {
    const boneIndex = BONES.indexOf(segment.bone);
    const bone = bones[segment.bone];
    const world = bone.matrixWorld;
    _normalMatrix.copy(world);
    // Uniform scale throughout, so the world matrix doubles as a normal matrix
    // once the translation is dropped.
    _normalMatrix.setPosition(0, 0, 0);

    const box = taperedBox(segment);

    for (let i = 0; i < box.position.length; i += 3) {
      _v.set(box.position[i]!, box.position[i + 1]!, box.position[i + 2]!).applyMatrix4(world);
      positions.push(_v.x, _v.y, _v.z);

      _n.set(box.normal[i]!, box.normal[i + 1]!, box.normal[i + 2]!)
        .applyMatrix4(_normalMatrix)
        .normalize();
      normals.push(_n.x, _n.y, _n.z);

      // Rigid binding: one bone, full weight. Joints crease rather than bend
      // smoothly, which on a stylised low-poly body reads as intentional — and
      // when it stops being good enough, this is the only place that changes.
      skinIndices.push(boneIndex, 0, 0, 0);
      skinWeights.push(1, 0, 0, 0);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(normals), 3));
  geometry.setAttribute('skinIndex', new BufferAttribute(new Uint16Array(skinIndices), 4));
  geometry.setAttribute('skinWeight', new BufferAttribute(new Float32Array(skinWeights), 4));
  geometry.computeBoundingSphere();

  const material = new MeshStandardMaterial({
    color,
    roughness: 0.62,
    metalness: 0.04,
    flatShading: true
  });

  const mesh = new SkinnedMesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // The body is built in world space around the origin and then posed by the
  // skeleton; its own bounds move with the animation, and re-deriving them per
  // frame costs more than it saves at this scale.
  mesh.frustumCulled = false;

  const skeleton = new Skeleton(boneList);
  mesh.add(bones.hips);
  mesh.bind(skeleton);

  // `height` is the knob that actually means something to a designer, so make it
  // real rather than decorative: the segment table describes a silhouette, and
  // this scales that silhouette to the height asked for. Races, "this one is a
  // dwarf" and a child NPC are all this one number.
  const scale = p.height / naturalHeight(p);
  mesh.scale.setScalar(scale);

  return {
    mesh,
    bones,
    proportions: p,
    material,
    dispose(): void {
      geometry.dispose();
      material.dispose();
      skeleton.dispose();
    }
  };
}

/* ---------------------------------------------------------------------- */

/**
 * A box that tapers from root to tip, as flat-shaded triangles.
 *
 * Non-indexed with per-face normals for the same reason the sandbox's crystals
 * are: the facets have to stay crisp. A limb is twelve triangles, so the whole
 * character comes to a couple of hundred — cheaper than the capsule it replaces.
 */
function taperedBox(segment: Segment): { position: number[]; normal: number[] } {
  const { along, wide, deep, axis = 'y', offset = [0, 0, 0] } = segment;

  const [ox, oy, oz] = offset;
  const corner = (end: 0 | 1, sx: number, st: number): [number, number, number] => {
    const w = wide[end]! * 0.5 * sx;
    const d = deep[end]! * 0.5 * st;
    const reach = along * end;
    return axis === 'y' ? [ox + w, oy + reach, oz + d] : [ox + w, oy + d, oz + reach];
  };

  // root ring, then tip ring, each counter-clockwise seen from outside.
  const ring = (end: 0 | 1): [number, number, number][] => [
    corner(end, -1, -1),
    corner(end, 1, -1),
    corner(end, 1, 1),
    corner(end, -1, 1)
  ];

  const a = ring(0);
  const b = ring(1);

  const position: number[] = [];
  const normal: number[] = [];

  const tri = (p0: number[], p1: number[], p2: number[]): void => {
    const ux = p1[0]! - p0[0]!;
    const uy = p1[1]! - p0[1]!;
    const uz = p1[2]! - p0[2]!;
    const vx = p2[0]! - p0[0]!;
    const vy = p2[1]! - p0[1]!;
    const vz = p2[2]! - p0[2]!;
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;

    for (const p of [p0, p1, p2]) {
      position.push(p[0]!, p[1]!, p[2]!);
      normal.push(nx, ny, nz);
    }
  };

  const quad = (p0: number[], p1: number[], p2: number[], p3: number[]): void => {
    tri(p0, p1, p2);
    tri(p0, p2, p3);
  };

  // Winding, and the one place this generator is easy to get wrong.
  //
  // The ring is laid out in (x, z) for segments running along Y and in (x, y)
  // for those running along Z, and those two orderings have opposite handedness.
  // So the rule is not simply "flip when the segment points backwards": a torso
  // (+Y) needs flipping and a foot (+Z) does not. Getting this wrong culls the
  // faces you meant to see and leaves a character with legs and no chest.
  const flip = axis === 'y' ? along > 0 : along < 0;
  const q = (p0: number[], p1: number[], p2: number[], p3: number[]): void =>
    flip ? quad(p0, p3, p2, p1) : quad(p0, p1, p2, p3);

  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    q(a[i]!, a[j]!, b[j]!, b[i]!);
  }
  q(a[3]!, a[2]!, a[1]!, a[0]!); // root cap
  q(b[0]!, b[1]!, b[2]!, b[3]!); // tip cap

  return { position, normal };
}
