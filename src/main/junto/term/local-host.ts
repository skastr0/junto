commit 041051778d2971d9d8367b4aa525ea63a06fd02c
Author: Guilherme Castro <skastr052@gmail.com>
Date:   Sat Oct 17 00:00:55 2026 -0300

    feat(pty): read OSC 7501 program status out of the seat's PTY stream
    
    Junto is the seat's terminal, so it now answers the Program Status
    Protocol query (ESC]7501;?) in the same tick it arrives, ahead of the
    DA1 reply pi and agy wait behind, and turns each root report into seat
    signals (source osc7501, fidelity native) published through
    LocalSessionHost.onSeatSignal. The reply goes through the managed
    submission hold like any other write. Agent seats spawn with
    PI_PROGRAM_STATUS=1 and AGY_CLI_OSC7501=on; a seat's own value wins.
    
    Decoding follows spec rev 0.4's receiving rules. Only the root record
    speaks for the seat. working and done msgs are dropped: agy puts the
    model's answer in done.
    
    Captured from the real binaries: pi 1.1.0 and agy 1.4.0 report after
    the query reply or under their env; omp 18.9.2 and devin 3000.11.92
    report unconditionally. Their sequences are fixtures in the tests.
    
    Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>

diff --git a/src/main/junto/term/local-host.ts b/src/main/junto/term/local-host.ts
index 50bb70979..66125d467 100644
--- a/src/main/junto/term/local-host.ts
+++ b/src/main/junto/term/local-host.ts
@@ -114,6 +114,13 @@ import {
 } from "./templates/harness-install";
 import { configuredToolDirectories } from "../adapters/exec";
 import { buildManagedSeatInject } from "./templates/seat-env";
+import {
+  PROGRAM_STATUS_ENV,
+  PROGRAM_STATUS_QUERY_REPLY,
+  ProgramStatusScanner,
+  programStatusEnvelopes,
+} from "./program-status";
+import type { SignalEnvelope } from "@shared/harness-domain";
 import {
   primeAgentDaemons,
   type PrimeAgentDaemonHandle,
@@ -351,6 +358,8 @@ type SessionRec = {
   killReceipt: AppProcessSignalReceipt | undefined;
   /** Bounded carryover for a harness session marker split across PTY chunks. */
   sessionCaptureTail: string;
+  /** OSC 7501 reports and queries in this generation's output. */
+  programStatus: ProgramStatusScanner;
   /** Exact-record escalation; never follows a mutable binding lookup. */
   escalationTimer: ReturnType<typeof setTimeout> | undefined;
   /**
@@ -729,6 +738,8 @@ export const resolveLaunch = (
     seat.kind === "agent"
       ? {
           ...buildSpawnEnv(process.env, {
+            // Status reporting on by default; anything the seat or region set wins.
+            ...PROGRAM_STATUS_ENV,
             ...launchEnv,
             ...(options?.regionEnv ?? {}),
             ...seatOwnEnv,
@@ -899,6 +910,7 @@ export class LocalSessionHost extends EventEmitter {
   private readonly recordExitWaiters = new Set<RecordExitWaiter>();
   private inputSealed: ((bindingId: string) => boolean) | undefined;
   private readonly drainEndedListeners = new Set<(drainKey: string, code: number | undefined) => void>();
+  private readonly seatSignalListeners = new Set<(envelope: SignalEnvelope) => void>();
   private maintenanceLease: LocalTerminalMaintenanceLease | undefined;
   private shuttingDown = false;
   private shutdownFlight: Promise<LocalHostShutdownResult> | undefined;
@@ -1206,6 +1218,7 @@ export class LocalSessionHost extends EventEmitter {
       termReceipt: undefined,
       killReceipt: undefined,
       sessionCaptureTail: "",
+      programStatus: new ProgramStatusScanner(),
       escalationTimer: undefined,
       unconfirmedStop: undefined,
       draining: undefined,
@@ -2174,6 +2187,14 @@ export class LocalSessionHost extends EventEmitter {
     };
   }
 
+  /** Told each seat signal read out of a seat's PTY stream (OSC 7501 today). */
+  onSeatSignal(listener: (envelope: SignalEnvelope) => void): () => void {
+    this.seatSignalListeners.add(listener);
+    return () => {
+      this.seatSignalListeners.delete(listener);
+    };
+  }
+
   /** Detached sessions still alive, for the record at quit. */
   drainingKeys(): ReadonlyArray<string> {
     return [...this.liveRecords]
@@ -2559,6 +2580,7 @@ export class LocalSessionHost extends EventEmitter {
     this.pushJournal(rec, { seq: rec.seq, type: "output", data });
     // Single insertion point: every byte already flows here with a seq.
     this.observerPlane.feed(rec.bindingId, data, rec.seq);
+    this.observeProgramStatus(rec, data);
     // Best-effort diagnostic observation when a harness prints a labeled id.
     // PTY text is untrusted and this value is neither durable nor a cold-resume
     // capability. Retain a bounded tail so a label split across chunks remains
@@ -2607,6 +2629,42 @@ export class LocalSessionHost extends EventEmitter {
     }
   }
 
+  /**
+   * Junto is the seat's terminal, so it answers the OSC 7501 support query
+   * and reads the program's status reports. The reply is written in the same
+   * tick the query arrives, ahead of any DA1 reply a surface sends, which is
+   * the order pi and agy require.
+   */
+  private observeProgramStatus(rec: SessionRec, data: string): void {
+    for (const event of rec.programStatus.feed(data)) {
+      if (event.type === "query") {
+        this.answerProgramStatusQuery(rec);
+        continue;
+      }
+      for (const envelope of programStatusEnvelopes(rec.bindingId, Date.now(), event.report)) {
+        for (const listener of this.seatSignalListeners) {
+          try {
+            listener(envelope);
+          } catch (error) {
+            console.error(`[term] seat signal listener failed for ${rec.bindingId}@${rec.epoch}:`, error);
+          }
+        }
+      }
+    }
+  }
+
+  /** Behind a managed submission span, like any other write, so it never lands inside a paste. */
+  private answerProgramStatusQuery(rec: SessionRec): void {
+    const answer = (): void => {
+      if (this.sessions.get(rec.bindingId) !== rec || rec.killed || !sessionPhaseAllowsWrite(rec.phase)) {
+        return;
+      }
+      this.writeRecord(rec, PROGRAM_STATUS_QUERY_REPLY);
+    };
+    if (this.operatorInterlock.holdWrite(rec.bindingId, { replay: answer })) return;
+    answer();
+  }
+
   private observeExit(
     rec: SessionRec,
     code: number | undefined,
diff --git a/src/main/junto/term/program-status.ts b/src/main/junto/term/program-status.ts
new file mode 100644
index 000000000..f1bb2fe53
--- /dev/null
+++ b/src/main/junto/term/program-status.ts
@@ -0,0 +1,292 @@
+/**
+ * OSC 7501, the Program Status Protocol, read out of a seat's PTY stream.
+ *
+ * A program reports its own state in-band:
+ *
+ *   ESC ] 7501 ; state=working:app=pi ST
+ *   ESC ] 7501 ; state=blocked:kind=permission:app=omp:msg=<base64> ST
+ *
+ * and asks whether the terminal supports it with `ESC ] 7501 ; ? ST`. Junto
+ * is the seat's terminal, so it answers the query and turns each root report
+ * into seat signals (source `osc7501`, fidelity `native`).
+ *
+ * Spec: https://www.superlogical.com/rex/docs/build/program-status (rev 0.4).
+ * The decoder follows its receiving rules: a malformed pair is skipped, the
+ * last value of a repeated key wins, an unknown key is ignored, and the whole
+ * report is dropped when it is over a limit, its state is missing or unknown,
+ * its id is malformed, or its base64 text does not decode to control-free
+ * UTF-8. Only the root record (no `id`) speaks for the seat; child records
+ * are a program's sub-tasks and are not read.
+ *
+ * What the installed harnesses emit, captured from the real binaries on
+ * 2026-10-16 (PTY, one short turn each):
+ *
+ * - pi 1.1.0: queries `7501;?` with DA1 behind it and reports only when the
+ *   reply comes first, or always under `PI_PROGRAM_STATUS=1`.
+ *   idle, working, done; `clear` on exit. ST-terminated.
+ * - omp 18.9.2: never queries, reports by default (`terminal.programStatus`).
+ *   idle, working, error with the upstream failure as `msg`; `clear` on exit.
+ * - agy 1.4.0: queries with BEL and DA1 behind it, or reports under
+ *   `AGY_CLI_OSC7501=on`. BEL-terminated. Starts `blocked/auth` ("Sign in
+ *   required") for about a second while credentials load, reports the folder
+ *   trust dialog as `blocked/permission` ("Trust this folder?"), and puts the
+ *   model's final answer in the `done` msg.
+ * - devin 3000.11.92: never queries, reports always. idle, working with
+ *   "Thinking" and "Typing", done ("Devin finished"); `clear` on exit.
+ *
+ * A `working` or `done` msg is a label, and agy's is model output: neither is
+ * carried. Only `blocked` and `error` keep their text.
+ */
+import { Schema } from "effect";
+import {
+  BindingId,
+  type SeatSignal,
+  type SignalEnvelope,
+} from "@shared/harness-domain";
+
+/** Environment that turns reporting on without a query, for the harnesses that read one. */
+export const PROGRAM_STATUS_ENV: Readonly<Record<string, string>> = {
+  PI_PROGRAM_STATUS: "1",
+  AGY_CLI_OSC7501: "on",
+};
+
+/** The answer to `7501;?`: support for the default states and kinds. */
+export const PROGRAM_STATUS_QUERY_REPLY = "\u001b]7501;?\u001b\\";
+
+const INTRODUCER = "\u001b]7501;";
+const BEL = "\u0007";
+const ESC = "\u001b";
+
+/** Whole sequence, introducer to terminator. */
+const MAX_SEQUENCE_BYTES = 4096;
+const MAX_KEY_BYTES = 16;
+const MAX_MSG_ENCODED = 2732;
+const MAX_MSG_DECODED = 2048;
+const MAX_TITLE_ENCODED = 256;
+const MAX_TITLE_DECODED = 192;
+const MAX_ID_BYTES = 128;
+const MAX_ID_DEPTH = 8;
+
+const KEY = /^[a-z]+$/;
+const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
+const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
+const APP = /^[A-Za-z0-9_.+-]{1,32}$/;
+const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/;
+const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
+
+export const PROGRAM_STATES = ["idle", "working", "done", "blocked", "error", "clear"] as const;
+export type ProgramState = (typeof PROGRAM_STATES)[number];
+
+export const BLOCKED_KINDS = ["permission", "question", "auth"] as const;
+export type BlockedKind = (typeof BLOCKED_KINDS)[number];
+
+export type ProgramStatusReport = {
+  readonly state: ProgramState;
+  /** Absent for the root record. */
+  readonly id?: string;
+  /** Only on `blocked`. */
+  readonly kind?: BlockedKind;
+  /** 0 to 100, only on `working` and `blocked`. Absent means indeterminate. */
+  readonly progress?: number;
+  readonly app?: string;
+  readonly title?: string;
+  readonly msg?: string;
+};
+
+const isState = (value: string): value is ProgramState =>
+  (PROGRAM_STATES as readonly string[]).includes(value);
+
+const isKind = (value: string): value is BlockedKind =>
+  (BLOCKED_KINDS as readonly string[]).includes(value);
+
+const utf8 = new TextDecoder("utf-8", { fatal: true });
+
+/** Decoded text, or `null` when the whole report must be refused. */
+const decodeText = (encoded: string, maxEncoded: number, maxDecoded: number): string | null => {
+  if (encoded.length > maxEncoded || !BASE64.test(encoded)) return null;
+  const bytes = Buffer.from(encoded, "base64");
+  if (bytes.length > maxDecoded) return null;
+  let text: string;
+  try {
+    text = utf8.decode(bytes);
+  } catch {
+    return null;
+  }
+  return CONTROL.test(text) ? null : text;
+};
+
+const validId = (id: string): boolean => {
+  if (id.length > MAX_ID_BYTES) return false;
+  const segments = id.split("/");
+  return segments.length <= MAX_ID_DEPTH && segments.every((segment) => SEGMENT.test(segment));
+};
+
+/**
+ * The body after `7501;`, decoded by the spec's receiving rules. `undefined`
+ * means the report is ignored. The query (`?`) is not a report.
+ */
+export const decodeProgramStatus = (body: string): ProgramStatusReport | undefined => {
+  if (body.startsWith("?")) return undefined;
+  const pairs = new Map<string, string>();
+  for (const pair of body.split(":")) {
+    const eq = pair.indexOf("=");
+    if (eq < 0) continue;
+    const key = pair.slice(0, eq).trim();
+    const value = pair.slice(eq + 1).trim();
+    if (key.length > MAX_KEY_BYTES || !KEY.test(key) || !VALUE.test(value)) continue;
+    pairs.set(key, value);
+  }
+  const state = pairs.get("state");
+  if (state === undefined || !isState(state)) return undefined;
+  const id = pairs.get("id");
+  if (id !== undefined && !validId(id)) return undefined;
+  const encodedMsg = pairs.get("msg");
+  const msg =
+    encodedMsg === undefined ? undefined : decodeText(encodedMsg, MAX_MSG_ENCODED, MAX_MSG_DECODED);
+  if (msg === null) return undefined;
+  const encodedTitle = pairs.get("title");
+  const title =
+    encodedTitle === undefined
+      ? undefined
+      : decodeText(encodedTitle, MAX_TITLE_ENCODED, MAX_TITLE_DECODED);
+  if (title === null) return undefined;
+  const kind = pairs.get("kind");
+  const progress = pairs.get("progress");
+  const progressValue = progress !== undefined && /^\d{1,3}$/.test(progress) ? Number(progress) : NaN;
+  const app = pairs.get("app");
+  return {
+    state,
+    ...(id === undefined ? {} : { id }),
+    ...(state === "blocked" && kind !== undefined && isKind(kind) ? { kind } : {}),
+    ...((state === "working" || state === "blocked") && progressValue <= 100
+      ? { progress: progressValue }
+      : {}),
+    ...(app !== undefined && APP.test(app) ? { app } : {}),
+    ...(title === undefined || title === "" ? {} : { title }),
+    ...(msg === undefined || msg === "" ? {} : { msg }),
+  };
+};
+
+/**
+ * What a root report says about the seat. Child records, and a `clear` aimed
+ * at one, say nothing.
+ */
+export const programStatusSignals = (report: ProgramStatusReport): readonly SeatSignal[] => {
+  if (report.id !== undefined) return [];
+  switch (report.state) {
+    case "idle":
+      return [{ _tag: "ActivityObserved", activity: "idle" }];
+    case "working":
+      return [{ _tag: "ActivityObserved", activity: "working" }];
+    case "done":
+      return [{ _tag: "TurnEnded", outcome: "completed" }];
+    case "error":
+      return [
+        { _tag: "ErrorRaised", kind: "unknown", message: report.msg ?? "" },
+        { _tag: "TurnEnded", outcome: "failed" },
+      ];
+    // The program withdrew its record (exit, suspend, opt-out): it no longer
+    // speaks for the seat, and the next channel carries it.
+    case "clear":
+      return [{ _tag: "ChannelClosed", channel: "osc7501" }];
+    case "blocked":
+      return [blockedSignal(report)];
+  }
+};
+
+const blockedSignal = (report: ProgramStatusReport): SeatSignal => {
+  switch (report.kind) {
+    case "permission":
+      return { _tag: "PermissionRequested", ...(report.msg === undefined ? {} : { detail: report.msg }) };
+    case "question":
+      return { _tag: "QuestionAsked", ...(report.msg === undefined ? {} : { text: report.msg }) };
+    case "auth":
+      return { _tag: "DialogShown", kind: "login" };
+    case undefined:
+      return { _tag: "DialogShown", kind: "unknown" };
+  }
+};
+
+const decodeSeat = Schema.decodeUnknownOption(BindingId);
+
+/** A root report as envelopes for one seat. Empty for anything that says nothing. */
+export const programStatusEnvelopes = (
+  seat: string,
+  at: number,
+  report: ProgramStatusReport,
+): readonly SignalEnvelope[] => {
+  const signals = programStatusSignals(report);
+  if (signals.length === 0) return [];
+  const decoded = decodeSeat(seat);
+  if (decoded._tag === "None") return [];
+  return signals.map((signal) => ({
+    seat: decoded.value,
+    at,
+    source: "osc7501",
+    fidelity: "native",
+    signal,
+  }));
+};
+
+export type ProgramStatusEvent =
+  | { readonly type: "query" }
+  | { readonly type: "report"; readonly report: ProgramStatusReport };
+
+/**
+ * Finds OSC 7501 sequences in a PTY stream that arrives in arbitrary chunks.
+ *
+ * A sequence split across chunks is held until its terminator (BEL or ST)
+ * arrives, up to the spec's 4096-byte sequence limit; longer is dropped. An
+ * ESC that does not start ST aborts the sequence, as it does in a terminal.
+ * A chunk with no introducer and nothing held costs one `indexOf`.
+ */
+export class ProgramStatusScanner {
+  private carry = "";
+
+  feed(data: string): readonly ProgramStatusEvent[] {
+    const text = this.carry === "" ? data : this.carry + data;
+    this.carry = "";
+    let start = text.indexOf(INTRODUCER);
+    if (start < 0) {
+      this.carry = partialIntroducer(text);
+      return NO_EVENTS;
+    }
+    const events: ProgramStatusEvent[] = [];
+    let rest = 0;
+    while (start >= 0) {
+      const bodyStart = start + INTRODUCER.length;
+      let end = bodyStart;
+      while (end < text.length && text[end] !== BEL && text[end] !== ESC) end += 1;
+      if (end - start > MAX_SEQUENCE_BYTES) {
+        rest = end;
+      } else if (end >= text.length || (text[end] === ESC && end + 1 >= text.length)) {
+        this.carry = text.slice(start);
+        return events;
+      } else if (text[end] === BEL || text[end + 1] === "\\") {
+        const body = text.slice(bodyStart, end);
+        if (body.startsWith("?")) events.push({ type: "query" });
+        else {
+          const report = decodeProgramStatus(body);
+          if (report !== undefined) events.push({ type: "report", report });
+        }
+        rest = end + (text[end] === BEL ? 1 : 2);
+      } else {
+        // Any other escape aborts the sequence and may begin the next one.
+        rest = end;
+      }
+      start = text.indexOf(INTRODUCER, rest);
+    }
+    this.carry = partialIntroducer(text.slice(rest));
+    return events;
+  }
+}
+
+const NO_EVENTS: readonly ProgramStatusEvent[] = [];
+
+/** The tail of `text` that could be the start of an introducer split across chunks. */
+const partialIntroducer = (text: string): string => {
+  const from = text.lastIndexOf(ESC, text.length - 1);
+  if (from < 0 || text.length - from >= INTRODUCER.length) return "";
+  const tail = text.slice(from);
+  return INTRODUCER.startsWith(tail) ? tail : "";
+};
diff --git a/tests/program-status.test.ts b/tests/program-status.test.ts
new file mode 100644
index 000000000..36f190f7f
--- /dev/null
+++ b/tests/program-status.test.ts
@@ -0,0 +1,343 @@
+import { seedThisMachine, clearMachines } from "./support/seed-this-machine";
+import { Result } from "effect";
+import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
+import {
+  decodeProgramStatus,
+  PROGRAM_STATUS_QUERY_REPLY,
+  ProgramStatusScanner,
+  programStatusEnvelopes,
+  type ProgramStatusEvent,
+} from "../src/main/junto/term/program-status";
+import { LocalSessionHost, resolveLaunch } from "../src/main/junto/term/local-host";
+import { OperatorInterlock } from "../src/main/junto/term/drive/operator-interlock";
+import {
+  makeProcessIdentityMap,
+  setProcessIdentityMapForTests,
+} from "../src/main/junto/process-identity";
+import { setProcessEpochReaderForTests } from "../src/main/junto/process-epoch";
+import {
+  makeFakeTerminalProcessAuthority,
+  type FakeTerminalProcessAuthority,
+} from "./helpers/fake-terminal-process-authority";
+import { installHermeticHarnessBins } from "./helpers/hermetic-harness-bins";
+import {
+  decodeSignalEnvelope,
+  initialSnapshot,
+  reduceSeatSignals,
+  type SignalEnvelope,
+} from "../src/shared/harness-domain";
+
+const ESC = "\u001b";
+const ST = `${ESC}\\`;
+const BEL = "\u0007";
+const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
+const osc = (body: string, end = ST): string => `${ESC}]7501;${body}${end}`;
+
+const scanAll = (chunks: readonly string[]): ProgramStatusEvent[] => {
+  const scanner = new ProgramStatusScanner();
+  return chunks.flatMap((chunk) => [...scanner.feed(chunk)]);
+};
+
+/** Exactly what the installed harnesses wrote on 2026-10-16 (see program-status.ts). */
+const CAPTURED = {
+  pi: [osc("state=idle:app=pi"), osc("state=working:app=pi"), osc("state=done:app=pi"), osc("state=clear")],
+  omp: [
+    osc("state=idle:app=omp"),
+    osc("state=working:app=omp"),
+    osc(
+      "state=error:app=omp:msg=NDAwIFVwc3RyZWFtIHJlcXVlc3QgZmFpbGVkOiBNb2RlbCBpcyB1bmF2YWlsYWJsZS4gVXBzdHJlYW0gcmVxdWVzdCBmYWlsZWQ6IE1vZGVsIGlzIHVuYXZhaWxhYmxlLiAodHlwZT1zZXJ2ZXJfZXJyb3IpIHJhdy1odHRwLXJlcXVlc3Q9L1VzZXJzL2d1aWxoZXJtZWNhc3Ryby8ub21wL2xvZ3MvaHR0cC00MDAtcmVxdWVzdHMvMTc5MjIwNTYzMDAxNC0xYzl5b3hxOXJ1YW5wLmpzb24=",
+    ),
+    osc("state=clear"),
+  ],
+  agy: [
+    osc("?", BEL),
+    osc("state=blocked:kind=auth:app=antigravity:msg=U2lnbiBpbiByZXF1aXJlZA==", BEL),
+    osc("state=blocked:kind=permission:app=antigravity:msg=VHJ1c3QgdGhpcyBmb2xkZXI/", BEL),
+    osc("state=idle:app=antigravity", BEL),
+    osc("state=working:app=antigravity", BEL),
+    osc("state=done:app=antigravity:msg=b2s=", BEL),
+  ],
+  devin: [
+    osc("state=idle:app=devin"),
+    osc("state=working:app=devin:msg=VGhpbmtpbmc="),
+    osc("state=working:app=devin:msg=VHlwaW5n"),
+    osc("state=done:app=devin:msg=RGV2aW4gZmluaXNoZWQ="),
+    osc("state=clear"),
+  ],
+} as const;
+
+describe("program status: decoding by the spec's receiving rules", () => {
+  it("reads state, kind, app and base64 msg in any order", () => {
+    expect(decodeProgramStatus(`state=blocked:kind=question:app=omp:msg=${b64("Which branch?")}`)).toEqual({
+      state: "blocked",
+      kind: "question",
+      app: "omp",
+      msg: "Which branch?",
+    });
+    expect(decodeProgramStatus(`app=pi:state=working`)).toEqual({ state: "working", app: "pi" });
+  });
+
+  it("ignores a report whose state is missing or unknown", () => {
+    expect(decodeProgramStatus("app=pi")).toBeUndefined();
+    expect(decodeProgramStatus("state=paused:app=pi")).toBeUndefined();
+  });
+
+  it("lets the last repeated key win and skips malformed pairs", () => {
+    expect(decodeProgramStatus("state=idle:state=working:junk:=x:BAD=1:app=pi")).toEqual({
+      state: "working",
+      app: "pi",
+    });
+    expect(decodeProgramStatus(" state = done : app = pi ")).toEqual({ state: "done", app: "pi" });
+  });
+
+  it("drops a kind on any state but blocked, and an unknown kind", () => {
+    expect(decodeProgramStatus("state=working:kind=permission")).toEqual({ state: "working" });
+    expect(decodeProgramStatus("state=blocked:kind=payment")).toEqual({ state: "blocked" });
+  });
+
+  it("keeps progress only as an integer 0 to 100 on working or blocked", () => {
+    expect(decodeProgramStatus("state=working:progress=40")).toEqual({ state: "working", progress: 40 });
+    expect(decodeProgramStatus("state=working:progress=140")).toEqual({ state: "working" });
+    expect(decodeProgramStatus("state=done:progress=40")).toEqual({ state: "done" });
+  });
+
+  it("refuses the whole report when its text is not control-free UTF-8 base64", () => {
+    expect(decodeProgramStatus("state=error:msg=a,b")).toBeUndefined();
+    expect(decodeProgramStatus("state=error:msg=a")).toBeUndefined();
+    // A byte outside the value set makes a malformed pair, which is skipped.
+    expect(decodeProgramStatus("state=error:msg=***")).toEqual({ state: "error" });
+    expect(decodeProgramStatus(`state=error:msg=${b64("line one\nline two")}`)).toBeUndefined();
+    expect(decodeProgramStatus(`state=error:msg=${Buffer.from([0xff, 0xfe]).toString("base64")}`)).toBeUndefined();
+    expect(decodeProgramStatus(`state=error:msg=${b64("x".repeat(2049))}`)).toBeUndefined();
+  });
+
+  it("accepts unpadded base64", () => {
+    expect(decodeProgramStatus("state=error:msg=b2s")).toEqual({ state: "error", msg: "ok" });
+  });
+
+  it("refuses a malformed id instead of falling back to the root", () => {
+    expect(decodeProgramStatus("state=working:id=build/test")).toEqual({ state: "working", id: "build/test" });
+    expect(decodeProgramStatus("state=working:id=build//test")).toBeUndefined();
+    expect(decodeProgramStatus(`state=working:id=${"a".repeat(33)}`)).toBeUndefined();
+  });
+
+  it("drops an app outside its charset", () => {
+    expect(decodeProgramStatus(`state=idle:app=${"a".repeat(33)}`)).toEqual({ state: "idle" });
+  });
+});
+
+describe("program status: scanning a PTY stream", () => {
+  it("finds every report captured from pi, omp, agy and devin", () => {
+    const states = (chunks: readonly string[]) =>
+      scanAll([chunks.join("plain text between\r\n")]).map((event) =>
+        event.type === "query" ? "?" : event.report.state,
+      );
+    expect(states(CAPTURED.pi)).toEqual(["idle", "working", "done", "clear"]);
+    expect(states(CAPTURED.omp)).toEqual(["idle", "working", "error", "clear"]);
+    expect(states(CAPTURED.agy)).toEqual(["?", "blocked", "blocked", "idle", "working", "done"]);
+    expect(states(CAPTURED.devin)).toEqual(["idle", "working", "working", "done", "clear"]);
+  });
+
+  it("holds a sequence split anywhere across chunks, the terminator included", () => {
+    const stream = `a${osc("state=working:app=pi")}b${osc("?", BEL)}c`;
+    for (let cut = 1; cut < stream.length; cut += 1) {
+      const events = scanAll([stream.slice(0, cut), stream.slice(cut)]);
+      expect(events.map((event) => event.type)).toEqual(["report", "query"]);
+    }
+    const byteByByte = scanAll([...stream]);
+    expect(byteByByte.map((event) => event.type)).toEqual(["report", "query"]);
+  });
+
+  it("lets another escape abort a sequence and start the next one", () => {
+    const events = scanAll([`${ESC}]7501;state=idle${ESC}[0m${osc("state=done")}`]);
+    expect(events).toEqual([{ type: "report", report: { state: "done" } }]);
+  });
+
+  it("drops a sequence past the 4096-byte limit and recovers after it", () => {
+    const long = `${ESC}]7501;state=working:title=${"A".repeat(5000)}`;
+    const events = scanAll([long.slice(0, 3000), long.slice(3000), `${ST}${osc("state=idle")}`]);
+    expect(events).toEqual([{ type: "report", report: { state: "idle" } }]);
+  });
+
+  it("ignores other OSCs", () => {
+    expect(scanAll([`${ESC}]0;title${BEL}${ESC}]9;4;3${BEL}${ESC}]75010;x${ST}`])).toEqual([]);
+  });
+});
+
+describe("program status: seat signals", () => {
+  const seat = "seat-osc";
+  const fold = (chunks: readonly string[]) => {
+    let clock = 1_000;
+    const envelopes: SignalEnvelope[] = scanAll(chunks).flatMap((event) =>
+      event.type === "report" ? [...programStatusEnvelopes(seat, (clock += 10), event.report)] : [],
+    );
+    for (const envelope of envelopes) {
+      expect(Result.isSuccess(decodeSignalEnvelope(envelope))).toBe(true);
+    }
+    return { envelopes, snapshot: reduceSeatSignals(initialSnapshot(envelopes[0]!.seat, 0), envelopes) };
+  };
+
+  it("marks every envelope native OSC 7501", () => {
+    const { envelopes } = fold([osc("state=working")]);
+    expect(envelopes).toEqual([
+      expect.objectContaining({ source: "osc7501", fidelity: "native", signal: { _tag: "ActivityObserved", activity: "working" } }),
+    ]);
+  });
+
+  it("reads a finished pi turn as an unseen completed turn, then a closed channel", () => {
+    const { snapshot } = fold(CAPTURED.pi);
+    expect(snapshot.status).toEqual({ _tag: "Idle" });
+    expect(snapshot.turnUnseen?.outcome).toBe("completed");
+    expect(snapshot.channels).not.toContain("osc7501");
+  });
+
+  it("records omp's failure text and ends the turn failed", () => {
+    const { snapshot } = fold(CAPTURED.omp.slice(0, 3));
+    expect(snapshot.lastError?.kind).toBe("unknown");
+    expect(snapshot.lastError?.message).toMatch(/^400 Upstream request failed: Model is unavailable/);
+    expect(snapshot.turnUnseen?.outcome).toBe("failed");
+    expect(snapshot.status).toEqual({ _tag: "Idle" });
+  });
+
+  it("maps blocked kinds to permission, question, login and an unknown dialog", () => {
+    const signal = (body: string) => fold([osc(body)]).envelopes.map((envelope) => envelope.signal);
+    expect(signal(`state=blocked:kind=permission:msg=${b64("Trust this folder?")}`)).toEqual([
+      { _tag: "PermissionRequested", detail: "Trust this folder?" },
+    ]);
+    expect(signal(`state=blocked:kind=question:msg=${b64("Which branch?")}`)).toEqual([
+      { _tag: "QuestionAsked", text: "Which branch?" },
+    ]);
+    expect(signal("state=blocked:kind=auth")).toEqual([{ _tag: "DialogShown", kind: "login" }]);
+    expect(signal("state=blocked")).toEqual([{ _tag: "DialogShown", kind: "unknown" }]);
+  });
+
+  it("never carries a working or done msg: agy puts the model's answer there", () => {
+    const { envelopes } = fold(CAPTURED.agy);
+    expect(JSON.stringify(envelopes)).not.toContain('"ok"');
+    expect(envelopes.at(-1)?.signal).toEqual({ _tag: "TurnEnded", outcome: "completed" });
+  });
+
+  it("says nothing for a child record or a clear aimed at one", () => {
+    expect(programStatusEnvelopes(seat, 1, { state: "blocked", id: "build" })).toEqual([]);
+    expect(programStatusEnvelopes(seat, 1, { state: "clear", id: "build" })).toEqual([]);
+  });
+});
+
+// ── The host answers the query and publishes signals ─────────────────────
+
+const hosts: LocalSessionHost[] = [];
+const syntheticEpochs = new Map<number, string>();
+let restoreHarnessBins: () => void = () => undefined;
+
+const trackSyntheticPid = (pid: number): number => {
+  syntheticEpochs.set(pid, `synthetic-${pid}`);
+  return pid;
+};
+
+const hostWith = (
+  fake: FakeTerminalProcessAuthority,
+  options: ConstructorParameters<typeof LocalSessionHost>[1] = {},
+): LocalSessionHost => {
+  const host = new LocalSessionHost(fake.authority, {
+    killGraceMs: 5,
+    shutdownGraceMs: 5,
+    lateExitGraceMs: 5,
+    ...options,
+  });
+  hosts.push(host);
+  return host;
+};
+
+beforeEach(() => {
+  seedThisMachine();
+  syntheticEpochs.clear();
+  restoreHarnessBins = installHermeticHarnessBins();
+  setProcessEpochReaderForTests({
+    snapshot: () =>
+      [...syntheticEpochs].map(([pid, startKey]) => ({
+        pid,
+        processGroupId: Math.max(2, pid - 1),
+        sessionId: 7,
+        startKey,
+      })),
+  });
+  setProcessIdentityMapForTests(
+    makeProcessIdentityMap({
+      processAlive: (pid) => pid === process.pid || syntheticEpochs.has(pid),
+      readProcessStartKey: (pid) => (pid === process.pid ? `self-${pid}` : syntheticEpochs.get(pid)),
+    }),
+  );
+});
+
+afterEach(async () => {
+  restoreHarnessBins();
+  for (const host of hosts.splice(0)) await host.shutdownAll("test_cleanup");
+  setProcessEpochReaderForTests(undefined);
+  setProcessIdentityMapForTests(undefined);
+  vi.unstubAllEnvs();
+  clearMachines();
+});
+
+describe("program status: the seat's terminal", () => {
+  it("answers the support query before the DA1 that follows it, in the same tick", () => {
+    const fake = makeFakeTerminalProcessAuthority(() => ({
+      pid: trackSyntheticPid(47_501),
+      exitOnSignal: "SIGTERM",
+    }));
+    const host = hostWith(fake);
+    host.create({ bindingId: "osc-query" });
+    fake.controllers[0]!.emitData(`${ESC}[?u${ESC}]7501;?${ST}${ESC}[c`);
+    expect(fake.controllers[0]!.writes).toEqual([PROGRAM_STATUS_QUERY_REPLY]);
+  });
+
+  it("holds the answer behind a managed submission span", () => {
+    const interlock = new OperatorInterlock();
+    const fake = makeFakeTerminalProcessAuthority(() => ({
+      pid: trackSyntheticPid(47_502),
+      exitOnSignal: "SIGTERM",
+    }));
+    const host = hostWith(fake, { operatorInterlock: interlock });
+    host.create({ bindingId: "osc-hold" });
+    interlock.beginHold("osc-hold");
+    fake.controllers[0]!.emitData(osc("?", BEL));
+    expect(fake.controllers[0]!.writes).toEqual([]);
+    interlock.endHold("osc-hold");
+    expect(fake.controllers[0]!.writes).toEqual([PROGRAM_STATUS_QUERY_REPLY]);
+  });
+
+  it("publishes each report as seat signals for its binding", () => {
+    const fake = makeFakeTerminalProcessAuthority(() => ({
+      pid: trackSyntheticPid(47_503),
+      exitOnSignal: "SIGTERM",
+    }));
+    const host = hostWith(fake);
+    const seen: SignalEnvelope[] = [];
+    host.onSeatSignal((envelope) => seen.push(envelope));
+    host.create({ bindingId: "osc-signal" });
+    const report = osc(`state=blocked:kind=permission:app=omp:msg=${b64("Run ls?")}`);
+    fake.controllers[0]!.emitData(report.slice(0, 12));
+    fake.controllers[0]!.emitData(report.slice(12));
+    expect(seen).toEqual([
+      expect.objectContaining({
+        seat: "osc-signal",
+        source: "osc7501",
+        fidelity: "native",
+        signal: { _tag: "PermissionRequested", detail: "Run ls?" },
+      }),
+    ]);
+  });
+
+  it("turns reporting on through the environment, and the seat's own value wins", () => {
+    const agent = (env?: Record<string, string>) =>
+      Result.getOrThrow(
+        resolveLaunch({
+          kind: "agent",
+          harness: "pi",
+          agentKey: "local:pi",
+          launch: { kind: "harness", argv: ["pi"], cwd: "/tmp", ...(env ? { env } : {}) },
+        }),
+      ).env;
+    expect(agent()).toMatchObject({ PI_PROGRAM_STATUS: "1", AGY_CLI_OSC7501: "on" });
+    expect(agent({ PI_PROGRAM_STATUS: "0" }).PI_PROGRAM_STATUS).toBe("0");
+  });
+});
