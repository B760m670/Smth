/**
 * HUD: readouts, the ability bar, and the network simulator.
 *
 * Plain DOM, no framework — the sandbox's HUD makes the same call and it is the
 * right one at this size. The cooldown sweep is a `conic-gradient` driven by a
 * CSS custom property, which is one `setProperty` per frame and never touches
 * layout; that trick is lifted directly from the sandbox's `ui/HUD.js`.
 *
 * The readouts are chosen to answer the questions M0 actually asks: is the
 * clock synced, is prediction correcting hard, how deep is the unacknowledged
 * queue, and how much of what we send is arriving.
 */

import type { NetSim } from './net.ts';
import type { AbilityProfile } from '../shared/profiles.ts';
import { mobile } from './quality.ts';

export interface HudState {
  fps: number;
  rtt: number;
  clockSynced: boolean;
  predictionError: number;
  pendingInputs: number;
  players: number;
  hp: number;
  alive: boolean;
  activeCasts: number;
  dropped: number;
  bytesInPerSec: number;
  bytesOutPerSec: number;
}

export class Hud {
  private readouts = new Map<string, HTMLElement>();
  private slotEls: HTMLElement[] = [];
  private toastEl: HTMLElement;
  private toastTimer = 0;

  /** Set by the bar; read by main to decide what a click casts. */
  selectedSlot = 0;
  onSelect: (slot: number) => void = () => {};
  ghostVisible = false;
  onGhostToggle: (visible: boolean) => void = () => {};
  /**
   * Fired whenever the simulator changes.
   *
   * The clock estimate keeps the *best* round trip it has ever seen, which is
   * the right way to sync a clock and the wrong way to survive a settings
   * change: dial latency up and the readout would happily keep reporting the
   * 2 ms it saw on localhost ten seconds ago. Moving a slider has to let the
   * estimate re-converge.
   */
  onSimChange: () => void = () => {};

  constructor(root: HTMLElement, sim: NetSim) {
    root.innerHTML = '';
    if (mobile) root.classList.add('mobile');

    /* ---- readouts ---- */
    const stats = div('panel stats', root);
    for (const key of [
      'fps',
      'rtt',
      'clock',
      'error',
      'queue',
      'players',
      'casts',
      'dropped',
      'traffic'
    ]) {
      const row = div('row', stats);
      div('key', row).textContent = key;
      this.readouts.set(key, div('val', row));
    }

    /* ---- the simulator ---- */
    const netPanel = div('panel net', root);
    div('title', netPanel).textContent = 'network simulator';

    const changed = (): void => this.onSimChange();
    slider(netPanel, 'one-way latency', 0, 400, 5, sim.latency, 'ms', (v) => {
      sim.latency = v;
      changed();
    });
    slider(netPanel, 'jitter', 0, 200, 5, sim.jitter, 'ms', (v) => {
      sim.jitter = v;
      changed();
    });
    slider(netPanel, 'loss', 0, 30, 1, sim.loss * 100, '%', (v) => {
      sim.loss = v / 100;
      changed();
    });

    const presets = div('presets', netPanel);
    preset(presets, 'lan', () => this.applyPreset(sim, 0, 0, 0));
    preset(presets, 'good', () => this.applyPreset(sim, 35, 8, 0.005));
    preset(presets, 'ok', () => this.applyPreset(sim, 75, 20, 0.02));
    preset(presets, 'bad', () => this.applyPreset(sim, 150, 60, 0.05));
    preset(presets, 'awful', () => this.applyPreset(sim, 260, 120, 0.12));

    const ghostRow = div('checkbox', netPanel);
    const ghostBox = document.createElement('input');
    ghostBox.type = 'checkbox';
    ghostBox.id = 'ghost';
    ghostBox.addEventListener('change', () => {
      this.ghostVisible = ghostBox.checked;
      this.onGhostToggle(ghostBox.checked);
    });
    const ghostLabel = document.createElement('label');
    ghostLabel.htmlFor = 'ghost';
    ghostLabel.textContent = 'show server ghost';
    ghostRow.append(ghostBox, ghostLabel);

    /* ---- toast ---- */
    this.toastEl = div('toast', root);

    /* ---- help ---- */
    const help = div('panel help', root);
    help.innerHTML = mobile
      ? '<b>left thumb</b> walk &nbsp; <b>hold an ability</b> to aim, release to cast<br>' +
        'slide back onto the button to cancel'
      : '<b>WASD</b> move &nbsp; <b>mouse</b> aim &nbsp; <b>click</b> cast<br>' +
        '<b>1 2 3</b> pick a profile &nbsp; open a second tab for a second player';

    // On a phone the two panels would cover most of the playfield, so they fold
    // away behind one tap. They are instrumentation, not chrome — but they are
    // no use at all if they are sitting on top of the thing being measured.
    if (mobile) {
      const toggle = document.createElement('button');
      toggle.className = 'toggle';
      toggle.textContent = 'i';
      toggle.addEventListener('click', () => {
        const shown = root.classList.toggle('panels');
        toggle.textContent = shown ? '×' : 'i';
      });
      root.appendChild(toggle);
    }
  }

  private applyPreset(sim: NetSim, latency: number, jitter: number, loss: number): void {
    sim.latency = latency;
    sim.jitter = jitter;
    sim.loss = loss;
    // Rebuild the sliders so they show what was applied.
    for (const input of document.querySelectorAll<HTMLInputElement>('.net input[type=range]')) {
      const label = input.dataset.key;
      if (label === 'one-way latency') input.value = String(latency);
      if (label === 'jitter') input.value = String(jitter);
      if (label === 'loss') input.value = String(Math.round(loss * 100));
      input.dispatchEvent(new Event('input'));
    }
    this.onSimChange();
  }

  /** Build the ability bar once the server has told us our loadout. */
  buildBar(root: HTMLElement, profiles: (AbilityProfile | null)[]): void {
    const bar = div('bar', root);
    this.slotEls = [];

    profiles.forEach((profile, index) => {
      const slot = div('slot', bar);
      slot.dataset.index = String(index);
      div('sweep', slot);
      div('key', slot).textContent = String(index + 1);
      div('name', slot).textContent = profile?.label ?? '—';
      if (profile) slot.style.setProperty('--accent', profile.colorIce);

      slot.addEventListener('click', () => this.select(index));
      this.slotEls.push(slot);
    });

    this.select(0);
  }

  select(slot: number): void {
    if (slot < 0 || slot >= this.slotEls.length) return;
    this.selectedSlot = slot;
    this.slotEls.forEach((el, i) => el.classList.toggle('active', i === slot));
    this.onSelect(slot);
  }

  /** `remaining` and `total` in seconds. */
  setCooldown(slot: number, remaining: number, total: number): void {
    const el = this.slotEls[slot];
    if (!el) return;
    const t = total > 0 ? Math.max(0, Math.min(1, remaining / total)) : 0;
    el.style.setProperty('--cooldown', `${t * 360}deg`);
    el.classList.toggle('cooling', t > 0.001);
  }

  toast(message: string): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastEl.classList.remove('show'), 1400);
  }

  update(state: HudState): void {
    this.set('fps', Math.round(state.fps).toString());
    this.set('rtt', Number.isFinite(state.rtt) ? `${Math.round(state.rtt)} ms` : '—');
    this.set('clock', state.clockSynced ? 'synced' : 'syncing…');
    this.set('error', `${(state.predictionError * 100).toFixed(1)} cm`);
    this.set('queue', `${state.pendingInputs} inputs`);
    this.set('players', state.players.toString());
    this.set('casts', state.activeCasts.toString());
    this.set('dropped', state.dropped.toString());
    this.set(
      'traffic',
      `${(state.bytesInPerSec / 1024).toFixed(1)} ↓ / ${(state.bytesOutPerSec / 1024).toFixed(1)} ↑ kB/s`
    );

    // Prediction error is the one number worth colouring: a few centimetres is
    // normal, a metre means something is wrong and you want to notice without
    // reading.
    const errorEl = this.readouts.get('error');
    if (errorEl) {
      errorEl.classList.toggle('warn', state.predictionError > 0.25);
      errorEl.classList.toggle('bad', state.predictionError > 1);
    }
  }

  private set(key: string, value: string): void {
    const el = this.readouts.get(key);
    if (el && el.textContent !== value) el.textContent = value;
  }
}

/* ---------------------------------------------------------------------- */

function div(className: string, parent: HTMLElement): HTMLDivElement {
  const el = document.createElement('div');
  el.className = className;
  parent.appendChild(el);
  return el;
}

function slider(
  parent: HTMLElement,
  label: string,
  min: number,
  max: number,
  step: number,
  value: number,
  unit: string,
  onChange: (v: number) => void
): void {
  const row = div('slider', parent);
  const name = div('key', row);
  name.textContent = label;
  const readout = div('val', row);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.dataset.key = label;

  const apply = (): void => {
    const v = Number(input.value);
    readout.textContent = `${v}${unit}`;
    onChange(v);
  };
  input.addEventListener('input', apply);
  row.appendChild(input);
  apply();
}

function preset(parent: HTMLElement, label: string, onClick: () => void): void {
  const button = document.createElement('button');
  button.textContent = label;
  button.addEventListener('click', onClick);
  parent.appendChild(button);
}
