import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import { terminal } from "./support/model-nodes";
import { defaultTerminal } from "../src/shared/settings";
import type { TerminalParkResult } from "../src/shared/ipc";
import type { TerminalOutputBatch } from "../src/shared/terminal";
import { SessionObserver } from "../src/main/junto/term/observer";

type Effect = { run: () => void | (() => void); deps?: readonly unknown[] };
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  states: [] as unknown[],
  effects: [] as Effect[],
  refIndex: 0,
  stateIndex: 0,
  api: undefined as unknown,
}));

// Run the component's real attachment and stream effects without browser
// layout/GPU effects, as tests/terminal-surface-lifecycle.test.ts does.
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

import { fallbackCell, PARK_GRACE_MS, TerminalSurface } from "../src/renderer/components/terminal/TerminalSurface";

const COLS = 100, ROWS = 40;
const EPOCH = "epoch-a";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};

const lines = (term: Terminal): string[] => {
  const buffer = term.buffer.active;
  return Array.from({ length: buffer.length }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? "")
    .concat(`cursor ${buffer.cursorX},${buffer.cursorY}`);
};

const cleanups: (() => void)[] = [];
/**
 * One surface on a fake main: `grid` is a real main-side SessionObserver fed
 * every byte, and the fake park gate holds output back from a parked view as
 * main's fan-out does. `stayed` is a terminal that took every byte live.
 */
const rig = () => {
  const term = Object.assign(new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true }), {
    refresh: () => {}, focus: () => {},
  });
  const stayed = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true });
  const grid = new SessionObserver({ bindingId: "a", epoch: EPOCH, cols: COLS, rows: ROWS });
  let listener: ((event: unknown) => void) | undefined;
  let parked = false;
  let missed = false;
  let seq = 0n;
  const parkReplies: ReturnType<typeof deferred<void>>[] = [];
  const api = {
    terminalAttach: vi.fn(async () => {
      const screen = await grid.attachScreen();
      return { ok: true, status: "running", lease: { leaseId: "lease-a", epoch: EPOCH }, screen };
    }),
    terminalRelease: vi.fn(async () => true),
    terminalWrite: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
    terminalPark: vi.fn(async (_lease: string, next: boolean): Promise<TerminalParkResult> => {
      if (next) {
        parked = true;
        missed = false;
        return { ok: true, missed: false };
      }
      parked = false;
      const held = missed;
      missed = false;
      if (!held) return { ok: true, missed: false };
      const gate = deferred<void>();
      parkReplies.push(gate);
      const screen = await grid.attachScreen();
      await gate.promise;
      return { ok: true, missed: true, screen, journal: [] };
    }),
    onTerminalEvent: (next: (event: unknown) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
  };
  hooks.api = api;
  const cell = fallbackCell(defaultTerminal());
  const host = {
    getBoundingClientRect: () => ({ width: 16 + (COLS + 0.25) * cell.cellW, height: 12 + (ROWS + 0.25) * cell.cellH }),
    querySelector: () => null, closest: () => null,
  };
  const node = terminal("surface", { bindingId: "a" as never });
  let detach: (() => void) | undefined;
  const render = (visible: boolean) => {
    hooks.refIndex = 0;
    hooks.stateIndex = 0;
    hooks.effects = [];
    TerminalSurface({ node, visible });
    hooks.refs[0]!.current = host;
    hooks.refs[1]!.current = host;
    hooks.refs[2]!.current = term;
    const stream = hooks.effects.find(({ run }) => run.toString().includes("streamShownRef"));
    expect(stream, "production stream effect").toBeDefined();
    return { attach: hooks.effects.find(({ deps }) => deps?.length === 4 && deps[0] === "a"), stream: stream! };
  };
  const writes = vi.spyOn(term, "write");
  /** One PTY chunk: into main's grid and the always-visible terminal, and to the view unless it is parked. */
  const emit = (data: string) => {
    seq += 1n;
    grid.feed(data, seq);
    stayed.write(data);
    if (parked) {
      missed = true;
      return;
    }
    const batch: TerminalOutputBatch = { type: "output", bindingId: "a", epoch: EPOCH, seq, data, chunks: [{ seq, end: data.length }] };
    listener?.(batch);
  };
  cleanups.push(() => { detach?.(); term.dispose(); stayed.dispose(); grid.dispose(); });
  return {
    term, stayed, api, writes, emit, parkReplies,
    open: (visible: boolean) => {
      const effects = render(visible);
      detach = effects.attach!.run() || undefined;
      effects.stream.run();
    },
    show: (visible: boolean) => { render(visible).stream.run(); },
  };
};

const settle = async (ms = 1) => { await vi.advanceTimersByTimeAsync(ms); };
const until = async (check: () => boolean) => {
  for (let round = 0; round < 200 && !check(); round += 1) await settle(5);
  expect(check()).toBe(true);
};
/** xterm parses on a timer: wait until everything written so far is in the buffer. */
const parsed = async (term: Terminal) => {
  let done = false;
  term.write("", () => { done = true; });
  await until(() => done);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
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

const burst = (from: number, count: number): string =>
  Array.from({ length: count }, (_, index) => `\x1b[3${(from + index) % 8}mline ${from + index}\x1b[0m\r\n`).join("");

describe("a hidden terminal surface", () => {
  it("hidden past the grace, parses nothing, and shown again matches a terminal that stayed visible", async () => {
    const surface = rig();
    surface.emit(burst(0, 10));
    surface.open(true);
    await until(() => surface.api.terminalResize.mock.calls.length > 0);
    surface.emit(burst(10, 5));

    surface.show(false);
    await settle(PARK_GRACE_MS - 10);
    expect(surface.api.terminalPark).not.toHaveBeenCalled();
    await settle(10);
    expect(surface.api.terminalPark).toHaveBeenLastCalledWith("lease-a", true);
    const writesWhenHidden = surface.writes.mock.calls.length;
    // Hidden long enough to push lines past the screen into scrollback.
    surface.emit(burst(15, 300));
    surface.emit("\x1b[1;32mprompt> \x1b[0mhalf typed");
    await settle(50);
    expect(surface.writes.mock.calls.length).toBe(writesWhenHidden);

    surface.show(true);
    expect(surface.api.terminalPark).toHaveBeenLastCalledWith("lease-a", false);
    await until(() => surface.parkReplies.length === 1);
    // Output that lands while the catch-up is on its way waits for it.
    surface.emit(" and more\r\nafter");
    surface.parkReplies[0]!.resolve();
    await until(() => surface.writes.mock.calls.length > writesWhenHidden + 1);
    await settle(10);
    await parsed(surface.term);
    await parsed(surface.stayed);

    expect(lines(surface.term)).toEqual(lines(surface.stayed));
  });

  it("shown again without having missed output, repaints nothing", async () => {
    const surface = rig();
    surface.emit(burst(0, 3));
    surface.open(true);
    await until(() => surface.api.terminalResize.mock.calls.length > 0);
    surface.show(false);
    await settle(PARK_GRACE_MS);
    const writes = surface.writes.mock.calls.length;
    surface.show(true);
    await settle(10);
    expect(surface.writes.mock.calls.length).toBe(writes);
    surface.emit("live");
    await settle(10);
    await parsed(surface.term);
    await parsed(surface.stayed);
    expect(lines(surface.term)).toEqual(lines(surface.stayed));
  });

  it("switched back inside the grace, draws everything with no catch-up", async () => {
    const surface = rig();
    surface.emit(burst(0, 10));
    surface.open(true);
    await until(() => surface.api.terminalResize.mock.calls.length > 0);
    surface.show(false);
    // Another terminal is up for a moment; this one keeps its stream.
    surface.emit(burst(10, 60));
    await settle(PARK_GRACE_MS / 2);
    surface.show(true);
    surface.emit("back");
    await settle(PARK_GRACE_MS);
    await parsed(surface.term);
    await parsed(surface.stayed);
    expect(surface.api.terminalPark).not.toHaveBeenCalled();
    expect(lines(surface.term)).toEqual(lines(surface.stayed));
  });

  it("opened hidden, parks as soon as it attaches", async () => {
    const surface = rig();
    surface.open(false);
    await until(() => surface.api.terminalPark.mock.calls.length > 0);
    expect(surface.api.terminalPark).toHaveBeenLastCalledWith("lease-a", true);
  });
});
