/**
 * RTS UI SFX — static pack player.
 *
 * Offline assets only (no fal at runtime). Mute/volume live in settings.audio
 * (master + per-clip). Fail-open when settings are mid-boot.
 *
 * Playback uses Web Audio (AudioBufferSourceNode), not HTMLAudioElement.
 * Chromium's HTML media path registers with macOS MediaPlayer / Now Playing
 * and triggers the "access Apple Music / media library" TCC dialog — UI
 * chimes must never do that.
 */

import blockedUrl from "../assets/sfx/blocked.mp3?url";
import cycleUrl from "../assets/sfx/cycle.mp3?url";
import permissionUrl from "../assets/sfx/permission.mp3?url";
import type { AudioSettings, SfxClipsSettings } from "@shared/settings";
import { defaultAudio } from "@shared/settings";
import { state$ } from "./state";
import { AUDIO_ENABLED } from "@shared/features";

export const ALERT_SFX_IDS = [
  "blocked",
  "attention",
  "cycle",
] as const;

export type AlertSfxId = (typeof ALERT_SFX_IDS)[number];

/** All durable settings keys, including retired compatibility clips. */
export type SfxClipKey = keyof SfxClipsSettings;

export const SFX_CLIP_KEYS: ReadonlyArray<SfxClipKey> = [
  "blocked",
  "permission",
  "herdrDone",
  "orphan",
  "cycle",
];

export const SFX_LABELS: Readonly<Record<AlertSfxId, string>> = {
  blocked: "Blocked",
  attention: "Attention",
  cycle: "Cycle / next alert",
};

const URLS: Readonly<Record<AlertSfxId, string>> = {
  blocked: blockedUrl,
  // Keep the existing bytes and durable `permission` clip preference while
  // presenting this sound as the generic node-attention cue.
  attention: permissionUrl,
  cycle: cycleUrl,
};

const isAlertSfxId = (value: string): value is AlertSfxId =>
  (ALERT_SFX_IDS as ReadonlyArray<string>).includes(value);

export const sfxIdToClipKey = (id: AlertSfxId): SfxClipKey => {
  return id === "attention" ? "permission" : id;
};

/** Map active settings clips back to alert ids; retired keys have no producer. */
export const clipKeyToSfxId = (key: SfxClipKey): AlertSfxId | undefined => {
  switch (key) {
    case "permission":
      return "attention";
    case "blocked":
    case "cycle":
      return key;
    default:
      return undefined;
  }
};

const readAudio = (): AudioSettings => {
  try {
    const audio = state$.settings.audio.peek() as AudioSettings | undefined;
    return audio ?? defaultAudio();
  } catch {
    return defaultAudio();
  }
};

export const isSfxMuted = (): boolean => readAudio().muted;

/** Resolve effective 0..1 gain for a clip (master × clip), or null if silent. */
export const resolveSfxGain = (id: AlertSfxId, audio: AudioSettings = readAudio()): number | null => {
  if (audio.muted) return null;
  const clip = audio.clips[sfxIdToClipKey(id)];
  if (!clip?.enabled) return null;
  const gain = audio.masterVolume * clip.volume;
  if (!(gain > 0)) return null;
  return Math.min(1, Math.max(0, gain));
};

export const sfxUrl = (id: AlertSfxId): string => URLS[id];

// --- Web Audio path (no HTMLMediaElement / no macOS MediaPlayer TCC) ---

type AudioContextCtor = typeof AudioContext;

const audioContextCtor = (): AudioContextCtor | null => {
  if (typeof globalThis === "undefined") return null;
  const g = globalThis as typeof globalThis & {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
};

let sharedContext: AudioContext | null = null;
const bufferCache = new Map<AlertSfxId, AudioBuffer>();
const inflightDecode = new Map<AlertSfxId, Promise<AudioBuffer | null>>();

/** Test seam — clears the shared context and decoded buffer cache. */
export const resetSfxRuntimeForTests = (): void => {
  sharedContext = null;
  bufferCache.clear();
  inflightDecode.clear();
};

const getContext = (): AudioContext | null => {
  const Ctor = audioContextCtor();
  if (!Ctor) return null;
  if (sharedContext === null) {
    try {
      sharedContext = new Ctor();
    } catch {
      return null;
    }
  }
  return sharedContext;
};

const resumeContext = async (ctx: AudioContext): Promise<boolean> => {
  try {
    if (ctx.state !== "running") await ctx.resume();
    // Compare via string so control-flow narrowing of AudioContextState
    // does not treat post-resume "running" as impossible.
    return `${ctx.state}` === "running";
  } catch {
    return false;
  }
};

const decodeClip = async (id: AlertSfxId, ctx: AudioContext): Promise<AudioBuffer | null> => {
  const cached = bufferCache.get(id);
  if (cached) return cached;
  const pending = inflightDecode.get(id);
  if (pending) return pending;

  const work = (async (): Promise<AudioBuffer | null> => {
    try {
      const response = await fetch(URLS[id]);
      if (!response.ok) return null;
      const bytes = await response.arrayBuffer();
      // slice() so decodeAudioData cannot detach the source ArrayBuffer mid-use.
      const buffer = await ctx.decodeAudioData(bytes.slice(0));
      bufferCache.set(id, buffer);
      return buffer;
    } catch {
      return null;
    } finally {
      inflightDecode.delete(id);
    }
  })();

  inflightDecode.set(id, work);
  return work;
};

const startBuffer = (ctx: AudioContext, buffer: AudioBuffer, gain: number): void => {
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gainNode = ctx.createGain();
  gainNode.gain.value = gain;
  source.connect(gainNode);
  gainNode.connect(ctx.destination);
  source.start(0);
};

/**
 * Play a catalog alert. Fail-open: missing Web Audio, autoplay block, mute, or
 * bad id never throws into the attention path.
 *
 * Intentionally never falls back to HTMLAudioElement — that path is what
 * surfaces the macOS Apple Music / media library permission dialog.
 */
export const playAlert = (id: AlertSfxId | string): void => {
  if (!AUDIO_ENABLED) return;
  if (!isAlertSfxId(id)) return;
  const gain = resolveSfxGain(id);
  if (gain === null) return;
  const ctx = getContext();
  if (!ctx) return;

  void (async () => {
    try {
      if (!(await resumeContext(ctx))) return;
      const buffer = await decodeClip(id, ctx);
      if (!buffer) return;
      // Re-check mute after the async gap (settings can change mid-decode).
      const liveGain = resolveSfxGain(id);
      if (liveGain === null) return;
      startBuffer(ctx, buffer, liveGain);
    } catch {
      // fail-open
    }
  })();
};
