/**
 * The content group over a window's link: the window's runtime on one end,
 * main's forward in the middle, and the core's content group behind main's
 * client. Every answer is the core's unchanged; a saved portrait still goes to
 * every trusted window as it stands; a payload the group's schema refuses is
 * refused at main's edge before the core is asked; and the page shot purge,
 * which main makes for itself, is not the window's to call.
 */
import { Effect, Exit, Fiber, Layer, Schema, Scope } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcTest } from "effect/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { clientProtocol, heldForServer, type PortMessage, type RpcPort } from "../src/shared/rpc-port";

/** The app's windows as main sees them: a trusted one, and one that is not. */
const sent: Array<{ readonly window: string; readonly channel: string; readonly payload: unknown }> = [];
const windowNamed = (name: string, trusted: boolean) => ({
  isDestroyed: () => false,
  webContents: {
    trusted,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => sent.push({ window: name, channel, payload }),
  },
});
const windows = [windowNamed("app", true), windowNamed("stranger", false)];

vi.mock("electron", () => ({ MessageChannelMain: class {}, BrowserWindow: { getAllWindows: () => windows } }));
vi.mock("../src/app/runtime", () => ({ AppRuntime: {} }));
vi.mock("../src/app/trusted-main-webcontents", () => ({
  isTrustedMainWebContents: (contents: { readonly trusted: boolean }) => contents.trusted,
}));

const { windowServer } = await import("../src/app/window/ipc");
const { ContentWindowHandlers } = await import("../src/app/content/content-ipc");
const { ContentCore, ContentRpcs } = await import("../src/contract/core/content");
const { ContentWindowRpcs } = await import("../src/contract/window/content");
const { WindowRpcs } = await import("../src/contract/window/rpcs");
const { pageLink } = await import("../src/window/rpc/link");
const { makeWindowRuntime } = await import("../src/window/rpc/runtime");
const { contentCalls } = await import("../src/window/lib/content-calls");
const { notUnderTest } = await import("./support/window-groups");

const mainLinkOf = (port: MessagePort): RpcPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (event: MessageEvent) => handler(event.data as PortMessage);
    port.addEventListener("message", on);
    port.start();
    return () => port.removeEventListener("message", on);
  },
});

/** A page whose preload hands it `port` when it asks for its link. */
const pageWith = (port: MessagePort) => {
  const listeners = new Set<(event: MessageEvent) => void>();
  const page = {
    addEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MessageEvent) => void) => listeners.delete(listener),
  } as unknown as Window;
  const bridge = {
    openWindowLink: () => {
      const event = { source: page, data: { type: IPC_CHANNELS.windowLink }, ports: [port] } as unknown as MessageEvent;
      queueMicrotask(() => {
        for (const listener of [...listeners]) listener(event);
      });
    },
  };
  return { page, bridge };
};

/** The core's content group, as far as these calls go: each answers what it was asked, and says so. */
const asks: Array<{ readonly tag: string; readonly payload: unknown }> = [];
const asked = <A>(tag: string, payload: unknown, answer: A) =>
  Effect.sync(() => {
    asks.push({ tag, payload });
    return answer;
  });
const coreHandlers = ContentRpcs.toLayer({
  ContentOperatorPut: (payload) => asked("ContentOperatorPut", payload, { ok: false as const, message: "The content store is full." }),
  ContentPutImage: (payload) => asked("ContentPutImage", payload, { ok: false as const, error: "The image is too large." }),
  ContentPortraitOverrides: () => asked("ContentPortraitOverrides", undefined, { "seat-1": { shape: "toast" } }),
  ContentPortraitOverrideSet: (payload) =>
    asked(
      "ContentPortraitOverrideSet",
      payload,
      payload.seatId === "refused"
        ? { ok: false as const, message: "The store refused it." }
        : { ok: true as const, seatId: payload.seatId, override: payload.override },
    ),
  ContentPageShotPurge: (payload) => asked("ContentPageShotPurge", payload, { ok: true as const, messageId: payload.messageId, already: false }),
});

let scope: Scope.Closeable;
let serve: (port: MessagePort) => void;
let runtime: ReturnType<typeof makeWindowRuntime>;
const cleanups: Array<() => Promise<void>> = [];

beforeEach(async () => {
  scope = await Effect.runPromise(Scope.make());
  asks.length = 0;
  sent.length = 0;
  const handlers = await Effect.runPromise(Layer.buildWithScope(coreHandlers, scope));
  const core = await Effect.runPromise(
    RpcTest.makeClient(ContentRpcs).pipe(Effect.provide(handlers), Effect.provideService(Scope.Scope, scope)),
  );
  const mainHandlers = Layer.mergeAll(
    // Every other window group answers nothing here: they are not under test.
    notUnderTest(WindowRpcs.omit("ContentOperatorPut", "ContentPutImage", "ContentPortraitOverrides", "ContentPortraitOverrideSet")),
    ContentWindowHandlers.pipe(Layer.provide(Layer.succeed(ContentCore, core as never))),
  );
  serve = (port) => {
    const server = Effect.runFork(
      Layer.launch(windowServer(heldForServer(mainLinkOf(port)), mainHandlers as never, { id: 1, webContents: {} as never })),
    );
    cleanups.push(async () => {
      await Effect.runPromise(Fiber.interrupt(server));
      port.close();
    });
  };
  const { port1, port2 } = new MessageChannel();
  serve(port1);
  const { page, bridge } = pageWith(port2);
  runtime = makeWindowRuntime(pageLink(bridge, page));
  cleanups.push(async () => {
    await runtime.dispose();
    port2.close();
  });
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

/** A client of a drifted contract: the same tag, with a payload main's schema refuses, or a tag main does not serve. */
const drifted = async (rpc: Rpc.Any, payload: unknown): Promise<Exit.Exit<unknown, unknown>> => {
  const { port1, port2 } = new MessageChannel();
  serve(port1);
  const exit = await Effect.runPromiseExit(
    Effect.scoped(
      RpcClient.make(RpcGroup.make(rpc)).pipe(
        Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(mainLinkOf(port2))),
        Effect.flatMap((client) => (client as unknown as Record<string, (payload: unknown) => Effect.Effect<unknown, unknown>>)[rpc._tag]!(payload)),
      ),
    ),
  );
  port2.close();
  return exit;
};

describe("the content group over a window's link", () => {
  it("forwards every content call but the page shot purge, which main makes itself", () => {
    expect([...ContentWindowRpcs.requests.keys()].sort()).toEqual(
      [...ContentRpcs.requests.keys()].filter((tag) => tag !== "ContentPageShotPurge").sort(),
    );
  });

  it("answers each call with the core's own answer", async () => {
    const content = contentCalls(runtime);
    expect(await content.putImage({ bytesBase64: "iVBORw0K", mediaType: "image/png", displayName: "a.png" })).toEqual({
      ok: false,
      error: "The image is too large.",
    });
    expect(await content.operatorPut({ canvasName: "factory", stage: { bytesBase64: "aGk=" } })).toEqual({
      ok: false,
      message: "The content store is full.",
    });
    expect(await content.portraitOverrides()).toEqual({ "seat-1": { shape: "toast" } });
    expect(asks.map((ask) => ask.tag)).toEqual(["ContentPutImage", "ContentOperatorPut", "ContentPortraitOverrides"]);
  });

  it("sends a saved portrait to every trusted window as it stands, and a refused one to none", async () => {
    const content = contentCalls(runtime);
    expect(await content.portraitOverrideSet("seat-1", { shape: "toast" })).toEqual({ ok: true, seatId: "seat-1", override: { shape: "toast" } });
    expect(sent).toEqual([{ window: "app", channel: IPC_CHANNELS.portraitOverride, payload: { seatId: "seat-1", override: { shape: "toast" } } }]);
    sent.length = 0;
    expect(await content.portraitOverrideSet("refused", null)).toEqual({ ok: false, message: "The store refused it." });
    expect(sent).toEqual([]);
  });

  it("answers a piece that does not decode in words, and never asks the core", async () => {
    const content = contentCalls(runtime);
    // A piece with neither bytes nor a close is no piece at all.
    expect(await content.operatorPut({ canvasName: "factory", stage: {} })).toEqual({
      ok: false,
      message: "That piece of the file could not be stored.",
    });
    expect(asks).toEqual([]);
  });

  it("refuses at main's edge a portrait save with a field the group does not name, before the core is asked", async () => {
    const exit = await drifted(
      Rpc.make("ContentPortraitOverrideSet", {
        payload: { seatId: Schema.String, override: Schema.Null, extra: Schema.String },
        success: Schema.Unknown,
      }),
      { seatId: "seat-1", override: null, extra: "x" },
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(asks).toEqual([]);
    expect(sent).toEqual([]);
  });

  it("refuses at main's edge a seat id the group does not take, with no hand decoding left in main", async () => {
    const exit = await drifted(
      Rpc.make("ContentPortraitOverrideSet", { payload: { seatId: Schema.String, override: Schema.Null }, success: Schema.Unknown }),
      { seatId: "   ", override: null },
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(asks).toEqual([]);
  });

  it("serves the window no page shot purge", async () => {
    const exit = await drifted(
      Rpc.make("ContentPageShotPurge", { payload: { canvasName: Schema.String, nodeId: Schema.String, messageId: Schema.String }, success: Schema.Unknown }),
      { canvasName: "factory", nodeId: "box", messageId: "m1" },
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(asks).toEqual([]);
  });
});
