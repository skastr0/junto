/**
 * Files the operator attached to mail for a seat on another machine.
 *
 * The mail crosses as rows and names its files by ref; the bytes stay in this
 * machine's content store. Delivery on the seat's machine reads each file from
 * its own store, so before the mail can be typed there every file is pushed to
 * that machine over SSH (`statMachineContent`, `receiveMachineContent`): asked
 * first what it holds, then sent in pieces from there, so an interrupted push
 * resumes and one already there costs a single question.
 *
 * Every time delivery routes such a mail to its machine the files are offered
 * again, so a push that failed is tried once more when the link comes back; in
 * between, a failed push is retried on its own, a little later each time.
 *
 * One push at a time per machine, so never two for the same object: the far
 * partial is keyed by sha256 alone (remote-security).
 */

import { Effect, Schema } from "effect";
import type { ContentRef } from "@shared/wire/content-ref";
import { boatRoute } from "../boat/machines";
import { HostsService } from "../hosts/service";
import { parseHostSshRoute, SshTransport } from "../ssh";
import { receiveMachineContent, statMachineContent } from "../ssh/machine-commands";
import { CONTENT_HELPER_STATUS_MAX_BYTES } from "./helper-contract";
import { ContentService } from "./service";
import { readContentObjectRange } from "./store";

/** One piece of a push: well inside the SSH stdin bound (16 MiB) and its 20 s budget. */
export const MACHINE_FILE_PIECE_BYTES = 4 * 1024 * 1024;

/** How long a failed push waits before it is tried again, then the last of these from then on. */
const RETRY_AFTER_MS = [15_000, 60_000, 5 * 60_000, 15 * 60_000] as const;

class MachineFileError extends Schema.TaggedError<MachineFileError>()("MachineFileError", {
  message: Schema.String,
}) {}

/**
 * What `content-transfer` answers on stdout, closed: any other key is refused.
 * A refusal's `error` can name a path on the far machine, so it is decoded
 * only to be dropped; nothing from the answer reaches a log or a row.
 */
const Ident = { sha256: Schema.String, byteLength: Schema.Number };
const Answer = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), state: Schema.Literal("verified"), ...Ident, verifiedAt: Schema.String, created: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({ ok: Schema.Literal(true), state: Schema.Literal("partial"), ...Ident, receivedBytes: Schema.Number }),
  Schema.Struct({ ok: Schema.Literal(true), state: Schema.Literal("missing"), ...Ident, reason: Schema.String }),
  Schema.Struct({
    ok: Schema.Literal(true),
    state: Schema.Literal("corrupt"),
    ...Ident,
    reason: Schema.String,
    observedSha256: Schema.optionalKey(Schema.String),
    observedByteLength: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
]);
const unreadable = () => new MachineFileError({ message: "the machine's answer could not be read" });
/** One status line, about the object asked for, or the push fails with fixed words. */
const decodeAnswer = (stdout: string, ref: ContentRef) =>
  Effect.gen(function* () {
    const line = stdout.trim();
    if (line.length === 0 || line.length > CONTENT_HELPER_STATUS_MAX_BYTES) return yield* unreadable();
    const answer = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Answer))(line, { onExcessProperty: "error" }).pipe(
      Effect.mapError(unreadable),
    );
    if (answer.ok && (answer.sha256 !== ref.sha256 || answer.byteLength !== ref.byteLength)) return yield* unreadable();
    return answer;
  });

/** Put one object on a machine, from what it already holds. */
export const pushFileToMachine = (machine: string, ref: ContentRef) =>
  Effect.gen(function* () {
    const host = yield* (yield* HostsService).get(machine);
    if (host === undefined || host.isThisMachine || host.juntoHome === undefined || host.installRoot === undefined) {
      return yield* new MachineFileError({ message: `${machine} has no route a file can take` });
    }
    const ssh = yield* SshTransport;
    const content = yield* ContentService;
    // A Boat machine's address changes as it sleeps and wakes: found now, as the link finds it.
    const target = yield* parseHostSshRoute(yield* Effect.promise(() => boatRoute(host)));
    const location = { juntoHome: host.juntoHome, installRoot: host.installRoot };
    const held = yield* decodeAnswer((yield* ssh.run(yield* statMachineContent(target, location, ref))).stdout, ref);
    if (held.ok && held.state === "verified") return;
    let offset = held.ok && held.state === "partial" ? held.receivedBytes : 0;
    while (offset < ref.byteLength) {
      const length = Math.min(MACHINE_FILE_PIECE_BYTES, ref.byteLength - offset);
      const bytes = readContentObjectRange(content.root, ref, offset, length);
      if (bytes === undefined) return yield* new MachineFileError({ message: "the file is not in this machine's store" });
      const sent = yield* decodeAnswer((yield* ssh.run(yield* receiveMachineContent(target, location, ref, { offset, bytes }))).stdout, ref);
      if (!sent.ok) return yield* new MachineFileError({ message: "the machine did not take the file" });
      offset += length;
    }
  }).pipe(
    // Fixed words and the machine's name only: SSH errors are scrubbed by the transport, and the
    // helper's own answer never leaves decodeAnswer.
    Effect.tapError(() =>
      Effect.logWarning("a file could not reach its seat's machine; it is tried again").pipe(
        Effect.annotateLogs({ area: "machine-files", machine }),
      ),
    ),
  );

type Pending = { readonly machine: string; readonly ref: ContentRef; attempts: number; timer?: ReturnType<typeof setTimeout> };

/**
 * The pushes in flight, one machine at a time per machine, each file once
 * however many mails name it. `run` runs a push in the core's context.
 */
export const makeMachineFiles = (run: (machine: string, ref: ContentRef) => Promise<void>) => {
  const pending = new Map<string, Pending>();
  const draining = new Set<string>();
  let stopped = false;

  const drain = async (machine: string): Promise<void> => {
    if (draining.has(machine) || stopped) return;
    draining.add(machine);
    try {
      for (;;) {
        const next = [...pending.entries()].find(([, item]) => item.machine === machine && item.timer === undefined);
        if (next === undefined || stopped) return;
        const [key, item] = next;
        const done = await run(machine, item.ref).then(() => true, () => false);
        if (done) {
          pending.delete(key);
          continue;
        }
        const wait = RETRY_AFTER_MS[Math.min(item.attempts, RETRY_AFTER_MS.length - 1)]!;
        item.attempts += 1;
        item.timer = setTimeout(() => {
          item.timer = undefined;
          void drain(machine);
        }, wait);
        item.timer.unref?.();
      }
    } finally {
      draining.delete(machine);
    }
  };

  return {
    /** Offer a mail's files for its seat's machine; one waiting on a retry goes now. */
    push: (machine: string, refs: ReadonlyArray<ContentRef>): void => {
      if (stopped) return;
      for (const ref of refs) {
        const key = `${machine}\n${ref.sha256}:${String(ref.byteLength)}`;
        const known = pending.get(key);
        if (known === undefined) pending.set(key, { machine, ref, attempts: 0 });
        else if (known.timer !== undefined) {
          clearTimeout(known.timer);
          known.timer = undefined;
        }
      }
      void drain(machine);
    },
    /** How many files wait to reach a machine. */
    waiting: (machine: string): number => [...pending.values()].filter((item) => item.machine === machine).length,
    stop: (): void => {
      stopped = true;
      for (const item of pending.values()) if (item.timer !== undefined) clearTimeout(item.timer);
      pending.clear();
    },
  };
};
