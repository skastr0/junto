import { Effect, Schema } from "effect";
import type { InstallationId } from "@shared/installation-id";
import {
  failureDetailNamesSeat,
  failureDetailSeat,
  isLogAnnotationId,
  LOG_ID_ANNOTATIONS,
  MachineLogRead,
  type MachineLogQuery,
  type MachineLogRow,
} from "@shared/machine-log";
import { ModelRecords } from "../model/records";
import { decodeEncodedFailure } from "../failure-encode";
import { knownSecretValues, scrubMessage } from "../credentials/scrub";
import { readMachineLog } from "./log-file";
import { logMachine } from "./logger";

/**
 * A linked machine's log, read by the owner over the link's status channel
 * (docs/security-doctrine.md, Logs). The machine that holds the log answers
 * only rows for canvases the asking machine holds, and rows that name no
 * canvas and no seat. The answer fits one link frame. The asking machine
 * decodes it closed and scrubs every text again before it shows it.
 */

export class MachineLogsNotSetUp extends Schema.TaggedError<MachineLogsNotSetUp>()("MachineLogsNotSetUp", {
  machine: Schema.String,
  message: Schema.String,
}) {}

export type LogPeer = {
  readonly machineName: string;
  readonly installationId: InstallationId | string;
};

/**
 * Which rows a peer may read: canvases it edits or holds a seat on, and the
 * seats on those canvases. A row that names no canvas is shown only when it
 * names no seat either, or a seat on a canvas the peer holds.
 */
export const peerLogScope = Effect.fn("peerLogScope")(function* (peer: LogPeer) {
  const records = yield* ModelRecords;
  const canvases = new Set<string>();
  const seats = new Set<string>();
  for (const canvas of yield* records.listCanvases()) {
    const editor = yield* records.canvasEditor(canvas);
    const nodes = yield* records.listNodes(canvas);
    const placed = nodes.filter((node) => node.kind === "agent" || node.kind === "peer");
    const holds = editor === peer.installationId || placed.some((node) => node.host === peer.machineName);
    if (!holds) continue;
    canvases.add(canvas);
    for (const node of placed) seats.add(node.id);
  }
  return (row: MachineLogRow): boolean => {
    const fromDetail = failureDetailSeat(row.failure);
    if (fromDetail === undefined && failureDetailNamesSeat(row.failure)) return false;
    if (row.canvas !== undefined) return canvases.has(row.canvas) && (fromDetail === undefined || seats.has(fromDetail));
    return [row.seat, fromDetail].every((seat) => seat === undefined || seats.has(seat));
  };
});

/** The answer this machine gives a peer that asked for its log. */
export const answerPeerLogRead = Effect.fn("answerPeerLogRead")(function* (
  home: string,
  peer: LogPeer,
  query: MachineLogQuery,
) {
  const scope = yield* peerLogScope(peer);
  return yield* readMachineLog(home, logMachine(), query, scope);
});

/** `answerPeerLogRead` with this machine's model records already provided, for a link handler. */
export const makePeerLogAnswer = Effect.fn("makePeerLogAnswer")(function* (home: string) {
  const records = yield* ModelRecords;
  return (peer: LogPeer, query: MachineLogQuery) =>
    answerPeerLogRead(home, peer, query).pipe(Effect.provideService(ModelRecords, records));
});

const decodeRead = Schema.decodeUnknownEffect(MachineLogRead, { onExcessProperty: "error" });

/**
 * A read another machine sent: decoded with the closed, bounded schema, then
 * every message, annotation, span and failure scrubbed again on this side.
 * The machine is the name this side pinned, not the one the peer claims.
 */
export const receivePeerLogRead = Effect.fn("receivePeerLogRead")(function* (input: unknown, machine: string) {
  const read = yield* decodeRead(input);
  const known = knownSecretValues();
  const rows = read.rows.map((row): MachineLogRow => ({
    ...row,
    message: scrubMessage(row.message),
    ...(row.failure === undefined ? {} : { failure: decodeEncodedFailure(row.failure) }),
    ...(row.spans === undefined ? {} : { spans: row.spans.map((span) => scrubMessage(span).slice(0, 128)).filter((span) => span.length > 0) }),
    ...(row.annotations === undefined
      ? {}
      : { annotations: Object.fromEntries(Object.entries(row.annotations).flatMap(([key, value]) => LOG_ID_ANNOTATIONS.has(key)
        ? (isLogAnnotationId(value) && !known.includes(value) ? [[key, value]] : [])
        : [[key, scrubMessage(value, known).slice(0, 256)]])) }),
  }));
  return { ...read, machine, rows };
});
