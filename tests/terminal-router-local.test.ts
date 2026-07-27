import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Scope } from "effect";
import { LocalSessionHost } from "../src/main/vellum/term/local-host";
import { TerminalRouter } from "../src/main/vellum/term/router";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/vellum/process-epoch";
import { hostsSnapshot, setHostsSnapshot } from "../src/main/vellum/hosts/snapshot";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const hosts: LocalSessionHost[] = [];
const initialHosts = hostsSnapshot();
const syntheticEpochs = new Map<number, string>();

beforeEach(() => {
  syntheticEpochs.clear();
  setProcessEpochReaderForTests({
    snapshot: () => [...syntheticEpochs].map(([pid, startKey]) => ({
      pid,
      processGroupId: Math.max(2, pid - 1),
      sessionId: 7,
      startKey,
    })),
  });
});

afterEach(async () => {
  for (const h of hosts.splice(0)) {
    await h.shutdownAll("test");
  }
  setProcessEpochReaderForTests(undefined);
  setProcessIdentityMapForTests(undefined);
  setHostsSnapshot(initialHosts);
});

const fakeAuthority = (pid = 55_010) => {
  syntheticEpochs.set(pid, `synthetic-${pid}`);
  return makeFakeTerminalProcessAuthority(() => ({
    pid,
    exitOnSignal: "SIGTERM",
  })).authority;
};

describe("TerminalRouter local path", () => {
  it("create/get/list/attach/write/kill stay on LocalSessionHost for local hostId", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    const local = new LocalSessionHost(fakeAuthority());
    hosts.push(local);
    const router = new TerminalRouter(local);

    const created = await router.create({
      bindingId: "r1",
      hostId: "local",
      launch: { kind: "shell" },
      cols: 80,
      rows: 24,
    });
    expect(created.bindingId).toBe("r1");
    expect(created.hostId).toBe("local");
    expect(created.status).toBe("running");

    const listed = await router.list("local");
    expect(listed.some((s) => s.bindingId === "r1")).toBe(true);

    const got = await router.get("r1", "local");
    expect(got?.status).toBe("running");

    const attach = await router.attach({
      bindingId: "r1",
      mode: "control",
      takeover: true,
      hostId: "local",
    });
    expect(attach.ok).toBe(true);
    if (!attach.ok) return;

    expect(await router.write(attach.lease, "x", "local")).toBe(true);
    expect(await router.resize(attach.lease, 100, 40, "local")).toBe(true);
    await router.release(attach.lease, "local");

    expect(await router.kill("r1", "local")).toBe(true);
    expect(router.runningCount()).toBe(0);
  });

  it("only absent, empty, and an explicit local registry host are local", () => {
    const local = new LocalSessionHost(fakeAuthority());
    hosts.push(local);
    const router = new TerminalRouter(local);
    expect(router.isLocalHostId("local")).toBe(true);
    expect(router.isLocalHostId(undefined)).toBe(true);
    expect(router.isLocalHostId("")).toBe(true);
    expect(router.isLocalHostId("missing-host")).toBe(false);
  });

  it("unknown nonempty host IDs cannot acquire local terminal authority", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    const local = new LocalSessionHost(fakeAuthority());
    hosts.push(local);
    const router = new TerminalRouter(local);
    const lease = { leaseId: "lease", bindingId: "unknown", epoch: "1", mode: "control" as const };

    await expect(router.create({ bindingId: "unknown", hostId: "missing-host" })).rejects.toThrow(
      /not a remote SSH endpoint/,
    );
    expect(await router.list("missing-host")).toEqual([]);
    expect(await router.get("unknown", "missing-host")).toBeUndefined();
    expect(await router.kill("unknown", "missing-host")).toBe(false);
    await expect(router.bindCanvas("unknown", null, "missing-host")).rejects.toThrow(
      /not a remote SSH endpoint/,
    );
    expect(await router.attach({ bindingId: "unknown", mode: "control", hostId: "missing-host" })).toMatchObject({ ok: false });
    expect(await router.write(lease, "x", "missing-host")).toBe(false);
    expect(await router.resize(lease, 80, 24, "missing-host")).toBe(false);
    expect(local.list()).toEqual([]);
  });

  it("revokes a cached remote lease when its host endpoint changes", async () => {
    const local = new LocalSessionHost(fakeAuthority());
    hosts.push(local);
    const router = new TerminalRouter(local);
    setHostsSnapshot([
      ...initialHosts,
      { id: "studio", label: "Studio", kind: "remote", endpoint: "studio-new", capabilities: ["terminal"] },
    ]);
    const close = vi.fn();
    (router as unknown as { remotes: Map<string, unknown> }).remotes.set("studio", {
      client: { close },
      forward: {},
      endpoint: "studio-old",
      generation: 0,
      scope: {},
      rootScope: Effect.runSync(Scope.make()),
      leaseMap: new Map([["lease", "remote-lease"]]),
      reverseLease: new Map([["remote-lease", "lease"]]),
    });

    const lease = { leaseId: "lease", bindingId: "remote", epoch: "1", mode: "control" as const };
    expect(await router.write(lease, "x", "studio")).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it("waits for superseded endpoint dials before remote shutdown returns", async () => {
    const local = new LocalSessionHost(fakeAuthority());
    hosts.push(local);
    const router = new TerminalRouter(local);
    setHostsSnapshot([
      ...initialHosts,
      { id: "studio", label: "Studio", kind: "remote", endpoint: "studio-a", capabilities: ["terminal"] },
    ]);
    const gates = new Map<string, () => void>();
    const cleanup: string[] = [];
    (router as unknown as { connectRemote: (...args: unknown[]) => Promise<never> }).connectRemote = async (
      _hostId,
      endpoint,
      _generation,
      admit,
    ) => {
      await new Promise<void>((resolve) => gates.set(endpoint as string, resolve));
      if (!(admit as () => boolean)()) {
        cleanup.push(endpoint as string);
        throw new Error("connection revoked");
      }
      throw new Error("test connection should not be admitted");
    };

    const creatingA = router.create({ bindingId: "remote-a", hostId: "studio" });
    await Promise.resolve();
    setHostsSnapshot([
      ...initialHosts,
      { id: "studio", label: "Studio", kind: "remote", endpoint: "studio-b", capabilities: ["terminal"] },
    ]);
    const creatingB = router.create({ bindingId: "remote-b", hostId: "studio" });
    await Promise.resolve();
    const closing = router.closeRemotes();
    let closeReturned = false;
    void closing.then(() => {
      closeReturned = true;
    });
    gates.get("studio-b")?.();
    await expect(creatingB).rejects.toThrow(/revoked/);
    await Promise.resolve();
    expect(closeReturned).toBe(false);
    gates.get("studio-a")?.();
    await expect(creatingA).rejects.toThrow(/revoked/);
    await expect(closing).resolves.toBeUndefined();
    expect(cleanup.sort()).toEqual(["studio-a", "studio-b"]);
    await expect(router.create({ bindingId: "later", hostId: "studio" })).rejects.toThrow(/stopping/);
  });

  it("shutdownAllLocal does not require remotes", async () => {
    const local = new LocalSessionHost(fakeAuthority());
    hosts.push(local);
    const router = new TerminalRouter(local);
    await router.create({ bindingId: "q1", hostId: "local" });
    await expect(router.shutdownAllLocal("test")).resolves.toEqual({
      clean: true,
      stragglers: [],
    });
    expect(router.runningCount()).toBe(0);
  });
});
