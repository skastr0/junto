/**
 * Native CLI parity (0.12 native CLI, N2): each case runs through the
 * TypeScript CLI and the native binary against one stand-in work socket. The
 * frames on the wire, stdout and the exit code match byte for byte; a failure
 * matches on what an agent acts on: its type, next_step and retryable (the
 * runtime decodes every request again, so a drifted message is a worse error,
 * never a wrong action). A ULID either side mints reads as <ULID>.
 *
 * Beside the hand cases, every entry of the `junto examples` corpus runs
 * through both paths: that is the drift guard, and its count is the port's
 * progress.
 *
 *   bun scripts/native-cli-parity.ts [--bin native/cli/target/release/junto] [--only <command prefix>]
 *
 * Without --bin it builds the crate first. Exits 1 on any difference.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allExamples } from "../src/cli/core/discovery";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binFlag = process.argv.indexOf("--bin");
const bin = binFlag >= 0 ? resolve(process.argv[binFlag + 1]!) : resolve(root, "native/cli/target/release/junto");
if (binFlag < 0) {
  const built = spawnSync("cargo", ["build", "--locked", "--release"], { cwd: resolve(root, "native/cli"), stdio: "inherit" });
  if (built.status !== 0) throw new Error("native CLI build failed");
}

// A short home: a Unix socket path must stay under 104 bytes on macOS.
const home = mkdtempSync(join(tmpdir(), "jp-"));
const noHome = join(home, "absent");
const SERVER_ID = "01M65A00M174ZD80B991YMNB97";

type Answer = string | "silent" | "close" | "garbage" | "stream-oversize";
let answer: (frame: { op: string; args: unknown }) => Answer = () => "silent";
let frames: string[] = [];

const ok = (op: string, data: unknown) => JSON.stringify({ ok: true, op, data, protocol_version: "junto/work-control/v1" });
const err = (op: string, error: unknown) => JSON.stringify({ ok: false, op, error, protocol_version: "junto/work-control/v1" });
const delivered = (frame: { op: string }) =>
  ok(frame.op, { messageId: SERVER_ID, delivered: true, n: 1.5, big: 1e21, small: 1e-7, s: "é \u0001\"", nested: { z: [null, false] } });

/** content.stage as main answers it: a piece keeps the upload open, `done` closes it with the ref; any other op is delivered. */
const staged = (frame: { op: string; args: unknown }) => {
  if (frame.op !== "content.stage") return delivered(frame);
  const { done } = frame.args as { done?: { mediaType: string; displayName?: string; expected: { sha256: string; byteLength: number } } };
  return done === undefined
    ? ok(frame.op, { stageId: `stg_${"0".repeat(32)}`, byteLength: 1 })
    : ok(frame.op, { ref: { ...done.expected, mediaType: done.mediaType, ...(done.displayName === undefined ? {} : { displayName: done.displayName }) } });
};

const server = createServer((socket: Socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const nl = buffer.indexOf("\n");
    if (nl < 0) return;
    const line = buffer.slice(0, nl);
    frames.push(line);
    const reply = answer(JSON.parse(line));
    if (reply === "silent") return;
    if (reply === "close") return void socket.end();
    if (reply === "garbage") return void socket.end("not json\n");
    socket.end(`${reply}\n`);
  });
  socket.on("error", () => {});
});
await new Promise<void>((done) => server.listen(join(home, "control.sock"), done));

interface Case {
  readonly name: string;
  readonly argv: ReadonlyArray<string>;
  readonly stdin?: string | Buffer;
  readonly answer?: typeof answer;
  readonly env?: Record<string, string | undefined>;
}

const onlyFlag = process.argv.indexOf("--only");
const only = onlyFlag >= 0 ? process.argv[onlyFlag + 1]! : undefined;
// The TypeScript path runs on the shipped feature profile, as the packaged CLI is built.
const shipDefines = spawnSync("bun", ["scripts/build-features.ts", "--bun-define-args"], { cwd: root, encoding: "utf8" })
  .stdout.trim().split("\n").filter((line) => line.length > 0);

const opId = "01M659BSENNDDPSF5T18QBAWV1";
const file = join(home, "reply.json");
writeFileSync(file, JSON.stringify({ target: "peer", text: "from a file", inReplyTo: SERVER_ID }));

const handCases: ReadonlyArray<Case> = [
  { name: "send", argv: ["msg", "send", '{"target":"peer","text":"hello"}'], answer: delivered },
  { name: "send shorthand", argv: ["msg", "send", "peer", "hi \"there\" é\n\ttab"], answer: delivered },
  { name: "send prompt", argv: ["msg", "send", "--prompt", "peer", "a prompt"], answer: delivered },
  { name: "send prompt excess key", argv: ["msg", "send", "--prompt", `{"target":"p","text":"t","opId":"${opId}"}`], answer: delivered },
  { name: "send keys reordered, extras dropped", argv: ["msg", "send", `{"threadId":"th","x":1,"refs":[{"line":3.0,"path":"a","kind":"file","q":1},{"sha":"s","kind":"commit"}],"text":"t","target":"p","taskId":"k","subject":"s"}`], answer: delivered },
  { name: "send escapes and surrogates", argv: ["msg", "send", '{"target":"p","text":"\\u00e9 \\ud83d\\ude00 \\u2028 \\/ \\u001f"}'], answer: delivered },
  { name: "send given opId", argv: ["msg", "send", `{"target":"p","text":"t","opId":"${opId}"}`], answer: delivered },
  { name: "reply", argv: ["msg", "reply", `{"target":"peer","text":"ok","inReplyTo":"${SERVER_ID}"}`], answer: delivered },
  { name: "reply from a file", argv: ["msg", "reply", `@${file}`], answer: delivered },
  { name: "reply from stdin", argv: ["msg", "reply", "-"], stdin: `{"target":"p","text":"in","inReplyTo":"${SERVER_ID}"}`, answer: delivered },
  { name: "reply from stdin, @-, with a BOM", argv: ["msg", "reply", "@-"], stdin: `﻿{"target":"p","text":"in","inReplyTo":"${SERVER_ID}"}`, answer: delivered },
  { name: "batch of three", argv: ["msg", "send", '[{"target":"a","text":"1"},{"target":"b","text":"2"},{"target":"c","text":"3"}]', "--concurrency", "2"], answer: delivered },
  { name: "batch partial", argv: ["msg", "send", '[{"target":"a","text":"1"},{"target":"b"}]'], answer: delivered },
  { name: "batch all failed", argv: ["msg", "send", '[{"text":"1"},{"target":"b","text":2}]'], answer: delivered },
  { name: "batch all failed, retryable", argv: ["msg", "reply", '[{"target":"a","text":"1","inReplyTo":"x"},{"target":"b","text":"2","inReplyTo":"y"}]', "--timeout=300"], answer: () => "silent" },
  { name: "item refused", argv: ["msg", "reply", '{"target":"a","text":"t","refs":[{"kind":"file","path":"p","line":0}],"inReplyTo":"i"}'], answer: delivered },
  { name: "server refuses, details in its order", argv: ["msg", "send", "peer", "x"], answer: (f) => err(f.op, { type: "UnknownTarget", message: "no seat", details: { retryable: false, candidates: [{ name: "n", nodeId: "agent-1", kind: "agent" }], target: "peer", path: "args.target" } }) },
  { name: "server AuthError", argv: ["msg", "send", "peer", "x"], answer: (f) => err(f.op, { type: "AuthError", message: "seat gone", details: { retryable: false, next_step: "restart the seat" } }) },
  { name: "server RuntimeDown", argv: ["msg", "send", "peer", "x"], answer: (f) => err(f.op, { type: "RuntimeDown", message: "shutting down" }) },
  { name: "server unknown error type", argv: ["msg", "send", "peer", "x"], answer: (f) => err(f.op, { type: "Weird", message: "m" }) },
  { name: "server extra key", argv: ["msg", "send", "peer", "x"], answer: (f) => JSON.stringify({ ok: true, op: f.op, data: 1, extra: 1 }) },
  { name: "server non-JSON", argv: ["msg", "send", "peer", "x"], answer: () => "garbage" },
  { name: "server closes", argv: ["msg", "reply", `{"target":"a","text":"t","inReplyTo":"i"}`], answer: () => "close" },
  { name: "server silent", argv: ["msg", "send", "--timeout", "300", "--prompt", "peer", "x"], answer: () => "silent" },
  { name: "no runtime", argv: ["msg", "send", "peer", "x"], env: { JUNTO_WORK_HOME: noHome } },
  { name: "no credential", argv: ["msg", "send", "peer", "x"], env: { JUNTO_WORK_TOKEN: "  " } },
  { name: "concurrency zero", argv: ["msg", "reply", "{}", "--concurrency", "0"] },
  { name: "empty input", argv: ["msg", "reply", " "] },
  { name: "bad JSON", argv: ["msg", "reply", "{bad"] },
  { name: "bad JSON in a file", argv: ["msg", "reply", `@${join(home, "control.sock")}`] },
  { name: "missing file", argv: ["msg", "reply", `@${join(home, "nope.json")}`] },
  { name: "@ alone", argv: ["msg", "reply", "@"] },
  { name: "not an object", argv: ["msg", "reply", "5"] },
  { name: "array of non-objects", argv: ["msg", "reply", "[1]"] },
];

// Each example as an agent would type it; one read from stdin gets its input there.
const exampleCases: ReadonlyArray<Case> = allExamples.flatMap((example) =>
  example.args === undefined
    ? []
    : [{
        name: `example ${example.command}: ${example.name}`,
        argv: example.args,
        ...(example.args.some((a) => a === "-" || a === "@-") ? { stdin: JSON.stringify(example.input ?? {}) } : {}),
        answer: staged,
      }]);

const cases = [...handCases, ...exampleCases].filter((c) => only === undefined || c.argv.join(" ").startsWith(only));

// --list prints each case's name and argv, for coverage reports, and runs none.
if (process.argv.includes("--list")) {
  process.stdout.write(`${JSON.stringify(cases.map(({ name, argv }) => ({ name, argv })))}\n`);
  server.close();
  rmSync(home, { recursive: true, force: true });
  process.exit(0);
}

const ULID = /[0-9A-HJKMNP-TV-Z]{26}/g;
const normal = (text: string, keep: ReadonlySet<string>) => text.replace(ULID, (id) => (keep.has(id) ? id : "<ULID>"));

/** What an agent acts on in a failure envelope. */
const acted = (stderr: string) => {
  try {
    const last = stderr.trimEnd().split("\n").at(-1) ?? "";
    const { ok, command, error } = JSON.parse(last) as { ok: boolean; command?: string; error: { type: string; details?: { next_step?: string; retryable?: boolean } } };
    return { ok, command, type: error.type, next_step: error.details?.next_step, retryable: error.details?.retryable };
  } catch {
    return stderr;
  }
};

// Async: the stand-in socket answers on this process's event loop.
/** Stdout with every error's message dropped: a batch row is acted on by its type. */
const actedOut = (stdout: string) => {
  try {
    return JSON.stringify(JSON.parse(stdout, (key, value) =>
      value !== null && typeof value === "object" && "type" in value && "message" in value ? { ...value, message: undefined } : value));
  } catch {
    return stdout;
  }
};

const runOne = (command: ReadonlyArray<string>, c: Case) =>
  new Promise<{ stdout: string; stderr: string; exit: number | null; frames: string[] }>((done) => {
    frames = [];
    answer = c.answer ?? (() => "silent");
    const child = spawn(command[0]!, [...command.slice(1), ...c.argv], {
      cwd: root,
      env: { ...process.env, JUNTO_WORK_HOME: home, JUNTO_WORK_TOKEN: "seat-token", ...c.env },
    });
    // A command that waits on the stand-in forever is a difference, not a hang.
    const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("close", () => clearTimeout(kill));
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.end(c.stdin ?? "");
    child.on("close", (exit) => done({ stdout, stderr, exit, frames: [...frames].sort() }));
  });

/**
 * The differences accepted, by case name and nothing broader: they print but
 * do not fail the guard. A case left out of the corpus or renamed drops out
 * of this list on its own.
 */
const ACCEPTED: ReadonlyMap<string, string> = new Map([
  // since=now is read on each side's own clock, so the two times differ by the gap between the runs.
  ["example logs: recent errors on this machine", "since=now timing"],
]);

let failed = 0;
let accepted = 0;
for (const c of cases) {
  const keep = new Set([SERVER_ID, ...[...c.argv, String(c.stdin ?? "")].flatMap((a) => a.match(ULID) ?? [])]);
  const ts = await runOne(["bun", ...shipDefines, "src/cli/main.ts"], c);
  const native = await runOne([bin], c);
  const diffs: string[] = [];
  for (const key of ["stdout", "stderr", "exit", "frames"] as const) {
    const pick = (run: typeof ts) => (key === "stderr" ? acted(run.stderr) : key === "stdout" ? actedOut(run.stdout) : run[key]);
    const a = normal(JSON.stringify(pick(ts)), keep);
    const b = normal(JSON.stringify(pick(native)), keep);
    if (a !== b) diffs.push(`  ${key}\n    ts:     ${a}\n    native: ${b}`);
  }
  if (diffs.length === 0) {
    process.stdout.write(`same  ${c.name}\n`);
  } else if (ACCEPTED.has(c.name)) {
    accepted += 1;
    process.stdout.write(`ACCEPTED (${ACCEPTED.get(c.name)})  ${c.name}\n${diffs.join("\n")}\n`);
  } else {
    failed += 1;
    process.stdout.write(`DIFF  ${c.name}\n${diffs.join("\n")}\n`);
  }
}

server.close();
rmSync(home, { recursive: true, force: true });
process.stdout.write(`\n${cases.length - failed - accepted} of ${cases.length} cases the same, ${accepted} accepted\n`);
process.exit(failed === 0 ? 0 : 1);
