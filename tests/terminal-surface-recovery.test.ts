import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import type { CanvasNode } from "../src/shared/canvas";
import { defaultTerminal } from "../src/shared/settings";
import { seatDeadReason } from "../src/renderer/lib/seat-recovery";

type Effect = { run: () => void | (() => void); deps?: readonly unknown[] };
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  states: [] as unknown[],
  effects: [] as Effect[],
  refIndex: 0,
  stateIndex: 0,
  api: undefined as unknown,
  listeners: new Set<(event: unknown) => void>(),
}));

// Same harness as terminal-surface-lifecycle: the component's real attach
// effect runs against a headless xterm; React is reduced to index-keyed state.
vi.mock("react", async (load) => ({
  ...await load<typeof import("react")>(),
  useRef: (initial: unknown) => {
    const index = hooks.refIndex++;
    return hooks.refs[index] ??= { current: initial };
  },
  useState: (initial: unknown) => {
    const index = hooks.stateIndex++;
    if (!(index in hooks.states)) {
      hooks.states[index] = typeof initial === "function" ? initial() : initial;
    }
    return [hooks.states[index], (next: unknown) => {
      hooks.states[index] = typeof next === "function" ? next(hooks.states[index]) : next;
    }];
  },
  useEffect: (run: Effect["run"], deps?: Effect["deps"]) => hooks.effects.push({ run, deps }),
  useLayoutEffect: () => {},
}));
vi.mock("@legendapp/state/react", async (load) => ({
  ...await load<typeof import("@legendapp/state/react")>(),
  use$: (value: (() => unknown) | { get: () => unknown }) =>
    typeof value === "function" ? value() : value.get(),
}));
vi.mock("../src/renderer/lib/junto-api", () => ({
  getJuntoApi: () => hooks.api,
}));
vi.mock("../src/renderer/lib/terminal-actions", async (load) => ({
  ...await load<typeof import("../src/renderer/lib/terminal-actions")>(),
  ensureTerminalRunning: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../src/renderer/lib/terminal-events", () => ({
  onTerminalEvent: (listener: (event: unknown) => void) => {
    hooks.listeners.add(listener);
    return () => hooks.listeners.delete(listener);
  },
}));

import { fallbackCell, TerminalSurface } from "../src/renderer/components/terminal/TerminalSurface";
import { ensureTerminalRunning } from "../src/renderer/lib/terminal-actions";

// useState order in TerminalSurface: status, geomLabel, releasePending,
// releaseError, attachKey, killPhase, reopenPending, deadInfo, loadPhase.
const STATUS = 0;
const ATTACH_KEY = 4;
const KILL_PHASE = 5;
const LOAD_PHASE = 8;

const REASON = "Codex could not start: the folder ~/gone does not exist";
const EXIT_REASON = "Claude Code exited with code 1: Error: Session ID 421f87b3 is already in use.";
const PIN = "421f87b3-5a95-474e-9164-85bb2d7d1ac6";

const agentNode: CanvasNode = {
  id: "seat-node",
  type: "text",
  text: "Codex",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: "local:codex" },
    terminal: { bindingId: "seat", harness: "codex" },
  },
};

/** A brand-new Claude Code seat: its session id is pinned at creation. */
const pinnedNode: CanvasNode = {
  ...agentNode,
  text: "Claude Code",
  ether: {
    entity: { kind: "agent", name: "local:claude" },
    terminal: { bindingId: "seat", harness: "claude", sessionId: PIN },
  },
};

const cleanups: (() => void)[] = [];

type Summary = {
  readonly bindingId: string;
  readonly status: "starting" | "running" | "exited";
  readonly epoch: string;
  readonly exitReason?: string;
  readonly exitMessage?: string;
};

/**
 * Drives the production attach effect. `get` answers every host read;
 * `attach` answers every attach. Each render is one attach-effect run.
 */
const seatRig = (input: {
  readonly node?: CanvasNode;
  readonly get: () => Summary | undefined;
  readonly attach: () => { readonly status: "running" | "exited"; readonly epoch: string };
}) => {
  const term = Object.assign(new Terminal({ cols: 100, rows: 40, allowProposedApi: true }), {
    refresh: () => {}, focus: () => {},
  });
  let attaches = 0;
  const api = {
    terminalGet: vi.fn(async () => input.get()),
    terminalAttach: vi.fn(async () => {
      attaches += 1;
      const generation = input.attach();
      return {
        ok: true,
        status: generation.status,
        lease: { leaseId: `lease-${attaches}`, epoch: generation.epoch },
        journal: [],
      };
    }),
    terminalRelease: vi.fn(async () => true),
    terminalWrite: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
  };
  hooks.api = api;
  const cell = fallbackCell(defaultTerminal());
  const host = {
    getBoundingClientRect: () => ({ width: 16 + 100.25 * cell.cellW, height: 12 + 40.25 * cell.cellH }),
    querySelector: () => null, closest: () => null,
  };
  let detach: (() => void) | undefined;
  const render = (): void => {
    detach?.();
    hooks.refIndex = 0;
    hooks.stateIndex = 0;
    hooks.effects = [];
    TerminalSurface({ node: input.node ?? agentNode });
    hooks.refs[0]!.current = host;
    hooks.refs[1]!.current = host;
    hooks.refs[2]!.current = term;
    const effect = hooks.effects.find(({ deps }) => deps?.length === 4 && deps[0] === "seat");
    expect(effect, "production attachment effect").toBeDefined();
    detach = effect!.run() || undefined;
  };
  const emit = (event: unknown): void => {
    for (const listener of [...hooks.listeners]) listener(event);
  };
  cleanups.push(() => { detach?.(); term.dispose(); });
  return { api, render, emit };
};

const ensureMock = vi.mocked(ensureTerminalRunning);

beforeEach(() => {
  vi.useFakeTimers();
  hooks.refs = [];
  hooks.states = [];
  hooks.effects = [];
  hooks.listeners.clear();
  ensureMock.mockResolvedValue({ ok: true });
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  hooks.api = undefined;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("seat dead reason", () => {
  it("shows the host's reason, never a raw exit code", () => {
    expect(seatDeadReason({ reason: "spawn_failed", message: REASON, status: REASON })).toBe(REASON);
    expect(seatDeadReason({ reason: "spawn_failed", status: "exited" })).toBe(
      "the seat could not start",
    );
    expect(seatDeadReason({ reason: "cli-missing" })).toBe(
      "the harness is not installed on this machine",
    );
    expect(seatDeadReason({ status: "agent seat is incomplete" })).toBe(
      "agent seat is incomplete",
    );
    expect(seatDeadReason({ message: REASON, status: "stopping failed" })).toBe(
      `${REASON} — stopping failed`,
    );
    expect(seatDeadReason({})).toBe("");
  });
});

describe("TerminalSurface on a seat that fails to start", () => {
  it("shows the refusal on the first dead generation, with no retry", async () => {
    ensureMock.mockResolvedValue({ ok: true, epoch: "gen-1" });
    const surface = seatRig({
      get: () => ({
        bindingId: "seat",
        status: "exited",
        epoch: "gen-1",
        exitReason: "spawn_failed",
        exitMessage: REASON,
      }),
      attach: () => ({ status: "exited", epoch: "gen-1" }),
    });
    surface.render();
    const key = hooks.states[ATTACH_KEY];
    await vi.advanceTimersByTimeAsync(50);

    expect(surface.api.terminalAttach).toHaveBeenCalledTimes(1);
    expect(hooks.states[ATTACH_KEY]).toBe(key);
    expect(hooks.states[STATUS]).toBe(REASON);
    expect(hooks.states[KILL_PHASE]).toBe("stopped");
    expect(hooks.states[LOAD_PHASE]).toBeNull();
  });

  it("shows why a live harness exited the moment it exits, with no restart", async () => {
    let exited = false;
    const surface = seatRig({
      node: pinnedNode,
      get: () =>
        exited
          ? { bindingId: "seat", status: "exited", epoch: "gen-1", exitMessage: EXIT_REASON }
          : { bindingId: "seat", status: "running", epoch: "gen-1" },
      attach: () => ({ status: "running", epoch: "gen-1" }),
    });
    surface.render();
    const key = hooks.states[ATTACH_KEY];
    await vi.advanceTimersByTimeAsync(50);
    expect(hooks.states[STATUS]).toBe("control");

    exited = true;
    surface.emit({ type: "exit", bindingId: "seat", epoch: "gen-1", seq: 9n, code: 1 });
    await vi.advanceTimersByTimeAsync(0);

    expect(hooks.states[STATUS]).toBe(EXIT_REASON);
    expect(hooks.states[KILL_PHASE]).toBe("stopped");
    expect(hooks.states[ATTACH_KEY]).toBe(key);
    expect(surface.api.terminalAttach).toHaveBeenCalledTimes(1);
  });

  it("does not wait out the live-generation deadline when the new generation already died", async () => {
    ensureMock.mockResolvedValue({ ok: true, epoch: "gen-1" });
    const surface = seatRig({
      get: () => ({ bindingId: "seat", status: "exited", epoch: "gen-1", exitMessage: EXIT_REASON }),
      attach: () => ({ status: "exited", epoch: "gen-1" }),
    });
    surface.render();
    await vi.advanceTimersByTimeAsync(10);

    expect(hooks.states[STATUS]).toBe(EXIT_REASON);
    expect(hooks.states[KILL_PHASE]).toBe("stopped");
  });

  it("follows the host's fail-open replacement of a dead resume", async () => {
    const surface = seatRig({
      node: pinnedNode,
      get: () => ({ bindingId: "seat", status: "running", epoch: "fresh-pin" }),
      attach: () => ({ status: "exited", epoch: "dead-resume" }),
    });
    surface.render();
    const key = hooks.states[ATTACH_KEY] as number;
    await vi.advanceTimersByTimeAsync(50);

    expect(hooks.states[ATTACH_KEY]).toBe(key + 1);
    expect(hooks.states[KILL_PHASE]).toBe("idle");
  });
});

describe("TerminalSurface load label on a pinned seat", () => {
  const stallBeforeAttach = () =>
    seatRig({
      node: pinnedNode,
      // No live generation yet: the surface holds the post-ensure phase.
      get: () => undefined,
      attach: () => ({ status: "running", epoch: "gen-1" }),
    });

  it("reads as finding before the host answers", () => {
    stallBeforeAttach().render();
    expect(hooks.states[LOAD_PHASE]).toBe("finding");
  });

  it("reads as a new session on the first start, even with a pinned id", async () => {
    ensureMock.mockResolvedValue({ ok: true, resuming: false, epoch: "gen-1" });
    stallBeforeAttach().render();
    await vi.advanceTimersByTimeAsync(10);

    expect(hooks.states[LOAD_PHASE]).toBe("starting");
    expect(hooks.states[STATUS]).toBe("starting new session");
  });

  it("reads as resuming only when the host resumed a session", async () => {
    ensureMock.mockResolvedValue({ ok: true, resuming: true, epoch: "gen-1" });
    stallBeforeAttach().render();
    await vi.advanceTimersByTimeAsync(10);

    expect(hooks.states[LOAD_PHASE]).toBe("resuming");
    expect(hooks.states[STATUS]).toBe("resuming 421f87b3…");
  });
});
