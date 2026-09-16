import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Scope } from "effect";
import { hostsSnapshot, setHostsSnapshot } from "../src/main/junto/hosts/snapshot";
import { LocalSessionHost } from "../src/main/junto/term/local-host";
import { TerminalRouter } from "../src/main/junto/term/router";
import { makeFakeTerminalProcessAuthority } from "./helpers/fake-terminal-process-authority";

const initialHosts = hostsSnapshot();
const routers: TerminalRouter[] = [];
const localHosts: LocalSessionHost[] = [];

const remoteHost = (sshEndpoint = "studio.example") => ({
  id: "studio",
  label: "Studio",
  kind: "remote" as const,
  sshEndpoint,
  capabilities: ["terminal" as const],
});

const makeRouter = (
  runtime: ConstructorParameters<typeof TerminalRouter>[1] = {},
): TerminalRouter => {
  const local = new LocalSessionHost(
    makeFakeTerminalProcessAuthority(() => ({
      pid: undefined,
      exitOnSignal: false,
    })).authority,
    { killGraceMs: 5, shutdownGraceMs: 5, lateExitGraceMs: 5 },
  );
  const router = new TerminalRouter(local, runtime);
  localHosts.push(local);
  routers.push(router);
  setHostsSnapshot([...initialHosts, remoteHost()]);
  return router;
};

const cleanCloseReceipt = Object.freeze({
  clean: true as const,
  closeObserved: true as const,
  pendingRequests: 0,
  diagnostics: Object.freeze([]),
});

type RemoteClientDouble = {
  isLive: () => boolean;
  acquireMaintenance: ReturnType<typeof vi.fn>;
  beginShutdown: ReturnType<typeof vi.fn>;
  drainOnQuit: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  bindCanvas: ReturnType<typeof vi.fn>;
  attach: ReturnType<typeof vi.fn>;
};

const remoteClient = (
  acquisition: unknown = {
    acquired: true,
    evidence: {
      activeTerminalSessions: 0,
      observationId: "tm_0123456789abcdef",
    },
  },
): RemoteClientDouble => ({
  isLive: () => true,
  acquireMaintenance: vi.fn(async () => acquisition),
  beginShutdown: vi.fn(),
  drainOnQuit: vi.fn(async () => cleanCloseReceipt),
  close: vi.fn(),
  create: vi.fn(async ({ bindingId }: { bindingId: string }) => ({
    bindingId,
    hostId: "local",
    epoch: "remote-epoch",
    status: "running",
  })),
  list: vi.fn(async () => []),
  get: vi.fn(async () => undefined),
  kill: vi.fn(async () => false),
  bindCanvas: vi.fn(async () => undefined),
  attach: vi.fn(async () => ({ ok: false, message: "unused" })),
});

const installRemoteEntry = (
  router: TerminalRouter,
  client: RemoteClientDouble,
  endpoint = "studio.example",
): void => {
  (
    router as unknown as {
      remotes: Map<string, unknown>;
    }
  ).remotes.set("studio", {
    client,
    forward: {},
    endpoint,
    generation: 1,
    scope: {},
    rootScope: Effect.runSync(Scope.make()),
    leaseMap: new Map(),
    reverseLease: new Map(),
  });
};

const replaceConnectRemote = (
  router: TerminalRouter,
  implementation: (...args: unknown[]) => Promise<never>,
): ReturnType<typeof vi.fn> => {
  const connect = vi.fn(implementation);
  (
    router as unknown as {
      connectRemote: typeof connect;
    }
  ).connectRemote = connect;
  return connect;
};

afterEach(async () => {
  for (const router of routers.splice(0)) router.beginShutdown();
  for (const host of localHosts.splice(0)) await host.shutdownAll("test");
  setHostsSnapshot(initialHosts);
  vi.restoreAllMocks();
});

describe("TerminalRouter listAll occupancy", () => {
  it("includes occupied remotes from every terminal host", async () => {
    const router = makeRouter();
    const client = remoteClient();
    client.list.mockResolvedValue([
      {
        bindingId: "seat-1",
        hostId: "local",
        epoch: "remote-epoch",
        status: "running",
      },
    ]);
    installRemoteEntry(router, client);

    const listed = await router.listAll();
    expect(
      listed.some((session) => session.bindingId === "seat-1" && session.hostId === "studio"),
    ).toBe(true);
  });

  it("does not treat a remote list error as vacant occupancy", async () => {
    const router = makeRouter();
    const client = remoteClient();
    client.list.mockRejectedValue(new Error("term control connect timeout"));
    installRemoteEntry(router, client);

    await expect(router.listAll()).rejects.toThrow(
      /Junto is not answering on studio/,
    );
  });
});

describe("TerminalRouter host maintenance", () => {
  it("turns exact remote zero-work evidence into a durable no-redial host cut", async () => {
    const router = makeRouter();
    const client = remoteClient();
    installRemoteEntry(router, client);
    const connect = replaceConnectRemote(router, async () => {
      throw new Error("dial invoked");
    });

    const acquired = await router.acquireRemoteHostMaintenance("studio");

    expect(acquired).toMatchObject({
      acquired: true,
      evidence: {
        activeTerminalSessions: 0,
        observationId: "tm_0123456789abcdef",
      },
    });
    if (!acquired.acquired) return;
    expect(client.acquireMaintenance).toHaveBeenCalledOnce();
    expect(client.beginShutdown).toHaveBeenCalledOnce();
    expect(client.drainOnQuit).toHaveBeenCalledOnce();
    expect(Object.isFrozen(acquired.lease)).toBe(true);

    await expect(
      router.create({ bindingId: "during-deploy", hostId: "studio" }),
    ).rejects.toThrow(/admission closed for maintenance/);
    await expect(
      router.bindCanvas("during-deploy", null, "studio"),
    ).rejects.toThrow(/admission closed for maintenance/);
    expect(
      await router.attach({
        bindingId: "during-deploy",
        mode: "control",
        hostId: "studio",
      }),
    ).toEqual({
      ok: false,
      message: "terminal route admission closed for maintenance",
    });
    expect(await router.list("studio")).toEqual([]);
    expect(await router.get("during-deploy", "studio")).toBeUndefined();
    expect(await router.kill("during-deploy", "studio")).toBe(false);
    expect(connect).not.toHaveBeenCalled();

    expect(acquired.lease.release()).toBe(true);
    expect(acquired.lease.release()).toBe(false);
    await expect(
      router.create({ bindingId: "after-deploy", hostId: "studio" }),
    ).rejects.toThrow(/dial invoked/);
    expect(connect).toHaveBeenCalledOnce();
  });

  it("never mints the router cut when the target reports active work", async () => {
    const router = makeRouter();
    const client = remoteClient({
      acquired: false,
      reason: "active_sessions",
      evidence: {
        activeTerminalSessions: 2,
        observationId: "tm_1111111111111111",
      },
    });
    installRemoteEntry(router, client);

    await expect(router.acquireRemoteHostMaintenance("studio")).resolves.toEqual({
      acquired: false,
      reason: "active_sessions",
      evidence: {
        activeTerminalSessions: 2,
        observationId: "tm_1111111111111111",
      },
    });
    expect(client.beginShutdown).not.toHaveBeenCalled();
    await expect(
      router.create({ bindingId: "work-continues", hostId: "studio" }),
    ).resolves.toMatchObject({
      bindingId: "work-continues",
      hostId: "studio",
    });
  });

  it("closes the create-after-observe race before asking the target for proof", async () => {
    const router = makeRouter();
    const client = remoteClient();
    installRemoteEntry(router, client);

    const racingCreate = router.create({
      bindingId: "racing-create",
      hostId: "studio",
    });
    const acquired = router.acquireRemoteHostMaintenance("studio");

    await expect(racingCreate).rejects.toThrow(
      /admission closed for maintenance/,
    );
    await expect(acquired).resolves.toMatchObject({ acquired: true });
    expect(client.create).not.toHaveBeenCalled();
  });

  it("keeps a held host cut across Remote restart and registry endpoint change", async () => {
    const router = makeRouter();
    const client = remoteClient();
    installRemoteEntry(router, client);
    const acquired = await router.acquireRemoteHostMaintenance("studio");
    if (!acquired.acquired) return;
    setHostsSnapshot([...initialHosts, remoteHost("replacement.example")]);
    const connect = replaceConnectRemote(router, async () => {
      throw new Error("replacement dial");
    });

    await expect(
      router.create({ bindingId: "after-restart", hostId: "studio" }),
    ).rejects.toThrow(/admission closed for maintenance/);
    expect(connect).not.toHaveBeenCalled();

    expect(acquired.lease.release()).toBe(true);
    await expect(
      router.create({ bindingId: "after-release", hostId: "studio" }),
    ).rejects.toThrow(/replacement dial/);
    expect(connect.mock.calls[0]?.[1]).toBe("replacement.example");
  });

  it("fails closed within a bound when an acquired target route cannot retire", async () => {
    const router = makeRouter({ maintenanceDeadlineMs: 20 });
    const client = remoteClient();
    client.drainOnQuit.mockImplementation(
      () => new Promise(() => undefined),
    );
    installRemoteEntry(router, client);
    const connect = replaceConnectRemote(router, async () => {
      throw new Error("poisoned host must not redial");
    });

    await expect(
      router.acquireRemoteHostMaintenance("studio"),
    ).rejects.toThrow(/route retirement timed out/);
    await expect(
      router.create({ bindingId: "after-timeout", hostId: "studio" }),
    ).rejects.toThrow(/admission closed for maintenance/);
    expect(connect).not.toHaveBeenCalled();
  });

  it("invalidates an opaque lease at router shutdown without signaling sessions", async () => {
    const fakeProcesses = makeFakeTerminalProcessAuthority(() => ({
      pid: undefined,
      exitOnSignal: false,
    }));
    const local = new LocalSessionHost(fakeProcesses.authority, {
      killGraceMs: 5,
      shutdownGraceMs: 5,
      lateExitGraceMs: 5,
    });
    const router = new TerminalRouter(local);
    localHosts.push(local);
    routers.push(router);
    setHostsSnapshot([...initialHosts, remoteHost()]);
    const client = remoteClient();
    installRemoteEntry(router, client);
    const acquired = await router.acquireRemoteHostMaintenance("studio");
    if (!acquired.acquired) return;

    router.beginShutdown();

    expect(acquired.lease.release()).toBe(false);
    await expect(
      router.create({ bindingId: "after-shutdown", hostId: "studio" }),
    ).rejects.toThrow(/router is stopping/);
    expect(fakeProcesses.controllers).toEqual([]);
    expect(client.kill).not.toHaveBeenCalled();
  });
});
