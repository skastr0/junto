import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime } from "effect";
import { describe, expect, it } from "vitest";
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
import {
  SettingsService,
  makeSettingsLive,
} from "../src/main/vellum/settings/service";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import type { Settings } from "../src/shared/settings";
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

const makePullRuntime = async (input: {
  readonly role: Settings["station"]["role"];
  readonly commandCenterRef: string;
  readonly hostId?: string;
}) => {
  const root = await mkdtemp(join(tmpdir(), "vellum-pull-state-"));
  const stateLive = makeStateEngineLive(join(root, "vellum.db"));
  const settingsLive = Layer.provideMerge(
    makeSettingsLive({
      probeSupervised: async () => "absent",
    }),
    stateLive,
  );
  const runtime = ManagedRuntime.make(settingsLive);
  const settings = await runtime.runPromise(SettingsService);
  await runtime.runPromise(
    settings.setStationTopology({
      role: input.role,
      hostId: input.hostId ?? "local",
      commandCenterRef: input.commandCenterRef,
      supervisedPreferred: input.role === "remote",
      topologyIntegrity: "ok",
    }),
  );
  return { runtime, root };
};

describe("pullCanvasesFromCommandCenter", () => {
  it("is disabled for beta (projection push is the fleet path)", async () => {
    const { runtime, root } = await makePullRuntime({
      role: "remote",
      commandCenterRef: "user@host",
    });
    try {
      const result = await runtime.runPromise(pullCanvasesFromCommandCenter);
      expect(result.ok).toBe(false);
      expect(result.status).toBe("misconfigured");
      expect(result.detail).toMatch(/disabled for beta/i);
      expect(result.keptLocal).toBe(true);
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
