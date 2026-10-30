/**
 * Keys on a surface port reach the PTY in the order they were typed and are
 * never lost: a key the terminal process did not take before its port closed
 * goes again over IPC, and keys typed while a gap reattaches wait for the new
 * lease. The real TerminalSurface attach effect, on a fake main.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import { terminal } from "./support/model-nodes";
import { defaultTerminal } from "../src/shared/settings";
import { MessageChannel, type MessagePort as NodePort } from "node:worker_threads";

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
const ports = vi.hoisted(() => ({ takers: new Map<string, (port: MessagePort) => void>() }));
// Main posts each port to the window; here the test hands it over by lease.
vi.mock("../src/renderer/lib/terminal-surface-port", () => ({
  takeSurfacePorts: (leaseId: string, take: (port: MessagePort) => void) => {
    ports.takers.set(leaseId, take);
    return () => ports.takers.delete(leaseId);
  },
}));

import { fallbackCell, TerminalSurface } from "../src/renderer/components/terminal/TerminalSurface";

const COLS = 100, ROWS = 40;
const EPOCH = "epoch-a";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
};

const turn = () => new Promise((resolve) => setImmediate(resolve));
const cleanups: (() => void)[] = [];

/** One control view on a fake main whose attaches can be held, and the far end of each port it is given. */
const rig = () => {
  const term = Object.assign(new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true }), {
    refresh: () => {}, focus: () => {},
  });
  let leases = 0;
  const holds: ReturnType<typeof deferred<void>>[] = [];
  let holdNext = false;
  const api = {
    terminalAttach: vi.fn(async () => {
      if (holdNext) {
        holdNext = false;
        const gate = deferred<void>();
        holds.push(gate);
        await gate.promise;
      }
      leases += 1;
      return { ok: true, status: "running", lease: { leaseId: `lease-${leases}`, epoch: EPOCH }, screen: { epoch: EPOCH, cols: COLS, rows: ROWS, seq: 1n, serialized: "" } };
    }),
    terminalRelease: vi.fn(async () => true),
    terminalWrite: vi.fn(async (_lease: string, _data: string) => true),
    terminalResize: vi.fn(async () => true),
    terminalPark: vi.fn(async () => ({ ok: true, missed: false })),
    onTerminalEvent: () => () => undefined,
  };
  hooks.api = api;
  const cell = fallbackCell(defaultTerminal());
  const host = {
    getBoundingClientRect: () => ({ width: 16 + (COLS + 0.25) * cell.cellW, height: 12 + (ROWS + 0.25) * cell.cellH }),
    querySelector: () => null, closest: () => null,
  };
  const node = terminal("surface", { bindingId: "a" as never });
  let detach: (() => void) | undefined;
  const opened: NodePort[] = [];
  cleanups.push(() => { detach?.(); term.dispose(); for (const port of opened) port.close(); });
  /** Give the view a port for its lease; the far end hears every key. */
  const port = (leaseId: string) => {
    const { port1, port2 } = new MessageChannel();
    opened.push(port1, port2);
    const keys: string[] = [];
    port2.on("message", (message: { t: string; data: string }) => {
      if (message.t === "in") keys.push(message.data);
    });
    ports.takers.get(leaseId)!(port1 as unknown as MessagePort);
    return { keys, send: (message: object) => port2.postMessage(message) };
  };
  return {
    term, api, port, holds,
    holdNextAttach: () => { holdNext = true; },
    open: () => {
      hooks.refIndex = 0;
      hooks.stateIndex = 0;
      hooks.effects = [];
      TerminalSurface({ node, visible: true });
      hooks.refs[0]!.current = host;
      hooks.refs[1]!.current = host;
      hooks.refs[2]!.current = term;
      const attach = hooks.effects.find(({ deps }) => deps?.length === 4 && deps[0] === "a");
      detach = attach!.run() || undefined;
    },
    type: (data: string) => term.input(data, true),
    written: () => api.terminalWrite.mock.calls.map(([lease, data]) => `${lease}:${data}`),
  };
};

const until = async (check: () => boolean) => {
  for (let round = 0; round < 400 && !check(); round += 1) {
    await vi.advanceTimersByTimeAsync(5);
    await turn();
  }
  expect(check()).toBe(true);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  hooks.refs = [];
  hooks.states = [];
  hooks.effects = [];
  ports.takers.clear();
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

describe("keys on a surface port", () => {
  it("go over the port, and a key the port never took goes again over IPC when it ends", async () => {
    const view = rig();
    view.open();
    await until(() => ports.takers.has("lease-1"));
    const far = view.port("lease-1");
    view.type("a");
    view.type("b");
    await until(() => far.keys.length === 2);
    expect(view.written()).toEqual([]);
    far.send({ t: "took" });
    // The terminal side closes the port with "b" untaken.
    far.send({ t: "end" });
    await until(() => view.written().length === 1);
    expect(view.written()).toEqual(["lease-1:b"]);
    view.type("c");
    await until(() => view.written().length === 2);
    expect(view.written()).toEqual(["lease-1:b", "lease-1:c"]);
  });

  it("typed across a gap reattach, reach the new lease in order once it answers", async () => {
    const view = rig();
    view.open();
    await until(() => ports.takers.has("lease-1"));
    const far = view.port("lease-1");
    view.type("x");
    await until(() => far.keys.length === 1);
    view.holdNextAttach();
    far.send({ t: "gap" });
    await until(() => view.api.terminalAttach.mock.calls.length === 2);
    view.type("y");
    view.type("z");
    await turn();
    // No lease takes them until the reattach answers; the old one is gone.
    expect(view.written()).toEqual([]);
    view.holds[0]!.resolve();
    await until(() => view.written().length === 3);
    expect(view.written()).toEqual(["lease-2:x", "lease-2:y", "lease-2:z"]);
  });
});
