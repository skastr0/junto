/**
 * The notifications group over a window's link: main serves it from the
 * plane. A report reaches the plane and the phone companion's core, and still
 * answers when the core does not; a click and a cue reach every window that
 * follows the event stream; a report the group's schema does not read is
 * refused at main's edge, before the plane or the core hear of it.
 */
import { Effect, Exit, Fiber, Layer, Schema, Scope, Stream } from "effect";
import { Rpc, RpcClient, RpcGroup, RpcServer, RpcTest } from "effect/rpc";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyReport } from "../src/shared/desktop-notifications";
import { defaultNotifications } from "../src/shared/settings";
import { clientProtocol, heldForServer, serverProtocol, type PortMessage, type RpcPort } from "../src/shared/rpc-port";
import type { MainNotifications } from "../src/app/notifications/ipc";
import type { NotifyWindowEvent, NotificationsWindowRpcs as WindowGroup } from "../src/contract/window/notifications";

vi.mock("electron", () => ({ Notification: class {}, app: {}, shell: { openExternal: vi.fn() } }));

const { MainNotificationsService, NotificationsWindowHandlers } = await import("../src/app/notifications/ipc");
const { NotificationsWindowRpcs } = await import("../src/contract/window/notifications");
const { CompanionCore } = await import("../src/contract/core/companion");

const REPORT: NotifyReport = { canvasName: "main", subjects: [], badge: 2, prefs: defaultNotifications() };

let scope: Scope.Closeable;
let reported: Array<NotifyReport>;
let companionReports: Array<NotifyReport>;
let companionDown: boolean;
let listeners: Set<(event: NotifyWindowEvent) => void>;
let handlers: Layer.Layer<Layer.Success<typeof NotificationsWindowHandlers>>;
let page: RpcClient.FromGroup<typeof WindowGroup>;

/** One end of a DOM-style channel as a link. */
const linkOf = (port: MessagePort): RpcPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (event: MessageEvent) => handler(event.data as PortMessage);
    port.addEventListener("message", on);
    port.start();
    return () => port.removeEventListener("message", on);
  },
});

beforeEach(async () => {
  scope = await Effect.runPromise(Scope.make());
  reported = [];
  companionReports = [];
  companionDown = false;
  listeners = new Set();
  const plane = {
    report: (report: NotifyReport) => void reported.push(report),
    test: async () => ({ ok: true, message: "Sent." }),
    delivery: () => ({ state: "blocked" as const, reason: "off in System Settings" }),
    attach: () => () => undefined,
    dispose: () => undefined,
    told: (listener: (event: NotifyWindowEvent) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  } satisfies MainNotifications;
  const companion = {
    CompanionDesktopReport: ({ report }: { report: NotifyReport }) =>
      companionDown ? Effect.die("the core left") : Effect.sync(() => void companionReports.push(report)),
  };
  handlers = NotificationsWindowHandlers.pipe(
    Layer.provide(Layer.succeed(MainNotificationsService, plane)),
    Layer.provide(Layer.succeed(CompanionCore, companion as never)),
  );
  const context = await Effect.runPromise(Layer.buildWithScope(handlers, scope));
  page = await Effect.runPromise(
    RpcTest.makeClient(NotificationsWindowRpcs).pipe(Effect.provideContext(context), Effect.provideService(Scope.Scope, scope)),
  );
});

afterEach(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
});

const until = async (ok: () => boolean): Promise<void> => {
  for (let tries = 0; tries < 200 && !ok(); tries += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe("the notifications group over a window's link", () => {
  it("hands a report to the plane and the companion's core, and answers even when the core does not", async () => {
    await Effect.runPromise(page.NotificationsReport({ report: REPORT }));
    expect(reported).toEqual([REPORT]);
    expect(companionReports).toEqual([REPORT]);

    companionDown = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = await Effect.runPromiseExit(page.NotificationsReport({ report: REPORT }));
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(reported).toHaveLength(2);
  });

  it("answers a test banner and the delivery state from the plane", async () => {
    expect(await Effect.runPromise(page.NotificationsTest())).toEqual({ ok: true, message: "Sent." });
    expect(await Effect.runPromise(page.NotificationsDelivery())).toEqual({ state: "blocked", reason: "off in System Settings" });
  });

  it("tells a following window each click and cue, and stops when it stops", async () => {
    const seen: Array<NotifyWindowEvent> = [];
    const following = Effect.runFork(Stream.runForEach(page.NotificationsEvents(), (event) => Effect.sync(() => seen.push(event))));
    await until(() => listeners.size === 1);
    for (const listener of listeners) listener({ _tag: "Activate", target: { kind: "seat", canvasName: "main", nodeId: "maple" } });
    for (const listener of listeners) listener({ _tag: "Cue", cue: "blocked" });
    await until(() => seen.length === 2);
    expect(seen).toEqual([
      { _tag: "Activate", target: { kind: "seat", canvasName: "main", nodeId: "maple" } },
      { _tag: "Cue", cue: "blocked" },
    ]);
    await Effect.runPromise(Fiber.interrupt(following));
    await until(() => listeners.size === 0);
    expect(listeners.size).toBe(0);
  });

  it("refuses at main's edge a report its schema does not read, before the plane or the core hear of it", async () => {
    const { port1, port2 } = new MessageChannel();
    const server = Effect.runFork(
      Layer.launch(
        RpcServer.layer(NotificationsWindowRpcs).pipe(
          Layer.provide(handlers),
          Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(heldForServer(linkOf(port1))))),
        ),
      ),
    );
    // A client of a drifted contract: the same tag, with a badge main's schema never reads.
    const Drifted = RpcGroup.make(
      Rpc.make("NotificationsReport", {
        payload: { report: Schema.Struct({ canvasName: Schema.String, subjects: Schema.Array(Schema.Unknown), badge: Schema.String }) },
      }),
    );
    try {
      const exit = await Effect.runPromiseExit(
        Effect.scoped(
          RpcClient.make(Drifted).pipe(
            Effect.provideServiceEffect(RpcClient.Protocol, clientProtocol(linkOf(port2))),
            Effect.flatMap((client) => client.NotificationsReport({ report: { canvasName: "main", subjects: [], badge: "two" } })),
          ),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(reported).toEqual([]);
      expect(companionReports).toEqual([]);
    } finally {
      await Effect.runPromise(Fiber.interrupt(server));
      port1.close();
      port2.close();
    }
  });
});
