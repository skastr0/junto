/**
 * The palette every Junto cue is played from, so the whole app sounds like
 * one instrument: one key, one room, a handful of voices.
 *
 * Key: D major, leaning lydian (the raised fourth, G sharp) for an open,
 * unhurried colour. Cues that say "things are fine" resolve to D; cues that
 * need the operator end open (on E or A) so the ear waits for an answer.
 *
 * Pure: numbers only, no Web Audio.
 */

/** MIDI note numbers for the notes the cues use. */
export const NOTE = {
  D3: 50,
  A3: 57,
  B3: 59,
  D4: 62,
  E4: 64,
  Fs4: 66,
  Gs4: 68,
  A4: 69,
  B4: 71,
  Cs5: 73,
  D5: 74,
  E5: 76,
  Fs5: 78,
  A5: 81,
  B5: 83,
  Cs6: 85,
  D6: 86,
  E6: 88,
} as const;

export const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** The D major pentatonic over two octaves, for strums and bursts. */
export const PENTATONIC: ReadonlyArray<number> = [
  NOTE.D4,
  NOTE.E4,
  NOTE.Fs4,
  NOTE.A4,
  NOTE.B4,
  NOTE.D5,
  NOTE.E5,
  NOTE.Fs5,
  NOTE.A5,
  NOTE.B5,
  NOTE.D6,
];

/** Seeded PRNG (mulberry32): every noise buffer and room is reproducible. */
export const seeded = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** The shared room: a small warm space, never a hall. */
export const ROOM = {
  seconds: 1.7,
  /** Larger decays faster. */
  decay: 3.4,
  preDelayMs: 14,
  /** Return level of the room against the dry voices. */
  wet: 0.2,
  seed: 0x4a17,
} as const;

/** Final safety: a soft knee limiter so stacked cues never clip. */
export const LIMITER = {
  thresholdDb: -12,
  kneeDb: 10,
  ratio: 4,
  attack: 0.004,
  release: 0.2,
} as const;

/** Cues sit this far under full scale before the operator's volume. */
export const HEADROOM = 0.5;
