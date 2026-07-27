import { Schema } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  InstallationId,
  LogicalSequence,
  StationConfiguration,
  type StationConfiguration as StationConfigurationValue,
} from "../src/shared/station-api";
import type { RemoteHost } from "../src/shared/remote-hosts";
import {
  BROWSER_STATION_ADMISSION_TTL_MS,
  prepareBrowserStationAdmissionAuthority,
} from "../src/main/vellum/browser/station-admission";
import {
  stationProjectionContentSha256,
  type StationProjection,
  type StationStatusFacts,
} from "../src/main/vellum/station/repository";

const installationId = Schema.decodeUnknownSync(InstallationId);
const logicalSequence = Schema.decodeUnknownSync(LogicalSequence);
const stationConfiguration = Schema.decodeUnknownSync(StationConfiguration);

const commandCenterInstallationId = installationId("command-installation");
const remoteInstallationId = installationId("remote-installation");
const projectionBody = JSON.stringify({ canvases: [] });
const contentSha256 = stationProjectionContentSha256(projectionBody);
const receivedAt = "2026-07-27T15:00:01.000Z";

const remoteConfiguration = (): StationConfigurationValue =>
  stationConfiguration({
    role: "remote",
    hostId: "studio",
    agentHostId: "studio",
    commandCenterInstallationId,
    supervisedPreferred: true,
  });

const commandCenterConfiguration = (): StationConfigurationValue =>
  stationConfiguration({
    role: "command-center",
    hostId: "local",
    supervisedPreferred: false,
  });

const projection = (): StationProjection => ({
  scope: "full",
  generation: logicalSequence("7"),
  body: projectionBody,
  contentSha256,
  createdAt: "2026-07-27T15:00:00.000Z",
  receivedAt,
});

const remoteFacts = (): StationStatusFacts => ({
  installationId: remoteInstallationId,
  pairing: {
    commandCenterInstallationId,
    stationLabel: "Studio",
    appVersion: "0.1.0",
    pairedAt: "2026-07-27T14:00:00.000Z",
  },
  configuration: remoteConfiguration(),
  configuredAt: "2026-07-27T14:30:00.000Z",
  projection: {
    generation: logicalSequence("7"),
    contentSha256,
    receivedAt,
  },
  receivedThrough: [],
  peerAcknowledgedThrough: [],
});

const remoteHost = (): RemoteHost => ({
  id: "studio",
  label: "Studio",
  kind: "remote",
  sshEndpoint: "studio",
  capabilities: ["browser", "terminal"],
});

type StationRead = Readonly<{
  facts: StationStatusFacts;
  projection?: StationProjection;
}>;

describe("browser station admission", () => {
  let station: StationRead;
  let stationReadError: Error | undefined;
  let hosts: ReadonlyArray<RemoteHost>;
  let hostListeners: Set<
    (
      next: ReadonlyArray<RemoteHost>,
      previous: ReadonlyArray<RemoteHost>,
    ) => void
  >;

  beforeEach(() => {
    station = { facts: remoteFacts(), projection: projection() };
    stationReadError = undefined;
    hosts = [remoteHost()];
    hostListeners = new Set();
  });

  const prepare = () =>
    prepareBrowserStationAdmissionAuthority({
      readStation: async () => {
        if (stationReadError !== undefined) throw stationReadError;
        return station;
      },
      findHost: (hostId: string) => hosts.find((host) => host.id === hostId),
      subscribeHosts: (
        listener: (
          next: ReadonlyArray<RemoteHost>,
          previous: ReadonlyArray<RemoteHost>,
        ) => void,
      ) => {
        hostListeners.add(listener);
        return () => hostListeners.delete(listener);
      },
    });

  it("admits an exact Remote configuration, pairing, host, and full projection", async () => {
    const authority = await prepare();
    expect(BROWSER_STATION_ADMISSION_TTL_MS).toBe(5_000);

    const first = await authority.admit();
    expect(first).toEqual({
      ok: true,
      maxTtlMs: BROWSER_STATION_ADMISSION_TTL_MS,
    });
    await expect(authority.admit()).resolves.toEqual(first);

    authority.close();
  });

  it("requires canonical configuration even on Command Center", async () => {
    station = {
      facts: {
        installationId: commandCenterInstallationId,
        configuration: commandCenterConfiguration(),
        configuredAt: "2026-07-27T14:30:00.000Z",
        receivedThrough: [],
        peerAcknowledgedThrough: [],
      },
    };
    const authority = await prepare();
    await expect(authority.admit()).resolves.toEqual({ ok: true });

    station = {
      facts: {
        installationId: commandCenterInstallationId,
        receivedThrough: [],
        peerAcknowledgedThrough: [],
      },
    };
    await expect(authority.admit()).resolves.toMatchObject({ ok: false });
    authority.close();
  });

  it.each([
    {
      label: "missing pairing",
      mutate: (current: StationRead): StationRead => ({
        ...current,
        facts: { ...current.facts, pairing: undefined },
      }),
    },
    {
      label: "pairing for another Command Center",
      mutate: (current: StationRead): StationRead => ({
        ...current,
        facts: {
          ...current.facts,
          pairing: {
            ...current.facts.pairing!,
            commandCenterInstallationId: installationId("other-command"),
          },
        },
      }),
    },
    {
      label: "missing status projection reference",
      mutate: (current: StationRead): StationRead => ({
        ...current,
        facts: { ...current.facts, projection: undefined },
      }),
    },
    {
      label: "missing installed projection",
      mutate: (current: StationRead): StationRead => ({
        facts: current.facts,
      }),
    },
    {
      label: "different projection generation",
      mutate: (current: StationRead): StationRead => ({
        ...current,
        projection: {
          ...current.projection!,
          generation: logicalSequence("8"),
        },
      }),
    },
    {
      label: "different projection hash",
      mutate: (current: StationRead): StationRead => ({
        ...current,
        projection: {
          ...current.projection!,
          contentSha256: stationProjectionContentSha256(
            JSON.stringify({ canvases: [{ id: "different" }] }),
          ),
        },
      }),
    },
    {
      label: "different projection receipt",
      mutate: (current: StationRead): StationRead => ({
        ...current,
        projection: {
          ...current.projection!,
          receivedAt: "2026-07-27T15:00:02.000Z",
        },
      }),
    },
  ])("fails closed for a Remote with $label", async ({ mutate }) => {
    station = mutate(station);
    const authority = await prepare();

    await expect(authority.admit()).resolves.toMatchObject({ ok: false });
    authority.close();
  });

  it.each([
    {
      label: "no enrolled host",
      host: undefined,
    },
    {
      label: "a different host identity",
      host: { ...remoteHost(), id: "other" },
    },
    {
      label: "a local host row",
      host: { ...remoteHost(), kind: "local" as const },
    },
    {
      label: "no browser capability",
      host: { ...remoteHost(), capabilities: ["terminal" as const] },
    },
  ])("fails closed when the configured Remote resolves to $label", async ({ host }) => {
    hosts = host === undefined ? [] : [host];
    const authority = await prepare();

    await expect(authority.admit()).resolves.toMatchObject({ ok: false });
    authority.close();
  });

  it("fails closed when canonical station state cannot be read", async () => {
    stationReadError = new Error("database unavailable");
    const authority = await prepare();

    await expect(authority.admit()).resolves.toMatchObject({ ok: false });
    authority.close();
  });

  it("rejects an admission whose host authority changes during the repository read", async () => {
    let resolveStation!: (value: StationRead) => void;
    const pending = new Promise<StationRead>((resolve) => {
      resolveStation = resolve;
    });
    const authority = await prepareBrowserStationAdmissionAuthority({
      readStation: async () => pending,
      findHost: (hostId: string) =>
        hosts.find((host) => host.id === hostId),
      subscribeHosts: (
        listener: (
          next: ReadonlyArray<RemoteHost>,
          previous: ReadonlyArray<RemoteHost>,
        ) => void,
      ) => {
        hostListeners.add(listener);
        return () => hostListeners.delete(listener);
      },
    });

    const admission = authority.admit();
    const changed = [
      ...hosts,
      {
        id: "other",
        label: "Other",
        kind: "remote" as const,
        sshEndpoint: "other",
        capabilities: ["terminal" as const],
      },
    ];
    for (const hostListener of hostListeners) {
      hostListener(changed, hosts);
    }
    resolveStation(station);

    await expect(admission).resolves.toMatchObject({
      ok: false,
      message: expect.stringMatching(/changed/i),
    });
    authority.close();
  });

  it("publishes enrolled-host authority changes and unsubscribes on close", async () => {
    const authority = await prepare();
    const listener = vi.fn();
    authority.subscribe(listener);

    const previous = hosts;
    hosts = [{ ...remoteHost(), capabilities: ["terminal"] }];
    for (const hostListener of hostListeners) {
      hostListener(hosts, previous);
    }

    expect(listener).toHaveBeenCalledTimes(1);
    await expect(authority.admit()).resolves.toMatchObject({ ok: false });

    authority.close();
    expect(hostListeners.size).toBe(0);
    await expect(authority.admit()).resolves.toMatchObject({ ok: false });
  });
});
