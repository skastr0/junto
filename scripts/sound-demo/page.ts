/**
 * Browser half of the sound demo: renders shots through the real sound
 * graph on an OfflineAudioContext and hands the samples back. Also runs the
 * real mixer over a simulated busy canvas, so the demo plays exactly what
 * the app would let through.
 */

import { defaultSoundCategories, SOUND_CATEGORIES } from "@shared/settings";
import { CUE_IDS, CUES, type CueId, type CueVariant, type MailTone } from "../../src/renderer/lib/sound/cues";
import { buildSoundGraph, duckAmbient, renderCue } from "../../src/renderer/lib/sound/graph";
import { ATTENTION_URGENCY, CueMixer, type CueRequest } from "../../src/renderer/lib/sound/mixer";
import { seeded } from "../../src/renderer/lib/sound/palette";

export type Shot = { readonly cue: CueId; readonly at: number; readonly variant: CueVariant };

const RATE = 48_000;
/** The default master volume (settings.ts defaultAudio). */
const MASTER = 0.6;

const toBase64 = (samples: Float32Array): string => {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
};

const render = async (
  shots: ReadonlyArray<Shot>,
  seconds: number,
): Promise<{ left: string; right: string }> => {
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * RATE), RATE);
  const graph = buildSoundGraph(ctx);
  graph.master.gain.value = MASTER;
  const families = defaultSoundCategories();
  for (const category of SOUND_CATEGORIES) graph.families[category].gain.value = families[category].volume;
  for (const shot of shots) {
    renderCue(graph, shot.cue, shot.at, shot.variant);
    if (CUES[shot.cue].urgency >= ATTENTION_URGENCY) duckAmbient(graph, shot.at, CUES[shot.cue].seconds);
  }
  const buffer = await ctx.startRendering();
  return { left: toBase64(buffer.getChannelData(0)), right: toBase64(buffer.getChannelData(1)) };
};

type Raw = { readonly at: number; readonly cue: CueId; readonly request: CueRequest };

/**
 * Fifty seats for `seconds`: most working, finishing and mailing each
 * other, a squad landing, a couple needing the operator. Seeded.
 */
const busyCanvas = (start: number, seconds: number): { raw: number; shots: Shot[] } => {
  const next = seeded(0x50);
  const events: Raw[] = [];
  const tones: ReadonlyArray<MailTone> = ["notice", "prompt", "answer"];
  for (let seat = 0; seat < 50; seat += 1) {
    const pan = (seat / 49) * 1.2 - 0.6;
    let t = next() * 2;
    while (t < seconds) {
      const roll = next();
      const cue: CueId = roll < 0.4 ? "mail" : roll < 0.7 ? "working" : roll < 0.9 ? "done" : "review";
      events.push({ at: t, cue, request: { pan, tone: tones[Math.floor(next() * 3)] } });
      t += 0.6 + next() * 3;
    }
  }
  events.push({ at: 1.2, cue: "squad", request: { count: 5 } });
  events.push({ at: seconds * 0.35, cue: "waiting", request: {} });
  events.push({ at: seconds * 0.37, cue: "waiting", request: {} });
  events.push({ at: seconds * 0.7, cue: "blocked", request: {} });
  events.push({ at: seconds * 0.72, cue: "answered", request: {} });
  events.sort((a, b) => a.at - b.at);

  const mixer = new CueMixer(CUES);
  const shots: Shot[] = [];
  let i = 0;
  for (let ms = 0; ms <= seconds * 1_000 + 1_000; ms += 5) {
    while (i < events.length && events[i]!.at * 1_000 <= ms) {
      mixer.request(events[i]!.cue, ms, events[i]!.request);
      i += 1;
    }
    for (const play of mixer.due(ms)) {
      shots.push({ cue: play.cue, at: start + ms / 1_000, variant: play.variant });
    }
  }
  return { raw: events.length, shots };
};

declare global {
  interface Window {
    __sound: {
      render: typeof render;
      busyCanvas: typeof busyCanvas;
      cues: ReadonlyArray<{ id: CueId; seconds: number; urgency: number; label: string }>;
    };
  }
}

window.__sound = {
  render,
  busyCanvas,
  cues: CUE_IDS.map((id) => ({ id, seconds: CUES[id].seconds, urgency: CUES[id].urgency, label: CUES[id].label })),
};
