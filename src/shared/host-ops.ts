/**
 * Host-ops receipts. One program per verb. Darwin and Linux fill the same shape.
 * Unknown is not down. A missing transcript is a failed program.
 */
import { Schema } from "effect";

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
  observedAt: Schema.String,
});
export type HostOpsInspect = typeof HostOpsInspect.Type;