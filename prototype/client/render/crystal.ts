/**
 * Procedural ice crystal geometry.
 *
 * Adapted from `src/assets/ProceduralGeometry.js` in the Elemental Sandbox
 * (https://github.com/achrefelouafi/LinearAbiltyCastingThreeJS), MIT licence,
 * © 2026 mohamedachrefelouafi. Trimmed to the crystal generator and ported to
 * TypeScript; the shape maths is unchanged.
 *
 * Unit space: base ring on y = 0 with a circumscribed radius of 0.5, apex at
 * y = 1. An instance therefore scales footprint and height independently, which
 * is what lets one geometry serve a whole field of differently proportioned
 * spikes — and what lets the *profile* decide those proportions per caster.
 *
 * A six-sided crystal comes out at 60 triangles, cheap enough to regenerate
 * outright when a shape control moves rather than approximate in a shader.
 */

import { BufferGeometry, Float32BufferAttribute } from 'three';

const TAU = Math.PI * 2;

/** Deterministic hash → [0,1). */
function hash11(n: number): number {
  const s = Math.sin(n * 127.1) * 43758.5453123;
  return s - Math.floor(s);
}

/** Ring heights up the crystal, as fractions of the way to the tip. */
const RING_HEIGHTS = [0, 0.22, 0.5, 0.75, 0.92];

function profileRadius(t: number, taper: number): number {
  return taper + (1 - taper) * Math.pow(1 - t, 1.15);
}

export interface CrystalOptions {
  seed?: number;
  sides?: number;
  taper?: number;
  roughness?: number;
  bend?: number;
}

export function createCrystalGeometry({
  seed = 1,
  sides = 6,
  taper = 0.13,
  roughness = 0.28,
  bend = 0.22
}: CrystalOptions = {}): BufferGeometry {
  const facets = Math.max(3, Math.round(sides));
  const tipRadius = Math.min(0.9, Math.max(0.01, taper));

  // One fixed bend direction per crystal, so a field leans convincingly
  // instead of every spike curving the same way.
  const bendAngle = hash11(seed * 1.77) * TAU;
  const bendX = Math.cos(bendAngle);
  const bendZ = Math.sin(bendAngle);

  const axisOffset = (t: number): number => bend * 0.5 * Math.pow(t, 1.6);

  // Angles are jittered once and shared by every ring, so the facets stay
  // continuous edges up the crystal rather than twisting into a screw.
  const angles: number[] = [];
  for (let i = 0; i < facets; i++) {
    const jitter = (hash11(seed * 3.13 + i * 7.7) - 0.5) * (TAU / facets) * 0.55 * roughness * 3;
    angles.push((i / facets) * TAU + jitter);
  }

  const rings = RING_HEIGHTS.map((t, ringIndex) => {
    const baseR = profileRadius(t, tipRadius) * 0.5;
    const drift = axisOffset(t);
    const y = t + (hash11(seed * 5.9 + ringIndex * 2.3) - 0.5) * 0.06 * roughness * (t > 0 ? 1 : 0);

    return angles.map((angle, i) => {
      // Irregularity grows toward the tip: a crystal is roughly round where it
      // leaves the ground and increasingly ragged where it was torn.
      const wobble =
        1 +
        (hash11(seed * 11.1 + ringIndex * 13.7 + i * 3.9) - 0.5) * roughness * 1.3 * (0.35 + 0.65 * t);
      const r = Math.max(0.002, baseR * wobble);
      return [Math.cos(angle) * r + bendX * drift, y, Math.sin(angle) * r + bendZ * drift] as const;
    });
  });

  const apexDrift = axisOffset(1);
  const apex = [
    bendX * apexDrift + (hash11(seed * 17.3) - 0.5) * 0.09 * roughness,
    1,
    bendZ * apexDrift + (hash11(seed * 19.7) - 0.5) * 0.09 * roughness
  ] as const;
  const floorCentre = [0, 0, 0] as const;

  const positions: number[] = [];
  const push = (p: readonly number[]): void => {
    positions.push(p[0]!, p[1]!, p[2]!);
  };

  for (let ring = 0; ring < rings.length - 1; ring++) {
    const lower = rings[ring]!;
    const upper = rings[ring + 1]!;
    for (let i = 0; i < facets; i++) {
      const j = (i + 1) % facets;
      push(lower[i]!); push(lower[j]!); push(upper[i]!);
      push(lower[j]!); push(upper[j]!); push(upper[i]!);
    }
  }

  const top = rings[rings.length - 1]!;
  const base = rings[0]!;
  for (let i = 0; i < facets; i++) {
    const j = (i + 1) % facets;
    push(top[i]!); push(top[j]!); push(apex);           // the point
    push(floorCentre); push(base[j]!); push(base[i]!);  // the underside
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  // Non-indexed + per-face normals: this is what makes the facets crisp.
  geometry.computeVertexNormals();
  return geometry;
}
