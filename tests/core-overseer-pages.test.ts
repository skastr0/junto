/**
 * The overseer runs in the core and main holds the browser and the window:
 * each page operation and the window's pixels are calls on
 * main's host groups (src/contract/host/), over the host link. An open's
 * recheck comes back through the overseer pages group
 * (src/contract/core/overseer-pages.ts) on the core's link, under the call id
 * the core gave it. A call the core abandons aborts main's page work.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { RpcServer } from "effect/rpc";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { OverseerPagesRpcs } from "../src/contract/core/overseer-pages";
import { serverProtocol, type PortMessage, type RpcPort } from "../src/shared/rpc-port";
import {
  hostCaptureApplicationPage,
  hostOverseerPages,
  OverseerPageFlights,
  OverseerPagesHandlers,
  type HostRun,
} from "../src/core/ops/overseer-pages";
import type { OverseerPages } from "../src/node/overseer/pages";
import type { ResolvedPageTarget } from "../src/core/browser/page-target";
import { servedHost } from "./support/host-link";

const linkOf = (port: MessagePort): RpcPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: PortMessage) => handler(message);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

let scope: Scope.Closeable;
const closing: Array<() => void> = [];
beforeEach(async () => {
  scope = await Effect.runPromise(Scope.make());
});
afterEach(async () => {
  for (const close of closing.splice(0)) close();
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

const target: ResolvedPageTarget = { ref: "junto://canvas/factory?node=p1" as never, nodeId: "p1", url: "https://p1.example.com", profile: "personal" };
const info = { sessionId: "s1", ref: target.ref, nodeId: "p1", url: target.url, profile: "personal", state: "ready", attached: true } as const;
const clipboard = { readText: () => "", writeText: () => undefined, clear: () => undefined, availableFormats: () => [] };

// Main holds the browser and the window; the core reaches them across the host link, and main asks each recheck back on the core's link.
const wire = async (input: {
  readonly pages?: Partial<OverseerPages>;
}) => {
  const link = new MessageChannel();
  closing.push(() => {
    link.port1.close();
    link.port2.close();
  });
  const flights = OverseerPageFlights.make();
  await Effect.runPromise(
    Layer.buildWithScope(
      RpcServer.layer(OverseerPagesRpcs).pipe(
        Layer.provide(OverseerPagesHandlers),
        Layer.provide([
          Layer.succeed(OverseerPageFlights, flights),
          Layer.effect(RpcServer.Protocol, serverProtocol(linkOf(link.port2))),
        ]),
      ),
      scope,
    ),
  );
  const main = await servedHost(scope, clipboard, {
    coreLink: linkOf(link.port1),
    pages: () => input.pages as OverseerPages | undefined,
    captureApplicationPage: async () => ({ ok: true, png: new Uint8Array([9, 8]) }),
  });
  closing.push(main.close);
  const core = await main.core();
  const runtime = ManagedRuntime.make(Layer.succeedContext(core.clients));
  closing.push(() => void runtime.dispose());
  const run: HostRun = (effect, options) => runtime.runPromise(effect, options);
  return { pages: hostOverseerPages(run, flights), capture: hostCaptureApplicationPage(run), flights };
};

it("opens a page in main and asks the core's recheck back before it commits", async () => {
  const asked: string[] = [];
  const { pages, flights } = await wire({
    pages: {
      open: async (input, recheck) => {
        asked.push(input.owner, input.driver);
        const again = await recheck();
        return again.ok ? { ok: true, data: info } : again;
      },
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
  // The recheck is held only while its open is in flight.
  expect(flights.recheckOf(1)).toBeUndefined();
  expect(flights.recheckOf(2)).toBeUndefined();
});

it("carries the core's abort to main's signal, and answers the abandoned call as cancelled data", async () => {
  let mainSignal: AbortSignal | undefined;
  const { pages } = await wire({
    pages: {
      eval: (_owner, _sessionId, _code, signal) =>
        new Promise(() => {
          mainSignal = signal;
        }),
    },
  });
  const controller = new AbortController();
  const evaluated = pages.eval("overseer", "s1", "1", controller.signal);
  await vi.waitFor(() => expect(mainSignal).toBeDefined());
  expect(mainSignal?.aborted).toBe(false);
  controller.abort();
  expect(await evaluated).toEqual({ ok: false, code: "cancelled", message: "eval cancelled" });
  await vi.waitFor(() => expect(mainSignal?.aborted).toBe(true));
});

it("answers as data: pixels and fences cross, and an unbound browser is down, not a throw", async () => {
  const fences: string[] = [];
  const bound = await wire({
    pages: {
      screenshot: async () => ({ ok: true, data: { png: new Uint8Array([1, 2, 3]) } }),
      beginDelete: (ref, leaseId) => void fences.push(`begin ${ref} ${leaseId}`),
      finishDelete: (ref, leaseId) => void fences.push(`finish ${ref} ${leaseId}`),
      sessionsForRef: async () => [{ owner: "junto-ui", sessionId: "s1" }],
    },
  });
  const shot = await bound.pages.screenshot("overseer", "s1", new AbortController().signal);
  expect(shot.ok && [...shot.data.png]).toEqual([1, 2, 3]);
  expect(await bound.capture()).toEqual({ ok: true, png: new Uint8Array([9, 8]) });
  bound.pages.beginDelete("r", "l1");
  bound.pages.finishDelete("r", "l1");
  expect(await bound.pages.sessionsForRef("r")).toEqual([{ owner: "junto-ui", sessionId: "s1" }]);
  // The fences reach main in the order they were sent.
  await vi.waitFor(() => expect(fences).toEqual(["begin r l1", "finish r l1"]));

  const unbound = await wire({});
  expect(await unbound.pages.state("overseer", "s1")).toMatchObject({ ok: false, code: "failed" });
  expect(await unbound.pages.sessionsForRef("r")).toEqual([]);
});
