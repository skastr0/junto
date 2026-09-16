/**
 * Crew fixture — deterministic generated-canvas crews for the local crew
 * surface (crew contract deleted by operator ruling 2026-09-16): mail, immediate prompts, seat/task
 * waits, read-only terminal observation, and review verdicts.
 *
 * Seats are FAKE TUI processes — every spec that uses them is labelled
 * `[fake-tui]` in its title and evidence. The fake is a `codex` binary
 * planted on the sandbox PATH ahead of the fakes dir: it paints the exact
 * screens the codex seat-state rule pack classifies
 * (src/main/vellum-command/term/agent-state/rules/codex.ts), echoes PTY
 * input the way a real composer does, and proxies REAL work-control
 * operations over the app's Unix control socket with the seat's own
 * injected env (process-bind admission — the same path a registered
 * harness CLI takes). Live product evidence uses the app's readCanvas
 * projection; physical write counts use the opt-in PTY trace journal.
 * This fixture never opens the product database while the app runs.
 *
 * Control channel per seat (all under `<sandbox home>/.vellum-command/
 * crew-seats/<canvas>--<nodeId>/`):
 *   ready.json    fake's identity report (pid, nodeRef, seat, argv)
 *   control.json  one-shot screen request + submit/paste/exit — polled ~50ms
 *   feed.ndjson   append-only lines the fake prints to its PTY
 *   ops/<id>.req.json -> ops/<id>.res.json   work-control socket calls
 *   events.ndjson spawn/screen/submit/op audit log
 *   stdin.log     base64 raw PTY input the seat received (paste evidence)
 */

import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import type { PtyDeliveryTraceEvent } from "../../src/main/vellum-command/term/drive/pty-delivery-trace";
import type { CanvasDoc, CanvasEdge, CanvasNode, TextNode } from "../../src/shared/canvas";
import type { GroupNode } from "../../src/shared/canvas";
import { readMailAttemptFacts, readMailExtension, type MailAttemptFacts, type MailExtension, type ReviewVerdict } from "../../src/shared/crew";
import { composeImmediatePromptPayload, composeMessageDeliveryPayload } from "../../src/shared/message-delivery";
import type { Port } from "../../src/shared/physics/schema";
import type { Verb } from "../../src/shared/physics/verbs";
import { transportLogDirectory } from "../../src/shared/transport-trace";
import type { Message, Rule, Task, TasksContract } from "../../src/shared/work-model";
import {
  agentTextNode,
  canvasDoc,
  tasksNode,
  verbEdge,
  type Sandbox,
} from "./sandbox";
import { seededHarnessBinDir } from "./agent-harness-fixture";

// ---------------------------------------------------------------------------
// Canvas builders — legal verbs only (verbEdge throws on an illegal pair)
// ---------------------------------------------------------------------------

export type CrewSeatInput = {
  readonly id: string;
  readonly key?: string;
  readonly label?: string;
  readonly x?: number;
  readonly y?: number;
};

/** A managed agent seat on the fake-tui harness (binary `codex`). */
export const crewSeatNode = (input: CrewSeatInput): TextNode =>
  agentTextNode({
    id: input.id,
    key: input.key ?? `local:${input.id}`,
    label: input.label ?? input.id,
    harness: "codex",
    x: input.x,
    y: input.y,
  });

/** messages edge; `mask` attenuates the compiled grant (grant-set, not deny-set). */
export const crewMessagesEdge = (
  id: string,
  fromNode: string,
  toNode: string,
  nodes: ReadonlyArray<CanvasNode>,
  mask?: ReadonlyArray<Port>,
): CanvasEdge => {
  const edge = verbEdge(id, fromNode, toNode, "messages" as Verb, nodes);
  if (mask === undefined) return edge;
  return { ...edge, ether: { ...edge.ether!, mask: [...mask] } };
};

/** reviews edge — directed reviewer -> author, compiles `verdict.post`. */
export const crewReviewsEdge = (
  id: string,
  reviewerNode: string,
  authorNode: string,
  nodes: ReadonlyArray<CanvasNode>,
): CanvasEdge => verbEdge(id, reviewerNode, authorNode, "reviews" as Verb, nodes);

/** works edge — claimable task path; the verb's source is the sink. */
export const crewWorksEdge = (
  id: string,
  sinkNode: string,
  seatNode: string,
  nodes: ReadonlyArray<CanvasNode>,
): CanvasEdge => verbEdge(id, sinkNode, seatNode, "works" as Verb, nodes);

/**
 * manages edge — agent -> task sink. Grants tasks.list/create/update (so
 * tasks.show and tasks.wait admit) but never tasks.claim and never marks the
 * seat claimable — the factory claim cycle cannot assign work through it.
 * The reviewer seat uses this so authored tasks stay the author's alone.
 */
export const crewManagesEdge = (
  id: string,
  agentNode: string,
  sinkNode: string,
  nodes: ReadonlyArray<CanvasNode>,
): CanvasEdge => verbEdge(id, agentNode, sinkNode, "manages" as Verb, nodes);

/** A Tasks sink carrying an operator contract (rules incl. `requires-review`). */
export const crewTasksNode = (input: {
  readonly id: string;
  readonly x?: number;
  readonly y?: number;
  readonly items?: ReadonlyArray<Task>;
  readonly contract?: TasksContract;
}): TextNode => {
  const node = tasksNode(input);
  if (input.contract === undefined) return node;
  return {
    ...node,
    ether: {
      ...node.ether!,
      tasks: { items: [...(input.items ?? [])], contract: input.contract },
    },
  };
};

/** One contract rule; kind "requires-review" arms the review gate. */
export const crewRule = (id: string, text: string, kind?: Rule["kind"]): Rule =>
  kind === undefined ? { id, text } : { id, text, kind };

/** A region (group) with optional operator contract. Members are geometric. */
export const crewRegionNode = (input: {
  readonly id: string;
  readonly label?: string;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly instruction?: string;
  readonly rules?: ReadonlyArray<Rule>;
}): GroupNode => ({
  id: input.id,
  type: "group",
  label: input.label,
  x: input.x ?? 0,
  y: input.y ?? 0,
  width: input.width ?? 1200,
  height: input.height ?? 800,
  ether: {
    region: {
      hold: true,
      ...(input.instruction !== undefined
        ? { instruction: input.instruction }
        : {}),
      ...(input.rules !== undefined
        ? { contract: { rules: [...input.rules] } }
        : {}),
    },
  },
});

export const crewDoc = (
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge> = [],
): CanvasDoc => canvasDoc(nodes, edges);

// ---------------------------------------------------------------------------
// Seat control-plane paths (spec side; mirrors the fake's own derivation)
// ---------------------------------------------------------------------------

/** Fake-seat control root inside the sandbox home. */
export const crewSeatsDir = (sandbox: Sandbox): string =>
  join(sandbox.homeDir, ".vellum-command", "crew-seats");

/** `canvas:node` -> the directory name the fake derives identically. */
export const crewSeatDirName = (canvas: string, nodeId: string): string =>
  `${canvas}:${nodeId}`.replace(/[^a-zA-Z0-9._-]+/g, "--");

export const crewSeatDir = (
  sandbox: Sandbox,
  canvas: string,
  nodeId: string,
): string => join(crewSeatsDir(sandbox), crewSeatDirName(canvas, nodeId));

// ---------------------------------------------------------------------------
// Fake TUI binary — planted as `codex` on the sandbox PATH (fake-tui label)
// ---------------------------------------------------------------------------

/**
 * Install the fake-tui `codex` binary into the sandbox harness bin dir —
 * first on the seat PATH, ahead of e2e/fakes/bin. Call from `afterSeed`.
 */
export const installCrewSeatHarness = async (sandbox: Sandbox): Promise<void> => {
  const binDir = seededHarnessBinDir(sandbox);
  await mkdir(binDir, { recursive: true });
  const path = join(binDir, "codex");
  await writeFile(path, CREW_SEAT_BINARY_SOURCE, "utf8");
  await chmod(path, 0o755);
};

/**
 * The fake codex. Deliberately self-contained (no imports beyond node
 * builtins): the seat runs it under the app's restricted PATH with only
 * the seat env inject plus CREW_SEAT_DIR resolved from WORK_HOME.
 *
 * Screens are the codex rule-pack literals — the state machine classifies
 * the painted grid, so state transitions the spec drives are the same
 * classifications a real codex produces. On CR the fake repaints like a
 * real submit: the composer returns to its empty placeholder under a
 * `• Working (esc to interrupt)` line — a genuine turn-start, not a
 * still-pending draft.
 */
const CREW_SEAT_BINARY_SOURCE = `#!/usr/bin/env node
// [fake-tui] crew seat — generated by e2e/harness/crew-fixture.ts.
"use strict";
const fs = require("fs");
const path = require("path");
const net = require("net");
const cp = require("child_process");
const crypto = require("crypto");

const workHome =
  process.env.JUNTO_WORK_HOME ||
  path.join(process.env.HOME || "", ".vellum-command", "work");
const sock = path.join(workHome, "control.sock");
const tokPath = path.join(workHome, "token");
const seatRoot = path.join(workHome, "..", "crew-seats");
const nodeRef =
  process.env.JUNTO_NODE_REF || "seat-" + String(process.pid);
const dir = path.join(
  seatRoot,
  nodeRef.replace(/[^a-zA-Z0-9._-]+/g, "--"),
);
fs.mkdirSync(path.join(dir, "ops"), { recursive: true });

const READY = path.join(dir, "ready.json");
const CONTROL = path.join(dir, "control.json");
const FEED = path.join(dir, "feed.ndjson");
const EVENTS = path.join(dir, "events.ndjson");
const STDINLOG = path.join(dir, "stdin.log");
const OPS = path.join(dir, "ops");

const ev = (event, detail) => {
  try {
    fs.appendFileSync(
      EVENTS,
      JSON.stringify({ at: Date.now(), event, ...(detail || {}) }) + "\\n",
    );
  } catch {}
};

fs.writeFileSync(
  READY,
  JSON.stringify({
    pid: process.pid,
    nodeRef,
    seat: process.env.JUNTO_SEAT || "",
    argv: process.argv.slice(2),
    at: Date.now(),
  }),
);
ev("spawn", { argv: process.argv.slice(2) });

// --- screen state (codex rule-pack literals) --------------------------------
// The fake models a composer, not a stack of printed screens: "composer"
// is the unsubmitted draft text (paste bytes and typed bytes fill it, CR
// submits it), "screen" is the ctl-driven base state, and "transcript"
// holds lines that scrolled above the composer. Every repaint erases the
// display first — a real codex redraws in place, and append-only paints
// would leave a stale "• Working" inside the rule pack's bottom-N
// windows after the spec flips the seat back to idle.
//
// idle      -> "› Ask Codex to do anything"   (empty_prompt_idle, empty)
// draft     -> idle + composer text "› <text>" (composer_draft_idle, draft)
// working   -> "• Working (esc to interrupt)" then the composer line —
//              the pending-evidence region anchors on the LAST glyph line,
//              so a submit that ends in a fresh empty composer makes the
//              pasted text leave the prompt box exactly like a real turn.
// attention -> "Allow command? [y/n]"          (weak_attention)
// silent    -> nothing rule-matched            (state machine holds/unknown)
let screen = { mode: "idle" };
let composer = "";
let submit = "ack"; // ack | hold | ignore
let paste = "echo"; // echo | swallow
const transcript = [];

const GLYPH = "\\u203a";
// Repaint like a real TUI: erase the display, drop the cursor to the
// bottom row, and let the frame scroll into place. The pending-evidence
// scan anchors on a prompt glyph inside the bottom-10 tail — a frame
// parked at the top of the viewport is invisible to it, so the composer
// must sit at the bottom the way real codex paints it.
const CLS = "\\x1b[2J\\x1b[999;1H";
const composerLines = (text) => {
  const parts = String(text).split("\\n");
  return [GLYPH + " " + parts[0]].concat(
    parts.slice(1).map((line) => "  " + line),
  );
};
const frame = () => {
  const lines = transcript.slice(-30);
  const prompt =
    composer.length > 0
      ? composerLines(composer)
      : [GLYPH + " Ask Codex to do anything"];
  switch (screen.mode) {
    case "idle":
      lines.push.apply(lines, prompt);
      break;
    case "working":
      lines.push("\\u2022 Working (esc to interrupt)", "");
      lines.push.apply(lines, prompt);
      break;
    case "attention":
      lines.push(screen.text || "Allow command? [y/n]");
      break;
    case "silent":
      lines.push("(unattended)");
      break;
  }
  return lines;
};
const paint = () => {
  process.stdout.write(CLS + frame().join("\\r\\n") + "\\r\\n");
};

let appliedScreenRequest;
const applyControl = () => {
  let c;
  try {
    c = JSON.parse(fs.readFileSync(CONTROL, "utf8"));
  } catch {
    return;
  }
  if (typeof c.submit === "string") submit = c.submit;
  if (typeof c.paste === "string") paste = c.paste;
  if (typeof c.exit === "number") {
    ev("exit", { code: c.exit });
    process.exit(c.exit);
  }
  if (
    c.screen &&
    typeof c.screen === "object" &&
    typeof c.screen.mode === "string"
  ) {
    // A screen request is an operator action, not a persistent composer
    // constraint. Consume even an already-idle request before bytes arrive.
    const request = JSON.stringify([c.screenRequestId, c.screen]);
    if (request === appliedScreenRequest) return;
    appliedScreenRequest = request;
    // {mode:"draft",text} is sugar: a draft is an idle seat whose composer
    // holds text. idle/working transitions clear the composer like a real
    // submit does; attention keeps whatever was drafted underneath.
    const m = c.screen.mode;
    const next =
      m === "draft"
        ? { mode: "idle" }
        : typeof c.screen.text === "string"
          ? { mode: m, text: c.screen.text }
          : { mode: m };
    const nextComposer =
      m === "draft"
        ? String(c.screen.text || "")
        : m === "idle" || m === "working"
          ? ""
          : composer;
    screen = next;
    composer = nextComposer;
    paint();
    ev("screen", { mode: m, requestId: c.screenRequestId });
  }
};
setInterval(applyControl, 50);

// --- feed: spec-appended lines printed verbatim ------------------------------
let feedOffset = 0;
const drainFeed = () => {
  let raw;
  try {
    raw = fs.readFileSync(FEED, "utf8");
  } catch {
    return;
  }
  if (raw.length <= feedOffset) return;
  const fresh = raw.slice(feedOffset);
  feedOffset = raw.length;
  for (const line of fresh.split("\\n")) {
    if (line.length === 0) continue;
    try {
      const entry = JSON.parse(line);
      if (typeof entry.print === "string") {
        transcript.push(entry.print);
        paint();
      }
    } catch {}
  }
};
setInterval(drainFeed, 60);

// --- stdin: PTY input -> composer -> submit ----------------------------------
// Bracketed paste (\x1b[200~ ... \x1b[201~) fills the composer as ONE block —
// a real TUI does not treat newlines inside a paste as submits. CR outside
// the bracket submits the composer:
//   ack     -> the text scrolls to the transcript, the composer empties and
//              the Working status repaints (a real turn-start);
//   hold    -> nothing clears: the pasted text stays pending in the composer
//              (written-but-unacknowledged, the unresolved class);
//   ignore  -> no answer at all — the bytes sit on screen, no repaint.
let inPaste = false;
let inputTail = "";
const doSubmit = () => {
  const line = composer;
  ev("submit", {
    text: line.slice(0, 200),
    textLength: line.length,
    textSha256: crypto.createHash("sha256").update(line).digest("hex"),
  });
  if (line.length === 0) return; // empty CR is a no-op on a real composer
  if (submit === "ack") {
    for (const l of line.split("\\n")) transcript.push(l);
    composer = "";
    screen = { mode: "working" };
    paint();
  } else if (submit === "hold") {
    paint();
  }
};
// Native Codex owns raw input. Cooked PTY input would echo on its behalf
// and withhold the final pasted line/paste-end until CR, falsifying the
// composer that the observer and drive are meant to exercise.
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  const incoming = chunk.toString("utf8");
  try {
    fs.appendFileSync(STDINLOG, Buffer.from(incoming).toString("base64") + "\\n");
  } catch {}
  const raw = inputTail + incoming;
  let dirty = false;
  let i = 0;
  while (i < raw.length) {
    if (inPaste) {
      if (raw.startsWith("\\x1b[201~", i)) {
        inPaste = false;
        i += 6;
        continue;
      }
      // PTY reads may split a bracket marker across data callbacks.
      if ("\\x1b[201~".startsWith(raw.slice(i))) break;
      if (paste === "echo") {
        composer += raw[i];
        dirty = true;
      }
      i += 1;
      continue;
    }
    if ("\\x1b[200~".startsWith(raw.slice(i))) break;
    if (raw.startsWith("\\x1b[200~", i)) {
      inPaste = true;
      i += 6;
      continue;
    }
    const esc =
      /^\\x1b\\[[0-9;?]*[a-zA-Z]|^\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)/.exec(
        raw.slice(i),
      );
    if (esc) {
      i += esc[0].length;
      continue;
    }
    const ch = raw[i];
    i += 1;
    if (ch === "\\r" || ch === "\\n") {
      doSubmit();
      continue;
    }
    composer += ch;
    dirty = true;
  }
  inputTail = raw.slice(i);
  // Unsubmitted bytes repaint as a draft — only over the idle composer,
  // never over a Working status or an attention form.
  if (dirty && screen.mode === "idle") paint();
});

// --- work-control ops --------------------------------------------------------
const callWork = (op, args, timeoutMs) =>
  new Promise((resolve) => {
    let token;
    try {
      token = fs.readFileSync(tokPath, "utf8").trim();
    } catch (error) {
      resolve({
        ok: false,
        error: { type: "InternalError", message: String(error) },
      });
      return;
    }
    const socket = net.createConnection({ path: sock });
    let buf2 = Buffer.alloc(0);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {}
      resolve(value);
    };
    const timer = setTimeout(
      () =>
        finish({
          ok: false,
          error: { type: "InternalError", message: "work call timed out" },
        }),
      timeoutMs,
    );
    socket.on("connect", () => {
      socket.write(JSON.stringify({ token, op, args }) + "\\n");
    });
    socket.on("data", (chunk) => {
      buf2 = Buffer.concat([buf2, chunk]);
      const nl = buf2.indexOf(0x0a);
      if (nl < 0) return;
      clearTimeout(timer);
      socket.end();
      try {
        finish(JSON.parse(buf2.subarray(0, nl).toString("utf8")));
      } catch (error) {
        finish({
          ok: false,
          error: { type: "InternalError", message: String(error) },
        });
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      finish({
        ok: false,
        error: { type: "InternalError", message: String(error) },
      });
    });
  });

const runCli = (argv, timeoutMs) =>
  new Promise((resolve) => {
    const bin = process.env.JUNTO_CLI || "vellum-command";
    cp.execFile(
      bin,
      argv,
      { env: process.env, timeout: timeoutMs },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          exitCode:
            error && typeof error.code === "number" ? error.code : error ? 1 : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      },
    );
  });

const drainOps = () => {
  let names;
  try {
    names = fs.readdirSync(OPS);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".req.json")) continue;
    const reqPath = path.join(OPS, name);
    const resPath = path.join(OPS, name.replace(/\\.req\\.json$/, ".res.json"));
    let req;
    try {
      req = JSON.parse(fs.readFileSync(reqPath, "utf8"));
      fs.unlinkSync(reqPath);
    } catch {
      continue;
    }
    const timeoutMs =
      typeof req.timeoutMs === "number" ? req.timeoutMs : 30000;
    ev("op", { id: name, op: req.op || req.cli });
    const done = (result) => {
      try {
        fs.writeFileSync(resPath, JSON.stringify(result));
      } catch {}
    };
    if (typeof req.cli !== "undefined") {
      void runCli(req.cli, timeoutMs).then(done);
    } else {
      void callWork(req.op, req.args, timeoutMs).then(done);
    }
  }
};
setInterval(drainOps, 50);

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
setInterval(() => {}, 60000); // keep alive
// Recorded Codex startup enables bracketed paste and sets an idle title;
// multiline text remains literal, as in corpus/codex/paste-chip.jsonl.
process.stdout.write("\\x1b[?2004h\\x1b]0;codex\\x07");
paint();
ev("ready", { nodeRef });
`;

// ---------------------------------------------------------------------------
// Spec-side seat handle
// ---------------------------------------------------------------------------

export type WorkEnvelope =
  | { readonly ok: true; readonly data?: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly type: string;
        readonly message: string;
        readonly details?: Record<string, unknown>;
      };
    };

export type CrewCliResult = {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CrewScreen =
  | { readonly mode: "idle" }
  | { readonly mode: "draft"; readonly text: string }
  | { readonly mode: "working" }
  | { readonly mode: "attention"; readonly text?: string }
  | { readonly mode: "silent" };

export type CrewSeatReady = {
  readonly pid: number;
  readonly nodeRef: string;
  readonly seat: string;
  readonly argv: ReadonlyArray<string>;
  readonly at: number;
};

export type CrewSeatEvent = {
  readonly at: number;
  readonly event: string;
  readonly [key: string]: unknown;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const readJsonFile = async <T>(path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return undefined;
  }
};

/** One fake seat's control channel — file-backed, no live-process handle. */
export class CrewSeat {
  readonly dir: string;
  private opCounter = 0;

  constructor(dir: string) {
    this.dir = dir;
  }

  /** Wait for the fake to register (spawned, env read, dirs made). */
  async ready(timeoutMs = 30_000): Promise<CrewSeatReady> {
    const readyPath = join(this.dir, "ready.json");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await readJsonFile<CrewSeatReady>(readyPath);
      if (ready !== undefined) return ready;
      await sleep(50);
    }
    throw new Error(`fake seat never registered: ${this.dir}`);
  }

  /** Patch behavior; an explicit screen request applies once before resolving. */
  async control(patch: {
    readonly screen?: CrewScreen;
    readonly submit?: "ack" | "hold" | "ignore";
    readonly paste?: "echo" | "swallow";
    readonly exit?: number;
  }): Promise<void> {
    const path = join(this.dir, "control.json");
    const prior = (await readJsonFile<Record<string, unknown>>(path)) ?? {};
    const screenRequestId = patch.screen === undefined ? undefined : randomUUID();
    await writeFile(path, JSON.stringify({
      ...prior,
      ...patch,
      ...(screenRequestId === undefined ? {} : { screenRequestId }),
    }), "utf8");
    if (screenRequestId === undefined) return;
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if ((await this.events()).some((event) => event.event === "screen" && event.requestId === screenRequestId)) return;
      await sleep(20);
    }
    throw new Error(`seat screen request ${screenRequestId} was not applied`);
  }

  /** Append lines for the seat to print into its PTY transcript. */
  async print(...lines: ReadonlyArray<string>): Promise<void> {
    const path = join(this.dir, "feed.ndjson");
    const body =
      lines.map((line) => JSON.stringify({ print: line })).join("\n") + "\n";
    await writeFile(path, body, { encoding: "utf8", flag: "a" });
  }

  /**
   * One work-control op over the seat's own socket+token — process-bound
   * admission, real authorization. `timeoutMs` rides the request so long
   * waits can run past the fake's default.
   */
  async op(
    op: string,
    args?: unknown,
    opts?: { readonly timeoutMs?: number; readonly awaitMs?: number },
  ): Promise<WorkEnvelope> {
    const id = `${Date.now().toString(36)}-${String(this.opCounter++)}`;
    const reqPath = join(this.dir, "ops", `${id}.req.json`);
    const resPath = join(this.dir, "ops", `${id}.res.json`);
    await writeFile(
      reqPath,
      JSON.stringify({
        op,
        args,
        timeoutMs: opts?.timeoutMs ?? 30_000,
      }),
      "utf8",
    );
    const deadline = Date.now() + (opts?.awaitMs ?? 60_000);
    while (Date.now() < deadline) {
      const res = await readJsonFile<WorkEnvelope>(resPath);
      if (res !== undefined) return res;
      await sleep(40);
    }
    throw new Error(`seat op ${op} produced no response within awaitMs`);
  }

  /** Spawn the seat CLI as a child of the seat (registered descendant). */
  async cli(
    argv: ReadonlyArray<string>,
    opts?: { readonly timeoutMs?: number; readonly awaitMs?: number },
  ): Promise<CrewCliResult> {
    const id = `${Date.now().toString(36)}-${String(this.opCounter++)}`;
    const reqPath = join(this.dir, "ops", `${id}.req.json`);
    const resPath = join(this.dir, "ops", `${id}.res.json`);
    await writeFile(
      reqPath,
      JSON.stringify({ cli: [...argv], timeoutMs: opts?.timeoutMs ?? 30_000 }),
      "utf8",
    );
    const deadline = Date.now() + (opts?.awaitMs ?? 60_000);
    while (Date.now() < deadline) {
      const res = await readJsonFile<CrewCliResult>(resPath);
      if (res !== undefined) return res;
      await sleep(40);
    }
    throw new Error(`seat cli ${argv.join(" ")} produced no response`);
  }

  /** Base64-decoded raw PTY input the seat process received. */
  async stdinLog(): Promise<string> {
    try {
      const raw = await readFile(join(this.dir, "stdin.log"), "utf8");
      return raw
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => Buffer.from(line, "base64").toString("utf8"))
        .join("");
    } catch {
      return "";
    }
  }

  async events(): Promise<ReadonlyArray<CrewSeatEvent>> {
    try {
      const raw = await readFile(join(this.dir, "events.ndjson"), "utf8");
      return raw
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as CrewSeatEvent);
    } catch {
      return [];
    }
  }
}

export const crewSeat = (
  sandbox: Sandbox,
  canvas: string,
  nodeId: string,
): CrewSeat => new CrewSeat(crewSeatDir(sandbox, canvas, nodeId));

// ---------------------------------------------------------------------------
// App-level gestures (through the real renderer API surface)
// ---------------------------------------------------------------------------

/** Play the factory if paused (first-play confirm included). */
export const crewPlayFactory = async (page: Page): Promise<void> => {
  const pause = page.getByTestId("factory-pause");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await pause.isVisible().catch(() => false)) break;
    await sleep(100);
  }
  if ((await pause.getAttribute("data-pause-state")) !== "playing") {
    await pause.click();
    const confirm = page.getByTestId("first-play-confirm");
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.getByRole("button", { name: /play/i }).click();
    }
    const playDeadline = Date.now() + 15_000;
    while (Date.now() < playDeadline) {
      if ((await pause.getAttribute("data-pause-state")) === "playing") return;
      await sleep(100);
    }
    throw new Error("factory never reached playing state");
  }
};

/**
 * Occupy a seat: terminalCreate on the agent node through the live API,
 * retried until the fake registers — the same gesture as opening the
 * seat's terminal in the UI.
 */
export const crewOccupySeat = async (
  page: Page,
  canvas: string,
  node: TextNode,
  seat: CrewSeat,
  timeoutMs = 45_000,
): Promise<CrewSeatReady> => {
  const occupy = () =>
    page.evaluate(
      async ([canvasName, seatNode]) => {
        const api = window.vellumCommand!;
        await api.terminalCreate({ node: seatNode, canvasName });
      },
      [canvas, node] as const,
    );
  const deadline = Date.now() + timeoutMs;
  await occupy().catch(() => undefined);
  while (Date.now() < deadline) {
    try {
      return await seat.ready(2_000);
    } catch {
      await occupy().catch(() => undefined);
    }
  }
  return seat.ready(5_000);
};

/** Author a doc into a canvas through the app's own write path. */
export const crewWriteCanvas = async (
  page: Page,
  canvas: string,
  doc: CanvasDoc,
): Promise<void> => {
  await page.evaluate(
    async ([name, nextDoc]) => {
      const api = window.vellumCommand!;
      const read = await api.readCanvas(name);
      await api.writeCanvas(name, nextDoc, read.revision);
    },
    [canvas, doc] as const,
  );
};

/** Mutate a canvas doc through the app's own write path (edges, rules, masks). */
export const crewMutateCanvas = async (
  page: Page,
  canvas: string,
  mutate: (doc: CanvasDoc) => CanvasDoc,
): Promise<void> => {
  const current = await page.evaluate(
    async (name) => (await window.vellumCommand!.readCanvas(name)).doc,
    canvas,
  );
  await crewWriteCanvas(page, canvas, mutate(current as CanvasDoc));
};

// ---------------------------------------------------------------------------
// App-owned work projections and install-local PTY trace evidence
// ---------------------------------------------------------------------------

const crewCanvas = (page: Page, canvas: string): Promise<CanvasDoc> =>
  page.evaluate(async (name) => (await window.vellumCommand!.readCanvas(name)).doc, canvas);

const crewMessages = async (
  page: Page,
  canvas: string,
  nodeId: string,
): Promise<ReadonlyArray<Message>> => {
  const doc = await crewCanvas(page, canvas);
  const node = doc.nodes.find((candidate) => candidate.id === nodeId);
  if (node === undefined) throw new Error(`Missing projected crew sink ${canvas}/${nodeId}`);
  return node.ether?.messages?.items ?? [];
};

export type CrewMailAttempt = MailAttemptFacts & {
  readonly messageId: string;
  readonly mailKind?: MailExtension["mailKind"];
};

/**
 * Latest durably queued generation per message, as projected by main. This is
 * not the full attempt ledger: policy, batch ids and physical counters are not
 * exposed by readCanvas. Receipt timestamps are read independently below.
 */
export const crewMailAttempts = async (
  page: Page,
  canvas: string,
  nodeId: string,
): Promise<ReadonlyArray<CrewMailAttempt>> =>
  (await crewMessages(page, canvas, nodeId)).flatMap((message) => {
    const facts = readMailAttemptFacts(message.metadata);
    if (facts === undefined) {
      if (message.metadata?.generation !== undefined || message.metadata?.queuedAt !== undefined) {
        throw new Error(`Invalid projected mail attempt for ${message.messageId}`);
      }
      return [];
    }
    const extension = readMailExtension(message.metadata);
    return [{
      messageId: message.messageId,
      ...facts,
      ...(extension === undefined ? {} : { mailKind: extension.mailKind }),
    }];
  });

/** Task-subject chains only; standalone commit verdicts are not a canvas projection. */
export const crewVerdicts = async (
  page: Page,
  canvas: string,
): Promise<ReadonlyArray<ReviewVerdict>> =>
  (await crewCanvas(page, canvas)).nodes
    .flatMap((node) => (node.ether?.tasks?.items ?? []).flatMap((task) => task.verdicts ?? []))
    .sort((left, right) => left.postedAtMs - right.postedAtMs);

export const crewMessageCount = async (
  page: Page,
  canvas: string,
  nodeId: string,
): Promise<number> => (await crewMessages(page, canvas, nodeId)).length;

export type CrewReceiptFacts = {
  readonly messageId: string;
  readonly deliveredAt?: number;
  readonly readAt?: number;
  readonly reactions?: ReadonlyArray<{ readonly kind: "ack"; readonly at: number }>;
};

const receiptTimestamp = (value: unknown, key: string, messageId: string): number | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Invalid projected ${key} receipt for ${messageId}`);
  }
  return value;
};

/** Accepted receipt facts from main; attempt.notifiedAt never substitutes for a receipt. */
export const crewReceipts = async (
  page: Page,
  canvas: string,
  nodeId: string,
): Promise<ReadonlyArray<CrewReceiptFacts>> =>
  (await crewMessages(page, canvas, nodeId)).flatMap((message) => {
    const deliveredAt = receiptTimestamp(message.metadata?.deliveredAt, "deliveredAt", message.messageId);
    const readAt = receiptTimestamp(message.metadata?.readAt, "readAt", message.messageId);
    const rawReactions = message.metadata?.reactions;
    let reactions: CrewReceiptFacts["reactions"];
    if (rawReactions !== undefined) {
      if (!Array.isArray(rawReactions)) throw new Error(`Invalid projected reactions for ${message.messageId}`);
      reactions = rawReactions.map((reaction: unknown) => {
        if (reaction === null || typeof reaction !== "object" ||
            !("kind" in reaction) || reaction.kind !== "ack" || !("at" in reaction)) {
          throw new Error(`Invalid projected acknowledgement for ${message.messageId}`);
        }
        const at = receiptTimestamp(reaction.at, "ack", message.messageId);
        if (at === undefined) throw new Error(`Missing projected acknowledgement time for ${message.messageId}`);
        return { kind: "ack" as const, at };
      });
    }
    if (deliveredAt === undefined && readAt === undefined && reactions === undefined) return [];
    return [{
      messageId: message.messageId,
      ...(deliveredAt === undefined ? {} : { deliveredAt }),
      ...(readAt === undefined ? {} : { readAt }),
      ...(reactions === undefined ? {} : { reactions }),
    }];
  });

/** Missing, rotated, malformed or dropped trace evidence fails the check. */
const crewPtyTrace = async (sandbox: Sandbox): Promise<ReadonlyArray<PtyDeliveryTraceEvent>> => {
  const directory = transportLogDirectory(sandbox.homeDir);
  const entries = await readdir(directory);
  if (entries.includes("pty-delivery.jsonl.1")) {
    throw new Error("Crew PTY trace rotated; the complete physical write history is unavailable");
  }
  const body = await readFile(join(directory, "pty-delivery.jsonl"), "utf8");
  return body.split("\n").filter((line) => line.length > 0).map((line, index) => {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== "object" ||
        !("ts" in value) || typeof value.ts !== "string" ||
        !("bindingId" in value) || typeof value.bindingId !== "string" ||
        !("harness" in value) || typeof value.harness !== "string" ||
        !("event" in value) || typeof value.event !== "string" ||
        !("fields" in value) || value.fields === null || typeof value.fields !== "object" ||
        Array.isArray(value.fields) ||
        ("deliveryId" in value && typeof value.deliveryId !== "string")) {
      throw new Error(`Invalid crew PTY trace row ${index + 1}`);
    }
    if ("dropped" in value && value.dropped !== 0) {
      throw new Error(`Crew PTY trace dropped events at row ${index + 1}`);
    }
    if ((value.event === "write.end" &&
          (!("stage" in value.fields) || typeof value.fields.stage !== "string" ||
           !("ok" in value.fields) || typeof value.fields.ok !== "boolean")) ||
        (value.event === "delivery.begin" &&
          (!("textSha256" in value.fields) || typeof value.fields.textSha256 !== "string" ||
           !/^[a-f0-9]{64}$/.test(value.fields.textSha256)))) {
      throw new Error(`Incomplete crew PTY write evidence at row ${index + 1}`);
    }
    return value as PtyDeliveryTraceEvent;
  });
};

/**
 * Accepted paste writes for an isolated single-message delivery. Correlates
 * the canonical payload hash and the live binding with trace deliveryId;
 * unrelated startup prompts and CRs do not count. The trace has no source id
 * or epoch, so this helper does not prove batched-mail attribution or history
 * across recipient generation replacement. The fake stdin log separately
 * proves the bytes reached the child process.
 */
export const crewMessagePasteWrites = async (
  page: Page,
  sandbox: Sandbox,
  canvas: string,
  nodeId: string,
  messageId: string,
  policy: "notice" | "immediate" = "notice",
): Promise<number> => {
  const message = (await crewMessages(page, canvas, nodeId))
    .find((candidate) => candidate.messageId === messageId);
  if (message === undefined) throw new Error(`Missing projected crew message ${messageId}`);
  const bindings = await page.evaluate(async ([canvasName, recipient]) =>
    (await window.vellumCommand!.terminalList()).filter((session) =>
      session.canvasName === canvasName && session.nodeId === recipient && session.status === "running"),
  [canvas, nodeId] as const);
  if (bindings.length !== 1) throw new Error(`Expected one live crew binding for ${canvas}/${nodeId}; found ${bindings.length}`);
  const bindingId = bindings[0]!.bindingId;
  const payload = policy === "immediate"
    ? composeImmediatePromptPayload(message)
    : composeMessageDeliveryPayload(message);
  const hash = createHash("sha256").update(payload).digest("hex");
  const events = await crewPtyTrace(sandbox);
  const deliveries = new Set(events.filter((event) =>
    event.bindingId === bindingId && event.event === "delivery.begin" && event.fields.textSha256 === hash,
  ).map((event) => {
    if (event.deliveryId === undefined) throw new Error("Crew PTY delivery.begin is missing its correlation id");
    return event.deliveryId;
  }));
  return events.filter((event) => event.bindingId === bindingId &&
    event.deliveryId !== undefined && deliveries.has(event.deliveryId) &&
    event.event === "write.end" && event.fields.stage === "paste" && event.fields.ok === true).length;
};
