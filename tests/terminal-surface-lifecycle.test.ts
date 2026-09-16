import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import type { CanvasNode } from "../src/shared/canvas";
import { defaultTerminal } from "../src/shared/settings";
import type { LocalHostEvent } from "../src/main/junto/term/local-host";
import { TerminalStreamCoalescer } from "../src/main/junto/term/stream-coalescer";

type Effect = { run: () => void | (() => void); deps?: readonly unknown[] };
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  states: [] as unknown[],
  effects: [] as Effect[],
  refIndex: 0,
  stateIndex: 0,
  api: undefined as unknown,
}));

// Run the component's real attachment effect and callbacks without browser
// layout/GPU effects. The three view refs receive a headless xterm and measured
// host; delivery, sequence tracking, resize state and cleanup stay production code.
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

import { fallbackCell, TerminalSurface } from "../src/renderer/components/terminal/TerminalSurface";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const output = (seq: bigint, data: string, bindingId = "a"): LocalHostEvent => ({
  type: "output", bindingId, epoch: `epoch-${bindingId}`, seq, data,
});
const attachment = (bindingId: string, serialized = "A") => ({
  ok: true,
  status: "running",
  lease: { leaseId: `lease-${bindingId}`, epoch: `epoch-${bindingId}` },
  screen: { serialized, seq: 1n, cols: 100, rows: 40 },
});

const cleanups: (() => void)[] = [];
const rig = () => {
  const term = Object.assign(new Terminal({ cols: 100, rows: 40, allowProposedApi: true }), {
    refresh: () => {}, focus: () => {},
  });
  let listener: ((event: unknown) => void) | undefined;
  const attach = new Map<string, ReturnType<typeof deferred<ReturnType<typeof attachment>>>>();
  const requests: { lease: string; cols: number; rows: number; result: ReturnType<typeof deferred<boolean>> }[] = [];
  const api = {
    terminalAttach: vi.fn(({ bindingId }: { bindingId: string }) => {
      const result = deferred<ReturnType<typeof attachment>>();
      attach.set(bindingId, result);
      return result.promise;
    }),
    terminalRelease: vi.fn(async () => true),
    terminalWrite: vi.fn(async () => true),
    terminalResize: vi.fn((lease: string, cols: number, rows: number) => {
      const result = deferred<boolean>();
      requests.push({ lease, cols, rows, result });
      return result.promise;
    }),
    onTerminalEvent: (next: (event: unknown) => void) => {
      listener = next;
      return () => { listener = undefined; };
    },
  };
  hooks.api = api;
  const cell = fallbackCell(defaultTerminal());
  const host = {
    getBoundingClientRect: () => ({ width: 16 + 100.25 * cell.cellW, height: 12 + 40.25 * cell.cellH }),
    querySelector: () => null, closest: () => null,
  };
  let detach: (() => void) | undefined;
  const render = (bindingId: string) => {
    detach?.();
    hooks.refIndex = 0;
    hooks.stateIndex = 0;
    hooks.effects = [];
    const node: CanvasNode = {
      id: "surface", type: "text", text: "Terminal", x: 0, y: 0, width: 200, height: 100,
      ether: { entity: { kind: "terminal" }, terminal: { bindingId } },
    };
    TerminalSurface({ node });
    hooks.refs[0]!.current = host;
    hooks.refs[1]!.current = host;
    hooks.refs[2]!.current = term;
    const effect = hooks.effects.find(({ deps }) => deps?.length === 4 && deps[0] === bindingId);
    expect(effect, "production attachment effect").toBeDefined();
    detach = effect!.run() || undefined;
  };
  const events: unknown[] = [];
  const coalescer = new TerminalStreamCoalescer((event) => {
    events.push(event);
    listener?.(event);
  });
  cleanups.push(() => { detach?.(); coalescer.drop("a", "epoch-a"); term.dispose(); });
  return {
    term, render, requests, coalescer, api, events,
    deliver: (event: unknown) => listener?.(event),
    completeAttach: (bindingId: string, serialized = "A") => attach.get(bindingId)!.resolve(attachment(bindingId, serialized)),
    text: () => term.buffer.active.getLine(0)?.translateToString(true),
  };
};

const settle = async (ms = 1) => { await vi.advanceTimersByTimeAsync(ms); };

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

describe("TerminalSurface attachment lifetime", () => {
  it("notifies a replacement lease even while the old resize never resolves", async () => {
    const surface = rig();
    surface.render("a"); surface.completeAttach("a"); await settle();
    expect(surface.requests.map(({ lease }) => lease)).toEqual(["lease-a"]);
    surface.render("b"); surface.completeAttach("b"); await settle();
    expect(surface.requests.map(({ lease }) => lease)).toEqual(["lease-a", "lease-b"]);
  });

  it.each(["success", "false", "reject"] as const)("ignores old lease resize %s while replacement resize is pending", async (outcome) => {
    const surface = rig();
    surface.render("a"); surface.completeAttach("a"); await settle();
    surface.render("b"); surface.completeAttach("b"); await settle();
    const old = surface.requests[0]!.result;
    if (outcome === "reject") old.reject(new Error("old transport closed"));
    else old.resolve(outcome === "success");
    await settle(700); // attach settle fits must not free B's in-flight request
    expect(surface.requests.map(({ lease }) => lease)).toEqual(["lease-a", "lease-b"]);
    surface.requests[1]!.result.resolve(false);
    await settle(120);
    expect(surface.requests.map(({ lease }) => lease)).toEqual(["lease-a", "lease-b", "lease-b"]);
  });

  it("drops a pre-snapshot batch flushed after hydration", async () => {
    const surface = rig();
    surface.render("a");
    surface.coalescer.push(output(1n, "A"));
    surface.completeAttach("a"); await settle();
    surface.coalescer.flushAll(); await settle();
    expect(surface.text()).toBe("A");
  });

  it.each(["hydrating", "live"] as const)("keeps only post-snapshot chunks of a crossing batch while %s", async (phase) => {
    const surface = rig();
    surface.render("a");
    surface.coalescer.push(output(1n, "A"));
    surface.coalescer.push(output(2n, "B"));
    surface.completeAttach("a");
    if (phase === "hydrating") {
      await Promise.resolve(); // Attach reply has queued xterm's parser; callback is still pending.
      surface.coalescer.flushAll();
    }
    await settle();
    if (phase === "live") surface.coalescer.flushAll();
    await settle();
    expect(surface.text()).toBe("AB");
  });

  it("ignores duplicate live output sequence numbers", async () => {
    const surface = rig();
    surface.render("a"); surface.completeAttach("a"); await settle();
    surface.coalescer.push(output(2n, "B")); surface.coalescer.flushAll();
    surface.deliver(surface.events[0]);
    await settle();
    expect(surface.text()).toBe("AB");
  });
});
