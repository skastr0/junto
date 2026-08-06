import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalSessionHost } from "../src/main/vellum/term/local-host";
import { startTermControlServer } from "../src/main/vellum/term/control-server";
import { TermControlClient } from "../src/main/vellum/term/control-client";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/vellum/process-epoch";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const cleanups: Array<() => Promise<void> | void> = [];

beforeEach(() => {
  setProcessEpochReaderForTests({
    snapshot: () => [{
      pid: 9001,
      processGroupId: 9000,
      sessionId: 7,
      startKey: "synthetic-9001",
    }],
  });
});

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  setProcessEpochReaderForTests(undefined);
  setProcessIdentityMapForTests(undefined);
});

const fakeAuthority = () => makeFakeTerminalProcessAuthority(() => ({
  pid: 9001,
  output: "ready\r\n",
  exitOnSignal: "SIGTERM",
  echoWrites: "echo:",
})).authority;

describe("term control UDS", () => {
  it("auth + create + attach + write + kill over NDJSON with bigint journal", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    const home = mkdtempSync(join(tmpdir(), "vt-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));

    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });

    const server = await startTermControlServer(host, { home });
    cleanups.push(() => server.close());

    const client = await TermControlClient.connect({
      socketPath: server.socketPath,
      token: server.token,
      timeoutMs: 5_000,
    });
    cleanups.push(() => client.close());

    const created = await client.create({
      bindingId: "bind_a",
      launch: { kind: "shell" },
      cols: 80,
      rows: 24,
      label: "t",
    });
    expect(created.bindingId).toBe("bind_a");
    expect(created.status).toBe("running");

    const listed = await client.list();
    expect(listed.some((s) => s.bindingId === "bind_a")).toBe(true);

    const browsedPath = join(home, "project");
    mkdirSync(browsedPath);
    const browsed = await client.readDirectory(home);
    expect(browsed.entries).toContainEqual(
      expect.objectContaining({
        name: "project",
        path: join(browsed.root, "project"),
        kind: "directory",
      }),
    );

    const attach = await client.attach({
      bindingId: "bind_a",
      mode: "control",
      takeover: true,
    });
    expect(attach.ok).toBe(true);
    if (!attach.ok) return;

    // Journal may include startup "ready" output — seq must revive as bigint.
    for (const entry of attach.journal) {
      expect(typeof entry.seq).toBe("bigint");
    }

    const events: string[] = [];
    client.on("event", (ev) => {
      if (ev && typeof ev === "object" && (ev as { type?: string }).type === "output") {
        events.push(String((ev as { data?: string }).data ?? ""));
      }
    });

    const wrote = await client.write(attach.lease.leaseId, "hi");
    expect(wrote).toBe(true);

    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.includes("echo:hi"))).toBe(true);

    const killed = await client.kill("bind_a");
    expect(killed).toBe(true);
    const after = await client.get("bind_a");
    expect(after?.status === "exited" || after === undefined).toBe(true);
  });

  it("rejects bad token", async () => {
    const home = mkdtempSync(join(tmpdir(), "vtb-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });
    const server = await startTermControlServer(host, { home });
    cleanups.push(() => server.close());

    await expect(
      TermControlClient.connect({
        socketPath: server.socketPath,
        token: "not-the-token",
        timeoutMs: 3_000,
      }),
    ).rejects.toThrow(/unauth|auth/i);
  });

  it("caps accepted peers before frame admission and recovers after close", async () => {
    const home = mkdtempSync(join(tmpdir(), "vtc-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => { await host.shutdownAll("test"); });
    const server = await startTermControlServer(host, { home, maxActiveClients: 1 });
    cleanups.push(() => server.close());
    const first = createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => { first.once("connect", resolve); first.once("error", reject); });
    const excess = createConnection(server.socketPath);
    await new Promise<void>((resolve) => excess.once("close", resolve));
    first.destroy();
    await new Promise<void>((resolve) => first.once("close", resolve));
    const recovered = createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => { recovered.once("connect", resolve); recovered.once("error", reject); });
    recovered.destroy();
  });

  it("boundedly drains an active client when the control server closes", async () => {
    const home = mkdtempSync(join(tmpdir(), "vtcl-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });
    const server = await startTermControlServer(host, { home });

    const socket = createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`${JSON.stringify({ token: server.token })}\n`);

    await expect(
      Promise.race([
        server.close(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("close timed out")), 1_000)),
      ]),
    ).resolves.toBeUndefined();
    expect(socket.destroyed).toBe(true);
  });

  it("stops accepting late clients and commands when close begins", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    const home = mkdtempSync(join(tmpdir(), "vtl-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeAuthority());
    cleanups.push(async () => {
      await host.shutdownAll("test");
    });
    const server = await startTermControlServer(host, { home });
    const active = createConnection(server.socketPath);
    await new Promise<void>((resolve, reject) => {
      active.once("connect", resolve);
      active.once("error", reject);
    });

    const closing = server.close();
    active.write(`${JSON.stringify({ token: server.token })}\n`);
    active.write(`${JSON.stringify({ v: 1, id: "late", op: "create", bindingId: "late" })}\n`);
    const late = createConnection(server.socketPath);
    const lateOutcome = await new Promise<"connected" | "rejected">((resolve) => {
      late.once("connect", () => resolve("connected"));
      late.once("error", () => resolve("rejected"));
    });
    if (lateOutcome === "connected") late.destroy();

    await closing;
    expect(host.list()).toEqual([]);
  });
});
