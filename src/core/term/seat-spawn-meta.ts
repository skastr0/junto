/**
 * What a terminal's spawn carries beside its argv and environment: the seat
 * record the PTY belongs to, and the generation credential the running seat
 * presents to the work socket.
 *
 * A PTY lives in the terminal process, which outlives a core that crashes
 * (`terminal-process/protocol.ts`). The next core adopts every PTY it finds,
 * and this is the record it rebuilds one from: who the terminal was for, which
 * generation it is, how it was sized, and which credential the seat already
 * holds. Nothing here is read back into a seat: it is opaque `pty.spawn` meta,
 * stored by the terminal process and handed back by `pty.adopt`.
 *
 * The credential is here because a seat proves itself with the value in its
 * environment, which cannot be replaced while the process runs. The terminal
 * process already holds the spawn environment that carries it; the meta adds
 * no disclosure that process did not have.
 */
import { Schema } from "effect";

export const SEAT_SPAWN_META_VERSION = 1;

const RegionEnvironmentRecord = Schema.Struct({
  fingerprint: Schema.String,
  names: Schema.Record(Schema.String, Schema.String),
  folders: Schema.Array(Schema.String),
});

export const SeatSpawnMeta = Schema.Struct({
  version: Schema.Literal(SEAT_SPAWN_META_VERSION),
  /** `agent` is an actor seat (a harness, a mailbox); `terminal` is geography. */
  kind: Schema.Literals(["agent", "terminal"]),
  bindingId: Schema.String,
  epoch: Schema.String,
  hostId: Schema.String,
  canvasName: Schema.optionalKey(Schema.String),
  nodeId: Schema.optionalKey(Schema.String),
  agentKey: Schema.optionalKey(Schema.String),
  harness: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  /** The spawned argv's basename, until an OSC title replaces it. */
  processName: Schema.optionalKey(Schema.String),
  cwd: Schema.String,
  cols: Schema.Number,
  rows: Schema.Number,
  createdAt: Schema.Number,
  shellEnvironmentGeneration: Schema.Number,
  resumeAttempt: Schema.optionalKey(Schema.Boolean),
  /** The zone the spawned process runs in, for the seat-state clock. */
  timeZone: Schema.optionalKey(Schema.String),
  regionEnvironment: RegionEnvironmentRecord,
  /** The generation credential in the seat's environment; agents only. */
  credential: Schema.optionalKey(
    Schema.Struct({ credential: Schema.String, generationId: Schema.String }),
  ),
});

export type SeatSpawnMeta = typeof SeatSpawnMeta.Type;

const decode = Schema.decodeUnknownOption(SeatSpawnMeta);

/**
 * A spawn's meta, or undefined when it is not one of ours (a PTY from an older
 * build, or a value that is not this shape). Never throws: a terminal this
 * core cannot name is left running, never hung up on a guess.
 */
export const seatSpawnMetaOf = (value: unknown): SeatSpawnMeta | undefined => {
  const decoded = decode(value);
  return decoded._tag === "Some" ? decoded.value : undefined;
};
