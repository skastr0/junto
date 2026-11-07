/**
 * The terminal groups (src/contract/core/term-ipc.ts, term-templates.ts) and
 * the seat credential lookup (seat-credentials.ts) at main's edge, over a
 * MessageChannel to the core's own handlers on a test plane: what the window
 * sends is decoded closed and never reaches the plane when it does not
 * decode, what the plane answers crosses the port's JSON whole (a summary
 * with unset fields, a journal's bigint sequence numbers), and a plane that
 * refuses is heard in its own words.
 */
import { EventEmitter } from "node:events";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { Context, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { RpcServer } from "effect/rpc";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { serverProtocol, type PortMessage, type RpcPort } from "../src/shared/rpc-port";
import { CoreLink } from "../src/contract/core/link";
import { TermCore, TermRpcs } from "../src/contract/core/term-ipc";
import { TermTemplatesCore, TermTemplatesRpcs } from "../src/contract/core/term-templates";
import { SeatCredentialsCore, SeatCredentialsRpcs } from "../src/contract/core/seat-credentials";
import { TermIpcPlane, TermPlaneHandlers } from "../src/core/ops/term-ipc";
import { TermTemplatesHandlers } from "../src/core/ops/term-templates";
import { SeatCredentialsHandlers } from "../src/core/ops/seat-credentials";
import { inProcessBus } from "./support/in-process-pushes";
import { CorePushesMain } from "../src/app/core-process/main-side/core-pushes";
import { ModelService } from "../src/core/model/service";
import { TerminalNodeDeleteService } from "../src/core/term/node-delete";

vi.mock("../src/app/runtime", () => ({ AppRuntime: ManagedRuntime.make(Layer.empty) }));

const { registerTerminalIpc } = await import("../src/app/term/ipc");
const { coreSeatCredentials } = await import("../src/app/browser/seat-credentials-ipc");

// The handlers on the test's plane and model. A handler that reads a service
// this test does not give fails when it is asked; none of those is asked here.
const termHandlers = TermPlaneHandlers as never as Layer.Layer<
  Layer.Success<typeof TermPlaneHandlers>,
  never,
  TermIpcPlane | ModelService
>;

const linkOf = (port: MessagePort): RpcPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: PortMessage) => handler(message);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

type Handler = (event: unknown, ...args: ReadonlyArray<unknown>) => unknown;

let scope: Scope.Closeable;
let ports: Array<MessagePort>;

beforeEach(async () => {
  scope = await Effect.runPromise(Scope.make());
  ports = [];
});

const buses: Array<ReturnType<typeof inProcessBus>> = [];
afterEach(async () => {
  await Effect.runPromise(Scope.close(scope, Exit.void));
  for (const port of ports) port.close();
  for (const bus of buses.splice(0)) bus.close();
});

/** A summary as the local host writes one: every unset field present, and undefined. */
const SUMMARY = {
  bindingId: "seat",
  epoch: "e1",
  hostId: "workbench",
  status: "running" as const,
  title: undefined,
  cwd: "/tmp",
  pid: undefined,
  detached: false,
  canvasName: undefined,
  nodeId: undefined,
  createdAt: 1,
  label: undefined,
  backend: "pty" as const,
  shellEnvironmentGeneration: undefined,
};

const ATTACHED = {
  ok: true as const,
  lease: { leaseId: "lease-1", bindingId: "seat", epoch: "e1", mode: "control" as const },
  cols: 80,
  rows: 24,
  journal: [
    { seq: 3n, type: "output" as const, data: "hello" },
    { seq: 4n, type: "exit" as const, code: 0, signal: undefined },
  ],
  status: "running",
  pid: undefined,
  screen: { bindingId: "seat", epoch: "e1", cols: 80, rows: 24, seq: 2n, serialized: "grid" },
};

/** Main's terminal IPC against the core's handlers on a test plane, across a port. */
const registered = async () => {
  const router = Object.assign(new EventEmitter(), {
    thisMachineName: () => "workbench",
    isLocalHostId: (hostId: string | undefined | null) => !hostId || hostId === "workbench",
    list: vi.fn(async () => [SUMMARY]),
    attach: vi.fn(async () => ATTACHED),
    kill: vi.fn(async () => {
      throw new Error("the router refused the stop");
    }),
    release: vi.fn(async () => {}),
  });
  const plane = { router, nodeDelete: new TerminalNodeDeleteService(router as never) };
  const { port1, port2 } = new MessageChannel();
  ports.push(port1, port2);
  // What the core pushes reaches main's bus for this test, as the relay feeds it in the app.
  const bus = inProcessBus();
  buses.push(bus);
  await Effect.runPromise(
    Layer.buildWithScope(
      RpcServer.layer(TermRpcs.merge(TermTemplatesRpcs, SeatCredentialsRpcs)).pipe(
        Layer.provide(Layer.mergeAll(termHandlers, TermTemplatesHandlers, SeatCredentialsHandlers)),
        Layer.provide(Layer.succeed(TermIpcPlane, plane as never)),
        Layer.provide(Layer.succeed(ModelService, {} as never)),
        Layer.provide(bus.layer),
        Layer.provide(Layer.effect(RpcServer.Protocol, serverProtocol(linkOf(port2)))),
      ),
      scope,
    ),
  );
  const clients = await Effect.runPromise(
    Layer.buildWithScope(
      Layer.mergeAll(TermCore.layer, TermTemplatesCore.layer, SeatCredentialsCore.layer).pipe(
        Layer.provide(Layer.succeed(CoreLink, linkOf(port1))),
      ),
      scope,
    ),
  );
  const core = Context.add(clients, CorePushesMain, bus.pushes);
  const handlers = new Map<string, Handler>();
  registerTerminalIpc(
    { handle: (channel: string, handler: Handler) => void handlers.set(channel, handler) } as never,
    { isTrustedSender: () => true, broadcast: () => {}, surfacePlane: () => undefined },
    core,
  );
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() });
  const invoke = (channel: string, ...args: ReadonlyArray<unknown>): unknown => {
    const handler = handlers.get(channel);
    if (handler === undefined) throw new Error(`${channel} handler not registered`);
    return handler({ sender }, ...args);
  };
  return { invoke, router, credentials: coreSeatCredentials(core) };
};

it("lists the plane's sessions across the port, an unset field as unset", async () => {
  const { invoke, router } = await registered();
  expect(await invoke(IPC_CHANNELS.terminalList, undefined)).toEqual([SUMMARY]);
  expect(router.list).toHaveBeenCalledWith(undefined);
});

it("attaches with the journal's and the screen's sequence numbers still bigints", async () => {
  const { invoke, router } = await registered();
  const attached = await invoke(IPC_CHANNELS.terminalAttach, { bindingId: "seat", mode: "control", takeover: true, hostId: undefined });
  expect(attached).toEqual(ATTACHED);
  expect(router.attach).toHaveBeenCalledWith({ bindingId: "seat", mode: "control", takeover: true, hostId: "workbench" });
});

it("refuses an attach this build does not read, and never asks the plane", async () => {
  const { invoke, router } = await registered();
  await expect(Promise.resolve(invoke(IPC_CHANNELS.terminalAttach, { bindingId: "seat", mode: "control", extra: 1 })))
    .rejects.toThrow(/does not read that attach/);
  await expect(Promise.resolve(invoke(IPC_CHANNELS.terminalAttach, { bindingId: "seat", mode: "watch" })))
    .rejects.toThrow(/does not read that attach/);
  expect(router.attach).not.toHaveBeenCalled();
});

it("says the plane's refusal in its own words", async () => {
  const { invoke, router } = await registered();
  await expect(Promise.resolve(invoke(IPC_CHANNELS.terminalKill, "seat", undefined))).rejects.toThrow(/the router refused the stop/);
  expect(router.kill).toHaveBeenCalledWith("seat", undefined);
});

it("answers a harness it does not know with nothing installed, without asking the core", async () => {
  const { invoke } = await registered();
  expect(await invoke(IPC_CHANNELS.managedTerminalFlags, "not-a-harness", "/tmp")).toEqual({ installed: false, flags: [] });
});

it("reads a credential the registry does not know as unknown", async () => {
  const { credentials } = await registered();
  expect(await credentials.lookup("not-a-credential")).toEqual({ status: "unknown" });
});
