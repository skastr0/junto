/**
 * The cue catalog: every sound Junto makes, one per meaning.
 *
 * Urgency sets the loudness and the shape. Cues that need the operator
 * (blocked, waiting on you, failed) are the loudest and end open, so the ear
 * waits for an answer; nothing is harsh, nothing repeats. Cues that say work
 * is moving (started, answered, a squad placed, mail between seats) are
 * soft and resolve home to D. Every cue is played from the same palette and
 * room (palette.ts), so fifty seats still sound like one instrument.
 *
 * A render takes `count`: a burst the mixer coalesced plays once, a little
 * fuller, instead of `count` times.
 */

import type { SoundCategory } from "@shared/settings";
import { NOTE, PENTATONIC } from "./palette";
import { breath, drop, kalimba, pad, tine, wood, type Voice } from "./voices";

export const CUE_IDS = [
  "blocked",
  "waiting",
  "failed",
  "review",
  "done",
  "summary",
  "working",
  "answered",
  "squad",
  "mail",
  "navigate",
  "bell",
] as const;

export type CueId = (typeof CUE_IDS)[number];

export const isCueId = (value: string): value is CueId =>
  (CUE_IDS as ReadonlyArray<string>).includes(value);

/** Mail colour, after the wire pulse it rides with. */
export type MailTone = "notice" | "prompt" | "answer";

export type CueVariant = {
  /** How many events this play stands for (coalesced bursts). */
  readonly count: number;
  readonly tone?: MailTone;
  /** -1..1 stereo position, from where the seat sits on screen. */
  readonly pan?: number;
};

/** 0 background chrome, 1 things are moving, 2 ready for you, 3 needs you, 4 stopped. */
export type Urgency = 0 | 1 | 2 | 3 | 4;

export type CueSpec = {
  readonly category: SoundCategory;
  readonly urgency: Urgency;
  /** Linear level of the whole cue: urgency made audible. */
  readonly level: number;
  /** Seconds the cue sounds for (before the room tail). */
  readonly seconds: number;
  /** Events closer than this merge into one play. 0 plays at once. */
  readonly coalesceMs: number;
  /** A second play of the same cue sooner than this is dropped. */
  readonly minGapMs: number;
  readonly label: string;
  /** What it means, for Settings. */
  readonly meaning: string;
  readonly render: (voice: Voice, t: number, variant: CueVariant) => void;
};

const capped = (count: number, max: number): number => Math.max(1, Math.min(max, Math.floor(count)));

export const CUES: Readonly<Record<CueId, CueSpec>> = {
  blocked: {
    category: "attention",
    urgency: 4,
    level: 1,
    seconds: 1.3,
    coalesceMs: 0,
    minGapMs: 2_500,
    label: "Blocked",
    meaning: "An agent stopped and cannot go on without you.",
    // Two low knocks, then a bell that steps down a fourth and hangs there.
    render: (v, t, { pan }) => {
      wood(v, t, NOTE.D3, { gain: 0.5, tau: 0.2, pan });
      wood(v, t + 0.17, NOTE.D3, { gain: 0.38, tau: 0.22, pan });
      tine(v, t + 0.34, NOTE.B4, { gain: 0.3, tau: 0.5, bright: 0.7, pan });
      tine(v, t + 0.6, NOTE.Fs4, { gain: 0.3, tau: 0.8, bright: 0.5, pan });
      pad(v, t + 0.34, [NOTE.B3, NOTE.Fs4], 1.1, { gain: 0.05, pan });
    },
  },
  waiting: {
    category: "attention",
    urgency: 3,
    level: 0.85,
    seconds: 1.1,
    coalesceMs: 0,
    minGapMs: 2_000,
    label: "Waiting on you",
    meaning: "An agent asked you something and is holding for the answer.",
    // A question: rising A, D, E, left open on the second.
    render: (v, t, { pan }) => {
      tine(v, t, NOTE.A4, { gain: 0.26, tau: 0.35, bright: 0.6, pan });
      tine(v, t + 0.13, NOTE.D5, { gain: 0.27, tau: 0.35, bright: 0.6, pan });
      tine(v, t + 0.26, NOTE.E5, { gain: 0.3, tau: 0.75, bright: 0.7, pan });
      kalimba(v, t + 0.26, NOTE.E6, { gain: 0.05, tau: 0.3, pan });
      pad(v, t + 0.1, [NOTE.A3, NOTE.E4], 1, { gain: 0.04, pan });
    },
  },
  failed: {
    category: "attention",
    urgency: 3,
    level: 0.8,
    seconds: 1.2,
    coalesceMs: 0,
    minGapMs: 2_500,
    label: "Failed",
    meaning: "An agent ended with an error.",
    // A soft knock and a falling minor line that settles low.
    render: (v, t, { pan }) => {
      wood(v, t, NOTE.B3, { gain: 0.4, tau: 0.2, pan });
      tine(v, t + 0.12, NOTE.B4, { gain: 0.26, tau: 0.35, bright: 0.5, pan });
      tine(v, t + 0.3, NOTE.Fs4, { gain: 0.26, tau: 0.35, bright: 0.45, pan });
      tine(v, t + 0.48, NOTE.D4, { gain: 0.28, tau: 0.8, bright: 0.35, pan });
    },
  },
  review: {
    category: "review",
    urgency: 2,
    level: 0.62,
    seconds: 0.9,
    coalesceMs: 200,
    minGapMs: 1_500,
    label: "Ready for review",
    meaning: "An agent has something for you to look at.",
    // An open fifth, D up to A, with a glint on top.
    render: (v, t, { count, pan }) => {
      kalimba(v, t, NOTE.D5, { gain: 0.3, tau: 0.35, pan });
      tine(v, t + 0.11, NOTE.A5, { gain: 0.22, tau: 0.55, bright: 0.5, pan });
      if (count > 1) kalimba(v, t + 0.22, NOTE.E6, { gain: 0.1, tau: 0.3, pan });
    },
  },
  done: {
    category: "review",
    urgency: 2,
    level: 0.55,
    seconds: 1.2,
    coalesceMs: 260,
    minGapMs: 1_200,
    label: "Done",
    meaning: "An agent finished its turn and you have not looked yet.",
    // Down the D major triad to home, over a warm chord. More seats, more notes.
    render: (v, t, { count, pan }) => {
      const notes = [NOTE.A5, NOTE.Fs5, NOTE.D5];
      const extra = capped(count, 4) - 1;
      const line = [...[NOTE.D6, NOTE.B5, NOTE.E6].slice(0, extra), ...notes];
      line.forEach((midi, i) =>
        kalimba(v, t + i * 0.085, midi, { gain: 0.24, tau: i === line.length - 1 ? 0.6 : 0.28, pan }),
      );
      pad(v, t + 0.05, [NOTE.D4, NOTE.Fs4, NOTE.A4, NOTE.Cs5], 1.2, { gain: 0.045, pan });
    },
  },
  summary: {
    category: "review",
    urgency: 1,
    level: 0.5,
    seconds: 0.8,
    coalesceMs: 400,
    minGapMs: 4_000,
    label: "Summary",
    meaning: "A digest of what happened while you were away.",
    render: (v, t, { pan }) => {
      tine(v, t, NOTE.Fs5, { gain: 0.2, tau: 0.3, bright: 0.4, pan });
      tine(v, t + 0.12, NOTE.D5, { gain: 0.22, tau: 0.6, bright: 0.4, pan });
    },
  },
  working: {
    category: "activity",
    urgency: 1,
    level: 0.34,
    seconds: 0.6,
    coalesceMs: 300,
    minGapMs: 900,
    label: "Started working",
    meaning: "An agent picked up work.",
    // A small breath in, then a low note: the seat leaning forward.
    render: (v, t, { count, pan }) => {
      breath(v, t, 0.32, 380, 1_300, { gain: 0.1 + 0.02 * capped(count, 3), pan });
      kalimba(v, t + 0.16, NOTE.D4, { gain: 0.22, tau: 0.3, bright: 0.3, pan });
      if (count > 1) kalimba(v, t + 0.24, NOTE.A4, { gain: 0.12, tau: 0.25, bright: 0.3, pan });
    },
  },
  answered: {
    category: "activity",
    urgency: 1,
    level: 0.4,
    seconds: 0.6,
    coalesceMs: 150,
    minGapMs: 600,
    label: "Answered",
    meaning: "Your answer reached the agent.",
    // The question's E, finally resolved down to D.
    render: (v, t, { pan }) => {
      tine(v, t, NOTE.E5, { gain: 0.18, tau: 0.2, bright: 0.35, pan });
      tine(v, t + 0.1, NOTE.D5, { gain: 0.22, tau: 0.5, bright: 0.35, pan });
    },
  },
  squad: {
    category: "activity",
    urgency: 1,
    level: 0.42,
    seconds: 0.8,
    coalesceMs: 200,
    minGapMs: 800,
    label: "Squad placed",
    meaning: "A squad of agents landed in a region.",
    // A strum up the pentatonic, one string per seat, up to six.
    render: (v, t, { count, pan }) => {
      const strings = capped(count, 6);
      const start = Math.max(0, 3 - Math.floor(strings / 2));
      for (let i = 0; i < Math.max(3, strings); i += 1) {
        const midi = PENTATONIC[start + i] ?? NOTE.D6;
        kalimba(v, t + i * 0.045, midi, { gain: 0.18, tau: 0.35, bright: 0.4, pan });
      }
    },
  },
  mail: {
    category: "traffic",
    urgency: 0,
    level: 0.26,
    seconds: 0.2,
    coalesceMs: 120,
    minGapMs: 240,
    label: "Message between agents",
    meaning: "A message crossed a wire.",
    // A single drop, pitched by what kind of message it was.
    render: (v, t, { count, tone, pan }) => {
      const midi = tone === "prompt" ? NOTE.A5 : tone === "answer" ? NOTE.D6 : NOTE.Fs5;
      drop(v, t, midi, { gain: 0.3, pan });
      if (count > 1) drop(v, t + 0.07, midi + 5, { gain: 0.16, pan });
    },
  },
  navigate: {
    category: "interface",
    urgency: 0,
    level: 0.25,
    seconds: 0.12,
    coalesceMs: 0,
    minGapMs: 60,
    label: "Next alert",
    meaning: "Space or ` jumps to the next seat that needs you.",
    render: (v, t) => {
      wood(v, t, NOTE.D6, { gain: 0.2, tau: 0.04, bright: 0.2 });
    },
  },
  bell: {
    category: "interface",
    urgency: 0,
    level: 0.3,
    seconds: 0.5,
    coalesceMs: 0,
    minGapMs: 400,
    label: "Terminal bell",
    meaning: "A program in a terminal rang its bell.",
    render: (v, t) => {
      tine(v, t, NOTE.A5, { gain: 0.24, tau: 0.35, bright: 0.5 });
    },
  },
};

/** Cues in a family, most urgent first. */
export const cuesInCategory = (category: SoundCategory): ReadonlyArray<CueId> =>
  CUE_IDS.filter((id) => CUES[id].category === category);

/** Families, in Settings order, with plain names. */
export const CATEGORY_LABEL: Readonly<Record<SoundCategory, { readonly title: string; readonly hint: string }>> = {
  attention: { title: "Needs you", hint: "blocked, waiting on you, failed" },
  review: { title: "Ready for you", hint: "ready for review, done, summaries" },
  activity: { title: "Activity", hint: "started working, answered, squads" },
  traffic: { title: "Messages", hint: "mail between agents, very quiet" },
  interface: { title: "Interface", hint: "next alert, terminal bell" },
};
