import type { Entity, SnapshotBundle } from "@shared/entities";
import { hermesKeyFor, hostHasCapability } from "@shared/remote-hosts";
import type { HermesHostId } from "../hermes/domain";
import { hostsSnapshot } from "../hosts/snapshot";
import type { CliResult } from "./exec";

// The Hermes fleet adapter: each profile on each host is one agent node.
// Hosts come from the durable remote-host registry (~/.vellum/hosts.json).
// A host that is unreachable contributes nothing rather than failing the
// whole bundle. `hermes profile list` has no --json, so its table is
// parsed; `hermes version` gives a host-level version applied to that host's
// agents.

interface HermesHost {
  readonly id: HermesHostId;
  readonly label: string; // display host
}

export interface HermesFleetOperations {
  readonly profiles: (host: HermesHostId) => Promise<CliResult>;
  readonly version: (host: HermesHostId) => Promise<CliResult>;
}

const listHermesHosts = (): ReadonlyArray<HermesHost> =>
  hostsSnapshot()
    .filter((host) => hostHasCapability(host, "hermes"))
    .map((host) => ({
      id: (host.kind === "local" ? "local" : hermesKeyFor(host)) as HermesHostId,
      label: host.label,
    }));

// "Hermes Agent v0.16.0 (2026.6.5) · upstream a72bb037" -> "v0.16.0"
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
//    profile-13          gpt-5.5      running   profile-13   —
// Header, separator, and blank lines are skipped; columns split on 2+ spaces.
export const parseProfiles = (stdout: string): ReadonlyArray<ParsedProfile> => {
  const rows: ParsedProfile[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.replace(/◆/g, "").trimEnd();
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (/─{3,}/.test(trimmed)) continue; // separator
    if (/^Profile\b/i.test(trimmed)) continue; // header
    const cols = trimmed.split(/\s{2,}/).filter((c) => c.length > 0);
    if (cols.length < 2) continue;
    const [name, model, gateway] = cols;
    if (!name) continue;
    rows.push({ name, model: model ?? "unknown", gateway: gateway ?? "unknown" });
  }
  return rows;
};

const fetchHost = async (
  operations: HermesFleetOperations,
  host: HermesHost,
): Promise<ReadonlyArray<Entity>> => {
  const listResult = await operations.profiles(host.id);
  if (!listResult.ok) return [];

  const profiles = parseProfiles(listResult.stdout);
  if (profiles.length === 0) return [];

  const verResult = await operations.version(host.id);
  const version = verResult.ok ? parseVersion(verResult.stdout) : undefined;

  const fetchedAt = new Date().toISOString();
  return profiles.map((profile): Entity => {
    const stats: Record<string, string | number> = {
      host: host.label,
      model: profile.model,
      gateway: profile.gateway,
    };
    if (version) stats.version = version;
    return {
      source: "hermes",
      key: `${host.id}:${profile.name}`,
      kind: "agent",
      title: profile.name,
      stats,
      updatedAt: fetchedAt,
    };
  });
};

export const fetchHermesBundle = async (
  operations: HermesFleetOperations,
): Promise<SnapshotBundle> => {
  const fetchedAt = new Date().toISOString();
  const hosts = listHermesHosts();
  const perHost = await Promise.all(
    hosts.map((host) =>
      fetchHost(operations, host).catch(() => [] as ReadonlyArray<Entity>),
    ),
  );
  const entities = perHost.flat();

  // Reachable if at least one host answered; if every host is silent, report
  // it as down so the UI shows a stale dot rather than a false "no agents".
  if (entities.length === 0) {
    return {
      source: "hermes",
      fetchedAt,
      ok: false,
      error: `no hermes hosts reachable (${hosts.map((h) => h.id).join(" + ") || "none configured"})`,
      entities: [],
    };
  }

  return { source: "hermes", fetchedAt, ok: true, entities };
};
