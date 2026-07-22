import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
import { SettingsService, makeSettingsService } from "../src/main/vellum/settings/service";
import { HostsService, makeHostsService } from "../src/main/vellum/hosts/service";
import { makeHostsRegistry } from "../src/main/vellum/hosts/registry";
import { SshTransport } from "../src/main/vellum/ssh/service";
import { defaultSettings, type Settings } from "../src/shared/settings";
import type { RemoteHost } from "../src/shared/remote-hosts";
import { applyMirrorLaw, serializeCanvas, type CanvasDoc } from "../src/shared/canvas";

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
}): Ssh => {
  const files = options?.files ?? {};
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
    run: () =>
      Effect.sync(() => {
        runCount += 1;
        // Call order: homeDirectoryLookup → ls → cat*
        if (runCount === 1) {
          return { stdout: "/Users/cc\n", stderr: "" };
        }
        if (runCount === 2) {
          return {
            stdout: options?.listing ?? "portfolio.canvas\n",
            stderr: "",
          };
        }
        const names = Object.keys(files);
        const idx = runCount - 3;
        const name = names[idx] ?? names[0] ?? "portfolio";
        const body = files[name] ?? files.portfolio ?? JSON.stringify(sampleDoc);
        return { stdout: body, stderr: "" };
      }),
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
      hostId: "local",
      commandCenterRef: input.commandCenterRef,
      supervisedPreferred: input.role === "remote",
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
    ),
  );

  return { runtime, canvasesDir };
};

describe("pullCanvasesFromCommandCenter", () => {
  afterEach(() => {
    delete process.env.VELLUM_CANVASES_DIR;
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
    const { runtime, canvasesDir } = await makePullRuntime({
      role: "remote",
      commandCenterRef: "cc-laptop",
      ssh: makeMockSsh({
        listing: "portfolio.canvas\n",
        files: { portfolio: remoteBody },
      }),
      hosts: [remoteHost],
    });

    const result = await runtime.runPromise(pullCanvasesFromCommandCenter);
    expect(result.ok).toBe(true);
    expect(result.status).toBe("ok");
    expect(result.pulled.map((row) => row.name)).toEqual(["portfolio"]);
    expect(result.pulled[0]?.changed).toBe(true);

    const installed = await readFile(join(canvasesDir, "portfolio.canvas"), "utf8");
    expect(installed).toBe(serializeCanvas(applyMirrorLaw(sampleDoc)));
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
});
