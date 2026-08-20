/**
 * Chrome CSS must not keep Chromium presenting at display refresh.
 * Decorative pulses are static; loading spinners pause under the
 * surface-motion gate.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readCss = (rel: string): string =>
  readFileSync(resolve(__dirname, rel), "utf8");

const rts = readCss("../src/renderer/components/rts/RtsBottomBar.css");
const hud = readCss("../src/renderer/components/UsageHud.css");
const license = readCss("../src/renderer/components/license/license.css");
const media = readCss("../src/renderer/components/work/content-media.css");
const chat = readCss("../src/renderer/components/chat/chat.css");

describe("chrome infinite CSS freeze", () => {
  it("notify / shimmer / breathe have no interpolating infinite animation", () => {
    expect(rts).not.toMatch(/infinite/);
    expect(rts).not.toMatch(/@keyframes\s+rts-notify-attention-pulse\b/);
    expect(rts).not.toMatch(/@keyframes\s+rts-notify-blocked-pulse\b/);
    expect(rts).toMatch(
      /\.rts-notify-attention__pill\s*\{[^}]*box-shadow:[^}]*\}/s,
    );

    expect(hud).not.toMatch(/infinite/);
    expect(hud).not.toMatch(/@keyframes\s+usage-hud-shimmer\b/);
    expect(hud).not.toMatch(/animation\s*:/);

    expect(license).not.toMatch(/infinite/);
    expect(license).not.toMatch(/@keyframes\s+license-mark-breathe\b/);
    expect(license).not.toMatch(
      /\.license-gate--amber\s+\.license-gate__mark\s*\{[^}]*animation\s*:/s,
    );
  });

  it("loading spinners still spin, and pause under data-surface-motion", () => {
    expect(media).toMatch(
      /animation:\s*content-media-spin\s+[\d.]+s\s+linear\s+infinite/,
    );
    expect(media).toMatch(
      /html\[data-surface-motion="paused"\][^{]*\{[^}]*animation:\s*none\s*!important/s,
    );

    expect(chat).toMatch(
      /animation:\s*chat-spin\s+[\d.]+s\s+linear\s+infinite/,
    );
    expect(chat).toMatch(
      /html\[data-surface-motion="paused"\][^{]*\{[^}]*animation:\s*none\s*!important/s,
    );
  });

  it("does not add will-change", () => {
    for (const css of [rts, hud, license, media, chat]) {
      expect(css).not.toMatch(/will-change\s*:/);
    }
  });
});
