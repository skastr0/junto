import { Effect } from "effect";
import { hostHasCapability, type RemoteHost } from "@shared/remote-hosts";
import type { StationSettings } from "@shared/settings";
import {
  STATION_PULL_STALE_AFTER_MS,
  type StationStatusDocument,
} from "@shared/station-status";
import { AppRuntime } from "../../runtime";
import {
  findHostById,
  subscribeHostsSnapshot,
} from "../hosts/snapshot";
import {
  SettingsService,
  type SettingsServiceApi,
} from "../settings/service";
import {
  readStationStatus,
  subscribeStationStatus,
  type StationStatusChange,
} from "../station-status-store";
import {
  readLocalCanvasMirrorWitness,
  stationSettingsWitness,
  type CanvasMirrorWitness,
} from "../station-witness";

export type BrowserStationAdmissionResult =
  | {
      readonly ok: true;
      /** Upper bound before the successful pull ceases to be fresh. */
      readonly maxTtlMs?: number;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

export interface BrowserStationAdmissionAuthority {
  readonly admit: () => Promise<BrowserStationAdmissionResult>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly close: () => void;
}

type BrowserStationAdmissionDependencies = {
  readonly readStatus: () => Promise<StationStatusDocument>;
  readonly readMirror: () => Promise<CanvasMirrorWitness>;
  readonly findHost: (hostId: string) => RemoteHost | undefined;
  readonly subscribeHosts: (
    listener: (
      hosts: ReadonlyArray<RemoteHost>,
      previous: ReadonlyArray<RemoteHost>,
    ) => void,
  ) => () => void;
  readonly subscribeStatus: (
    listener: (change: StationStatusChange) => void,
  ) => () => void;
  readonly now: () => number;
};

const defaultDependencies: BrowserStationAdmissionDependencies = {
  readStatus: readStationStatus,
  readMirror: readLocalCanvasMirrorWitness,
  findHost: findHostById,
  subscribeHosts: subscribeHostsSnapshot,
  subscribeStatus: subscribeStationStatus,
  now: Date.now,
};

const hostAuthorityTuple = (
  station: StationSettings | undefined,
  hosts: ReadonlyArray<RemoteHost>,
): string => {
  if (station === undefined) return "station-unavailable";
  const host = hosts.find((candidate) => candidate.id === station.hostId);
  return JSON.stringify({
    stationHostId: station.hostId,
    hostKind: host?.kind ?? null,
    browser: host === undefined ? false : hostHasCapability(host, "browser"),
  });
};

const denial = (message: string): BrowserStationAdmissionResult => ({
  ok: false,
  message,
});

/**
 * Prepare the private admission authority before the browser control plane is
 * exposed. Browser callers cannot supply a path, clock, status row, or station
 * tuple; every fact is read from owner-local application services.
 */
export const prepareBrowserStationAdmissionAuthority = async (
  settings: Pick<SettingsServiceApi, "get" | "subscribe">,
  dependencies: Partial<BrowserStationAdmissionDependencies> = {},
): Promise<BrowserStationAdmissionAuthority> => {
  const deps = { ...defaultDependencies, ...dependencies };
  const listeners = new Set<() => void>();
  let currentStation: StationSettings | undefined;
  let currentSettingsWitness: string | undefined;
  let revision = 0;
  let closed = false;

  const publish = (): void => {
    revision += 1;
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        console.warn("[vellum:browser] station admission listener failed");
      }
    }
  };

  let observedSettingsUpdate = false;
  const unsubscribeSettings = settings.subscribe((next) => {
    observedSettingsUpdate = true;
    const nextWitness = stationSettingsWitness(next.station);
    const changed =
      currentSettingsWitness !== undefined &&
      currentSettingsWitness !== nextWitness;
    currentStation = next.station;
    currentSettingsWitness = nextWitness;
    if (changed) publish();
  });

  const unsubscribeStatus = deps.subscribeStatus((change) => {
    if (change.kind === "pull") publish();
  });

  const unsubscribeHosts = deps.subscribeHosts((hosts, previous) => {
    if (
      hostAuthorityTuple(currentStation, hosts) !==
      hostAuthorityTuple(currentStation, previous)
    ) {
      publish();
    }
  });

  try {
    const loaded = await Effect.runPromise(settings.get);
    if (!observedSettingsUpdate) {
      currentStation = loaded.station;
      currentSettingsWitness = stationSettingsWitness(loaded.station);
    }
  } catch (error) {
    unsubscribeHosts();
    unsubscribeStatus();
    unsubscribeSettings();
    throw error;
  }

  const admit = async (): Promise<BrowserStationAdmissionResult> => {
    if (closed) return denial("station browser admission is closed");
    const startedAtRevision = revision;
    let loaded;
    try {
      loaded = await Effect.runPromise(settings.get);
    } catch {
      return denial("station settings are unavailable");
    }
    const station = loaded.station;
    if (station.role === "command-center") {
      return revision === startedAtRevision
        ? { ok: true }
        : denial("station identity changed during browser admission");
    }
    if (station.role !== "remote") {
      return denial("station role is not ready for browser work");
    }

    const host = deps.findHost(station.hostId);
    if (
      station.hostId === "local" ||
      host === undefined ||
      host.kind !== "remote" ||
      !hostHasCapability(host, "browser")
    ) {
      return denial("Remote station browser capability is not current");
    }

    let status: StationStatusDocument;
    let mirror: CanvasMirrorWitness;
    try {
      [status, mirror] = await Promise.all([
        deps.readStatus(),
        deps.readMirror(),
      ]);
    } catch {
      return denial("Remote canvas pull witness is unavailable");
    }

    const pull = status.lastPull;
    if (
      pull === undefined ||
      !pull.ok ||
      pull.keptLocal ||
      pull.failedCount !== 0 ||
      (pull.status !== "ok" && pull.status !== "empty")
    ) {
      return denial("Remote canvas pull is not a complete successful mirror");
    }
    const admission = pull.admission;
    if (
      admission === undefined ||
      admission.stationHostId !== station.hostId ||
      admission.stationConfigSha256 !== stationSettingsWitness(station) ||
      pull.commandCenterRef !== station.commandCenterRef ||
      admission.canvasMirrorSha256 !== mirror.sha256 ||
      admission.canvasCount !== mirror.canvasCount ||
      pull.pulledCount !== mirror.canvasCount ||
      (pull.status === "empty" && mirror.canvasCount !== 0) ||
      (pull.status === "ok" && mirror.canvasCount === 0)
    ) {
      return denial("Remote canvas pull does not match this station and mirror");
    }

    const now = deps.now();
    const pulledAt = Date.parse(pull.at);
    if (
      !Number.isFinite(now) ||
      !Number.isFinite(pulledAt) ||
      pulledAt > now
    ) {
      return denial("Remote canvas pull timestamp is invalid or in the future");
    }
    const remaining = STATION_PULL_STALE_AFTER_MS - (now - pulledAt);
    if (!Number.isSafeInteger(remaining) || remaining <= 0) {
      return denial("Remote canvas pull is stale");
    }
    if (revision !== startedAtRevision) {
      return denial("station admission facts changed during browser admission");
    }
    return { ok: true, maxTtlMs: remaining };
  };

  return Object.freeze({
    admit,
    subscribe: (listener: () => void) => {
      if (closed) return () => undefined;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: () => {
      if (closed) return;
      closed = true;
      revision += 1;
      unsubscribeHosts();
      unsubscribeStatus();
      unsubscribeSettings();
      listeners.clear();
    },
  });
};

export const prepareDefaultBrowserStationAdmissionAuthority =
  async (): Promise<BrowserStationAdmissionAuthority> => {
    const settings = await AppRuntime.runPromise(
      Effect.map(SettingsService, (service) => service),
    );
    return prepareBrowserStationAdmissionAuthority(settings);
  };
