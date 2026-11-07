/**
 * The session host keeps the terminal process's surface gate where `write`
 * would decide (phase 3): it names the control lease the attach minted, moves
 * on a takeover, closes on release, a stop and the input seal, and holds keys
 * for exactly as long as a managed span. A surface opened for the control
 * lease types into the PTY and its echo comes back on the port, and typing
 * on it is operator presence. Real PTYs over real ports.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context, Effect, Exit, Layer, Scope } from "effect";
import type { TerminalLink, TerminalLinkMessage, TerminalLinkPort } from "../src/contract/terminal/protocol";
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
  const recording: TerminalLinkPort = {
    post: (message) => {
      if (message.kind === "command" && message.message._tag === "gate") gates.push(message.message.lease);
      if (message.kind === "command" && message.message._tag === "hold") holds.push(message.message.held);
      core.post(message);
    },
    listen: core.listen,
  };
  // Moved behind every spawn on the same port, as the utilityProcess does.
  placeTerminals({ kind: "process", client: terminalClient(recording, (message, surface) => {
    port1.postMessage({ ...(message as object), port: surface }, [surface as MessagePort]);
  }) });
  return { gates, holds };
};

const asCore = (port: MessagePort): TerminalLinkPort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: TerminalLinkMessage) => handler(message);
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

describe("the session host and the terminal process's surface gate", () => {
  it("names the control lease, moves on a takeover, and closes on release", async () => {
    const { host, gates, epoch } = await start();
    expect(gates).toEqual([]);
    const first = await control(host);
    expect(gates).toEqual([{ leaseId: first.leaseId, epoch }]);
    const second = await control(host, true);
    expect(gates.at(-1)).toEqual({ leaseId: second.leaseId, epoch });
    host.release(second);
    expect(gates.at(-1)).toBeNull();
  });

  it("closes on a stop and on the input seal, and opens again when the seal lifts", async () => {
    const { host, gates } = await start();
    const lease = await control(host);
    let sealed = true;
    host.setInputSealed(() => sealed);
    expect(gates.at(-1)).toBeNull();
    sealed = false;
    host.inputSealChanged("b1");
    expect(gates.at(-1)).toEqual({ leaseId: lease.leaseId, epoch: lease.epoch });
    host.kill("b1");
    expect(gates.at(-1)).toBeNull();
  });

  it("holds keys for exactly as long as a managed span", async () => {
    const { host, holds, interlock } = await start();
    await control(host);
    const outer = interlock.beginHold("b1");
    const inner = interlock.beginHold("b1");
    expect(holds).toEqual([true]);
    inner();
    expect(holds).toEqual([true]);
    outer();
    expect(holds).toEqual([true, false]);
  });

  it("a surface for the control lease types into the PTY, echoes on its port, and counts as typing", async () => {
    const { host, interlock } = await start();
    const lease = await control(host);
    const view = renderer();
    expect(host.openSurface(lease, view.far)).toBeTypeOf("function");
    const before = interlock.inputVersion("b1");
    view.type("echo surfaced-$((40+2))\r");
    await until(() => view.text().includes("surfaced-42"));
    expect(interlock.inputVersion("b1")).toBeGreaterThan(before);
    host.release(lease);
    await until(() => view.seen.some((message) => message.t === "end"));
  });

  it("a surface starts after what the attach screen held, and repeats none of it", async () => {
    const { host } = await start();
    const warm = await control(host);
    const first = renderer();
    expect(host.openSurface(warm, first.far)).toBeTypeOf("function");
    first.type("echo held-$((6*7))\r");
    await until(() => first.text().includes("held-42"));
    host.release(warm);
    // Let the grid absorb it, so the next attach's screen holds it.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const attached = await host.attach({ bindingId: "b1", mode: "control", takeover: true });
    if (!attached.ok) throw new Error(attached.message);
    expect(attached.screen?.serialized).toContain("held-42");
    const view = renderer();
    expect(host.openSurface(attached.lease, view.far)).toBeTypeOf("function");
    view.type("echo after-$((50+1))\r");
    await until(() => view.text().includes("after-51"));
    expect(view.text()).not.toContain("held-42");
  });

  it("refuses a surface for a lease that does not control the session", async () => {
    const { host } = await start();
    const first = await control(host);
    await control(host, true);
    const view = renderer();
    expect(host.openSurface(first, view.far)).toBeUndefined();
    await until(view.closed);
  });
});
