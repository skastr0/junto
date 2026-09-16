import { describe, expect, it } from "vitest";
import {
  defaultTerminal,
  terminalSettings,
  type TerminalSettings,
} from "@shared/settings";
import { JUNTO_XTERM_FONT_FAMILY } from "../src/renderer/lib/terminal-theme";
import {
  applyTerminalPreferences,
  bellResponse,
  fallbackCell,
  MANAGED_TERMINAL_OPTIONS,
  managedTerminalOptions,
  METRIC_TERMINAL_OPTIONS,
  scrollbackRepair,
  wheelReportFanout,
  writeManagedTerminalOptions,
  type LiveTerminalTarget,
} from "../src/renderer/components/terminal/TerminalSurface";

/**
 * A terminal that is already open, built from `prefs` exactly the way the
 * surface builds the real one. Everything here is the seam the surface drives:
 * the mutable options bag, the buffer's viewport position, and the scroll call.
 */
const openTerminal = (
  prefs: TerminalSettings,
  surface: {
    readonly visible?: boolean;
    readonly viewportY?: number;
    readonly baseY?: number;
  } = {},
) => {
  const scrollsToBottom: number[] = [];
  const options: LiveTerminalTarget["options"] = {
    ...managedTerminalOptions(prefs, { visible: surface.visible ?? true }),
  };
  const term: LiveTerminalTarget = {
    options,
    buffer: {
      active: {
        viewportY: surface.viewportY ?? 0,
        baseY: surface.baseY ?? 0,
      },
    },
    scrollToBottom: () => {
      scrollsToBottom.push(1);
    },
  };
  return { term, options, scrollsToBottom };
};

/** Apply `next` to an open terminal and record which resize path it took. */
const applyTo = (
  term: LiveTerminalTarget,
  next: TerminalSettings,
  surface: { readonly visible?: boolean } = {},
) => {
  const calls = { refit: 0, refitBurst: 0 };
  const applied = applyTerminalPreferences(next, {
    term,
    visible: surface.visible ?? true,
    refit: () => {
      calls.refit += 1;
    },
    refitBurst: () => {
      calls.refitBurst += 1;
    },
  });
  return { applied, calls };
};

const withPref = <K extends keyof TerminalSettings>(
  base: TerminalSettings,
  key: K,
  value: TerminalSettings[K],
): TerminalSettings => ({ ...base, [key]: value });

describe("managedTerminalOptions", () => {
  it("opens an install that predates the settings fragment on today's terminal", () => {
    // `settings.terminal` is optionalKey, so an installed row written before it
    // existed has no key at all. Absence is "today's terminal", not "no terminal".
    const options = managedTerminalOptions(terminalSettings(undefined), {
      visible: true,
    });

    expect(options).toEqual({
      scrollSensitivity: 3,
      fastScrollSensitivity: 15,
      fontSize: 13,
      fontFamily: JUNTO_XTERM_FONT_FAMILY,
      cursorStyle: "block",
      scrollback: 10_000,
      cursorBlink: true,
      minimumContrastRatio: 4.5,
      lineHeight: 1.2,
      letterSpacing: 0,
      screenReaderMode: false,
    });
  });

  it("drives exactly the options it declares", () => {
    const options = managedTerminalOptions(defaultTerminal(), { visible: true });

    expect(Object.keys(options).sort()).toEqual(
      [...MANAGED_TERMINAL_OPTIONS].sort(),
    );
  });

  it("carries the operator's gesture travel to both wheel speeds", () => {
    const options = managedTerminalOptions(
      withPref(defaultTerminal(), "scrollSensitivity", 8),
      { visible: true },
    );

    expect(options.scrollSensitivity).toBe(8);
    // Alt-held fast scroll stays a fixed multiple of the operator's gesture.
    expect(options.fastScrollSensitivity).toBe(40);
  });

  it("routes every xterm-owned terminal preference into an xterm option", () => {
    const base = defaultTerminal();
    const bumps: Partial<TerminalSettings> = {
      scrollSensitivity: 9,
      fontSize: 18,
      fontFamily: "Iosevka Term, monospace",
      cursorStyle: "bar",
      scrollback: 4_000,
      cursorBlink: false,
      minimumContrastRatio: 7,
      lineHeight: 1.6,
      letterSpacing: 2,
      screenReaderMode: true,
    };

    for (const [key, value] of Object.entries(bumps)) {
      const { term } = openTerminal(base);
      const write = writeManagedTerminalOptions(
        term,
        managedTerminalOptions({ ...base, [key]: value }, { visible: true }),
      );
      expect(write.changed.length, `${key} reached no xterm option`).toBeGreaterThan(0);
    }

    // Bell response and copy-on-select are event policies rather than xterm
    // options. Their focused tests pin those paths separately. A new setting
    // omitted from all three surfaces still fails this count.
    expect(Object.keys(bumps).length).toBe(Object.keys(base).length - 2);
  });
});

describe("cursorBlink gate", () => {
  const blink = (cursorBlink: boolean, visible: boolean): boolean =>
    managedTerminalOptions(withPref(defaultTerminal(), "cursorBlink", cursorBlink), {
      visible,
    }).cursorBlink;

  it("blinks only when the preference allows it and the surface is visible", () => {
    expect(blink(true, true)).toBe(true);
    // Hidden pane: stop forcing repaints, as before the preference existed.
    expect(blink(true, false)).toBe(false);
    // Photosensitivity: off must survive the pane becoming visible.
    expect(blink(false, true)).toBe(false);
    expect(blink(false, false)).toBe(false);
  });

  it("turns a live terminal's blink off the moment the preference does", () => {
    const base = defaultTerminal();
    const { term, options } = openTerminal(base, { visible: true });
    expect(options.cursorBlink).toBe(true);

    applyTo(term, withPref(base, "cursorBlink", false));

    expect(options.cursorBlink).toBe(false);
  });
});

describe("writeManagedTerminalOptions", () => {
  it("writes only what changed", () => {
    const base = defaultTerminal();
    const { term, options } = openTerminal(base);

    const write = writeManagedTerminalOptions(
      term,
      managedTerminalOptions(withPref(base, "cursorStyle", "underline"), {
        visible: true,
      }),
    );

    expect(write.changed).toEqual(["cursorStyle"]);
    expect(options.cursorStyle).toBe("underline");
    expect(options.fontSize).toBe(base.fontSize);
    expect(write.metricsChanged).toBe(false);
    expect(write.scrollbackChanged).toBe(false);
  });

  it("reports a cell-metric write for every metric option", () => {
    const base = defaultTerminal();
    const bumps: Partial<TerminalSettings> = {
      fontSize: 20,
      fontFamily: "Iosevka Term, monospace",
      lineHeight: 1.5,
      letterSpacing: 1,
    };

    expect(Object.keys(bumps).sort()).toEqual([...METRIC_TERMINAL_OPTIONS].sort());

    for (const [key, value] of Object.entries(bumps)) {
      const { term } = openTerminal(base);
      const write = writeManagedTerminalOptions(
        term,
        managedTerminalOptions({ ...base, [key]: value }, { visible: true }),
      );
      expect(write.metricsChanged, key).toBe(true);
    }
  });

  it("classifies a scrollback shrink against the value the terminal held", () => {
    const base = defaultTerminal();

    const shrink = writeManagedTerminalOptions(
      openTerminal(base).term,
      managedTerminalOptions(withPref(base, "scrollback", 500), { visible: true }),
    );
    expect(shrink.scrollbackChanged).toBe(true);
    expect(shrink.scrollbackShrank).toBe(true);

    const grow = writeManagedTerminalOptions(
      openTerminal(base).term,
      managedTerminalOptions(withPref(base, "scrollback", 40_000), { visible: true }),
    );
    expect(grow.scrollbackChanged).toBe(true);
    expect(grow.scrollbackShrank).toBe(false);
  });
});

describe("scrollbackRepair", () => {
  it("re-pins a viewport that was following the live output", () => {
    expect(
      scrollbackRepair({ changed: true, shrank: true, atBottom: true }),
    ).toBe("scroll to bottom");
  });

  it("leaves a viewport parked in history where xterm put it", () => {
    expect(
      scrollbackRepair({ changed: true, shrank: true, atBottom: false }),
    ).toBe("repaint");
  });

  it("still repaints when scrollback only grew", () => {
    // xterm mutates ydisp inside the buffer resize without firing a scroll
    // event and cols x rows never change, so nothing else schedules a paint.
    expect(
      scrollbackRepair({ changed: true, shrank: false, atBottom: true }),
    ).toBe("repaint");
  });

  it("does nothing when scrollback was not written", () => {
    expect(
      scrollbackRepair({ changed: false, shrank: false, atBottom: false }),
    ).toBe("none");
  });
});

describe("applyTerminalPreferences", () => {
  it("reaches the live options of an already-open terminal", () => {
    const base = defaultTerminal();
    const { term, options } = openTerminal(base);

    const { applied } = applyTo(term, {
      ...base,
      fontSize: 17,
      cursorStyle: "bar",
      scrollSensitivity: 6,
      screenReaderMode: true,
      minimumContrastRatio: 7,
    });

    expect(options.fontSize).toBe(17);
    expect(options.cursorStyle).toBe("bar");
    expect(options.scrollSensitivity).toBe(6);
    expect(options.fastScrollSensitivity).toBe(30);
    expect(options.screenReaderMode).toBe(true);
    expect(options.minimumContrastRatio).toBe(7);
    expect([...applied.write.changed].sort()).toEqual(
      [
        "cursorStyle",
        "fastScrollSensitivity",
        "fontSize",
        "minimumContrastRatio",
        "screenReaderMode",
        "scrollSensitivity",
      ].sort(),
    );
  });

  it("re-fits geometry when a cell-metric option moves", () => {
    const base = defaultTerminal();
    const bumps: Partial<TerminalSettings> = {
      fontSize: 20,
      fontFamily: "Iosevka Term, monospace",
      lineHeight: 1.5,
      letterSpacing: 1,
    };

    for (const [key, value] of Object.entries(bumps)) {
      const { term } = openTerminal(base);
      const { applied, calls } = applyTo(term, { ...base, [key]: value });

      expect(applied.refitted, key).toBe(true);
      // The immediate pass plus the settle ladder, both on the resize path.
      expect(calls.refit, key).toBe(1);
      expect(calls.refitBurst, key).toBe(1);
    }
  });

  it("does not touch geometry for an option that only repaints", () => {
    const base = defaultTerminal();
    const bumps: Partial<TerminalSettings> = {
      cursorStyle: "underline",
      cursorBlink: false,
      minimumContrastRatio: 7,
      screenReaderMode: true,
      scrollSensitivity: 11,
    };

    for (const [key, value] of Object.entries(bumps)) {
      const { term } = openTerminal(base);
      const { applied, calls } = applyTo(term, { ...base, [key]: value });

      expect(applied.write.changed.length, key).toBeGreaterThan(0);
      expect(calls.refit, key).toBe(0);
      expect(calls.refitBurst, key).toBe(0);
    }
  });

  it("keeps the live screen under a viewport that was following it", () => {
    const base = defaultTerminal();
    const { term, scrollsToBottom } = openTerminal(base, {
      viewportY: 900,
      baseY: 900,
    });

    const { applied, calls } = applyTo(term, withPref(base, "scrollback", 200));

    expect(applied.repair).toBe("scroll to bottom");
    expect(scrollsToBottom).toHaveLength(1);
    // Forced repaint: xterm trims and moves ydisp with no event behind it.
    expect(calls.refit).toBe(1);
    expect(calls.refitBurst).toBe(0);
  });

  it("does not yank a viewport parked up in history", () => {
    const base = defaultTerminal();
    const { term, scrollsToBottom } = openTerminal(base, {
      viewportY: 40,
      baseY: 900,
    });

    const { applied, calls } = applyTo(term, withPref(base, "scrollback", 200));

    expect(applied.repair).toBe("repaint");
    expect(scrollsToBottom).toHaveLength(0);
    expect(calls.refit).toBe(1);
  });

  it("is inert when nothing the terminal owns changed", () => {
    const base = defaultTerminal();
    const { term, options } = openTerminal(base);

    const { applied, calls } = applyTo(term, { ...base });

    expect(applied.write.changed).toEqual([]);
    expect(options.fontSize).toBe(base.fontSize);
    expect(calls.refit).toBe(0);
    expect(calls.refitBurst).toBe(0);
  });
});

describe("bellResponse", () => {
  it("subscribes to nothing while the bell is off", () => {
    expect(bellResponse("off")).toBe("none");
  });

  it("maps the two live modes", () => {
    expect(bellResponse("visual")).toBe("flash");
    expect(bellResponse("sound")).toBe("sound");
  });
});

describe("fallbackCell", () => {
  it("follows the preference while xterm has not measured the font", () => {
    const base = defaultTerminal();

    expect(fallbackCell(base)).toEqual({ cellW: 13 * 0.6, cellH: 13 * 1.2 });

    const big = fallbackCell({
      ...base,
      fontSize: 24,
      lineHeight: 1.5,
      letterSpacing: 2,
    });
    expect(big.cellW).toBeCloseTo(24 * 0.6 + 2, 6);
    expect(big.cellH).toBeCloseTo(36, 6);
  });
});

describe("wheelReportFanout", () => {
  const notch = (over: Partial<Parameters<typeof wheelReportFanout>[0]> = {}) =>
    wheelReportFanout({
      deltaY: 120,
      deltaMode: 0,
      altFast: false,
      sensitivity: 3,
      cellHeight: 16,
      partial: 0,
      ...over,
    });

  it("means reports-per-notch for a discrete wheel", () => {
    // The settings hint reads "lines per wheel notch" — a notch at
    // sensitivity 3 is three reports, not xterm's magnitude-discarded one.
    expect(notch().reports).toBe(3);
    expect(notch().partial).toBeCloseTo(0, 9);
    expect(notch({ deltaY: -120 }).reports).toBe(-3);
    expect(notch({ sensitivity: 20 }).reports).toBe(20);
  });

  it("multiplies by the fast-scroll ratio when alt is held", () => {
    expect(notch({ altFast: true }).reports).toBe(15);
  });

  it("accumulates trackpad pixels across events until a whole report", () => {
    // 10px on a 16px cell at damping 0.3 and sensitivity 3: 0.5625 per event.
    const first = notch({ deltaY: 10 });
    expect(first.reports).toBe(0);
    expect(first.partial).toBeCloseTo(0.5625, 6);

    const second = notch({ deltaY: 10, partial: first.partial });
    expect(second.reports).toBe(1);
    expect(second.partial).toBeCloseTo(0.125, 6);
  });

  it("drops the carried fraction on a direction flip", () => {
    // A reversed gesture must not spend the tail of the previous one.
    const flipped = notch({ deltaY: -10, partial: 0.9 });
    expect(flipped.reports).toBe(0);
    expect(flipped.partial).toBeCloseTo(-0.5625, 6);
  });

  it("caps a momentum burst so the PTY is not flooded", () => {
    const burst = notch({ deltaY: 3000, sensitivity: 20, altFast: true });
    expect(burst.reports).toBe(60);
  });
});
