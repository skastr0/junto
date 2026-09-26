/**
 * The mixer's policy: which requested cues actually sound. Pure, clock
 * injected, no Web Audio, so fifty seats can be simulated in a test.
 *
 * Laws:
 * - Coalesce: requests for the same cue inside its window become one play
 *   that knows how many it stands for.
 * - Rate: a cue never plays again sooner than its own gap, and never again
 *   for the same subject (a seat) sooner than its subject gap, so a seat
 *   whose state flickers is heard once.
 * - One attention cue at a time: while one sounds (and a short hush after),
 *   another of equal or lower urgency is dropped; a more urgent one takes
 *   over and the first fades out.
 * - Voices: at most `maxVoices` cues sound at once; a new cue steals the
 *   least urgent, oldest voice below it, or is dropped.
 * - Budget: the quiet families (urgency 2 and under) share a small rolling
 *   budget so a burst across the canvas reads as a few notes, not a wash.
 *
 * A dropped cue is never replayed late: a late sound describes nothing. The
 * screen still shows every state; sound only points at it.
 */

import type { CueId, CueSpec, CueVariant, MailTone, Urgency } from "./cues";

export type MixSpec = Pick<CueSpec, "urgency" | "seconds" | "coalesceMs" | "minGapMs" | "subjectGapMs">;

export type MixerLimits = {
  readonly maxVoices: number;
  /** Hush after an attention cue before another may sound. */
  readonly attentionHushMs: number;
  readonly ambientBudget: number;
  readonly ambientWindowMs: number;
};

export const MIXER_LIMITS: MixerLimits = {
  maxVoices: 4,
  attentionHushMs: 1_600,
  ambientBudget: 5,
  ambientWindowMs: 4_000,
};

/** An echo this soon after its cue sounded is the same event. */
export const ECHO_WINDOW_MS = 3_000;

/** Urgency at and above which a cue takes the one attention slot. */
export const ATTENTION_URGENCY: Urgency = 3;

export type CueRequest = {
  readonly count?: number;
  /** What the cue is about (a node id), for the per-subject gap. */
  readonly subject?: string;
  /**
   * The same event, reported again by another path (a native notification
   * for something the canvas already sounded). It joins a waiting play
   * without counting, and is dropped if that cue just sounded.
   */
  readonly echo?: boolean;
  readonly tone?: MailTone;
  readonly pan?: number;
};

export type Play = {
  /** Instance id; the engine keys its voice gain by it. */
  readonly id: number;
  readonly cue: CueId;
  readonly variant: CueVariant;
  /** Instance ids to fade out now. */
  readonly steal: ReadonlyArray<number>;
};

export type RequestOutcome = "queued" | "coalesced" | "dropped";

type Pending = {
  count: number;
  /** Only echoes so far: the first real request joins it without counting. */
  echo: boolean;
  tone?: MailTone;
  pan?: number;
  readonly dueAt: number;
};

type Active = {
  readonly id: number;
  readonly cue: CueId;
  readonly urgency: Urgency;
  readonly startedAt: number;
  readonly endsAt: number;
};

export class CueMixer {
  private readonly pending = new Map<CueId, Pending>();
  private readonly lastStart = new Map<CueId, number>();
  private readonly lastSubject = new Map<string, number>();
  private active: Active[] = [];
  private ambientStarts: number[] = [];
  private attention: { readonly id: number; readonly urgency: Urgency; readonly until: number } | undefined;
  private nextId = 1;

  constructor(
    private readonly specs: Readonly<Record<CueId, MixSpec>>,
    private readonly limits: MixerLimits = MIXER_LIMITS,
  ) {}

  request(cue: CueId, now: number, request: CueRequest = {}): RequestOutcome {
    const spec = this.specs[cue];
    const count = Math.max(1, Math.floor(request.count ?? 1));
    const waiting = this.pending.get(cue);
    if (request.echo === true) {
      if (waiting !== undefined) return "coalesced";
      const last = this.lastStart.get(cue);
      if (last !== undefined && now - last < ECHO_WINDOW_MS) return "dropped";
    }
    if (!this.subjectFree(cue, spec, now, request.subject)) return "dropped";
    if (waiting !== undefined) {
      if (waiting.echo) waiting.echo = false;
      else waiting.count += count;
      if (request.tone !== undefined) waiting.tone = request.tone;
      if (request.pan !== undefined) waiting.pan = request.pan;
      return "coalesced";
    }
    const last = this.lastStart.get(cue);
    if (last !== undefined && now - last < spec.minGapMs) return "dropped";
    this.pending.set(cue, {
      count,
      echo: request.echo === true,
      tone: request.tone,
      pan: request.pan,
      dueAt: now + spec.coalesceMs,
    });
    return "queued";
  }

  /** When the next queued cue falls due, if any. */
  nextDueAt(): number | undefined {
    let next: number | undefined;
    for (const waiting of this.pending.values()) {
      if (next === undefined || waiting.dueAt < next) next = waiting.dueAt;
    }
    return next;
  }

  /**
   * Cues that start now, most urgent first, with the voices they take over.
   * `all` closes every coalescing window early (a hidden window's timers are
   * throttled, so it cannot wait for them).
   */
  due(now: number, all = false): ReadonlyArray<Play> {
    this.prune(now);
    const ready = [...this.pending.entries()]
      .filter(([, waiting]) => all || waiting.dueAt <= now)
      .sort(([a], [b]) => this.specs[b].urgency - this.specs[a].urgency);
    const plays: Play[] = [];
    for (const [cue, waiting] of ready) {
      this.pending.delete(cue);
      const play = this.admit(cue, waiting, now);
      if (play !== undefined) plays.push(play);
    }
    return plays;
  }

  /** Instances still sounding (for tests and the engine's idle check). */
  sounding(now: number): number {
    this.prune(now);
    return this.active.length;
  }

  private admit(cue: CueId, waiting: Pending, now: number): Play | undefined {
    const spec = this.specs[cue];
    const steal: number[] = [];

    if (spec.urgency >= ATTENTION_URGENCY) {
      const slot = this.attention;
      if (slot !== undefined && now < slot.until) {
        if (spec.urgency <= slot.urgency) return undefined;
        if (this.active.some((voice) => voice.id === slot.id)) steal.push(slot.id);
      }
    } else if (!this.withinBudget(now)) {
      return undefined;
    }

    const live = this.active.filter((voice) => !steal.includes(voice.id));
    if (live.length >= this.limits.maxVoices) {
      const victim = [...live]
        .filter((voice) => voice.urgency < spec.urgency)
        .sort((a, b) => a.urgency - b.urgency || a.startedAt - b.startedAt)[0];
      if (victim === undefined) return undefined;
      steal.push(victim.id);
    }

    const id = this.nextId;
    this.nextId += 1;
    const endsAt = now + spec.seconds * 1_000;
    this.active = [
      ...this.active.filter((voice) => !steal.includes(voice.id)),
      { id, cue, urgency: spec.urgency, startedAt: now, endsAt },
    ];
    this.lastStart.set(cue, now);
    if (spec.urgency >= ATTENTION_URGENCY) {
      this.attention = { id, urgency: spec.urgency, until: endsAt + this.limits.attentionHushMs };
    } else {
      this.ambientStarts.push(now);
    }
    return {
      id,
      cue,
      variant: { count: waiting.count, tone: waiting.tone, pan: waiting.pan },
      steal,
    };
  }

  private subjectFree(cue: CueId, spec: MixSpec, now: number, subject: string | undefined): boolean {
    if (subject === undefined || spec.subjectGapMs === undefined) return true;
    const key = `${cue}\u0000${subject}`;
    const last = this.lastSubject.get(key);
    if (last !== undefined && now - last < spec.subjectGapMs) return false;
    this.lastSubject.set(key, now);
    if (this.lastSubject.size > 512) {
      for (const [k, at] of this.lastSubject) if (now - at >= spec.subjectGapMs) this.lastSubject.delete(k);
    }
    return true;
  }

  private withinBudget(now: number): boolean {
    this.ambientStarts = this.ambientStarts.filter((at) => now - at < this.limits.ambientWindowMs);
    return this.ambientStarts.length < this.limits.ambientBudget;
  }

  private prune(now: number): void {
    this.active = this.active.filter((voice) => voice.endsAt > now);
  }
}
