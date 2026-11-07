/**
 * The browser group (src/contract/core/browser.ts) over a MessageChannel:
 * main's typed client on one end, the core's handlers on the other. The pool
 * limits come from Settings; for the box comment main draws the box and takes
 * the shot, and the core holds the staged shots and the store. Main's page
 * resolver asks the core only for a ref that can name a page.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Context, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { RpcServer } from "effect/rpc";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { serverProtocol, type PortMessage, type RpcPort } from "../src/shared/rpc-port";
import { defaultSettings } from "../src/shared/settings";
import { CoreLink } from "../src/contract/core/link";
import { BrowserCore, BrowserRpcs } from "../src/contract/core/browser";
import { BrowserHandlers } from "../src/core/ops/ipc-browser";
import { ModelService } from "../src/core/model/service";
import { SettingsService } from "../src/core/settings/service";

vi.mock("../src/app/runtime", () => ({ AppRuntime: ManagedRuntime.make(Layer.empty) }));

const { browserPageTargetResolver } = await import("../src/app/browser/ipc");

const linkOf = (port: MessagePort): RpcPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: PortMessage) => handler(message);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

const settings = defaultSettings();
const handlers = BrowserHandlers.pipe(
  Layer.provide([
    Layer.mock(SettingsService, {
      get: Effect.succeed({ ...settings, browser: { ...settings.browser, maxVisibleSurfaces: 3, maxWarmSessions: 5 } }),
      subscribe: () => () => undefined,
    }),
    Layer.mock(ModelService, { subscribeChanges: () => () => undefined, subscribeCanvasesChanges: () => () => undefined }),
  ]),
);

let scope: Scope.Closeable;
let ports: Array<MessagePort>;

beforeEach(async () => {
  scope = await Effect.runPromise(Scope.make());
  ports = [];
});

afterEach(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const port of ports) port.close();
});

/** The core's browser handlers on one end of a channel, and main's client on the other. */
const browserCore = async (): Promise<Context.Context<BrowserCore>> => {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  await Effect.runPromise(
    Layer.buildWithScope(
      RpcServer.layer(BrowserRpcs).pipe(
        Layer.provide(handlers),
        Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(linkOf(port2)))),
      ),
      scope,
    ),
  );
  return Effect.runPromise(Layer.buildWithScope(BrowserCore.layer.pipe(Layer.provide(Layer.succeed(CoreLink, linkOf(port1)))), scope));
};

it("answers the browser's pool limits and box comments in the core, refusing what it never staged", async () => {
  const browser = Context.get(await browserCore(), BrowserCore);
  const page = { canvasName: "factory", nodeId: "page" };
  expect(await Effect.runPromise(browser.BrowserPoolLimits())).toEqual({ maxVisibleSurfaces: 3, maxWarmSessions: 5 });
  // A shot whose address cannot be named on a comment is refused before anything is stored.
  expect(
    await Effect.runPromise(
      browser.BrowserPageBoxStage({
        sessionId: "s",
        page,
        shot: { png: new Uint8Array([1]), url: "not a url", scroll: { x: 0, y: 0 }, rect: { x: 0, y: 0, w: 1, h: 1 } },
      }),
    ),
  ).toMatchObject({ ok: false, code: "invalid" });
  expect(
    await Effect.runPromise(browser.BrowserPageBoxPost({ page, sessionId: "s", shotId: "01J00000000000000000000000", text: "look" })),
  ).toMatchObject({ ok: false, code: "invalid" });
  expect(await Effect.runPromise(browser.BrowserPageBoxDiscard({ sessionId: "s", shotId: "01J00000000000000000000000" }))).toBeUndefined();
  expect(await Effect.runPromise(browser.BrowserPageBoxReleaseSession({ sessionId: "s" }))).toBeUndefined();
});

it("resolves a page ref in the core, and refuses one that is not a string without asking", async () => {
  const resolve = browserPageTargetResolver(await browserCore());
  expect(await resolve(42)).toEqual({ ok: false, code: "invalid", message: "canonical page ref required" });
  expect(await resolve("not a page ref")).toMatchObject({ ok: false, code: "invalid" });
});
