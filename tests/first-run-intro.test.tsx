/**
 * First-run introduction.
 *
 * Pins when the tour appears (once, only after the durable settings row
 * hydrates, and again only on request), that finishing it writes the seen flag
 * through the settings path, that the play slide says a new workspace starts
 * paused and where the switch is, and that the permission slide says plainly
 * why macOS may name Junto.
 */
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { Result } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS_VERSION, defaultSettings, type Settings, type SettingsPatch } from "@shared/settings";

vi.mock("../src/renderer/components/FocusSurface", () => ({
  FocusSurface: ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
    <div role="dialog" aria-label={label}>{children}</div>
  ),
}));

import {
  FirstRunIntro,
  FirstRunIntroSurface,
  tourChapters,
} from "../src/renderer/components/onboarding/FirstRunIntro";
import { finishIntro, introVisible, openIntro } from "../src/renderer/lib/first-run-intro";
import { SEAT_AWARENESS_COMPILED } from "../src/shared/features";
import { state$ } from "../src/renderer/lib/state";
import { applyAndValidatePatch } from "../src/main/junto/settings/patch";
import { decodeStoredSettings, preferencesFromSettings } from "../src/main/junto/settings/state-schema";

const text = (html: string): string =>
  html.replace(/<[^>]+>/gu, " ").replace(/&amp;/gu, "&").replace(/&#x27;|&#39;/gu, "'").replace(/\s+/gu, " ").trim();

const withSeen = (seen: boolean | undefined): Settings => {
  const base = defaultSettings();
  const { onboardingSeen: _drop, ...advanced } = base.advanced;
  return { ...base, advanced: seen === undefined ? advanced : { ...advanced, onboardingSeen: seen } };
};

const resetIntroState = (): void => {
  state$.settings.set(defaultSettings());
  state$.settingsReady.set(false);
  state$.introOpen.set(false);
  state$.introDismissed.set(false);
};

beforeEach(resetIntroState);
afterEach(() => {
  resetIntroState();
  vi.unstubAllGlobals();
});

describe("when the introduction shows", () => {
  it("waits for the durable settings row, then shows once while unseen", () => {
    expect(introVisible({ settingsReady: false, seen: undefined, requested: false, dismissed: false })).toBe(false);
    expect(introVisible({ settingsReady: true, seen: undefined, requested: false, dismissed: false })).toBe(true);
    expect(introVisible({ settingsReady: true, seen: false, requested: false, dismissed: false })).toBe(true);
    expect(introVisible({ settingsReady: true, seen: true, requested: false, dismissed: false })).toBe(false);
  });

  it("never reopens on its own in a session where it was finished", () => {
    expect(introVisible({ settingsReady: true, seen: undefined, requested: false, dismissed: true })).toBe(false);
  });

  it("reopens on request even after it was seen", () => {
    expect(introVisible({ settingsReady: true, seen: true, requested: true, dismissed: true })).toBe(true);
  });

  it("renders nothing before settings hydrate, and the tour once they say unseen", () => {
    state$.settings.set(withSeen(undefined));
    expect(renderToStaticMarkup(<FirstRunIntro />)).toBe("");
    state$.settingsReady.set(true);
    expect(renderToStaticMarkup(<FirstRunIntro />)).toContain('aria-label="Welcome to Junto"');
    state$.settings.set(withSeen(true));
    expect(renderToStaticMarkup(<FirstRunIntro />)).toBe("");
    openIntro();
    expect(renderToStaticMarkup(<FirstRunIntro />)).toContain('aria-label="Welcome to Junto"');
  });
});

describe("finishing the introduction", () => {
  it("closes at once and writes the seen flag through settings", async () => {
    const patches: SettingsPatch[] = [];
    vi.stubGlobal("window", {
      junto: {
        settingsPatch: async (patch: SettingsPatch) => {
          patches.push(patch);
          return { ok: true, settings: withSeen(true) };
        },
      },
    });
    state$.settingsReady.set(true);
    openIntro();
    const done = finishIntro();
    expect(state$.introOpen.peek()).toBe(false);
    expect(state$.introDismissed.peek()).toBe(true);
    await done;
    expect(patches).toEqual([{ advanced: { onboardingSeen: true } }]);
    expect(state$.settings.peek().advanced.onboardingSeen).toBe(true);
  });

  it("does not rewrite the flag when a replay finishes", async () => {
    const settingsPatch = vi.fn();
    vi.stubGlobal("window", { junto: { settingsPatch } });
    state$.settings.set(withSeen(true));
    openIntro();
    await finishIntro();
    expect(settingsPatch).not.toHaveBeenCalled();
    expect(state$.introOpen.peek()).toBe(false);
  });
});

describe("the seen flag in the settings row", () => {
  it("decodes a row written before the introduction existed as unseen", () => {
    const stored = preferencesFromSettings(withSeen(undefined));
    const settings = decodeStoredSettings(SETTINGS_VERSION, JSON.parse(JSON.stringify(stored)), defaultSettings().station);
    expect(settings.advanced.onboardingSeen).toBeUndefined();
  });

  it("round-trips through a settings patch and the stored row", () => {
    const patched = applyAndValidatePatch(withSeen(undefined), { advanced: { onboardingSeen: true } });
    expect(Result.isSuccess(patched)).toBe(true);
    const next = Result.getOrThrow(patched);
    expect(next.advanced.onboardingSeen).toBe(true);
    const stored = JSON.parse(JSON.stringify(preferencesFromSettings(next)));
    expect(decodeStoredSettings(SETTINGS_VERSION, stored, next.station).advanced.onboardingSeen).toBe(true);
  });
});

/** Render the tour open at a chapter, by id. */
const chapterAt = (id: string, mac = true): string => {
  const index = tourChapters(mac).findIndex((c) => c.id === id);
  expect(index).toBeGreaterThanOrEqual(0);
  return renderToStaticMarkup(<FirstRunIntroSurface onDone={() => {}} mac={mac} initialStep={index} />);
};

describe("what the tour says", () => {
  it("opens on the seats, ends on permissions, and offers a way out on every chapter", () => {
    const chapters = tourChapters(true);
    expect(chapters[0]!.id).toBe("seats");
    expect(chapters.at(-1)!.id).toBe("permissions");
    for (let step = 0; step < chapters.length; step += 1) {
      const html = renderToStaticMarkup(<FirstRunIntroSurface onDone={() => {}} mac initialStep={step} />);
      expect(html).toContain('data-testid="first-run-intro-skip"');
      expect(html).toContain(`${step + 1} of ${chapters.length}: ${chapters[step]!.title}`);
    }
  });

  it("introduces seats with live seats, their characters, and how to start one", () => {
    const html = chapterAt("seats");
    const copy = text(html);
    expect(copy).toContain("Junto is a canvas for running coding agents side by side");
    expect(copy).toContain("project folder");
    expect(copy).toContain("Add item");
    // The demo is the canvas's own seat and the real customize editor.
    expect(html).toContain('data-testid="agent-seat"');
    expect(html).toContain('class="agent-editor"');
  });

  it("shows every ring state live, done until read, and the AI reading only when built in", () => {
    const html = chapterAt("states");
    const copy = text(html);
    for (const state of ["working", "wants your input", "waiting on you", "blocked", "resting", "ready for review", "offline"]) {
      expect(copy).toContain(state);
    }
    expect(copy).toContain("until you open the seat and read the answer");
    expect(html.match(/data-testid="agent-seat"/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
    // The AI reading shows exactly when the build carries it, marked experimental.
    expect(copy.includes("Experimental")).toBe(SEAT_AWARENESS_COMPILED);
  });

  it("says a new workspace starts paused, what play does, and where the switch is", () => {
    const copy = text(chapterAt("play"));
    expect(copy).toContain("A new workspace starts paused");
    expect(copy).toContain("it opens playing every time");
    expect(copy).toContain("the paused button at the top right of the window");
    expect(copy).toContain("Play canvas");
  });

  it("tells a Mac user plainly that macOS may name Junto, and that they choose", () => {
    const html = chapterAt("permissions");
    const copy = text(html);
    expect(copy).toContain("run with your permissions");
    expect(copy).toContain("the prompt names Junto because Junto started the agent");
    expect(copy).toContain("Allow or deny each one");
    expect(copy).toContain("Privacy & Security");
    expect(html).toContain('data-testid="first-run-intro-done"');
  });

  it("keeps macOS prompts out of the tour on other platforms", () => {
    const copy = text(chapterAt("permissions", false));
    expect(copy).toContain("run with your permissions");
    expect(copy).not.toContain("macOS");
  });

  it("obeys the copy law", () => {
    for (const mac of [true, false]) {
      for (let step = 0; step < tourChapters(mac).length; step += 1) {
        const html = renderToStaticMarkup(<FirstRunIntroSurface onDone={() => {}} mac={mac} initialStep={step} />);
        expect(html).not.toContain("·");
      }
    }
  });
});
