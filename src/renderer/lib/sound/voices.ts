/**
 * Synthesis voices. Each voice schedules one note onto any BaseAudioContext
 * (live or offline) and tears itself down when the note has decayed: every
 * oscillator is given a stop time, so nothing keeps running at idle.
 *
 * - tine:    two-operator FM electric piano; a bright strike that mellows.
 * - kalimba: a sine with quick inharmonic overtones and a tiny thumb click.
 * - wood:    a soft marimba knock; low and round.
 * - drop:    a water drop; a short falling sine.
 * - breath:  filtered noise that swells and passes.
 * - pad:     slow detuned triangles under a low-pass; the floor of a chord.
 */

import { hz, seeded } from "./palette";

export type Voice = {
  readonly ctx: BaseAudioContext;
  /** Where notes land (the cue's own gain). */
  readonly out: AudioNode;
  /** A second of seeded white noise, shared by every breath and click. */
  readonly noise: AudioBuffer;
};

export type NoteOptions = {
  /** Peak linear gain of the note before the cue's level. */
  readonly gain?: number;
  /** Seconds for the note to fall about 63% of the way (time constant). */
  readonly tau?: number;
  /** 0..1: how much bite the strike carries. */
  readonly bright?: number;
  /** -1..1 stereo position. */
  readonly pan?: number;
};

const NOISE_SEED = 0x51f7;

export const makeNoise = (ctx: BaseAudioContext): AudioBuffer => {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const next = seeded(NOISE_SEED);
  for (let i = 0; i < data.length; i += 1) data[i] = next() * 2 - 1;
  return buffer;
};

/** Where a note's gain ends up: panned when asked, straight otherwise. */
const destination = (voice: Voice, pan: number | undefined): AudioNode => {
  if (pan === undefined || pan === 0) return voice.out;
  const panner = voice.ctx.createStereoPanner();
  panner.pan.value = Math.max(-1, Math.min(1, pan));
  panner.connect(voice.out);
  return panner;
};

/** Strike envelope: a short linear rise, then an exponential fall. Returns the stop time. */
const strike = (param: AudioParam, t: number, peak: number, attack: number, tau: number): number => {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  param.setTargetAtTime(0, t + attack, tau);
  return t + attack + tau * 7;
};

const sine = (ctx: BaseAudioContext, frequency: number): OscillatorNode => {
  const osc = ctx.createOscillator();
  osc.type = "sine";
  osc.frequency.value = frequency;
  return osc;
};

/** One sine partial with its own strike, into `out`. */
const partial = (
  voice: Voice,
  out: AudioNode,
  t: number,
  frequency: number,
  peak: number,
  attack: number,
  tau: number,
): number => {
  const osc = sine(voice.ctx, frequency);
  const amp = voice.ctx.createGain();
  const end = strike(amp.gain, t, peak, attack, tau);
  osc.connect(amp).connect(out);
  osc.start(t);
  osc.stop(end);
  return end;
};

/** A few milliseconds of band-passed noise: the thumb, the mallet, the hammer. */
const click = (voice: Voice, out: AudioNode, t: number, centre: number, peak: number): void => {
  const src = voice.ctx.createBufferSource();
  src.buffer = voice.noise;
  const band = voice.ctx.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = Math.min(centre, 12_000);
  band.Q.value = 1.4;
  const amp = voice.ctx.createGain();
  const end = strike(amp.gain, t, peak, 0.001, 0.006);
  src.connect(band).connect(amp).connect(out);
  src.start(t, 0.1 + (centre % 0.5));
  src.stop(end);
};

/** FM electric piano: carrier and modulator at the same pitch, plus a tine glint. */
export const tine = (voice: Voice, t: number, midi: number, options: NoteOptions = {}): number => {
  const { ctx } = voice;
  const f = hz(midi);
  const gain = options.gain ?? 0.3;
  const tau = options.tau ?? 0.45;
  const bright = options.bright ?? 0.6;
  const out = destination(voice, options.pan);

  const carrier = sine(ctx, f);
  const modulator = sine(ctx, f);
  const depth = ctx.createGain();
  // Modulation index falls from a bright strike to a near-sine body.
  depth.gain.setValueAtTime(0, t);
  depth.gain.linearRampToValueAtTime(f * (0.6 + 1.6 * bright), t + 0.003);
  depth.gain.setTargetAtTime(f * 0.18, t + 0.003, 0.09 + 0.1 * (1 - bright));
  modulator.connect(depth).connect(carrier.frequency);

  const amp = ctx.createGain();
  const end = strike(amp.gain, t, gain, 0.004, tau);
  carrier.connect(amp).connect(out);
  carrier.start(t);
  modulator.start(t);
  carrier.stop(end);
  modulator.stop(end);

  // The tine: a quiet high partial that dies almost at once.
  partial(voice, out, t, f * 7.02, gain * 0.05 * bright, 0.002, 0.03);
  return end;
};

/** Kalimba: a round fundamental with quick, slightly sharp overtones. */
export const kalimba = (voice: Voice, t: number, midi: number, options: NoteOptions = {}): number => {
  const f = hz(midi);
  const gain = options.gain ?? 0.3;
  const tau = options.tau ?? 0.32;
  const bright = options.bright ?? 0.5;
  const out = destination(voice, options.pan);
  const end = partial(voice, out, t, f, gain, 0.003, tau);
  partial(voice, out, t, f * 5.94, gain * 0.16 * bright, 0.002, 0.045);
  partial(voice, out, t, f * 2.01, gain * 0.12, 0.003, tau * 0.35);
  click(voice, out, t, f * 3, gain * 0.25 * bright);
  return end;
};

/** Marimba-like knock: fundamental, a fourth partial near 4x, a soft mallet. */
export const wood = (voice: Voice, t: number, midi: number, options: NoteOptions = {}): number => {
  const f = hz(midi);
  const gain = options.gain ?? 0.35;
  const tau = options.tau ?? 0.16;
  const bright = options.bright ?? 0.4;
  const out = destination(voice, options.pan);
  const end = partial(voice, out, t, f, gain, 0.004, tau);
  partial(voice, out, t, f * 3.93, gain * 0.22 * bright, 0.002, tau * 0.25);
  click(voice, out, t, f * 6, gain * 0.18 * bright);
  return end;
};

/** A water drop: a sine that falls into its pitch and is gone. */
export const drop = (voice: Voice, t: number, midi: number, options: NoteOptions = {}): number => {
  const { ctx } = voice;
  const f = hz(midi);
  const gain = options.gain ?? 0.2;
  const tau = options.tau ?? 0.06;
  const out = destination(voice, options.pan);
  const osc = sine(ctx, f * 1.45);
  osc.frequency.setValueAtTime(f * 1.45, t);
  osc.frequency.exponentialRampToValueAtTime(f, t + 0.028);
  const soft = ctx.createBiquadFilter();
  soft.type = "lowpass";
  soft.frequency.value = 5_200;
  const amp = ctx.createGain();
  const end = strike(amp.gain, t, gain, 0.003, tau);
  osc.connect(soft).connect(amp).connect(out);
  osc.start(t);
  osc.stop(end);
  return end;
};

/** Filtered noise that swells from `from` Hz to `to` Hz and passes. */
export const breath = (
  voice: Voice,
  t: number,
  seconds: number,
  from: number,
  to: number,
  options: NoteOptions = {},
): number => {
  const { ctx } = voice;
  const gain = options.gain ?? 0.12;
  const out = destination(voice, options.pan);
  const src = ctx.createBufferSource();
  src.buffer = voice.noise;
  src.loop = true;
  const band = ctx.createBiquadFilter();
  band.type = "bandpass";
  band.Q.value = 0.8;
  band.frequency.setValueAtTime(from, t);
  band.frequency.exponentialRampToValueAtTime(to, t + seconds);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(gain, t + seconds * 0.4);
  amp.gain.setTargetAtTime(0, t + seconds * 0.45, seconds * 0.22);
  const end = t + seconds * 0.45 + seconds * 0.22 * 7;
  src.connect(band).connect(amp).connect(out);
  src.start(t);
  src.stop(end);
  return end;
};

/** A slow, low-passed chord bed: two detuned triangles per note. */
export const pad = (
  voice: Voice,
  t: number,
  notes: ReadonlyArray<number>,
  seconds: number,
  options: NoteOptions = {},
): number => {
  const { ctx } = voice;
  const gain = options.gain ?? 0.06;
  const out = destination(voice, options.pan);
  const soft = ctx.createBiquadFilter();
  soft.type = "lowpass";
  soft.frequency.setValueAtTime(700, t);
  soft.frequency.linearRampToValueAtTime(1_500, t + seconds * 0.5);
  soft.Q.value = 0.5;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(gain, t + Math.min(0.25, seconds * 0.3));
  amp.gain.setTargetAtTime(0, t + seconds * 0.5, seconds * 0.25);
  const end = t + seconds * 0.5 + seconds * 0.25 * 7;
  soft.connect(amp).connect(out);
  for (const midi of notes) {
    for (const cents of [-6, 6]) {
      const osc = ctx.createOscillator();
      osc.type = "triangle";
      osc.frequency.value = hz(midi);
      osc.detune.value = cents;
      osc.connect(soft);
      osc.start(t);
      osc.stop(end);
    }
  }
  return end;
};
