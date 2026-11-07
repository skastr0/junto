/**
 * A generation that drains off its seat (an offboard) lets go of every
 * surface reading it in the same step: the view's port ends, and nothing the
 * old process prints after reaches it. The fresh generation's lookup by
 * binding never finds the drained one, so the host ends them by the
 * generation each was opened on. Real PTYs over real ports.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import type { TerminalLink, TerminalLinkMessage } from "../src/contract/terminal/protocol";
import { createAppProcessPlane } from "../src/node/app-process-plane";
import { LocalSessionHost } from "../src/core/term/local-host";
import { OperatorInterlock } from "../src/core/term/drive/operator-interlock";
import { CoreLink, PidEpochs, PtySpawner, TerminalServer, type SpawnPty, type SurfacePort } from "../src/terminal/serve";
import { terminalClient } from "../src/node/terminals/client";
import { placeTerminals } from "../src/node/terminals/use";
import type { SurfaceOut } from "../src/contract/terminal/protocol";
import type { TerminalGate } from "../src/contract/terminal/messages";
import { makeThisMachine } from "../src/shared/remote-hosts";
import { hostsSnapshot, setHostsSnapshot } from "../src/core/hosts/snapshot";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
const realPty: SpawnPty = (command, args, options) => nodePty.spawn(command, [...args], options);

const opened: MessagePort[] = [];
const scopes: Scope.Closeable[] = [];
const hosts: LocalSessionHost[] = [];
const initialHosts = hostsSnapshot();
const initialShell = process.env.SHELL;

beforeEach(() => {
  setHostsSnapshot([makeThisMachine("workbench")]);
  process.env.SHELL = "/bin/sh";
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdownAll("test");
  // Closing the server's scope hangs up every PTY it still holds.
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
  placeTerminals({ kind: "here" });
  for (const port of opened.splice(0)) port.close();
  setHostsSnapshot(initialHosts);
  process.env.SHELL = initialShell;
});

const until = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

/** The real terminal server through its layer, with the parent stubbed: it never connects a core of its own. */
const boot = () => {
  const scope = Effect.runSync(Scope.make());
  scopes.push(scope);
  const deps = Layer.mergeAll(
    Layer.succeed(PtySpawner, realPty),
    PidEpochs.live,
    Layer.succeed(CoreLink, { parentAsCore: undefined, listenParent: () => () => undefined }),
  );
  const context = Effect.runSync(Layer.buildWithScope(Layer.provideMerge(TerminalServer.layer, deps), scope));
  return Context.get(context, TerminalServer);
};

/** The served end of the core's link: a node port carries a transferred port inside the posted value. */
const servedLink = (port: MessagePort): TerminalLink<SurfacePort> => ({
  post: (message) => port.postMessage(message),
  transfer: () => {
    throw new Error("the terminal process posts no port on the link");
  },
  listen: (handler) => {
    const on = (message: TerminalLinkMessage & { readonly port?: MessagePort }) =>
      handler(message, message.port === undefined ? undefined : surfaceOf(message.port));
    port.on("message", on);
    return () => port.off("message", on);
  },
});

const install = () => {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  // The terminal process's side: a surface port rides beside its numbered
  // `surfaceOpen`, as entry.ts takes it from a utilityProcess message.
  boot().attach(servedLink(port2), 1);
  const gates: Array<TerminalGate["lease"]> = [];
  const holds: boolean[] = [];
  const core = asCore(port1);
  const recording: TerminalLink<MessagePort> = {
    // Moved behind every spawn on the same port, as the utilityProcess does.
    transfer: (frame, surface) => port1.postMessage({ ...frame, port: surface }, [surface]),
    post: (message) => {
      if (message.kind === "command" && message.message._tag === "gate") gates.push(message.message.lease);
      if (message.kind === "command" && message.message._tag === "hold") holds.push(message.message.held);
      core.post(message);
    },
    listen: core.listen,
  };
  placeTerminals({ kind: "process", client: terminalClient(recording) });
  return { gates, holds };
};

const asCore = (port: MessagePort): Pick<TerminalLink<MessagePort>, "post" | "listen"> => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: TerminalLinkMessage) => handler(message, undefined);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

const surfaceOf = (port: MessagePort): SurfacePort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    port.on("message", handler);
    return () => port.off("message", handler);
  },
  close: () => port.close(),
});

const renderer = () => {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  const seen: SurfaceOut[] = [];
  let closed = false;
  port1.on("message", (message: SurfaceOut) => seen.push(message));
  port1.on("close", () => {
    closed = true;
  });
  return {
    far: port2,
    closed: () => closed,
    seen,
    text: () => seen.flatMap((message) => (message.t === "out" ? [message.data] : [])).join(""),
    type: (data: string) => port1.postMessage({ t: "in", data }),
  };
};

const start = async (interlock = new OperatorInterlock()) => {
  const recorded = install();
  const plane = createAppProcessPlane({ termGraceMs: 200, killGraceMs: 200 });
  const host = new LocalSessionHost(plane, { killGraceMs: 50, shutdownGraceMs: 50, lateExitGraceMs: 50, operatorInterlock: interlock });
  hosts.push(host);
  const created = host.create({ bindingId: "b1", launch: { kind: "shell" }, cols: 80, rows: 24 });
  expect(created.status).toBe("running");
  return { ...recorded, host, interlock, epoch: created.epoch };
};

const control = async (host: LocalSessionHost, takeover = false) => {
  const attached = await host.attach({ bindingId: "b1", mode: "control", takeover });
  if (!attached.ok) throw new Error(attached.message);
  return attached.lease;
};

describe("a drained generation's surfaces", () => {
  it("end at the drain, and the old process's later output never reaches the view", async () => {
    const { host } = await start();
    const lease = await control(host);
    const view = renderer();
    expect(host.openSurface(lease, view.far)).toBeTypeOf("function");
    view.type("echo before-$((40+2))\r");
    await until(() => view.text().includes("before-42"));
    const drained = host.drain("b1");
    expect(drained).toBeDefined();
    await until(() => view.seen.some((message) => message.t === "end"));
    // The old process still runs, and prints on its own terminal.
    const ended = view.seen.length;
    host.stopDraining(drained!.drainKey, "test");
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(view.seen.slice(ended).filter((message) => message.t === "out")).toEqual([]);
  });

  it("an observe surface on the drained generation ends too", async () => {
    const { host } = await start();
    await control(host);
    const attached = await host.attach({ bindingId: "b1", mode: "observe" });
    if (!attached.ok) throw new Error(attached.message);
    const tile = renderer();
    expect(host.openSurface(attached.lease, tile.far)).toBeTypeOf("function");
    expect(host.drain("b1")).toBeDefined();
    await until(() => tile.seen.some((message) => message.t === "end"));
  });
});
