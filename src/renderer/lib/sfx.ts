/**
 * RTS UI SFX — static pack player.
 *
 * Offline assets only (no fal at runtime). Mute is session-local until a
 * settings section earns a home.
 */

import blockedUrl from "../assets/sfx/blocked.mp3?url";
import boothReviewUrl from "../assets/sfx/booth-review.mp3?url";
import cycleUrl from "../assets/sfx/cycle.mp3?url";
import herdrDoneUrl from "../assets/sfx/herdr-done.mp3?url";
import orphanUrl from "../assets/sfx/orphan.mp3?url";
import permissionUrl from "../assets/sfx/permission.mp3?url";

export const ALERT_SFX_IDS = [
  "blocked",
  "permission",
  "herdr-done",
  "booth-review",
  "orphan",
  "cycle",
] as const;

export type AlertSfxId = (typeof ALERT_SFX_IDS)[number];

const URLS: Readonly<Record<AlertSfxId, string>> = {
  blocked: blockedUrl,
  permission: permissionUrl,
  "herdr-done": herdrDoneUrl,
  "booth-review": boothReviewUrl,
  orphan: orphanUrl,
  cycle: cycleUrl,
};

const MUTE_KEY = "vellum.sfx.muted";

let muted = readInitialMute();
let volume = 0.55;

const isAlertSfxId = (value: string): value is AlertSfxId =>
  (ALERT_SFX_IDS as ReadonlyArray<string>).includes(value);

function readInitialMute(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(MUTE_KEY) === "1";
  } catch {
    return false;
  }
}

export const isSfxMuted = (): boolean => muted;

export const setSfxMuted = (next: boolean): void => {
  muted = next;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(MUTE_KEY, next ? "1" : "0");
    }
  } catch {
    // session-only if storage is blocked
  }
};

export const toggleSfxMuted = (): boolean => {
  setSfxMuted(!muted);
  return muted;
};

/** 0..1 master volume for UI alerts. */
export const setSfxVolume = (next: number): void => {
  volume = Math.min(1, Math.max(0, next));
};

export const getSfxVolume = (): number => volume;

export const sfxUrl = (id: AlertSfxId): string => URLS[id];

/**
 * Play a catalog alert. Fail-open: missing Audio, autoplay block, or bad id
 * never throws into the attention path.
 */
export const playAlert = (id: AlertSfxId | string): void => {
  if (!isAlertSfxId(id)) return;
  if (muted) return;
  if (typeof Audio === "undefined") return;
  try {
    const audio = new Audio(URLS[id]);
    audio.volume = volume;
    void audio.play().catch(() => undefined);
  } catch {
    // ignore
  }
};
