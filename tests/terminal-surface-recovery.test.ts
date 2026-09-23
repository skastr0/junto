import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import type { CanvasNode } from "../src/shared/canvas";
import { defaultTerminal } from "../src/shared/settings";
import {
  SEAT_RECOVERY_LIMIT,
  seatDeadReason,
  seatRecoveryDecision,
} from "../src/renderer/lib/seat-recovery";

type Effect = { run: () => void | (() => void); deps?: readonly unknown[] };
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  states: [] as unknown[],
  effects: [] as Effect[],
  refIndex: 0,
  stateIndex: 0,
  api: undefined as unknown,
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

import { fallbackCell, TerminalSurface } from "../src/renderer/components/terminal/TerminalSurface";

// useState order in TerminalSurface: status, geomLabel, releasePending,
// releaseError, attachKey, killPhase, reopenPending, deadInfo, loadPhase.
const STATUS = 0;
const ATTACH_KEY = 4;
const KILL_PHASE = 5;
const LOAD_PHASE = 8;

const REASON = "Codex could not start: the folder ~/gone does not exist";

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

const cleanups: (() => void)[] = [];

/** A seat that dies before ownership on every start, as a missing folder does. */
const deadSeatRig = () => {
  const term = Object.assign(new Terminal({ cols: 100, rows: 40, allowProposedApi: true }), {
    refresh: () => {}, focus: () => {},
  });
  let generation = 0;
  const api = {
    // The host always reports a fresh generation starting, then it dies.
    terminalGet: vi.fn(async () => ({
      bindingId: "seat",
      status: "starting",
      epoch: `live-${generation}`,
      exitReason: "spawn_failed",
      exitMessage: REASON,
    })),
    terminalAttach: vi.fn(async () => {
      generation += 1;
      return {
        ok: true,
        status: "exited",
        lease: { leaseId: `lease-${generation}`, epoch: `dead-${generation}` },
        journal: [{ type: "output", seq: 1n, data: `[junto] ${REASON}\r\n` }],
      };
    }),
    terminalRelease: vi.fn(async () => true),
    terminalWrite: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
    onTerminalEvent: () => () => {},
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
    TerminalSurface({ node: agentNode });
    hooks.refs[0]!.current = host;
    hooks.refs[1]!.current = host;
    hooks.refs[2]!.current = term;
    const effect = hooks.effects.find(({ deps }) => deps?.length === 4 && deps[0] === "seat");
    expect(effect, "production attachment effect").toBeDefined();
    detach = effect!.run() || undefined;
  };
  cleanups.push(() => { detach?.(); term.dispose(); });
  return { api, render };
};

beforeEach(() => {
  vi.useFakeTimers();
  hooks.refs = [];
  hooks.states = [];
  hooks.effects = [];
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

describe("seat recovery policy", () => {
  it("recovers through the budget, then settles", () => {
    for (let dead = 1; dead <= SEAT_RECOVERY_LIMIT; dead += 1) {
      expect(seatRecoveryDecision(dead)).toBe("recover");
    }
    expect(seatRecoveryDecision(SEAT_RECOVERY_LIMIT + 1)).toBe("settle");
  });

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

describe("TerminalSurface on a seat that can never start", () => {
  it("settles into the stopped state with the real reason instead of starting forever", async () => {
    const surface = deadSeatRig();
    let renders = 0;
    let key = hooks.states[ATTACH_KEY];
    surface.render();
    renders += 1;
    // Each recovery bumps attachKey, which re-runs the attach effect. Drive
    // those re-renders until the surface stops asking for another one.
    for (let step = 0; step < 20; step += 1) {
      await vi.advanceTimersByTimeAsync(1_000);
      if (hooks.states[ATTACH_KEY] === key) continue;
      key = hooks.states[ATTACH_KEY];
      surface.render();
      renders += 1;
    }

    expect(surface.api.terminalAttach).toHaveBeenCalledTimes(SEAT_RECOVERY_LIMIT + 1);
    expect(renders).toBe(SEAT_RECOVERY_LIMIT + 1);
    expect(hooks.states[STATUS]).toBe(REASON);
    expect(hooks.states[KILL_PHASE]).toBe("stopped");
    expect(hooks.states[LOAD_PHASE]).toBeNull();
  });
});
