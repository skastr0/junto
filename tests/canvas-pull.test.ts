import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "effect";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  canvasNameFromListingEntry,
  canvasPullFileName,
  isValidCanvasPullName,
  parseRemoteCanvasListing,
  resolveCommandCenterEndpoint,
} from "../src/shared/canvas-pull";
import {
  atomicInstallCanvasFile,
  preparePulledCanvasBody,
  pullCanvasesFromCommandCenter,
} from "../src/main/vellum/canvas-pull";
import { CanvasesLive } from "../src/main/vellum/canvases";
import { readStationStatus } from "../src/main/vellum/station-status-store";
import {
  readLocalCanvasMirrorWitness,
  stationSettingsWitness,
} from "../src/main/vellum/station-witness";
import { SettingsService, makeSettingsService } from "../src/main/vellum/settings/service";
import { HostsService, makeHostsService } from "../src/main/vellum/hosts/service";
import { makeHostsRegistry } from "../src/main/vellum/hosts/registry";
import { SshTransport } from "../src/main/vellum/ssh/service";
import {
  SshExitError,
  SshTimeoutError,
  type SshError,
} from "../src/main/vellum/ssh/domain";
import { defaultSettings, type Settings } from "../src/shared/settings";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { applyMirrorLaw, serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import {
  agentKeysForWatcher,
  isNodeEligibleOnStation,
} from "../src/shared/station";

describe("canvas pull pure helpers", () => {
  it("accepts valid canvas names", () => {
    expect(isValidCanvasPullName("portfolio")).toBe(true);
    expect(isValidCanvasPullName("a")).toBe(true);
    expect(isValidCanvasPullName("my-board-2")).toBe(true);
    expect(isValidCanvasPullName("work_board")).toBe(true);
    expect(isValidCanvasPullName("a".repeat(64))).toBe(true);
  });

  it("rejects invalid canvas names", () => {
    expect(isValidCanvasPullName("")).toBe(false);
    expect(isValidCanvasPullName("Portfolio")).toBe(false);
    expect(isValidCanvasPullName("has space")).toBe(false);
    expect(isValidCanvasPullName("../etc")).toBe(false);
    expect(isValidCanvasPullName("foo.bar")).toBe(false);
    expect(isValidCanvasPullName("a".repeat(65))).toBe(false);
  });

  it("builds canvas file names", () => {
    expect(canvasPullFileName("portfolio")).toBe("portfolio.canvas");
  });

  it("parses listing entries safely", () => {
    expect(canvasNameFromListingEntry("portfolio.canvas")).toBe("portfolio");
    expect(canvasNameFromListingEntry("  main.canvas\n")).toBe("main");
    expect(canvasNameFromListingEntry("/Users/x/.vellum/canvases/work.canvas")).toBe("work");
    expect(canvasNameFromListingEntry("../secret.canvas")).toBeUndefined();
    expect(canvasNameFromListingEntry("notes.txt")).toBeUndefined();
    expect(canvasNameFromListingEntry("BadName.canvas")).toBeUndefined();
    expect(canvasNameFromListingEntry("")).toBeUndefined();
  });

  it("parses remote ls stdout into sorted unique names", () => {
    const names = parseRemoteCanvasListing(
      ["portfolio.canvas", "main.canvas", "portfolio.canvas", "noise.txt", "", "other.canvas"].join(
        "\n",
      ),
    );
    expect(names).toEqual(["main", "other", "portfolio"]);
  });

  it("resolves Command Center ref via remote host registry", () => {
    const hosts = [
      { id: "local", kind: "local" as const },
      { id: "laptop", kind: "remote" as const, endpoint: "user@laptop" },
    ];
    expect(resolveCommandCenterEndpoint("laptop", hosts)).toEqual({
      ok: true,
      endpoint: "user@laptop",
      source: "host",
    });
  });

  it("rejects local host id as Command Center", () => {
    const result = resolveCommandCenterEndpoint("local", [
      { id: "local", kind: "local" },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.detail).toMatch(/local host/i);
    }
  });

  it("rejects empty ref", () => {
    const result = resolveCommandCenterEndpoint("  ", []);
    expect(result.ok).toBe(false);
  });

  it("accepts direct SSH endpoint when not a host id", () => {
    expect(resolveCommandCenterEndpoint("studio-box", [])).toEqual({
      ok: true,
      endpoint: "studio-box",
      source: "direct",
    });
    expect(resolveCommandCenterEndpoint("user@10.0.0.2", [])).toEqual({
      ok: true,
      endpoint: "user@10.0.0.2",
      source: "direct",
    });
  });

  it("rejects remote host without endpoint", () => {
    const result = resolveCommandCenterEndpoint("ghost", [
      { id: "ghost", kind: "remote" },
    ]);
    expect(result.ok).toBe(false);
  });
});

describe("preparePulledCanvasBody + atomicInstall", () => {
  it("rejects invalid JSON", () => {
    const result = preparePulledCanvasBody("x", "not-json");
    expect(result.ok).toBe(false);
  });

  it("rejects non-canvas JSON", () => {
    const result = preparePulledCanvasBody("x", JSON.stringify({ foo: 1 }));
    expect(result.ok).toBe(false);
  });

  it("accepts a valid empty canvas and installs atomically", async () => {
    const doc: CanvasDoc = { nodes: [], edges: [] };
    const raw = JSON.stringify(doc);
    const prepared = preparePulledCanvasBody("portfolio", raw);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const dir = await mkdtemp(join(tmpdir(), "vellum-canvas-pull-"));
    const previousRoot = process.env.VELLUM_CANVASES_DIR;
    process.env.VELLUM_CANVASES_DIR = dir;
    try {
      const first = await atomicInstallCanvasFile("portfolio", prepared.body);
      expect(first.changed).toBe(true);
      expect(first.bytes).toBeGreaterThan(0);

      const second = await atomicInstallCanvasFile("portfolio", prepared.body);
      expect(second.changed).toBe(false);

      const onDisk = await readFile(join(dir, "portfolio.canvas"), "utf8");
      expect(onDisk).toBe(serializeCanvas(applyMirrorLaw(doc)));
    } finally {
      if (previousRoot === undefined) delete process.env.VELLUM_CANVASES_DIR;
      else process.env.VELLUM_CANVASES_DIR = previousRoot;
    }
  });

  it("refuses traversal at the atomic install sink", async () => {
    const doc: CanvasDoc = { nodes: [], edges: [] };
    const body = serializeCanvas(applyMirrorLaw(doc));
    const root = await mkdtemp(join(tmpdir(), "vellum-canvas-pull-root-"));
    const previousRoot = process.env.VELLUM_CANVASES_DIR;
    process.env.VELLUM_CANVASES_DIR = root;
    try {
      await expect(atomicInstallCanvasFile("../outside", body)).rejects.toThrow(
        "invalid canvas name",
      );
      await expect(readFile(join(root, "..", "outside.canvas"), "utf8")).rejects.toThrow();
    } finally {
      if (previousRoot === undefined) delete process.env.VELLUM_CANVASES_DIR;
      else process.env.VELLUM_CANVASES_DIR = previousRoot;
    }
  });
});

const remoteHost: RemoteHost = {
  id: "cc-laptop",
  label: "CC Laptop",
  kind: "remote",
  endpoint: "cc-laptop",
  capabilities: ["herdr", "hermes"],
};

const sampleDoc: CanvasDoc = {
  nodes: [
    {
      id: "n1",
      type: "text",
      x: 0,
      y: 0,
      width: 100,
      height: 40,
      text: "hello",
    },
  ],
  edges: [],
};

type Ssh = Context.Tag.Service<typeof SshTransport>;

const makeMockSsh = (options?: {
  readonly failWarm?: boolean;
  readonly listing?: string;
  readonly files?: Readonly<Record<string, string>>;
  readonly listError?: SshError;
  readonly catError?: SshError;
}): Ssh => {
  const files = options?.files ?? {};
  const listingStdout = options?.listing ?? "portfolio.canvas\n";
  const listedNames = parseRemoteCanvasListing(listingStdout);
  let runCount = 0;

  return {
    warm: () =>
      options?.failWarm
        ? Effect.fail({
            _tag: "SshTimeoutError",
            endpoint: "cc-laptop",
            operation: "warm",
            timeoutMs: 1,
          } as never)
        : Effect.void,
    run: () => {
      runCount += 1;
      // Call order: homeDirectoryLookup → ls → cat* (in listing order)
      if (runCount === 1) {
        return Effect.succeed({ stdout: "/Users/cc\n", stderr: "" });
      }
      if (runCount === 2) {
        return options?.listError
          ? Effect.fail(options.listError)
          : Effect.succeed({
              stdout: listingStdout,
              stderr: "",
            });
      }
      if (options?.catError) {
        return Effect.fail(options.catError);
      }
      const idx = runCount - 3;
      const name = listedNames[idx] ?? listedNames[0] ?? "portfolio";
      const body = files[name] ?? files.portfolio ?? JSON.stringify(sampleDoc);
      return Effect.succeed({ stdout: body, stderr: "" });
    },
    connect: () => Effect.die("unused"),
    forward: () => Effect.die("unused"),
    handoff: () => Effect.die("unused"),
    teardown: () => Effect.void,
  } as unknown as Ssh;
};

const makePullRuntime = async (input: {
  readonly role: Settings["station"]["role"];
  readonly commandCenterRef: string;
  readonly ssh: Ssh;
  readonly hosts: ReadonlyArray<RemoteHost>;
  readonly canvasesDir?: string;
  readonly hostId?: string;
}) => {
  const settingsDir = await mkdtemp(join(tmpdir(), "vellum-settings-"));
  const settingsPath = join(settingsDir, "settings.json");
  const hostsDir = await mkdtemp(join(tmpdir(), "vellum-hosts-"));
  const hostsPath = join(hostsDir, "hosts.json");
  const canvasesDir =
    input.canvasesDir ?? (await mkdtemp(join(tmpdir(), "vellum-canvases-")));

  const settings: Settings = {
    ...defaultSettings(),
    station: {
      role: input.role,
      hostId: input.hostId ?? "local",
      commandCenterRef: input.commandCenterRef,
      supervisedPreferred: input.role === "remote",
      topologyIntegrity: "ok",
    },
  };
  await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
  await writeFile(
    hostsPath,
    JSON.stringify(
      {
        version: 1,
        hosts: [
          {
            id: "local",
            label: "local",
            kind: "local",
            capabilities: ["herdr", "hermes"],
          },
          ...input.hosts,
        ],
      },
      null,
      2,
    ),
    "utf8",
  );

  process.env.VELLUM_CANVASES_DIR = canvasesDir;
  process.env.VELLUM_STATION_STATUS_PATH = join(
    settingsDir,
    "station-status.json",
  );

  const settingsSvc = makeSettingsService(settingsPath, {
    probeSupervised: async () => "absent",
  });
  const registry = makeHostsRegistry(hostsPath);
  await registry.reload();
  const hostsSvc = makeHostsService(registry, input.ssh);
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Layer.succeed(SettingsService, settingsSvc),
      Layer.succeed(HostsService, hostsSvc),
      Layer.succeed(SshTransport, input.ssh),
      CanvasesLive,
    ),
  );

  return { runtime, canvasesDir };
};

describe("pullCanvasesFromCommandCenter", () => {
  afterEach(() => {
    delete process.env.VELLUM_CANVASES_DIR;
    delete process.env.VELLUM_STATION_STATUS_PATH;
  });

  it("skips when station is not Remote", async () => {
    const { runtime } = await makePullRuntime({
      role: "command-center",
      commandCenterRef: "",
      ssh: makeMockSsh(),
      hosts: [],
    });
    const result = await runtime.runPromise(pullCanvasesFromCommandCenter);
    expect(result.status).toBe("skipped_not_remote");
    expect(result.ok).toBe(false);
    expect(result.keptLocal).toBe(true);
    await runtime.dispose();
  });

  it("keeps local canvases when Command Center is unreachable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vellum-canvases-"));
    await mkdir(dir, { recursive: true });
    const sentinel = serializeCanvas(applyMirrorLaw({ nodes: [], edges: [] }));
    await writeFile(join(dir, "kept.canvas"), sentinel, "utf8");

    const { runtime } = await makePullRuntime({
      role: "remote",
      commandCenterRef: "cc-laptop",
      ssh: makeMockSsh({ failWarm: true }),
      hosts: [remoteHost],
      canvasesDir: dir,
    });

    const result = await runtime.runPromise(pullCanvasesFromCommandCenter);
    expect(result.status).toBe("unreachable");
    expect(result.keptLocal).toBe(true);
    expect(result.ok).toBe(false);
    expect(await readFile(join(dir, "kept.canvas"), "utf8")).toBe(sentinel);
    await runtime.dispose();
  });

  it("pulls canvases from Command Center when reachable", async () => {
    const remoteBody = JSON.stringify(sampleDoc);
    const canvasesDir = await mkdtemp(join(tmpdir(), "vellum-canvases-"));
    const oldBody = serializeCanvas(applyMirrorLaw({ nodes: [], edges: [] }));
    await writeFile(join(canvasesDir, "portfolio.canvas"), oldBody, "utf8");
    await writeFile(join(canvasesDir, "stale.canvas"), oldBody, "utf8");
    await writeFile(join(canvasesDir, "operator-note.txt"), "untouched", "utf8");

    const { runtime } = await makePullRuntime({
      role: "remote",
      commandCenterRef: "cc-laptop",
      ssh: makeMockSsh({
        listing: "portfolio.canvas\n",
        files: { portfolio: remoteBody },
      }),
      hosts: [remoteHost],
      canvasesDir,
    });

    const result = await runtime.runPromise(pullCanvasesFromCommandCenter);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.pulled.map((row) => row.name)).toEqual(["portfolio"]);
    expect(result.pulled[0]?.changed).toBe(true);

    const installed = await readFile(join(canvasesDir, "portfolio.canvas"), "utf8");
    expect(installed).toBe(serializeCanvas(applyMirrorLaw(sampleDoc)));
    await expect(readFile(join(canvasesDir, "stale.canvas"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(canvasesDir, "operator-note.txt"), "utf8")).toBe(
      "untouched",
    );
    expect(result.detail).toContain("1 stale local removed");
    const mirror = await readLocalCanvasMirrorWitness();
    await expect(readStationStatus()).resolves.toMatchObject({
      lastPull: {
        ok: true,
        status: "ok",
        keptLocal: false,
        failedCount: 0,
        admission: {
          stationHostId: "local",
          stationConfigSha256: stationSettingsWitness({
            role: "remote",
            hostId: "local",
            commandCenterRef: "cc-laptop",
            supervisedPreferred: true,
            topologyIntegrity: "ok",
          }),
          canvasMirrorSha256: mirror.sha256,
          canvasCount: 1,
        },
      },
    });
    await runtime.dispose();
  });

  it("treats an authoritative empty listing as an empty mirror", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vellum-canvases-"));
    const body = serializeCanvas(applyMirrorLaw({ nodes: [], edges: [] }));
    await writeFile(join(dir, "first.canvas"), body, "utf8");
    await writeFile(join(dir, "second.canvas"), body, "utf8");
    await writeFile(join(dir, "operator-note.txt"), "untouched", "utf8");

    const { runtime } = await makePullRuntime({
      role: "remote",
      commandCenterRef: "cc-laptop",
      ssh: makeMockSsh({ listing: "" }),
      hosts: [remoteHost],
      canvasesDir: dir,
    });

    const result = await runtime.runPromise(pullCanvasesFromCommandCenter);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("empty");
    expect(result.keptLocal).toBe(false);
    expect(result.detail).toContain("2 stale local removed");
    expect(await readdir(dir)).toEqual(["operator-note.txt"]);
    await runtime.dispose();
  });

  it.each([
    {
      label: "non-zero remote listing",
      error: new SshExitError({
        endpoint: "cc-laptop",
        operation: "one-shot",
        code: 255,
      }),
    },
    {
      label: "listing transport timeout",
      error: new SshTimeoutError({
        endpoint: "cc-laptop",
        operation: "one-shot",
        timeoutMs: 10_000,
      }),
    },
  ])("keeps the last mirror on $label failure", async ({ error }) => {
    const dir = await mkdtemp(join(tmpdir(), "vellum-canvases-"));
    const body = serializeCanvas(applyMirrorLaw({ nodes: [], edges: [] }));
    await writeFile(join(dir, "kept.canvas"), body, "utf8");

    const { runtime } = await makePullRuntime({
      role: "remote",
      commandCenterRef: "cc-laptop",
      ssh: makeMockSsh({ listError: error }),
      hosts: [remoteHost],
      canvasesDir: dir,
    });

    const result = await runtime.runPromise(pullCanvasesFromCommandCenter);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("unreachable");
    expect(result.status).not.toBe("empty");
    expect(result.keptLocal).toBe(true);
    expect(result.detail).toMatch(/failed to list command center canvases/i);
    expect(await readFile(join(dir, "kept.canvas"), "utf8")).toBe(body);
    await runtime.dispose();
  });

  it("preserves host stamps for configured-host eligibility after pull", async () => {
    const hostScopedDoc: CanvasDoc = {
      nodes: [
        {
          id: "watch-studio",
          type: "text",
          text: "studio watcher",
          x: 0,
          y: 0,
          width: 120,
          height: 80,
          ether: {
            entity: { kind: "watcher" },
            host: "studio",
            watch: { kind: "glyphs_done" },
          },
        },
        {
          id: "agent-studio",
          type: "text",
          text: "studio agent",
          x: 160,
          y: 0,
          width: 120,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "studio:codex" },
            host: "studio",
          },
        },
        {
          id: "watch-other",
          type: "text",
          text: "other watcher",
          x: 0,
          y: 120,
          width: 120,
          height: 80,
          ether: {
            entity: { kind: "watcher" },
            host: "other",
            watch: { kind: "glyphs_done" },
          },
        },
        {
          id: "agent-other",
          type: "text",
          text: "other agent",
          x: 160,
          y: 120,
          width: 120,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "other:codex" },
            host: "other",
          },
        },
      ],
      edges: [
        {
          id: "edge-studio",
          fromNode: "watch-studio",
          toNode: "agent-studio",
        },
        {
          id: "edge-other",
          fromNode: "watch-other",
          toNode: "agent-other",
        },
      ],
    };
    const { runtime, canvasesDir } = await makePullRuntime({
      role: "remote",
      hostId: "studio",
      commandCenterRef: "cc-laptop",
      ssh: makeMockSsh({
        listing: "fleet.canvas\n",
        files: { fleet: JSON.stringify(hostScopedDoc) },
      }),
      hosts: [remoteHost],
    });

    const result = await runtime.runPromise(pullCanvasesFromCommandCenter);
    expect(result.ok).toBe(true);

    const installed = JSON.parse(
      await readFile(join(canvasesDir, "fleet.canvas"), "utf8"),
    ) as CanvasDoc;
    const configured = installed.nodes.find((node) => node.id === "watch-studio");
    const wrongHost = installed.nodes.find((node) => node.id === "watch-other");
    expect(configured && isNodeEligibleOnStation(configured, "studio")).toBe(true);
    expect(wrongHost && isNodeEligibleOnStation(wrongHost, "studio")).toBe(false);
    expect(agentKeysForWatcher(installed, "watch-studio", "remote", "studio")).toEqual([
      "studio:codex",
    ]);
    expect(agentKeysForWatcher(installed, "watch-other", "remote", "studio")).toEqual([]);
    await runtime.dispose();
  });

  it("reports misconfigured when commandCenterRef is empty", async () => {
    const { runtime } = await makePullRuntime({
      role: "remote",
      commandCenterRef: "",
      ssh: makeMockSsh(),
      hosts: [],
    });
    const result = await runtime.runPromise(pullCanvasesFromCommandCenter);
    expect(result.status).toBe("misconfigured");
    expect(result.keptLocal).toBe(true);
    await runtime.dispose();
  });

  it("refuses partial projection and leaves good local canvases untouched", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vellum-canvases-"));
    const goodBody = serializeCanvas(applyMirrorLaw({ nodes: [], edges: [] }));
    const staleBody = serializeCanvas(applyMirrorLaw({ nodes: [], edges: [] }));
    await writeFile(join(dir, "portfolio.canvas"), goodBody, "utf8");
    await writeFile(join(dir, "stale.canvas"), staleBody, "utf8");

    const { runtime } = await makePullRuntime({
      role: "remote",
      commandCenterRef: "cc-laptop",
      ssh: makeMockSsh({
        listing: "portfolio.canvas\nbroken.canvas\n",
        files: {
          portfolio: JSON.stringify(sampleDoc),
          broken: "not-json",
        },
      }),
      hosts: [remoteHost],
      canvasesDir: dir,
    });

    const result = await runtime.runPromise(pullCanvasesFromCommandCenter);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("partial");
    expect(result.keptLocal).toBe(true);
    expect(result.pulled).toEqual([]);
    expect(result.failed.some((row) => row.name === "broken")).toBe(true);
    // Live authority untouched: neither install nor stale delete.
    expect(await readFile(join(dir, "portfolio.canvas"), "utf8")).toBe(goodBody);
    expect(await readFile(join(dir, "stale.canvas"), "utf8")).toBe(staleBody);
    await expect(readFile(join(dir, "broken.canvas"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    await runtime.dispose();
  });
});
