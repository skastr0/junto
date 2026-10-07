/**
 * Settings → Terminal surface.
 *
 * Two things are worth pinning here. The rows must render from the durable
 * settings row (including an installation written before the terminal fragment
 * existed, where the key is simply absent), and the numeric commit rule must
 * never turn half-typed text into a write.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import {
  TERMINAL_BOUNDS,
  defaultSettings,
  defaultTerminal,
  type Settings,
} from "@shared/settings";
import {
  TerminalSettingsSection,
  nextNumericValue,
} from "../src/renderer/components/settings/TerminalSettingsSection";
import { state$ } from "../src/renderer/lib/state";

const render = (settings: Settings): string => {
  state$.settings.set(settings);
  return renderToStaticMarkup(<TerminalSettingsSection />);
};

/** Reads the attributes of the one input carrying this aria-label. */
const inputFor = (html: string, ariaLabel: string): string => {
  const match = html.match(
    new RegExp(`<input[^>]*aria-label="${ariaLabel}"[^>]*>`, "u"),
  );
  expect(match, `no input labelled ${ariaLabel}`).not.toBeNull();
  return match![0];
};

/** Reads the label the dropdown trigger is showing for the current value. */
const selectLabel = (html: string, ariaLabel: string): string => {
  const match = html.match(
    new RegExp(
      `<button[^>]*aria-label="${ariaLabel}"[^>]*>\\s*<span[^>]*>([^<]*)</span>`,
      "u",
    ),
  );
  expect(match, `no select labelled ${ariaLabel}`).not.toBeNull();
  return match![1]!;
};

afterEach(() => {
  state$.settings.set(defaultSettings());
});

describe("numeric commit rule", () => {
  it("refuses text that is not yet a number", () => {
    for (const raw of ["", "   ", "-", "1.e", "abc", "--2"]) {
      expect(nextNumericValue(raw, TERMINAL_BOUNDS.fontSize, "integer")).toBe(
        undefined,
      );
    }
  });

  it("keeps a partially typed decimal usable", () => {
    expect(nextNumericValue("1.", TERMINAL_BOUNDS.lineHeight, "fractional")).toBe(1);
  });

  it("clamps to the schema bounds instead of writing a rejected patch", () => {
    expect(nextNumericValue("2000", TERMINAL_BOUNDS.fontSize, "integer")).toBe(
      TERMINAL_BOUNDS.fontSize.max,
    );
    expect(nextNumericValue("0", TERMINAL_BOUNDS.scrollback, "integer")).toBe(
      TERMINAL_BOUNDS.scrollback.min,
    );
    expect(
      nextNumericValue("-4", TERMINAL_BOUNDS.letterSpacing, "fractional"),
    ).toBe(TERMINAL_BOUNDS.letterSpacing.min);
  });

  it("rounds integer rows whole and fractional rows to two places", () => {
    expect(nextNumericValue("13.6", TERMINAL_BOUNDS.fontSize, "integer")).toBe(14);
    expect(
      nextNumericValue("1.20000000000004", TERMINAL_BOUNDS.lineHeight, "fractional"),
    ).toBe(1.2);
    expect(
      nextNumericValue("4.5", TERMINAL_BOUNDS.minimumContrastRatio, "fractional"),
    ).toBe(4.5);
  });
});

describe("terminal settings section", () => {
  it("renders each preference from the durable value", () => {
    const html = render({
      ...defaultSettings(),
      terminal: {
        ...defaultTerminal(),
        scrollSensitivity: 8,
        fontSize: 15,
        fontFamily: "Berkeley Mono, monospace",
        cursorStyle: "bar",
        scrollback: 20_000,
        cursorBlink: false,
        minimumContrastRatio: 4.5,
        lineHeight: 1.35,
        letterSpacing: 0.5,
        screenReaderMode: true,
        bell: "visual",
        copyOnSelect: true,
      },
    });

    expect(inputFor(html, "Scroll sensitivity")).toContain('value="8"');
    expect(inputFor(html, "Font size")).toContain('value="15"');
    expect(inputFor(html, "Font family")).toContain(
      'value="Berkeley Mono, monospace"',
    );
    expect(inputFor(html, "Scrollback")).toContain('value="20000"');
    expect(inputFor(html, "Cursor blink")).toContain('aria-checked="false"');
    expect(inputFor(html, "Minimum contrast")).toContain('value="4.5"');
    expect(inputFor(html, "Line height")).toContain('value="1.35"');
    expect(inputFor(html, "Letter spacing")).toContain('value="0.5"');
    expect(inputFor(html, "Screen reader mode")).toContain('aria-checked="true"');
    expect(inputFor(html, "Copy selection automatically")).toContain('aria-checked="true"');
    // Selects are the design-system dropdown: labelled trigger, selected label.
    expect(selectLabel(html, "Cursor style")).toBe("Bar");
    expect(selectLabel(html, "Bell")).toBe("Flash the terminal");
  });

  it("resolves an installation written before the terminal fragment", () => {
    const { terminal: _absent, ...withoutTerminal } = defaultSettings();
    const html = render(withoutTerminal);

    expect(inputFor(html, "Scroll sensitivity")).toContain(
      `value="${defaultTerminal().scrollSensitivity}"`,
    );
    expect(inputFor(html, "Font size")).toContain(
      `value="${defaultTerminal().fontSize}"`,
    );
    expect(inputFor(html, "Cursor blink")).toContain('aria-checked="true"');
  });

  it("bounds every numeric control by the schema, not by a second copy", () => {
    const html = render(defaultSettings());
    const bounded = [
      ["Scroll sensitivity", TERMINAL_BOUNDS.scrollSensitivity],
      ["Font size", TERMINAL_BOUNDS.fontSize],
      ["Scrollback", TERMINAL_BOUNDS.scrollback],
      ["Minimum contrast", TERMINAL_BOUNDS.minimumContrastRatio],
      ["Line height", TERMINAL_BOUNDS.lineHeight],
      ["Letter spacing", TERMINAL_BOUNDS.letterSpacing],
    ] as const;

    for (const [label, bounds] of bounded) {
      const input = inputFor(html, label);
      expect(input, label).toContain(`min="${bounds.min}"`);
      expect(input, label).toContain(`max="${bounds.max}"`);
    }
    expect(inputFor(html, "Font family")).toContain(
      `maxLength="${TERMINAL_BOUNDS.fontFamily.maxLength}"`,
    );
  });

  it("sorts the rows into titled groups, each a labelled section", () => {
    const html = render(defaultSettings());
    const titles = ["Text", "Cursor", "Scrolling and copying", "Bell and screen reader"];
    const at = titles.map((title) => html.indexOf(`>${title}</h3>`));

    for (const [index, position] of at.entries()) expect(position, titles[index]).toBeGreaterThan(-1);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(html.match(/<section class="settings-group" aria-labelledby=/g)).toHaveLength(titles.length);
    // A row sits under its own title.
    expect(html.indexOf('aria-label="Font size"')).toBeLessThan(at[1]!);
    expect(html.indexOf('aria-label="Cursor blink"')).toBeGreaterThan(at[1]!);
    expect(html.indexOf('aria-label="Scrollback"')).toBeGreaterThan(at[2]!);
    expect(html.indexOf('aria-label="Screen reader mode"')).toBeGreaterThan(at[3]!);
  });

  it("labels every control", () => {
    const html = render(defaultSettings());
    for (const label of [
      "Scroll sensitivity",
      "Font size",
      "Font family",
      "Cursor style",
      "Scrollback",
      "Cursor blink",
      "Minimum contrast",
      "Line height",
      "Letter spacing",
      "Screen reader mode",
      "Bell",
    ]) {
      expect(html, label).toContain(`aria-label="${label}"`);
    }
  });
});

describe("settings panel nav", () => {
  it("carries Terminal as a core section, ungated, wired to the surface", async () => {
    const source = await readFile(
      new URL("../src/renderer/components/SettingsPanel.tsx", import.meta.url),
      "utf8",
    );
    const sections = source.slice(
      source.indexOf("const SECTIONS"),
      source.indexOf("const DEFAULT_SETTINGS_SECTION"),
    );
    const entry = sections
      .split("\n")
      .find((line) => line.includes('key: "terminal"'));

    expect(entry, "no Terminal entry in SECTIONS").toBeDefined();
    expect(entry).not.toContain("...(");
    expect(entry).not.toContain("ENABLED");
    expect(source).toMatch(
      /case "terminal":\s*\n\s*return <TerminalSettingsSection \/>;/u,
    );
  });
});
