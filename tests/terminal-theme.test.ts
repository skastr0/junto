import { describe, expect, it } from "vitest";
import { colorFgBgFor, schemeDsrFor, themeRuntime } from "@shared/theme";
import { xtermThemeFor } from "../src/renderer/lib/terminal-theme";

describe("xtermThemeFor", () => {
  it("projects a complete 16-colour ANSI table from Vellum Command tokens (dark)", () => {
    const t = themeRuntime("dark");
    const theme = xtermThemeFor("dark");
    expect(theme.background).toBe(t.ground);
    expect(theme.foreground).toBe(t.ink);
    expect(theme.cursor).toBe(t["main-fg"]);
    expect(theme.black).toBe(t.well);
    expect(theme.red).toBe(t.crimson);
    expect(theme.green).toBe(t.green);
    expect(theme.yellow).toBe(t.gold);
    expect(theme.blue).toBe(t.indigo);
    expect(theme.magenta).toBe(t.violet);
    expect(theme.cyan).toBe(t.cyan);
    expect(theme.white).toBe(t["ink-2"]);
    expect(theme.brightBlack).toBe(t.faint);
    expect(theme.brightRed).toBe(t["crimson-fg"]);
    expect(theme.brightYellow).toBe(t.amber);
    expect(theme.brightCyan).toBe(t["cyan-fg"]);
    expect(theme.brightWhite).toBe(t.ink);
  });

  it("projects a complete palette for bright mode", () => {
    const t = themeRuntime("bright");
    const theme = xtermThemeFor("bright");
    expect(theme.background).toBe(t.ground);
    expect(theme.foreground).toBe(t.ink);
    expect(theme.red).toBe(t.crimson);
    expect(theme.cyan).toBe(t.cyan);
    // Bright paper ground is light; ink is dark.
    expect(theme.background).not.toBe(xtermThemeFor("dark").background);
    expect(theme.foreground).not.toBe(xtermThemeFor("dark").foreground);
  });

  it("never invents non-token hex — every slot is a themeRuntime value", () => {
    for (const mode of ["dark", "bright"] as const) {
      const tokens = new Set(Object.values(themeRuntime(mode)));
      const theme = xtermThemeFor(mode);
      for (const [key, value] of Object.entries(theme)) {
        if (value === undefined) continue;
        expect(tokens.has(value), `${mode}.${key}=${value}`).toBe(true);
      }
    }
  });
});

describe("COLORFGBG + scheme DSR", () => {
  it("maps dark → 15;0 and bright → 0;15", () => {
    expect(colorFgBgFor("dark")).toBe("15;0");
    expect(colorFgBgFor("bright")).toBe("0;15");
  });

  it("maps dark → ?997;1n and bright → ?997;2n", () => {
    expect(schemeDsrFor("dark")).toBe("\x1b[?997;1n");
    expect(schemeDsrFor("bright")).toBe("\x1b[?997;2n");
  });
});
