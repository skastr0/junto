/**
 * Host-ops receipts. One program per verb. Darwin and Linux fill the same shape.
 * Unknown is not down. A missing transcript is a failed program.
 */
import { Schema } from "effect";
import { HostProcess, HostWorkAttach } from "./host-runtime";

export const HostOpsPresence = Schema.Literals(["absent", "present", "unknown"]);
export type HostOpsPresence = typeof HostOpsPresence.Type;

export const HostOpsInspect = Schema.Struct({
  endpoint: Schema.String,
  platform: Schema.Literals(["darwin", "linux", "unknown"]),
  network: Schema.Literals(["up", "down"]),
  home: Schema.optionalKey(Schema.String),
  package: HostOpsPresence,
  deployLock: HostOpsPresence,
  incoming: HostOpsPresence,
  termSocket: HostOpsPresence,
  process: HostProcess,
  workAttach: HostWorkAttach,
  observedAt: Schema.String,
});
export type HostOpsInspect = typeof HostOpsInspect.Type;

export const HostOpsCopy = Schema.Struct({
  ok: Schema.Boolean,
  exit: Schema.NullOr(Schema.Number),
  stdout: Schema.String,
  stderr: Schema.String,
  tag: Schema.optionalKey(Schema.String),
  localApp: Schema.optionalKey(Schema.String),
  expectedPackage: HostOpsPresence,
  after: Schema.Struct({
    package: HostOpsPresence,
    deployLock: HostOpsPresence,
    incoming: HostOpsPresence,
    termSocket: HostOpsPresence,
  }),
  elapsedMs: Schema.Number,
  observedAt: Schema.String,
});
export type HostOpsCopy = typeof HostOpsCopy.Type;

export const HostOpsCleanup = Schema.Struct({
  ok: Schema.Boolean,
  removed: Schema.Array(Schema.String),
  stderr: Schema.String,
  observedAt: Schema.String,
});
export type HostOpsCleanup = typeof HostOpsCleanup.Type;

export const HostOpsConfigure = Schema.Struct({
  ok: Schema.Boolean,
  detail: Schema.String,
  stationInstallationId: Schema.optionalKey(Schema.String),
  configuredAt: Schema.optionalKey(Schema.String),
  code: Schema.optionalKey(
    Schema.Literals(["io", "validation", "not_found", "conflict"]),
  ),
  observedAt: Schema.String,
});
export type HostOpsConfigure = typeof HostOpsConfigure.Type;

export const HostOpsActivate = Schema.Struct({
  ok: Schema.Boolean,
  detail: Schema.String,
  stages: Schema.Array(Schema.String),
  disposition: Schema.optionalKey(
    Schema.Literals([
      "not-started",
      "configuration-required",
      "ready",
      "indeterminate",
    ]),
  ),
  code: Schema.optionalKey(
    Schema.Literals([
      "io",
      "validation",
      "not_found",
      "conflict",
      "auth_required",
    ]),
  ),
  observedAt: Schema.String,
});
export type HostOpsActivate = typeof HostOpsActivate.Type;

export const HostOpsAttach = Schema.Struct({
  ok: Schema.Boolean,
  workAttach: HostWorkAttach,
  detail: Schema.String,
  observedAt: Schema.String,
});
export type HostOpsAttach = typeof HostOpsAttach.Type;