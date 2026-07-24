import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMain, IpcMainInvokeEvent, WebContents } from "electron";
import { IPC_CHANNELS, type HerdrStreamEvent } from "../src/shared/ipc";
import type { HerdrMirrorRegistry } from "../src/main/vellum/herdr/mirrors";
import type { HerdrObservePool } from "../src/main/vellum/herdr/observe-pool";
import type { HerdrService } from "../src/main/vellum/herdr/service";
import type { HerdrStreamManager } from "../src/main/vellum/herdr/stream";
import { HerdrServiceMap } from "../src/main/vellum/herdr/service-map";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp",
    getName: () => "vellum-test",
    isReady: () => true,
    whenReady: () => Promise.resolve(),
    on: () => undefined,
    once: () => undefined,
  },
  ipcMain: { handle: () => undefined, on: () => undefined },
  BrowserWindow: class {},
}));

// Defer ipc import until after electron mock (bun evaluates imports first otherwise).
const { registerHerdrIpc } = await import("../src/main/vellum/herdr/ipc");

// registerHerdrIpc resolves its plane through the app-wide AppRuntime
// singleton (../../runtime relative to ipc.ts === src/main/runtime.ts).
// Mocking that module — the same idiom tests/region-rollup-service.test.ts
// uses for HerdrPlane, just applied through vi.mock since registerHerdrIpc
// does not take an injectable plane — swaps in a fake HerdrPlane without
// booting the real ssh/hermes layer stack.
// Mutable spies shared with the runtime mock (no vi.hoisted — bun).
const productSpies = {
  openProduct: vi.fn(),
  closeProduct: vi.fn(),
  inputBytesProduct: vi.fn(),
  pasteImageProduct: vi.fn(),
  resizeProduct: vi.fn(),
  scrollProduct: vi.fn(),
  setFrameSink: vi.fn(),
};

vi.mock("../src/main/runtime", async () => {
  const { Effect, Layer, ManagedRuntime } = await import("effect");
  const { HerdrPlane } = await import("../src/main/vellum/herdr/plane");
  const sessions = {
    openProduct: (...args: unknown[]) => productSpies.openProduct(...args),
    closeProduct: (...args: unknown[]) => productSpies.closeProduct(...args),
    inputBytesProduct: (...args: unknown[]) => productSpies.inputBytesProduct(...args),
    inputTextProduct: vi.fn(),
    pasteImageProduct: (...args: unknown[]) => productSpies.pasteImageProduct(...args),
    resizeProduct: (...args: unknown[]) => productSpies.resizeProduct(...args),
    scrollProduct: (...args: unknown[]) => productSpies.scrollProduct(...args),
    setFrameSink: (...args: unknown[]) => productSpies.setFrameSink(...args),
    setOpenHook: vi.fn(),
    activeControlCount: () => 0,
    streamIdForTerminal: () => undefined,
    open: vi.fn(),
    openScoped: vi.fn(),
    inputBytes: vi.fn(),
    inputText: vi.fn(),
    resize: vi.fn(),
    scroll: vi.fn(),
    pasteImage: vi.fn(),
    close: vi.fn(),
  };
  const fakePlane = HerdrPlane.of({
    service: {} as unknown as HerdrService,
    mirrors: {
      onChange: () => () => {},
      mirrorFor: () => undefined,
      states: () => [],
    } as unknown as HerdrMirrorRegistry,
    observePool: {} as unknown as HerdrObservePool,
    sessions: sessions as never,
    streams: {} as unknown as HerdrStreamManager,
    serviceMap: new HerdrServiceMap(),
    serveCatalog: {
      peekOrEmpty: (hostId: string) => ({ hostId, entries: [] }),
      refresh: async (hostId: string) => ({ hostId, entries: [] }),
      preferredUrl: () => undefined,
      get: () => undefined,
      listServices: () => [],
    } as never,
    serverLifetime: "daemon-outlives-app",
    beginShutdown: () => undefined,
    drainOnQuit: async () => ({
      clean: true,
      retained: 0,
      causes: [],
      components: {},
      server: {
        clean: true,
        retained: 0,
        excluded: true,
        lifetime: "daemon-outlives-app",
        reason: "independent-daemon-never-app-owned",
      },
    }),
    isQuiescing: () => false,
    start: Effect.void,
    warm: Effect.void,
  });
  return { AppRuntime: ManagedRuntime.make(Layer.succeed(HerdrPlane, fakePlane)) };
});

type InvokeHandler = (event: IpcMainInvokeEvent, ...args: ReadonlyArray<unknown>) => unknown;

/** Minimal WebContents fake: real EventEmitter so once()/removeListener()/emit() behave exactly like production. */
class FakeSender extends EventEmitter {
  private destroyed = false;
  readonly sent: Array<{ channel: string; args: ReadonlyArray<unknown> }> = [];
  isDestroyed(): boolean {
    return this.destroyed;
  }
  send(channel: string, ...args: ReadonlyArray<unknown>): void {
    this.sent.push({ channel, args });
  }
  destroy(): void {
    this.destroyed = true;
  }
}

const asWebContents = (sender: FakeSender): WebContents => sender as unknown as WebContents;
const eventFor = (sender: FakeSender): IpcMainInvokeEvent =>
  ({ sender: asWebContents(sender) }) as IpcMainInvokeEvent;

const openInput = (terminalId: string) => ({
  hostId: "local",
  terminalId,
  cols: 80,
  rows: 24,
});

describe("registerHerdrIpc — stream ownership", () => {
  const handlers = new Map<string, InvokeHandler>();

  const invoke = async (channel: string, event: IpcMainInvokeEvent, ...args: ReadonlyArray<unknown>) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`${channel} handler not registered`);
    return handler(event, ...args);
  };

  const open = (sender: FakeSender, terminalId: string) =>
    invoke(IPC_CHANNELS.herdrStreamOpen, eventFor(sender), openInput(terminalId)) as Promise<{
      readonly ok: boolean;
      readonly streamId?: string;
      readonly message?: string;
    }>;

  beforeEach(() => {
    handlers.clear();
    for (const fn of Object.values(productSpies)) fn.mockReset();
    productSpies.openProduct.mockImplementation((input: { terminalId: string }) => ({
      ok: true,
      streamId: `stream-${input.terminalId}`,
      retained: { frames: [] },
    }));
    productSpies.closeProduct.mockImplementation(() => ({ ok: true }));
    productSpies.inputBytesProduct.mockImplementation(() => ({ ok: true }));
    productSpies.pasteImageProduct.mockImplementation(() => ({ ok: true }));
    productSpies.resizeProduct.mockImplementation(() => ({ ok: true }));
    productSpies.scrollProduct.mockImplementation(() => ({ ok: true }));

    const ipcMain = {
      handle: vi.fn((channel: string, handler: InvokeHandler) => {
        handlers.set(channel, handler);
      }),
    } as unknown as IpcMain;

    registerHerdrIpc(ipcMain, () => []);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("default deny — no owner record", () => {
    const mutating: ReadonlyArray<readonly [string, ReadonlyArray<unknown>, keyof typeof productSpies]> = [
      [IPC_CHANNELS.herdrStreamInput, ["no-such-stream", "aGk="], "inputBytesProduct"],
      [IPC_CHANNELS.herdrStreamPasteImage, ["no-such-stream", "png", "aGk="], "pasteImageProduct"],
      [IPC_CHANNELS.herdrStreamResize, ["no-such-stream", 80, 24], "resizeProduct"],
      [IPC_CHANNELS.herdrStreamScroll, ["no-such-stream", 1], "scrollProduct"],
      [IPC_CHANNELS.herdrStreamClose, ["no-such-stream"], "closeProduct"],
    ];

    it.each(mutating)("denies %s for an untracked streamId without touching sessions product API", async (channel, args, spyKey) => {
      const sender = new FakeSender();
      const result = await invoke(channel, eventFor(sender), ...args);
      expect(result).toEqual({ ok: false, error: "unauthorized stream owner" });
      expect(productSpies[spyKey]).not.toHaveBeenCalled();
    });
  });

  describe("herdrStreamOpen — dead sender rejection", () => {
    it("returns not-ok and never opens when the sender is destroyed before open", async () => {
      const sender = new FakeSender();
      sender.destroy();

      const result = await open(sender, "t1");

      expect(result).toEqual({ ok: false, message: "renderer gone" });
      expect(productSpies.openProduct).not.toHaveBeenCalled();
    });

    it("closes the just-opened stream when the sender dies between open and registration", async () => {
      const sender = new FakeSender();
      productSpies.openProduct.mockImplementationOnce((input: { terminalId: string }) => {
        // Simulate the renderer dying while `open` was in flight.
        sender.destroy();
        return { ok: true, streamId: `stream-${input.terminalId}`, retained: { frames: [] } };
      });

      const result = await open(sender, "t1");

      expect(result).toEqual({ ok: false, message: "renderer gone" });
      expect(productSpies.closeProduct).toHaveBeenCalledWith("stream-t1", "renderer_gone");

      // No ownership was registered — a fresh, non-destroyed sender still
      // cannot act on the stream the dead sender opened.
      const otherSender = new FakeSender();
      const inputResult = await invoke(
        IPC_CHANNELS.herdrStreamInput,
        eventFor(otherSender),
        "stream-t1",
        "aGk=",
      );
      expect(inputResult).toEqual({ ok: false, error: "unauthorized stream owner" });
    });
  });

  describe("herdrStreamOpen — successful open grants ownership", () => {
    it("authorizes the opening sender for input on its own stream", async () => {
      const sender = new FakeSender();
      const opened = await open(sender, "t1");
      expect(opened.ok).toBe(true);

      const result = await invoke(IPC_CHANNELS.herdrStreamInput, eventFor(sender), opened.streamId, "aGk=");
      expect(result).toEqual({ ok: true });
      expect(productSpies.inputBytesProduct).toHaveBeenCalledWith(opened.streamId, "aGk=");
    });

    it("denies a different sender acting on someone else's stream", async () => {
      const owner = new FakeSender();
      const opened = await open(owner, "t1");
      expect(opened.ok).toBe(true);

      const intruder = new FakeSender();
      const result = await invoke(IPC_CHANNELS.herdrStreamInput, eventFor(intruder), opened.streamId, "aGk=");
      expect(result).toEqual({ ok: false, error: "unauthorized stream owner" });
      expect(productSpies.inputBytesProduct).not.toHaveBeenCalled();
    });
  });

  describe("reload releases ownership", () => {
    it('"did-start-loading" on the owner releases ownership and closes with reason renderer_reloaded', async () => {
      const sender = new FakeSender();
      const opened = await open(sender, "t1");
      expect(opened.ok).toBe(true);

      sender.emit("did-start-loading");

      expect(productSpies.closeProduct).toHaveBeenCalledWith(opened.streamId, "renderer_reloaded");

      const result = await invoke(IPC_CHANNELS.herdrStreamInput, eventFor(sender), opened.streamId, "aGk=");
      expect(result).toEqual({ ok: false, error: "unauthorized stream owner" });
    });

    it("a concurrent second stream owned by another sender is unaffected by the first owner's reload", async () => {
      const senderA = new FakeSender();
      const senderB = new FakeSender();
      const openedA = await open(senderA, "t-a");
      const openedB = await open(senderB, "t-b");
      expect(openedA.ok).toBe(true);
      expect(openedB.ok).toBe(true);
      expect(openedA.streamId).not.toBe(openedB.streamId);

      senderA.emit("did-start-loading");

      expect(productSpies.closeProduct).toHaveBeenCalledWith(openedA.streamId, "renderer_reloaded");
      expect(productSpies.closeProduct).not.toHaveBeenCalledWith(openedB.streamId, expect.anything());

      // A's ownership is gone; B's stream is untouched and still authorized.
      const deniedA = await invoke(IPC_CHANNELS.herdrStreamInput, eventFor(senderA), openedA.streamId, "aGk=");
      expect(deniedA).toEqual({ ok: false, error: "unauthorized stream owner" });

      productSpies.inputBytesProduct.mockClear();
      const okB = await invoke(IPC_CHANNELS.herdrStreamInput, eventFor(senderB), openedB.streamId, "aGk=");
      expect(okB).toEqual({ ok: true });
      expect(productSpies.inputBytesProduct).toHaveBeenCalledWith(openedB.streamId, "aGk=");
    });
  });

  describe("stream sink — ownership routing (no broadcast fallback)", () => {
    /** The callback registered on sessions.setFrameSink is the routing logic under test. */
    const getSink = (): ((frame: HerdrStreamEvent) => void) => {
      const call = productSpies.setFrameSink.mock.calls[0];
      if (!call) throw new Error("plane.sessions.setFrameSink was never called");
      return call[0] as (frame: HerdrStreamEvent) => void;
    };

    it("drops a frame for an unowned streamId — no send, no throw", async () => {
      const sender = new FakeSender();
      await open(sender, "t1"); // exercise withPlane so the sink registration has settled
      const sink = getSink();

      expect(() => sink({ streamId: "no-such-stream", type: "frame" })).not.toThrow();
      expect(sender.sent).toEqual([]);
    });

    it("delivers an owned frame only to its owner, never to another sender", async () => {
      const senderA = new FakeSender();
      const senderB = new FakeSender();
      const openedA = await open(senderA, "t-a");
      await open(senderB, "t-b");
      const sink = getSink();

      const frame: HerdrStreamEvent = { streamId: openedA.streamId!, type: "frame", bytes: "aGk=" };
      sink(frame);

      expect(senderA.sent).toEqual([{ channel: IPC_CHANNELS.herdrStreamEvent, args: [frame] }]);
      expect(senderB.sent).toEqual([]);
    });

    it('a "closed" frame for an unowned streamId is a no-op — no send, no release, no throw', async () => {
      const sender = new FakeSender();
      const opened = await open(sender, "t1");
      const sink = getSink();

      expect(() => sink({ streamId: "no-such-stream", type: "closed" })).not.toThrow();
      expect(sender.sent).toEqual([]);

      // The real owner is unaffected — still authorized on its own stream.
      const result = await invoke(IPC_CHANNELS.herdrStreamInput, eventFor(sender), opened.streamId, "aGk=");
      expect(result).toEqual({ ok: true });
    });

    it('a "closed" frame for an owned streamId is delivered to the owner, then releases ownership', async () => {
      const sender = new FakeSender();
      const opened = await open(sender, "t1");
      const sink = getSink();

      const frame: HerdrStreamEvent = { streamId: opened.streamId!, type: "closed", reason: "test" };
      sink(frame);

      expect(sender.sent).toEqual([{ channel: IPC_CHANNELS.herdrStreamEvent, args: [frame] }]);

      const result = await invoke(IPC_CHANNELS.herdrStreamInput, eventFor(sender), opened.streamId, "aGk=");
      expect(result).toEqual({ ok: false, error: "unauthorized stream owner" });
    });
  });
});
