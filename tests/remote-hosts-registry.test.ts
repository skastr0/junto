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
import { ProductPlanesLive } from "../src/main/runtime";
import {
  HostsService,
  makeHostsService,
} from "../src/main/vellum/hosts/service";
import {
  makeHostsRegistry,
  resetDefaultHostsRegistryForTests,
  type HostsRegistry,
} from "../src/main/vellum/hosts/registry";
import {
  makeStateEngineLive,
} from "../src/main/vellum/state/engine";
import { StateEngine } from "../src/main/vellum/state/service";
import {
  findHostByHermesId,
  findHostById,
  hostsSnapshot,
  hostsWithCapability,
  setHostsSnapshot,
  subscribeHostsSnapshot,
} from "../src/main/vellum/hosts/snapshot";
import { SshTransport } from "../src/main/vellum/ssh/service";
import { acpVerboseLogging } from "../src/main/vellum/chat/acp-client";
import { StationFleetPropagation } from "../src/main/vellum/station/fleet-propagation";

const dirs: string[] = [];
const originalHome = process.env.HOME;
const unusedFleet = {} as Context.Service.Shape<
  typeof StationFleetPropagation
>;
const stateDisposers: Array<() => Promise<void>> = [];
const stateByPath = new Map<
  string,
  Context.Service.Shape<typeof StateEngine>
>();

const testRegistry = async (databasePath: string) => {
  let state = stateByPath.get(databasePath);
  if (!state) {
    const runtime = ManagedRuntime.make(makeStateEngineLive(databasePath));
    state = await runtime.runPromise(StateEngine);
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
  setHostsSnapshot(defaultRemoteHostsDocument().hosts);
  delete process.env.VELLUM_COMMAND_ACP_VERBOSE;
  delete process.env.VELLUM_COMMAND_DEBUG;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
});

describe("remote hosts registry", () => {
  it("constructs fresh SQLite state with only the local host", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-empty-"));
    dirs.push(root);
    const { registry } = await testRegistry(join(root, "vellum-command.db"));

    const hosts = await registry.list();
    expect(hosts.map((host) => host.id)).toEqual(["local"]);
    expect(hosts[0]?.capabilities).toEqual(
      expect.arrayContaining(["terminal", "browser", "hermes"]),
    );
  });

  it("persists enrollment transactions and keeps local capabilities synthesized", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-write-"));
    dirs.push(root);
    const { registry, state } = await testRegistry(join(root, "vellum-command.db"));

    const written = await registry.upsert({
      id: "studio",
      label: "Studio",
      kind: "remote",
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
      "local",
      "studio",
    ]);
    await expect(cold.remove("local")).rejects.toMatchObject({
      code: "conflict",
    });
    await cold.upsert({
      id: "local",
      label: "This machine",
      kind: "local",
      capabilities: ["terminal"],
    });
    const local = await cold.get("local");
    expect(local?.label).toBe("This machine");
    expect(local?.capabilities).toHaveLength(3);
    await expect(
      cold.upsert({
        id: "local",
        label: "Forged remote",
        kind: "remote",
        sshEndpoint: "forged",
        capabilities: ["hermes"],
      }),
    ).rejects.toMatchObject({ code: "validation" });

    await cold.upsert({
      id: "render",
      label: "Render",
      kind: "remote",
      sshEndpoint: "render",
      capabilities: ["terminal"],
    });
    await cold.remove("studio");
    await cold.upsert({
      id: "render",
      label: "Render updated",
      kind: "remote",
      sshEndpoint: "render",
      capabilities: ["terminal"],
    });
    await cold.upsert({
      id: "build",
      label: "Build",
      kind: "remote",
      sshEndpoint: "build",
      capabilities: ["terminal"],
    });
    expect((await cold.list()).map((host) => host.id)).toEqual([
      "local",
      "render",
      "build",
    ]);
  });

  it("survives an engine restart with SQLite as the only authority", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-restart-"));
    dirs.push(root);
    const databasePath = join(root, "vellum-command.db");

    const firstRuntime = ManagedRuntime.make(makeStateEngineLive(databasePath));
    try {
      const state = await firstRuntime.runPromise(StateEngine);
      await makeHostsRegistry(state, (e) => Effect.runPromise(e)).upsert({
        id: "studio",
        label: "Studio",
        kind: "remote",
        sshEndpoint: "studio",
        capabilities: ["hermes"],
      });
    } finally {
      await firstRuntime.dispose();
    }

    const secondRuntime = ManagedRuntime.make(makeStateEngineLive(databasePath));
    try {
      const state = await secondRuntime.runPromise(StateEngine);
      expect(
        (await makeHostsRegistry(state, (e) => Effect.runPromise(e)).list()).map((host) => host.id),
      ).toEqual(["local", "studio"]);
    } finally {
      await secondRuntime.dispose();
    }
  });

  it("rejects duplicate endpoint and effective Hermes identities before commit", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-unique-"));
    dirs.push(root);
    const { registry } = await testRegistry(join(root, "vellum-command.db"));
    await registry.upsert({
      id: "studio",
      label: "Studio",
      kind: "remote",
      sshEndpoint: "shared",
      capabilities: ["hermes"],
      hermesId: "compute",
    });

    await expect(
      registry.upsert({
        id: "render",
        label: "Render",
        kind: "remote",
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
        kind: "remote",
        sshEndpoint: "render",
        capabilities: ["hermes"],
        hermesId: "compute",
      }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("duplicate hermes id"),
    });
    expect((await registry.list()).map((host) => host.id)).toEqual([
      "local",
      "studio",
    ]);
  });

  it("rejects excess renderer host fields before registry mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-strict-upsert-"));
    dirs.push(root);
    const { registry } = await testRegistry(join(root, "vellum-command.db"));
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
      unusedFleet,
    );

    const result = await Effect.runPromise(
      Effect.result(
        service.upsert({
          id: "studio",
          label: "Studio",
          kind: "remote",
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
    expect((await registry.list()).map((host) => host.id)).toEqual(["local"]);
  });

  it("resolves optional hermesId aliases without product-specific defaults", () => {
    setHostsSnapshot([
      ...defaultRemoteHostsDocument().hosts,
      {
        id: "fleet-1",
        label: "Fleet One",
        kind: "remote",
        sshEndpoint: "fleet-1",
        capabilities: ["hermes"],
        hermesId: "f1",
      },
    ]);
    const host = findHostByHermesId("f1");
    expect(host?.id).toBe("fleet-1");
    expect(hermesKeyFor(host!)).toBe("f1");
    expect(hostsWithCapability("hermes").map((row) => row.id)).toEqual([
      "local",
      "fleet-1",
    ]);
  });

  it("hydrates persisted hosts before the first normal-boot route", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-boot-"));
    dirs.push(root);
    process.env.HOME = root;
    const databasePath = join(root, ".vellum-command", "state", "vellum-command.db");
    const setupRuntime = ManagedRuntime.make(makeStateEngineLive(databasePath));
    try {
      const state = await setupRuntime.runPromise(StateEngine);
      await makeHostsRegistry(state, (e) => Effect.runPromise(e)).upsert({
        id: "studio",
        label: "Studio",
        kind: "remote",
        sshEndpoint: "studio-ssh",
        capabilities: ["hermes"],
      });
    } finally {
      await setupRuntime.dispose();
    }
    resetDefaultHostsRegistryForTests();
    // Stale local-only snapshot — route must not appear until SQLite hydrates.
    setHostsSnapshot(defaultRemoteHostsDocument().hosts);
    expect(findHostById("studio") !== undefined).toBe(false);

    const reopen = ManagedRuntime.make(makeStateEngineLive(databasePath));
    try {
      const state = await reopen.runPromise(StateEngine);
      const registry = makeHostsRegistry(state, (e) => Effect.runPromise(e));
      const service = makeHostsService(
        registry,
        {} as Context.Service.Shape<typeof SshTransport>,
        unusedFleet,
      );
      const listed = await Effect.runPromise(service.list);
      const firstRoute = findHostById("studio") !== undefined;
      await Effect.runPromise(service.remove("studio"));
      await Effect.runPromise(
        service.upsert({
          id: "render",
          label: "Render",
          kind: "remote",
          sshEndpoint: "render-ssh",
          capabilities: ["terminal"],
        }),
      );
      const rejected = await Effect.runPromise(
        Effect.result(
          service.upsert({
            id: "duplicate",
            label: "Duplicate",
            kind: "remote",
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
        listedIds: ["local", "studio"],
        rejected: "Failure",
        reloadedIds: ["local", "render"],
        oldRoute: false,
        newRoute: true,
      });
    } finally {
      await reopen.dispose();
    }
  });

  it("publishes a committed mutation even when its caller is interrupted", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-interrupt-"));
    dirs.push(root);
    const { registry } = await testRegistry(join(root, "vellum-command.db"));
    await registry.list();
    setHostsSnapshot(defaultRemoteHostsDocument().hosts);

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
      unusedFleet,
    );
    const fiber = Effect.runFork(
      service.upsert({
        id: "studio",
        label: "Studio",
        kind: "remote",
        sshEndpoint: "studio",
        capabilities: ["terminal"],
      }),
    );
    await started;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    release();
    await interrupted;

    expect((await registry.list()).map((host) => host.id)).toEqual([
      "local",
      "studio",
    ]);
    expect(hostsSnapshot().map((host) => host.id)).toEqual([
      "local",
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
          ...defaultRemoteHostsDocument().hosts,
          {
            id: "studio",
            label: "Studio",
            kind: "remote",
            sshEndpoint: "studio-ssh",
            capabilities: ["terminal"],
          },
        ])
      ).not.toThrow();
      expect(reconciliations).toBe(1);
      expect(warning).toHaveBeenCalledWith(
        "[vellum-command:hosts] routing snapshot listener failed",
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
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-endpoint-"));
    dirs.push(root);
    const { registry } = await testRegistry(join(root, "vellum-command.db"));

    await expect(
      registry.upsert({
        id: "wrong-port",
        label: "Wrong port",
        kind: "remote",
        sshEndpoint: "example.com:2222",
        capabilities: ["terminal"],
      }),
    ).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("custom ports in ~/.ssh/config"),
    });
    await expect(
      registry.upsert({
        id: "empty-user",
        label: "Empty user",
        kind: "remote",
        sshEndpoint: "@example.com",
        capabilities: ["terminal"],
      }),
    ).rejects.toMatchObject({ code: "validation" });
    await expect(
      registry.upsert({
        id: "bracketed-ipv6",
        label: "Bracketed IPv6",
        kind: "remote",
        sshEndpoint: "ops@[2001:db8::10]",
        capabilities: ["hermes"],
      }),
    ).rejects.toMatchObject({ code: "validation" });

    const ipv6 = await registry.upsert({
      id: "ipv6",
      label: "IPv6",
      kind: "remote",
      sshEndpoint: "ops@2001:db8::10",
      capabilities: ["hermes"],
    });
    expect(ipv6.find((host) => host.id === "ipv6")?.sshEndpoint).toBe(
      "ops@2001:db8::10",
    );
    const scopedIpv6 = await registry.upsert({
      id: "scoped-ipv6",
      label: "Scoped IPv6",
      kind: "remote",
      sshEndpoint: "ops@fe80::1%lo0",
      capabilities: ["terminal"],
    });
    expect(
      scopedIpv6.find((host) => host.id === "scoped-ipv6")?.sshEndpoint,
    ).toBe("ops@fe80::1%lo0");
  });

  it("rejects duplicate capabilities instead of persisting ambiguous claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-capabilities-"));
    dirs.push(root);
    const { registry } = await testRegistry(join(root, "vellum-command.db"));

    await expect(
      registry.upsert({
        id: "studio",
        label: "Studio",
        kind: "remote",
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

  it("enables via VELLUM_COMMAND_ACP_VERBOSE", () => {
    process.env.VELLUM_COMMAND_ACP_VERBOSE = "1";
    expect(acpVerboseLogging()).toBe(true);
  });
});
