// @vitest-environment jsdom
/**
 * The seat's drawing reads the theme, the camera tier and saved portraits
 * through seat-view-source.tsx. The app feeds it from the live stores at its
 * root; without that provider a seat silently draws fixed defaults, so this
 * test fails if the root loses it, and checks the live feed really moves a
 * mounted seat.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LiveSeatViewSource } from "../src/renderer/components/LiveSeatViewSource";
import { AgentSeatView } from "../src/renderer/components/nodes/AgentSeatView";
import { terminalActivity } from "../src/renderer/lib/activity";
import { canvasTier$ } from "../src/renderer/lib/canvas-tier";
import { themeMode$ } from "../src/renderer/lib/theme-mode";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  themeMode$.set("dark");
  canvasTier$.set("near");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  themeMode$.set("dark");
  canvasTier$.set("near");
});

const seat = (
  <AgentSeatView
    identity="seat-view-source"
    activity={terminalActivity({ seatState: "working" })}
    title="planner"
    harness="claude"
    health={{}}
    signal={{ openCount: 0 }}
  />
);

const face = (): string | null => host.querySelector<HTMLImageElement>("img.agent-portrait__face:not(.agent-portrait__face--prev)")?.getAttribute("src") ?? null;
const ringPart = (): Element | null => host.querySelector("[data-part]");

describe("seat view source", () => {
  it("under the live source, a mounted seat follows the theme and the camera tier", () => {
    act(() => root.render(<LiveSeatViewSource>{seat}</LiveSeatViewSource>));
    const darkFace = face();
    const nearPart = ringPart();
    expect(darkFace).toBeTruthy();
    expect(nearPart).toBeTruthy();

    act(() => themeMode$.set("bright"));
    expect(face()).not.toBe(darkFace);

    // The ring's parts are made anew at each tier (ActivityMark keys them on it).
    act(() => canvasTier$.set("far"));
    expect(ringPart()).toBeTruthy();
    expect(ringPart()).not.toBe(nearPart);
  });

  it("with no provider, a seat draws fixed defaults and ignores the stores", () => {
    act(() => root.render(seat));
    const darkFace = face();
    const part = ringPart();
    act(() => {
      themeMode$.set("bright");
      canvasTier$.set("far");
    });
    expect(face()).toBe(darkFace);
    expect(ringPart()).toBe(part);
  });

  it("the app's root mounts every seat under the live source", () => {
    const main = readFileSync(resolve(__dirname, "../src/renderer/main.tsx"), "utf8");
    expect(main).toMatch(/<LiveSeatViewSource>\s*<AppRoot \/>\s*<\/LiveSeatViewSource>/);
  });
});
