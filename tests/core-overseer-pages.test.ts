import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Layer, ManagedRuntime } from "effect";
import { afterEach, expect, it } from "vitest";
import { portCore, serveCore, type CorePort } from "../src/main/core-process/port";
import { hostCaptureApplicationPage, hostOverseerPages } from "../src/main/core-process/ops/overseer-pages";
import { serveOverseerHost } from "../src/main/core-process/main-side/overseer-pages";
import type { OverseerPages } from "../src/main/junto/overseer/pages";
import type { ResolvedPageTarget } from "../src/main/junto/browser/page-target";
import type { CoreRunner } from "./support/in-process-core";

const portOf = (port: MessagePort): CorePort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: Parameters<typeof handler>[0]) => handler(message);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

const closing: Array<() => void> = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

const target: ResolvedPageTarget = { ref: "junto://canvas/factory?node=p1" as never, nodeId: "p1", url: "https://p1.example.com", profile: "personal" };
const info = { sessionId: "s1", ref: target.ref, nodeId: "p1", url: target.url, profile: "personal" } as never;

// Main holds the browser; the core's overseer reaches it across the port.
const wire = (pages: Partial<OverseerPages> | undefined) => {
  const runtime = ManagedRuntime.make(Layer.empty);
  const { port1, port2 } = new MessageChannel();
  const served = serveCore(portOf(port2), runtime as unknown as CoreRunner);
  const core = portCore(portOf(port1));
  const stop = serveOverseerHost({
    core,
    pages: () => pages as OverseerPages | undefined,
    captureApplicationPage: async () => ({ ok: true, png: new Uint8Array([9, 8]) }),
  });
  closing.push(() => {
    stop();
    port1.close();
    void runtime.dispose();
  });
  return { pages: hostOverseerPages(served.host), capture: hostCaptureApplicationPage(served.host) };
};

it("opens a page in main and asks the core's recheck back before it commits", async () => {
  const asked: string[] = [];
  const { pages } = wire({
    open: async (input, recheck) => {
      asked.push(input.owner, input.driver);
      const again = await recheck();
      return again.ok ? { ok: true, data: info } : again;
    },
  });
  const opened = await pages.open({ owner: "overseer", target, driver: "seat-1" }, async () => ({ ok: true, data: target }), new AbortController().signal);
  expect(opened).toEqual({ ok: true, data: info });
  expect(asked).toEqual(["overseer", "seat-1"]);
  const refused = await pages.open(
    { owner: "overseer", target, driver: "seat-1" },
    async () => ({ ok: false, code: "not_found", message: "canvas not found" }),
    new AbortController().signal,
  );
  expect(refused).toEqual({ ok: false, code: "not_found", message: "canvas not found" });
});

it("carries the core's abort to main's signal for the same call", async () => {
  let mainSignal: AbortSignal | undefined;
  const { pages } = wire({
    eval: (_owner, _sessionId, _code, signal) =>
      new Promise((resolve) => {
        mainSignal = signal;
        signal.addEventListener("abort", () => resolve({ ok: false, code: "failed", message: "aborted" }));
      }),
  });
  const controller = new AbortController();
  const evaluated = pages.eval("overseer", "s1", "1", controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(mainSignal?.aborted).toBe(false);
  controller.abort();
  expect(await evaluated).toEqual({ ok: false, code: "failed", message: "aborted" });
});

it("answers as data: pixels and fences cross, and an unbound browser is down, not a throw", async () => {
  const fences: string[] = [];
  const bound = wire({
    screenshot: async () => ({ ok: true, data: { png: new Uint8Array([1, 2, 3]) } }),
    beginDelete: (ref, leaseId) => void fences.push(`begin ${ref} ${leaseId}`),
    finishDelete: (ref, leaseId) => void fences.push(`finish ${ref} ${leaseId}`),
    sessionsForRef: async () => [{ owner: "junto-ui", sessionId: "s1" }],
  });
  const shot = await bound.pages.screenshot("overseer", "s1", new AbortController().signal);
  expect(shot.ok && [...shot.data.png]).toEqual([1, 2, 3]);
  expect(await bound.capture()).toEqual({ ok: true, png: new Uint8Array([9, 8]) });
  bound.pages.beginDelete("r", "l1");
  bound.pages.finishDelete("r", "l1");
  expect(await bound.pages.sessionsForRef("r")).toEqual([{ owner: "junto-ui", sessionId: "s1" }]);
  expect(fences).toEqual(["begin r l1", "finish r l1"]);

  // Main registers its host bodies once; the unbound browser is a second main.
  for (const close of closing.splice(0)) close();
  const unbound = wire(undefined);
  expect(await unbound.pages.state("overseer", "s1")).toMatchObject({ ok: false, code: "failed" });
  expect(await unbound.pages.sessionsForRef("r")).toEqual([]);
});
