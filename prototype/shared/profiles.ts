/**
 * The ability profile registry — the fix for the sandbox's global singleton.
 *
 * In the sandbox every ability reads `settings[this.element]`, one shared
 * mutable object. That is exactly right for a one-caster editor and it falls
 * over on the second player: two people casting the same spell at different
 * ranks, in different skins, or under different buffs cannot both read the same
 * numbers.
 *
 * The fix is small and keeps the sandbox's actual discipline intact. An ability
 * still holds **no dimensions of its own** and still re-reads every metre,
 * radian and second out of a settings object each frame — it just reads the
 * object it was handed at spawn instead of the one global. Profiles are shared
 * by reference, so a thousand simultaneous casts of Frost Lance point at one
 * object and copy nothing.
 *
 * Two consequences worth stating because they are the whole payoff:
 *
 *   - **The live editor survives.** Mutating a profile in place updates every
 *     cast currently referencing it, in the same frame, exactly as mutating
 *     `settings.ice` did. Tuning on a paused frame still works.
 *   - **Profiles are content.** This registry is a spellbook. It wants to be
 *     JSON on disk, versioned, with the editor writing it — which is what the
 *     sandbox's `PresetManager` already does for its one global tree.
 *
 * The client never chooses a profile. It asks for a *slot*; the server resolves
 * the slot against the caster's loadout and puts the resolved id on the wire.
 * A client that lies about its slot gets its own loadout back, not someone
 * else's rank 5.
 */

export interface AbilityProfile {
  /** Stable numeric id — this is what travels on the wire. */
  readonly id: number;
  readonly key: string;
  readonly label: string;

  /* --- the cast --- */
  /** Maximum cast distance, metres. */
  range: number;
  /** Refuse to cast closer than this, metres. */
  minRange: number;
  /** How fast the fracture front races out, metres/second. */
  speed: number;
  /** Seconds before this slot can be used again. */
  cooldown: number;

  /* --- the footprint ---
   * Read by the hit resolver on the server and by the crystal field on the
   * client, out of the same object. The damage lands exactly where the ice
   * comes up because both halves ask the same question of the same numbers.
   */
  /** Half-width of the band at the far end, metres. */
  width: number;
  /** ... and at the caster's feet. */
  widthNear: number;
  /** How late the band opens out. >1 keeps it narrow until the far end. */
  widthCurve: number;
  /** Radius of the cluster thrown up at the impact point, metres. */
  impactRadius: number;

  /* --- timing --- */
  /** Seconds the field stands after the front lands. */
  lifetime: number;
  /** Seconds it takes to withdraw. */
  fadeTime: number;

  /* --- gameplay --- */
  /** Damage to anything the travelling front sweeps over. */
  damage: number;
  /** Extra damage inside `impactRadius` when it lands. */
  impactDamage: number;

  /* --- the silhouette (client-side, but per-profile, which is the point) --- */
  spikeCount: number;
  height: number;
  heightNear: number;
  heightCurve: number;
  crystalRadius: number;
  riseTime: number;

  /* --- palette --- */
  colorIce: string;
  colorRim: string;
  colorCore: string;
}

/** Frost Lance, rank 1 — the baseline everything else is a diff against. */
const FROST_LANCE_1: AbilityProfile = {
  id: 1,
  key: 'frost_lance@1',
  label: 'Frost Lance',

  range: 15,
  minRange: 1.5,
  speed: 26,
  cooldown: 1.2,

  width: 1.9,
  widthNear: 0.55,
  widthCurve: 1.35,
  impactRadius: 2.6,

  lifetime: 3.6,
  fadeTime: 1.4,

  damage: 14,
  impactDamage: 9,

  spikeCount: 96,
  height: 2.4,
  heightNear: 0.5,
  heightCurve: 1.6,
  crystalRadius: 0.22,
  riseTime: 0.16,

  colorIce: '#8fd8ff',
  colorRim: '#e8fbff',
  colorCore: '#3aa6e8'
};

/**
 * Rank 2 — reaches further, opens wider, hits harder, costs a longer cooldown.
 *
 * This exists to make the singleton's failure concrete: put two players side by
 * side, one on each rank, and both casts have to be on screen at once with
 * different reach, different band width and a different palette. One global
 * settings object cannot express that at all.
 */
const FROST_LANCE_2: AbilityProfile = {
  ...FROST_LANCE_1,
  id: 2,
  key: 'frost_lance@2',
  label: 'Greater Frost Lance',

  range: 21,
  speed: 30,
  cooldown: 2.1,

  width: 2.9,
  widthNear: 0.8,
  impactRadius: 3.6,

  lifetime: 4.6,
  damage: 22,
  impactDamage: 16,

  spikeCount: 150,
  height: 3.4,
  heightNear: 0.7,
  crystalRadius: 0.27,

  colorIce: '#a6e4ff',
  colorRim: '#ffffff',
  colorCore: '#2f8fe0'
};

/**
 * A cosmetic variant of rank 1: identical numbers, different palette.
 *
 * The second axis a singleton cannot carry. Gameplay-identical to rank 1, which
 * is exactly what a skin has to be, and the server resolves it from the
 * caster's loadout like any other profile — so a client cannot grant itself one.
 */
const FROST_LANCE_1_CRIMSON: AbilityProfile = {
  ...FROST_LANCE_1,
  id: 3,
  key: 'frost_lance@1/crimson',
  label: 'Frost Lance (Crimson)',

  colorIce: '#ff9a8f',
  colorRim: '#fff0ec',
  colorCore: '#c8324a'
};

const ALL: AbilityProfile[] = [FROST_LANCE_1, FROST_LANCE_2, FROST_LANCE_1_CRIMSON];

const BY_ID = new Map<number, AbilityProfile>(ALL.map((p) => [p.id, p]));

export function profileById(id: number): AbilityProfile | null {
  return BY_ID.get(id) ?? null;
}

export function allProfiles(): readonly AbilityProfile[] {
  return ALL;
}

/**
 * What a player is allowed to cast, by slot.
 *
 * Server-side authority in its smallest possible form. In a real build this
 * comes out of the character row in Postgres; here every player gets the same
 * three so the failure mode the registry fixes is visible with two browser tabs.
 */
export const DEFAULT_LOADOUT: readonly number[] = [FROST_LANCE_1.id, FROST_LANCE_2.id, FROST_LANCE_1_CRIMSON.id];

/** Resolve a slot index against a loadout. Returns null for a slot they lack. */
export function resolveSlot(loadout: readonly number[], slot: number): AbilityProfile | null {
  if (slot < 0 || slot >= loadout.length) return null;
  return profileById(loadout[slot]!);
}
