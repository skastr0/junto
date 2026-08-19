import { describe, expect, it, vi } from "vitest";
import { WebglAddon } from "@xterm/addon-webgl";
import { attachWebglRenderer } from "../src/renderer/components/terminal/TerminalSurface";

type Report = { readonly kind: string; readonly detail: Record<string, unknown> };

/**
 * Stand-in for the xterm WebGL addon. Only the two members the surface drives
 * are modelled, plus counters for what teardown actually reached.
 */
const fakeAddon = () => {
  const state = {
    disposeCalls: 0,
    lossSubDisposeCalls: 0,
    listener: undefined as (() => void) | undefined,
  };
  const handle = {
    dispose: () => {
      state.disposeCalls += 1;
    },
    onContextLoss: (listener: () => void) => {
      state.listener = listener;
      return {
        dispose: () => {
          state.lossSubDisposeCalls += 1;
        },
      };
    },
  };
  return { state, handle };
};

const harness = (
  over: {
    readonly create?: () => ReturnType<typeof fakeAddon>["handle"];
    readonly load?: (addon: ReturnType<typeof fakeAddon>["handle"]) => void;
  } = {},
) => {
  const { state, handle } = fakeAddon();
  const reports: Report[] = [];
  const loaded: unknown[] = [];
  const attachment = attachWebglRenderer({
    create: over.create ?? (() => handle),
    load:
      over.load ??
      ((addon) => {
        loaded.push(addon);
      }),
    report: (kind, detail) => {
      reports.push({ kind, detail });
    },
  });
  return { state, handle, reports, loaded, attachment };
};

describe("attachWebglRenderer", () => {
  it("reports webgl once the addon constructs and activates", () => {
    const { attachment, reports, loaded, handle } = harness();

    expect(attachment.kind).toBe("webgl");
    expect(loaded).toEqual([handle]);
    expect(reports).toEqual([{ kind: "webgl", detail: { stage: "active" } }]);
  });

  it("falls back to the DOM renderer when the addon cannot be constructed", () => {
    const { attachment, reports, loaded } = harness({
      create: () => {
        throw new Error("WebGL2 is only supported on Safari 16 and above");
      },
    });

    expect(attachment.kind).toBe("dom");
    // The terminal was never handed a half-built addon.
    expect(loaded).toEqual([]);
    expect(reports).toEqual([
      {
        kind: "dom",
        detail: {
          stage: "activate",
          error: "WebGL2 is only supported on Safari 16 and above",
        },
      },
    ]);
  });

  it("releases the addon when activation throws", () => {
    const { attachment, reports, state } = harness({
      load: () => {
        throw new Error("no gl context");
      },
    });

    expect(attachment.kind).toBe("dom");
    expect(state.disposeCalls).toBe(1);
    expect(state.lossSubDisposeCalls).toBe(1);
    expect(reports).toEqual([
      { kind: "dom", detail: { stage: "activate", error: "no gl context" } },
    ]);
  });

  it("survives a non-Error activation throw", () => {
    const { attachment, reports } = harness({
      load: () => {
        throw "gl gone";
      },
    });

    expect(attachment.kind).toBe("dom");
    expect(reports).toEqual([
      { kind: "dom", detail: { stage: "activate", error: "gl gone" } },
    ]);
  });

  it("disposes the addon on context loss so xterm restores its own renderer", () => {
    const { reports, state } = harness();

    state.listener?.();

    // Disposing the addon is what hands painting back; a lost context that is
    // never disposed is a terminal that has stopped repainting.
    expect(state.disposeCalls).toBe(1);
    expect(state.lossSubDisposeCalls).toBe(1);
    expect(reports).toEqual([
      { kind: "webgl", detail: { stage: "active" } },
      { kind: "dom", detail: { stage: "context-loss" } },
    ]);
  });

  it("never re-arms WebGL, so a flapping context cannot loop the surface", () => {
    const { reports, state } = harness();

    state.listener?.();
    state.listener?.();
    state.listener?.();

    expect(state.disposeCalls).toBe(1);
    expect(reports.filter((r) => r.kind === "dom")).toHaveLength(1);
  });

  it("unmount after a context loss does not dispose twice", () => {
    const { attachment, state } = harness();

    state.listener?.();
    attachment.dispose();

    expect(state.disposeCalls).toBe(1);
    expect(state.lossSubDisposeCalls).toBe(1);
  });

  it("unmount releases the addon and reports no renderer change", () => {
    const { attachment, state, reports } = harness();

    attachment.dispose();
    attachment.dispose();

    expect(state.disposeCalls).toBe(1);
    expect(state.lossSubDisposeCalls).toBe(1);
    expect(reports).toEqual([{ kind: "webgl", detail: { stage: "active" } }]);
  });

  it("a throwing dispose still lands the surface on the DOM renderer", () => {
    const reports: Report[] = [];
    const attachment = attachWebglRenderer({
      create: () => ({
        dispose: () => {
          throw new Error("dispose blew up");
        },
        onContextLoss: () => ({ dispose: () => {} }),
      }),
      load: () => {
        throw new Error("no gl context");
      },
      report: (kind, detail) => {
        reports.push({ kind, detail });
      },
    });

    expect(attachment.kind).toBe("dom");
    expect(reports).toEqual([
      { kind: "dom", detail: { stage: "activate", error: "no gl context" } },
    ]);
  });
});

describe("installed @xterm/addon-webgl", () => {
  /**
   * The surface drives exactly `onContextLoss` and `dispose`, and hands the
   * instance to `Terminal.loadAddon`, which calls `activate`. Read the real
   * installed build rather than the docs.
   */
  it("exposes the members the surface drives", () => {
    const addon = new WebglAddon({ customGlyphs: false });
    try {
      expect(typeof addon.activate).toBe("function");
      expect(typeof addon.dispose).toBe("function");
      expect(typeof addon.onContextLoss).toBe("function");

      const listener = vi.fn();
      const sub = addon.onContextLoss(listener);
      expect(typeof sub.dispose).toBe("function");
      sub.dispose();
    } finally {
      addon.dispose();
    }
  });
});
