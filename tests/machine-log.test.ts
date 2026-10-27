import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { Cause, Context, Deferred, Effect, Layer, Logger, ManagedRuntime, Schema } from "effect";
import { MachineLogRow, type MachineLogRow as Row } from "../src/shared/machine-log";
import {
  closeMachineLog,
  installMachineLog,
  ObservabilityLoggerLive,
  recordRendererConsole,
  setLogMachine,
  withMachineLogger,
  writeLog,
} from "../src/main/junto/observability/logger";
import { machineLogDir, openMachineLogSink, readMachineLog, seatLogScope } from "../src/main/junto/observability/log-file";

const homes: string[] = [];
const freshHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "junto-log-"));
  homes.push(home);
  return home;
};

afterEach(() => {
  closeMachineLog();
  delete process.env.JUNTO_TEST_LOG_SECRET;
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const rowsOf = (home: string, process: "app" | "core" = "core"): ReadonlyArray<Row> =>
  readFileSync(join(machineLogDir(home), `${process}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => Schema.decodeUnknownSync(MachineLogRow, { onExcessProperty: "error" })(JSON.parse(line)));

class SpawnRefused extends Schema.TaggedError<SpawnRefused>()("SpawnRefused", {
  harness: Schema.String,
  message: Schema.String,
}) {}

describe("machine log file", () => {
  it("keeps the directory 0700 and the file 0600", () => {
    const home = freshHome();
    installMachineLog({ home, process: "core", echo: false });
    writeLog({ level: "info", source: "system", message: "started" });
    expect(statSync(machineLogDir(home)).mode & 0o777).toBe(0o700);
    expect(statSync(join(machineLogDir(home), "core.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("writes one decodable row with machine, process, area and the lifted annotations", () => {
    const home = freshHome();
    installMachineLog({ home, process: "core", echo: false });
    setLogMachine("mini");
    writeLog({
      level: "error",
      source: "effect",
      message: "seat start failed",
      annotations: { area: "seats", operationId: "op-1", seat: "agent-1", canvas: "factory", harness: "claude" },
      failure: Cause.fail(new SpawnRefused({ harness: "claude", message: "native PTY backend is unavailable" })),
    });
    const [row] = rowsOf(home);
    expect(row).toMatchObject({
      level: "error", machine: "mini", process: "core", source: "effect", area: "seats",
      operationId: "op-1", seat: "agent-1", canvas: "factory", annotations: { harness: "claude" },
      failure: { tag: "SpawnRefused", message: "native PTY backend is unavailable", machine: "mini", operationId: "op-1" },
    });
  });

  it("takes a console row's area from its [prefix] and its failure from an Error argument", () => {
    const home = freshHome();
    installMachineLog({ home, process: "app", echo: false });
    writeLog({ level: "error", source: "main", message: "[kernel] evaluation cycle failed:", failure: new Error("disk I/O error") });
    writeLog({ level: "info", source: "main", message: "no prefix here" });
    const [prefixed, plain] = rowsOf(home, "app");
    expect(prefixed).toMatchObject({ area: "kernel", failure: { tag: "Error", message: "disk I/O error" } });
    expect(plain?.area).toBe("main");
  });

  it("takes a renderer console row's area from its [prefix] too", () => {
    const home = freshHome();
    installMachineLog({ home, process: "app", echo: false });
    recordRendererConsole({ level: "info", message: "[boot] canvas list started at 412 ms", sourceId: "app.js", lineNumber: 9 });
    recordRendererConsole({ level: "warning", message: "layout thrash" });
    const [prefixed, plain] = rowsOf(home, "app");
    expect(prefixed).toMatchObject({ source: "renderer", area: "boot", level: "info" });
    expect(plain).toMatchObject({ source: "renderer", area: "renderer", level: "warn" });
  });

  it("scrubs a known environment value and credential shapes from message, annotations and failure", () => {
    const home = freshHome();
    const secret = "hunter2-correct-horse";
    process.env.JUNTO_TEST_LOG_SECRET = secret;
    installMachineLog({ home, process: "core", echo: false });
    writeLog({
      level: "error",
      source: "main",
      message: `[link] refused ${secret} Authorization: Bearer abc.def token=sk-live-123456`,
      annotations: { detail: `value ${secret}` },
      failure: new Error(`spawn failed with ${secret} and ghp_abcdefghijklmnop0123`),
    });
    const text = readFileSync(join(machineLogDir(home), "core.jsonl"), "utf8");
    expect(text).not.toContain(secret);
    expect(text).not.toContain("abc.def");
    expect(text).not.toContain("sk-live-123456");
    expect(text).not.toContain("ghp_abcdefghijklmnop0123");
    expect(text).toContain("[redacted]");
  });

  it("redacts a known value with spaces that straddles the cut", () => {
    const home = freshHome();
    const passphrase = "correct horse battery staple";
    process.env.JUNTO_TEST_LOG_SECRET = passphrase;
    installMachineLog({ home, process: "core", echo: false });
    writeLog({ level: "error", source: "system", message: `${"word ".repeat(306)}${passphrase} tail` });
    const text = readFileSync(join(machineLogDir(home), "core.jsonl"), "utf8");
    expect(text).not.toContain("correct");
    expect(text).not.toContain("horse");
  });

  it("strips escape sequences and keeps a row within 16 KiB", () => {
    const home = freshHome();
    installMachineLog({ home, process: "core", echo: false });
    writeLog({
      level: "warn",
      source: "system",
      message: `\u001b[31mred\u001b[0m ${"x".repeat(50_000)}`,
      annotations: Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, "y".repeat(5_000)])),
    });
    const line = readFileSync(join(machineLogDir(home), "core.jsonl"), "utf8").trimEnd();
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(16 * 1024);
    const [row] = rowsOf(home);
    expect(row?.message.startsWith("red ")).toBe(true);
    expect(Object.keys(row?.annotations ?? {}).length).toBeLessThanOrEqual(16);
  });

  it("does not write debug rows to the file", () => {
    const home = freshHome();
    installMachineLog({ home, process: "core", echo: false });
    writeLog({ level: "debug", source: "system", message: "chatter" });
    writeLog({ level: "info", source: "system", message: "kept" });
    expect(rowsOf(home).map((row) => row.message)).toEqual(["kept"]);
  });

  it("rotates and bounds the files", () => {
    const home = freshHome();
    const sink = openMachineLogSink({ home, process: "core", maxFileBytes: 1_000, keptFiles: 2 });
    for (let i = 0; i < 100; i += 1) sink.write(JSON.stringify({ i, pad: "z".repeat(80) }));
    sink.close();
    const files = readdirSync(machineLogDir(home)).sort();
    expect(files).toEqual(["core.1.jsonl", "core.2.jsonl", "core.jsonl"]);
    for (const file of files) expect(statSync(join(machineLogDir(home), file)).size).toBeLessThanOrEqual(1_000);
  });

  it("routes Effect logs through the same row", async () => {
    const home = freshHome();
    installMachineLog({ home, process: "app", echo: false });
    const runtime = ManagedRuntime.make(Layer.mergeAll(ObservabilityLoggerLive));
    await runtime.runPromise(
      Effect.logError("the link closed", Cause.fail(new SpawnRefused({ harness: "codex", message: "harness not installed" }))).pipe(
        Effect.annotateLogs({ area: "link", operationId: "op-9" }),
        Effect.withLogSpan("link.request"),
      ),
    );
    await runtime.dispose();
    const [row] = rowsOf(home, "app");
    expect(row).toMatchObject({ area: "link", operationId: "op-9", spans: ["link.request"], failure: { tag: "SpawnRefused" } });
    expect(Logger).toBeDefined();
  });

  it("logs from a fiber a service forks while its layer builds, with the link ids whole", async () => {
    const home = freshHome();
    installMachineLog({ home, process: "core", echo: false });
    setLogMachine("mini");
    class LinkProbe extends Context.Service<LinkProbe, { readonly opened: Deferred.Deferred<void> }>()("test/LinkProbe") {}
    // The shape of the mini's real "link opened" row (rerun 7b829b7d9), with fresh ids.
    const opened = {
      area: "link", machine: "mini", sessionId: "3f6b2d1e-8c4a-4e9f-b7d2-5a1c9e0f3b6d", peer: "guilhermes-macbook-pro-2",
      peerBuild: "7b829b7d9e4c1a2f3b5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3", peerInstallationId: "01M4FX7HGTF3MYC3R771Y12MRX",
    };
    const service = Layer.effect(LinkProbe, Effect.gen(function* () {
      const done = yield* Deferred.make<void>();
      yield* Effect.forkDetach(Effect.logInfo("link opened").pipe(Effect.annotateLogs(opened), Effect.andThen(Deferred.succeed(done, undefined))));
      return { opened: done };
    }));
    const runtime = ManagedRuntime.make(withMachineLogger(service));
    await runtime.runPromise(Effect.flatMap(LinkProbe, (probe) => Deferred.await(probe.opened)));
    await runtime.dispose();
    const [row] = rowsOf(home, "core");
    expect(row).toMatchObject({ source: "effect", area: "link", message: "link opened", machine: "mini", annotations: {
      machine: "mini", peer: "guilhermes-macbook-pro-2",
      sessionId: opened.sessionId, peerBuild: opened.peerBuild, peerInstallationId: opened.peerInstallationId,
    } });
  });
});

describe("row ids", () => {
  it("keeps Junto ids as typed fields and drops ids that are not valid", () => {
    const home = freshHome();
    installMachineLog({ home, process: "core", echo: false });
    writeLog({ level: "info", source: "effect", message: "a", annotations: { seat: "agent-01M4G59ER01QPV3WBTEK3Z84TP", canvas: "factory" } });
    writeLog({ level: "info", source: "effect", message: "b", annotations: { seat: "not a seat id", canvas: "Not A Canvas" } });
    const [kept, dropped] = rowsOf(home);
    expect(kept).toMatchObject({ seat: "agent-01M4G59ER01QPV3WBTEK3Z84TP", canvas: "factory" });
    expect(dropped?.seat).toBeUndefined();
    expect(dropped?.canvas).toBeUndefined();
  });

  it("keeps link ids in annotations as they are, while a credential-id UUID in text is still redacted", () => {
    const home = freshHome();
    installMachineLog({ home, process: "core", echo: false });
    const sessionId = "6f1c2b9e-3d4a-4f5b-8c7d-0e1f2a3b4c5d";
    const credentialId = "12345678-1234-1234-1234-123456789012";
    process.env.JUNTO_TEST_LOG_SECRET = "generation-secret-value";
    writeLog({ level: "info", source: "effect", message: `vault/credentials/${credentialId} refused`, annotations: {
      area: "link", sessionId, requestId: "7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d", peerInstallationId: "mini-install:01",
      operationId: "status.read", bindingId: "binding-1", generation: "generation-secret-value", note: credentialId,
    } });
    writeLog({ level: "info", source: "effect", message: "b", annotations: { sessionId: "token=abc def", peerInstallationId: "-bad" } });
    const [kept, dropped] = rowsOf(home);
    expect(kept?.annotations).toMatchObject({
      sessionId, requestId: "7a8b9c0d-1e2f-4a3b-9c4d-5e6f7a8b9c0d", peerInstallationId: "mini-install:01", bindingId: "binding-1",
    });
    expect(kept?.operationId).toBe("status.read");
    // A known secret value is never let through as an id; other text keeps every scrub rule.
    expect(kept?.annotations?.generation).toBeUndefined();
    expect(kept?.message).not.toContain(credentialId);
    expect(kept?.annotations?.note).not.toContain(credentialId);
    expect(dropped?.annotations).toBeUndefined();
  });

  it("files a failure under the seat its detail names, so another seat cannot read it", async () => {
    const home = freshHome();
    installMachineLog({ home, process: "core", echo: false });
    setLogMachine("mini");
    writeLog({
      level: "error", source: "effect", message: "seat start failed", annotations: { area: "link" },
      failure: new Error("harness exited during start"), detail: { seatId: "agent-other" },
    });
    writeLog({
      level: "error", source: "effect", message: "peer said no", annotations: { area: "link" },
      failure: { tag: "SeatsFailure", message: "spawn failed", machine: "laptop", causes: [], detail: { seatId: "agent-other" } },
    });
    closeMachineLog();
    const rows = rowsOf(home);
    expect(rows.map((row) => row.seat)).toEqual(["agent-other", "agent-other"]);
    expect(rows[1]?.failure).toMatchObject({ tag: "SeatsFailure", machine: "laptop", detail: { seatId: "agent-other" } });
    const withheld = await Effect.runPromise(readMachineLog(home, "mini", { area: "link" }, seatLogScope(new Set(["agent-me"]))));
    expect(withheld.rows).toEqual([]);
    const own = await Effect.runPromise(readMachineLog(home, "mini", { area: "link" }, seatLogScope(new Set(["agent-other"]))));
    expect(own.rows).toHaveLength(2);
  });

  it("withholds a row whose stored detail names another seat even when the row has no seat", async () => {
    const home = freshHome();
    const dir = machineLogDir(home);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "core.jsonl"), `${JSON.stringify({
      time: "2026-10-16T10:00:00.000Z", level: "error", machine: "mini", process: "core", source: "effect", area: "link",
      message: "old row", failure: { tag: "SeatsFailure", message: "spawn failed", machine: "mini", causes: [], detail: { seatId: "agent-other" } },
    })}\n`, { mode: 0o600 });
    const read = await Effect.runPromise(readMachineLog(home, "mini", {}, seatLogScope(new Set(["agent-me"]))));
    expect(read.rows).toEqual([]);
  });

  it("keeps an encoded failure given as a log annotation as the row's failure", async () => {
    const home = freshHome();
    installMachineLog({ home, process: "app", echo: false });
    const runtime = ManagedRuntime.make(ObservabilityLoggerLive);
    const failure = { tag: "LinkClosed", message: "the peer closed the link", machine: "mini", causes: [{ tag: "SpawnRefused", message: "harness not installed" }] };
    await runtime.runPromise(Effect.logWarning("machine status failed").pipe(Effect.annotateLogs({ area: "link", peer: "mini", failure })));
    await runtime.dispose();
    const [row] = rowsOf(home, "app");
    expect(row).toMatchObject({ area: "link", failure, annotations: { peer: "mini" } });
    expect(row?.annotations?.failure).toBeUndefined();
  });

  it("withholds from seats a row whose detail names a seat that does not validate; the owner still reads it", async () => {
    const home = freshHome();
    installMachineLog({ home, process: "core", echo: false });
    setLogMachine("mini");
    writeLog({
      level: "error", source: "effect", message: "odd detail", annotations: { area: "link" },
      failure: new Error("spawn failed"), detail: { seatId: "not a seat id" },
    });
    closeMachineLog();
    const seatRead = await Effect.runPromise(readMachineLog(home, "mini", {}, seatLogScope(new Set(["agent-me"]))));
    expect(seatRead.rows).toEqual([]);
    const ownerRead = await Effect.runPromise(readMachineLog(home, "mini", {}));
    expect(ownerRead.rows.map((row) => row.message)).toEqual(["odd detail"]);
  });
});

describe("console hook", () => {
  it("routes console.* into the scrubbed row and, without echo, prints nothing", () => {
    const home = freshHome();
    const logger = join(__dirname, "../src/main/junto/observability/logger.ts");
    const script = [
      `const { installMachineLog, installObservabilityConsoleHook } = await import(${JSON.stringify(logger)});`,
      `installMachineLog({ home: ${JSON.stringify(home)}, process: "core", echo: false });`,
      "installObservabilityConsoleHook({ echo: false });",
      "console.error(\"[budget] held the main thread\", new Error(\"secret is \" + process.env.JUNTO_TEST_LOG_SECRET));",
      "console.log(\"plain\", { a: 1 });",
    ].join("\n");
    const child = spawnSync("bun", ["-e", script], {
      cwd: join(__dirname, ".."),
      env: { ...process.env, JUNTO_TEST_LOG_SECRET: "child-secret-value" },
      encoding: "utf8",
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("");
    expect(child.stderr).toBe("");
    const rows = rowsOf(home);
    expect(rows).toMatchObject([
      { level: "error", source: "main", area: "budget", message: "[budget] held the main thread", failure: { tag: "Error" } },
      { level: "info", area: "main", message: "plain {\"a\":1}" },
    ]);
    expect(JSON.stringify(rows)).not.toContain("child-secret-value");
  });
});

describe("reading the machine log", () => {
  const seed = (home: string): void => {
    installMachineLog({ home, process: "core", echo: false });
    setLogMachine("mini");
    const at = Date.parse("2026-10-16T10:00:00.000Z");
    writeLog({ level: "info", source: "system", message: "machine row", ts: at });
    writeLog({ level: "error", source: "effect", message: "mine", annotations: { area: "seats", seat: "agent-me", operationId: "op-a" }, ts: at + 1 });
    writeLog({ level: "error", source: "effect", message: "watched", annotations: { area: "seats", seat: "agent-watched" }, ts: at + 2 });
    writeLog({ level: "error", source: "effect", message: "hidden", annotations: { area: "seats", seat: "agent-other" }, ts: at + 3 });
    writeLog({ level: "warn", source: "effect", message: "link", annotations: { area: "link", operationId: "op-a" }, ts: at + 4 });
    closeMachineLog();
  };

  it("filters by level, area, operation id and time, oldest first", async () => {
    const home = freshHome();
    seed(home);
    const errors = await Effect.runPromise(readMachineLog(home, "mini", { level: "error" }));
    expect(errors.rows.map((row) => row.message)).toEqual(["mine", "watched", "hidden"]);
    const byOperation = await Effect.runPromise(readMachineLog(home, "mini", { operationId: "op-a" }));
    expect(byOperation.rows.map((row) => row.message)).toEqual(["mine", "link"]);
    const since = await Effect.runPromise(readMachineLog(home, "mini", { since: Date.parse("2026-10-16T10:00:00.003Z") }));
    expect(since.rows.map((row) => row.message)).toEqual(["hidden", "link"]);
    const last = await Effect.runPromise(readMachineLog(home, "mini", { limit: 1 }));
    expect(last).toMatchObject({ machine: "mini", cut: true, rows: [{ message: "link" }] });
  });

  it("shows a seat its own rows, rows of seats it may read, and rows naming no seat", async () => {
    const home = freshHome();
    seed(home);
    const read = await Effect.runPromise(
      readMachineLog(home, "mini", {}, seatLogScope(new Set(["agent-me", "agent-watched"]))),
    );
    expect(read.rows.map((row) => row.message)).toEqual(["machine row", "mine", "watched", "link"]);
    // The scope runs before the limit: a hidden row never takes a visible one's place.
    const newest = await Effect.runPromise(
      readMachineLog(home, "mini", { area: "seats", limit: 1 }, seatLogScope(new Set(["agent-me"]))),
    );
    expect(newest.rows.map((row) => row.message)).toEqual(["mine"]);
  });

  it("counts lines that do not decode and reads an absent log as empty", async () => {
    const home = freshHome();
    seed(home);
    writeFileSync(join(machineLogDir(home), "app.jsonl"), "not json\n{\"time\":\"x\"}\n", { mode: 0o600 });
    const read = await Effect.runPromise(readMachineLog(home, "mini", {}));
    expect(read.unreadable).toBe(2);
    const empty = await Effect.runPromise(readMachineLog(freshHome(), "mini", {}));
    expect(empty).toEqual({ machine: "mini", rows: [], cut: false, unreadable: 0 });
  });
});
