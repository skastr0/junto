import {
  mkdtemp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Context,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
} from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultRemoteHostsDocument,
  hermesKeyFor,
} from "../src/shared/remote-hosts";
import {
  HostsService,
  HostsPersistenceLive,
  makeHostsService,
} from "../src/main/junto/hosts/service";
import {
  HostsPersistence,
  makeHostsRegistry,
  resetDefaultHostsRegistryForTests,
  type HostsRegistry,
} from "../src/main/junto/hosts/registry";
import {
  findHostByHermesId,
  findHostById,
  hostsSnapshot,
  hostsWithCapability,
  setHostsSnapshot,
  subscribeHostsSnapshot,
} from "../src/main/junto/hosts/snapshot";
import { SshTransport } from "../src/main/junto/ssh/service";
import { DatabaseSync } from "node:sqlite";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { MACHINE_REGISTRY_STATE_SCHEMA_SQL } from "../src/main/junto/hosts/state-schema";
import { makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { MACHINE_STATE_SCHEMA_SQL } from "../src/main/junto/machines/state-schema";
import { acpVerboseLogging } from "../src/main/junto/chat/acp-client";

const dirs: string[] = [];
const originalHome = process.env.HOME;
const stateDisposers: Array<() => Promise<void>> = [];
const stateByPath = new Map<
  string,
  Context.Service.Shape<typeof HostsPersistence>
>();

const registryRuntime = (databasePath: string) => {
  const database = new DatabaseSync(databasePath);
  if (!database.prepare("SELECT name FROM sqlite_master WHERE name='host_registry'").get()) {
    database.exec(MACHINE_STATE_SCHEMA_SQL + MACHINE_REGISTRY_STATE_SCHEMA_SQL);
    database.exec("CREATE TABLE host_registry_state(singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL, initialized_at TEXT NOT NULL) STRICT");
  }
  const sql = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  const machines = makeMachineRepositoryLive({defaultName: () => "macbook"}).pipe(Layer.provideMerge(sql));
  const runtime = ManagedRuntime.make(HostsPersistenceLive.pipe(Layer.provideMerge(machines)));
  return { runPromise: runtime.runPromise.bind(runtime), dispose: async () => { await runtime.dispose(); database.close(); } };
};

const testRegistry = async (databasePath: string) => {
  let state = stateByPath.get(databasePath);
  if (!state) {
    const runtime = registryRuntime(databasePath);
    state = await runtime.runPromise(HostsPersistence);
    stateByPath.set(databasePath, state);
    stateDisposers.push(() => runtime.dispose());
  }
  return {
    registry: makeHostsRegistry(state, (e) => Effect.runPromise(e)),
    state,
  };
};

afterEach(async () => {
  await Promise.all(stateDisposers.splice(0).map((dispose) => dispose()));
  stateByPath.clear();
  await Promise.all(
    dirs.splice(0).map((path) =>
      rm(path, { recursive: true, force: true })
    ),
  );
  resetDefaultHostsRegistryForTests();
  setHostsSnapshot(defaultRemoteHostsDocument("macbook").hosts);
  delete process.env.JUNTO_ACP_VERBOSE;
  delete process.env.JUNTO_DEBUG;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("remote hosts registry", () => {
  it("constructs fresh SQLite state with only the local host", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-hosts-empty-"));
    dirs.push(root);
    const { registry } = await testRegistry(join(root, "junto.db"));

    const hosts = await registry.list();
    expect(hosts.map((host) => host.id)).toEqual(["macbook"]);
    expect(hosts[0]?.capabilities).toEqual(
      expect.arrayContaining(["terminal", "browser", "hermes"]),
    );
  });

  it("persists enrollment transactions and keeps local capabilities synthesized", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-hosts-write-"));
    dirs.push(root);
    const { registry, state } = await testRegistry(join(root, "junto.db"));

    const written = await registry.upsert({
      id: "studio",
      label: "Studio",
      isThisMachine: false,
      sshEndpoint: "studio",
      sshIdentityFile: "/Users/operator/.ssh/studio_ed25519",
      sshHostKeyPolicy: "accept-new",
      capabilities: ["hermes"],
      appearance: { color: "amber", glyph: "S" },
    });
    expect(written.find((host) => host.id === "studio")).toMatchObject({
      capabilities: ["hermes"],
      sshIdentityFile: "/Users/operator/.ssh/studio_ed25519",
      sshHostKeyPolicy: "accept-new",
      appearance: { color: "amber", glyph: "S" },
    });

    const cold = makeHostsRegistry(state, (e) => Effect.runPromise(e));
    expect((await cold.list()).map((host) => host.id)).toEqual([
      "macbook",
      "studio",
    ]);
    await expect(cold.remove("macbook")).rejects.toMatchObject({
      code: "conflict",
    });
    await cold.upsert({
      id: "macbook",
      label: "This machine",
      isThisMachine: true,
      capabilities: ["terminal"],
    });
    const local = await cold.get("macbook");
    expect(local?.label).toBe("This machine");
    expect(local?.capabilities).toHaveLength(3);
    await expect(
      cold.upsert({
        id: "macbook",
        label: "Forged remote",
        isThisMachine: false,
        sshEndpoint: "forged",
        capabilities: ["hermes"],
      }),
    ).rejects.toMatchObject({ code: "validation" });

    await cold.upsert({
      id: "render",
      label: "Render",
      isThisMachine: false,
      sshEndpoint: "render",
      capabilities: ["terminal"],
    });
    await cold.remove("studio");
    await cold.upsert({
      id: "render",
      label: "Render updated",
      isThisMachine: false,
      sshEndpoint: "render",
      capabilities: ["terminal"],
    });
    await cold.upsert({
      id: "build",
      label: "Build",
      isThisMachine: false,
      sshEndpoint: "build",
      capabilities: ["terminal"],
    });
    expect((await cold.list()).map((host) => host.id)).toEqual([
      "macbook",
      "render",
      "build",
    ]);
  });

  it("survives an engine restart with SQLite as the only authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-hosts-restart-"));
    dirs.push(root);
    const databasePath = join(root, "junto.db");

    const firstRuntime = registryRuntime(databasePath);
    try {
      const state = await firstRuntime.runPromise(HostsPersistence);
      await makeHostsRegistry(state, (e) => Effect.runPromise(e)).upsert({
        id: "studio",
        label: "Studio",
        isThisMachine: false,
        sshEndpoint: "studio",
        capabilities: ["hermes"],
      });
    } finally {
      await firstRuntime.dispose();
    }

    const secondRuntime = registryRuntime(databasePath);
    try {
      const state = await secondRuntime.runPromise(HostsPersistence);
      expect(
        (await makeHostsRegistry(state, (e) => Effect.runPromise(e)).list()).map((host) => host.id),
      ).toEqual(["macbook", "studio"]);
    } finally {
      await secondRuntime.dispose();
    }
  });

  it("rejects duplicate endpoint and effective Hermes identities before commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-hosts-unique-"));
    dirs.push(root);
    const { registry } = await testRegistry(join(root, "junto.db"));
    await registry.upsert({
      id: "studio",
      label: "Studio",
      isThisMachine: false,
      sshEndpoint: "shared",
      capabilities: ["hermes"],
      hermesId: "compute",
    });

    await expect(
      registry.upsert({
        id: "render",
        label: "Render",
        isThisMachine: false,
        sshEndpoint: "shared",
        capabilities: ["terminal"],
      }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("duplicate remote sshEndpoint"),
    });
    await expect(
      registry.upsert({
        id: "render",
        label: "Render",
        isThisMachine: false,
        sshEndpoint: "render",
        capabilities: ["hermes"],
        hermesId: "compute",
      }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("duplicate hermes id"),
    });
    expect((await registry.list()).map((host) => host.id)).toEqual([
      "macbook",
      "studio",
    ]);
  });

  it("persists strict route selections and distinguishes ports on the same gateway", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-hosts-pinned-")); dirs.push(root);
    const { registry, state } = await testRegistry(join(root, "junto.db"));
    const route = { id: "sandbox-one", label: "Sandbox", isThisMachine: false,
      sshEndpoint: "user@gateway", sshPort: 19049,
      sshKnownHostsFile: "/Users/operator/.ssh/pinned/one", sshHostKeyAlias: "sandbox-one",
      sshIdentityFile: "/Users/operator/.ssh/key", sshHostKeyPolicy: "system" as const,
      juntoHome: "/home/user/probe", installRoot: "/home/user/probe/install", capabilities: ["terminal" as const] };
    await registry.upsert(route);
    const cold = makeHostsRegistry(state, e => Effect.runPromise(e));
    expect(await cold.get(route.id)).toEqual(route);
    await cold.upsert({ ...route, id: "sandbox-two", sshPort: 19050 });
    await expect(cold.upsert({ ...route, id: "duplicate" })).rejects.toMatchObject({ code: "validation" });
    await expect(cold.upsert({ ...route, sshHostKeyPolicy: "accept-new" })).rejects.toMatchObject({ code: "validation" });
    expect((await cold.list()).map(host => host.id)).toEqual(["macbook", "sandbox-one", "sandbox-two"]);
  });

  it("rejects excess renderer host fields before registry mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-hosts-strict-upsert-"));
    dirs.push(root);
    const { registry } = await testRegistry(join(root, "junto.db"));
    let mutationCount = 0;
    const observingRegistry: HostsRegistry = {
      ...registry,
      upsert: async (host) => {
        mutationCount += 1;
        return registry.upsert(host);
      },
    };
    const service = makeHostsService(
      observingRegistry,
      {} as Context.Service.Shape<typeof SshTransport>,
    );

    const result = await Effect.runPromise(
      Effect.result(
        service.upsert({
          id: "studio",
          label: "Studio",
          isThisMachine: false,
          sshEndpoint: "studio",
          capabilities: ["hermes"],
          legacyToken: "retired-host-credential",
        }),
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure.code).toBe("validation");
      expect(result.failure.message).toContain("legacyToken");
    }
    expect(mutationCount).toBe(0);
    expect((await registry.list()).map((host) => host.id)).toEqual(["macbook"]);
  });

  it("resolves optional hermesId aliases without product-specific defaults", () => {
    setHostsSnapshot([
      ...defaultRemoteHostsDocument("macbook").hosts,
      {
        id: "fleet-1",
        label: "Fleet One",
        isThisMachine: false,
        sshEndpoint: "fleet-1",
        capabilities: ["hermes"],
        hermesId: "f1",
      },
    ]);
    const host = findHostByHermesId("f1");
    expect(host?.id).toBe("fleet-1");
    expect(hermesKeyFor(host!)).toBe("f1");
    expect(hostsWithCapability("hermes").map((row) => row.id)).toEqual([
      "macbook",
      "fleet-1",
    ]);
  });

  it("hydrates persisted hosts before the first normal-boot route", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-hosts-boot-"));
    dirs.push(root);
    process.env.HOME = root;
    const databasePath = join(root, "junto.db");
    const setupRuntime = registryRuntime(databasePath);
    try {
      const state = await setupRuntime.runPromise(HostsPersistence);
      await makeHostsRegistry(state, (e) => Effect.runPromise(e)).upsert({
        id: "studio",
        label: "Studio",
        isThisMachine: false,
        sshEndpoint: "studio-ssh",
        capabilities: ["hermes"],
      });
    } finally {
      await setupRuntime.dispose();
    }
    resetDefaultHostsRegistryForTests();
    // Stale local-only snapshot — route must not appear until SQLite hydrates.
    setHostsSnapshot(defaultRemoteHostsDocument("macbook").hosts);
    expect(findHostById("studio") !== undefined).toBe(false);

    const reopen = registryRuntime(databasePath);
    try {
      const state = await reopen.runPromise(HostsPersistence);
      const registry = makeHostsRegistry(state, (e) => Effect.runPromise(e));
      const service = makeHostsService(
        registry,
        {} as Context.Service.Shape<typeof SshTransport>,
      );
      const listed = await Effect.runPromise(service.list);
      const firstRoute = findHostById("studio") !== undefined;
      await Effect.runPromise(service.remove("studio"));
      await Effect.runPromise(
        service.upsert({
          id: "render",
          label: "Render",
          isThisMachine: false,
          sshEndpoint: "render-ssh",
          capabilities: ["terminal"],
        }),
      );
      const rejected = await Effect.runPromise(
        Effect.result(
          service.upsert({
            id: "duplicate",
            label: "Duplicate",
            isThisMachine: false,
            sshEndpoint: "render-ssh",
            capabilities: ["terminal"],
          }),
        ),
      );
      const reloaded = await Effect.runPromise(service.list);
      expect({
        firstRoute,
        listedIds: listed.map((host) => host.id).sort(),
        rejected: rejected._tag,
        reloadedIds: reloaded.map((host) => host.id).sort(),
        oldRoute: findHostById("studio") !== undefined,
        newRoute: findHostById("render") !== undefined,
      }).toEqual({
        firstRoute: true,
        listedIds: ["macbook", "studio"],
        rejected: "Failure",
        reloadedIds: ["macbook", "render"],
        oldRoute: false,
        newRoute: true,
      });
    } finally {
      await reopen.dispose();
    }
  });

  it("publishes a committed mutation even when its caller is interrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-hosts-interrupt-"));
    dirs.push(root);
    const { registry } = await testRegistry(join(root, "junto.db"));
    await registry.list();
    setHostsSnapshot(defaultRemoteHostsDocument("macbook").hosts);

    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const delayedRegistry: HostsRegistry = {
      ...registry,
      upsert: async (host) => {
        entered();
        await blocked;
        return registry.upsert(host);
      },
    };
    const service = makeHostsService(
      delayedRegistry,
      {} as Context.Service.Shape<typeof SshTransport>,
    );
    const fiber = Effect.runFork(
      service.upsert({
        id: "studio",
        label: "Studio",
        isThisMachine: false,
        sshEndpoint: "studio",
        capabilities: ["terminal"],
      }),
    );
    await started;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    release();
    await interrupted;

    expect((await registry.list()).map((host) => host.id)).toEqual([
      "macbook",
      "studio",
    ]);
    expect(hostsSnapshot().map((host) => host.id)).toEqual([
      "macbook",
      "studio",
    ]);
  });

  it("isolates snapshot listener failures without exposing endpoint data", () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let reconciliations = 0;
    const unsubscribeBroken = subscribeHostsSnapshot(() => {
      throw new Error("secret-user@private-endpoint");
    });
    const unsubscribeHealthy = subscribeHostsSnapshot(() => {
      reconciliations += 1;
    });

    try {
      expect(() =>
        setHostsSnapshot([
          ...defaultRemoteHostsDocument("macbook").hosts,
          {
            id: "studio",
            label: "Studio",
            isThisMachine: false,
            sshEndpoint: "studio-ssh",
            capabilities: ["terminal"],
          },
        ])
      ).not.toThrow();
      expect(reconciliations).toBe(1);
      expect(warning).toHaveBeenCalledWith(
        "[junto:hosts] routing snapshot listener failed",
      );
      expect(JSON.stringify(warning.mock.calls)).not.toContain(
        "private-endpoint",
      );
    } finally {
      unsubscribeBroken();
      unsubscribeHealthy();
      warning.mockRestore();
    }
  });


  it("rejects malformed endpoints while preserving direct IPv6 destinations", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-hosts-endpoint-"));
    dirs.push(root);
    const { registry } = await testRegistry(join(root, "junto.db"));

    await expect(
      registry.upsert({
        id: "wrong-port",
        label: "Wrong port",
        isThisMachine: false,
        sshEndpoint: "example.com:2222",
        capabilities: ["terminal"],
      }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("a separate SSH port"),
    });
    await expect(
      registry.upsert({
        id: "empty-user",
        label: "Empty user",
        isThisMachine: false,
        sshEndpoint: "@example.com",
        capabilities: ["terminal"],
      }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      registry.upsert({
        id: "bracketed-ipv6",
        label: "Bracketed IPv6",
        isThisMachine: false,
        sshEndpoint: "ops@[2001:db8::10]",
        capabilities: ["hermes"],
      }),
    ).rejects.toMatchObject({ code: "validation" });

    const ipv6 = await registry.upsert({
      id: "ipv6",
      label: "IPv6",
      isThisMachine: false,
      sshEndpoint: "ops@2001:db8::10",
      capabilities: ["hermes"],
    });
    expect(ipv6.find((host) => host.id === "ipv6")?.sshEndpoint).toBe(
      "ops@2001:db8::10",
    );
    const scopedIpv6 = await registry.upsert({
      id: "scoped-ipv6",
      label: "Scoped IPv6",
      isThisMachine: false,
      sshEndpoint: "ops@fe80::1%lo0",
      capabilities: ["terminal"],
    });
    expect(
      scopedIpv6.find((host) => host.id === "scoped-ipv6")?.sshEndpoint,
    ).toBe("ops@fe80::1%lo0");
  });

  it("rejects duplicate capabilities instead of persisting ambiguous claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "junto-hosts-capabilities-"));
    dirs.push(root);
    const { registry } = await testRegistry(join(root, "junto.db"));

    await expect(
      registry.upsert({
        id: "studio",
        label: "Studio",
        isThisMachine: false,
        sshEndpoint: "studio",
        capabilities: ["browser", "browser"],
      }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("duplicate capability"),
    });
  });
});

describe("acp verbose logging gate", () => {
  it("defaults off", () => {
    expect(acpVerboseLogging()).toBe(false);
  });

  it("enables via JUNTO_ACP_VERBOSE", () => {
    process.env.JUNTO_ACP_VERBOSE = "1";
    expect(acpVerboseLogging()).toBe(true);
  });
});
