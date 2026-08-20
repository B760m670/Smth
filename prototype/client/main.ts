/**
 * The client: input, prediction, interpolation, and the frame loop.
 *
 * Read the loop at the bottom first — everything above it is a handler for one
 * kind of packet or one kind of intent, and the loop is the only place that
 * decides what order things happen in.
 */

import { Plane, Raycaster, Vector2, Vector3 } from 'three';

import { Stage } from './render/scene.ts';
import { AimView } from './render/aimView.ts';
import { Actor, ServerGhost } from './render/actors.ts';
import { CastView } from './render/castView.ts';
import { createCrystalGeometry } from './render/crystal.ts';
import { Net } from './net.ts';
import { Predictor } from './prediction.ts';
import { RemoteBuffer } from './remotes.ts';
import { Hud } from './ui.ts';
import { TouchControls } from './touch.ts';
import { isTouch } from './quality.ts';
import type { Endpoint } from './net.ts';

import { INPUT_DT, MAX_HP } from '../shared/constants.ts';
import { Msg, REJECT_TEXT, Reader, Writer, readCast } from '../shared/protocol.ts';
import { profileById } from '../shared/profiles.ts';
import type { AbilityProfile } from '../shared/profiles.ts';
import type { CastData } from '../shared/ability.ts';
import { clamp } from '../shared/math.ts';

const GROUND = new Plane(new Vector3(0, 1, 0), 0);

const canvas = document.getElementById('viewport') as HTMLCanvasElement;
const hudRoot = document.getElementById('hud') as HTMLElement;

const stage = new Stage(canvas);
const net = new Net();
const predictor = new Predictor();
const remotes = new RemoteBuffer();
const hud = new Hud(hudRoot, net.sim);

const ghost = new ServerGhost();
stage.scene.add(ghost.mesh);
hud.onGhostToggle = (visible) => {
  ghost.mesh.visible = visible;
};
// Let the clock re-converge when the simulated route changes underneath it.
hud.onSimChange = () => net.resetClock();

const aimView = new AimView();
aimView.addTo(stage.scene);

/**
 * On a phone, both thumbs. On a desktop, nothing — the mouse path below is
 * untouched, and this is null.
 */
const touch = isTouch ? new TouchControls(hudRoot) : null;
if (touch) {
  touch.onSelect = (slot) => hud.select(slot);
  touch.onCast = (slot) => attemptCast(slot);
}

/** One geometry for every crystal in the world. */
const crystalGeometry = createCrystalGeometry({ seed: 7.3, sides: 6, taper: 0.13, roughness: 0.3, bend: 0.2 });

const actors = new Map<number, Actor>();
const meta = new Map<number, { name: string; isBot: boolean }>();
/** Live casts, keyed by seed — the id both halves already agree on. */
const casts = new Map<number, CastView>();
/** Casts we predicted and have not had confirmed, keyed by our own sequence. */
const pending = new Map<number, { seed: number; sentAt: number }>();
/** Predicted cooldowns, profileId → client-clock ms. The server holds the real ones. */
const cooldowns = new Map<number, number>();

let castSeq = 0;
let selfHp = MAX_HP;
let selfAlive = true;

/* ---------------------------------------------------------------------- */
/* Input                                                                   */
/* ---------------------------------------------------------------------- */

const keys = new Set<string>();
const pointer = new Vector2();
const raycaster = new Raycaster();
const aimPoint = new Vector3();

window.addEventListener('keydown', (event) => {
  if (event.repeat) return;
  keys.add(event.code);
  if (event.code === 'Digit1') hud.select(0);
  if (event.code === 'Digit2') hud.select(1);
  if (event.code === 'Digit3') hud.select(2);
});
window.addEventListener('keyup', (event) => keys.delete(event.code));

window.addEventListener('pointermove', (event) => {
  pointer.set(
    (event.clientX / window.innerWidth) * 2 - 1,
    -(event.clientY / window.innerHeight) * 2 + 1
  );
});

canvas.addEventListener('pointerdown', (event) => {
  // Touch casts from the ability buttons, not from the world, so a tap on the
  // ground must not also throw a spell.
  if (event.pointerType !== 'mouse') return;
  if (event.button === 0) attemptCast();
});

/**
 * Where the cast is pointed, resolved fresh every frame.
 *
 * Two sources, one answer. The mouse projects the cursor onto the ground —
 * re-projected every frame rather than only on move, because the camera drifts under
 * a stationary cursor. A thumb has no cursor to project, so its drag vector
 * becomes a direction and a fraction of the ability's range directly.
 */
function updateAim(): void {
  const profile = selectedProfile();

  if (touch?.aiming && profile) {
    const reach = profile.minRange + (profile.range - profile.minRange) * touch.aim.reach;
    aimPoint.set(
      predictor.state.x + touch.aim.x * reach,
      0,
      predictor.state.z + touch.aim.z * reach
    );
    return;
  }

  raycaster.setFromCamera(pointer, stage.camera);
  if (!raycaster.ray.intersectPlane(GROUND, aimPoint)) aimPoint.set(0, 0, 0);
}

/** Draw the band the cast would sweep, in the colour of whether it is legal. */
function updateAimView(): void {
  const profile = selectedProfile();
  // On a phone the indicator belongs to the drag; on a desktop the cursor is
  // always aiming something, so it is always up.
  const wanted = touch ? touch.aiming && !touch.aim.cancelling : true;

  if (!profile || !wanted || !selfAlive || !net.connected) {
    aimView.hide();
    return;
  }

  const dx = aimPoint.x - predictor.state.x;
  const dz = aimPoint.z - predictor.state.z;
  const raw = Math.hypot(dx, dz);

  aimView.show(
    profile,
    predictor.state.x,
    predictor.state.z,
    Math.atan2(dx, dz),
    clamp(raw, profile.minRange, profile.range),
    raw >= profile.minRange
  );
}

function selectedProfile(): AbilityProfile | null {
  const id = net.loadout[hud.selectedSlot];
  return id === undefined ? null : profileById(id);
}

/* ---------------------------------------------------------------------- */
/* Casting                                                                 */
/* ---------------------------------------------------------------------- */

/**
 * Fire the selected slot, optimistically.
 *
 * The effect appears on this frame, before the server has heard about it. That
 * is the whole reason the client picks the seed: when the confirmation arrives
 * it describes the *same* field, so `adopt` nudges the origin and start time
 * rather than replacing the spell with a different-looking one.
 */
function attemptCast(slot: number = hud.selectedSlot): void {
  const id = net.loadout[slot];
  const profile = id === undefined ? null : profileById(id);
  if (!profile || !net.connected) return;

  if (!selfAlive) {
    hud.toast('You are dead');
    return;
  }

  const readyAt = cooldowns.get(profile.id) ?? 0;
  if (performance.now() < readyAt) {
    hud.toast('Not ready');
    return;
  }

  const dx = aimPoint.x - predictor.state.x;
  const dz = aimPoint.z - predictor.state.z;
  const raw = Math.hypot(dx, dz);

  // Predicting the refusal too — the server will refuse it identically, and
  // waiting a round trip to be told what we already know feels broken.
  if (raw < profile.minRange) {
    hud.toast('Too close — aim further out');
    return;
  }

  const distance = clamp(raw, profile.minRange, profile.range);
  const yaw = Math.atan2(dx, dz);
  const seed = (Math.random() * 0xffffffff) >>> 0;

  spawnCast(
    profile,
    {
      casterId: net.playerId,
      profileId: profile.id,
      seed,
      t0: net.serverNow(),
      originX: predictor.state.x,
      originZ: predictor.state.z,
      yaw,
      distance
    },
    true
  );

  // Predict the gesture too, not only the effect: the body has to commit on the
  // frame the key went down, or the spell reads as something that happened near
  // the character rather than something they did.
  actors.get(net.playerId)?.playCast();

  cooldowns.set(profile.id, performance.now() + profile.cooldown * 1000);

  const seq = ++castSeq;
  pending.set(seq, { seed, sentAt: performance.now() });

  net.send(
    new Writer(32)
      .u8(Msg.C_CAST)
      .u32(seq)
      .u8(slot)
      .u32(seed)
      .cm(predictor.state.x)
      .cm(predictor.state.z)
      .yaw(yaw)
      .u16(Math.round(distance * 100))
      .finish()
  );
}

function spawnCast(profile: AbilityProfile, data: CastData, predicted: boolean): void {
  if (casts.has(data.seed)) return;
  const view = new CastView(profile, data, crystalGeometry);
  view.predicted = predicted;
  view.addTo(stage.scene);
  casts.set(data.seed, view);
}

function dropCast(seed: number): void {
  const view = casts.get(seed);
  if (!view) return;
  view.dispose(stage.scene);
  casts.delete(seed);
}

/**
 * Roll back a prediction the server never answered.
 *
 * With the loss slider up this fires regularly, and it is the correct
 * behaviour: the request genuinely did not arrive, so the effect has to be
 * taken back. A game that leaves the ghost effect standing is lying about what
 * happened; one that never rolls back is not predicting at all.
 */
function expirePredictions(): void {
  const timeout = Math.max(600, (Number.isFinite(net.rtt) ? net.rtt : 200) * 2 + 300);
  const now = performance.now();

  for (const [seq, entry] of pending) {
    if (now - entry.sentAt < timeout) continue;
    pending.delete(seq);
    const view = casts.get(entry.seed);
    if (view?.predicted) {
      dropCast(entry.seed);
      hud.toast('Cast lost in transit');
    }
  }
}

/* ---------------------------------------------------------------------- */
/* Packets                                                                 */
/* ---------------------------------------------------------------------- */

net.onPacket((type, r) => {
  switch (type) {
    case Msg.S_SNAPSHOT: {
      const serverTime = r.u32();
      const ackSeq = r.u32();
      const count = r.u8();

      for (let i = 0; i < count; i++) {
        const id = r.u16();
        const x = r.f32();
        const z = r.f32();
        const yaw = r.yaw();
        const hp = r.u16();
        const alive = r.u8() === 1;

        if (id === net.playerId) {
          predictor.reconcile(x, z, ackSeq);
          // A respawn moves us further than any replay could reconcile, so
          // treat coming back alive as a teleport rather than an error.
          if (alive && !selfAlive) predictor.teleport(x, z);
          selfHp = hp;
          selfAlive = alive;
        } else {
          remotes.push(id, { time: serverTime, x, z, yaw, hp, alive });
        }
      }
      break;
    }

    case Msg.S_CAST: {
      const wire = readCast(r);
      const profile = profileById(wire.profileId);
      if (!profile) break;

      const mine = casts.get(wire.seed);
      if (mine && wire.casterId === net.playerId) {
        // Ours, confirmed. Adopt the server's origin, reach and start time.
        const moved = mine.adopt(wire);
        for (const [seq, entry] of pending) {
          if (entry.seed === wire.seed) pending.delete(seq);
        }
        if (moved > 0.75) hud.toast(`Cast corrected by ${moved.toFixed(1)} m`);
        break;
      }

      spawnCast(profile, wire, false);
      // Somebody else threw it — their body should throw it too. No animation
      // state on the wire: the cast packet is the trigger, and it was going to
      // be sent anyway.
      if (wire.casterId !== net.playerId) actorFor(wire.casterId).playCast();
      break;
    }

    case Msg.S_CAST_REJECT: {
      const seq = r.u32();
      const reason = r.u8();
      const entry = pending.get(seq);
      if (entry) {
        pending.delete(seq);
        dropCast(entry.seed);
        // The server refused it, so the cooldown we predicted never started.
        const profile = selectedProfile();
        if (profile) cooldowns.delete(profile.id);
      }
      hud.toast(REJECT_TEXT[reason] ?? 'Cast refused');
      break;
    }

    case Msg.S_HIT: {
      const casterId = r.u16();
      const targetId = r.u16();
      const damage = r.u16();
      r.u16(); // hp after — the snapshot is the authority on health
      r.cm();
      r.cm();
      const killed = r.u8() === 1;

      if (targetId === net.playerId) hud.toast(killed ? 'You died' : `−${damage}`);
      else if (casterId === net.playerId && killed) hud.toast('Kill');
      break;
    }

    case Msg.S_JOIN: {
      const id = r.u16();
      const name = r.str();
      const isBot = r.u8() === 1;
      meta.set(id, { name, isBot });
      break;
    }

    case Msg.S_LEAVE: {
      const id = r.u16();
      remotes.remove(id);
      meta.delete(id);
      actors.get(id)?.dispose(stage.scene);
      actors.delete(id);
      break;
    }

    default:
      break;
  }
});

/* ---------------------------------------------------------------------- */
/* Actors                                                                  */
/* ---------------------------------------------------------------------- */

function actorFor(id: number): Actor {
  let actor = actors.get(id);
  if (!actor) {
    const info = meta.get(id);
    actor = new Actor(id === net.playerId, info?.isBot ?? false);
    actor.addTo(stage.scene);
    actors.set(id, actor);
  }
  return actor;
}

function updateActors(dt: number): void {
  const serverNow = net.serverNow();

  // Us: the predicted position, drawn at "now".
  if (net.playerId) {
    const self = actorFor(net.playerId);
    self.setHealth(selfHp, selfAlive);
    self.sync(predictor.state.x, predictor.state.z, predictor.state.yaw, dt);
    self.faceCamera(stage.camera);
    ghost.set(predictor.server.x, predictor.server.z);
  }

  // Everyone else: interpolated, a tenth of a second behind. Their gait comes
  // out of that interpolation — nothing about the animation is replicated.
  for (const id of remotes.ids()) {
    const sample = remotes.sampleAt(id, serverNow);
    if (!sample) continue;
    const actor = actorFor(id);
    actor.setHealth(sample.hp, sample.alive);
    actor.sync(sample.x, sample.z, sample.yaw, dt);
    actor.faceCamera(stage.camera);
  }
}

function updateCasts(): void {
  const serverNow = net.serverNow();
  for (const [seed, view] of casts) {
    const age = (serverNow - view.instance.cast.t0) / 1000;
    if (!view.update(age)) dropCast(seed);
  }
}

/* ---------------------------------------------------------------------- */
/* The loop                                                                */
/* ---------------------------------------------------------------------- */

let inputAccumulator = 0;
let lastFrame = performance.now();
let fps = 60;
let pingTimer = 0;
let trafficTimer = 0;
let lastBytesIn = 0;
let lastBytesOut = 0;
let bytesInPerSec = 0;
let bytesOutPerSec = 0;

function sampleInputs(dt: number): void {
  inputAccumulator += dt;

  // Fixed-rate sampling regardless of frame rate: a 144 Hz client must not get
  // more inputs per second than a 60 Hz one, or it moves further per second.
  let sent = 0;
  while (inputAccumulator >= INPUT_DT && sent < 4) {
    inputAccumulator -= INPUT_DT;
    sent++;

    // The camera looks down +Z, so forward on screen is −Z. The stick already
    // speaks in screen space, so it needs no translation.
    let moveX = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0);
    let moveZ = (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0);
    if (touch && (touch.move.x !== 0 || touch.move.z !== 0)) {
      moveX = touch.move.x;
      moveZ = touch.move.z;
    }

    const yaw = Math.atan2(aimPoint.x - predictor.state.x, aimPoint.z - predictor.state.z);
    predictor.sample(INPUT_DT, moveX, moveZ, yaw);
  }

  if (sent === 0) return;

  // Every packet carries the whole unacknowledged queue. It is a few dozen
  // bytes and it makes a lost input packet cost nothing at all.
  const unacked = predictor.unacked();
  const w = new Writer(16 + unacked.length * 10);
  w.u8(Msg.C_INPUT).u8(Math.min(unacked.length, 255));
  for (const input of unacked.slice(-255)) {
    w.u32(input.seq)
      .u16(Math.round(input.dt * 1000))
      .i8(Math.round(input.moveX * 127))
      .i8(Math.round(input.moveZ * 127))
      .yaw(input.yaw);
  }
  net.send(w.finish());
}

function frame(): void {
  requestAnimationFrame(frame);

  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;
  fps += (1 / Math.max(dt, 1e-4) - fps) * 0.08;

  net.pump();
  updateAim();
  updateAimView();
  sampleInputs(dt);
  expirePredictions();

  updateActors(dt);
  updateCasts();

  stage.follow(predictor.state.x, predictor.state.z, dt);
  stage.render();

  /* ---- clock and readouts ---- */
  pingTimer += dt;
  if (pingTimer > 1) {
    pingTimer = 0;
    net.ping();
  }

  trafficTimer += dt;
  if (trafficTimer >= 0.5) {
    bytesInPerSec = (net.stats.bytesIn - lastBytesIn) / trafficTimer;
    bytesOutPerSec = (net.stats.bytesOut - lastBytesOut) / trafficTimer;
    lastBytesIn = net.stats.bytesIn;
    lastBytesOut = net.stats.bytesOut;
    trafficTimer = 0;
  }

  for (let slot = 0; slot < net.loadout.length; slot++) {
    const profile = profileById(net.loadout[slot]!);
    if (!profile) continue;
    const remaining = Math.max(0, ((cooldowns.get(profile.id) ?? 0) - now) / 1000);
    hud.setCooldown(slot, remaining, profile.cooldown);
  }

  hud.update({
    fps,
    rtt: net.rtt,
    clockSynced: net.clockSynced,
    predictionError: predictor.error,
    pendingInputs: predictor.pendingCount,
    players: actors.size,
    hp: selfHp,
    alive: selfAlive,
    activeCasts: casts.size,
    dropped: net.stats.dropped,
    bytesInPerSec,
    bytesOutPerSec
  });
}

/* ---------------------------------------------------------------------- */
/* Boot                                                                    */
/* ---------------------------------------------------------------------- */

/**
 * A handle on the running client, for the console.
 *
 * The sandbox does the same thing with `window.app`, and for the same reason:
 * when the question is "why did that cast not happen", poking at the live state
 * beats adding a log line and reloading.
 */
declare global {
  interface Window {
    slice: Record<string, unknown>;
  }
}

window.slice = { net, predictor, remotes, casts, pending, cooldowns, hud, stage, aimPoint };

/**
 * Decide what this client is talking to.
 *
 *   ?local=1        run the session in this tab against bots — no server, no
 *                   hosting, works from a static file. The point of this mode is
 *                   a phone with nothing to connect to.
 *   ?server=host    an explicit address.
 *   otherwise       the origin that served this page, which is the deployed
 *                   case: one process serves the client and owns the socket, so
 *                   the two are same-origin by construction.
 *
 * The protocol has to follow the page's. A browser refuses a plain `ws://` from
 * a page loaded over HTTPS, and every phone is on HTTPS — hardcoding `ws://` is
 * the single most common reason a prototype that works on a laptop cannot be
 * opened on a phone at all.
 */
function resolveEndpoint(params: URLSearchParams): Endpoint {
  if (params.get('local') === '1') {
    return { kind: 'local', bots: Number(params.get('bots') ?? 3) };
  }

  const secure = location.protocol === 'https:';
  const scheme = secure ? 'wss' : 'ws';
  const explicit = params.get('server');
  if (explicit) return { kind: 'remote', url: `${scheme}://${explicit}` };

  // Vite's dev server does not own the socket; the game server next door does.
  if (location.port === '5173') return { kind: 'remote', url: `ws://${location.hostname}:8080` };

  return { kind: 'remote', url: `${scheme}://${location.host}` };
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const endpoint = resolveEndpoint(params);
  const name = params.get('name') ?? `Player ${Math.floor(Math.random() * 900 + 100)}`;

  try {
    await net.connect(endpoint, name);
  } catch (error) {
    // No server there. Rather than leave a dead page — which is what a static
    // host with no backend would always be — fall back to running the session
    // here. It is the same `Session` either way, so nothing about the game
    // changes except that the other players are bots.
    if (endpoint.kind === 'remote' && !params.get('server')) {
      console.warn('no server, falling back to a local session:', error);
      await net.connect({ kind: 'local', bots: Number(params.get('bots') ?? 3) }, name);
      hud.toast('No server — playing locally against bots');
    } else {
      hud.toast(
        endpoint.kind === 'remote' ? `Cannot reach ${endpoint.url}` : 'Could not start the local session'
      );
      console.error(error);
      return;
    }
  }

  // The loadout arrives with the welcome; wait a beat for it before building
  // the bar, rather than building an empty one and patching it.
  const ready = setInterval(() => {
    if (net.loadout.length === 0) return;
    clearInterval(ready);
    hud.buildBar(hudRoot, net.loadout.map((id) => profileById(id)));
  }, 50);

  for (let i = 0; i < 5; i++) setTimeout(() => net.ping(), 100 * i);

  frame();
}

void boot();
