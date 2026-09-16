import type { Entity, SnapshotBundle } from "@shared/entities";
import { throwIfAborted } from "../access-signal";
import { hermesKeyFor, hostHasCapability } from "@shared/remote-hosts";
import {
  canonicalLocalAgentKey,
  parseHermesProfileName,
  type HermesHostId,
  type HermesStationIdentity,
} from "../hermes/domain";
import { hostsSnapshot } from "../hosts/snapshot";
import type { CliResult } from "./exec";

// The Hermes fleet adapter: each profile on each host is one agent node.
// Hosts come from the durable app-owned StateEngine registry.
// A failed host makes the bundle partial/unhealthy while successful host facts
// remain present for freshness-aware consumers. `hermes profile list` has no
// --json, so its table is parsed; `hermes version` gives a host-level version
// applied to that host's agents.

interface HermesHost {
  /** Host accepted by the local/SSH adapter operation. */
  readonly transportId: HermesHostId;
  /** Prefix persisted in the agent entity key. */
  readonly agentHostId: HermesHostId;
  /** Physical RemoteHost.id persisted separately from display label. */
  readonly hostId: string;
  readonly label: string; // display host
}

export interface HermesFleetOperations {
  readonly profiles: (host: HermesHostId, signal?: AbortSignal) => Promise<CliResult>;
  readonly version: (host: HermesHostId, signal?: AbortSignal) => Promise<CliResult>;
}

const listHermesHosts = (
  station: HermesStationIdentity,
): ReadonlyArray<HermesHost> =>
  hostsSnapshot()
    .filter((host) => hostHasCapability(host, "hermes"))
    .map((host) => ({
      transportId: (host.kind === "local" ? "local" : hermesKeyFor(host)) as HermesHostId,
      agentHostId: (host.kind === "local"
        ? station.agentHostId
        : hermesKeyFor(host)) as HermesHostId,
      hostId: host.kind === "local" ? station.hostId : host.id,
      label: host.label,
    }));

// "Hermes Agent v0.16.0 (2026.6.5) - upstream a72bb037" -> "v0.16.0"
export const parseVersion = (stdout: string): string | undefined => {
  const match = stdout.match(/v\d+\.\d+\.\d+/);
  return match?.[0];
};

interface ParsedProfile {
  readonly name: string;
  readonly model: string;
  readonly gateway: string;
}

// Parse the `hermes profile list` table. Rows look like:
//   ◆default         gpt-5.5      running   —   —
//    profile-13      gpt-5.5      running   profile-13   —
// Header, separator, and blank lines are skipped; columns split on 2+ spaces.
export const parseProfiles = (stdout: string): ReadonlyArray<ParsedProfile> => {
  const rows: ParsedProfile[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/◆/g, "").trimEnd();
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/─{3,}/.test(trimmed)) continue; // separator
    if (/^Profile(?:\s|$)/i.test(trimmed)) continue; // header
    const cols = trimmed.split(/\s{2,}/).filter((c) => c.length > 0);
    if (cols.length < 2) continue;
    const [name, model, gateway] = cols;
    if (!name) continue;
    rows.push({ name, model: model ?? "unknown", gateway: gateway ?? "unknown" });
  }
  return rows;
};

interface HermesHostFetch {
  readonly reachable: boolean;
  readonly host: HermesHost;
  readonly entities: ReadonlyArray<Entity>;
}

const fetchHost = async (
  operations: HermesFleetOperations,
  host: HermesHost,
  signal?: AbortSignal,
): Promise<HermesHostFetch> => {
  const listResult = await operations.profiles(host.transportId, signal);
  if (!listResult.ok) return { reachable: false, host, entities: [] };

  const profiles = parseProfiles(listResult.stdout);
  if (profiles.length === 0) return { reachable: true, host, entities: [] };

  throwIfAborted(signal);
  const verResult = await operations.version(host.transportId, signal);
  const version = verResult.ok ? parseVersion(verResult.stdout) : undefined;

  const fetchedAt = new Date().toISOString();
  const entities = profiles.flatMap((profile): ReadonlyArray<Entity> => {
    const profileName = parseHermesProfileName(profile.name);
    if (profileName === undefined) return [];
    const stats: Record<string, string | number> = {
      host: host.label,
      hostId: host.hostId,
      model: profile.model,
      gateway: profile.gateway,
      running: profile.gateway === "running" ? 1 : 0,
    };
    if (version) stats.version = version;
    return [{
      source: "hermes",
      key:
        host.transportId === "local"
          ? canonicalLocalAgentKey(
              { hostId: host.hostId, agentHostId: host.agentHostId },
              profileName,
            )
          : `${host.agentHostId}:${profileName}`,
      kind: "agent",
      title: profile.name,
      stats,
      updatedAt: fetchedAt,
    }];
  });
  return { reachable: true, host, entities };
};

export const fetchHermesBundle = async (
  operations: HermesFleetOperations,
  station: HermesStationIdentity,
  signal?: AbortSignal,
): Promise<SnapshotBundle> => {
  const fetchedAt = new Date().toISOString();
  const hosts = listHermesHosts(station);
  const perHost = await Promise.all(
    hosts.map((host) =>
      fetchHost(operations, host, signal).catch((error: unknown): HermesHostFetch => {
        if (signal?.aborted) throw error;
        return { reachable: false, host, entities: [] };
      }),
    ),
  );
  const entities = perHost.flatMap((result) => result.entities);
  const failed = perHost
    .filter((result) => !result.reachable)
    .map((result) => result.host.agentHostId);

  if (failed.length > 0) {
    return {
      source: "hermes",
      fetchedAt,
      ok: false,
      error: `hermes host refresh failed (${failed.join(" + ")})`,
      entities,
    };
  }

  return { source: "hermes", fetchedAt, ok: true, entities };
};
