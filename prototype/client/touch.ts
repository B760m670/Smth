/**
 * Touch controls.
 *
 * A skillshot needs two things a phone does not have: a direction to walk and a
 * point to aim at, at the same time, from two thumbs. The convention that
 * solved this is the mobile MOBA one, and there is no reason to invent a worse
 * version of it:
 *
 *   - **Left thumb: a floating stick.** It appears wherever the thumb lands
 *     rather than sitting in a fixed corner, because a fixed stick means looking
 *     down at the screen to find it. Direction only; the magnitude is ignored
 *     past the dead zone, since there is one walk speed.
 *   - **Right thumb: drag from an ability button.** Press the button and the
 *     aim indicator appears; drag to swing it; release to cast. Sliding back
 *     onto the button cancels, which is the affordance that makes a mis-tap
 *     recoverable — on a phone you cannot right-click to cancel.
 *
 * The aim indicator this drives is drawn in the world (see `aimView.ts`), not
 * as a UI overlay, because the thing being judged is a distance in metres on the
 * ground and every other measurement in this project is too.
 *
 * On a desktop none of this attaches, and the mouse path in `main.ts` is
 * untouched.
 */

const DEAD_ZONE = 12;
const STICK_RADIUS = 56;
/** Drag length, in CSS pixels, that maps to the ability's full range. */
const AIM_FULL_DRAG = 150;
/** Inside this, the cast is cancelled instead of thrown. */
const CANCEL_RADIUS = 26;

export interface TouchAim {
  /** Unit direction on the ground plane, screen-relative. */
  x: number;
  z: number;
  /** 0..1 of the ability's usable range. */
  reach: number;
  /** True while the thumb is close enough to the button to cancel. */
  cancelling: boolean;
}

export class TouchControls {
  /** −1..1 on each axis, screen-relative. Consumed by the input sampler. */
  readonly move = { x: 0, z: 0 };

  aiming = false;
  readonly aim: TouchAim = { x: 0, z: 1, reach: 0, cancelling: false };
  /** Which slot the current drag is aiming. */
  slot = 0;

  onCast: (slot: number) => void = () => {};
  onSelect: (slot: number) => void = () => {};

  private stick: HTMLElement;
  private knob: HTMLElement;
  private moveTouch: number | null = null;
  private moveOrigin = { x: 0, y: 0 };

  private aimTouch: number | null = null;
  private aimOrigin = { x: 0, y: 0 };

  constructor(root: HTMLElement) {
    this.stick = document.createElement('div');
    this.stick.className = 'stick';
    this.knob = document.createElement('div');
    this.knob.className = 'knob';
    this.stick.appendChild(this.knob);
    root.appendChild(this.stick);

    window.addEventListener('touchstart', this.onStart, { passive: false });
    window.addEventListener('touchmove', this.onMove, { passive: false });
    window.addEventListener('touchend', this.onEnd, { passive: false });
    window.addEventListener('touchcancel', this.onEnd, { passive: false });
  }

  /**
   * Ability buttons are claimed by index rather than by listening on them.
   *
   * A `touchstart` on the button and the `touchmove`s that follow belong to the
   * same gesture, and only the window sees all of them — a listener on the
   * button stops hearing once the thumb leaves it, which is every drag.
   */
  private slotAt(x: number, y: number): number {
    const element = document.elementFromPoint(x, y)?.closest('.slot') as HTMLElement | null;
    if (!element?.dataset.index) return -1;
    return Number(element.dataset.index);
  }

  private onStart = (event: TouchEvent): void => {
    for (const touch of Array.from(event.changedTouches)) {
      const slot = this.slotAt(touch.clientX, touch.clientY);

      if (slot >= 0 && this.aimTouch === null) {
        event.preventDefault();
        this.aimTouch = touch.identifier;
        this.aimOrigin = { x: touch.clientX, y: touch.clientY };
        this.slot = slot;
        this.aiming = true;
        this.aim.reach = 0;
        this.aim.cancelling = true;
        this.onSelect(slot);
        continue;
      }

      // Anything that is not a control and not the HUD starts the stick.
      if (this.moveTouch === null && !isInterface(touch.clientX, touch.clientY)) {
        event.preventDefault();
        this.moveTouch = touch.identifier;
        this.moveOrigin = { x: touch.clientX, y: touch.clientY };
        this.showStick(touch.clientX, touch.clientY);
      }
    }
  };

  private onMove = (event: TouchEvent): void => {
    for (const touch of Array.from(event.changedTouches)) {
      if (touch.identifier === this.moveTouch) {
        event.preventDefault();
        const dx = touch.clientX - this.moveOrigin.x;
        const dy = touch.clientY - this.moveOrigin.y;
        const length = Math.hypot(dx, dy);

        if (length < DEAD_ZONE) {
          this.move.x = 0;
          this.move.z = 0;
          this.knob.style.transform = 'translate(-50%, -50%)';
          continue;
        }

        // Direction only — there is one walk speed, so a half-pushed stick
        // walking at half pace would just be a way to be slower by accident.
        this.move.x = dx / length;
        this.move.z = dy / length;

        const clamped = Math.min(length, STICK_RADIUS);
        this.knob.style.transform =
          `translate(calc(-50% + ${(dx / length) * clamped}px), calc(-50% + ${(dy / length) * clamped}px))`;
      } else if (touch.identifier === this.aimTouch) {
        event.preventDefault();
        const dx = touch.clientX - this.aimOrigin.x;
        const dy = touch.clientY - this.aimOrigin.y;
        const length = Math.hypot(dx, dy);

        this.aim.cancelling = length < CANCEL_RADIUS;
        if (length > 1) {
          this.aim.x = dx / length;
          this.aim.z = dy / length;
        }
        this.aim.reach = Math.min(1, length / AIM_FULL_DRAG);
      }
    }
  };

  private onEnd = (event: TouchEvent): void => {
    for (const touch of Array.from(event.changedTouches)) {
      if (touch.identifier === this.moveTouch) {
        this.moveTouch = null;
        this.move.x = 0;
        this.move.z = 0;
        this.hideStick();
      } else if (touch.identifier === this.aimTouch) {
        this.aimTouch = null;
        this.aiming = false;
        // Releasing on the button is a cancel, not a cast at zero range.
        if (!this.aim.cancelling) this.onCast(this.slot);
        this.aim.cancelling = false;
      }
    }
  };

  private showStick(x: number, y: number): void {
    this.stick.style.left = `${x}px`;
    this.stick.style.top = `${y}px`;
    this.stick.classList.add('show');
    this.knob.style.transform = 'translate(-50%, -50%)';
  }

  private hideStick(): void {
    this.stick.classList.remove('show');
  }

  dispose(): void {
    window.removeEventListener('touchstart', this.onStart);
    window.removeEventListener('touchmove', this.onMove);
    window.removeEventListener('touchend', this.onEnd);
    window.removeEventListener('touchcancel', this.onEnd);
    this.stick.remove();
  }
}

/** Is this point on a HUD panel rather than on the world? */
function isInterface(x: number, y: number): boolean {
  const element = document.elementFromPoint(x, y);
  return Boolean(element?.closest('.panel, .bar, .toggle'));
}
