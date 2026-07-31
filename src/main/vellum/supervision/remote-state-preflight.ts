/**
 * Displayless Node Remote sealed state preflight.
 *
 * Opens the fixed canonical state path read-only only long enough to read
 * PRAGMA user_version when present. Never migrates, never starts a runtime
 * plane, never accepts a database-path redirect.
 */
import {
  evaluateSchemaCompatibility,
  probeInstalledStateSchema,
} from "../state/schema-version-probe";
import { CURRENT_STATE_SCHEMA_VERSION } from "../state/migrations";
import { resolveCandidateRuntimeRootFromRemoteBinary } from "./install-user-service";

export const REMOTE_STATE_PREFLIGHT_SWITCH = "--vellum-state-preflight" as const;

export const REMOTE_STATE_PREFLIGHT_PROTOCOL =
  "vellum-remote-state-preflight/v1" as const;

export type RemoteStatePreflightReceipt = {
  readonly protocol: typeof REMOTE_STATE_PREFLIGHT_PROTOCOL;
  readonly candidateRoot: string;
  readonly source: "fresh" | "installed";
  readonly sourceSchemaVersion: number | null;
  readonly supportedSchemaVersion: number;
  readonly ready: true;
};

/**
 * Prove this binary sits under an owner-local candidate tree (staging extract
 * or installed generation) and that installed state (if any) is not newer than
 * this binary can admit. Starts no runtime plane.
 */
export const runRemoteStatePreflight = (
  binaryPath: string = process.execPath,
): RemoteStatePreflightReceipt => {
  const candidateRoot = resolveCandidateRuntimeRootFromRemoteBinary(binaryPath);
  const probe = probeInstalledStateSchema();
  if (probe.kind === "unreadable") {
    throw new Error(`state preflight cannot read installed database: ${probe.message}`);
  }
  const compatibility = evaluateSchemaCompatibility(probe);
  if (!compatibility.ok) {
    throw new Error(
      `installed state schema ${compatibility.userVersion} is newer than supported ${compatibility.supportedVersion}`,
    );
  }
  if (probe.kind === "missing") {
    return Object.freeze({
      protocol: REMOTE_STATE_PREFLIGHT_PROTOCOL,
      candidateRoot,
      source: "fresh",
      sourceSchemaVersion: null,
      supportedSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
      ready: true as const,
    });
  }
  return Object.freeze({
    protocol: REMOTE_STATE_PREFLIGHT_PROTOCOL,
    candidateRoot,
    source: "installed",
    sourceSchemaVersion: probe.userVersion,
    supportedSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
    ready: true as const,
  });
};
