import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalSessionHost,
  type TermChild,
  type TermSpawnFn,
} from "../src/main/vellum/term/local-host";
import { startTermControlServer } from "../src/main/vellum/term/control-server";
import { TermControlClient } from "../src/main/vellum/term/control-client";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum/process-identity";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  setProcessIdentityMapForTests(undefined);
});

const fakeSpawn = (): TermSpawnFn => {
  return () => {
    const dataListeners = new Set<(d: string) => void>();
    const exitListeners = new Set<(c: number | undefined, s: number | undefined) => void>();
    let alive = true;
    const child: TermChild = {
      pid: 9001,
      write(data: string) {
        // Echo back so attach/write paths are observable.
        for (const l of dataListeners) l(`echo:${data}`);
      },
      resize() {
        /* noop */
      },
      kill() {
        if (!alive) return;
        alive = false;
        for (const l of exitListeners) l(0, undefined);
      },
      onData(listener) {
        dataListeners.add(listener);
        queueMicrotask(() => listener("ready\r\n"));
      },
      onExit(listener) {
        exitListeners.add(listener);
      },
    };
    return child;
  };
};

describe("term control UDS", () => {
  it("auth + create + attach + write + kill over NDJSON with bigint journal", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    const home = mkdtempSync(join(tmpdir(), "vellum-term-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));

    const host = new LocalSessionHost(fakeSpawn());
    cleanups.push(() => host.shutdownAll("test"));

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
    const home = mkdtempSync(join(tmpdir(), "vellum-term-bad-"));
    cleanups.push(() => rmSync(home, { recursive: true, force: true }));
    const host = new LocalSessionHost(fakeSpawn());
    cleanups.push(() => host.shutdownAll("test"));
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
});
