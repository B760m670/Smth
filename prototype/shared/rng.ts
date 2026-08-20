/**
 * Seeded PRNG.
 *
 * The sandbox calls `Math.random()` when a cast starts. That is fine when there
 * is one machine drawing the effect and nobody is watching for a second opinion.
 * Here the same cast is drawn on every client that can see it, so the dice have
 * to come out the same on all of them — and the only thing that travels over the
 * wire is a 32-bit seed.
 *
 * mulberry32: one multiply, a couple of shifts, passes gjrand for our purposes,
 * and — the part that matters — is trivially identical in any language, so a
 * future Go or Rust server can reproduce a client's rolls exactly.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Convenience: a stream of values in [-1, 1). */
export function signedStream(seed: number): () => number {
  const rand = mulberry32(seed);
  return () => rand() * 2 - 1;
}
