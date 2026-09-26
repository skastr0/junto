/**
 * The signal path every cue shares, on any BaseAudioContext (the live one,
 * or an OfflineAudioContext for the demo render):
 *
 *   cue voice gain -> family gain -> attention bus | ambient bus -> mix
 *   mix -> dry ----------------------------------------------> master
 *   mix -> room (procedural impulse) -> wet --------------------> master
 *   master -> low cut -> soft limiter -> destination
 *
 * While an attention cue sounds, the ambient bus ducks under it.
 */

import { SOUND_CATEGORIES, type SoundCategory } from "@shared/settings";
import { CUES, type CueId, type CueVariant } from "./cues";
import { HEADROOM, LIMITER, ROOM, seeded } from "./palette";
import { makeNoise, type Voice } from "./voices";

export type SoundGraph = {
  readonly ctx: BaseAudioContext;
  readonly noise: AudioBuffer;
  readonly master: GainNode;
  readonly families: Readonly<Record<SoundCategory, GainNode>>;
  readonly ambient: GainNode;
};

/** A small warm room: seeded noise, darkening and fading, after a short pre-delay. */
const roomImpulse = (ctx: BaseAudioContext): AudioBuffer => {
  const rate = ctx.sampleRate;
  const length = Math.floor(rate * ROOM.seconds);
  const preDelay = Math.floor((rate * ROOM.preDelayMs) / 1_000);
  const impulse = ctx.createBuffer(2, length, rate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = impulse.getChannelData(channel);
    const next = seeded(ROOM.seed + channel * 7_919);
    let low = 0;
    for (let i = preDelay; i < length; i += 1) {
      const x = (i - preDelay) / (length - preDelay);
      // A one-pole low-pass that closes as the tail goes on: bright early
      // reflections, a dark tail.
      low += (next() * 2 - 1 - low) * (0.6 - 0.45 * x);
      data[i] = low * Math.exp(-x * ROOM.decay * 2);
    }
  }
  return impulse;
};

export const buildSoundGraph = (ctx: BaseAudioContext): SoundGraph => {
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = LIMITER.thresholdDb;
  limiter.knee.value = LIMITER.kneeDb;
  limiter.ratio.value = LIMITER.ratio;
  limiter.attack.value = LIMITER.attack;
  limiter.release.value = LIMITER.release;
  limiter.connect(ctx.destination);

  const lowCut = ctx.createBiquadFilter();
  lowCut.type = "highpass";
  lowCut.frequency.value = 70;
  lowCut.connect(limiter);

  const master = ctx.createGain();
  master.connect(lowCut);

  const mix = ctx.createGain();
  mix.connect(master);
  const room = ctx.createConvolver();
  room.buffer = roomImpulse(ctx);
  const wet = ctx.createGain();
  wet.gain.value = ROOM.wet;
  mix.connect(room).connect(wet).connect(master);

  const attention = ctx.createGain();
  attention.connect(mix);
  const ambient = ctx.createGain();
  ambient.connect(mix);

  const families = Object.fromEntries(
    SOUND_CATEGORIES.map((category) => {
      const family = ctx.createGain();
      family.connect(category === "attention" ? attention : ambient);
      return [category, family];
    }),
  ) as Record<SoundCategory, GainNode>;

  return { ctx, noise: makeNoise(ctx), master, families, ambient };
};

export type Sounding = {
  /** The cue's own gain: fade it to steal the voice. */
  readonly gain: GainNode;
  readonly endsAt: number;
};

/** Schedule one cue at context time `t`. */
export const renderCue = (
  graph: SoundGraph,
  cue: CueId,
  t: number,
  variant: CueVariant,
): Sounding => {
  const spec = CUES[cue];
  const gain = graph.ctx.createGain();
  gain.gain.value = spec.level * HEADROOM;
  gain.connect(graph.families[spec.category]);
  const voice: Voice = { ctx: graph.ctx, out: gain, noise: graph.noise };
  spec.render(voice, t, variant);
  return { gain, endsAt: t + spec.seconds };
};

/** Fade a sounding cue out quickly, without a click. */
export const releaseCue = (sounding: Sounding, t: number): void => {
  sounding.gain.gain.cancelScheduledValues(t);
  sounding.gain.gain.setValueAtTime(sounding.gain.gain.value, t);
  sounding.gain.gain.setTargetAtTime(0, t, 0.03);
};

/** Tuck the quiet families under an attention cue, then let them back up. */
export const duckAmbient = (graph: SoundGraph, t: number, seconds: number): void => {
  const level = graph.ambient.gain;
  level.cancelScheduledValues(t);
  level.setValueAtTime(level.value, t);
  level.setTargetAtTime(0.35, t, 0.03);
  level.setTargetAtTime(1, t + seconds, 0.35);
};
