/**
 * A seat's two views, Terminal and Threads, on the terminal's side. Threads
 * is laid over the stage; the xterm under it stays mounted and attached in
 * its real box, and fits it as an open terminal does. These lock what a
 * covered terminal must never do: size itself or the child from a hidden or
 * zero box, or take the keyboard.
 */
import { isValidElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/headless";
import type { Seat, Terminal as TerminalNode } from "../src/shared/model";
import { seat, terminal } from "./support/model-nodes";
import { defaultTerminal, type SeatOpenView } from "../src/shared/settings";

type Effect = { run: () => void | (() => void); deps?: readonly unknown[] };
const hooks = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  states: [] as unknown[],
  effects: [] as Effect[],
  layouts: [] as Effect[],
  refIndex: 0,
  stateIndex: 0,
  api: undefined as unknown,
  listeners: new Set<(event: unknown) => void>(),
  /** What the operator last did, as focus-ownership reports it. */
  gesture: null as "pointer" | "key" | null,
}));

// Same harness as terminal-surface-recovery: the component runs as a plain
// function against a headless xterm, React reduced to index-keyed state. Here
// layout effects are kept too, so the view switch's own can be run.
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
  useLayoutEffect: (run: Effect["run"], deps?: Effect["deps"]) => hooks.layouts.push({ run, deps }),
}));
vi.mock("@legendapp/state/react", async (load) => ({
  ...await load<typeof import("@legendapp/state/react")>(),
  use$: (value: (() => unknown) | { get: () => unknown }) =>
    typeof value === "function" ? value() : value.get(),
}));
vi.mock("../src/window/lib/junto-api", () => ({
  getJuntoApi: () => hooks.api,
}));
vi.mock("../src/window/lib/terminal-actions", async (load) => ({
  ...await load<typeof import("../src/window/lib/terminal-actions")>(),
  ensureTerminalRunning: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../src/window/lib/terminal-events", () => ({
  onTerminalEvent: (listener: (event: unknown) => void) => {
    hooks.listeners.add(listener);
    return () => hooks.listeners.delete(listener);
  },
}));
// The keyboard: every claim the surface makes is recorded, and granted.
vi.mock("../src/window/lib/focus-ownership", async (load) => ({
  ...await load<typeof import("../src/window/lib/focus-ownership")>(),
  claimFocus: vi.fn(() => true),
  shouldClaimFocusOnSurfaceOpen: () => true,
  recentGestureKind: () => hooks.gesture,
}));
// No GPU in this rig: the open effect's renderer lease is not what is tested.
vi.mock("../src/window/lib/terminal-paint-lease", async (load) => ({
  ...await load<typeof import("../src/window/lib/terminal-paint-lease")>(),
  shouldPresentTerminalFrames: () => false,
}));

import { fallbackCell, TerminalSurface } from "../src/window/components/terminal/TerminalSurface";
import { SeatThreadsStage, SeatViewSwitch } from "../src/window/components/threads/SeatThreads";
import { claimFocus } from "../src/window/lib/focus-ownership";
import { seatViewAsked$ } from "../src/window/lib/seat-view";
import { state$ } from "../src/window/lib/state";
import { ensureTerminalRunning } from "../src/window/lib/terminal-actions";

const SEAT = seat("seat-node", { label: "Codex", agentKey: "local:codex", bindingId: "seat" as never, harness: "codex" });
const PLAIN = terminal("plain-node", { bindingId: "seat" as never });

const claims = vi.mocked(claimFocus);
const ensure = vi.mocked(ensureTerminalRunning);
const cleanups: (() => void)[] = [];

/** Every element in a rendered tree, through children and any prop that holds elements. */
const elementsIn = (value: unknown, out: ReactElement[] = []): ReactElement[] => {
  if (Array.isArray(value)) {
    for (const item of value) elementsIn(item, out);
  } else if (isValidElement(value)) {
    out.push(value);
    for (const prop of Object.values(value.props as Record<string, unknown>)) elementsIn(prop, out);
  }
  return out;
};
type Props = Record<string, unknown>;
const propsOf = (element: ReactElement | undefined): Props => (element?.props ?? {}) as Props;

/** The settings as they are before any test: no Seat opens on, which means Terminal. */
const SETTINGS = state$.settings.peek();
/** The operator's Seat opens on setting. */
const opensOn = (view: SeatOpenView): void => {
  state$.settings.set({ ...SETTINGS, terminal: { ...defaultTerminal(), seatOpenView: view } });
};

const sameDeps = (a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean =>
  a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));

/**
 * One surface on a fake main. `box` is the host's layout box in cells; `gone`
 * makes it the zero box of a hidden element. Each render commits the effects
 * this file is about, when their deps changed, as React would.
 */
const rig = (input: { readonly node?: Seat | TerminalNode; readonly grid?: { readonly fontSize: number }; readonly cold?: boolean } = {}) => {
  const term = Object.assign(new Terminal({ cols: 100, rows: 40, allowProposedApi: true }), { focus: () => {} });
  const refresh = vi.fn();
  Object.assign(term, { refresh });
  const resize = vi.spyOn(term, "resize");
  let started = input.cold !== true;
  ensure.mockImplementation(async () => {
    started = true;
    return { ok: true, epoch: "gen-1" };
  });
  const api = {
    terminalGet: vi.fn(async () => (started ? { bindingId: "seat", status: "running", epoch: "gen-1" } : undefined)),
    terminalAttach: vi.fn(async () => ({
      ok: true,
      status: "running",
      lease: { leaseId: "lease-1", epoch: "gen-1" },
      journal: [],
    })),
    terminalRelease: vi.fn(async () => true),
    terminalWrite: vi.fn(async () => true),
    terminalResize: vi.fn(async () => true),
    onAgentSeatStateChanged: () => () => {},
  };
  hooks.api = api;
  const cell = fallbackCell(defaultTerminal());
  const box = { cols: 100, rows: 40, gone: false };
  const host = {
    getBoundingClientRect: () =>
      box.gone
        ? { width: 0, height: 0 }
        : { width: 16 + (box.cols + 0.25) * cell.cellW, height: 12 + (box.rows + 0.25) * cell.cellH },
    querySelector: () => null,
    // In the focus shell, so the open-time claim has somewhere to land.
    closest: () => host,
    setAttribute: () => {},
  };
  const props: { node: Seat | TerminalNode; visible: boolean; grid?: { readonly fontSize: number } } = {
    node: input.node ?? SEAT,
    visible: true,
    ...(input.grid ? { grid: input.grid } : {}),
  };
  const ran = new Map<string, { deps: readonly unknown[] | undefined; cleanup: (() => void) | undefined }>();
  const commit = (key: string, effect: Effect | undefined): void => {
    expect(effect, key).toBeDefined();
    const before = ran.get(key);
    if (before && sameDeps(before.deps, effect!.deps)) return;
    before?.cleanup?.();
    ran.set(key, { deps: effect!.deps, cleanup: effect!.run() || undefined });
  };
  let tree: unknown;
  const render = (): void => {
    // A state set while rendering renders again before anything commits.
    for (let pass = 0; pass < 3; pass += 1) {
      hooks.refIndex = 0;
      hooks.stateIndex = 0;
      hooks.effects = [];
      hooks.layouts = [];
      tree = TerminalSurface(props);
      hooks.refs[0]!.current = host;
      hooks.refs[1]!.current = host;
      hooks.refs[2]!.current = term;
    }
    commit("back to Terminal", hooks.layouts.find(({ run }) => run.toString().includes("coveredBefore")));
    commit("the ask answered", hooks.effects.find(({ run }) => run.toString().includes("answerSeatViewAsk")));
    commit("open-time claim", hooks.effects.find(({ run }) => run.toString().includes("shouldClaimFocusOnSurfaceOpen")));
    commit("attach", hooks.effects.find(({ deps }) => deps?.length === 4 && deps[0] === "seat"));
  };
  const found = (type: unknown): ReactElement | undefined => elementsIn(tree).find((element) => element.type === type);
  const xterm = (): Props =>
    propsOf(elementsIn(tree).find((element) => String(propsOf(element).className ?? "").includes("native-terminal-surface__xterm")));
  const stage = (): ReactElement | undefined =>
    elementsIn(tree).find((element) => propsOf(element).className === "native-terminal-surface__stage");
  cleanups.push(() => {
    for (const { cleanup } of ran.values()) cleanup?.();
    term.dispose();
  });
  return {
    term, api, box, host, refresh, resize, render, found, xterm, stage,
    /** The view on screen, as the switch says it. */
    view: (): unknown => propsOf(found(SeatViewSwitch)).view,
    /** A press on one half of the header's switch. */
    select: (view: SeatOpenView, how: "pointer" | "key" = "pointer"): void => {
      hooks.gesture = how;
      (propsOf(found(SeatViewSwitch)).onSelect as (next: SeatOpenView) => void)(view);
      render();
      hooks.gesture = null;
    },
    show: (visible: boolean): void => {
      props.visible = visible;
      render();
    },
    /** The grid takes the surface as a cell, or lets it go. */
    cell: (grid: { readonly fontSize: number } | undefined): void => {
      if (grid) props.grid = grid;
      else delete props.grid;
      render();
    },
    /** Everything the surface rendered. */
    tree: (): unknown => tree,
    /** The load pill over the stage, while the session is coming up. */
    load: (): ReactElement | undefined =>
      elementsIn(tree).find((element) => propsOf(element).className === "native-terminal-surface__load"),
  };
};

/** Past every rung of the settle ladder and the trailing notify. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(2_000);
};

beforeEach(() => {
  vi.useFakeTimers();
  hooks.refs = [];
  hooks.states = [];
  hooks.effects = [];
  hooks.layouts = [];
  hooks.listeners.clear();
  hooks.gesture = null;
  claims.mockClear();
  ensure.mockClear();
  state$.settings.set(SETTINGS);
  vi.stubGlobal("window", { setTimeout, clearTimeout });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  hooks.api = undefined;
  state$.settings.set(SETTINGS);
  seatViewAsked$.set({});
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("the two views of a seat", () => {
  it("offers the switch and the threads to an agent seat's modal, and to nothing else", () => {
    const agent = rig();
    agent.render();
    expect(agent.found(SeatViewSwitch)).toBeDefined();
    expect(agent.found(SeatThreadsStage)).toBeDefined();
    expect(propsOf(agent.found(SeatThreadsStage)).shown).toBe(false);
    // The halves name the stage they switch, and the threads are laid inside it.
    const stage = agent.stage();
    expect(propsOf(stage).id).toBe(propsOf(agent.found(SeatViewSwitch)).controls);
    expect(propsOf(stage).role).toBe("tabpanel");
    expect(elementsIn(stage).some((element) => element.type === SeatThreadsStage)).toBe(true);

    // A grid cell stays the terminal, whatever the setting says.
    opensOn("threads");
    hooks.refs = [];
    hooks.states = [];
    const cell = rig({ grid: { fontSize: 11 } });
    cell.render();
    expect(cell.found(SeatViewSwitch)).toBeUndefined();
    expect(cell.found(SeatThreadsStage)).toBeUndefined();
    expect(cell.xterm().inert).toBe(false);

    // A plain terminal has no threads.
    hooks.refs = [];
    hooks.states = [];
    const plain = rig({ node: PLAIN });
    plain.render();
    expect(plain.found(SeatViewSwitch)).toBeUndefined();
    expect(plain.found(SeatThreadsStage)).toBeUndefined();
    expect(plain.xterm().inert).toBe(false);
  });

  it("opens on the view the setting names, and every open starts on it again", () => {
    opensOn("threads");
    const surface = rig();
    surface.render();
    expect(surface.view()).toBe("threads");
    expect(propsOf(surface.found(SeatThreadsStage)).shown).toBe(true);

    // The switch holds for as long as this open lasts.
    surface.select("terminal");
    expect(surface.view()).toBe("terminal");
    surface.render();
    expect(surface.view()).toBe("terminal");

    // Parked, the threads are gone with the view; shown again is a new open.
    surface.show(false);
    expect(surface.found(SeatThreadsStage)).toBeUndefined();
    surface.show(true);
    expect(surface.view()).toBe("threads");

    // The setting is read as the view opens, not when the surface mounted.
    surface.show(false);
    opensOn("terminal");
    surface.show(true);
    expect(surface.view()).toBe("terminal");
  });

  it("does not move an open view when the setting changes under it", () => {
    const surface = rig();
    surface.render();
    opensOn("threads");
    surface.render();
    expect(surface.view()).toBe("terminal");
  });

  it("opens on the view it was asked for whatever the setting says, once", () => {
    // openSeatOn's ask, made before the surface is on screen.
    const surface = rig();
    surface.show(false);
    seatViewAsked$[SEAT.id].set("threads");
    surface.show(true);
    expect(surface.view()).toBe("threads");
    // Taken: the ask is answered and not read again.
    expect(seatViewAsked$[SEAT.id].peek()).toBeUndefined();

    surface.show(false);
    surface.show(true);
    expect(surface.view()).toBe("terminal");

    // Asked of a seat already on screen, it changes there.
    seatViewAsked$[SEAT.id].set("threads");
    surface.render();
    expect(surface.view()).toBe("threads");
    surface.select("terminal");
    expect(surface.view()).toBe("terminal");
  });

  it("takes an ask only where the view is offered: a parked surface keeps nothing for a later open", () => {
    const surface = rig();
    surface.show(false);
    // Seen while parked: neither taken nor answered.
    seatViewAsked$[SEAT.id].set("threads");
    surface.render();
    expect(seatViewAsked$[SEAT.id].peek()).toBe("threads");
    // The open it was for never showed this surface, and the ask ended.
    seatViewAsked$[SEAT.id].delete();
    surface.render();
    // The next open is another open: the setting, not the ask.
    surface.show(true);
    expect(surface.view()).toBe("terminal");
    expect(propsOf(surface.found(SeatThreadsStage)).shown).toBe(false);
  });

  it("takes no ask as a grid cell, and starts on the setting when the grid lets it go", () => {
    const surface = rig({ grid: { fontSize: 11 } });
    surface.render();
    seatViewAsked$[SEAT.id].set("threads");
    surface.render();
    // A cell stays the terminal, and the ask is not its to answer.
    expect(surface.found(SeatViewSwitch)).toBeUndefined();
    expect(surface.xterm().inert).toBe(false);
    expect(seatViewAsked$[SEAT.id].peek()).toBe("threads");
    seatViewAsked$[SEAT.id].delete();
    surface.render();
    surface.cell(undefined);
    expect(surface.view()).toBe("terminal");

    // An ask still waiting when the grid lets the seat go is taken there, once.
    surface.cell({ fontSize: 11 });
    seatViewAsked$[SEAT.id].set("threads");
    surface.render();
    surface.cell(undefined);
    expect(surface.view()).toBe("threads");
    expect(seatViewAsked$[SEAT.id].peek()).toBeUndefined();
  });
});

describe("a terminal under Threads", () => {
  it("starts a cold seat and fits its real box as an open terminal does: the child is told the size the operator will see", async () => {
    opensOn("threads");
    const surface = rig({ cold: true });
    // The stage is not the size the terminal was made at.
    surface.box.cols = 80;
    surface.box.rows = 24;
    surface.render();
    await settle();
    expect(ensure).toHaveBeenCalledTimes(1);
    expect(surface.api.terminalAttach).toHaveBeenCalledTimes(1);
    expect(surface.xterm().inert).toBe(true);
    expect(surface.resize.mock.calls).toEqual([[80, 24]]);
    expect(surface.api.terminalResize.mock.calls).toEqual([["lease-1", 80, 24]]);
  });

  it("sizes nothing from a hidden or zero box: not its grid, not the child", async () => {
    opensOn("threads");
    const surface = rig({ cold: true });
    // No box at all, through the attach's own fit and every rung after it.
    surface.box.gone = true;
    surface.render();
    await settle();
    expect(surface.api.terminalAttach).toHaveBeenCalledTimes(1);
    expect(surface.resize).not.toHaveBeenCalled();
    expect(surface.api.terminalResize).not.toHaveBeenCalled();
    expect([surface.term.cols, surface.term.rows]).toEqual([100, 40]);

    // Back on Terminal with the box still gone: the fit on the way back refuses it too.
    surface.select("terminal");
    await settle();
    expect(surface.resize).not.toHaveBeenCalled();
    expect(surface.api.terminalResize).not.toHaveBeenCalled();
    expect([surface.term.cols, surface.term.rows]).toEqual([100, 40]);
  });

  it("fits once on the way back to Terminal, and catches a size it missed under Threads", async () => {
    opensOn("threads");
    const surface = rig();
    surface.render();
    await settle();
    expect(surface.api.terminalResize.mock.calls).toEqual([["lease-1", 100, 40]]);
    const painted = surface.refresh.mock.calls.length;

    // The stage changed size with nothing to tell the terminal.
    surface.box.cols = 80;
    surface.box.rows = 24;
    surface.select("terminal");
    // Before any timer: the fit is made in the commit that shows the terminal.
    expect(surface.resize.mock.calls).toEqual([[80, 24]]);
    expect(surface.refresh).toHaveBeenCalledTimes(painted + 1);
    await settle();
    expect(surface.api.terminalResize.mock.calls).toEqual([["lease-1", 100, 40], ["lease-1", 80, 24]]);
    expect(surface.resize).toHaveBeenCalledTimes(1);
    expect(surface.refresh).toHaveBeenCalledTimes(painted + 1);
  });

  it("looked at and left with its box unchanged, repaints once and tells the child nothing", async () => {
    const surface = rig();
    surface.render();
    await settle();
    // The first measurement after an attach always tells the child.
    expect(surface.api.terminalResize.mock.calls).toEqual([["lease-1", 100, 40]]);
    const painted = surface.refresh.mock.calls.length;

    surface.select("threads");
    expect(surface.xterm().inert).toBe(true);
    surface.render();
    await settle();

    surface.select("terminal");
    await settle();
    expect(surface.xterm().inert).toBe(false);
    expect(surface.refresh).toHaveBeenCalledTimes(painted + 1);
    expect(surface.resize).not.toHaveBeenCalled();
    expect(surface.api.terminalResize).toHaveBeenCalledTimes(1);
  });

  it("closed under Threads, fits nothing on the way out", async () => {
    opensOn("threads");
    const surface = rig();
    surface.render();
    await settle();
    const painted = surface.refresh.mock.calls.length;
    const told = surface.api.terminalResize.mock.calls.length;
    // The parked box is not a size, and closing is not coming back to Terminal.
    surface.box.cols = 80;
    surface.box.rows = 24;
    surface.show(false);
    await settle();
    expect(surface.resize).not.toHaveBeenCalled();
    expect(surface.refresh).toHaveBeenCalledTimes(painted);
    expect(surface.api.terminalResize).toHaveBeenCalledTimes(told);
  });
});

describe("the keyboard and a terminal under Threads", () => {
  it("opened on Terminal, the terminal takes the keyboard", () => {
    const surface = rig();
    surface.render();
    expect(claims).toHaveBeenCalledTimes(1);
    expect(claims.mock.calls[0]?.slice(0, 2)).toEqual([surface.host, "open"]);
    expect(surface.xterm().inert).toBe(false);
  });

  it("opened on Threads, the terminal is inert and never takes the keyboard", async () => {
    opensOn("threads");
    const surface = rig();
    surface.render();
    await settle();
    expect(claims).not.toHaveBeenCalled();
    expect(surface.xterm().inert).toBe(true);
    expect(surface.xterm()["aria-hidden"]).toBe(true);
  });

  it("coming up, the load is said once: by the pill on Terminal, by the header under Threads", () => {
    const status = (surface: ReturnType<typeof rig>): Props =>
      propsOf(
        elementsIn(surface.tree()).find((element) =>
          String(propsOf(element).className ?? "").includes("native-terminal-surface__status"),
        ),
      );
    const open = rig({ cold: true });
    open.render();
    // On Terminal the pill over the stage speaks, and the header's line does not.
    expect(open.load()).toBeDefined();
    expect(propsOf(open.load()).inert).toBe(false);
    expect(propsOf(open.load())["aria-hidden"]).toBeUndefined();
    expect(status(open).role).toBeUndefined();

    // Under Threads the pill is covered: out of reach and unsaid, and the header says the load.
    opensOn("threads");
    hooks.refs = [];
    hooks.states = [];
    const covered = rig({ cold: true });
    covered.render();
    expect(covered.load()).toBeDefined();
    expect(propsOf(covered.load()).inert).toBe(true);
    expect(propsOf(covered.load())["aria-hidden"]).toBe(true);
    expect(status(covered).role).toBe("status");
  });

  it("covered inside the open-time retries, the retries give the keyboard to nothing", async () => {
    const surface = rig();
    // Not yet adopted into the focus shell: the claim waits and tries again.
    const adopted = surface.host.closest;
    surface.host.closest = () => null as never;
    surface.render();
    expect(claims).not.toHaveBeenCalled();
    surface.select("threads", "key");
    surface.host.closest = adopted;
    await settle();
    expect(claims).not.toHaveBeenCalled();
  });

  it("back on Terminal by a press, the terminal takes the keyboard; by a key, the switch keeps it", async () => {
    opensOn("threads");
    const surface = rig();
    surface.render();
    await settle();

    surface.select("terminal", "key");
    expect(claims).not.toHaveBeenCalled();

    surface.select("threads", "pointer");
    expect(claims).not.toHaveBeenCalled();

    surface.select("terminal", "pointer");
    expect(claims).toHaveBeenCalledTimes(1);
    expect(claims.mock.calls[0]?.slice(0, 2)).toEqual([surface.host, "gesture"]);
  });
});
