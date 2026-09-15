/**
 * Crew fixture — deterministic generated-canvas crews for the local crew
 * surface (docs/crew-contract.md): mail, immediate prompts, seat/task
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
 * harness CLI takes). Nothing here opens or writes the product database
 * while the app runs; evidence reads are read-only `DatabaseSync`.
 *
 * Control channel per seat (all under `<sandbox home>/.vellum-command/
 * crew-seats/<canvas>--<nodeId>/`):
 *   ready.json    fake's identity report (pid, nodeRef, seat, argv)
 *   control.json  desired screen/submit/paste/exit — polled ~50ms
 *   feed.ndjson   append-only lines the fake prints to its PTY
 *   ops/<id>.req.json -> ops/<id>.res.json   work-control socket calls
 *   events.ndjson spawn/screen/submit/op audit log
 *   stdin.log     base64 raw PTY input the seat received (paste evidence)
 */

import { chmod, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import type { CanvasDoc, CanvasEdge, CanvasNode, TextNode } from "../../src/shared/canvas";
import type { GroupNode } from "../../src/shared/canvas";
import type { Port } from "../../src/shared/physics/schema";
import type { Verb } from "../../src/shared/physics/verbs";
import type { Rule, Task, TasksContract } from "../../src/shared/work-model";
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

const workHome =
  process.env.VELLUM_COMMAND_WORK_HOME ||
  path.join(process.env.HOME || "", ".vellum-command", "work");
const sock = path.join(workHome, "control.sock");
const tokPath = path.join(workHome, "token");
const seatRoot = path.join(workHome, "..", "crew-seats");
const nodeRef =
  process.env.VELLUM_COMMAND_NODE_REF || "seat-" + String(process.pid);
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
    seat: process.env.VELLUM_COMMAND_SEAT || "",
    argv: process.argv.slice(2),
    at: Date.now(),
  }),
);
ev("spawn", { argv: process.argv.slice(2) });

// --- screen state (codex rule-pack literals) --------------------------------
// idle      -> "› Ask Codex to do anything"      (empty_prompt_idle, empty)
// draft     -> "› <text>"                        (composer_draft_idle, draft)
// working   -> "• Working (esc to interrupt)"
//              then a fresh empty "›" line below — the real codex keeps the
//              composer under its status line; the pending-evidence region
//              anchors on the LAST glyph line, so the pasted text leaves the
//              prompt box exactly like a real submit.
// attention -> "Allow command? [y/n]"            (weak_attention)
// silent    -> nothing rule-matched              (state machine holds/unknown)
let screen = { mode: "idle" };
let submit = "ack"; // ack | hold | ignore
let paste = "echo"; // echo | swallow

const GLYPH = "\\u203a";
const paint = () => {
  switch (screen.mode) {
    case "idle":
      process.stdout.write("\\n" + GLYPH + " Ask Codex to do anything\\n");
      break;
    case "draft":
      process.stdout.write("\\n" + GLYPH + " " + (screen.text || "") + "\\n");
      break;
    case "working":
      process.stdout.write(
        "\\n\\u2022 Working (esc to interrupt)\\n\\n" +
          GLYPH +
          " Ask Codex to do anything\\n",
      );
      break;
    case "attention":
      process.stdout.write(
        "\\n" + (screen.text || "Allow command? [y/n]") + "\\n",
      );
      break;
    case "silent":
      process.stdout.write("\\n(unattended)\\n");
      break;
  }
};

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
    typeof c.screen.mode === "string" &&
    JSON.stringify(c.screen) !== JSON.stringify(screen)
  ) {
    screen = c.screen;
    ev("screen", { mode: screen.mode });
    paint();
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
        process.stdout.write("\\n" + entry.print + "\\n");
      }
    } catch {}
  }
};
setInterval(drainFeed, 60);

// --- stdin: PTY input -> composer echo -> submit repaint ---------------------
let buf = "";
process.stdin.on("data", (chunk) => {
  const raw = chunk.toString("utf8");
  try {
    fs.appendFileSync(STDINLOG, Buffer.from(raw).toString("base64") + "\\n");
  } catch {}
  const text = raw
    .replace(/\\x1b\\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\\x1b\\][^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)/g, "");
  buf += text;
  let nl;
  while ((nl = buf.search(/[\\r\\n]/)) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    ev("submit", { text: line.slice(0, 200) });
    if (submit === "ack") {
      // Real codex: submitted text leaves the composer for the transcript,
      // the status line goes Working, a fresh empty composer sits below.
      process.stdout.write("\\n" + line + "\\n");
      screen = { mode: "working" };
      paint();
    } else if (submit === "hold") {
      screen = { mode: "draft", text: line };
      paint();
    }
    // ignore: swallow the submission entirely (no turn-start evidence)
  }
  if (buf.length > 0 && paste === "echo" && screen.mode !== "working") {
    // Unsubmitted bytes sit in the composer as a draft, like a real TUI.
    screen = { mode: "draft", text: buf };
    paint();
  }
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
    const bin = process.env.VELLUM_COMMAND_CLI || "vellum-command";
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

  /** Merge-patch the seat's control object (screen/submit/paste/exit). */
  async control(patch: {
    readonly screen?: CrewScreen;
    readonly submit?: "ack" | "hold" | "ignore";
    readonly paste?: "echo" | "swallow";
    readonly exit?: number;
  }): Promise<void> {
    const path = join(this.dir, "control.json");
    const prior = (await readJsonFile<Record<string, unknown>>(path)) ?? {};
    await writeFile(path, JSON.stringify({ ...prior, ...patch }), "utf8");
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
// Read-only durable evidence (never writes; opens the sandbox db read-only)
// ---------------------------------------------------------------------------

export const crewStateDbPath = (sandbox: Sandbox): string =>
  join(sandbox.homeDir, ".vellum-command", "state", "vellum-command.db");

export const crewQuery = <T>(
  sandbox: Sandbox,
  sql: string,
  params: ReadonlyArray<string | number>,
): ReadonlyArray<T> => {
  const db = new DatabaseSync(crewStateDbPath(sandbox), { readOnly: true });
  try {
    return db.prepare(sql).all(...params) as T[];
  } catch {
    return [];
  } finally {
    db.close();
  }
};

export type MailAttemptRow = {
  readonly canvas_name: string;
  readonly node_id: string;
  readonly message_id: string;
  readonly recipient_seat_id: string;
  readonly recipient_generation: string;
  readonly policy: string;
  readonly batch_id: string | null;
  readonly queued_at: string;
  readonly attempted_at: string | null;
  readonly notified_at: string | null;
  readonly unresolved_at: string | null;
  readonly refused_at: string | null;
  readonly refused_reason: string | null;
  readonly writes_before: number | null;
  readonly writes_after: number | null;
  readonly write_at: string | null;
};

export const crewMailAttempts = (
  sandbox: Sandbox,
  canvas: string,
  nodeId: string,
): ReadonlyArray<MailAttemptRow> =>
  crewQuery<MailAttemptRow>(
    sandbox,
    "SELECT * FROM work_mail_attempts WHERE canvas_name = ? AND node_id = ? ORDER BY queued_at",
    [canvas, nodeId],
  );

export type VerdictRow = {
  readonly verdict_id: string;
  readonly kind: string;
  readonly reviewer_seat_id: string;
  readonly reviewer_node_id: string | null;
  readonly author_seat_id: string;
  readonly subject_kind: string;
  readonly subject_task_canvas: string | null;
  readonly subject_task_node: string | null;
  readonly subject_task_item: string | null;
  readonly subject_epoch: number | null;
  readonly subject_sha: string | null;
  readonly subject_hash: string;
  readonly epoch: number;
  readonly findings_json: string;
  readonly refs_json: string;
  readonly posted_at_ms: number;
};

export const crewVerdicts = (sandbox: Sandbox): ReadonlyArray<VerdictRow> =>
  crewQuery<VerdictRow>(
    sandbox,
    "SELECT * FROM work_review_verdicts ORDER BY posted_at_ms",
    [],
  );

export const crewMessageCount = (
  sandbox: Sandbox,
  canvas: string,
  nodeId: string,
): number =>
  crewQuery<{ n: number }>(
    sandbox,
    "SELECT count(*) AS n FROM work_messages WHERE canvas_name = ? AND node_id = ?",
    [canvas, nodeId],
  )[0]?.n ?? 0;

export type ReceiptRow = {
  readonly delivery_id: string;
  readonly delivered_canvas_name: string;
  readonly delivered_node_id: string;
  readonly delivered_item_kind: string;
  readonly accepted_at: string;
};

/** Mailbox delivery/read receipts accepted on one sink (durable truth). */
export const crewReceipts = (
  sandbox: Sandbox,
  canvas: string,
  nodeId: string,
): ReadonlyArray<ReceiptRow> =>
  crewQuery<ReceiptRow>(
    sandbox,
    `SELECT delivery_id, delivered_canvas_name, delivered_node_id,
            delivered_item_kind, accepted_at
       FROM work_delivery_receipts
      WHERE delivered_canvas_name = ? AND delivered_node_id = ?
      ORDER BY accepted_at`,
    [canvas, nodeId],
  );
