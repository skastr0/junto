import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type JuntoApi } from "../src/shared/ipc";
import { FILES_DRAFTS_START_TIMEOUT_MS, makeFilesDraftsSettle } from "../src/main/junto/files/drafts-settle";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => void>(),
  exposed: new Map<string, unknown>(),
  sent: [] as Array<ReadonlyArray<unknown>>,
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => electron.exposed.set(name, value),
  },
  ipcRenderer: {
    invoke: () => Promise.resolve(undefined),
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => {
      electron.handlers.set(channel, listener);
    },
    removeListener: vi.fn(),
    send: (...args: ReadonlyArray<unknown>) => electron.sent.push(args),
  },
}));

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Timers run by hand: no test waits on a real clock. */
const handTimers = () => {
  const queued = new Map<number, { readonly fn: () => void; readonly ms: number }>();
  let next = 0;
  return {
    timers: {
      set: (fn: () => void, ms: number) => {
        next += 1;
        queued.set(next, { fn, ms });
        return next;
      },
      clear: (handle: unknown) => void queued.delete(handle as number),
    },
    pending: () => [...queued.values()].map(({ ms }) => ms),
    fire: () => {
      const all = [...queued.values()];
      queued.clear();
      for (const { fn } of all) fn();
    },
  };
};

describe("main asks the renderer to settle Files drafts", () => {
  const ask = (settle: ReturnType<typeof makeFilesDraftsSettle>) => {
    const requests: string[] = [];
    let answer: boolean | undefined;
    void settle.request({ id: 7, send: ({ requestId }) => requests.push(requestId) }).then((proceed) => {
      answer = proceed;
    });
    return { requests, answer: () => answer };
  };

  it("answers the operator's choice, and joins a second ask to the first", async () => {
    const hand = handTimers();
    const settle = makeFilesDraftsSettle(hand.timers);
    const first = ask(settle);
    const second = ask(settle);
    expect(first.requests).toHaveLength(1);
    expect(second.requests).toEqual([]);
    settle.complete(7, { requestId: "someone else", proceed: true });
    settle.complete(8, { requestId: first.requests[0], proceed: true });
    settle.complete(7, { requestId: first.requests[0], proceed: "no" });
    await turn();
    expect(first.answer()).toBeUndefined();
    settle.complete(7, { requestId: first.requests[0], proceed: false });
    await turn();
    expect([first.answer(), second.answer()]).toEqual([false, false]);
    expect(hand.pending()).toEqual([]);
  });

  it("goes on when the renderer never says it started, and waits with no deadline once it has", async () => {
    const hand = handTimers();
    const settle = makeFilesDraftsSettle(hand.timers);
    const silent = ask(settle);
    expect(hand.pending()).toEqual([FILES_DRAFTS_START_TIMEOUT_MS]);
    hand.fire();
    await turn();
    expect(silent.answer()).toBe(true);

    const asking = ask(settle);
    settle.started(7, { requestId: asking.requests[0] });
    expect(hand.pending()).toEqual([]);
    hand.fire();
    await turn();
    expect(asking.answer()).toBeUndefined();
    settle.complete(7, { requestId: asking.requests[0], proceed: true });
    await turn();
    expect(asking.answer()).toBe(true);
  });

  it("goes on when the renderer goes away mid-ask", async () => {
    const settle = makeFilesDraftsSettle(handTimers().timers);
    const asking = ask(settle);
    settle.started(7, { requestId: asking.requests[0] });
    settle.gone(7);
    await turn();
    expect(asking.answer()).toBe(true);
  });
});

describe("the preload answers the settle ask", () => {
  beforeEach(() => {
    vi.resetModules();
    electron.handlers.clear();
    electron.exposed.clear();
    electron.sent.length = 0;
  });

  const loadPreload = async (): Promise<JuntoApi> => {
    await import("../src/preload/index");
    return electron.exposed.get("junto") as JuntoApi;
  };
  const request = (requestId: string): void =>
    electron.handlers.get(IPC_CHANNELS.filesDraftsSettleRequested)?.({}, { requestId });

  it("says it started at once, then sends the listener's answer; no listener or a throw goes on", async () => {
    const api = await loadPreload();
    request("00000000-0000-4000-8000-00000000000a");
    expect(electron.sent).toEqual([[IPC_CHANNELS.filesDraftsSettleComplete, { requestId: "00000000-0000-4000-8000-00000000000a", proceed: true }]]);

    electron.sent.length = 0;
    let choose!: (proceed: boolean) => void;
    const stop = api.onFilesDraftsSettle(() => new Promise<boolean>((resolve) => (choose = resolve)));
    request("00000000-0000-4000-8000-00000000000b");
    expect(electron.sent).toEqual([[IPC_CHANNELS.filesDraftsSettleStarted, { requestId: "00000000-0000-4000-8000-00000000000b" }]]);
    choose(false);
    await turn();
    expect(electron.sent.at(-1)).toEqual([IPC_CHANNELS.filesDraftsSettleComplete, { requestId: "00000000-0000-4000-8000-00000000000b", proceed: false }]);
    stop();

    electron.sent.length = 0;
    api.onFilesDraftsSettle(() => Promise.reject(new Error("broken")));
    request("00000000-0000-4000-8000-00000000000c");
    await turn();
    expect(electron.sent.at(-1)).toEqual([IPC_CHANNELS.filesDraftsSettleComplete, { requestId: "00000000-0000-4000-8000-00000000000c", proceed: true }]);
  });
});

describe("quit and close ask about Files drafts first", () => {
  const source = readFileSync(join(import.meta.dirname, "..", "src/main/index.ts"), "utf8");

  it("asks on the dialog path of a quit, before the live work confirm, and Cancel stops the quit", () => {
    const block = source.slice(source.indexOf('app.on("before-quit"'), source.indexOf('app.on("will-quit"'));
    const signalPath = block.indexOf("if (skipQuitConfirm || headless || quitConfirmed)");
    const settle = block.indexOf("requestFilesDraftsSettle(trustedMainWindow)");
    expect(signalPath).toBeGreaterThan(0);
    expect(settle).toBeGreaterThan(signalPath);
    expect(block.slice(settle)).toMatch(/if \(!leave\) \{\s+quitConfirmed = false;\s+recreateWindowIfEmpty\(\);\s+return;/u);
    expect(block.indexOf("confirmLiveWorkThenQuit();", settle)).toBeGreaterThan(settle);
  });

  it("asks before the canvas flush when the window closes, and Cancel keeps it", () => {
    expect(source).toContain("closeFlush ??= requestFilesDraftsSettle(mainWindow)");
    expect(source).toContain(".then((leave) => (leave ? flushThenClose() : undefined))");
    expect(source).toContain("filesDraftsSettle.gone(mainWebContentsId)");
  });
});
