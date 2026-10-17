import { seedThisMachine, clearMachines } from "./support/seed-this-machine";
import { Result } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeProgramStatus,
  PROGRAM_STATUS_QUERY_REPLY,
  ProgramStatusScanner,
  programStatusEnvelopes,
  type ProgramStatusEvent,
} from "../src/main/junto/term/program-status";
import { LocalSessionHost, resolveLaunch } from "../src/main/junto/term/local-host";
import { OperatorInterlock } from "../src/main/junto/term/drive/operator-interlock";
import {
  makeProcessIdentityMap,
  setProcessIdentityMapForTests,
} from "../src/main/junto/process-identity";
import { setProcessEpochReaderForTests } from "../src/main/junto/process-epoch";
import {
  makeFakeTerminalProcessAuthority,
  type FakeTerminalProcessAuthority,
} from "./helpers/fake-terminal-process-authority";
import { installHermeticHarnessBins } from "./helpers/hermetic-harness-bins";
import {
  decodeSignalEnvelope,
  initialSnapshot,
  reduceSeatSignals,
  type SignalEnvelope,
} from "../src/shared/harness-domain";

const ESC = "\u001b";
const ST = `${ESC}\\`;
const BEL = "\u0007";
const b64 = (text: string): string => Buffer.from(text, "utf8").toString("base64");
const osc = (body: string, end = ST): string => `${ESC}]7501;${body}${end}`;

const scanAll = (chunks: readonly string[]): ProgramStatusEvent[] => {
  const scanner = new ProgramStatusScanner();
  return chunks.flatMap((chunk) => [...scanner.feed(chunk)]);
};

/** Exactly what the installed harnesses wrote on 2026-10-16 (see program-status.ts). */
const CAPTURED = {
  pi: [osc("state=idle:app=pi"), osc("state=working:app=pi"), osc("state=done:app=pi"), osc("state=clear")],
  omp: [
    osc("state=idle:app=omp"),
    osc("state=working:app=omp"),
    osc(
      "state=error:app=omp:msg=NDAwIFVwc3RyZWFtIHJlcXVlc3QgZmFpbGVkOiBNb2RlbCBpcyB1bmF2YWlsYWJsZS4gVXBzdHJlYW0gcmVxdWVzdCBmYWlsZWQ6IE1vZGVsIGlzIHVuYXZhaWxhYmxlLiAodHlwZT1zZXJ2ZXJfZXJyb3IpIHJhdy1odHRwLXJlcXVlc3Q9L1VzZXJzL2d1aWxoZXJtZWNhc3Ryby8ub21wL2xvZ3MvaHR0cC00MDAtcmVxdWVzdHMvMTc5MjIwNTYzMDAxNC0xYzl5b3hxOXJ1YW5wLmpzb24=",
    ),
    osc("state=clear"),
  ],
  agy: [
    osc("?", BEL),
    osc("state=blocked:kind=auth:app=antigravity:msg=U2lnbiBpbiByZXF1aXJlZA==", BEL),
    osc("state=blocked:kind=permission:app=antigravity:msg=VHJ1c3QgdGhpcyBmb2xkZXI/", BEL),
    osc("state=idle:app=antigravity", BEL),
    osc("state=working:app=antigravity", BEL),
    osc("state=done:app=antigravity:msg=b2s=", BEL),
  ],
  devin: [
    osc("state=idle:app=devin"),
    osc("state=working:app=devin:msg=VGhpbmtpbmc="),
    osc("state=working:app=devin:msg=VHlwaW5n"),
    osc("state=done:app=devin:msg=RGV2aW4gZmluaXNoZWQ="),
    osc("state=clear"),
  ],
} as const;

describe("program status: decoding by the spec's receiving rules", () => {
  it("reads state, kind, app and base64 msg in any order", () => {
    expect(decodeProgramStatus(`state=blocked:kind=question:app=omp:msg=${b64("Which branch?")}`)).toEqual({
      state: "blocked",
      kind: "question",
      app: "omp",
      msg: "Which branch?",
    });
    expect(decodeProgramStatus(`app=pi:state=working`)).toEqual({ state: "working", app: "pi" });
  });

  it("ignores a report whose state is missing or unknown", () => {
    expect(decodeProgramStatus("app=pi")).toBeUndefined();
    expect(decodeProgramStatus("state=paused:app=pi")).toBeUndefined();
  });

  it("lets the last repeated key win and skips malformed pairs", () => {
    expect(decodeProgramStatus("state=idle:state=working:junk:=x:BAD=1:app=pi")).toEqual({
      state: "working",
      app: "pi",
    });
    expect(decodeProgramStatus(" state = done : app = pi ")).toEqual({ state: "done", app: "pi" });
  });

  it("drops a kind on any state but blocked, and an unknown kind", () => {
    expect(decodeProgramStatus("state=working:kind=permission")).toEqual({ state: "working" });
    expect(decodeProgramStatus("state=blocked:kind=payment")).toEqual({ state: "blocked" });
  });

  it("keeps progress only as an integer 0 to 100 on working or blocked", () => {
    expect(decodeProgramStatus("state=working:progress=40")).toEqual({ state: "working", progress: 40 });
    expect(decodeProgramStatus("state=working:progress=140")).toEqual({ state: "working" });
    expect(decodeProgramStatus("state=done:progress=40")).toEqual({ state: "done" });
  });

  it("refuses the whole report when its text is not control-free UTF-8 base64", () => {
    expect(decodeProgramStatus("state=error:msg=a,b")).toBeUndefined();
    expect(decodeProgramStatus("state=error:msg=a")).toBeUndefined();
    // A byte outside the value set makes a malformed pair, which is skipped.
    expect(decodeProgramStatus("state=error:msg=***")).toEqual({ state: "error" });
    expect(decodeProgramStatus(`state=error:msg=${b64("line one\nline two")}`)).toBeUndefined();
    expect(decodeProgramStatus(`state=error:msg=${Buffer.from([0xff, 0xfe]).toString("base64")}`)).toBeUndefined();
    expect(decodeProgramStatus(`state=error:msg=${b64("x".repeat(2049))}`)).toBeUndefined();
  });

  it("accepts unpadded base64", () => {
    expect(decodeProgramStatus("state=error:msg=b2s")).toEqual({ state: "error", msg: "ok" });
  });

  it("refuses a malformed id instead of falling back to the root", () => {
    expect(decodeProgramStatus("state=working:id=build/test")).toEqual({ state: "working", id: "build/test" });
    expect(decodeProgramStatus("state=working:id=build//test")).toBeUndefined();
    expect(decodeProgramStatus(`state=working:id=${"a".repeat(33)}`)).toBeUndefined();
  });

  it("drops an app outside its charset", () => {
    expect(decodeProgramStatus(`state=idle:app=${"a".repeat(33)}`)).toEqual({ state: "idle" });
  });
});

describe("program status: scanning a PTY stream", () => {
  it("finds every report captured from pi, omp, agy and devin", () => {
    const states = (chunks: readonly string[]) =>
      scanAll([chunks.join("plain text between\r\n")]).map((event) =>
        event.type === "query" ? "?" : event.report.state,
      );
    expect(states(CAPTURED.pi)).toEqual(["idle", "working", "done", "clear"]);
    expect(states(CAPTURED.omp)).toEqual(["idle", "working", "error", "clear"]);
    expect(states(CAPTURED.agy)).toEqual(["?", "blocked", "blocked", "idle", "working", "done"]);
    expect(states(CAPTURED.devin)).toEqual(["idle", "working", "working", "done", "clear"]);
  });

  it("holds a sequence split anywhere across chunks, the terminator included", () => {
    const stream = `a${osc("state=working:app=pi")}b${osc("?", BEL)}c`;
    for (let cut = 1; cut < stream.length; cut += 1) {
      const events = scanAll([stream.slice(0, cut), stream.slice(cut)]);
      expect(events.map((event) => event.type)).toEqual(["report", "query"]);
    }
    const byteByByte = scanAll([...stream]);
    expect(byteByByte.map((event) => event.type)).toEqual(["report", "query"]);
  });

  it("lets another escape abort a sequence and start the next one", () => {
    const events = scanAll([`${ESC}]7501;state=idle${ESC}[0m${osc("state=done")}`]);
    expect(events).toEqual([{ type: "report", report: { state: "done" } }]);
  });

  it("drops a sequence past the 4096-byte limit and recovers after it", () => {
    const long = `${ESC}]7501;state=working:title=${"A".repeat(5000)}`;
    const events = scanAll([long.slice(0, 3000), long.slice(3000), `${ST}${osc("state=idle")}`]);
    expect(events).toEqual([{ type: "report", report: { state: "idle" } }]);
  });

  it("ignores other OSCs", () => {
    expect(scanAll([`${ESC}]0;title${BEL}${ESC}]9;4;3${BEL}${ESC}]75010;x${ST}`])).toEqual([]);
  });
});

describe("program status: seat signals", () => {
  const seat = "seat-osc";
  const fold = (chunks: readonly string[]) => {
    let clock = 1_000;
    const envelopes: SignalEnvelope[] = scanAll(chunks).flatMap((event) =>
      event.type === "report" ? [...programStatusEnvelopes(seat, (clock += 10), event.report)] : [],
    );
    for (const envelope of envelopes) {
      expect(Result.isSuccess(decodeSignalEnvelope(envelope))).toBe(true);
    }
    return { envelopes, snapshot: reduceSeatSignals(initialSnapshot(envelopes[0]!.seat, 0), envelopes) };
  };

  it("marks every envelope native OSC 7501", () => {
    const { envelopes } = fold([osc("state=working")]);
    expect(envelopes).toEqual([
      expect.objectContaining({ source: "osc7501", fidelity: "native", signal: { _tag: "ActivityObserved", activity: "working" } }),
    ]);
  });

  it("reads a finished pi turn as an unseen completed turn, then a closed channel", () => {
    const { snapshot } = fold(CAPTURED.pi);
    expect(snapshot.status).toEqual({ _tag: "Idle" });
    expect(snapshot.turnUnseen?.outcome).toBe("completed");
    expect(snapshot.channels).not.toContain("osc7501");
  });

  it("records omp's failure text and ends the turn failed", () => {
    const { snapshot } = fold(CAPTURED.omp.slice(0, 3));
    expect(snapshot.lastError?.kind).toBe("unknown");
    expect(snapshot.lastError?.message).toMatch(/^400 Upstream request failed: Model is unavailable/);
    expect(snapshot.turnUnseen?.outcome).toBe("failed");
    expect(snapshot.status).toEqual({ _tag: "Idle" });
  });

  it("maps blocked kinds to permission, question, login and an unknown dialog", () => {
    const signal = (body: string) => fold([osc(body)]).envelopes.map((envelope) => envelope.signal);
    expect(signal(`state=blocked:kind=permission:msg=${b64("Trust this folder?")}`)).toEqual([
      { _tag: "PermissionRequested", detail: "Trust this folder?" },
    ]);
    expect(signal(`state=blocked:kind=question:msg=${b64("Which branch?")}`)).toEqual([
      { _tag: "QuestionAsked", text: "Which branch?" },
    ]);
    expect(signal("state=blocked:kind=auth")).toEqual([{ _tag: "DialogShown", kind: "login" }]);
    expect(signal("state=blocked")).toEqual([{ _tag: "DialogShown", kind: "unknown" }]);
  });

  it("never carries a working or done msg: agy puts the model's answer there", () => {
    const { envelopes } = fold(CAPTURED.agy);
    expect(JSON.stringify(envelopes)).not.toContain('"ok"');
    expect(envelopes.at(-1)?.signal).toEqual({ _tag: "TurnEnded", outcome: "completed" });
  });

  it("says nothing for a child record or a clear aimed at one", () => {
    expect(programStatusEnvelopes(seat, 1, { state: "blocked", id: "build" })).toEqual([]);
    expect(programStatusEnvelopes(seat, 1, { state: "clear", id: "build" })).toEqual([]);
  });
});

// ── The host answers the query and publishes signals ─────────────────────

const hosts: LocalSessionHost[] = [];
const syntheticEpochs = new Map<number, string>();
let restoreHarnessBins: () => void = () => undefined;

const trackSyntheticPid = (pid: number): number => {
  syntheticEpochs.set(pid, `synthetic-${pid}`);
  return pid;
};

const hostWith = (
  fake: FakeTerminalProcessAuthority,
  options: ConstructorParameters<typeof LocalSessionHost>[1] = {},
): LocalSessionHost => {
  const host = new LocalSessionHost(fake.authority, {
    killGraceMs: 5,
    shutdownGraceMs: 5,
    lateExitGraceMs: 5,
    ...options,
  });
  hosts.push(host);
  return host;
};

beforeEach(() => {
  seedThisMachine();
  syntheticEpochs.clear();
  restoreHarnessBins = installHermeticHarnessBins();
  setProcessEpochReaderForTests({
    snapshot: () =>
      [...syntheticEpochs].map(([pid, startKey]) => ({
        pid,
        processGroupId: Math.max(2, pid - 1),
        sessionId: 7,
        startKey,
      })),
  });
  setProcessIdentityMapForTests(
    makeProcessIdentityMap({
      processAlive: (pid) => pid === process.pid || syntheticEpochs.has(pid),
      readProcessStartKey: (pid) => (pid === process.pid ? `self-${pid}` : syntheticEpochs.get(pid)),
    }),
  );
});

afterEach(async () => {
  restoreHarnessBins();
  for (const host of hosts.splice(0)) await host.shutdownAll("test_cleanup");
  setProcessEpochReaderForTests(undefined);
  setProcessIdentityMapForTests(undefined);
  vi.unstubAllEnvs();
  clearMachines();
});

describe("program status: the seat's terminal", () => {
  it("answers the support query before the DA1 that follows it, in the same tick", () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(47_501),
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake);
    host.create({ bindingId: "osc-query" });
    fake.controllers[0]!.emitData(`${ESC}[?u${ESC}]7501;?${ST}${ESC}[c`);
    expect(fake.controllers[0]!.writes).toEqual([PROGRAM_STATUS_QUERY_REPLY]);
  });

  it("holds the answer behind a managed submission span", () => {
    const interlock = new OperatorInterlock();
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(47_502),
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake, { operatorInterlock: interlock });
    host.create({ bindingId: "osc-hold" });
    interlock.beginHold("osc-hold");
    fake.controllers[0]!.emitData(osc("?", BEL));
    expect(fake.controllers[0]!.writes).toEqual([]);
    interlock.endHold("osc-hold");
    expect(fake.controllers[0]!.writes).toEqual([PROGRAM_STATUS_QUERY_REPLY]);
  });

  it("publishes each report as seat signals for its binding", () => {
    const fake = makeFakeTerminalProcessAuthority(() => ({
      pid: trackSyntheticPid(47_503),
      exitOnSignal: "SIGTERM",
    }));
    const host = hostWith(fake);
    const seen: SignalEnvelope[] = [];
    host.onSeatSignal((envelope) => seen.push(envelope));
    host.create({ bindingId: "osc-signal" });
    const report = osc(`state=blocked:kind=permission:app=omp:msg=${b64("Run ls?")}`);
    fake.controllers[0]!.emitData(report.slice(0, 12));
    fake.controllers[0]!.emitData(report.slice(12));
    expect(seen).toEqual([
      expect.objectContaining({
        seat: "osc-signal",
        source: "osc7501",
        fidelity: "native",
        signal: { _tag: "PermissionRequested", detail: "Run ls?" },
      }),
    ]);
  });

  it("turns reporting on through the environment, and the seat's own value wins", () => {
    const agent = (env?: Record<string, string>) =>
      Result.getOrThrow(
        resolveLaunch({
          kind: "agent",
          harness: "pi",
          agentKey: "local:pi",
          launch: { kind: "harness", argv: ["pi"], cwd: "/tmp", ...(env ? { env } : {}) },
        }),
      ).env;
    expect(agent()).toMatchObject({ PI_PROGRAM_STATUS: "1", AGY_CLI_OSC7501: "on" });
    expect(agent({ PI_PROGRAM_STATUS: "0" }).PI_PROGRAM_STATUS).toBe("0");
  });
});
