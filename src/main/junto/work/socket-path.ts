import { Schema } from "effect";
import { workControlSocketPath } from "@shared/work-control";
import { UNIX_DOMAIN_SOCKET_PATH_LIMIT } from "../ssh/control-dir";

/**
 * The work control socket lives at `<workHome>/control.sock`. Darwin's
 * `sockaddr_un.sun_path` is 104 bytes including the trailing NUL, so a path of
 * 103 bytes is the longest that binds; Linux allows 108 including the NUL.
 * Above that, `listen` fails and the core exits before it says ready.
 */
export const unixSocketPathLimit = (
  platform: NodeJS.Platform = process.platform,
): number => platform === "darwin" ? UNIX_DOMAIN_SOCKET_PATH_LIMIT : 108;

export class WorkSocketPathTooLong extends Schema.TaggedError<WorkSocketPathTooLong>()(
  "WorkSocketPathTooLong",
  {
    path: Schema.String,
    bytes: Schema.Number,
    limit: Schema.Number,
  },
) {}

export interface WorkSocketPathBudget {
  readonly path: string;
  readonly bytes: number;
  readonly limit: number;
}

export const workControlSocketPathBudget = (
  workHome: string,
  platform: NodeJS.Platform = process.platform,
): WorkSocketPathBudget => {
  const path = workControlSocketPath(workHome);
  return {
    path,
    bytes: Buffer.byteLength(path, "utf8"),
    limit: unixSocketPathLimit(platform),
  };
};

/**
 * Refuse a work socket that cannot bind, before the core forks or listens.
 * The startup dialog names the path and the limit; the operator moves
 * `JUNTO_HOME` to a shorter path and launches again.
 */
export const assertWorkControlSocketPathFits = (
  workHome: string,
  platform: NodeJS.Platform = process.platform,
): void => {
  const budget = workControlSocketPathBudget(workHome, platform);
  if (budget.bytes >= budget.limit) throw new WorkSocketPathTooLong(budget);
};
