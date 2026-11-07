/**
 * OSC 7501, the Program Status Protocol, read out of a seat's PTY stream.
 *
 * A program reports its own state in-band:
 *
 *   ESC ] 7501 ; state=working:app=pi ST
 *   ESC ] 7501 ; state=blocked:kind=permission:app=omp:msg=<base64> ST
 *
 * and asks whether the terminal supports it with `ESC ] 7501 ; ? ST`. Junto
 * is the seat's terminal, so it answers the query and turns each root report
 * into seat signals (source `osc7501`, fidelity `native`).
 *
 * Spec: https://www.superlogical.com/rex/docs/build/program-status (rev 0.4).
 * The decoder follows its receiving rules: a malformed pair is skipped, the
 * last value of a repeated key wins, an unknown key is ignored, and the whole
 * report is dropped when it is over a limit, its state is missing or unknown,
 * its id is malformed, or its base64 text does not decode to control-free
 * UTF-8. Only the root record (no `id`) speaks for the seat; child records
 * are a program's sub-tasks and are not read.
 *
 * What the installed harnesses emit, captured from the real binaries on
 * 2026-10-16 (PTY, one short turn each):
 *
 * - pi 1.1.0: queries `7501;?` with DA1 behind it and reports only when the
 *   reply comes first, or always under `PI_PROGRAM_STATUS=1`.
 *   idle, working, done; `clear` on exit. ST-terminated.
 * - omp 18.9.2: never queries, reports by default (`terminal.programStatus`).
 *   idle, working, error with the upstream failure as `msg`; `clear` on exit.
 *   Under `--approval-mode always-ask` a tool approval is `blocked/permission`
 *   with the prompt as `msg` ("Allow tool: bash Command: ls").
 * - agy 1.4.0: queries with BEL and DA1 behind it, or reports under
 *   `AGY_CLI_OSC7501=on`. BEL-terminated. Starts `blocked/auth` ("Sign in
 *   required") for about a second while credentials load, reports the folder
 *   trust dialog as `blocked/permission` ("Trust this folder?"), and puts the
 *   model's final answer in the `done` msg.
 * - devin 3000.11.92: never queries, reports always. idle, working with
 *   "Thinking" and "Typing", done ("Devin finished"); `clear` on exit.
 *
 * A `working` or `done` msg is a label, and agy's is model output: neither is
 * carried. Only `blocked` and `error` keep their text.
 */
import { Schema } from "effect";
import {
  BindingId,
  type SeatSignal,
  type SignalEnvelope,
} from "@shared/harness-domain";

/** Environment that turns reporting on without a query, for the harnesses that read one. */
export const PROGRAM_STATUS_ENV: Readonly<Record<string, string>> = {
  PI_PROGRAM_STATUS: "1",
  AGY_CLI_OSC7501: "on",
};

/** The answer to `7501;?`: support for the default states and kinds. */
export const PROGRAM_STATUS_QUERY_REPLY = "\u001b]7501;?\u001b\\";

const INTRODUCER = "\u001b]7501;";
const BEL = "\u0007";
const ESC = "\u001b";

/** Whole sequence, introducer to terminator. */
const MAX_SEQUENCE_BYTES = 4096;
const MAX_KEY_BYTES = 16;
const MAX_MSG_ENCODED = 2732;
const MAX_MSG_DECODED = 2048;
const MAX_TITLE_ENCODED = 256;
const MAX_TITLE_DECODED = 192;
const MAX_ID_BYTES = 128;
const MAX_ID_DEPTH = 8;

const KEY = /^[a-z]+$/;
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const APP = /^[A-Za-z0-9_.+-]{1,32}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export const PROGRAM_STATES = ["idle", "working", "done", "blocked", "error", "clear"] as const;
export type ProgramState = (typeof PROGRAM_STATES)[number];

export const BLOCKED_KINDS = ["permission", "question", "auth"] as const;
export type BlockedKind = (typeof BLOCKED_KINDS)[number];

export type ProgramStatusReport = {
  readonly state: ProgramState;
  /** Absent for the root record. */
  readonly id?: string;
  /** Only on `blocked`. */
  readonly kind?: BlockedKind;
  /** 0 to 100, only on `working` and `blocked`. Absent means indeterminate. */
  readonly progress?: number;
  readonly app?: string;
  readonly title?: string;
  readonly msg?: string;
};

const isState = (value: string): value is ProgramState =>
  (PROGRAM_STATES as readonly string[]).includes(value);

const isKind = (value: string): value is BlockedKind =>
  (BLOCKED_KINDS as readonly string[]).includes(value);

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Decoded text, or `null` when the whole report must be refused. */
const decodeText = (encoded: string, maxEncoded: number, maxDecoded: number): string | null => {
  if (encoded.length > maxEncoded || !BASE64.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > maxDecoded) return null;
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return null;
  }
  return CONTROL.test(text) ? null : text;
};

const validId = (id: string): boolean => {
  if (id.length > MAX_ID_BYTES) return false;
  const segments = id.split("/");
  return segments.length <= MAX_ID_DEPTH && segments.every((segment) => SEGMENT.test(segment));
};

/**
 * The body after `7501;`, decoded by the spec's receiving rules. `undefined`
 * means the report is ignored. The query (`?`) is not a report.
 */
export const decodeProgramStatus = (body: string): ProgramStatusReport | undefined => {
  if (body.startsWith("?")) return undefined;
  const pairs = new Map<string, string>();
  for (const pair of body.split(":")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key.length > MAX_KEY_BYTES || !KEY.test(key) || !VALUE.test(value)) continue;
    pairs.set(key, value);
  }
  const state = pairs.get("state");
  if (state === undefined || !isState(state)) return undefined;
  const id = pairs.get("id");
  if (id !== undefined && !validId(id)) return undefined;
  const encodedMsg = pairs.get("msg");
  const msg =
    encodedMsg === undefined ? undefined : decodeText(encodedMsg, MAX_MSG_ENCODED, MAX_MSG_DECODED);
  if (msg === null) return undefined;
  const encodedTitle = pairs.get("title");
  const title =
    encodedTitle === undefined
      ? undefined
      : decodeText(encodedTitle, MAX_TITLE_ENCODED, MAX_TITLE_DECODED);
  if (title === null) return undefined;
  const kind = pairs.get("kind");
  const progress = pairs.get("progress");
  const progressValue = progress !== undefined && /^\d{1,3}$/.test(progress) ? Number(progress) : NaN;
  const app = pairs.get("app");
  return {
    state,
    ...(id === undefined ? {} : { id }),
    ...(state === "blocked" && kind !== undefined && isKind(kind) ? { kind } : {}),
    ...((state === "working" || state === "blocked") && progressValue <= 100
      ? { progress: progressValue }
      : {}),
    ...(app !== undefined && APP.test(app) ? { app } : {}),
    ...(title === undefined || title === "" ? {} : { title }),
    ...(msg === undefined || msg === "" ? {} : { msg }),
  };
};

/**
 * What a root report says about the seat. Child records, and a `clear` aimed
 * at one, say nothing.
 */
export const programStatusSignals = (report: ProgramStatusReport): readonly SeatSignal[] => {
  if (report.id !== undefined) return [];
  switch (report.state) {
    case "idle":
      return [{ _tag: "ActivityObserved", activity: "idle" }];
    case "working":
      return [{ _tag: "ActivityObserved", activity: "working" }];
    case "done":
      return [{ _tag: "TurnEnded", outcome: "completed" }];
    case "error":
      return [
        { _tag: "ErrorRaised", kind: "unknown", message: report.msg ?? "" },
        { _tag: "TurnEnded", outcome: "failed" },
      ];
    // The program withdrew its record (exit, suspend, opt-out): it no longer
    // speaks for the seat, and the next channel carries it.
    case "clear":
      return [{ _tag: "ChannelClosed", channel: "osc7501" }];
    case "blocked":
      return [blockedSignal(report)];
  }
};

const blockedSignal = (report: ProgramStatusReport): SeatSignal => {
  switch (report.kind) {
    case "permission":
      return { _tag: "PermissionRequested", ...(report.msg === undefined ? {} : { detail: report.msg }) };
    case "question":
      return { _tag: "QuestionAsked", ...(report.msg === undefined ? {} : { text: report.msg }) };
    case "auth":
      return { _tag: "DialogShown", kind: "login" };
    case undefined:
      return { _tag: "DialogShown", kind: "unknown" };
  }
};

const decodeSeat = Schema.decodeUnknownOption(BindingId);

/** A root report as envelopes for one seat. Empty for anything that says nothing. */
export const programStatusEnvelopes = (
  seat: string,
  at: number,
  report: ProgramStatusReport,
): readonly SignalEnvelope[] => {
  const signals = programStatusSignals(report);
  if (signals.length === 0) return [];
  const decoded = decodeSeat(seat);
  if (decoded._tag === "None") return [];
  return signals.map((signal) => ({
    seat: decoded.value,
    at,
    source: "osc7501",
    fidelity: "native",
    signal,
  }));
};

export type ProgramStatusEvent =
  | { readonly type: "query" }
  | { readonly type: "report"; readonly report: ProgramStatusReport };

/**
 * Finds OSC 7501 sequences in a PTY stream that arrives in arbitrary chunks.
 *
 * A sequence split across chunks is held until its terminator (BEL or ST)
 * arrives, up to the spec's 4096-byte sequence limit; longer is dropped. An
 * ESC that does not start ST aborts the sequence, as it does in a terminal.
 * A chunk with no introducer and nothing held costs one `indexOf`.
 */
export class ProgramStatusScanner {
  private carry = "";

  feed(data: string): readonly ProgramStatusEvent[] {
    const text = this.carry === "" ? data : this.carry + data;
    this.carry = "";
    let start = text.indexOf(INTRODUCER);
    if (start < 0) {
      this.carry = partialIntroducer(text);
      return NO_EVENTS;
    }
    const events: ProgramStatusEvent[] = [];
    let rest = 0;
    while (start >= 0) {
      const bodyStart = start + INTRODUCER.length;
      let end = bodyStart;
      while (end < text.length && text[end] !== BEL && text[end] !== ESC) end += 1;
      if (end - start > MAX_SEQUENCE_BYTES) {
        rest = end;
      } else if (end >= text.length || (text[end] === ESC && end + 1 >= text.length)) {
        this.carry = text.slice(start);
        return events;
      } else if (text[end] === BEL || text[end + 1] === "\\") {
        const body = text.slice(bodyStart, end);
        if (body.startsWith("?")) events.push({ type: "query" });
        else {
          const report = decodeProgramStatus(body);
          if (report !== undefined) events.push({ type: "report", report });
        }
        rest = end + (text[end] === BEL ? 1 : 2);
      } else {
        // Any other escape aborts the sequence and may begin the next one.
        rest = end;
      }
      start = text.indexOf(INTRODUCER, rest);
    }
    this.carry = partialIntroducer(text.slice(rest));
    return events;
  }
}

const NO_EVENTS: readonly ProgramStatusEvent[] = [];

/** The tail of `text` that could be the start of an introducer split across chunks. */
const partialIntroducer = (text: string): string => {
  const from = text.lastIndexOf(ESC, text.length - 1);
  if (from < 0 || text.length - from >= INTRODUCER.length) return "";
  const tail = text.slice(from);
  return INTRODUCER.startsWith(tail) ? tail : "";
};
