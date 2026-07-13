import { homedir } from "node:os";
import { parseAgentKey, type HermesHostId } from "../adapters/hermes-identity";

// Builds the argv to spawn `hermes acp` for one agent node. Agent keys are
// "<host>:<profile>" (host in {local, remote-a}) — the exact shape already
// proven live by adapters/hermes-identity.ts, which this module reuses for
// parsing rather than re-implementing the charset check. That reuse is what
// satisfies "validate profile charset before splicing into the ssh command":
// parseAgentKey already rejects anything outside [A-Za-z0-9_-]+.
//
// PROVEN WIRE FACTS (live spike against hermes 0.16.0):
//   local default profile -> `hermes acp`
//   local named profile   -> `hermes -p <name> acp`
//   remote (remote-a)     -> `ssh -o ConnectTimeout=6 -o BatchMode=yes
//                             -o ServerAliveInterval=15 -o ServerAliveCountMax=3
//                             remote-a hermes -p <name> acp`
//
// ServerAliveInterval/ServerAliveCountMax are set explicitly here (rather
// than relying on the operator's own ~/.ssh/config) so a session over a
// silently-dead network path (lid close, WiFi roam, NAT/tailnet relay drop
// with no FIN/RST) surfaces as an ssh exit within ~45s on every deployment,
// not just this machine's personal dotfile.
const SSH_OPTS = [
  "-o",
  "ConnectTimeout=6",
  "-o",
  "BatchMode=yes",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=3",
] as const;
const MAC_MINI = "remote-a";

export interface AcpSpawnTarget {
  readonly command: string;
  readonly argv: ReadonlyArray<string>;
  readonly host: HermesHostId;
  readonly profile: string;
}

const isDefaultProfile = (profile: string): boolean => profile === "default";

export const buildAcpSpawnTarget = (agentKey: string): AcpSpawnTarget | undefined => {
  const parsed = parseAgentKey(agentKey);
  if (!parsed) return undefined;
  const { host, profile } = parsed;
  const isDefault = isDefaultProfile(profile);

  if (host === "local") {
    return {
      command: "hermes",
      argv: isDefault ? ["acp"] : ["-p", profile, "acp"],
      host,
      profile,
    };
  }

  return {
    command: "ssh",
    argv: isDefault
      ? [...SSH_OPTS, MAC_MINI, "hermes", "acp"]
      : [...SSH_OPTS, MAC_MINI, "hermes", "-p", profile, "acp"],
    host,
    profile,
  };
};

// session/new (and session/load) take a `cwd`. Locally that's the real user
// home dir (proven live). Over ssh there is no second round-trip needed to
// learn the remote home path: a non-interactive ssh command starts in the
// target user's $HOME by default, so "." already resolves there.
export const resolveSessionCwd = (host: HermesHostId): string => (host === "local" ? homedir() : ".");
