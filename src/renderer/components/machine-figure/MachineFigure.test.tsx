import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MachineFigureState } from "@shared/machine-figure";

vi.mock("../../lib/theme-mode", async () => {
  const { observable } = await import("@legendapp/state");
  return { themeMode$: observable<"dark" | "bright">("dark") };
});

const { MachineFigure, machineFigureSrc } = await import("./MachineFigure");

const machine = { name: "mac-mini", label: "Mac mini", form: "mac-mini", isThisMachine: false } as const;
const state: MachineFigureState = { reach: "reachable", install: "idle", missingHarness: false, missingSecrets: 0, seats: 2 };

describe("MachineFigure", () => {
  it("renders one cached image named by the machine's label", () => {
    const html = renderToStaticMarkup(<MachineFigure machine={machine} state={state} size={28} />);
    expect(html.match(/<img/g)?.length).toBe(1);
    expect(html).toContain('alt="Mac mini"');
    expect(html).not.toMatch(/<canvas|<svg/);
    const request = { ...machine, state, mode: "dark", detail: "glyph", frame: "bare", turn: 0 } as const;
    expect(machineFigureSrc(request)).toBe(machineFigureSrc(request));
    expect(html).toContain(machineFigureSrc(request).slice(0, 80));
  });

  it("paints a pinned theme, and state changes the drawing", () => {
    const dark = renderToStaticMarkup(<MachineFigure machine={machine} state={state} size={96} />);
    const bright = renderToStaticMarkup(<MachineFigure machine={machine} state={state} size={96} theme="bright" />);
    const asleep = renderToStaticMarkup(<MachineFigure machine={machine} state={{ ...state, reach: "unreachable" }} size={96} />);
    expect(new Set([dark, bright, asleep]).size).toBe(3);
  });
});
