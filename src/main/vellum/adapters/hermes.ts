import type { Entity, SnapshotBundle } from "@shared/entities";
import { runCli } from "./exec";

// The Hermes fleet adapter: each profile on each host is one agent node.
// Hosts are enumerated locally (no ssh) and on the remote-a (over the tailnet
// via ssh). A host that is unreachable contributes nothing rather than failing
// the whole bundle. `hermes profile list` has no --json, so its table is
// parsed; `hermes version` gives a host-level version applied to that host's
// agents.

interface HermesHost {
  readonly id: string; // stable key prefix, e.g. "local" | "remote-a"
  readonly label: string; // display host
  // Argv to run a hermes subcommand on this host (ssh-wrapped for remotes).
  readonly run: (args: ReadonlyArray<string>) => { command: string; argv: string[] };
}

const HOSTS: ReadonlyArray<HermesHost> = [
  {
    id: "local",
    label: "dev-laptop",
    run: (args) => ({ command: "hermes", argv: [...args] }),
  },
  {
    id: "remote-a",
    label: "remote-a",
    run: (args) => ({
      command: "ssh",
      argv: ["-o", "ConnectTimeout=6", "-o", "BatchMode=yes", "remote-a", "hermes", ...args],
    }),
  },
];

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

const fetchHost = async (host: HermesHost): Promise<ReadonlyArray<Entity>> => {
  const list = host.run(["profile", "list"]);
  const listResult = await runCli(list.command, list.argv, 12_000);
  if (!listResult.ok) return [];

  const profiles = parseProfiles(listResult.stdout);
  if (profiles.length === 0) return [];

  const ver = host.run(["version"]);
  const verResult = await runCli(ver.command, ver.argv, 12_000);
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

export const fetchHermesBundle = async (): Promise<SnapshotBundle> => {
  const fetchedAt = new Date().toISOString();
  const perHost = await Promise.all(
    HOSTS.map((host) =>
      fetchHost(host).catch(() => [] as ReadonlyArray<Entity>),
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
      error: "no hermes hosts reachable (local + remote-a)",
      entities: [],
    };
  }

  return { source: "hermes", fetchedAt, ok: true, entities };
};
