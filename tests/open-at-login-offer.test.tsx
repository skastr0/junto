/**
 * The Open at Login offer after the first phone pairs.
 *
 * Pins when the pairing view asks (first phone, settings hydrated, never asked,
 * login item really off on macOS), that only a yes touches the login item and
 * only a yes that stuck or a no records the question as asked, and that the
 * asked flag round-trips through a settings patch and the stored row.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { Result } from "effect";
import { describe, expect, it, vi } from "vitest";
import { SETTINGS_VERSION, defaultSettings } from "@shared/settings";
import type { LoginItemOpResult } from "@shared/ipc";
import { answerOpenAtLogin, openAtLoginOfferVisible } from "../src/renderer/lib/open-at-login-offer";
import { OpenAtLoginOffer } from "../src/renderer/components/settings/CompanionSettingsSection";
import { applyAndValidatePatch } from "../src/main/junto/settings/patch";
import { decodeStoredSettings, preferencesFromSettings } from "../src/main/junto/settings/state-schema";

const off: LoginItemOpResult = {
  ok: true,
  provider: "apple-login-items",
  state: { openAtLogin: false, openAsHidden: false, wasOpenedAtLogin: false, wasOpenedAsHidden: false },
};
const on: LoginItemOpResult = { ...off, state: { ...off.state!, openAtLogin: true } };
const base = { firstPhone: true, settingsReady: true, offered: undefined, loginItem: off } as const;

describe("when the pairing view asks", () => {
  it("asks after the first phone, with the login item off and the question never asked", () => {
    expect(openAtLoginOfferVisible(base)).toBe(true);
  });

  it.each([
    ["a second phone", { firstPhone: false }],
    ["settings not hydrated yet", { settingsReady: false }],
    ["already asked", { offered: true }],
    ["the login item already on", { loginItem: on }],
    ["the OS read failed", { loginItem: { ok: false, provider: "apple-login-items", message: "no" } }],
    ["not macOS", { loginItem: { ok: false, provider: "unsupported", message: "no" } }],
    ["no OS answer", { loginItem: undefined }],
  ] as const)("does not ask for %s", (_label, change) => {
    expect(openAtLoginOfferVisible({ ...base, ...change })).toBe(false);
  });
});

describe("answering", () => {
  it("yes turns the login item on and records the question", async () => {
    const loginItemSet = vi.fn(async () => on);
    const markOffered = vi.fn(async () => true);
    expect(await answerOpenAtLogin(true, { loginItemSet, markOffered })).toEqual({ ok: true, openAtLogin: true });
    expect(loginItemSet).toHaveBeenCalledWith(true);
    expect(markOffered).toHaveBeenCalledTimes(1);
  });

  it("no records the question and never touches the login item", async () => {
    const loginItemSet = vi.fn(async () => on);
    const markOffered = vi.fn(async () => true);
    expect(await answerOpenAtLogin(false, { loginItemSet, markOffered })).toEqual({ ok: true, openAtLogin: false });
    expect(loginItemSet).not.toHaveBeenCalled();
    expect(markOffered).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["the OS refused", async (): Promise<LoginItemOpResult> => ({ ok: false, provider: "apple-login-items", message: "denied" })],
    ["the OS still reports off", async (): Promise<LoginItemOpResult> => off],
    ["the call threw", async (): Promise<LoginItemOpResult> => Promise.reject(new Error("gone"))],
  ])("a yes that did not stick leaves the question unasked: %s", async (_label, loginItemSet) => {
    const markOffered = vi.fn(async () => true);
    const answer = await answerOpenAtLogin(true, { loginItemSet, markOffered });
    expect(answer.ok).toBe(false);
    expect(markOffered).not.toHaveBeenCalled();
  });
});

describe("the offer", () => {
  it("asks a question with both answers and changes nothing on render", () => {
    const html = renderToStaticMarkup(<OpenAtLoginOffer onAnswered={() => undefined} />);
    expect(html).toContain("Open Junto when you log in?");
    expect(html).toContain("Open at login");
    expect(html).toContain("not now");
    expect(html).not.toContain("·");
  });
});

describe("the asked flag in the settings row", () => {
  it("decodes a row written before the offer existed as not asked", () => {
    const settings = defaultSettings();
    const stored = JSON.parse(JSON.stringify(preferencesFromSettings(settings)));
    expect(decodeStoredSettings(SETTINGS_VERSION, stored, settings.machine).advanced.openAtLoginOffered).toBeUndefined();
  });

  it("round-trips through a settings patch and the stored row", () => {
    const patched = applyAndValidatePatch(defaultSettings(), { advanced: { openAtLoginOffered: true } });
    expect(Result.isSuccess(patched)).toBe(true);
    const next = Result.getOrThrow(patched);
    expect(next.advanced.openAtLoginOffered).toBe(true);
    const stored = JSON.parse(JSON.stringify(preferencesFromSettings(next)));
    expect(decodeStoredSettings(SETTINGS_VERSION, stored, next.machine).advanced.openAtLoginOffered).toBe(true);
  });
});
