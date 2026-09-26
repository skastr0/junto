/**
 * The live sound engine: one AudioContext, the shared graph, the mixer's
 * policy, and the operator's settings.
 *
 * Playback is Web Audio only. HTMLMediaElement registers with macOS Now
 * Playing and raises the media library permission prompt; UI sound must
 * never do that. The context is made on the first cue and suspended after a
 * quiet spell, so an idle Junto keeps no audio thread busy. Every failure
 * (no Web Audio, a refused resume) is silent: sound never breaks a caller.
 */

import { AUDIO_ENABLED } from "@shared/features";
import {
  SOUND_CATEGORIES,
  defaultAudio,
  soundCategoryPrefs,
  type AudioSettings,
} from "@shared/settings";
import { state$ } from "../state";
import { CUES, type CueId, type CueVariant } from "./cues";
import { buildSoundGraph, duckAmbient, releaseCue, renderCue, type SoundGraph, type Sounding } from "./graph";
import { ATTENTION_URGENCY, CueMixer, type CueRequest, type Play, type RequestOutcome } from "./mixer";

/** Suspend the context after this long with nothing sounding. */
const IDLE_SUSPEND_MS = 20_000;
/** Gap between cues in a preview run. */
const PREVIEW_GAP_S = 0.45;

const readAudio = (): AudioSettings => {
  try {
    return (state$.settings.audio.peek() as AudioSettings | undefined) ?? defaultAudio();
  } catch {
    return defaultAudio();
  }
};

/** Whether the operator's settings let this cue sound at all. */
export const cueAudible = (audio: AudioSettings, cue: CueId): boolean => {
  if (audio.muted || !(audio.masterVolume > 0)) return false;
  const family = soundCategoryPrefs(audio, CUES[cue].category);
  return family.enabled && family.volume > 0;
};

type ContextCtor = typeof AudioContext;

const contextCtor = (): ContextCtor | undefined => {
  const g = globalThis as typeof globalThis & { webkitAudioContext?: ContextCtor };
  return g.AudioContext ?? g.webkitAudioContext;
};

const hidden = (): boolean =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

export class SoundEngine {
  private ctx: AudioContext | undefined;
  private graph: SoundGraph | undefined;
  private readonly mixer = new CueMixer(CUES);
  private readonly sounding = new Map<number, Sounding>();
  private preview: Sounding[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private offSettings: (() => void) | undefined;
  private hushUntil = 0;

  constructor(private readonly clock: () => number = () => performance.now()) {}

  /** Ask for a cue. The mixer decides whether, and how, it sounds. */
  play(cue: CueId, request: CueRequest = {}): RequestOutcome | "silent" {
    if (!AUDIO_ENABLED || !cueAudible(readAudio(), cue)) return "silent";
    if (this.clock() < this.hushUntil) return "silent";
    const outcome = this.mixer.request(cue, this.clock(), request);
    this.flush();
    return outcome;
  }

  /**
   * Stay silent for a while: a canvas that just opened is hydrating, and
   * what it already held is not news. Previews still sound.
   */
  hush(ms: number): void {
    this.hushUntil = Math.max(this.hushUntil, this.clock() + ms);
  }

  /** Settings preview: one cue now, at the operator's levels, outside the mixer. */
  previewCue(cue: CueId): void {
    this.previewRun([{ cue, variant: { count: 1 } }]);
  }

  /** Settings preview: cues one after another; a new run replaces the last. */
  previewRun(run: ReadonlyArray<{ readonly cue: CueId; readonly variant: CueVariant }>): void {
    if (!AUDIO_ENABLED) return;
    void this.withGraph((graph, ctx) => {
      const audio = readAudio();
      for (const sounding of this.preview) releaseCue(sounding, ctx.currentTime);
      this.preview = [];
      let t = ctx.currentTime + 0.02;
      for (const { cue, variant } of run) {
        if (!cueAudible(audio, cue)) continue;
        const sounding = renderCue(graph, cue, t, variant);
        this.preview.push(sounding);
        t = sounding.endsAt + PREVIEW_GAP_S;
      }
      this.armIdle(t);
    });
  }

  private flush(): void {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    const now = this.clock();
    const plays = this.mixer.due(now, hidden());
    if (plays.length > 0) void this.start(plays);
    const next = this.mixer.nextDueAt();
    if (next !== undefined) {
      this.flushTimer = setTimeout(() => this.flush(), Math.max(0, next - now));
    }
  }

  private async start(plays: ReadonlyArray<Play>): Promise<void> {
    await this.withGraph((graph, ctx) => {
      const audio = readAudio();
      const t = ctx.currentTime + 0.01;
      for (const [id, sounding] of this.sounding) {
        if (sounding.endsAt < ctx.currentTime) this.sounding.delete(id);
      }
      let last = t;
      for (const play of plays) {
        for (const id of play.steal) {
          const victim = this.sounding.get(id);
          if (victim !== undefined) releaseCue(victim, t);
          this.sounding.delete(id);
        }
        // Settings may have changed while the context resumed.
        if (!cueAudible(audio, play.cue)) continue;
        const sounding = renderCue(graph, play.cue, t, play.variant);
        this.sounding.set(play.id, sounding);
        last = Math.max(last, sounding.endsAt);
        if (CUES[play.cue].urgency >= ATTENTION_URGENCY) duckAmbient(graph, t, CUES[play.cue].seconds);
      }
      this.armIdle(last);
    });
  }

  /** Run with a resumed context and current levels; silent on any failure. */
  private async withGraph(run: (graph: SoundGraph, ctx: AudioContext) => void): Promise<void> {
    try {
      const ready = this.ensure();
      if (ready === undefined) return;
      const [graph, ctx] = ready;
      if (ctx.state !== "running") await ctx.resume();
      if (`${ctx.state}` !== "running") return;
      this.applyLevels(readAudio());
      run(graph, ctx);
    } catch {
      // Sound is never load-bearing.
    }
  }

  private ensure(): readonly [SoundGraph, AudioContext] | undefined {
    if (this.ctx !== undefined && this.graph !== undefined) return [this.graph, this.ctx];
    const Ctor = contextCtor();
    if (Ctor === undefined) return undefined;
    const ctx = new Ctor({ latencyHint: "interactive" });
    this.ctx = ctx;
    this.graph = buildSoundGraph(ctx);
    this.offSettings = state$.settings.audio.onChange(({ value }) => {
      if (value !== undefined) this.applyLevels(value as AudioSettings);
    });
    return [this.graph, ctx];
  }

  private applyLevels(audio: AudioSettings): void {
    const graph = this.graph;
    const ctx = this.ctx;
    if (graph === undefined || ctx === undefined) return;
    const t = ctx.currentTime;
    graph.master.gain.setTargetAtTime(audio.muted ? 0 : audio.masterVolume, t, 0.02);
    for (const category of SOUND_CATEGORIES) {
      const family = soundCategoryPrefs(audio, category);
      graph.families[category].gain.setTargetAtTime(family.enabled ? family.volume : 0, t, 0.02);
    }
  }

  /** Suspend once the last scheduled sound (context time `until`) has rung out. */
  private armIdle(until: number): void {
    const ctx = this.ctx;
    if (ctx === undefined) return;
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    const ms = Math.max(0, (until - ctx.currentTime) * 1_000) + IDLE_SUSPEND_MS;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void ctx.suspend().catch(() => undefined);
    }, ms);
  }

  /** Tests: drop the context and every timer. */
  dispose(): void {
    if (this.flushTimer !== undefined) clearTimeout(this.flushTimer);
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer);
    this.offSettings?.();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = undefined;
    this.graph = undefined;
    this.sounding.clear();
    this.preview = [];
  }
}
