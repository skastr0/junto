/**
 * RTS UI SFX — static pack player.
 *
 * Offline assets only (no fal at runtime). Mute/volume live in settings.audio
 * (master + per-clip). Fail-open when settings are mid-boot.
 */

import blockedUrl from "../assets/sfx/blocked.mp3?url";
import boothReviewUrl from "../assets/sfx/booth-review.mp3?url";
import cycleUrl from "../assets/sfx/cycle.mp3?url";
import herdrDoneUrl from "../assets/sfx/herdr-done.mp3?url";
import orphanUrl from "../assets/sfx/orphan.mp3?url";
import permissionUrl from "../assets/sfx/permission.mp3?url";
import type { AudioSettings, SfxClipsSettings } from "@shared/settings";
import { defaultAudio } from "@shared/settings";
import { state$ } from "./state";

export const ALERT_SFX_IDS = [
  "blocked",
  "permission",
  "herdr-done",
  "booth-review",
  "orphan",
  "cycle",
] as const;

export type AlertSfxId = (typeof ALERT_SFX_IDS)[number];

/** Settings key for each alert id (camelCase). */
export type SfxClipKey = keyof SfxClipsSettings;

export const SFX_CLIP_KEYS: ReadonlyArray<SfxClipKey> = [
  "blocked",
  "permission",
  "herdrDone",
  "boothReview",
  "orphan",
  "cycle",
];

export const SFX_LABELS: Readonly<Record<AlertSfxId, string>> = {
  blocked: "Blocked",
  permission: "Permission pending",
  "herdr-done": "Herdr done",
  "booth-review": "Booth review",
  orphan: "Orphaned arm",
  cycle: "Cycle / next alert",
};

const URLS: Readonly<Record<AlertSfxId, string>> = {
  blocked: blockedUrl,
  permission: permissionUrl,
  "herdr-done": herdrDoneUrl,
  "booth-review": boothReviewUrl,
  orphan: orphanUrl,
  cycle: cycleUrl,
};

const isAlertSfxId = (value: string): value is AlertSfxId =>
  (ALERT_SFX_IDS as ReadonlyArray<string>).includes(value);

export const sfxIdToClipKey = (id: AlertSfxId): SfxClipKey => {
  switch (id) {
    case "herdr-done":
      return "herdrDone";
    case "booth-review":
      return "boothReview";
    default:
      return id;
  }
};

export const clipKeyToSfxId = (key: SfxClipKey): AlertSfxId => {
  switch (key) {
    case "herdrDone":
      return "herdr-done";
    case "boothReview":
      return "booth-review";
    default:
      return key;
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

/**
 * Play a catalog alert. Fail-open: missing Audio, autoplay block, mute, or
 * bad id never throws into the attention path.
 */
export const playAlert = (id: AlertSfxId | string): void => {
  if (!isAlertSfxId(id)) return;
  const gain = resolveSfxGain(id);
  if (gain === null) return;
  if (typeof Audio === "undefined") return;
  try {
    const audio = new Audio(URLS[id]);
    audio.volume = gain;
    void audio.play().catch(() => undefined);
  } catch {
    // ignore
  }
};
