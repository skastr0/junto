import { Schema } from "effect";
import { MachineInstallEvent } from "./machine-install";
import { RequestId } from "./operator-control";
import { MAX_MACHINE_ARCHIVE_BYTES } from "./machine-release";

export const MACHINE_COPY_STALL_MS = 30_000;
const Bytes = Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: 0, maximum: 512 * 1024 * 1024 })));
/** Bytes accepted by the SSH input sink, never proof of remote activation. */
export const MachineCopyProgress = Schema.Struct({
  event: Schema.Literal("machine-copy"),
  copiedBytes: Bytes,
  totalBytes: Bytes.pipe(Schema.check(Schema.isGreaterThan(0))),
  state: Schema.Literals(["copying", "stalled", "copied"]),
}).pipe(Schema.check(Schema.makeFilter(value => value.copiedBytes <= value.totalBytes &&
  (value.state === "copied" ? value.copiedBytes === value.totalBytes : value.copiedBytes < value.totalBytes))));
export type MachineCopyProgress = typeof MachineCopyProgress.Type;
const DownloadBytes = Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: 0, maximum: MAX_MACHINE_ARCHIVE_BYTES })));
/** Received archive bytes. Completion means this release's bundle also passed admission. */
export const MachineDownloadProgress = Schema.Struct({
  event: Schema.Literal("machine-download"),
  downloadedBytes: DownloadBytes,
  totalBytes: DownloadBytes.pipe(Schema.check(Schema.isGreaterThan(0))),
  state: Schema.Literals(["downloading", "stalled", "downloaded"]),
}).pipe(Schema.check(Schema.makeFilter(value => value.downloadedBytes <= value.totalBytes &&
  (value.state !== "downloaded" || value.downloadedBytes === value.totalBytes))));
export type MachineDownloadProgress = typeof MachineDownloadProgress.Type;
export const MachineSendEvent = Schema.Union([MachineInstallEvent, MachineCopyProgress, MachineDownloadProgress]);
export type MachineSendEvent = typeof MachineSendEvent.Type;

/**
 * A step of a machine send or update in flight, as main tells the window.
 * `id` is the id of the owner command the step belongs to, so two machines
 * can be sent to at once and each step lands on its own row.
 */
export const MachineCommandProgress = Schema.Struct({
  id: RequestId,
  event: MachineSendEvent,
});
export type MachineCommandProgress = typeof MachineCommandProgress.Type;

/** The window decodes a step before it reads it; anything else is dropped. */
export const decodeMachineCommandProgress = Schema.decodeUnknownResult(
  MachineCommandProgress,
  { onExcessProperty: "error" },
);
