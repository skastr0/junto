import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAudio, defaultSettings } from "@shared/settings";
import {
  ALERT_SFX_IDS,
  playAlert,
  resolveSfxGain,
  sfxIdToClipKey,
  sfxUrl,
} from "@renderer/lib/sfx";
import { state$ } from "@renderer/lib/state";

describe("sfx catalog", () => {
  afterEach(() => {
    state$.settings.set(defaultSettings());
    vi.restoreAllMocks();
  });

  it("exposes six alert ids with resolvable urls", () => {
    expect(ALERT_SFX_IDS).toHaveLength(6);
    for (const id of ALERT_SFX_IDS) {
      expect(sfxUrl(id)).toMatch(/\.mp3/);
      expect(sfxIdToClipKey(id)).toBeTruthy();
    }
  });

  it("master mute skips Audio construction", () => {
    const audioSpy = vi.fn();
    vi.stubGlobal(
      "Audio",
      class {
        constructor() {
          audioSpy();
        }
        play() {
          return Promise.resolve();
        }
        set volume(_v: number) {}
      },
    );
    state$.settings.audio.set({ ...defaultAudio(), muted: true });
    playAlert("blocked");
    expect(audioSpy).not.toHaveBeenCalled();
    state$.settings.audio.set(defaultAudio());
    playAlert("blocked");
    expect(audioSpy).toHaveBeenCalledTimes(1);
  });

  it("per-clip disable skips Audio", () => {
    const audioSpy = vi.fn();
    vi.stubGlobal(
      "Audio",
      class {
        constructor() {
          audioSpy();
        }
        play() {
          return Promise.resolve();
        }
        set volume(_v: number) {}
      },
    );
    const audio = defaultAudio();
    state$.settings.audio.set({
      ...audio,
      clips: { ...audio.clips, cycle: { enabled: false, volume: 0.5 } },
    });
    playAlert("cycle");
    expect(audioSpy).not.toHaveBeenCalled();
    playAlert("blocked");
    expect(audioSpy).toHaveBeenCalledTimes(1);
  });

  it("resolveSfxGain multiplies master × clip", () => {
    const audio = defaultAudio();
    const next = {
      ...audio,
      masterVolume: 0.5,
      clips: { ...audio.clips, cycle: { enabled: true, volume: 0.2 } },
    };
    expect(resolveSfxGain("cycle", next)).toBeCloseTo(0.1, 5);
    expect(resolveSfxGain("cycle", { ...next, muted: true })).toBeNull();
  });

  it("ignores unknown ids", () => {
    const audioSpy = vi.fn();
    vi.stubGlobal(
      "Audio",
      class {
        constructor() {
          audioSpy();
        }
        play() {
          return Promise.resolve();
        }
        set volume(_v: number) {}
      },
    );
    playAlert("not-a-real-id");
    expect(audioSpy).not.toHaveBeenCalled();
  });
});
