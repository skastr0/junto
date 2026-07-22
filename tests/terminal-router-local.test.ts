import { afterEach, describe, expect, it } from "vitest";
import {
  LocalSessionHost,
  type TermChild,
  type TermSpawnFn,
} from "../src/main/vellum/term/local-host";
import { TerminalRouter } from "../src/main/vellum/term/router";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/vellum/process-identity";

const hosts: LocalSessionHost[] = [];

afterEach(async () => {
  for (const h of hosts.splice(0)) {
    await h.shutdownAll("test");
  }
  setProcessIdentityMapForTests(undefined);
});

const fakeSpawn = (pid = 55_010): TermSpawnFn => () => {
  const dataListeners = new Set<(d: string) => void>();
  const exitListeners = new Set<(c: number | undefined, s: number | undefined) => void>();
  let alive = true;
  const child: TermChild = {
    pid,
    write() {
      /* noop */
    },
    resize() {
      /* noop */
    },
    kill() {
      if (!alive) return;
      alive = false;
      for (const l of exitListeners) l(0, undefined);
    },
    onData(l) {
      dataListeners.add(l);
    },
    onExit(l) {
      exitListeners.add(l);
    },
  };
  return child;
};

describe("TerminalRouter local path", () => {
  it("create/get/list/attach/write/kill stay on LocalSessionHost for local hostId", async () => {
    setProcessIdentityMapForTests(makeProcessIdentityMap());
    const local = new LocalSessionHost(fakeSpawn());
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

  it("isLocalHostId treats missing registry host as local-safe", () => {
    const local = new LocalSessionHost(fakeSpawn());
    hosts.push(local);
    const router = new TerminalRouter(local);
    expect(router.isLocalHostId("local")).toBe(true);
    expect(router.isLocalHostId(undefined)).toBe(true);
    expect(router.isLocalHostId("")).toBe(true);
  });

  it("shutdownAllLocal does not require remotes", async () => {
    const local = new LocalSessionHost(fakeSpawn());
    hosts.push(local);
    const router = new TerminalRouter(local);
    await router.create({ bindingId: "q1", hostId: "local" });
    await router.shutdownAllLocal("test");
    expect(router.runningCount()).toBe(0);
  });
});
