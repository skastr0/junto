import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NodeRefOpenedDelivery,
  NodeRefOpenedEvent,
  JuntoApi,
  JuntoHostsApi,
} from "../src/shared/ipc";
import type { CanvasDoc } from "../src/shared/canvas";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { formatNodeRef } from "../src/shared/node-ref";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => void>(),
  exposed: new Map<string, unknown>(),
  sent: [] as Array<ReadonlyArray<unknown>>,
  invoked: [] as Array<ReadonlyArray<unknown>>,
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => electron.exposed.set(name, value),
  },
  ipcRenderer: {
    invoke: (...args: ReadonlyArray<unknown>) => {
      electron.invoked.push(args);
      return Promise.resolve(undefined);
    },
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      electron.handlers.set(channel, listener);
    },
    removeListener: vi.fn(),
    send: (...args: ReadonlyArray<unknown>) => electron.sent.push(args),
  },
}));

const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const delivery = (nodeId: string, deliveryId: string): NodeRefOpenedDelivery => ({
  ref: formatNodeRef({ canvasName: "portfolio", nodeId }),
  canvasName: "portfolio",
  nodeId,
  deliveryId,
});

const loadPreload = async (): Promise<JuntoApi> => {
  await import("../src/preload/index");
  const api = electron.exposed.get("junto") as JuntoApi | undefined;
  if (api === undefined) throw new Error("preload did not expose Junto API");
  return api;
};

const emit = (payload: unknown): void => {
  const listener = electron.handlers.get(IPC_CHANNELS.nodeRefOpened);
  if (listener === undefined) throw new Error("preload did not register node-ref ingress");
  listener({}, payload);
};

const emitCanvasFlush = (payload: unknown): void => {
  const listener = electron.handlers.get(IPC_CHANNELS.canvasFlushRequested);
  if (listener === undefined) throw new Error("preload did not register canvas flush ingress");
  listener({}, payload);
};

const emitCanvasQuiesceAndFlush = (payload: unknown): void => {
  const listener = electron.handlers.get(IPC_CHANNELS.canvasQuiesceAndFlushRequested);
  if (listener === undefined) throw new Error("preload did not register canvas quiesce ingress");
  listener({}, payload);
};

const emitRendererSurfaceChallenge = (payload: unknown): void => {
  const listener = electron.handlers.get(IPC_CHANNELS.rendererSurfaceChallenge);
  if (listener === undefined) throw new Error("preload did not register renderer challenge ingress");
  listener({}, payload);
};

const settle = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  vi.resetModules();
  electron.handlers.clear();
  electron.exposed.clear();
  electron.sent.length = 0;
  electron.invoked.length = 0;
});

describe("preload renderer surface readiness", () => {
  it("answers a challenge only after the React surface reports its commit", async () => {
    const api = await loadPreload();

    emitRendererSurfaceChallenge("generation-1");
    expect(electron.sent).toEqual([]);

    api.rendererSurfaceReady();
    expect(electron.sent).toEqual([
      [IPC_CHANNELS.rendererSurfaceReady, "generation-1"],
    ]);
  });

  it("never carries a previous preload challenge into a fresh module generation", async () => {
    const first = await loadPreload();
    emitRendererSurfaceChallenge("generation-1");
    first.rendererSurfaceReady();
    expect(electron.sent).toEqual([
      [IPC_CHANNELS.rendererSurfaceReady, "generation-1"],
    ]);

    vi.resetModules();
    electron.handlers.clear();
    electron.exposed.clear();
    electron.sent.length = 0;
    const replacement = await loadPreload();
    replacement.rendererSurfaceReady();
    expect(electron.sent).toEqual([]);

    emitRendererSurfaceChallenge("generation-2");
    expect(electron.sent).toEqual([
      [IPC_CHANNELS.rendererSurfaceReady, "generation-2"],
    ]);
  });

  it("ignores malformed challenges", async () => {
    const api = await loadPreload();
    api.rendererSurfaceReady();
    emitRendererSurfaceChallenge(1);
    emitRendererSurfaceChallenge("");
    expect(electron.sent).toEqual([]);
  });
});

describe("preload Remote deployment authorization", () => {
  it("forwards host id only — no administrator password payload", async () => {
    const api = (await loadPreload()) as JuntoApi &
      Partial<JuntoHostsApi>;
    const input = { id: "studio" };
    if (!api.hostsDeployRemote) {
      throw new Error("hostsDeployRemote missing from all-on preload");
    }

    await api.hostsDeployRemote(input);

    expect(electron.invoked).toEqual([
      [IPC_CHANNELS.hostsDeployRemote, input],
    ]);
    expect(JSON.stringify(electron.invoked)).not.toContain(
      "linux-administrator-password",
    );
    expect(JSON.stringify(electron.invoked)).not.toContain("password");
  });
});

describe("preload node-reference delivery", () => {
  it("does not expose the product bridge to a remote document", async () => {
    const prior = Object.getOwnPropertyDescriptor(globalThis, "location");
    Object.defineProperty(globalThis, "location", {
      configurable: true,
      value: { href: "https://attacker.invalid/" },
    });
    try {
      await import("../src/preload/index");
      expect(electron.exposed.has("junto")).toBe(false);
      expect(electron.exposed.has("chassis")).toBe(false);
    } finally {
      if (prior === undefined) delete (globalThis as { location?: unknown }).location;
      else Object.defineProperty(globalThis, "location", prior);
    }
  });

  it("buffers one delivery and acknowledges only after renderer focus resolves", async () => {
    const api = await loadPreload();
    const target = delivery("page", "00000000-0000-4000-8000-000000000001");
    const focused = deferred();
    const listener = vi.fn(() => focused.promise);

    emit(target);
    expect(electron.sent).toEqual([]);

    api.onNodeRefOpened(listener);
    expect(listener).toHaveBeenCalledWith({
      ref: target.ref,
      canvasName: target.canvasName,
      nodeId: target.nodeId,
    });
    expect(electron.sent).toEqual([]);

    focused.resolve();
    await settle();
    expect(electron.sent).toEqual([[IPC_CHANNELS.nodeRefOpenedAck, target.deliveryId]]);
  });

  it("dispatches a newer delivery immediately and never acknowledges the superseded one", async () => {
    const api = await loadPreload();
    const older = delivery("older", "00000000-0000-4000-8000-000000000001");
    const newer = delivery("newer", "00000000-0000-4000-8000-000000000002");
    const olderFocus = deferred();
    const newerFocus = deferred();
    const firstListener = vi.fn((event: { readonly nodeId: string }) =>
      event.nodeId === "older" ? olderFocus.promise : newerFocus.promise,
    );
    const unsubscribe = api.onNodeRefOpened(firstListener);

    emit(older);
    emit(newer);
    expect(firstListener.mock.calls.map(([event]) => event.nodeId)).toEqual(["older", "newer"]);

    olderFocus.resolve();
    newerFocus.reject(new Error("focus interrupted"));
    await settle();
    expect(electron.sent).toEqual([]);

    unsubscribe();
    const retry = vi.fn(async (_event: NodeRefOpenedEvent) => undefined);
    api.onNodeRefOpened(retry);
    await settle();

    expect(retry).toHaveBeenCalledOnce();
    expect(retry.mock.calls[0]?.[0]).toMatchObject({ nodeId: "newer" });
    expect(electron.sent).toEqual([[IPC_CHANNELS.nodeRefOpenedAck, newer.deliveryId]]);
  });

  it("drops malformed or identity-substituted envelopes without superseding the buffer", async () => {
    const api = await loadPreload();
    const valid = delivery("page", "00000000-0000-4000-8000-000000000001");
    emit(valid);
    emit({ ...valid, nodeId: "substituted" });
    emit({ ...valid, deliveryId: "not-a-delivery-id" });

    const listener = vi.fn(async (_event: NodeRefOpenedEvent) => undefined);
    api.onNodeRefOpened(listener);
    await settle();

    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]?.[0]).toMatchObject({ nodeId: "page" });
    expect(electron.sent).toEqual([[IPC_CHANNELS.nodeRefOpenedAck, valid.deliveryId]]);
  });
});

describe("preload canvas close gate", () => {
  it("acknowledges close only after the renderer save flush resolves", async () => {
    const api = await loadPreload();
    const flushed = deferred();
    api.onCanvasFlushRequested(() => flushed.promise);

    emitCanvasFlush({ requestId: "00000000-0000-4000-8000-000000000010" });
    expect(electron.sent).toEqual([]);

    flushed.resolve();
    await settle();
    expect(electron.sent).toEqual([
      [
        IPC_CHANNELS.canvasFlushComplete,
        { requestId: "00000000-0000-4000-8000-000000000010", ok: true },
      ],
    ]);
  });

  it("rejects close when the renderer save flush fails", async () => {
    const api = await loadPreload();
    api.onCanvasFlushRequested(async () => {
      throw new Error("revision conflict");
    });

    emitCanvasFlush({ requestId: "00000000-0000-4000-8000-000000000011" });
    await settle();
    expect(electron.sent).toEqual([
      [
        IPC_CHANNELS.canvasFlushComplete,
        { requestId: "00000000-0000-4000-8000-000000000011", ok: false },
      ],
    ]);
  });
});

describe("preload canvas quiesce gate", () => {
  it("sends canvas write/create with a fixed wire shape in and out of the flush", async () => {
    const api = await loadPreload();
    const doc = { nodes: [], edges: [] } as CanvasDoc;

    // The renderer can pass surplus arguments; preload's fixed arity drops them
    // so nothing beyond the declared canvas payload ever crosses the boundary.
    await (api.writeCanvas as unknown as (...args: ReadonlyArray<unknown>) => Promise<unknown>)(
      "ordinary",
      doc,
      "r0",
      { surplus: true },
    );
    await (api.createCanvas as unknown as (...args: ReadonlyArray<unknown>) => Promise<unknown>)(
      "ordinary-create",
      { surplus: true },
    );
    expect(electron.invoked).toEqual([
      [IPC_CHANNELS.writeCanvas, "ordinary", doc, "r0"],
      [IPC_CHANNELS.createCanvas, "ordinary-create"],
    ]);
    electron.invoked.length = 0;

    const durable = deferred();
    api.onCanvasQuiesceAndFlushRequested(async (acknowledgeQuiesced) => {
      acknowledgeQuiesced();
      await api.writeCanvas("final", doc, "r1");
      await api.createCanvas("final-create");
      await durable.promise;
      return { ok: true, quiesced: true };
    });

    const requestId = "00000000-0000-4000-8000-000000000020";
    emitCanvasQuiesceAndFlush({ requestId });
    await settle();

    // The quit flush rides the ordinary channels: main's one-way authoring gate
    // is the only thing that admits it, so preload adds nothing to the wire.
    expect(electron.invoked).toEqual([
      [IPC_CHANNELS.writeCanvas, "final", doc, "r1"],
      [IPC_CHANNELS.createCanvas, "final-create"],
    ]);

    durable.resolve();
    await settle();
    electron.invoked.length = 0;
    await api.writeCanvas("after-finally", doc, "r2");
    await api.createCanvas("after-finally-create");
    expect(electron.invoked).toEqual([
      [IPC_CHANNELS.writeCanvas, "after-finally", doc, "r2"],
      [IPC_CHANNELS.createCanvas, "after-finally-create"],
    ]);
  });

  it("refuses overlapping and replayed quiesce deliveries without rebinding authority", async () => {
    const api = await loadPreload();
    const durable = deferred();
    const listener = vi.fn(async () => {
      await durable.promise;
      return { ok: true, quiesced: true } as const;
    });
    api.onCanvasQuiesceAndFlushRequested(listener);

    const activeRequestId = "00000000-0000-4000-8000-000000000021";
    const overlapRequestId = "00000000-0000-4000-8000-000000000022";
    emitCanvasQuiesceAndFlush({ requestId: activeRequestId });
    emitCanvasQuiesceAndFlush({ requestId: overlapRequestId });
    emitCanvasQuiesceAndFlush({ requestId: activeRequestId });

    expect(listener).toHaveBeenCalledOnce();
    expect(electron.sent).toEqual([
      [
        IPC_CHANNELS.canvasQuiesceAndFlushComplete,
        { requestId: overlapRequestId, ok: false, quiesced: false },
      ],
    ]);

    durable.resolve();
    await settle();
    emitCanvasQuiesceAndFlush({ requestId: overlapRequestId });
    emitCanvasQuiesceAndFlush({ requestId: activeRequestId });

    expect(listener).toHaveBeenCalledOnce();
    expect(electron.sent.at(-1)).toEqual([
      IPC_CHANNELS.canvasQuiesceAndFlushComplete,
      { requestId: activeRequestId, ok: false, quiesced: false },
    ]);
  });

  it("keeps signal quiesce distinct and acknowledges only after renderer durability", async () => {
    const api = await loadPreload();
    const ordinaryFlush = vi.fn(async () => undefined);
    api.onCanvasFlushRequested(ordinaryFlush);
    const durable = deferred();
    const quiesce = vi.fn(async (acknowledgeQuiesced: () => void) => {
      acknowledgeQuiesced();
      await durable.promise;
      return { ok: true, quiesced: true } as const;
    });
    api.onCanvasQuiesceAndFlushRequested(quiesce);

    emitCanvasQuiesceAndFlush({
      requestId: "00000000-0000-4000-8000-000000000012",
    });
    expect(quiesce).toHaveBeenCalledOnce();
    expect(ordinaryFlush).not.toHaveBeenCalled();
    expect(electron.sent).toEqual([
      [
        IPC_CHANNELS.canvasQuiesceAndFlushStarted,
        { requestId: "00000000-0000-4000-8000-000000000012" },
      ],
    ]);

    durable.resolve();
    await settle();
    expect(electron.sent).toEqual([
      [
        IPC_CHANNELS.canvasQuiesceAndFlushStarted,
        { requestId: "00000000-0000-4000-8000-000000000012" },
      ],
      [
        IPC_CHANNELS.canvasQuiesceAndFlushComplete,
        {
          requestId: "00000000-0000-4000-8000-000000000012",
          ok: true,
          quiesced: true,
        },
      ],
    ]);
  });

  it("buffers a cold request and never lets a result retract its Started receipt", async () => {
    const api = await loadPreload();
    emitCanvasQuiesceAndFlush({
      requestId: "00000000-0000-4000-8000-000000000013",
    });
    expect(electron.sent).toEqual([]);

    api.onCanvasQuiesceAndFlushRequested(async (acknowledgeQuiesced) => {
      acknowledgeQuiesced();
      return { ok: false, quiesced: false };
    });
    await settle();

    expect(electron.sent).toEqual([
      [
        IPC_CHANNELS.canvasQuiesceAndFlushStarted,
        { requestId: "00000000-0000-4000-8000-000000000013" },
      ],
      [
        IPC_CHANNELS.canvasQuiesceAndFlushComplete,
        {
          requestId: "00000000-0000-4000-8000-000000000013",
          ok: false,
          quiesced: true,
        },
      ],
    ]);
  });

  it("reports a listener failure before it acknowledges gate closure as recoverable", async () => {
    const api = await loadPreload();
    api.onCanvasQuiesceAndFlushRequested(async () => {
      throw new Error("listener failed after an unknown boundary");
    });

    emitCanvasQuiesceAndFlush({
      requestId: "00000000-0000-4000-8000-000000000014",
    });
    await settle();

    expect(electron.sent).toEqual([
      [
        IPC_CHANNELS.canvasQuiesceAndFlushComplete,
        {
          requestId: "00000000-0000-4000-8000-000000000014",
          ok: false,
          quiesced: false,
        },
      ],
    ]);
  });
});

describe("preload browser automation bridge", () => {
  it("does not expose enable/list/revoke — process-bind replaced the ceremony", async () => {
    const api = await loadPreload();
    // Ceremony deleted (process-bind + edges only). Public DTO surface is gone too.
    const keys = Object.keys(api);
    expect(keys).not.toContain("browserAutomationEnable");
    expect(keys).not.toContain("browserAutomationList");
    expect(keys).not.toContain("browserAutomationRevoke");
  });
});
