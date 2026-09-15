import { Cause, Effect, Exit, Option } from "effect";
import { describe, expect, it } from "vitest";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../src/shared/canvas";
import type { TaskState } from "../src/shared/work-model";
import type { WorkErrorBody } from "../src/shared/work-control";
import type {
  ObserverGridSnapshot,
  ObserverGridWindow,
} from "../src/main/vellum-command/term/observer";
import {
  makeSeatObservation,
  type SeatObservationDeps,
} from "../src/main/vellum-command/work/seat-observation";

// Focused tests for the seat wait/observe service. Everything is injected: the
// service's contract is about authority, ordering and bounds, none of which
// needs a real PTY.

const agentNode = (id: string, bindingId: string, host?: string): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  ether: {
    entity: { kind: "agent", name: `local:${id}` },
    terminal: { bindingId, harness: "claude" },
    ...(host !== undefined ? { host } : {}),
  },
});

const taskSinkNode = (
  items: ReadonlyArray<{ id: string; state: TaskState; epoch?: number }>,
): CanvasNode => ({
  id: "sink",
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  ether: {
    entity: { kind: "task" },
    tasks: { items: items.map((item) => ({ history: [], ...item })) },
  },
});

const edge = (verb: "messages" | "contributes", from: string, to: string): CanvasEdge => ({
  id: `${verb}-${from}-${to}`,
  fromNode: from,
  toNode: to,
  ether: { verb },
});

const doc = (
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
): CanvasDoc => ({ nodes: [...nodes], edges: [...edges] });

const seatEvent = (over: Partial<AgentSeatStateEvent> = {}): AgentSeatStateEvent => ({
  bindingId: "bind-peer",
  epoch: "e1",
  state: "idle",
  reason: "settled",
  confidence: "high",
  at: 1_000,
  ...over,
});

const gridWindow = (over: Partial<ObserverGridWindow> = {}): ObserverGridWindow => ({
  bindingId: "bind-peer",
  epoch: "e1",
  cols: 80,
  rows: 24,
  seq: 1n,
  lines: ["line one"],
  totalLines: 1,
  truncated: false,
  ...over,
});

const gridSnapshot = (over: Partial<ObserverGridSnapshot> = {}): ObserverGridSnapshot => ({
  bindingId: "bind-peer",
  epoch: "e1",
  cols: 80,
  rows: 24,
  lines: ["line one"],
  text: "line one",
  signals: { title: "", osc9: "", modes: { bracketedPaste: false, synchronizedOutput: false, altScreen: false, mouseModes: [] } },
  seq: 2n,
  ...over,
});

const failure = <A>(exit: Exit.Exit<A, WorkErrorBody>): WorkErrorBody | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const settle = (ms = 25): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

type Harness = {
  readonly service: ReturnType<typeof makeSeatObservation>;
  readonly setDoc: (next: CanvasDoc) => void;
  readonly emitCanvas: (name: string) => void;
  readonly emitSeat: (event: AgentSeatStateEvent) => void;
  /**
   * Model the seat state machine retiring a generation: the binding leaves the
   * live projection and its published exit survives as a tombstone, which is
   * exactly what production `current()` now merges.
   */
  readonly retireSeat: (bindingId: string, reason?: string) => void;
  readonly emitGrid: (snapshot: ObserverGridSnapshot) => void;
  readonly emitWork: (canvasName?: string, nodeId?: string) => void;
  readonly setWindow: (window: ObserverGridWindow | undefined) => void;
  readonly seatSubscribed: () => boolean;
  readonly gridSubscribed: () => boolean;
  readonly gridReads: () => number;
  readonly activeListeners: () => number;
};

const makeHarness = (input: {
  doc: CanvasDoc;
  seatEvents?: ReadonlyArray<AgentSeatStateEvent>;
  sessionEpoch?: string;
  window?: ObserverGridWindow;
  onReadGrid?: (self: () => Harness) => void;
}): Harness => {
  let currentDoc = input.doc;
  let seatEvents = [...(input.seatEvents ?? [])];
  let retiredSeats: AgentSeatStateEvent[] = [];
  let window = input.window;
  let gridReads = 0;
  let seatSubscribed = false;
  let gridSubscribed = false;
  const canvasListeners = new Set<(name: string) => void>();
  const seatListeners = new Set<(event: AgentSeatStateEvent) => void>();
  const gridListeners = new Set<(snapshot: ObserverGridSnapshot) => void>();
  const workListeners = new Set<
    (canvasName: string | undefined, nodeId: string | undefined) => void
  >();

  const deps: SeatObservationDeps = {
    readDoc: () => Effect.succeed(currentDoc),
    subscribeCanvasChanges: (listener) => {
      canvasListeners.add(listener);
      return () => canvasListeners.delete(listener);
    },
    seatStates: {
      current: () => [...seatEvents, ...retiredSeats],
      subscribe: (listener) => {
        seatSubscribed = true;
        seatListeners.add(listener);
        return () => seatListeners.delete(listener);
      },
    },
    subscribeWorkChanges: (listener) => {
      workListeners.add(listener);
      return () => workListeners.delete(listener);
    },
    sessionOf: () =>
      input.sessionEpoch === undefined
        ? undefined
        : { epoch: input.sessionEpoch, status: "running" },
    readGrid: async () => {
      gridReads += 1;
      input.onReadGrid?.(() => harness);
      return window;
    },
    subscribeGrid: (listener) => {
      gridSubscribed = true;
      gridListeners.add(listener);
      return () => gridListeners.delete(listener);
    },
  };

  const service = makeSeatObservation(deps);

  const harness: Harness = {
    service,
    setDoc: (next) => {
      currentDoc = next;
    },
    setWindow: (next) => {
      window = next;
    },
    emitCanvas: (name) => {
      for (const listener of canvasListeners) listener(name);
    },
    emitSeat: (event) => {
      seatEvents = [...seatEvents.filter((entry) => entry.bindingId !== event.bindingId), event];
      for (const listener of seatListeners) listener(event);
    },
    retireSeat: (bindingId, reason = "generation_exited") => {
      const prior = seatEvents.find((entry) => entry.bindingId === bindingId);
      seatEvents = seatEvents.filter((entry) => entry.bindingId !== bindingId);
      const gone: AgentSeatStateEvent = {
        ...(prior ?? seatEvent()),
        bindingId,
        state: "gone",
        reason,
        confidence: "high",
      };
      retiredSeats = [...retiredSeats.filter((entry) => entry.bindingId !== bindingId), gone];
      for (const listener of seatListeners) listener(gone);
    },
    emitGrid: (snapshot) => {
      for (const listener of gridListeners) listener(snapshot);
    },
    emitWork: (canvasName, nodeId) => {
      for (const listener of workListeners) listener(canvasName, nodeId);
    },
    seatSubscribed: () => seatSubscribed,
    gridSubscribed: () => gridSubscribed,
    gridReads: () => gridReads,
    activeListeners: () =>
      canvasListeners.size + seatListeners.size + gridListeners.size + workListeners.size,
  };
  return harness;
};

const caller = { canvasName: "c", nodeId: "caller" };

const peerDoc = (edges: ReadonlyArray<CanvasEdge> = [edge("messages", "caller", "peer")]) =>
  doc([agentNode("caller", "bind-caller"), agentNode("peer", "bind-peer")], edges);

describe("seat.wait", () => {
  it("reports the observed state, reason, confidence and both generation witnesses", async () => {
    const harness = makeHarness({
      doc: peerDoc(),
      sessionEpoch: "e1",
      seatEvents: [seatEvent({ state: "attention", reason: "permission_form", confidence: "high" })],
    });
    const exit = await Effect.runPromiseExit(
      harness.service.waitSeat({ target: "peer", until: "attention", timeoutMs: 1_000 }, caller),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({
        target: "peer",
        state: "attention",
        reason: "permission_form",
        confidence: "high",
        generation: "e1",
        epoch: "e1",
        at: 1_000,
      });
    }
  });

  it("resolves a wait that starts after the seat already exited", async () => {
    // The E2E shape: B's process exits before the wait is issued. `unbind`
    // publishes `gone` and drops the binding, so only the retained tombstone
    // can answer — and it must carry the evidence of the generation that left.
    const harness = makeHarness({ doc: peerDoc() });
    harness.emitSeat(seatEvent({ state: "working", reason: "turn_active" }));
    harness.retireSeat("bind-peer");

    const exit = await Effect.runPromiseExit(
      harness.service.waitSeat({ target: "peer", until: "gone", timeoutMs: 1_000 }, caller),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({
        target: "peer",
        state: "gone",
        reason: "generation_exited",
        confidence: "high",
        generation: "e1",
        epoch: "e1",
        at: 1_000,
      });
    }
  });

  it("ignores a retired generation's exit once a replacement owns the binding", async () => {
    const harness = makeHarness({ doc: peerDoc(), sessionEpoch: "e2" });
    harness.emitSeat(seatEvent({ epoch: "e1", state: "working" }));
    harness.retireSeat("bind-peer");

    const exit = await Effect.runPromiseExit(
      harness.service.waitSeat({ target: "peer", until: "gone", timeoutMs: 60 }, caller),
    );
    const error = failure(exit);
    expect(error?.type).toBe("Timeout");
    expect(error?.details?.from).toBeUndefined();
    expect(error?.details?.to).toBe("gone");
    expect(error?.details?.hint).toContain("replaced generation");
  });

  it("answers from the current projection after registering its subscription", async () => {
    // The transition landed before the call, so only the post-registration
    // current-value check can answer it.
    const harness = makeHarness({
      doc: peerDoc(),
      sessionEpoch: "e1",
      seatEvents: [seatEvent({ state: "idle" })],
    });
    const exit = await Effect.runPromiseExit(
      harness.service.waitSeat({ target: "peer", until: "idle", timeoutMs: 1_000 }, caller),
    );
    expect(harness.seatSubscribed()).toBe(true);
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("does not lose a transition delivered synchronously at registration", async () => {
    let reads = 0;
    const service = makeSeatObservation({
      readDoc: () => Effect.succeed(peerDoc()),
      subscribeCanvasChanges: () => () => {},
      seatStates: {
        current: () => [],
        subscribe: (listener) => {
          // A replay-style delivery during registration, before the current
          // value is ever read.
          listener(seatEvent({ state: "working", reason: "turn", confidence: "high" }));
          return () => {};
        },
      },
      subscribeWorkChanges: () => () => {},
      sessionOf: () => ({ epoch: "e1", status: "running" }),
      readGrid: async () => undefined,
      subscribeGrid: () => () => {},
      now: () => {
        reads += 1;
        return reads;
      },
    });
    const exit = await Effect.runPromiseExit(
      service.waitSeat({ target: "peer", until: "working", timeoutMs: 1_000 }, caller),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.state).toBe("working");
  });

  it("fails closed with ScopeError when the edge dies between event and answer", async () => {
    const authorized = peerDoc();
    const revoked = peerDoc([]);
    let reads = 0;
    const service = makeSeatObservation({
      readDoc: () => {
        reads += 1;
        return Effect.succeed(reads === 1 ? authorized : revoked);
      },
      subscribeCanvasChanges: () => () => {},
      seatStates: {
        current: () => [],
        subscribe: (listener) => {
          listener(seatEvent({ state: "idle" }));
          return () => {};
        },
      },
      subscribeWorkChanges: () => () => {},
      sessionOf: () => ({ epoch: "e1", status: "running" }),
      readGrid: async () => undefined,
      subscribeGrid: () => () => {},
    });
    const exit = await Effect.runPromiseExit(
      service.waitSeat({ target: "peer", until: "idle", timeoutMs: 5_000 }, caller),
    );
    expect(failure(exit)?.type).toBe("ScopeError");
  });

  it("ends with ScopeError when the canvas revokes the edge mid-wait", async () => {
    const harness = makeHarness({ doc: peerDoc(), sessionEpoch: "e1" });
    const pending = Effect.runPromiseExit(
      harness.service.waitSeat({ target: "peer", until: "idle", timeoutMs: 5_000 }, caller),
    );
    await settle();
    expect(harness.seatSubscribed()).toBe(true);
    harness.setDoc(peerDoc([]));
    harness.emitCanvas("c");
    const exit = await pending;
    expect(failure(exit)?.type).toBe("ScopeError");
    expect(harness.activeListeners()).toBe(0);
  });

  it("ignores a seat event from a replaced generation and times out", async () => {
    const harness = makeHarness({
      doc: peerDoc(),
      sessionEpoch: "e2",
      seatEvents: [seatEvent({ epoch: "e1", state: "idle" })],
    });
    const exit = await Effect.runPromiseExit(
      harness.service.waitSeat({ target: "peer", until: "idle", timeoutMs: 60 }, caller),
    );
    const error = failure(exit);
    expect(error?.type).toBe("Timeout");
    // The stale event is not reported as an observation of the live seat; it
    // is named in the hint instead.
    expect(error?.details?.from).toBeUndefined();
    expect(error?.details?.to).toBe("idle");
    expect(error?.details?.retryable).toBe(true);
    expect(error?.details?.hint).toContain("replaced generation");
  });

  it("picks up a redrawn authorized set that already satisfies the wait", async () => {
    // The loop's first read authorizes caller→A; by the post-registration
    // recheck the operator has removed A and drawn caller→B, and B is already
    // in the requested state with no event left to emit. The wait must rebuild
    // on the fresh set and answer, not time out on the stale one.
    const withA = doc(
      [agentNode("caller", "bind-caller"), agentNode("a", "bind-a")],
      [edge("messages", "caller", "a")],
    );
    const withB = doc(
      [agentNode("caller", "bind-caller"), agentNode("b", "bind-b")],
      [edge("messages", "caller", "b")],
    );
    let reads = 0;
    const service = makeSeatObservation({
      readDoc: () => {
        reads += 1;
        return Effect.succeed(reads === 1 ? withA : withB);
      },
      subscribeCanvasChanges: () => () => {},
      seatStates: {
        current: () => [seatEvent({ bindingId: "bind-b", state: "working", epoch: "e1" })],
        subscribe: () => () => {},
      },
      subscribeWorkChanges: () => () => {},
      sessionOf: () => ({ epoch: "e1", status: "running" }),
      readGrid: async () => undefined,
      subscribeGrid: () => () => {},
    });
    const exit = await Effect.runPromiseExit(
      service.waitSeat({ any: true, until: "working", timeoutMs: 2_000 }, caller),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.target).toBe("b");
      expect(exit.value.state).toBe("working");
    }
  });

  it("answers within the observation budget of the transition it waits on", async () => {
    const harness = makeHarness({ doc: peerDoc(), sessionEpoch: "e1" });
    const started = Date.now();
    const pending = Effect.runPromiseExit(
      harness.service.waitSeat({ target: "peer", until: "working", timeoutMs: 2_000 }, caller),
    );
    await settle(20);
    expect(harness.seatSubscribed()).toBe(true);
    harness.emitSeat(seatEvent({ state: "working", reason: "turn", confidence: "high" }));
    const exit = await pending;
    const elapsed = Date.now() - started;
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.state).toBe("working");
    // The wait adds no debounce of its own: it answers the machine's event.
    expect(elapsed).toBeLessThan(250);
  });

  it("fails ScopeError when the edge is revoked before the canvas subscription installs", async () => {
    // The loop's own read sees an authorized document; the grant is removed
    // before the canvas subscription is registered, so no commit event can
    // deliver the news. The post-registration recheck must catch it.
    const authorized = peerDoc();
    const revoked = peerDoc([]);
    let reads = 0;
    const service = makeSeatObservation({
      readDoc: () => {
        reads += 1;
        return Effect.succeed(reads === 1 ? authorized : revoked);
      },
      subscribeCanvasChanges: () => () => {},
      seatStates: { current: () => [], subscribe: () => () => {} },
      subscribeWorkChanges: () => () => {},
      sessionOf: () => ({ epoch: "e1", status: "running" }),
      readGrid: async () => undefined,
      subscribeGrid: () => () => {},
    });
    const exit = await Effect.runPromiseExit(
      service.waitSeat({ target: "peer", until: "idle", timeoutMs: 25 }, caller),
    );
    expect(failure(exit)?.type).toBe("ScopeError");
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  it("waits on any authorized peer seat and ignores an unauthorized one", async () => {
    const withStranger = doc(
      [
        agentNode("caller", "bind-caller"),
        agentNode("peer", "bind-peer"),
        agentNode("stranger", "bind-stranger"),
      ],
      [edge("messages", "caller", "peer")],
    );
    const strangerOnly = makeHarness({
      doc: withStranger,
      sessionEpoch: "e1",
      seatEvents: [seatEvent({ bindingId: "bind-stranger", state: "idle" })],
    });
    const timedOut = await Effect.runPromiseExit(
      strangerOnly.service.waitSeat({ any: true, until: "idle", timeoutMs: 60 }, caller),
    );
    expect(failure(timedOut)?.type).toBe("Timeout");

    const peerIdle = makeHarness({
      doc: withStranger,
      sessionEpoch: "e1",
      seatEvents: [
        seatEvent({ bindingId: "bind-stranger", state: "idle" }),
        seatEvent({ bindingId: "bind-peer", state: "idle" }),
      ],
    });
    const answered = await Effect.runPromiseExit(
      peerIdle.service.waitSeat({ any: true, until: "idle", timeoutMs: 1_000 }, caller),
    );
    expect(Exit.isSuccess(answered)).toBe(true);
    if (Exit.isSuccess(answered)) expect(answered.value.target).toBe("peer");
  });

  it("refuses any when no peer edge holds the port", async () => {
    const harness = makeHarness({ doc: peerDoc([]), sessionEpoch: "e1" });
    const exit = await Effect.runPromiseExit(
      harness.service.waitSeat({ any: true, until: "idle", timeoutMs: 1_000 }, caller),
    );
    expect(failure(exit)?.type).toBe("ScopeError");
  });

  it("refuses a target that is not a managed seat", async () => {
    const harness = makeHarness({
      doc: doc(
        [
          agentNode("caller", "bind-caller"),
          { id: "peer", type: "text", text: "peer", x: 0, y: 0, width: 10, height: 10, ether: { entity: { kind: "agent", name: "peer" } } },
        ],
        [edge("messages", "caller", "peer")],
      ),
    });
    const exit = await Effect.runPromiseExit(
      harness.service.waitSeat({ target: "peer", until: "idle", timeoutMs: 1_000 }, caller),
    );
    expect(failure(exit)?.type).toBe("UnknownTarget");
  });

  it("refuses a managed seat that runs on another host", async () => {
    const harness = makeHarness({
      doc: doc(
        [
          agentNode("caller", "bind-caller"),
          agentNode("peer", "bind-peer", "station-b"),
        ],
        [edge("messages", "caller", "peer")],
      ),
      sessionEpoch: "e1",
      seatEvents: [seatEvent({ state: "idle" })],
    });
    const exit = await Effect.runPromiseExit(
      harness.service.waitSeat({ target: "peer", until: "idle", timeoutMs: 1_000 }, caller),
    );
    const error = failure(exit);
    expect(error?.type).toBe("ScopeError");
    expect(error?.details?.reason).toBe("crew-local-seat-only");
    expect(error?.details?.received).toBe("station-b");
  });

  it("refuses --any when every authorized peer is on another host", async () => {
    const harness = makeHarness({
      doc: doc(
        [
          agentNode("caller", "bind-caller"),
          agentNode("peer", "bind-peer", "station-b"),
        ],
        [edge("messages", "caller", "peer")],
      ),
      sessionEpoch: "e1",
      seatEvents: [seatEvent({ state: "idle" })],
    });
    const exit = await Effect.runPromiseExit(
      harness.service.waitSeat({ any: true, until: "idle", timeoutMs: 60 }, caller),
    );
    const error = failure(exit);
    expect(error?.type).toBe("ScopeError");
    expect(error?.details?.reason).toBe("crew-local-seat-only");
  });

  it("ignores a remote peer's matching state for --any", async () => {
    const harness = makeHarness({
      doc: doc(
        [
          agentNode("caller", "bind-caller"),
          agentNode("local-peer", "bind-local"),
          agentNode("remote-peer", "bind-remote", "station-b"),
        ],
        [edge("messages", "caller", "local-peer"), edge("messages", "caller", "remote-peer")],
      ),
      sessionEpoch: "e1",
      seatEvents: [seatEvent({ bindingId: "bind-remote", state: "idle" })],
    });
    const exit = await Effect.runPromiseExit(
      harness.service.waitSeat({ any: true, until: "idle", timeoutMs: 60 }, caller),
    );
    // The remote seat is authorized but not observable here, so the wait times
    // out rather than answering from another host's state.
    expect(failure(exit)?.type).toBe("Timeout");
  });
});

describe("seat.read", () => {
  it("returns the bounded settled window with sequence and generation", async () => {
    const harness = makeHarness({
      doc: peerDoc(),
      sessionEpoch: "e1",
      window: gridWindow({ lines: ["a", "b"], totalLines: 9, seq: 12n }),
    });
    const exit = await Effect.runPromiseExit(
      harness.service.readSeat({ target: "peer", lines: 2 }, caller),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toMatchObject({
        target: "peer",
        text: "a\nb",
        lineCount: 2,
        bytes: 3,
        seq: 12,
        epoch: "e1",
        generation: "e1",
        replaced: false,
        stopped: "not-following",
        truncated: false,
      });
    }
  });

  it("answers an empty window when the caller's cursor is already current", async () => {
    const harness = makeHarness({
      doc: peerDoc(),
      sessionEpoch: "e1",
      window: gridWindow({ seq: 12n }),
    });
    const exit = await Effect.runPromiseExit(
      harness.service.readSeat(
        { target: "peer", since: 12, sinceGeneration: "e1" },
        caller,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.text).toBe("");
      expect(exit.value.lineCount).toBe(0);
      expect(exit.value.seq).toBe(12);
      expect(exit.value.truncated).toBe(false);
    }
  });

  it("re-derives authority after the awaited grid read", async () => {
    const harness = makeHarness({
      doc: peerDoc(),
      sessionEpoch: "e1",
      window: gridWindow(),
      onReadGrid: (self) => self().setDoc(peerDoc([])),
    });
    const exit = await Effect.runPromiseExit(
      harness.service.readSeat({ target: "peer" }, caller),
    );
    expect(failure(exit)?.type).toBe("ScopeError");
  });

  it("reports a replaced generation instead of relabeling the old window", async () => {
    const harness = makeHarness({
      doc: peerDoc(),
      sessionEpoch: "e2",
      window: gridWindow({ epoch: "e1", lines: ["old stream"], seq: 9n }),
    });
    const exit = await Effect.runPromiseExit(
      harness.service.readSeat({ target: "peer" }, caller),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.epoch).toBe("e1");
      expect(exit.value.generation).toBe("e1");
      expect(exit.value.replaced).toBe(true);
      expect(exit.value.state).toBe("unknown");
      expect(exit.value.reason).toBe("generation_replaced");
    }
  });

  it("follow returns as soon as the settled grid advances", async () => {
    const harness = makeHarness({
      doc: peerDoc(),
      sessionEpoch: "e1",
      window: gridWindow({ seq: 5n }),
    });
    const pending = Effect.runPromiseExit(
      harness.service.readSeat({ target: "peer", follow: true, maxSeconds: 5 }, caller),
    );
    await settle();
    expect(harness.gridSubscribed()).toBe(true);
    harness.setWindow(gridWindow({ seq: 6n, lines: ["fresh output"] }));
    harness.emitGrid(gridSnapshot({ seq: 6n }));
    const exit = await pending;
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.stopped).toBe("advanced");
      expect(exit.value.text).toBe("fresh output");
      expect(exit.value.seq).toBe(6);
    }
    expect(harness.activeListeners()).toBe(0);
  });

  it("follow returns immediately when output already settled past the cursor", async () => {
    const harness = makeHarness({
      doc: peerDoc(),
      sessionEpoch: "e1",
      window: gridWindow({ seq: 9n, lines: ["catch up"] }),
    });
    const exit = await Effect.runPromiseExit(
      harness.service.readSeat(
        { target: "peer", follow: true, maxSeconds: 5, since: 4, sinceGeneration: "e1" },
        caller,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.stopped).toBe("advanced");
      expect(exit.value.text).toBe("catch up");
    }
  });

  it("follow ends at its duration bound on a quiet seat", async () => {
    const harness = makeHarness({
      doc: peerDoc(),
      sessionEpoch: "e1",
      window: gridWindow({ seq: 5n }),
    });
    const exit = await Effect.runPromiseExit(
      harness.service.readSeat({ target: "peer", follow: true, maxSeconds: 1 }, caller),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.stopped).toBe("duration");
    expect(harness.activeListeners()).toBe(0);
  });

  it("follow ends with ScopeError on a revoked edge instead of waiting out its duration", async () => {
    const harness = makeHarness({
      doc: peerDoc(),
      sessionEpoch: "e1",
      window: gridWindow({ seq: 5n }),
    });
    const pending = Effect.runPromiseExit(
      harness.service.readSeat({ target: "peer", follow: true, maxSeconds: 5 }, caller),
    );
    await settle();
    harness.setDoc(peerDoc([]));
    harness.emitCanvas("c");
    const exit = await pending;
    expect(failure(exit)?.type).toBe("ScopeError");
    expect(harness.activeListeners()).toBe(0);
  });

  it("follow reports an explicit replacement when the generation moves", async () => {
    const harness = makeHarness({
      doc: peerDoc(),
      sessionEpoch: "e1",
      window: gridWindow({ seq: 5n }),
    });
    const pending = Effect.runPromiseExit(
      harness.service.readSeat(
        { target: "peer", follow: true, maxSeconds: 5, since: 5, sinceGeneration: "e1" },
        caller,
      ),
    );
    await settle();
    harness.setWindow(gridWindow({ epoch: "e2", seq: 1n, lines: ["replacement"] }));
    harness.emitGrid(gridSnapshot({ epoch: "e2", seq: 1n }));
    const exit = await pending;
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.stopped).toBe("replaced");
      expect(exit.value.replaced).toBe(true);
      expect(exit.value.epoch).toBe("e2");
      expect(exit.value.text).toBe("replacement");
    }
  });

  it("refuses to read a managed seat that runs on another host", async () => {
    const harness = makeHarness({
      doc: doc(
        [
          agentNode("caller", "bind-caller"),
          agentNode("peer", "bind-peer", "station-b"),
        ],
        [edge("messages", "caller", "peer")],
      ),
      sessionEpoch: "e1",
      window: gridWindow({ lines: ["remote screen"] }),
    });
    const exit = await Effect.runPromiseExit(
      harness.service.readSeat({ target: "peer" }, caller),
    );
    const error = failure(exit);
    expect(error?.type).toBe("ScopeError");
    expect(error?.details?.reason).toBe("crew-local-seat-only");
    // Nothing was read: the refusal is up front, not a fallback to a stale grid.
    expect(harness.gridReads()).toBe(0);
  });

  it("clips the window to the byte bound and says so", async () => {
    const harness = makeHarness({
      doc: peerDoc(),
      sessionEpoch: "e1",
      window: gridWindow({ lines: ["x".repeat(200), "tail"] }),
    });
    const exit = await Effect.runPromiseExit(
      harness.service.readSeat({ target: "peer" }, caller),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.bytes).toBeLessThanOrEqual(64 * 1024);
      expect(exit.value.text.endsWith("tail")).toBe(true);
    }
  });
});

describe("tasks.wait", () => {
  const taskDoc = (state: TaskState, epoch = 1) =>
    doc(
      [agentNode("caller", "bind-caller"), taskSinkNode([{ id: "t1", state, epoch }])],
      [edge("contributes", "caller", "sink")],
    );

  it("answers immediately when the task is already in the requested state", async () => {
    const harness = makeHarness({ doc: taskDoc("completed", 3) });
    const exit = await Effect.runPromiseExit(
      harness.service.waitTask(
        { target: "sink", taskId: "t1", until: "completed", timeoutMs: 1_000 },
        caller,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value).toEqual({
        taskId: "t1",
        state: "completed",
        epoch: 3,
        at: expect.any(Number),
      });
    }
  });

  it("does not lose a transition that lands between the check and the subscription", async () => {
    let reads = 0;
    let state: TaskState = "working";
    const service = makeSeatObservation({
      readDoc: () => {
        reads += 1;
        const snapshot = taskDoc(state);
        if (reads === 1) state = "completed";
        return Effect.succeed(snapshot);
      },
      subscribeCanvasChanges: () => () => {},
      seatStates: { current: () => [], subscribe: () => () => {} },
      subscribeWorkChanges: () => () => {},
      sessionOf: () => undefined,
      readGrid: async () => undefined,
      subscribeGrid: () => () => {},
    });
    const exit = await Effect.runPromiseExit(
      service.waitTask(
        { target: "sink", taskId: "t1", until: "completed", timeoutMs: 120 },
        caller,
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value.state).toBe("completed");
  });

  it("wakes on a work change for its own canvas", async () => {
    const harness = makeHarness({ doc: taskDoc("working") });
    const pending = Effect.runPromiseExit(
      harness.service.waitTask(
        { target: "sink", taskId: "t1", until: "rejected", timeoutMs: 5_000 },
        caller,
      ),
    );
    await settle();
    harness.setDoc(taskDoc("rejected", 2));
    harness.emitWork("c", "sink");
    const exit = await pending;
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) expect(exit.value).toEqual({ taskId: "t1", state: "rejected", epoch: 2, at: expect.any(Number) });
  });

  it("times out with the last observed state", async () => {
    const harness = makeHarness({ doc: taskDoc("working", 4) });
    const exit = await Effect.runPromiseExit(
      harness.service.waitTask(
        { target: "sink", taskId: "t1", until: "completed", timeoutMs: 60 },
        caller,
      ),
    );
    const error = failure(exit);
    expect(error?.type).toBe("Timeout");
    expect(error?.details?.from).toBe("working");
    expect(error?.details?.to).toBe("completed");
  });

  it("fails ScopeError on a revoked task edge without waiting for a mutation", async () => {
    const harness = makeHarness({ doc: taskDoc("working") });
    const pending = Effect.runPromiseExit(
      harness.service.waitTask(
        { target: "sink", taskId: "t1", until: "completed", timeoutMs: 5_000 },
        caller,
      ),
    );
    await settle();
    harness.setDoc(doc([agentNode("caller", "bind-caller"), taskSinkNode([{ id: "t1", state: "working" }])], []));
    harness.emitCanvas("c");
    const exit = await pending;
    expect(failure(exit)?.type).toBe("ScopeError");
    expect(harness.activeListeners()).toBe(0);
  });

  it("refuses a task that is not on the named sink", async () => {
    const harness = makeHarness({ doc: taskDoc("working") });
    const exit = await Effect.runPromiseExit(
      harness.service.waitTask(
        { target: "sink", taskId: "nope", until: "completed", timeoutMs: 1_000 },
        caller,
      ),
    );
    expect(failure(exit)?.type).toBe("UnknownTarget");
  });
});
