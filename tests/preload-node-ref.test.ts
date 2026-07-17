import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  NodeRefOpenedDelivery,
  NodeRefOpenedEvent,
  VellumApi,
  VellumBrowserAutomationApi,
} from "../src/shared/ipc";
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

const loadPreload = async (): Promise<VellumApi & VellumBrowserAutomationApi> => {
  await import("../src/preload/index");
  const api = electron.exposed.get("vellum") as
    | (VellumApi & VellumBrowserAutomationApi)
    | undefined;
  if (api === undefined) throw new Error("preload did not expose Vellum API");
  return api;
};

const emit = (payload: unknown): void => {
  const listener = electron.handlers.get(IPC_CHANNELS.nodeRefOpened);
  if (listener === undefined) throw new Error("preload did not register node-ref ingress");
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

describe("preload node-reference delivery", () => {
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

describe("preload browser automation bridge", () => {
  it("exposes only enable, list, and revoke request arguments", async () => {
    const api = await loadPreload();
    const ref = formatNodeRef({ canvasName: "portfolio", nodeId: "page" });
    const automationId = "00000000-0000-4000-8000-000000000001";

    await api.browserAutomationEnable({ kind: "hermes", ref });
    await api.browserAutomationEnable({ kind: "herdr", ref, agent: "codex" });
    await api.browserAutomationList();
    await api.browserAutomationRevoke(automationId);

    expect(electron.invoked).toEqual([
      [IPC_CHANNELS.browserAutomationEnable, { kind: "hermes", ref }],
      [IPC_CHANNELS.browserAutomationEnable, { kind: "herdr", ref, agent: "codex" }],
      [IPC_CHANNELS.browserAutomationList],
      [IPC_CHANNELS.browserAutomationRevoke, automationId],
    ]);
  });
});
