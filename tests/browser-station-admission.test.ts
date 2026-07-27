import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { serializeCanvas, type CanvasDoc } from "../src/shared/canvas";
import { defaultSettings, type Settings } from "../src/shared/settings";
import {
  STATION_PULL_ADMISSION_VERSION,
  STATION_PULL_STALE_AFTER_MS,
  type StationStatusDocument,
} from "../src/shared/station-status";
import type { RemoteHost } from "../src/shared/remote-hosts";
import {
  prepareBrowserStationAdmissionAuthority,
} from "../src/main/vellum/browser/station-admission";
import { makeSettingsService } from "../src/main/vellum/settings/service";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import { StateEngine } from "../src/main/vellum/state/service";
import type {
  StationStatusChange,
} from "../src/main/vellum/station-status-store";
import {
  readLocalCanvasMirrorWitness,
  stationSettingsWitness,
} from "../src/main/vellum/station-witness";

const now = Date.parse("2026-07-23T12:00:00.000Z");

const remoteSettings = (): Settings => ({
  ...defaultSettings(),
  station: {
    role: "remote",
    hostId: "studio",
    agentHostId: "studio",
    commandCenterRef: "command",
    supervisedPreferred: true,
  },
});

const remoteHost = (): RemoteHost => ({
  id: "studio",
  label: "Studio",
  kind: "remote",
  endpoint: "studio",
  capabilities: ["browser", "terminal"],
});

describe("Remote browser station admission", () => {
  let root = "";
  let canvasesDir = "";
  let settings: Settings;
  let status: StationStatusDocument;
  let hosts: ReadonlyArray<RemoteHost>;
  let statusListeners: Set<(change: StationStatusChange) => void>;
  let hostListeners: Set<
    (
      next: ReadonlyArray<RemoteHost>,
      previous: ReadonlyArray<RemoteHost>,
    ) => void
  >;
  let state: Context.Tag.Service<typeof StateEngine>;
  let closeState: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "vellum-browser-station-"));
    canvasesDir = join(root, "canvases");
    const stateRuntime = ManagedRuntime.make(
      makeStateEngineLive(join(root, "vellum.db")),
    );
    state = await stateRuntime.runPromise(StateEngine);
    closeState = () => stateRuntime.dispose();
    process.env.VELLUM_CANVASES_DIR = canvasesDir;
    settings = remoteSettings();
    const doc: CanvasDoc = { nodes: [], edges: [] };
    await mkdir(canvasesDir, { recursive: true });
    await writeFile(join(canvasesDir, "work.canvas"), serializeCanvas(doc), "utf8");
    const mirror = await readLocalCanvasMirrorWitness();
    status = {
      version: 1,
      lastPull: {
        at: new Date(now - 30_000).toISOString(),
        status: "ok",
        ok: true,
        detail: "complete",
        commandCenterRef: settings.station.commandCenterRef,
        keptLocal: false,
        pulledCount: 1,
        failedCount: 0,
        admission: {
          version: STATION_PULL_ADMISSION_VERSION,
          stationHostId: settings.station.hostId,
          stationConfigSha256: stationSettingsWitness(settings.station),
          canvasMirrorSha256: mirror.sha256,
          canvasCount: mirror.canvasCount,
        },
      },
    };
    hosts = [remoteHost()];
    statusListeners = new Set();
    hostListeners = new Set();
  });

  afterEach(async () => {
    delete process.env.VELLUM_CANVASES_DIR;
    await closeState?.();
    closeState = undefined;
    await rm(root, { recursive: true, force: true });
  });

  const makeService = async () => {
    const service = await Effect.runPromise(
      makeSettingsService(state, {
        probeSupervised: async () => "absent",
      }),
    );
    await Effect.runPromise(
      service.setStationTopology(settings.station),
    );
    return service;
  };

  const prepare = async () => {
    const service = await makeService();
    const authority = await prepareBrowserStationAdmissionAuthority(service, {
      now: () => now,
      readStatus: async () => status,
      readMirror: readLocalCanvasMirrorWitness,
      findHost: (hostId) => hosts.find((host) => host.id === hostId),
      subscribeStatus: (listener) => {
        statusListeners.add(listener);
        return () => statusListeners.delete(listener);
      },
      subscribeHosts: (listener) => {
        hostListeners.add(listener);
        return () => hostListeners.delete(listener);
      },
    });
    return { authority, service };
  };

  it("admits only the exact fresh complete pull and mirror", async () => {
    const { authority } = await prepare();
    await expect(authority.admit()).resolves.toEqual({
      ok: true,
      maxTtlMs: STATION_PULL_STALE_AFTER_MS - 30_000,
    });

    await writeFile(
      join(canvasesDir, "work.canvas"),
      serializeCanvas({
        nodes: [
          {
            id: "changed",
            type: "text",
            text: "changed",
            x: 0,
            y: 0,
            width: 100,
            height: 40,
          },
        ],
        edges: [],
      }),
      "utf8",
    );
    await expect(authority.admit()).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/does not match/i),
    });
    authority.close();
  });

  it.each([
    {
      label: "partial",
      mutate: (pull: NonNullable<StationStatusDocument["lastPull"]>) => ({
        ...pull,
        ok: false,
        status: "partial" as const,
        failedCount: 1,
      }),
      message: /not a complete/i,
    },
    {
      label: "kept local",
      mutate: (pull: NonNullable<StationStatusDocument["lastPull"]>) => ({
        ...pull,
        ok: false,
        status: "unreachable" as const,
        keptLocal: true,
      }),
      message: /not a complete/i,
    },
    {
      label: "future",
      mutate: (pull: NonNullable<StationStatusDocument["lastPull"]>) => ({
        ...pull,
        at: new Date(now + 1).toISOString(),
      }),
      message: /future/i,
    },
    {
      label: "stale",
      mutate: (pull: NonNullable<StationStatusDocument["lastPull"]>) => ({
        ...pull,
        at: new Date(now - STATION_PULL_STALE_AFTER_MS).toISOString(),
      }),
      message: /stale/i,
    },
  ])("fails closed for a $label pull receipt", async ({ mutate, message }) => {
    status = {
      version: 1,
      lastPull: mutate(status.lastPull!),
    };
    const { authority } = await prepare();
    await expect(authority.admit()).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(message),
    });
    authority.close();
  });

  it("publishes only admission-relevant status, settings, and host changes", async () => {
    const { authority, service } = await prepare();
    const listener = vi.fn();
    authority.subscribe(listener);

    const current = status;
    for (const statusListener of statusListeners) {
      statusListener({ kind: "kernel", previous: current, current });
    }
    await Effect.runPromise(
      service.patch({ appearance: { reduceMotion: true } }),
    );
    const unrelated = [
      ...hosts,
      {
        id: "other",
        label: "Other",
        kind: "remote" as const,
        endpoint: "other",
        capabilities: ["terminal" as const],
      },
    ];
    for (const hostListener of hostListeners) {
      hostListener(unrelated, hosts);
    }
    expect(listener).not.toHaveBeenCalled();

    for (const statusListener of statusListeners) {
      statusListener({ kind: "pull", previous: current, current });
    }
    // Established pairing freezes commandCenterRef/hostId/role; only
    // supervisedPreferred may change — still an admission-relevant settings event.
    await Effect.runPromise(
      service.setStationTopology({ supervisedPreferred: false }),
    );
    const previousHosts = hosts;
    hosts = [{ ...remoteHost(), capabilities: ["terminal"] }];
    for (const hostListener of hostListeners) {
      hostListener(hosts, previousHosts);
    }
    expect(listener).toHaveBeenCalledTimes(3);
    await expect(authority.admit()).resolves.toMatchObject({ ok: false });
    authority.close();
  });

  it("preserves Command Center admission without a pull receipt", async () => {
    settings = {
      ...defaultSettings(),
      station: {
        role: "command-center",
        hostId: "local",
        commandCenterRef: "",
        supervisedPreferred: false,
      },
    };
    const service = await makeService();
    const readStatus = vi.fn(async () => {
      throw new Error("must not read");
    });
    const authority = await prepareBrowserStationAdmissionAuthority(service, {
      now: () => now,
      readStatus,
      readMirror: async () => {
        throw new Error("must not read");
      },
      findHost: () => undefined,
      subscribeStatus: () => () => undefined,
      subscribeHosts: () => () => undefined,
    });
    await expect(authority.admit()).resolves.toEqual({ ok: true });
    expect(readStatus).not.toHaveBeenCalled();
    authority.close();
  });
});
