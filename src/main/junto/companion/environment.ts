/**
 * What pairing a phone needs from this Mac, read fresh each time Settings asks:
 *
 * - Remote Login (macOS sshd) accepting connections on port 22;
 * - the SSH host key the phone pins (read from the public host key file);
 * - the hosts the phone tries, in order: Tailscale name and address when
 *   Tailscale is present, then this Mac's local name and LAN addresses;
 * - the account and the `junto` command the forced command runs.
 *
 * Every probe is bounded and read-only; a missing piece is reported, never
 * guessed. Junto opens no port of its own.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, hostname, networkInterfaces, userInfo } from "node:os";
import { join } from "node:path";

export type CompanionEnvironment = {
  readonly remoteLogin: "on" | "off";
  readonly hostKey: string | undefined;
  readonly tailscale: { readonly name?: string; readonly address?: string } | undefined;
  readonly localName: string;
  readonly lanAddresses: ReadonlyArray<string>;
  readonly hosts: ReadonlyArray<string>;
  readonly user: string;
  readonly station: string;
  readonly juntoPath: string | undefined;
};

const HOST_KEY_FILES = ["/etc/ssh/ssh_host_ed25519_key.pub", "/etc/ssh/ssh_host_ecdsa_key.pub"];
const TAILSCALE_BINARIES = [
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
  "/opt/homebrew/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/usr/bin/tailscale",
];

const run = (file: string, args: ReadonlyArray<string>, timeoutMs: number): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      resolve(error ? undefined : stdout);
    });
  });

/** sshd answers on localhost:22 within a moment, or Remote Login is off. */
export const probeRemoteLogin = (port = 22, timeoutMs = 800): Promise<"on" | "off"> =>
  new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const done = (state: "on" | "off"): void => {
      socket.destroy();
      resolve(state);
    };
    socket.setTimeout(timeoutMs, () => done("off"));
    socket.once("connect", () => done("on"));
    socket.once("error", () => done("off"));
  });

/** `type base64` of the first host key present; the comment is dropped. */
export const readHostKey = (files: ReadonlyArray<string> = HOST_KEY_FILES): string | undefined => {
  for (const file of files) {
    try {
      const [type, key] = readFileSync(file, "utf8").trim().split(/\s+/u);
      if (type && key) return `${type} ${key}`;
    } catch {
      // Next candidate.
    }
  }
  return undefined;
};

/** Parse `tailscale status --json`: this node's MagicDNS name and IPv4. */
export const parseTailscaleStatus = (json: string): { readonly name?: string; readonly address?: string } | undefined => {
  try {
    const status = JSON.parse(json) as { Self?: { DNSName?: unknown; TailscaleIPs?: unknown; Online?: unknown } };
    const self = status.Self;
    if (!self) return undefined;
    const name = typeof self.DNSName === "string" && self.DNSName !== "" ? self.DNSName.replace(/\.$/u, "") : undefined;
    const ips = Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs.filter((ip): ip is string => typeof ip === "string") : [];
    const address = ips.find((ip) => /^\d+\.\d+\.\d+\.\d+$/u.test(ip));
    if (!name && !address) return undefined;
    return { ...(name ? { name } : {}), ...(address ? { address } : {}) };
  } catch {
    return undefined;
  }
};

const probeTailscale = async (): Promise<CompanionEnvironment["tailscale"]> => {
  for (const binary of TAILSCALE_BINARIES) {
    if (!existsSync(binary)) continue;
    const out = await run(binary, ["status", "--json"], 2_000);
    if (out !== undefined) return parseTailscaleStatus(out);
  }
  return undefined;
};

const computerName = async (): Promise<string> => {
  if (process.platform === "darwin") {
    const out = (await run("/usr/sbin/scutil", ["--get", "ComputerName"], 1_000))?.trim();
    if (out) return out;
  }
  return hostname().replace(/\.local$/u, "");
};

const lanAddresses = (): ReadonlyArray<string> =>
  Object.values(networkInterfaces())
    .flatMap((entries) => entries ?? [])
    .filter((entry) => entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("100."))
    .map((entry) => entry.address);

/**
 * The `junto` command the forced command runs. An installed app links it at
 * ~/.local/bin/junto, a path that survives reinstalling or updating the app,
 * so that is preferred; otherwise the bundle's own copy (packaged) or the
 * repo's built CLI (a development run).
 */
export const resolveJuntoCommand = (options: {
  readonly packaged: boolean;
  readonly resourcesPath: string;
  readonly repoRoot: string;
  readonly home?: string;
}): string | undefined => {
  const candidates = [
    join(options.home ?? homedir(), ".local", "bin", "junto"),
    options.packaged ? join(options.resourcesPath, "bin", "junto") : join(options.repoRoot, "dist", "junto"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
};

/** Hosts in the order the phone should try them, without repeats. */
export const pairingHosts = (input: {
  readonly tailscale: CompanionEnvironment["tailscale"];
  readonly localName: string;
  readonly lanAddresses: ReadonlyArray<string>;
}): ReadonlyArray<string> =>
  [...new Set([input.tailscale?.name, input.tailscale?.address, input.localName, ...input.lanAddresses])].filter(
    (host): host is string => typeof host === "string" && host !== "",
  );

export const readCompanionEnvironment = async (options: {
  readonly packaged: boolean;
  readonly resourcesPath: string;
  readonly repoRoot: string;
}): Promise<CompanionEnvironment> => {
  const [remoteLogin, tailscale, station] = await Promise.all([probeRemoteLogin(), probeTailscale(), computerName()]);
  const short = hostname().replace(/\.local$/u, "");
  const localName = `${short}.local`;
  const lan = lanAddresses();
  return {
    remoteLogin,
    hostKey: readHostKey(),
    tailscale,
    localName,
    lanAddresses: lan,
    hosts: pairingHosts({ tailscale, localName, lanAddresses: lan }),
    user: userInfo().username,
    station,
    juntoPath: resolveJuntoCommand(options),
  };
};
