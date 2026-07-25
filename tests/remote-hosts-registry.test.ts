import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRemoteHostsDocument, hermesKeyFor } from "../src/shared/remote-hosts";
import { ProductPlanesLive } from "../src/main/runtime";
import { HostsService } from "../src/main/vellum/hosts/service";
import {
  hostsPathsForDocument,
  writeHostsSeal,
} from "../src/main/vellum/hosts/hosts-seal";
import {
  makeHostsRegistry,
  resetDefaultHostsRegistryForTests,
} from "../src/main/vellum/hosts/registry";
import {
  findHostByHermesId,
  hostsWithCapability,
  setHostsSnapshot,
  subscribeHostsSnapshot,
} from "../src/main/vellum/hosts/snapshot";
import { isKnownHerdrHost, listHerdrHosts } from "../src/main/vellum/herdr/hosts";
import { HerdrPlane } from "../src/main/vellum/herdr/plane";
import { HerdrMirrorRegistry } from "../src/main/vellum/herdr/mirrors";
import type { MirrorTransport } from "../src/main/vellum/herdr/mirror-transport";
import { acpVerboseLogging } from "../src/main/vellum/chat/acp-client";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  resetDefaultHostsRegistryForTests();
  setHostsSnapshot(defaultRemoteHostsDocument().hosts);
  delete process.env.VELLUM_ACP_VERBOSE;
  delete process.env.VELLUM_DEBUG;
  delete process.env.VELLUM_HOSTS_PATH;
});

describe("remote hosts registry", () => {
  it("seeds only local when the file is missing (no product remote hardcoding)", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-"));
    dirs.push(root);
    const path = join(root, "hosts.json");
    const registry = makeHostsRegistry(path);
    const hosts = await registry.list();
    expect(hosts.map((host) => host.id)).toEqual(["local"]);
    expect(hosts[0]?.capabilities).toContain("browser");
    expect(hosts.every((host) => host.kind === "local" || host.endpoint)).toBe(true);
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw).version).toBe(1);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    // First create seals enrollment so later offline mint fails closed.
    const sealPaths = hostsPathsForDocument(path);
    await stat(sealPaths.key);
    await stat(sealPaths.seal);
  });

  it("app write seals and reloads sealed membership", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-seal-write-"));
    dirs.push(root);
    const path = join(root, "hosts.json");
    const registry = makeHostsRegistry(path);
    await registry.list();
    await registry.upsert({
      id: "studio",
      label: "Studio",
      kind: "remote",
      endpoint: "studio",
      capabilities: ["hermes"],
    });
    const sealPaths = hostsPathsForDocument(path);
    await stat(sealPaths.key);
    await stat(sealPaths.seal);

    const cold = makeHostsRegistry(path);
    const hosts = await cold.list();
    expect(hosts.map((host) => host.id).sort()).toEqual(["local", "studio"]);
  });

  it("tampered hosts.json fails closed to local-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-seal-tamper-"));
    dirs.push(root);
    const path = join(root, "hosts.json");
    const registry = makeHostsRegistry(path);
    await registry.list();
    await registry.upsert({
      id: "studio",
      label: "Studio",
      kind: "remote",
      endpoint: "studio",
      capabilities: ["hermes", "herdr"],
    });

    // Offline mint: rewrite membership without resealing.
    const tampered = {
      version: 1,
      hosts: [
        ...defaultRemoteHostsDocument().hosts,
        {
          id: "evil",
          label: "Evil",
          kind: "remote",
          endpoint: "evil-ssh",
          capabilities: ["hermes"],
        },
      ],
    };
    await writeFile(path, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

    const cold = makeHostsRegistry(path);
    const hosts = await cold.list();
    expect(hosts.map((host) => host.id)).toEqual(["local"]);
    expect(hosts.some((host) => host.id === "evil")).toBe(false);

    // Disk rewritten fail-closed.
    const after = JSON.parse(await readFile(path, "utf8")) as {
      hosts: Array<{ id: string }>;
    };
    expect(after.hosts.map((host) => host.id)).toEqual(["local"]);
  });

  it("tampered seal mac fails closed", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-seal-mac-"));
    dirs.push(root);
    const path = join(root, "hosts.json");
    const registry = makeHostsRegistry(path);
    await registry.list();
    await registry.upsert({
      id: "studio",
      label: "Studio",
      kind: "remote",
      endpoint: "studio",
      capabilities: ["hermes"],
    });

    const sealPaths = hostsPathsForDocument(path);
    await writeFile(
      sealPaths.seal,
      `${JSON.stringify({ version: 1, alg: "hmac-sha256", mac: "not-a-real-mac" })}\n`,
      "utf8",
    );

    const cold = makeHostsRegistry(path);
    expect((await cold.list()).map((host) => host.id)).toEqual(["local"]);
  });

  it("bootstrap admits unsealed hosts once then seals", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-seal-bootstrap-"));
    dirs.push(root);
    const path = join(root, "hosts.json");
    const stamped = {
      version: 1 as const,
      hosts: [
        ...defaultRemoteHostsDocument().hosts,
        {
          id: "studio",
          label: "Studio",
          kind: "remote" as const,
          endpoint: "studio",
          capabilities: ["hermes" as const],
        },
      ],
    };
    await writeFile(path, `${JSON.stringify(stamped, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });

    const registry = makeHostsRegistry(path);
    const admitted = await registry.list();
    expect(admitted.map((host) => host.id).sort()).toEqual(["local", "studio"]);

    const sealPaths = hostsPathsForDocument(path);
    await stat(sealPaths.key);
    await stat(sealPaths.seal);

    // Subsequent offline membership flip fails closed.
    const flipped = {
      version: 1,
      hosts: [
        ...defaultRemoteHostsDocument().hosts,
        {
          id: "evil",
          label: "Evil",
          kind: "remote",
          endpoint: "evil",
          capabilities: ["hermes"],
        },
      ],
    };
    await writeFile(path, `${JSON.stringify(flipped, null, 2)}\n`, "utf8");
    const cold = makeHostsRegistry(path);
    expect((await cold.list()).map((host) => host.id)).toEqual(["local"]);
  });

  it("app-written seal matches sealed material helper", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-seal-rewrite-"));
    dirs.push(root);
    const path = join(root, "hosts.json");
    const registry = makeHostsRegistry(path);
    await registry.list();
    const hosts = await registry.upsert({
      id: "studio",
      label: "Studio",
      kind: "remote",
      endpoint: "studio",
      capabilities: ["hermes"],
    });
    // Rewriting the same seal is a no-op admit.
    await writeHostsSeal(path, { version: 1, hosts: [...hosts] });
    const cold = makeHostsRegistry(path);
    expect((await cold.list()).map((host) => host.id).sort()).toEqual([
      "local",
      "studio",
    ]);
  });

  it("keeps atomic rewrites owner-only", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-mode-"));
    dirs.push(root);
    const path = join(root, "hosts.json");
    const registry = makeHostsRegistry(path);
    await registry.list();
    await chmod(path, 0o664);

    await registry.upsert({
      id: "studio",
      label: "Studio",
      kind: "remote",
      endpoint: "studio",
      capabilities: ["hermes"],
    });

    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("repairs a legacy group/world-readable regular file before reading", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-legacy-mode-"));
    dirs.push(root);
    const path = join(root, "hosts.json");
    await writeFile(path, `${JSON.stringify(defaultRemoteHostsDocument())}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(path, 0o664);

    await makeHostsRegistry(path).list();

    expect((await lstat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects a symlink without changing or reading through its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-symlink-"));
    dirs.push(root);
    const target = join(root, "target.json");
    const path = join(root, "hosts.json");
    const body = `${JSON.stringify(defaultRemoteHostsDocument())}\n`;
    await writeFile(target, body, { encoding: "utf8", mode: 0o600 });
    await chmod(target, 0o664);
    await symlink(target, path);

    await expect(makeHostsRegistry(path).list()).rejects.toMatchObject({
      code: "io",
    });
    expect(await readFile(target, "utf8")).toBe(body);
    expect((await lstat(target)).mode & 0o777).toBe(0o664);
  });

  it("projects local station caps from code defaults without rewriting disk or inventing remote caps", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-local-projection-"));
    dirs.push(root);
    const path = join(root, "hosts.json");
    const onDisk = {
      version: 1,
      hosts: [
        {
          id: "local",
          label: "local",
          kind: "local",
          // Intentionally stripped — must not gate this-machine surfaces.
          capabilities: ["herdr"],
        },
        {
          id: "studio",
          label: "Studio",
          kind: "remote",
          endpoint: "studio",
          capabilities: ["terminal"],
        },
      ],
    };
    await writeFile(path, `${JSON.stringify(onDisk)}\n`, "utf8");

    const hosts = await makeHostsRegistry(path).list();
    const local = hosts.find((host) => host.id === "local");
    expect(local?.capabilities).toEqual(
      expect.arrayContaining(["terminal", "browser", "herdr", "hermes"]),
    );
    expect(local?.capabilities).toHaveLength(4);
    // Dynamic label when stored label is still the routing id.
    expect(local?.label).not.toBe("local");
    expect(hosts.find((host) => host.id === "studio")?.capabilities).toEqual([
      "terminal",
    ]);
    // Projection is runtime-only — do not rewrite enrollment for local caps.
    const persisted = JSON.parse(await readFile(path, "utf8")) as {
      hosts: Array<{ id: string; capabilities: string[] }>;
    };
    expect(persisted.hosts.find((host) => host.id === "local")?.capabilities)
      .toEqual(["herdr"]);
    expect(persisted.hosts.find((host) => host.id === "studio")?.capabilities)
      .toEqual(["terminal"]);
  });

  it("upserts an remote host and rejects removing local", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-"));
    dirs.push(root);
    const registry = makeHostsRegistry(join(root, "hosts.json"));
    const hosts = await registry.upsert({
      id: "studio",
      label: "studio mini",
      kind: "remote",
      endpoint: "studio",
      capabilities: ["herdr", "hermes"],
    });
    expect(hosts.some((host) => host.id === "studio")).toBe(true);
    await expect(registry.remove("local")).rejects.toMatchObject({ code: "conflict" });
  });

  it("resolves optional hermesId aliases without product-specific defaults", () => {
    setHostsSnapshot([
      ...defaultRemoteHostsDocument().hosts,
      {
        id: "fleet-1",
        label: "Fleet One",
        kind: "remote",
        endpoint: "fleet-1",
        capabilities: ["herdr", "hermes"],
        hermesId: "f1",
      },
    ]);
    const host = findHostByHermesId("f1");
    expect(host?.id).toBe("fleet-1");
    expect(hermesKeyFor(host!)).toBe("f1");
    expect(hostsWithCapability("herdr").map((h) => h.id)).toEqual(["local", "fleet-1"]);
    expect(listHerdrHosts().map((h) => h.id)).toEqual(["local", "fleet-1"]);
    expect(isKnownHerdrHost("studio")).toBe(false);
  });

  it("loads persisted hosts before the first normal-boot route and keeps list reload coherent", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-boot-"));
    dirs.push(root);
    const path = join(root, "hosts.json");
    process.env.VELLUM_HOSTS_PATH = path;
    // Unsealed on-disk document bootstraps a seal on first load.
    await writeFile(
      path,
      `${JSON.stringify({
        version: 1,
        hosts: [
          ...defaultRemoteHostsDocument().hosts,
          {
            id: "studio",
            label: "Studio",
            kind: "remote",
            endpoint: "studio-ssh",
            capabilities: ["herdr", "hermes"],
          },
        ],
      })}\n`,
      "utf8",
    );
    resetDefaultHostsRegistryForTests();
    setHostsSnapshot(defaultRemoteHostsDocument().hosts);

    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        // Yielding the plane is the normal boot construction boundary. The
        // first synchronous route below must already see the durable host.
        const herdr = yield* HerdrPlane;
        const hosts = yield* HostsService;
        const firstRoute = herdr.mirrors.mirrorFor("studio") !== undefined;

        // Membership changes go through the app write path (reseals). Offline
        // plaintext rewrites of hosts.json alone are no longer live authority.
        yield* hosts.remove("studio");
        yield* hosts.upsert({
          id: "render",
          label: "Render",
          kind: "remote",
          endpoint: "render-ssh",
          capabilities: ["herdr"],
        });
        const reloaded = yield* hosts.list;

        return {
          firstRoute,
          reloadedIds: reloaded.map((host) => host.id),
          oldRoute: isKnownHerdrHost("studio"),
          newRoute: herdr.mirrors.mirrorFor("render") !== undefined,
        };
      }).pipe(Effect.provide(ProductPlanesLive), Effect.scoped),
    );

    expect(observed).toEqual({
      firstRoute: true,
      reloadedIds: ["local", "render"],
      oldRoute: false,
      newRoute: true,
    });
  });

  it("boots local-only on an invalid durable registry while list and Doctor surface the error", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-invalid-boot-"));
    dirs.push(root);
    const path = join(root, "hosts.json");
    const invalid = '{"version":1,"hosts":[';
    process.env.VELLUM_HOSTS_PATH = path;
    await writeFile(path, invalid, "utf8");
    resetDefaultHostsRegistryForTests();
    setHostsSnapshot([
      ...defaultRemoteHostsDocument().hosts,
      {
        id: "stale",
        label: "Stale route",
        kind: "remote",
        endpoint: "stale-ssh",
        capabilities: ["herdr"],
      },
    ]);

    const observed = await Effect.runPromise(
      Effect.gen(function* () {
        const herdr = yield* HerdrPlane;
        const hosts = yield* HostsService;
        const listError = yield* hosts.list.pipe(
          Effect.match({
            onFailure: (error) => error.message,
            onSuccess: () => "unexpected success",
          }),
        );
        const doctor = yield* hosts.doctor;
        return {
          localOnly: listHerdrHosts().map((host) => host.id),
          staleRoute: herdr.mirrors.mirrorFor("stale") !== undefined,
          listError,
          doctor,
        };
      }).pipe(Effect.provide(ProductPlanesLive), Effect.scoped),
    );

    expect(observed.localOnly).toEqual(["local"]);
    expect(observed.staleRoute).toBe(false);
    expect(observed.listError).toContain("hosts.json unreadable");
    expect(observed.doctor).toMatchObject({
      status: "error",
      detail: expect.stringContaining("hosts.json unreadable"),
    });
    expect(await readFile(path, "utf8")).toBe(invalid);
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
            endpoint: "studio-ssh",
            capabilities: ["herdr"],
          },
        ])
      ).not.toThrow();
      expect(reconciliations).toBe(1);
      expect(warning).toHaveBeenCalledWith(
        "[vellum:hosts] routing snapshot listener failed",
      );
      expect(JSON.stringify(warning.mock.calls)).not.toContain("private-endpoint");
    } finally {
      unsubscribeBroken();
      unsubscribeHealthy();
      warning.mockRestore();
    }
  });

  it("restarts live Herdr mirrors on add, endpoint edit, and removal", () => {
    setHostsSnapshot(defaultRemoteHostsDocument().hosts);
    const started: string[] = [];
    const disposed: string[] = [];
    const mirrors = new HerdrMirrorRegistry((hostId): MirrorTransport => ({
      request: async () => {
        started.push(hostId);
        return { snapshot: {} };
      },
      openEvents: async () => () => undefined,
      dispose: () => {
        disposed.push(hostId);
      },
    }));

    try {
      mirrors.startAll();
      expect(started).toEqual(["local"]);

      const withStudio = [
        ...defaultRemoteHostsDocument().hosts,
        {
          id: "studio",
          label: "Studio",
          kind: "remote" as const,
          endpoint: "studio-a",
          capabilities: ["herdr" as const],
        },
      ];
      setHostsSnapshot(withStudio);
      expect(started).toEqual(["local", "local", "studio"]);
      expect(disposed).toEqual(["local"]);

      // A semantically identical list refresh must not flap live mirrors.
      setHostsSnapshot(withStudio.map((host) => ({ ...host })));
      expect(started).toHaveLength(3);

      setHostsSnapshot(withStudio.map((host) =>
        host.id === "studio" ? { ...host, endpoint: "studio-b" } : host,
      ));
      expect(started.slice(-2)).toEqual(["local", "studio"]);
      expect(disposed.slice(-2)).toEqual(["local", "studio"]);

      setHostsSnapshot(defaultRemoteHostsDocument().hosts);
      expect(started.at(-1)).toBe("local");
      expect(disposed.at(-1)).toBe("studio");
      expect(mirrors.mirrorFor("studio")).toBeUndefined();
    } finally {
      mirrors.stopAll();
    }
  });

  it("notifies onChange listeners when mirrors are created and across host reconciliation", () => {
    setHostsSnapshot(defaultRemoteHostsDocument().hosts);
    const notified: string[] = [];
    const mirrors = new HerdrMirrorRegistry((hostId): MirrorTransport => ({
      request: async () => ({ snapshot: {} }),
      openEvents: async () => () => undefined,
      dispose: () => undefined,
    }));
    const unsubscribe = mirrors.onChange((hostId) => notified.push(hostId));

    try {
      mirrors.startAll();
      expect(notified).toEqual(["local"]);

      const withStudio = [
        ...defaultRemoteHostsDocument().hosts,
        {
          id: "studio",
          label: "Studio",
          kind: "remote" as const,
          endpoint: "studio-a",
          capabilities: ["herdr" as const],
        },
      ];
      setHostsSnapshot(withStudio);
      expect(notified).toEqual(["local", "local", "studio"]);

      setHostsSnapshot(defaultRemoteHostsDocument().hosts);
      expect(notified).toEqual(["local", "local", "studio", "local", "studio"]);
    } finally {
      unsubscribe();
      mirrors.stopAll();
    }
  });

  it("rejects malformed/host:port endpoints while preserving direct IPv6 destinations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-endpoint-"));
    dirs.push(root);
    const registry = makeHostsRegistry(join(root, "hosts.json"));

    await expect(registry.upsert({
      id: "wrong-port",
      label: "Wrong port",
      kind: "remote",
      endpoint: "example.com:2222",
      capabilities: ["herdr"],
    })).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("custom ports in ~/.ssh/config"),
    });

    await expect(registry.upsert({
      id: "empty-user",
      label: "Empty user",
      kind: "remote",
      endpoint: "@example.com",
      capabilities: ["herdr"],
    })).rejects.toMatchObject({ code: "validation" });

    await expect(registry.upsert({
      id: "bracketed-ipv6",
      label: "Bracketed IPv6",
      kind: "remote",
      endpoint: "ops@[2001:db8::10]",
      capabilities: ["hermes"],
    })).rejects.toMatchObject({ code: "validation" });

    const ipv6 = await registry.upsert({
      id: "ipv6",
      label: "IPv6",
      kind: "remote",
      endpoint: "ops@2001:db8::10",
      capabilities: ["hermes"],
    });
    expect(ipv6.find((host) => host.id === "ipv6")?.endpoint).toBe("ops@2001:db8::10");

    const scopedIpv6 = await registry.upsert({
      id: "scoped-ipv6",
      label: "Scoped IPv6",
      kind: "remote",
      endpoint: "ops@fe80::1%lo0",
      capabilities: ["herdr"],
    });
    expect(scopedIpv6.find((host) => host.id === "scoped-ipv6")?.endpoint)
      .toBe("ops@fe80::1%lo0");
  });

  it("rejects duplicate capabilities instead of persisting ambiguous host claims", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-hosts-capabilities-"));
    dirs.push(root);
    const registry = makeHostsRegistry(join(root, "hosts.json"));

    await expect(registry.upsert({
      id: "studio",
      label: "Studio",
      kind: "remote",
      endpoint: "studio",
      capabilities: ["browser", "browser"],
    })).rejects.toMatchObject({
      code: "validation",
      message: expect.stringContaining("duplicate capability"),
    });
  });
});

describe("acp verbose logging gate", () => {
  it("defaults off", () => {
    expect(acpVerboseLogging()).toBe(false);
  });

  it("enables via VELLUM_ACP_VERBOSE", () => {
    process.env.VELLUM_ACP_VERBOSE = "1";
    expect(acpVerboseLogging()).toBe(true);
  });
});
