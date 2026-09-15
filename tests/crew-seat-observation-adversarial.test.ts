import { Cause, Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "../src/shared/canvas";
import type { AgentSeatStateEvent } from "../src/shared/agent-seat-state";
import type {
  ObserverGridSnapshot,
  ObserverGridWindow,
} from "../src/main/vellum-command/term/observer";
import { makeSeatObservation } from "../src/main/vellum-command/work/seat-observation";

// Independent adversarial seam tests for the seat wait/observe contract
// (docs/crew-contract.md). The service's own rules: authority is re-derived
// from a fresh live document before an event is accepted and before every
// return; subscriptions register before the current value is checked.

const agentNode = (id: string, bindingId: string): CanvasNode => ({
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
  },
});

const taskSinkNode = (
  items: ReadonlyArray<{
    id: string;
    state:
      | "submitted"
      | "working"
      | "input-required"
      | "completed"
      | "canceled"
      | "failed"
      | "rejected"
      | "auth-required"
      | "archived";
    epoch?: number;
  }>,
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
    tasks: { items: items.map((i) => ({ history: [], ...i })) },
  },
});

const messagesEdge: CanvasEdge = {
  id: "e-msg",
  fromNode: "caller",
  toNode: "peer",
  ether: { verb: "messages" },
};

const contributesEdge: CanvasEdge = {
  id: "e-task",
  fromNode: "caller",
  toNode: "sink",
  ether: { verb: "contributes" },
};

const docWith = (
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
): CanvasDoc => ({ nodes: [...nodes], edges: [...edges] });

type Harness = {
  readonly service: ReturnType<typeof makeSeatObservation>;
  readonly setDoc: (doc: CanvasDoc) => void;
  readonly emitCanvas: (name: string) => void;
  readonly emitSeat: (event: AgentSeatStateEvent) => void;
  readonly emitGrid: (snapshot: ObserverGridSnapshot) => void;
  readonly emitWork: (canvasName?: string, nodeId?: string) => void;
  readonly gridSubscribed: () => boolean;
  readonly seatSubscribed: () => boolean;
};

const makeHarness = (input: {
  doc: CanvasDoc;
  seatEvents?: ReadonlyArray<AgentSeatStateEvent>;
  sessionEpoch?: string;
  window?: ObserverGridWindow;
  workListenersFire?: boolean;
}): Harness => {
  let doc = input.doc;
  let seatEvents = [...(input.seatEvents ?? [])];
  const canvasListeners = new Set<(name: string) => void>();
  const seatListeners = new Set<(e: AgentSeatStateEvent) => void>();
  const gridListeners = new Set<(s: ObserverGridSnapshot) => void>();
  const workListeners = new Set<
    (canvasName: string | undefined, nodeId: string | undefined) => void
  >();
  let gridSubscribed = false;
  let seatSubscribed = false;

  const service = makeSeatObservation({
    readDoc: () => Effect.succeed(doc),
    subscribeCanvasChanges: (listener) => {
      canvasListeners.add(listener);
      return () => canvasListeners.delete(listener);
    },
    seatStates: {
      current: () => seatEvents,
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
    readGrid: async () => input.window,
    subscribeGrid: (listener) => {
      gridSubscribed = true;
      gridListeners.add(listener);
      return () => gridListeners.delete(listener);
    },
  });

  return {
    service,
    setDoc: (next) => {
      doc = next;
    },
    emitCanvas: (name) => {
      for (const l of canvasListeners) l(name);
    },
    emitSeat: (event) => {
      seatEvents = [...seatEvents.filter((e) => e.bindingId !== event.bindingId), event];
      for (const l of seatListeners) l(event);
    },
    emitGrid: (snapshot) => {
      for (const l of gridListeners) l(snapshot);
    },
    emitWork: (canvasName, nodeId) => {
      for (const l of workListeners) l(canvasName, nodeId);
    },
    gridSubscribed: () => gridSubscribed,
    seatSubscribed: () => seatSubscribed,
  };
};

const failureOf = (exit: Exit.Exit<unknown, { type?: string }>): { type?: string } | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const found = Cause.findFail(exit.cause);
  if (found._tag !== "Success") return undefined;
  const reason = found.success;
  return reason._tag === "Fail" ? reason.error : undefined;
};

const settle = async (ms = 40): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

const seatEvent = (
  over: Partial<AgentSeatStateEvent> = {},
): AgentSeatStateEvent => ({
  bindingId: "bind-peer",
  epoch: "e1",
  state: "idle",
  reason: "settled",
  confidence: "high",
  at: 1,
  ...over,
});

describe("crew seat observation — adversarial authority and ordering", () => {
  // Contract: "subscriptions are registered before the current value is
  // checked, so a transition that lands during registration cannot be lost."
  // The wait must observe a transition that lands in the narrow window
  // between its first check and subscription registration.
  it(
    "tasks.wait does not lose a transition landing between check and subscribe",
    async () => {
      let taskState: "working" | "completed" = "working";
      const doc = () =>
        docWith(
          [agentNode("caller", "bind-caller"), taskSinkNode([{ id: "t1", state: taskState, epoch: 1 }])],
          [contributesEdge],
        );
      const workListeners = new Set<
        (canvasName: string | undefined, nodeId: string | undefined) => void
      >();
      let readCount = 0;
      const service = makeSeatObservation({
        // The first read still shows "working", then the mutation lands —
        // before the wait's subscription registers. No further change event
        // arrives, which is exactly the steady-state case the ordering rule
        // exists for.
        readDoc: () => {
          readCount += 1;
          const snapshot = doc();
          if (readCount === 1) taskState = "completed";
          return Effect.succeed(snapshot);
        },
        subscribeCanvasChanges: () => () => {},
        seatStates: { current: () => [], subscribe: () => () => {} },
        subscribeWorkChanges: (listener) => {
          workListeners.add(listener);
          return () => workListeners.delete(listener);
        },
        sessionOf: () => undefined,
        readGrid: async () => undefined,
        subscribeGrid: () => () => {},
      });
      const exit = await Effect.runPromiseExit(
        service.waitTask(
          { target: "sink", taskId: "t1", until: "completed", timeoutMs: 90 },
          { canvasName: "c", nodeId: "caller" },
        ),
      );
      expect(Exit.isSuccess(exit)).toBe(true);
    },
  );

  // Contract: authority is re-derived before EVERY return. A settled window
  // must not reach the caller when the edge died before the return — even
  // when the canvas-change event has not dispatched to this wait yet.
  it(
    "seat.read --follow re-derives authority before returning settled text",
    async () => {
      const authorized = docWith(
        [agentNode("caller", "bind-caller"), agentNode("peer", "bind-peer")],
        [messagesEdge],
      );
      const revoked = docWith(
        [agentNode("caller", "bind-caller"), agentNode("peer", "bind-peer")],
        [],
      );
      const harness = makeHarness({
        doc: authorized,
        sessionEpoch: "e1",
        window: gridWindow({ seq: 1n }),
      });
      const pending = Effect.runPromiseExit(
        harness.service.readSeat(
          { target: "peer", follow: true, maxSeconds: 5 },
          { canvasName: "c", nodeId: "caller" },
        ),
      );
      await settle(60);
      expect(harness.gridSubscribed()).toBe(true);
      // The edge is gone; the canvas-change event has not dispatched yet —
      // the return path must not trust the subscription to have seen it.
      harness.setDoc(revoked);
      harness.emitGrid({
        bindingId: "bind-peer",
        epoch: "e1",
        cols: 80,
        rows: 24,
        seq: 2n,
        lines: ["post-revocation screen"],
        text: "post-revocation screen",
        signals: { title: "", osc9: "", modes: {} as never },
      });
      const exit = await pending;
      // Correct behavior is a ScopeError (re-derived authority), not screen
      // text returned under a dead grant.
      expect(Exit.isFailure(exit)).toBe(true);
    },
  );

  it("seat.wait ends with ScopeError when the edge is revoked mid-wait", async () => {
    const authorized = docWith(
      [agentNode("caller", "bind-caller"), agentNode("peer", "bind-peer")],
      [messagesEdge],
    );
    const revoked = docWith(
      [agentNode("caller", "bind-caller"), agentNode("peer", "bind-peer")],
      [],
    );
    const harness = makeHarness({ doc: authorized, sessionEpoch: "e1" });
    const pending = Effect.runPromiseExit(
      harness.service.waitSeat(
        { target: "peer", until: "idle", timeoutMs: 5_000 },
        { canvasName: "c", nodeId: "caller" },
      ),
    );
    await settle(60);
    expect(harness.seatSubscribed()).toBe(true);
    harness.setDoc(revoked);
    harness.emitCanvas("c");
    const exit = await pending;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = failureOf(exit);
      expect(error?.type).toBe("ScopeError");
    }
  });

  it("seat.wait ignores a seat event from a dead generation", async () => {
    const harness = makeHarness({
      doc: docWith(
        [agentNode("caller", "bind-caller"), agentNode("peer", "bind-peer")],
        [messagesEdge],
      ),
      sessionEpoch: "e2",
      seatEvents: [seatEvent({ epoch: "e1", state: "idle" })],
    });
    const exit = await Effect.runPromiseExit(
      harness.service.waitSeat(
        { target: "peer", until: "idle", timeoutMs: 90 },
        { canvasName: "c", nodeId: "caller" },
      ),
    );
    // The stale-epoch idle event must not satisfy the wait: Timeout is the
    // honest outcome here.
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = failureOf(exit);
      expect(error?.type).toBe("Timeout");
    }
  });

  it("seat.wait fails closed when the edge dies between event and answer", async () => {
    const authorized = docWith(
      [agentNode("caller", "bind-caller"), agentNode("peer", "bind-peer")],
      [messagesEdge],
    );
    const revoked = docWith(
      [agentNode("caller", "bind-caller"), agentNode("peer", "bind-peer")],
      [],
    );
    let reads = 0;
    const workListeners = new Set<
      (canvasName: string | undefined, nodeId: string | undefined) => void
    >();
    const service = makeSeatObservation({
      // First read resolves targets; by the post-event revalidation the
      // edge is gone — the answer must be ScopeError, not the stale match.
      readDoc: () => {
        reads += 1;
        return Effect.succeed(reads === 1 ? authorized : revoked);
      },
      subscribeCanvasChanges: () => () => {},
      seatStates: {
        current: () => [],
        subscribe: (listener) => {
          // Deliver the matching event synchronously at registration.
          listener(seatEvent({ epoch: "e1", state: "idle" }));
          return () => {};
        },
      },
      subscribeWorkChanges: (listener) => {
        workListeners.add(listener);
        return () => workListeners.delete(listener);
      },
      sessionOf: () => ({ epoch: "e1", status: "running" }),
      readGrid: async () => undefined,
      subscribeGrid: () => () => {},
    });
    const exit = await Effect.runPromiseExit(
      service.waitSeat(
        { target: "peer", until: "idle", timeoutMs: 5_000 },
        { canvasName: "c", nodeId: "caller" },
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = failureOf(exit);
      expect(error?.type).toBe("ScopeError");
    }
  });

  it("seat.wait returns the observed state for a live-generation match", async () => {
    const harness = makeHarness({
      doc: docWith(
        [agentNode("caller", "bind-caller"), agentNode("peer", "bind-peer")],
        [messagesEdge],
      ),
      sessionEpoch: "e1",
      seatEvents: [seatEvent({ epoch: "e1", state: "idle" })],
    });
    const exit = await Effect.runPromiseExit(
      harness.service.waitSeat(
        { target: "peer", until: "idle", timeoutMs: 1_000 },
        { canvasName: "c", nodeId: "caller" },
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.state).toBe("idle");
      expect(exit.value.epoch).toBe("e1");
      expect(exit.value.generation).toBe("e1");
    }
  });

  it("seat.read reports a replaced generation instead of concatenating", async () => {
    const harness = makeHarness({
      doc: docWith(
        [agentNode("caller", "bind-caller"), agentNode("peer", "bind-peer")],
        [messagesEdge],
      ),
      sessionEpoch: "e2",
      window: gridWindow({ epoch: "e2", seq: 4n, lines: ["new stream"] }),
    });
    const exit = await Effect.runPromiseExit(
      harness.service.readSeat(
        { target: "peer", since: 9, sinceGeneration: "e1" },
        { canvasName: "c", nodeId: "caller" },
      ),
    );
    expect(Exit.isSuccess(exit)).toBe(true);
    if (Exit.isSuccess(exit)) {
      expect(exit.value.replaced).toBe(true);
      expect(exit.value.epoch).toBe("e2");
      expect(exit.value.stopped).toBe("not-following");
    }
  });
});
