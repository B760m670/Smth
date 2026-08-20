/**
 * One place that decides how hard to push the device.
 *
 * A phone is not a small desktop. It has a fraction of the fill rate, a screen
 * whose device pixel ratio is often 3, and a thermal budget that turns a fast
 * first minute into a slow fifth one. Rendering at native resolution on a 3× DPR
 * panel means shading nine times the pixels of a 1× one, which is the single
 * biggest cost on mobile and the cheapest thing to give back.
 *
 * The knobs here are all *visual*. Nothing in this file may touch a number the
 * simulation reads — a phone and a desktop have to agree about where the ice
 * lands even if they disagree about how many crystals draw it.
 */

const coarse =
  typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/** True for phones and tablets: no hover, a thumb instead of a cursor. */
export const isTouch = coarse || (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0);

/** True when the viewport is phone-shaped, which drives the HUD layout. */
export const isSmallScreen = typeof window !== 'undefined' && Math.min(window.innerWidth, window.innerHeight) < 620;

export const mobile = isTouch && isSmallScreen;

export const quality = {
  /**
   * Cap on device pixel ratio. 1.5 on a phone is still sharper than most
   * desktops were until recently, and it roughly halves the fill cost against
   * an uncapped 3× panel.
   */
  pixelRatio: mobile ? 1.5 : 1.75,
  /** MSAA is a real cost on tile-based mobile GPUs for a flat-shaded look. */
  antialias: !mobile,
  shadowMapSize: mobile ? 1024 : 2048,
  /** Multiplier on how many crystals a cast draws. Cosmetic only. */
  spikeScale: mobile ? 0.55 : 1,
  /** How far away bodies and effects still get drawn, metres. */
  drawDistance: mobile ? 55 : 120
};

/** Let a device that turns out to be slow give back more, mid-session. */
export function degrade(): void {
  quality.pixelRatio = Math.max(0.75, quality.pixelRatio - 0.25);
  quality.spikeScale = Math.max(0.25, quality.spikeScale - 0.15);
}
