import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAudio, defaultSettings } from "@shared/settings";
import {
  ALERT_SFX_IDS,
  playAlert,
  resetSfxRuntimeForTests,
  resolveSfxGain,
  sfxIdToClipKey,
  sfxUrl,
} from "@renderer/lib/sfx";
import { state$ } from "@renderer/lib/state";

type FakeSource = {
  buffer: AudioBuffer | null;
  connect: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
};

const installWebAudioMocks = () => {
  const sources: FakeSource[] = [];
  const decodeAudioData = vi.fn(async () => ({ duration: 0.1 }) as AudioBuffer);
  const createBufferSource = vi.fn(() => {
    const source: FakeSource = {
      buffer: null,
      connect: vi.fn(),
      start: vi.fn(),
    };
    sources.push(source);
    return source;
  });
  const createGain = vi.fn(() => ({
    gain: { value: 1 },
    connect: vi.fn(),
  }));
  const resume = vi.fn(async () => undefined);
  const ctx = {
    state: "running" as AudioContextState,
    destination: {},
    resume,
    decodeAudioData,
    createBufferSource,
    createGain,
  };

  vi.stubGlobal(
    "AudioContext",
    vi.fn(function AudioContext(this: unknown) {
      return ctx;
    }),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    })),
  );

  // Guard: HTMLAudioElement must not be used for UI sfx (macOS MediaPlayer TCC).
  const htmlAudio = vi.fn();
  vi.stubGlobal(
    "Audio",
    class {
      constructor() {
        htmlAudio();
      }
      play() {
        return Promise.resolve();
      }
      set volume(_v: number) {}
    },
  );

  return { sources, decodeAudioData, createBufferSource, htmlAudio, resume, ctx };
};

describe("sfx catalog", () => {
  afterEach(() => {
    resetSfxRuntimeForTests();
    state$.settings.set(defaultSettings());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("exposes alert ids with resolvable urls", () => {
    expect(ALERT_SFX_IDS).toHaveLength(5);
    for (const id of ALERT_SFX_IDS) {
      expect(sfxUrl(id)).toMatch(/\.mp3/);
      expect(sfxIdToClipKey(id)).toBeTruthy();
    }
  });

  it("master mute skips Web Audio work and never touches HTMLAudioElement", async () => {
    const { createBufferSource, htmlAudio } = installWebAudioMocks();
    state$.settings.audio.set({ ...defaultAudio(), muted: true });
    playAlert("blocked");
    await vi.waitFor(() => {
      expect(createBufferSource).not.toHaveBeenCalled();
    });
    expect(htmlAudio).not.toHaveBeenCalled();
  });

  it("per-clip disable skips playback", async () => {
    const { createBufferSource, htmlAudio } = installWebAudioMocks();
    const audio = defaultAudio();
    state$.settings.audio.set({
      ...audio,
      clips: { ...audio.clips, cycle: { enabled: false, volume: 0.5 } },
    });
    playAlert("cycle");
    await Promise.resolve();
    expect(createBufferSource).not.toHaveBeenCalled();
    playAlert("blocked");
    await vi.waitFor(() => {
      expect(createBufferSource).toHaveBeenCalledTimes(1);
    });
    expect(htmlAudio).not.toHaveBeenCalled();
  });

  it("plays via AudioBufferSourceNode, not HTMLAudioElement", async () => {
    const { sources, createBufferSource, htmlAudio, decodeAudioData } = installWebAudioMocks();
    playAlert("blocked");
    await vi.waitFor(() => {
      expect(createBufferSource).toHaveBeenCalledTimes(1);
    });
    expect(decodeAudioData).toHaveBeenCalled();
    expect(sources[0]?.start).toHaveBeenCalledWith(0);
    expect(htmlAudio).not.toHaveBeenCalled();
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

  it("ignores unknown ids", async () => {
    const { createBufferSource, htmlAudio } = installWebAudioMocks();
    playAlert("not-a-real-id");
    await Promise.resolve();
    expect(createBufferSource).not.toHaveBeenCalled();
    expect(htmlAudio).not.toHaveBeenCalled();
  });
});
