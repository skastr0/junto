/**
 * Surface ports in the terminal process (phase 3): a key from a surface port
 * reaches the PTY and its echo comes back on the same port, with nothing on
 * the core's side in between. The core hears every key as it arrives,
 * refused ones included, and again once it landed. Only the lease the core's
 * gate names writes, key by key: closed until named, a second or stale lease
 * dropped. A held span queues keys and writes them in order at release, each
 * checked again; a closed gate drops what was held. A
 * surface opened late is given the output it missed from the ring, or told
 * there is a gap; an exit or a lease end closes it. Real PTYs.
 */
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";
import type { CoreMessage, CorePort } from "../src/main/core-process/port";
import { serveTerminals, SURFACE_RING_BYTES, type SpawnPty, type SurfacePort } from "../src/main/terminal-process/serve";
import { terminalClient } from "../src/main/terminal-process/client";
import { TerminalSurface, type SurfaceOut, type TerminalInput } from "../src/main/terminal-process/protocol";

const nodePty = createRequire(import.meta.url)("node-pty") as typeof import("node-pty");
const realPty: SpawnPty = (command, args, options) => nodePty.spawn(command, [...args], options);

const opened: MessagePort[] = [];
afterEach(() => {
  for (const port of opened.splice(0)) port.close();
});

const portOf = (port: MessagePort): CorePort => ({
  post: (message) => port.postMessage(message),
  listen: (handler) => {
    const on = (message: CoreMessage) => handler(message);
    port.on("message", on);
    return () => port.off("message", on);
  },
});

const until = async (check: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

const setup = (spawnPty: SpawnPty = realPty) => {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  const served = serveTerminals(portOf(port2), spawnPty);
  const inputs: string[] = [];
  const typing: string[] = [];
  port1.on("message", (message: CoreMessage) => {
    if (message.kind !== "push") return;
    if (message.channel === TerminalSurface.input) inputs.push((message.payload as TerminalInput).data);
    if (message.channel === TerminalSurface.typing) typing.push((message.payload as TerminalInput).data);
  });
  return { served, client: terminalClient(portOf(port1)), inputs, typing };
};

/** The renderer's end: everything the surface was sent, and a way to type. */
const surface = (served: ReturnType<typeof setup>["served"], id: number, leaseId: string, fromSeq = 1, epoch = "1") => {
  const { port1, port2 } = new MessageChannel();
  opened.push(port1, port2);
  const far: SurfacePort = {
    post: (message) => port2.postMessage(message),
    listen: (handler) => {
      port2.on("message", handler);
      return () => port2.off("message", handler);
    },
    close: () => port2.close(),
  };
  const seen: SurfaceOut[] = [];
  port1.on("message", (message: SurfaceOut) => seen.push(message));
  served.openSurface({ id, leaseId, epoch, fromSeq }, far);
  return {
    seen,
    text: () => seen.flatMap((message) => (message.t === "out" ? [message.data] : [])).join(""),
    type: (data: string) => port1.postMessage({ t: "in", data }),
  };
};

const lease1 = { leaseId: "lease-1", epoch: "1" };

const env = { PATH: process.env.PATH, TERM: "xterm-256color" };
const cat = (client: ReturnType<typeof setup>["client"]) => client.spawn({ command: "/bin/cat", args: [], cols: 80, rows: 24, env });

describe("surface ports in the terminal process", () => {
  it("a key from a surface echoes on it, and the core hears the key", async () => {
    const { served, client, inputs } = setup();
    const pty = cat(client);
    await pty.pid;
    pty.gate(lease1);
    await settle();
    const lead = surface(served, pty.id, "lease-1");
    lead.type("hello\r");
    await until(() => lead.text().includes("hello"));
    expect(inputs).toEqual(["hello\r"]);
    const seqs = lead.seen.flatMap((message) => (message.t === "out" ? [message.seq] : []));
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
    pty.kill("SIGKILL");
  });

  it("drops keys until the core opens the gate", async () => {
    const { served, client, inputs } = setup();
    const pty = cat(client);
    await pty.pid;
    const lead = surface(served, pty.id, "lease-1");
    lead.type("before\r");
    await settle();
    expect(lead.text()).toBe("");
    expect(inputs).toEqual([]);
    pty.gate(lease1);
    // The gate and the key cross different ports; a key wins no race to it.
    await settle();
    lead.type("after\r");
    await until(() => lead.text().includes("after"));
    expect(lead.text()).not.toContain("before");
    pty.kill("SIGKILL");
  });

  it("a held span queues keys and writes them in order at release", async () => {
    const { served, client, inputs } = setup();
    const pty = cat(client);
    await pty.pid;
    pty.gate(lease1);
    pty.hold(true);
    await settle();
    const lead = surface(served, pty.id, "lease-1");
    lead.type("one ");
    lead.type("two\r");
    await settle();
    expect(lead.text()).toBe("");
    pty.hold(false);
    await until(() => lead.text().includes("one two"));
    expect(inputs).toEqual(["one ", "two\r"]);
    pty.kill("SIGKILL");
  });

  it("closing the gate drops what a span held", async () => {
    const { served, client, inputs } = setup();
    const pty = cat(client);
    await pty.pid;
    pty.gate(lease1);
    pty.hold(true);
    await settle();
    const lead = surface(served, pty.id, "lease-1");
    lead.type("held\r");
    await settle();
    pty.gate(null);
    pty.hold(false);
    await settle();
    expect(lead.text()).toBe("");
    expect(inputs).toEqual([]);
    pty.kill("SIGKILL");
  });

  it("a second lease on an open gate writes nothing, and the core still hears it type", async () => {
    const { served, client, inputs, typing } = setup();
    const pty = cat(client);
    await pty.pid;
    pty.gate(lease1);
    await settle();
    const lead = surface(served, pty.id, "lease-1");
    const other = surface(served, pty.id, "lease-2");
    other.type("intruder\r");
    lead.type("owner\r");
    await until(() => lead.text().includes("owner"));
    await settle();
    expect(lead.text()).not.toContain("intruder");
    expect(inputs).toEqual(["owner\r"]);
    expect(typing).toEqual(expect.arrayContaining(["intruder\r", "owner\r"]));
    pty.kill("SIGKILL");
  });

  it("a lease of another generation writes nothing", async () => {
    const { served, client, inputs } = setup();
    const pty = cat(client);
    await pty.pid;
    pty.gate(lease1);
    await settle();
    const stale = surface(served, pty.id, "lease-1", 1, "0");
    stale.type("stale\r");
    await settle();
    expect(inputs).toEqual([]);
    pty.kill("SIGKILL");
  });

  it("a held key from a lease that lost control is dropped at release", async () => {
    const { served, client, inputs, typing } = setup();
    const pty = cat(client);
    await pty.pid;
    pty.gate(lease1);
    pty.hold(true);
    await settle();
    const lead = surface(served, pty.id, "lease-1");
    const next = surface(served, pty.id, "lease-2");
    lead.type("from the old lease\r");
    await until(() => typing.length === 1);
    // Taken over while the span held the key.
    pty.gate({ leaseId: "lease-2", epoch: "1" });
    pty.hold(false);
    await settle();
    next.type("from the new lease\r");
    await until(() => next.text().includes("from the new lease"));
    expect(next.text()).not.toContain("old lease");
    expect(inputs).toEqual(["from the new lease\r"]);
    pty.kill("SIGKILL");
  });

  it("a refused key still reaches the core as typing", async () => {
    const { served, client, inputs, typing } = setup();
    const pty = cat(client);
    await pty.pid;
    const lead = surface(served, pty.id, "lease-1");
    lead.type("x");
    await until(() => typing.length === 1);
    expect(typing).toEqual(["x"]);
    expect(inputs).toEqual([]);
    pty.kill("SIGKILL");
  });

  it("a late surface is given what it missed from the ring, or told of a gap", async () => {
    const { served, client } = setup();
    const pty = client.spawn({ command: "/bin/sh", args: ["-c", "printf early; read go; printf late"], cols: 80, rows: 24, env });
    await pty.pid;
    pty.gate(lease1);
    const first = surface(served, pty.id, "lease-1");
    await until(() => first.text().includes("early"));
    const late = surface(served, pty.id, "lease-2", 1);
    await until(() => late.text().includes("early"));
    first.type("\r");
    await until(() => late.text().includes("late"));
    pty.kill("SIGKILL");

    const big = setup();
    const flood = big.client.spawn({ command: "/bin/sh", args: ["-c", `head -c ${SURFACE_RING_BYTES * 2} /dev/zero | tr '\\0' x; read go`], cols: 80, rows: 24, env });
    await flood.pid;
    let total = 0;
    flood.onData((data) => {
      total += data.length;
    });
    await until(() => total >= SURFACE_RING_BYTES * 2);
    const behind = surface(big.served, flood.id, "lease-3", 1);
    await until(() => behind.seen.length > 0);
    expect(behind.seen[0]).toEqual({ t: "gap" });
    flood.kill("SIGKILL");
  });

  it("an exit or a lease end closes the surface", async () => {
    const { served, client } = setup();
    const pty = cat(client);
    await pty.pid;
    const one = surface(served, pty.id, "lease-1");
    const two = surface(served, pty.id, "lease-2");
    pty.endSurface("lease-1");
    await until(() => one.seen.some((message) => message.t === "end"));
    expect(two.seen.some((message) => message.t === "end")).toBe(false);
    pty.kill("SIGKILL");
    await until(() => two.seen.some((message) => message.t === "end"));
    const gone = surface(served, pty.id, "lease-3");
    await until(() => gone.seen.some((message) => message.t === "end"));
  });
});
