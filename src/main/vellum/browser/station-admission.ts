import { Effect } from "effect";
import { hostHasCapability, type RemoteHost } from "@shared/remote-hosts";
import { AppRuntime } from "../../runtime";
import {
  findHostById,
  subscribeHostsSnapshot,
} from "../hosts/snapshot";
import {
  StationRepository,
  type StationProjection,
  type StationStatusFacts,
} from "../station/repository";

/** Remote grants revalidate durable station authority at this fixed bound. */
export const BROWSER_STATION_ADMISSION_TTL_MS = 5_000;

export type BrowserStationAdmissionResult =
  | {
      readonly ok: true;
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

export type BrowserStationAdmissionSnapshot = {
  readonly facts: StationStatusFacts;
  /** Full body read verifies the persisted projection hash before admission. */
  readonly projection?: StationProjection;
};

type BrowserStationAdmissionDependencies = {
  readonly readStation: () => Promise<BrowserStationAdmissionSnapshot>;
  readonly findHost: (hostId: string) => RemoteHost | undefined;
  readonly subscribeHosts: (
    listener: (
      hosts: ReadonlyArray<RemoteHost>,
      previous: ReadonlyArray<RemoteHost>,
    ) => void,
  ) => () => void;
};

const defaultDependencies: BrowserStationAdmissionDependencies = {
  readStation: () =>
    AppRuntime.runPromise(
      Effect.gen(function* () {
        const repository = yield* StationRepository;
        const { facts, projection } = yield* Effect.all({
          facts: repository.statusFacts,
          projection: repository.projection,
        });
        return { facts, projection };
      }),
    ),
  findHost: findHostById,
  subscribeHosts: subscribeHostsSnapshot,
};

const denial = (message: string): BrowserStationAdmissionResult => ({
  ok: false,
  message,
});

const completeProjectionMatches = (
  facts: StationStatusFacts,
  projection: StationProjection | undefined,
): boolean =>
  facts.projection !== undefined &&
  projection !== undefined &&
  projection.scope === "full" &&
  projection.generation === facts.projection.generation &&
  projection.contentSha256 === facts.projection.contentSha256 &&
  projection.receivedAt === facts.projection.receivedAt;

/**
 * Prepare owner-local browser admission. All station authority comes from the
 * canonical repository; no renderer setting, status mirror, timestamp, or
 * filesystem projection can participate.
 */
export const prepareBrowserStationAdmissionAuthority = async (
  dependencies: Partial<BrowserStationAdmissionDependencies> = {},
): Promise<BrowserStationAdmissionAuthority> => {
  const deps = { ...defaultDependencies, ...dependencies };
  const listeners = new Set<() => void>();
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

  // Host capability changes are synchronous revocation facts. Repository
  // changes are revalidated by the fixed Remote grant TTL and on every admit.
  const unsubscribeHosts = deps.subscribeHosts((hosts, previous) => {
    if (JSON.stringify(hosts) !== JSON.stringify(previous)) publish();
  });

  const admit = async (): Promise<BrowserStationAdmissionResult> => {
    if (closed) return denial("browser admission is closed");
    const startedAtRevision = revision;
    let snapshot: BrowserStationAdmissionSnapshot;
    try {
      snapshot = await deps.readStation();
    } catch {
      return denial("this machine's configuration is unavailable");
    }
    const { facts, projection } = snapshot;
    const configuration = facts.configuration;
    if (configuration === undefined) {
      return denial("this machine is not configured");
    }

    if (configuration.role === "command-center") {
      return revision === startedAtRevision
        ? { ok: true }
        : denial("machine state changed during browser admission");
    }

    const host = deps.findHost(configuration.hostId);
    if (
      configuration.hostId === "local" ||
      host === undefined ||
      host.kind !== "remote" ||
      !hostHasCapability(host, "browser")
    ) {
      return denial("Remote browser capability is not current");
    }
    if (
      facts.pairing === undefined ||
      facts.pairing.commandCenterInstallationId !==
        configuration.commandCenterInstallationId
    ) {
      return denial("Remote pairing does not match its configuration");
    }
    if (!completeProjectionMatches(facts, projection)) {
      return denial("Remote projection is absent or inconsistent");
    }
    if (revision !== startedAtRevision) {
      return denial("machine state changed during browser admission");
    }
    return { ok: true, maxTtlMs: BROWSER_STATION_ADMISSION_TTL_MS };
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
      listeners.clear();
    },
  });
};

export const prepareDefaultBrowserStationAdmissionAuthority =
  (): Promise<BrowserStationAdmissionAuthority> =>
    prepareBrowserStationAdmissionAuthority();
