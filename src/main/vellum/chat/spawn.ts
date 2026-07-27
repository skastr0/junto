import { homedir } from "node:os";
import {
  parseAgentKey,
  type HermesHostId,
  type HermesProfileName,
} from "../hermes/domain";

// Product intent only. Executable, transport, connection isolation, liveness,
// and SSH policy are rendered by the scoped Hermes transport layer.
export interface AcpSpawnTarget {
  readonly host: HermesHostId;
  readonly profile: HermesProfileName;
}

export const buildAcpSpawnTarget = (agentKey: string): AcpSpawnTarget | undefined => {
  const parsed = parseAgentKey(agentKey);
  if (!parsed) return undefined;
  return parsed;
};

// session/new (and session/load) take a `cwd`. Locally that's the real user
// home dir (proven live). Over ssh there is no second round-trip needed to
// learn the remote home path: a non-interactive ssh command starts in the
// target user's $HOME by default, so "." already resolves there.
export const resolveSessionCwd = (isLocal: boolean): string =>
  isLocal ? homedir() : ".";
