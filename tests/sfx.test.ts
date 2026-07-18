import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALERT_SFX_IDS,
  getSfxVolume,
  isSfxMuted,
  playAlert,
  setSfxMuted,
  setSfxVolume,
  sfxUrl,
  toggleSfxMuted,
} from "@renderer/lib/sfx";

describe("sfx catalog", () => {
  afterEach(() => {
    setSfxMuted(false);
    setSfxVolume(0.55);
    vi.restoreAllMocks();
  });

  it("exposes six alert ids with resolvable urls", () => {
    expect(ALERT_SFX_IDS).toHaveLength(6);
    for (const id of ALERT_SFX_IDS) {
      expect(sfxUrl(id)).toMatch(/\.mp3/);
    }
  });

  it("mutes without throwing and skips Audio construction", () => {
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
    setSfxMuted(true);
    expect(isSfxMuted()).toBe(true);
    playAlert("blocked");
    expect(audioSpy).not.toHaveBeenCalled();
    toggleSfxMuted();
    expect(isSfxMuted()).toBe(false);
    playAlert("blocked");
    expect(audioSpy).toHaveBeenCalledTimes(1);
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

  it("clamps volume", () => {
    setSfxVolume(2);
    expect(getSfxVolume()).toBe(1);
    setSfxVolume(-1);
    expect(getSfxVolume()).toBe(0);
  });
});
