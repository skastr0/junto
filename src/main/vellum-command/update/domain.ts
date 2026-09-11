import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Effect } from "effect";
import { updateError, type UpdateError } from "./errors";
import type { StagedUpdate } from "./provider";

/**
 * Exact downloaded candidate that alone may authorize install.
 *
 * A structurally similar object never authorizes: only this module mints
 * membership via the sealed WeakSet after hash + staged-app admit.
 */
export type AuthorizedUpdateCandidate = {
  readonly version: string;
  readonly downloadedFile: string;
  readonly archiveSha256: string;
  readonly stagedAppPath?: string;
  readonly installation?: StagedUpdate;
  readonly authorizedAt: string;
};

const authorizedCandidates = new WeakSet<object>();

export const mintAuthorizedCandidate = (
  input: {
    readonly version: string;
    readonly downloadedFile: string;
    readonly archiveSha256: string;
    readonly stagedAppPath?: string;
    readonly installation?: StagedUpdate;
  },
): AuthorizedUpdateCandidate => {
  const candidate: AuthorizedUpdateCandidate = {
    version: input.version,
    downloadedFile: input.downloadedFile,
    archiveSha256: input.archiveSha256,
    ...(input.stagedAppPath === undefined
      ? {}
      : { stagedAppPath: input.stagedAppPath }),
    ...(input.installation === undefined ? {} : { installation: input.installation }),
    authorizedAt: new Date().toISOString(),
  };
  authorizedCandidates.add(candidate);
  return Object.freeze(candidate);
};

export const isMintedCandidate = (
  candidate: AuthorizedUpdateCandidate | undefined,
): candidate is AuthorizedUpdateCandidate =>
  candidate !== undefined && authorizedCandidates.has(candidate);

/**
 * Operator may Restart: minted candidate with a staged admitted app path.
 * Surfaces as UpdateStatus.canInstall in the ready phase.
 */
export const canOperatorInstall = (
  candidate: AuthorizedUpdateCandidate | undefined,
): boolean =>
  isMintedCandidate(candidate) &&
  candidate.stagedAppPath !== undefined &&
  candidate.stagedAppPath.length > 0;

/**
 * Install finalize is permitted only for the exact minted candidate with a
 * staged admitted app path. Schema+data migration runs on normal app open.
 */
export const canAuthorizeInstall = (
  candidate: AuthorizedUpdateCandidate | undefined,
): boolean => canOperatorInstall(candidate);

/** Node adapter I/O; the coordinator maps this into its existing Effect runtime. */
export const readUpdateArchiveDigest = async (path: string): Promise<string> => {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("update archive must be a regular file");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytes += chunk.length;
      if (bytes > before.size) throw new Error("update archive changed while being hashed");
      hash.update(chunk);
    }
    const after = await handle.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("update archive changed while being hashed");
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
};

export const hashFileSha256 = (path: string): Effect.Effect<string, UpdateError> =>
  Effect.tryPromise({
    try: () => readUpdateArchiveDigest(path),
    catch: (cause) => updateError("readiness-failed",
      cause instanceof Error ? `failed to hash update archive: ${cause.message}` : "failed to hash update archive", cause),
  });

/**
 * Remote auto-rollout may only target the Command Center's currently
 * running version. Fleet walk is partial; this helper is the invariant.
 */
export const remoteRolloutTargetVersion = (
  commandCenterVersion: string,
): string => commandCenterVersion;

export const admitsRemoteAutoRollout = (input: {
  readonly commandCenterVersion: string;
  readonly targetVersion: string;
}): boolean =>
  input.targetVersion.length > 0 &&
  input.targetVersion === input.commandCenterVersion;
