/**
 * The seats group (src/contract/core/seats.ts) at main's edge
 * (src/app/seats/seats-ipc.ts), over a MessageChannel to a core that records
 * what it was asked: what the window sends is decoded closed, a call that
 * does not decode is refused in the operator's words and never reaches the
 * core, and a call that does reaches it typed.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import type { IpcMainInvokeEvent } from "electron";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { RpcServer } from "effect/rpc";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { PAUSED_CANVAS } from "../src/shared/pause";
import { serverProtocol, type PortMessage, type RpcPort } from "../src/shared/rpc-port";
import { CoreLink } from "../src/contract/core/link";
import { SeatsCore, SeatsRpcs } from "../src/contract/core/seats";

vi.mock("../src/app/runtime", () => ({ AppRuntime: ManagedRuntime.make(Layer.empty) }));

const { registerSeatsIpc } = await import("../src/app/seats/seats-ipc");

const linkOf = (port: MessagePort): RpcPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: PortMessage) => handler(message);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

/** A listener as Electron's `ipcMain.handle` takes it. */
type Listener = (event: IpcMainInvokeEvent, ...args: ReadonlyArray<unknown>) => unknown;
/** Electron's event, which the registrar under test never reads. */
const event = {} as IpcMainInvokeEvent;

let scope: Scope.Closeable;
let ports: Array<MessagePort>;
let asked: Array<readonly [string, unknown]>;

/** A core that answers every seat call plainly and records what reached it. */
const recording = SeatsRpcs.toLayer({
  SeatsRegionEnvReport: (payload) => Effect.sync(() => (asked.push(["report", payload]), { ok: true as const, report: [] })),
  SeatsRegionEnvStaleSeats: (payload) => Effect.sync(() => (asked.push(["stale", payload]), { ok: true as const, seats: [] })),
  SeatsRegionEnvSaveSecret: (payload) => Effect.sync(() => (asked.push(["save", payload]), { ok: true as const, secretId: "secret-1" })),
  SeatsRegionEnvRemoveSecret: (payload) => Effect.sync(() => (asked.push(["remove", payload]), { ok: true as const })),
  SeatsFactoryPauseState: (payload) => Effect.sync(() => (asked.push(["pauseState", payload]), { playing: true, everPlayed: true })),
  SeatsFactoryPauseSet: (payload) =>
    Effect.sync(() => (asked.push(["pauseSet", payload]), { ok: true as const, state: { playing: !payload.paused, everPlayed: true } })),
  SeatsManagedPrompt: (payload) =>
    Effect.sync(() => (asked.push(["prompt", payload]), { ok: true as const, disposition: "queued" as const, messageId: "m1" })),
  SeatsOffboardProgress: () => Effect.sync(() => (asked.push(["progress", null]), [])),
  SeatsOffboardAsk: (payload) => Effect.sync(() => (asked.push(["offboard", payload]), { ok: true as const })),
  SeatsOnboardNudge: (payload) => Effect.sync(() => (asked.push(["nudge", payload]), { ok: true as const })),
});

beforeEach(async () => {
  scope = await Effect.runPromise(Scope.make());
  ports = [];
  asked = [];
});

afterEach(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const port of ports) port.close();
});

/** Main's seat IPC registered against a recording core; `invoke` calls a channel as the window would. */
const registered = async () => {
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  await Effect.runPromise(
    Layer.buildWithScope(
      RpcServer.layer(SeatsRpcs).pipe(Layer.provide(recording), Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(linkOf(port2))))),
      scope,
    ),
  );
  const core = await Effect.runPromise(Layer.buildWithScope(SeatsCore.layer.pipe(Layer.provide(Layer.succeed(CoreLink, linkOf(port1)))), scope));
  const handlers = new Map<string, Listener>();
  registerSeatsIpc(
    {
      handle: (channel: string, listener: Listener): void => {
        handlers.set(channel, listener);
      },
    },
    core,
  );
  return (channel: string, ...args: ReadonlyArray<unknown>): unknown => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`${channel} handler not registered`);
    return handler(event, ...args);
  };
};

it("refuses what the window sent that does not decode, in the operator's words, without asking the core", async () => {
  const invoke = await registered();
  expect(await invoke(IPC_CHANNELS.regionEnvReport, 1, "region")).toEqual({ ok: false, message: "That region is not on this canvas." });
  expect(await invoke(IPC_CHANNELS.regionEnvStaleSeats, "factory", null)).toEqual({ ok: false, message: "That region is not on this canvas." });
  expect(await invoke(IPC_CHANNELS.regionEnvSaveSecret, { regionId: "r", name: "TOKEN", value: "v", extra: 1 })).toEqual({
    ok: false,
    message: "There is no secret to save.",
  });
  expect(await invoke(IPC_CHANNELS.regionEnvRemoveSecret, 7)).toEqual({ ok: true });
  expect(await invoke(IPC_CHANNELS.factoryPauseState, undefined)).toEqual(PAUSED_CANVAS);
  expect(await invoke(IPC_CHANNELS.factoryPauseSet, "factory", "yes")).toMatchObject({ ok: false });
  expect(await invoke(IPC_CHANNELS.terminalManagedPrompt, { bindingId: "b", text: "hi", sneaky: true })).toMatchObject({
    ok: false,
    disposition: "failed",
  });
  expect(await invoke(IPC_CHANNELS.seatOffboardAsk, "", "seat-1", "rest")).toEqual({ ok: false, message: "Junto could not find that seat." });
  expect(await invoke(IPC_CHANNELS.seatOffboardAsk, "factory", "seat-1", "later")).toEqual({
    ok: false,
    message: "Offboard to rest or to continue.",
  });
  expect(await invoke(IPC_CHANNELS.seatOnboardNudge, "factory", 3)).toEqual({ ok: false, message: "Junto could not find that seat." });
  expect(asked).toEqual([]);
});

it("hands the core each call that decodes, typed, and answers with what the core said", async () => {
  const invoke = await registered();
  expect(await invoke(IPC_CHANNELS.regionEnvReport, "factory", "region")).toEqual({ ok: true, report: [] });
  // The value crosses once; the screen's context does not.
  expect(await invoke(IPC_CHANNELS.regionEnvSaveSecret, { regionId: "r", name: "TOKEN", value: "v" })).toEqual({ ok: true, secretId: "secret-1" });
  expect(await invoke(IPC_CHANNELS.factoryPauseSet, "factory", true)).toEqual({ ok: true, state: { playing: false, everPlayed: true } });
  expect(await invoke(IPC_CHANNELS.terminalManagedPrompt, { bindingId: "b", text: "hi", canvasName: "factory", nodeId: "seat-1", wake: false }))
    .toEqual({ ok: true, disposition: "queued", messageId: "m1" });
  expect(await invoke(IPC_CHANNELS.seatOffboardAsk, "factory", "seat-1", "continue")).toEqual({ ok: true });
  expect(await invoke(IPC_CHANNELS.seatOnboardNudge, "factory", "seat-1")).toEqual({ ok: true });
  expect(await invoke(IPC_CHANNELS.seatOffboardProgressList)).toEqual([]);
  expect(asked).toEqual([
    ["report", { canvasName: "factory", regionId: "region" }],
    ["save", { value: "v" }],
    ["pauseSet", { canvas: "factory", paused: true }],
    ["prompt", { input: { bindingId: "b", text: "hi", canvasName: "factory", nodeId: "seat-1", wake: false } }],
    ["offboard", { canvasName: "factory", seatId: "seat-1", mode: "continue" }],
    ["nudge", { canvasName: "factory", seatId: "seat-1" }],
    ["progress", null],
  ]);
});
