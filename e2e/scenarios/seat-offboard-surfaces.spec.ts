/**
 * Seat offboard, wherever the operator is looking, and against everything
 * that could take the session back [fake-tui].
 *
 *   bun run test:e2e:fast e2e/scenarios/seat-offboard-surfaces.spec.ts
 *   bun run test:e2e:fast e2e/scenarios/seat-offboard-surfaces.spec.ts -g "slow-cap"   (ten minutes, on its own)
 *
 * The rule under test. `junto offboard` moves the seat on at once: the old
 * process is taken off the seat without being signalled and is left to
 * finish its turn, off to one side (main/junto/seat-sessions/drain.ts). The
 * seat is vacant (rest) or runs a fresh process that is typed one line
 * (continue), and nothing waits. Nothing addressed to the seat reaches the
 * old process again. The old process is stopped two seconds after it reads
 * idle, or ten minutes after the offboard, and main logs how it ended.
 *
 * The pass lines the walks hold:
 *   P1  continue mid-turn: the fresh process is up and has its line while
 *       the OLD process is still alive
 *   P2  nothing reaches the old process after the offboard, to its end:
 *       mail, an operator prompt, keystrokes in the open view, a nudge
 *   P3  the old process, once idle, is gone a few seconds later, logged
 *       "(settled)"
 *   P4  one that never goes idle is stopped at ten minutes, logged "(cap)"
 *   P5  junto, run from the old process after the offboard, is refused
 *   P6  card, modal, tile and view show the fresh session or the resting
 *       seat, never the old process's later output
 *   P7  many seats at once, each on its own; a seat that offboards again
 *       while its first old process still runs
 *   P8  Junto quits while one is winding down
 *   P9  rest: the open view reads "offboarded, resting", with Reopen
 *
 *   SA   the focus view is open on the seat (rest, continue); SA3: the
 *        operator's own Stop is not overridden by a wake
 *   SB   four seats in the grid; SB5: five at once, one ignoring SIGTERM;
 *        SB-again: a seat offboards twice
 *   SC   [slow-cap] a turn that never ends
 *   SD   a draft in the input box (rest, continue)
 *   SE   Junto quits while an old process winds down, and while a fresh
 *        process has not had its line
 *   SF   a seat on the Claude template, which pins its session id
 *   SG   a process that ignores SIGTERM, at its wind-down
 *   SJ   hijack attempts in the moment after the offboard returns
 *   SK   junto from the old process
 *
 * Old and fresh processes run side by side, so each generation of a seat
 * has a folder of its own: the wrapper (installSurfaceSeatHarness) gives
 * launch N the folder gen<N>, and the fake (a patched copy) keeps its input
 * log, control file, events and work-control proxy there. The old process
 * is addressed only through its own generation's files. The patched fake
 * writes the time into an `alive` file ten times a second: that is how a
 * process is shown to be running, and when it stopped, with no pid and no
 * signal from the test. Every walk ends its old processes: it lets their
 * turn end and waits for main's "(settled)" line, except SC (the cap stops
 * it) and SE (the quit does).
 *
 * The drive's journal (JUNTO_PTY_TRACE=1) is keyed by seat, not by process,
 * and carries no drain key, so once a fresh process exists it cannot say who
 * was typed to. "Nothing reached the old process" rests on the old
 * generation's own input log, which only that process writes; the journal is
 * read only for the stretch before a fresh process exists.
 *
 * The focus view. Double-clicking a seat opens its terminal in the workbench
 * focus zone, which IS the focus modal: WorkFocusShell renders FocusSurface
 * (role="dialog") around the workbench panes. There is no second modal.
 *
 * Evidence, whatever the outcome: `<id>-offboard-log.txt` holds the test id,
 * the failed checks, main's `[offboard]` lines, the test's timeline and every
 * seat's input log per generation; it sits with the screenshots in
 * OFFBOARD_WALK_DIR when that is set, in the test's output folder otherwise.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import type { AgentSeatStateEvent } from "../../src/shared/agent-seat-state";
import type { CanvasDoc, CanvasEdge, TextNode } from "../../src/shared/canvas";
import { buildOnboardNudge } from "../../src/shared/managed-terminal-injection";
import { templateFor } from "../../src/shared/managed-terminal-templates";
import { CONTINUATION_LINE, type SeatOffboardProgress } from "../../src/shared/seat-sessions";
import type { TerminalSessionSummary } from "../../src/shared/terminal";
import { seededHarnessBinDir } from "../harness/agent-harness-fixture";
import {
  crewDoc,
  crewMessagesEdge,
  crewOccupySeat,
  crewPlayFactory,
  CrewSeat,
  crewSeatDir,
  crewSeatNode,
  crewSeatsDir,
  installCrewSeatHarness,
  type WorkEnvelope,
} from "../harness/crew-fixture";
import { expect, launchJunto, test, type JuntoHandle } from "../harness/launch";
import { agentTextNode, type Sandbox } from "../harness/sandbox";

// Only [A-Za-z0-9._-] in the canvas name and node ids: the wrapper turns the
// one ":" of JUNTO_NODE_REF into the "--" the fake names its folder with.
const CANVAS = "surfaces";
const MAILER_ID = "mailer";
const CODEX_SESSION = "sess-surfaces-0001";

const CLI_BUILT = existsSync(join(process.cwd(), "dist", "junto"));
const NOTES = "# Parser wired for all three feeds\n\n- Why it matters: the nightly sync fails without it.";
const NEXT = "next: pick up the retry on 429 in the feed importer, the nightly sync fails without it";
/** The open (not parked) terminal surface in the focus view (mail-wakes-cold-seat.spec.ts:203-205). */
const SURFACE = ".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface";

const NUDGE = buildOnboardNudge();

// ---------------------------------------------------------------------------
// Timing. Every bound the checks use, in one place.
// ---------------------------------------------------------------------------

/** The seat must have moved on (vacant, or on a fresh process) this long after `junto offboard` returns (expected: about 1 s). */
const MOVED_ON_AFTER_OFFBOARD_MS = 4_000;
/** How long the test waits to see the seat move on at all. */
const MOVED_ON_WATCH_MS = 20_000;
/** An old process must be gone this long after its turn ends (expected: 2 to 4 s; drain.ts DRAIN_SETTLE_MS is 2 s). */
const GONE_AFTER_IDLE_MS = 8_000;
/** One that ignores SIGTERM is killed 1.5 s after the TERM (local-host.ts KILL_GRACE_MS): TERM to gone must be under this. */
const TERM_TO_GONE_MS = 4_000;
/** How long the test waits to see an old process go at all. */
const GONE_WATCH_MS = 30_000;
/** After a quit, every process the app held must be gone within this. */
const GONE_AFTER_QUIT_MS = 15_000;
/** drain.ts DRAIN_CAP_MS: an old process that never goes idle is stopped this long after the offboard. */
const CAP_MS = 10 * 60 * 1_000;
/** The cap may come this much early or late and still be the cap. */
const CAP_EARLY_MS = 15_000;
const CAP_LATE_MS = 60_000;
/** The fake writes the time this often; a process silent for HEARTBEAT_STALE_MS is gone. */
const HEARTBEAT_MS = 100;
const HEARTBEAT_STALE_MS = 700;
/** A continuing seat's fresh process must be up this long after the offboard returns. */
const FRESH_AFTER_OFFBOARD_MS = 8_000;
/** How long the test waits to see a fresh process at all. */
const FRESH_WATCH_MS = 60_000;
/** Mail, a prompt or the continuation line must reach the fresh session within this. */
const DELIVERY_MS = 60_000;
/** An open view must show the fresh session this long after its line reached the fresh process (expected: about 1 s). */
const VIEW_FOLLOWS_MS = 3_000;
/** Seats that offboard together restart within this of each other. */
const RESTART_SPREAD_MS = 3_000;
/** A continuing seat's one line must be in its fresh session this long after the fresh process (or the operator's last key) (expected: about 3 s). */
const LINE_AFTER_FRESH_MS = 5_000;
/** A continuation line held by the operator's draft must arrive this long after the box is empty and the seat idle (expected: about 3 s). */
const LINE_AFTER_DRAFT_MS = 5_000;
/** A hijack is tried at once, and again this long after. */
const HIJACK_AGAIN_MS = 300;
/** Time given for a stray or a second line to arrive before counting. */
const QUIET_MS = 5_000;
/** Before a fresh generation offboards: its input must have been still this long after its line was submitted. */
const INPUT_QUIET_MS = 300;
/** How long the test waits for a fresh generation's continuation line to be submitted and its input to go still. */
const INPUT_SETTLE_WATCH_MS = 15_000;
/** How long a view the operator stopped must stay stopped after the seat is woken behind it. */
const STOPPED_STAYS_MS = 5_000;
/** After a relaunch: how long the seat gets to start by itself before the test starts it. */
const SELF_START_MS = 10_000;
/** How long the fresh session is watched for a nudge after its continuation line. */
const FRESH_NUDGE_WATCH_MS = 10_000;
/** How long `junto offboard` gets to answer, or main to say the notes are saved. */
const OFFBOARD_ANSWER_MS = 15_000;
/** Between two turns of a seat: time for a nudge that is due to land whole. */
const TURN_GAP_MS = 3_000;
/** A seat reaching a state. */
const SEAT_STATE_MS = 30_000;
/** How often the test looks. */
const POLL_MS = 50;
/**
 * What the continuation line reads like on a screen. FAIL SIGNATURE of the
 * view bug 6ea48c9b5 fixed: the open view shows the seat as stopped, with a
 * Reopen button, while a new process is already running behind it.
 */
const CONTINUATION_ON_SCREEN = "Continuing from your previous session.";
/** What a view says for a session that ended because its seat offboarded to rest (renderer/lib/seat-offboard-state.ts:73 at d31ca1748). */
const RESTING_COPY = "offboarded, resting";
/** What a process hears when it calls junto after its seat moved on (main/junto/process-identity.ts:505-506). */
const OFFBOARDED_SESSION_MESSAGE = "This session has offboarded. Its seat has moved on to a fresh session.";
/** Main's lines for an old process's end (seat-sessions/drain-seat.ts:82) and for what a quit ended (ipc.ts:2126). */
const endedLine = (seatId: string, how: "settled" | "cap" | "crashed" | "quit"): string => `${seatId}: its offboarded session ended (${how})`;
const ENDED_AT_QUIT = "offboarded session(s) ended when Junto last quit";
/** What a view says when it has no reason for a process being gone: never right for a seat that offboarded. */
const FAILED_START_COPY = "could not start";
const STALE_VIEW = "FAIL SIGNATURE (stale view): the view shows the seat as stopped with a Reopen button while a new process is running";

const soft = expect.configure({ soft: true });

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

/** A codex seat with a session to close, seeded the way seat-sessions.spec.ts does (line 36). */
const codexSeat = (id: string, label: string, x: number, y: number): TextNode => {
  const base = crewSeatNode({ id, label, x, y });
  return { ...base, ether: { ...base.ether, terminal: { ...base.ether!.terminal!, sessionId: `${CODEX_SESSION}-${id}` } } };
};

const MAILER = crewSeatNode({ id: MAILER_ID, label: "Mailer", x: 480, y: 380 });

/** The seats under test, a mailer, and a messages edge from the mailer to each. */
const docOf = (seats: ReadonlyArray<TextNode>): CanvasDoc => {
  const nodes = [...seats, MAILER];
  const edges: CanvasEdge[] = seats.map((seat) => crewMessagesEdge(`e-mailer-${seat.id}`, MAILER.id, seat.id, nodes));
  return crewDoc(nodes, edges);
};

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

const walkDir = (testInfo: TestInfo): string => process.env.OFFBOARD_WALK_DIR ?? testInfo.outputPath();

const note = (testInfo: TestInfo, type: string, description: string): void => {
  testInfo.annotations.push({ type, description });
};

const offboardLines = (log: string): ReadonlyArray<string> => log.split("\n").filter((line) => line.includes("[offboard]"));

type Evidence = {
  readonly id: string;
  readonly testInfo: TestInfo;
  /** Keep everything this app's main process prints. */
  readonly listen: (app: ElectronApplication, name: string) => void;
  readonly mainLog: () => string;
  /** A fact for the timeline in the log file, and an annotation when `as` is given. */
  readonly mark: (line: string, as?: string) => number;
  readonly shot: (page: Page, name: string) => Promise<void>;
  /** The seats whose input logs go into the log file. */
  readonly seats: (sandbox: Sandbox, ids: ReadonlyArray<string>) => void;
  readonly flush: () => Promise<void>;
};

const evidenceFor = (testInfo: TestInfo, id: string): Evidence => {
  const logs: Array<{ readonly name: string; readonly chunks: string[] }> = [];
  const timeline: string[] = [];
  const dir = walkDir(testInfo);
  let watched: { readonly sandbox: Sandbox; readonly ids: ReadonlyArray<string> } | undefined;
  return {
    id,
    seats: (sandbox, ids) => {
      watched = { sandbox, ids };
    },
    testInfo,
    listen: (app, name) => {
      const chunks: string[] = [];
      logs.push({ name, chunks });
      const keep = (chunk: Buffer): void => {
        chunks.push(String(chunk));
      };
      app.process().stdout?.on("data", keep);
      app.process().stderr?.on("data", keep);
    },
    mainLog: () => logs.map((log) => log.chunks.join("")).join("\n"),
    mark: (line, as) => {
      const at = Date.now();
      timeline.push(`${new Date(at).toISOString()} ${line}`);
      if (as !== undefined) note(testInfo, `${id}-${as}`, line);
      return at;
    },
    shot: async (page, name) => {
      await mkdir(dir, { recursive: true });
      await page.screenshot({ path: join(dir, `${id}-${name}.png`) });
    },
    flush: async () => {
      // Every seat's input, one block per process generation.
      const inputs: string[] = [];
      if (watched !== undefined) {
        for (const seatId of watched.ids) {
          const generations = await inputsOf(watched.sandbox, seatId).catch(() => [] as ReadonlyArray<string>);
          generations.forEach((input, index) => {
            inputs.push(`### ${seatId}, generation ${String(index + 1)}`, JSON.stringify(input), "");
          });
          if (generations.length === 0) inputs.push(`### ${seatId}: never started`, "");
        }
      }
      const failed = testInfo.errors.map((error) => (error.message ?? String(error.value ?? "")).split("\n").slice(0, 6).join("\n"));
      const text = [
        `# ${id}: ${testInfo.title}`,
        "",
        `## failed checks (${String(failed.length)})`,
        ...failed.flatMap((message) => [message, ""]),
        ...logs.flatMap((log) => [`## main (${log.name}): lines containing [offboard]`, ...offboardLines(log.chunks.join("")), ""]),
        "## test timeline",
        ...timeline,
        "",
        "## seat input logs",
        ...inputs,
      ].join("\n");
      await mkdir(dir, { recursive: true }).catch(() => undefined);
      await writeFile(join(dir, `${id}-offboard-log.txt`), text, "utf8").catch(() => undefined);
      await testInfo.attach(`${id}-offboard-log`, { body: text, contentType: "text/plain" }).catch(() => undefined);
    },
  };
};

/** Keep the delivery trace and the seats' logs: the sandbox is deleted on close. */
const keepTrace = async (sandbox: Sandbox, id: string): Promise<void> => {
  const traceDir = process.env.PTY_WALK_TRACE_DIR;
  if (!traceDir) return;
  const { cpSync, mkdirSync } = await import("node:fs");
  const dest = join(traceDir, id);
  mkdirSync(dest, { recursive: true });
  const logs = join(sandbox.homeDir, ".junto", "logs");
  if (existsSync(logs)) cpSync(logs, join(dest, "logs"), { recursive: true });
  const seats = crewSeatsDir(sandbox);
  if (existsSync(seats)) cpSync(seats, join(dest, "crew-seats"), { recursive: true });
};

/** One app per test. */
const walk = async (
  testInfo: TestInfo,
  id: string,
  doc: CanvasDoc,
  body: (junto: JuntoHandle, evidence: Evidence) => Promise<void>,
): Promise<void> => {
  const evidence = evidenceFor(testInfo, id);
  const junto = await launchJunto({
    seedCanvases: { [CANVAS]: doc },
    afterSeed: installSurfaceSeatHarness,
    extraEnv: { JUNTO_PTY_TRACE: "1" },
  });
  evidence.listen(junto.app, "app");
  evidence.seats(junto.sandbox, doc.nodes.map((node) => node.id));
  try {
    await expect(junto.page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await body(junto, evidence);
  } catch (error) {
    await evidence.shot(junto.page, "on-failure").catch(() => undefined);
    throw error;
  } finally {
    await evidence.flush();
    await keepTrace(junto.sandbox, id).catch(() => undefined);
    await junto.close();
  }
};

// ---------------------------------------------------------------------------
// Fake seat harness: one folder per process generation
// ---------------------------------------------------------------------------

/**
 * The fake, changed so that two generations of one seat can run side by
 * side and be told apart: it keeps its files in the folder the wrapper names
 * (WALK_SEAT_DIR), it writes the time into `alive` every HEARTBEAT_MS, and on
 * SIGTERM it records the signal and exits, or (the `ignores` copy) records it
 * and carries on, to be stopped only by SIGKILL.
 */
const patchFake = (source: string, ignoresTerm: boolean): string => {
  const edits: ReadonlyArray<readonly [string, string]> = [
    ["const dir = path.join(", "const dir = process.env.WALK_SEAT_DIR || path.join("],
    [
      'process.on("SIGTERM", () => process.exit(0));',
      ignoresTerm
        ? 'process.on("SIGTERM", () => ev("sigterm-ignored"));'
        : 'process.on("SIGTERM", () => { ev("sigterm"); process.exit(0); });',
    ],
    [
      "setInterval(() => {}, 60000); // keep alive",
      `setInterval(() => { try { fs.writeFileSync(path.join(dir, "alive"), String(Date.now())); } catch {} }, ${String(HEARTBEAT_MS)});`,
    ],
  ];
  let out = source;
  for (const [from, to] of edits) {
    if (!out.includes(from)) throw new Error(`SETUP: the crew fake no longer has the line this spec changes: ${from}`);
    out = out.replace(from, to);
  }
  return out;
};

/**
 * The crew fixture's fake (patched, see patchFake), behind a wrapper that at
 * every launch of a seat: gives it a folder of its own, gen<N>; writes the
 * launch's arguments to argv.<N> (one per line); leaves a launch.<N> mark;
 * hands the new process a first screen when a control.next.json was left for
 * it; and waits while a hold.<N> file exists (the process is up, its terminal
 * blank). Then it execs the fake, so the seat process is the fake itself. A
 * seat with an `ignore-term` file gets the copy that ignores SIGTERM.
 * Installed under `codex` and under the Claude template's binary name, so no
 * real harness is ever resolvable.
 */
const installSurfaceSeatHarness = async (sandbox: Sandbox): Promise<void> => {
  await installCrewSeatHarness(sandbox);
  const bin = seededHarnessBinDir(sandbox);
  const fake = join(bin, "codex-crew-fake");
  await rename(join(bin, "codex"), fake);
  const source = await readFile(fake, "utf8");
  const stubborn = join(bin, "codex-crew-fake-ignores-term");
  await writeFile(fake, patchFake(source, false), "utf8");
  await writeFile(stubborn, patchFake(source, true), "utf8");
  await chmod(fake, 0o755);
  await chmod(stubborn, 0o755);
  const script = [
    "#!/bin/sh",
    "# [fake-tui] seat-offboard-surfaces: one folder per generation, then become the crew fake.",
    'if [ -n "${JUNTO_NODE_REF:-}" ]; then',
    `  dir='${crewSeatsDir(sandbox)}'/$(printf '%s' "$JUNTO_NODE_REF" | sed 's/:/--/')`,
    '  mkdir -p "$dir"',
    "  n=1",
    '  while [ -e "$dir/launch.$n" ]; do n=$((n + 1)); done',
    '  mkdir -p "$dir/gen$n"',
    "  : > \"$dir/argv.$n\"",
    "  for arg in \"$@\"; do printf '%s\\n' \"$arg\" >> \"$dir/argv.$n\"; done",
    '  date +%s > "$dir/launch.$n"',
    '  if [ -f "$dir/control.next.json" ]; then mv "$dir/control.next.json" "$dir/gen$n/control.json"; fi',
    '  WALK_SEAT_DIR="$dir/gen$n"',
    "  export WALK_SEAT_DIR",
    '  while [ -e "$dir/hold.$n" ]; do sleep 0.1; done',
    `  if [ -e "$dir/ignore-term" ]; then exec '${stubborn}' "$@"; fi`,
    "fi",
    `exec '${fake}' "$@"`,
    "",
  ].join("\n");
  for (const name of ["codex", templateFor("claude").argvSpec.binary]) {
    const wrapper = join(bin, name);
    await writeFile(wrapper, script, "utf8");
    await chmod(wrapper, 0o755);
  }
};

const seatDir = (sandbox: Sandbox, nodeId: string): string => crewSeatDir(sandbox, CANVAS, nodeId);

/** One generation of a seat (1 is its first process): its own control file, input log, events and junto proxy. */
const genSeat = (sandbox: Sandbox, nodeId: string, generation: number): CrewSeat =>
  new CrewSeat(join(seatDir(sandbox, nodeId), `gen${String(generation)}`));

/** How many processes this seat has had. */
const launches = async (sandbox: Sandbox, nodeId: string): Promise<number> =>
  (await readdir(seatDir(sandbox, nodeId)).catch(() => [] as string[])).filter((name) => /^launch\.\d+$/u.test(name)).length;

/**
 * When generation `generation` was launched: the wrapper's launch mark,
 * written just before the fake starts, by its modification time (the mark's
 * own content is whole seconds).
 */
const launchedAt = async (sandbox: Sandbox, nodeId: string, generation: number): Promise<number | undefined> =>
  (await stat(join(seatDir(sandbox, nodeId), `launch.${String(generation)}`)).catch(() => undefined))?.mtimeMs;

/** Everything generation `generation` received on its PTY input: only that process writes this log. */
const inputOf = (sandbox: Sandbox, nodeId: string, generation: number): Promise<string> => genSeat(sandbox, nodeId, generation).stdinLog();

/** Every generation's input, oldest first. */
const inputsOf = async (sandbox: Sandbox, nodeId: string): Promise<ReadonlyArray<string>> => {
  const count = await launches(sandbox, nodeId);
  return Promise.all(Array.from({ length: count }, (_unused, index) => inputOf(sandbox, nodeId, index + 1)));
};

const argvOf = async (sandbox: Sandbox, nodeId: string, generation: number): Promise<ReadonlyArray<string>> =>
  (await readFile(join(seatDir(sandbox, nodeId), `argv.${String(generation)}`), "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.length > 0);

/** The last time this process said it was running; undefined before it ever did. */
const lastAlive = async (seat: CrewSeat): Promise<number | undefined> => {
  const at = Number(await readFile(join(seat.dir, "alive"), "utf8").catch(() => ""));
  return Number.isFinite(at) && at > 0 ? at : undefined;
};

/** The process is running: it said so within the last HEARTBEAT_STALE_MS. No pid, no signal. */
const isAlive = async (seat: CrewSeat): Promise<boolean> => {
  const at = await lastAlive(seat);
  return at !== undefined && Date.now() - at < HEARTBEAT_STALE_MS;
};

/** Wait until the process has stopped saying it runs; its last heartbeat, or undefined when it never stopped. */
const waitGone = async (seat: CrewSeat, withinMs: number): Promise<number | undefined> => {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    const at = await lastAlive(seat);
    if (at !== undefined && Date.now() - at >= HEARTBEAT_STALE_MS) return at;
    await sleep(POLL_MS);
  }
  return undefined;
};

type DrainRow = { readonly sessionId: string; readonly detachedAt: number | null; readonly endedAt: number | null; readonly endedHow: string | null };

/**
 * What the session rows say became of this seat's offboarded sessions
 * (seat_session_drains; seat-sessions/repository.ts). Read straight from the
 * sandbox's database, read-only, the way mail-wakes-cold-seat.spec.ts reads
 * receipts; empty when it cannot be read.
 */
const drainRows = (sandbox: Sandbox, seatId: string): ReadonlyArray<DrainRow> => {
  try {
    const db = new DatabaseSync(join(sandbox.homeDir, ".junto", "state", "junto.db"), { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT session_id, detached_at, ended_at, ended_how FROM seat_session_drains WHERE seat_id = ? ORDER BY detached_at")
        .all(seatId) as unknown as ReadonlyArray<{ session_id: string; detached_at: number | null; ended_at: number | null; ended_how: string | null }>;
      return rows.map((row) => ({ sessionId: row.session_id, detachedAt: row.detached_at, endedAt: row.ended_at, endedHow: row.ended_how }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
};

const bindingOf = (nodeId: string): string => `local:${nodeId}`;

const seatState = async (page: Page, nodeId: string): Promise<string | undefined> => {
  const events = (await page.evaluate(() => window.junto!.agentSeatStateSnapshot())) as ReadonlyArray<AgentSeatStateEvent>;
  return events.find((event) => event.bindingId === bindingOf(nodeId))?.state;
};

const expectSeatState = async (page: Page, nodeId: string, state: string | RegExp): Promise<void> => {
  const poll = expect.poll(async () => (await seatState(page, nodeId)) ?? "none", {
    message: `seat ${nodeId} state`,
    timeout: SEAT_STATE_MS,
  });
  if (typeof state === "string") await poll.toBe(state);
  else await poll.toMatch(state);
};

const startSeat = async (junto: JuntoHandle, node: TextNode): Promise<CrewSeat> => {
  const seat = genSeat(junto.sandbox, node.id, 1);
  await crewOccupySeat(junto.page, CANVAS, node, seat);
  await expectSeatState(junto.page, node.id, "idle");
  return seat;
};

const opData = (envelope: WorkEnvelope): Record<string, unknown> => {
  expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
  return ((envelope as { readonly data?: unknown }).data ?? {}) as Record<string, unknown>;
};

const sessionOf = (page: Page, nodeId: string): Promise<TerminalSessionSummary | undefined> =>
  page.evaluate((id) => window.junto!.terminalGet(id), bindingOf(nodeId)) as Promise<TerminalSessionSummary | undefined>;

const isLive = (session: TerminalSessionSummary | undefined): boolean =>
  session?.status === "running" || session?.status === "starting";

/** The session id the seat's node names (`ether.terminal.sessionId`). A codex seat's is cleared at the close (rotate.ts:83-84). */
const nodeSessionId = async (page: Page, nodeId: string): Promise<string | undefined> => {
  const doc = (await page.evaluate(async (name) => (await window.junto!.readCanvas(name)).doc, CANVAS)) as CanvasDoc;
  return doc.nodes.find((node) => node.id === nodeId)?.ether?.terminal?.sessionId;
};

const offboardStage = async (page: Page, nodeId: string): Promise<string> => {
  const all = (await page.evaluate(() => window.junto!.seatOffboardProgressList?.() ?? [])) as ReadonlyArray<SeatOffboardProgress>;
  const mine = all.find((entry) => entry.seatId === nodeId && entry.canvasName === CANVAS);
  return mine ? `${mine.stage}${mine.message ? `: ${mine.message}` : ""}` : "none";
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;
const squash = (text: string): string => text.replace(/\s+/gu, "");

/** One seat's visible rows, from the per-binding registry (TerminalSurface.tsx:1048: the key is the binding id). */
const screenOf = (page: Page, nodeId: string): Promise<string> =>
  page.evaluate((key) => {
    const registry = (window as unknown as { __juntoTermScreenText?: Map<string, () => string> }).__juntoTermScreenText;
    return registry?.get(key)?.() ?? "";
  }, bindingOf(nodeId));

type Fired = {
  /** When the call was made. */
  readonly firedAt: number;
  /** When `junto offboard` answered, or main first said the notes were saved, whichever came first. */
  readonly offboardedAt: number;
  /** The call itself: undefined when it answered ok, else why it did not. */
  readonly answer: Promise<string | undefined>;
};

/**
 * `junto offboard`, from the process that is on the seat (`seat` is that
 * generation's handle). "Returned" is the call's answer, or main's own word
 * that the offboard was taken (the seat's offboard stage changing),
 * whichever is seen first.
 */
const fireOffboard = async (page: Page, seat: CrewSeat, nodeId: string, testInfo: TestInfo, continuation?: string): Promise<Fired> => {
  if (!CLI_BUILT && !testInfo.annotations.some((entry) => entry.type === "offboard-via")) {
    note(testInfo, "offboard-via", "dist/junto is missing: ran the `offboard` work-control op from the seat instead of the CLI");
  }
  const stageBefore = await offboardStage(page, nodeId).catch(() => "none");
  const firedAt = Date.now();
  let answeredAt: number | undefined;
  const wait = { timeoutMs: OFFBOARD_ANSWER_MS, awaitMs: OFFBOARD_ANSWER_MS };
  const call: Promise<string | undefined> = CLI_BUILT
    ? seat
        .cli(["offboard", NOTES, ...(continuation === undefined ? [] : ["--continue", continuation])], wait)
        .then((result) => (result.ok ? undefined : `junto offboard failed: ${result.stdout}${result.stderr}`))
    : seat
        .op("offboard", { notes: NOTES, ...(continuation === undefined ? {} : { continuation }) }, wait)
        .then((envelope) => (envelope.ok ? undefined : `offboard op failed: ${JSON.stringify(envelope)}`));
  const answer = call.then(
    (problem) => {
      if (problem === undefined) answeredAt = Date.now();
      return problem;
    },
    (error: unknown) => `no answer came back from the seat: ${String(error)}`,
  );
  while (Date.now() < firedAt + OFFBOARD_ANSWER_MS) {
    if (answeredAt !== undefined) return { firedAt, offboardedAt: answeredAt, answer };
    if ((await offboardStage(page, nodeId).catch(() => stageBefore)) !== stageBefore) return { firedAt, offboardedAt: Date.now(), answer };
    await sleep(POLL_MS / 2);
  }
  throw new Error(`junto offboard neither answered nor was recorded by main within ${String(OFFBOARD_ANSWER_MS)} ms: ${String(await answer)}`);
};

type DriveWrite = { readonly at: number; readonly ts: string; readonly stage: string };

/** Every physical write the drive made into this seat's PTY (drive/pty-delivery-trace.ts; managed-terminal-drive.ts `write.begin`). */
const driveWrites = async (sandbox: Sandbox, nodeId: string): Promise<ReadonlyArray<DriveWrite>> => {
  const raw = await readFile(join(sandbox.homeDir, ".junto", "logs", "pty-delivery.jsonl"), "utf8").catch(() => "");
  const out: DriveWrite[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"write.begin"')) continue;
    try {
      const event = JSON.parse(line) as { ts?: string; bindingId?: string; event?: string; fields?: { stage?: unknown } };
      if (event.event !== "write.begin" || event.bindingId !== bindingOf(nodeId) || typeof event.ts !== "string") continue;
      out.push({ at: Date.parse(event.ts), ts: event.ts, stage: String(event.fields?.stage ?? "") });
    } catch {
      // A torn last line is not a write.
    }
  }
  return out;
};

const writesBetween = (writes: ReadonlyArray<DriveWrite>, from: number, to: number): ReadonlyArray<string> =>
  writes.filter((write) => write.at > from && write.at < to).map((write) => `${write.ts} ${write.stage}`);

/** A real turn: mail from the mailer, which the fake submits and starts working on. */
const startTurn = async (junto: JuntoHandle, mailer: CrewSeat, nodeId: string): Promise<void> => {
  const text = `start a turn, ${nodeId}: wire the parser`;
  opData(await mailer.op("msg.send", { target: nodeId, text }));
  await expect.poll(() => inputOf(junto.sandbox, nodeId, 1), { message: `the mail that starts ${nodeId}'s turn`, timeout: DELIVERY_MS }).toContain(text);
  await expectSeatState(junto.page, nodeId, "working");
};

/** Wait until the generation at `oldEpoch` is gone; the time it was first seen gone. */
const waitClosed = async (page: Page, nodeId: string, oldEpoch: string | undefined, withinMs: number): Promise<number | undefined> => {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    const session = await sessionOf(page, nodeId).catch(() => undefined);
    if (!isLive(session) || session?.epoch !== oldEpoch) return Date.now();
    await sleep(POLL_MS);
  }
  return undefined;
};

// ---------------------------------------------------------------------------
// The focus view, sampled from inside the page
// ---------------------------------------------------------------------------

type Sample = {
  readonly t: number;
  /** Open terminal surfaces in the focus view. */
  readonly surfaces: number;
  /** The surface element marked when the watch began is still in the document. */
  readonly same: boolean;
  readonly dialog: string;
  readonly status: string;
  readonly dead: string;
  readonly load: string;
  /** A visible Reopen button on the surface. */
  readonly reopen: boolean;
};

const seatCard = (page: Page, nodeId: string): Locator => page.locator(`.react-flow__node[data-id="${nodeId}"]`);

/** Open the seat's terminal the way an operator does: double-click its card. */
const openFocusView = async (page: Page, nodeId: string): Promise<Locator> => {
  await seatCard(page, nodeId).dblclick();
  const surface = page.locator(SURFACE);
  await expect(surface).toBeVisible({ timeout: 30_000 });
  return surface;
};

const focusTerminal = async (page: Page, surface: Locator): Promise<void> => {
  await surface.locator(".xterm-screen").click();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest(".native-terminal-surface") != null), {
      message: "the keyboard is in the terminal",
    })
    .toBe(true);
};

/** Mark the open surface and sample the focus view every 100 ms, inside the page. */
const watchFocusView = async (page: Page): Promise<void> => {
  await page.evaluate((selector) => {
    const scope = window as unknown as { __walkSamples?: unknown[]; __walkTimer?: number; __walkSurface?: Element | null };
    scope.__walkSurface = document.querySelector(selector);
    scope.__walkSamples = [];
    const text = (root: ParentNode | null | undefined, query: string): string =>
      Array.from(root?.querySelectorAll(query) ?? [])
        .map((el) => (el.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join(" | ");
    scope.__walkTimer = window.setInterval(() => {
      const open = document.querySelectorAll(selector);
      const first = open[0];
      scope.__walkSamples!.push({
        t: Date.now(),
        surfaces: open.length,
        same: scope.__walkSurface?.isConnected === true && open[0] === scope.__walkSurface,
        dialog: first?.closest("[role='dialog']")?.getAttribute("aria-label") ?? "",
        status: text(first, ".native-terminal-surface__status"),
        dead: text(first, ".native-terminal-surface__dead"),
        load: text(first, ".native-terminal-surface__load"),
        reopen: Array.from(first?.querySelectorAll("button") ?? []).some(
          (button) => (button.textContent ?? "").trim() === "Reopen" && (button as HTMLElement).offsetParent !== null,
        ),
      });
    }, 100);
  }, SURFACE);
};

const stopWatch = (page: Page): Promise<ReadonlyArray<Sample>> =>
  page.evaluate(() => {
    const scope = window as unknown as { __walkSamples?: unknown[]; __walkTimer?: number };
    if (scope.__walkTimer !== undefined) window.clearInterval(scope.__walkTimer);
    return scope.__walkSamples ?? [];
  }) as Promise<ReadonlyArray<Sample>>;

/** What the view showed, in order, each state once, with when it began. */
const storyOf = (samples: ReadonlyArray<Sample>): ReadonlyArray<string> => {
  const out: string[] = [];
  let last = "";
  for (const sample of samples) {
    const shown = `surfaces=${String(sample.surfaces)} same=${String(sample.same)} dialog="${sample.dialog}" status="${sample.status}" dead="${sample.dead}" load="${sample.load}" reopen=${String(sample.reopen)}`;
    if (shown === last) continue;
    last = shown;
    out.push(`${new Date(sample.t).toISOString()} ${shown}`);
  }
  return out;
};

/** The buttons the open surface offers, by their accessible name or text. */
const buttonsOn = (surface: Locator): Promise<ReadonlyArray<string>> =>
  surface
    .locator("button")
    .evaluateAll((buttons) =>
      buttons
        .filter((button) => (button as HTMLElement).offsetParent !== null)
        .map((button) => `${button.getAttribute("aria-label") ?? (button.textContent ?? "").trim()}${(button as HTMLButtonElement).disabled ? " (disabled)" : ""}`),
    )
    .catch(() => []);


/** One seat's whole terminal buffer, scrollback included (TerminalSurface.tsx, `__juntoTermTranscriptText`). */
const transcriptOf = (page: Page, nodeId: string): Promise<string> =>
  page.evaluate((key) => {
    const registry = (window as unknown as { __juntoTermTranscriptText?: Map<string, () => string> }).__juntoTermTranscriptText;
    return registry?.get(key)?.() ?? "";
  }, bindingOf(nodeId));

// ---------------------------------------------------------------------------
// One offboard, watched
// ---------------------------------------------------------------------------

type Running = {
  /** The seat's first process. */
  readonly seat: CrewSeat;
  readonly mailer: CrewSeat;
  readonly oldPid: number;
  readonly oldEpoch: string | undefined;
};

/** Play the canvas, start the seat and the mailer, and leave the seat mid-turn on real mail. */
const seatMidTurn = async (junto: JuntoHandle, node: TextNode, options: { readonly onboard: boolean }): Promise<Running> => {
  await crewPlayFactory(junto.page);
  const seat = await startSeat(junto, node);
  const mailer = await startSeat(junto, MAILER);
  if (options.onboard) opData(await seat.op("onboard", {}));
  const oldEpoch = (await sessionOf(junto.page, node.id))?.epoch;
  const oldPid = (await seat.ready()).pid;
  await startTurn(junto, mailer, node.id);
  return { seat, mailer, oldPid, oldEpoch };
};

const waitLaunches = async (sandbox: Sandbox, nodeId: string, count: number, withinMs: number): Promise<number | undefined> => {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if ((await launches(sandbox, nodeId)) >= count) return Date.now();
    await sleep(POLL_MS);
  }
  return undefined;
};

type Run = {
  /** Which generation offboarded (1 is the seat's first process), and its handle. */
  readonly generation: number;
  readonly old: CrewSeat;
  /**
   * That generation's input when the offboard was ACCEPTED (its answer came
   * back, or main's stage changed): what "nothing after the offboard" is
   * measured from.
   */
  readonly before: string;
  /** Its input when the command was launched. The CLI takes about half a second to reach Junto. */
  readonly atLaunch: string;
  /** What arrived between the launch and the acceptance: shown, not judged. */
  readonly inFlight: string;
  readonly fired: Fired;
  /** When the seat was first seen off that process: vacant, or on another generation. */
  readonly movedOnAt: number | undefined;
  /** Continue only: when the next process was first seen. */
  readonly restartedAt: number | undefined;
  /** Continue only: when the continuation line was first seen in the next generation's input. */
  readonly lineAt: number | undefined;
};

/**
 * Run `junto offboard` from the process on the seat, mid-turn, and watch the
 * seat move on, and the next process come up and get its line when it
 * continues. Nothing is set idle. `during` runs the moment the offboard has
 * returned, while the watches are already looking.
 */
/**
 * A fresh generation is ready to offboard only once its own continuation
 * line is in whole, submit included (the paste's closing bracket, then the
 * return), and its input has then been still for INPUT_QUIET_MS. Offboarding
 * the instant the pasted text shows would race the return that submits it.
 */
const settleFreshInput = async (sandbox: Sandbox, nodeId: string, generation: number): Promise<void> => {
  const until = Date.now() + INPUT_SETTLE_WATCH_MS;
  const submitted = (input: string): boolean => {
    const at = input.lastIndexOf(CONTINUATION_LINE);
    // No line (not a continued generation): nothing to wait for but stillness.
    return at < 0 || input.slice(at + CONTINUATION_LINE.length).includes("\r");
  };
  let last = await inputOf(sandbox, nodeId, generation);
  let stillSince = Date.now();
  while (Date.now() < until) {
    await sleep(POLL_MS);
    const now = await inputOf(sandbox, nodeId, generation);
    if (now !== last) {
      last = now;
      stillSince = Date.now();
      continue;
    }
    if (submitted(now) && Date.now() - stillSince >= INPUT_QUIET_MS) return;
  }
};

const offboardRun = async (
  junto: JuntoHandle,
  testInfo: TestInfo,
  nodeId: string,
  generation: number,
  oldEpoch: string | undefined,
  continuation: string | undefined,
  during?: (fired: Fired) => Promise<void>,
  /** How long to look for the continuation line before handing back (it may be held, by design). */
  lineWatchMs: number = DELIVERY_MS,
): Promise<Run> => {
  const { page, sandbox } = junto;
  const old = genSeat(sandbox, nodeId, generation);
  // A first generation offboards whenever the walk says (some walks race it
  // on purpose); a fresh one only once its own line is in and submitted.
  if (generation > 1) await settleFreshInput(sandbox, nodeId, generation);
  const atLaunch = await inputOf(sandbox, nodeId, generation);
  const fired = await fireOffboard(page, old, nodeId, testInfo, continuation);
  // The snapshot that counts is taken when the offboard is accepted.
  const before = await inputOf(sandbox, nodeId, generation);
  const inFlight = before.startsWith(atLaunch) ? before.slice(atLaunch.length) : before;
  if (inFlight !== "") {
    note(
      testInfo,
      `in-flight-${nodeId}-g${String(generation)}`,
      `written between the command's launch and its arrival at Junto (not judged), over ${String(fired.offboardedAt - fired.firedAt)} ms: ${JSON.stringify(inFlight)}`,
    );
  }
  const moving = waitClosed(page, nodeId, oldEpoch, MOVED_ON_WATCH_MS);
  const restarting = continuation === undefined ? Promise.resolve(undefined) : waitLaunches(sandbox, nodeId, generation + 1, FRESH_WATCH_MS);
  const lining =
    continuation === undefined
      ? Promise.resolve(undefined)
      : (async (): Promise<number | undefined> => {
          const until = Date.now() + lineWatchMs;
          while (Date.now() < until) {
            if ((await inputOf(sandbox, nodeId, generation + 1)).includes(CONTINUATION_LINE)) return Date.now();
            await sleep(POLL_MS);
          }
          return undefined;
        })();
  if (during) await during(fired);
  return { generation, old, before, atLaunch, inFlight, fired, movedOnAt: await moving, restartedAt: await restarting, lineAt: await lining };
};

/** The seat moved on, in time, and the old process was not stopped for it (P1). */
const checkMovedOn = async (check: typeof expect, evidence: Evidence, nodeId: string, run: Run): Promise<void> => {
  const ms = run.movedOnAt === undefined ? undefined : run.movedOnAt - run.fired.offboardedAt;
  evidence.mark(
    `${nodeId}: seat moved on ${ms === undefined ? `NOT within ${String(MOVED_ON_WATCH_MS)} ms` : `${String(ms)} ms after junto offboard returned`}`,
    `offboard-to-moved-on-${nodeId}-g${String(run.generation)}`,
  );
  check(run.movedOnAt, `${nodeId}: the seat moved on after junto offboard, with its old process still mid-turn`).toBeDefined();
  if (ms !== undefined) check(ms, `${nodeId}: offboard to seat moved on, in ms`).toBeLessThan(MOVED_ON_AFTER_OFFBOARD_MS);
  const alive = await isAlive(run.old);
  evidence.mark(`${nodeId}: its old process (generation ${String(run.generation)}) is still running: ${String(alive)}`);
  check(alive, `${nodeId}: the old process is still alive after the offboard: it is left to finish its turn`).toBe(true);
};

/** The one line came promptly: within LINE_AFTER_FRESH_MS of the fresh process, or of `afterAt` when that is later. */
const checkLinePrompt = (check: typeof expect, evidence: Evidence, nodeId: string, run: Run, afterAt?: number): void => {
  const from = Math.max(run.restartedAt ?? run.fired.offboardedAt, afterAt ?? 0);
  const ms = run.lineAt === undefined ? undefined : Math.max(0, run.lineAt - from);
  evidence.mark(
    `${nodeId}: continuation line ${ms === undefined ? `NOT within ${String(DELIVERY_MS)} ms` : `${String(ms)} ms after the fresh process${afterAt !== undefined && afterAt > (run.restartedAt ?? 0) ? " (counted from the operator's last key)" : ""}`}`,
    `line-after-fresh-${nodeId}`,
  );
  check(run.lineAt, `${nodeId}: the continuation line reached the fresh session`).toBeDefined();
  if (ms !== undefined) check(ms, `${nodeId}: from the fresh process to its continuation line, in ms`).toBeLessThan(LINE_AFTER_FRESH_MS);
};

/** No view of a seat that offboarded says its process could not start. */
const checkNoFailedStartCopy = async (view: Locator, who: string): Promise<void> => {
  await soft(view, `${who}: a seat that offboarded never reads "${FAILED_START_COPY}"`).not.toContainText(FAILED_START_COPY);
};

/**
 * Nothing reached the old process since the offboard (P2). Its own input log
 * is the witness: only that process writes it. The drive's journal is keyed
 * by seat, so it is read only up to the next generation's launch.
 */
const checkOldSilent = async (
  check: typeof expect,
  evidence: Evidence,
  sandbox: Sandbox,
  nodeId: string,
  run: Run,
  snapshot: string = run.before,
): Promise<void> => {
  const old = await inputOf(sandbox, nodeId, run.generation);
  const added = old.startsWith(snapshot) ? old.slice(snapshot.length) : old;
  evidence.mark(
    `${nodeId}: generation ${String(run.generation)}, written between the command's launch and its arrival at Junto (not judged, ${String(run.fired.offboardedAt - run.fired.firedAt)} ms): ${JSON.stringify(run.inFlight)}`,
  );
  evidence.mark(`${nodeId}: reached the OLD process (generation ${String(run.generation)}) after the offboard was accepted: ${JSON.stringify(added)}`);
  check(added, `${nodeId}: nothing reached the old process after junto offboard was accepted`).toBe("");
  // The journal's writes either side of the acceptance, to line up by eye
  // (it is keyed by seat: the first one after may be the fresh process's).
  const all = await driveWrites(sandbox, nodeId);
  const lastBefore = all.filter((write) => write.at <= run.fired.offboardedAt).at(-1);
  const firstAfter = all.find((write) => write.at > run.fired.offboardedAt);
  evidence.mark(
    `${nodeId}: generation ${String(run.generation)} offboard launched ${new Date(run.fired.firedAt).toISOString()}, accepted ${new Date(run.fired.offboardedAt).toISOString()}; ` +
      `last drive write before acceptance: ${lastBefore ? `${lastBefore.ts} ${lastBefore.stage}` : "none"}; first after: ${firstAfter ? `${firstAfter.ts} ${firstAfter.stage}` : "none"}`,
    `journal-around-offboard-${nodeId}-g${String(run.generation)}`,
  );
  const until = Math.min(run.movedOnAt ?? Date.now(), (await launchedAt(sandbox, nodeId, run.generation + 1)) ?? Number.POSITIVE_INFINITY);
  const writes = writesBetween(await driveWrites(sandbox, nodeId), run.fired.offboardedAt, until);
  evidence.mark(`${nodeId}: drive writes to the seat from the offboard until it moved on: ${writes.join(", ") || "none"}`);
  check(writes, `${nodeId}: drive writes to the seat between the offboard and its move-on`).toEqual([]);
};

const countIn = (inputs: ReadonlyArray<string>, needle: string): number =>
  inputs.reduce((sum, input) => sum + occurrences(input, needle), 0);

/** Continue: a fresh process, by itself, typed the one line, while the old one still runs (P1). */
const checkContinued = async (check: typeof expect, evidence: Evidence, junto: JuntoHandle, nodeId: string, run: Run): Promise<void> => {
  const ms = run.restartedAt === undefined ? undefined : run.restartedAt - run.fired.offboardedAt;
  evidence.mark(
    `${nodeId}: fresh process ${ms === undefined ? `NOT within ${String(FRESH_WATCH_MS)} ms` : `${String(ms)} ms after junto offboard returned`}`,
    `offboard-to-restarted-${nodeId}-g${String(run.generation)}`,
  );
  check(run.restartedAt, `${nodeId}: a fresh process started by itself`).toBeDefined();
  if (ms !== undefined) check(ms, `${nodeId}: offboard to fresh process, in ms`).toBeLessThan(FRESH_AFTER_OFFBOARD_MS);
  check(run.lineAt, `${nodeId}: the fresh session was typed its continuation line`).toBeDefined();
  const alive = await isAlive(run.old);
  evidence.mark(`${nodeId}: with the fresh session on its line, the old process is still running: ${String(alive)}`);
  check(alive, `${nodeId}: the old process is not stopped until it goes idle`).toBe(true);
};

/** How many continuation lines each generation got. */
const lineCounts = async (sandbox: Sandbox, nodeId: string): Promise<ReadonlyArray<number>> =>
  (await inputsOf(sandbox, nodeId)).map((input) => occurrences(input, CONTINUATION_LINE));

/**
 * P6, the old process's later output: it prints a marker line on its own
 * terminal after the offboard. The seat's view must never show it.
 */
const printFromOld = async (evidence: Evidence, nodeId: string, run: Run): Promise<string> => {
  const marker = `OLD-PROCESS-OUTPUT-${nodeId}-g${String(run.generation)}`;
  await run.old.print(marker);
  evidence.mark(`${nodeId}: the old process printed "${marker}" on its own terminal`);
  return marker;
};

const checkOldOutputHidden = async (evidence: Evidence, page: Page, nodeId: string, marker: string, view?: Locator): Promise<void> => {
  const whole = `${await transcriptOf(page, nodeId)}\n${await screenOf(page, nodeId)}`;
  const shown = squash(whole).includes(squash(marker));
  evidence.mark(`${nodeId}: the old process's later output is on the seat's view: ${String(shown)}`);
  soft(shown, `${nodeId}: output the old process printed after the offboard shows on the seat's view or tile`).toBe(false);
  if (view !== undefined) await soft(view, `${nodeId}: nor in the view's own text`).not.toContainText(marker);
};

/**
 * P3: let the old turn end and watch the old process go. The OLD process is
 * set idle through its own generation's control file; the fresh process has
 * its own and never reads this one. Just before, its input must still be
 * what it was at the offboard (P2, over its whole life off the seat).
 */
const windDown = async (
  check: typeof expect,
  evidence: Evidence,
  junto: JuntoHandle,
  nodeId: string,
  run: Run,
  options: {
    /** The screen that reads idle for this seat's harness. */
    readonly idle?: Parameters<CrewSeat["control"]>[0]["screen"];
    /** This process ignores SIGTERM. */
    readonly stubborn?: boolean;
    /** How many "(settled)" lines main must have logged for the seat by the end. */
    readonly settledLines?: number;
    /** What the old process's input may have gained since the offboard without it being a miss. */
    readonly snapshot?: string;
  } = {},
): Promise<number | undefined> => {
  const { sandbox } = junto;
  const { mark } = evidence;
  const snapshot = options.snapshot ?? run.before;
  const before = await inputOf(sandbox, nodeId, run.generation);
  check(before.startsWith(snapshot) ? before.slice(snapshot.length) : before, `${nodeId}: nothing reached the old process in all its time off the seat`).toBe("");
  check(await isAlive(run.old), `${nodeId}: the old process ran until its turn ended`).toBe(true);
  await run.old.control({ screen: options.idle ?? { mode: "idle" } });
  const idleAt = mark(`${nodeId}: the old process's turn ended (generation ${String(run.generation)} set idle)`);
  const goneAt = await waitGone(run.old, GONE_WATCH_MS);
  const ms = goneAt === undefined ? undefined : Math.max(0, goneAt - idleAt);
  mark(
    `${nodeId}: old process ${ms === undefined ? `NOT gone within ${String(GONE_WATCH_MS)} ms of idle` : `gone ${String(ms)} ms after it went idle (its last heartbeat)`}`,
    `idle-to-gone-${nodeId}-g${String(run.generation)}`,
  );
  check(goneAt, `${nodeId}: the old process is gone once its turn has ended`).toBeDefined();
  if (ms !== undefined) check(ms, `${nodeId}: old process idle to gone, in ms`).toBeLessThan(GONE_AFTER_IDLE_MS);

  const events = await run.old.events();
  const term = events.filter((event) => event.event === (options.stubborn === true ? "sigterm-ignored" : "sigterm"));
  mark(`${nodeId}: the old process recorded SIGTERM ${String(term.length)} time(s)${options.stubborn === true ? " and ignored it" : ""}`);
  if (options.stubborn === true) {
    soft(term.length, `${nodeId}: the process was sent SIGTERM and ignored it`).toBeGreaterThan(0);
    const termAt = term[0]?.at;
    if (termAt !== undefined && goneAt !== undefined) {
      mark(`${nodeId}: gone ${String(Math.max(0, goneAt - termAt))} ms after the SIGTERM it ignored`, `term-to-gone-${nodeId}`);
      soft(goneAt - termAt, `${nodeId}: from the ignored SIGTERM to the process being gone, in ms`).toBeLessThan(TERM_TO_GONE_MS);
    }
  }

  // Main says how it ended, and the session's row agrees.
  const line = endedLine(nodeId, "settled");
  await check
    .poll(() => occurrences(offboardLines(evidence.mainLog()).join("\n"), line), { message: `main's "${line}" lines`, timeout: 10_000 })
    .toBeGreaterThanOrEqual(options.settledLines ?? 1);
  const rows = drainRows(sandbox, nodeId);
  mark(`${nodeId}: session rows (detached, ended, how): ${JSON.stringify(rows)}`, `drain-rows-${nodeId}-g${String(run.generation)}`);
  if (rows.length > 0) {
    soft(rows.filter((row) => row.endedHow === "settled").length, `${nodeId}: session rows that ended "settled"`).toBeGreaterThanOrEqual(options.settledLines ?? 1);
  }
  check(await inputOf(sandbox, nodeId, run.generation), `${nodeId}: the old process's input never changed, to its end`).toBe(before);
  return goneAt;
};

/**
 * An open view follows the fresh process: its screen shows the continuation
 * line soon after the line reached the process, with no click, and it does
 * not sit on a stopped seat with a Reopen button.
 */
const checkViewFollows = async (evidence: Evidence, junto: JuntoHandle, nodeId: string, run: Run, view: Locator): Promise<void> => {
  const { page } = junto;
  let onScreen: number | undefined;
  const until = Date.now() + (run.lineAt === undefined ? 0 : VIEW_FOLLOWS_MS * 3);
  do {
    if (squash(await screenOf(page, nodeId)).includes(squash(CONTINUATION_ON_SCREEN))) {
      onScreen = Date.now();
      break;
    }
    await sleep(POLL_MS);
  } while (Date.now() < until);
  const lag = run.lineAt !== undefined && onScreen !== undefined ? Math.max(0, onScreen - run.lineAt) : undefined;
  evidence.mark(
    `${nodeId}: the open view showed the fresh session ${onScreen === undefined ? "NEVER" : `${String(onScreen - run.fired.offboardedAt)} ms after the offboard`}` +
      `, ${lag === undefined ? "lag not measured" : `at most ${String(lag)} ms after the line reached the fresh process`}`,
    `view-follows-${nodeId}`,
  );
  soft(onScreen, `${nodeId}: the open view shows the fresh session's screen, with no click`).toBeDefined();
  if (lag !== undefined) soft(lag, `${nodeId}: from the line reaching the fresh process to the view showing it, in ms`).toBeLessThan(VIEW_FOLLOWS_MS);
  const fresh = isLive(await sessionOf(page, nodeId).catch(() => undefined));
  const reopen = await view.getByRole("button", { name: "Reopen", exact: true }).count();
  const dead = await view.locator(".native-terminal-surface__dead").count();
  evidence.mark(`${nodeId}: fresh process running=${String(fresh)}, Reopen buttons on its view=${String(reopen)}, stopped overlay=${String(dead)}`);
  soft(fresh && (reopen > 0 || dead > 0), `${nodeId}: ${STALE_VIEW}`).toBe(false);
};

// ===========================================================================
// SA: the focus view is open on the offboarding seat
// ===========================================================================

const focusViewFlow = (mode: "rest" | "continue"): void => {
  const id = mode === "rest" ? "SA-rest" : "SA-continue";
  test(`${id} [fake-tui] the focus view stays open, and shows only the ${mode === "rest" ? "resting seat" : "fresh session"}, while its seat offboards mid-turn`, async ({}, testInfo) => {
    test.setTimeout(360_000);
    const SEAT = codexSeat("closer", "Closer", 120, 220);
    await walk(testInfo, id, docOf([SEAT]), async (junto, evidence) => {
      const { page, sandbox } = junto;
      const { mark } = evidence;
      const running = await seatMidTurn(junto, SEAT, { onboard: true });
      const surface = await openFocusView(page, SEAT.id);
      const modal = page.locator("[role='dialog']").filter({ has: page.locator(SURFACE) });
      await soft(modal, "the seat's terminal is inside the focus modal").toHaveCount(1);
      mark(`focus modal label: ${JSON.stringify(await modal.first().getAttribute("aria-label").catch(() => null))}`, "modal-label");
      await evidence.shot(page, "1-focus-view-open-mid-turn");
      await watchFocusView(page);

      const run = await offboardRun(junto, testInfo, SEAT.id, 1, running.oldEpoch, mode === "continue" ? NEXT : undefined);
      await evidence.shot(page, "2-after-the-offboard");
      await checkMovedOn(expect, evidence, SEAT.id, run);
      await checkOldSilent(expect, evidence, sandbox, SEAT.id, run);
      // The old process goes on with its turn and prints: none of it may show.
      const marker = await printFromOld(evidence, SEAT.id, run);

      if (mode === "continue") {
        await checkContinued(expect, evidence, junto, SEAT.id, run);
        await checkViewFollows(evidence, junto, SEAT.id, run, surface);
        await evidence.shot(page, "3-fresh-process-in-the-same-view");
        await sleep(QUIET_MS);
        expect(await lineCounts(sandbox, SEAT.id), "continuation lines per generation").toEqual([0, 1]);
      } else {
        await soft.poll(() => offboardStage(page, SEAT.id), { message: "where the seat's offboard stands", timeout: 10_000 }).toBe("resting");
        // P9: the view says why its process is gone, and offers Reopen.
        await soft(surface, "the resting seat's view says it offboarded").toContainText(RESTING_COPY, { timeout: 10_000 });
        await soft(surface.getByRole("button", { name: "Reopen", exact: true }), "the resting seat's view offers Reopen").toBeVisible();
        await sleep(QUIET_MS);
        expect(await launches(sandbox, SEAT.id), "a resting seat starts no process by itself").toBe(1);
        await evidence.shot(page, "3-resting-in-the-same-view");
      }
      soft(await nodeSessionId(page, SEAT.id), "the node no longer names the old session").not.toBe(`${CODEX_SESSION}-${SEAT.id}`);
      await checkOldOutputHidden(evidence, page, SEAT.id, marker, surface);

      // The whole time: one surface, the same element, never none.
      const samples = await stopWatch(page);
      const story = storyOf(samples);
      for (const line of story) mark(`focus view: ${line}`);
      note(testInfo, `${id}-focus-view-story`, story.join("\n"));
      const gaps = samples.filter((sample) => sample.surfaces === 0);
      const swapped = samples.filter((sample) => sample.surfaces > 0 && !sample.same);
      mark(`samples: ${String(samples.length)}, with no surface: ${String(gaps.length)}, with another surface element: ${String(swapped.length)}`, "focus-view-gaps");
      soft(samples.length, "the view was sampled").toBeGreaterThan(10);
      soft(gaps.map((sample) => new Date(sample.t).toISOString()), "moments with no terminal surface in the focus view").toEqual([]);
      soft(swapped.map((sample) => new Date(sample.t).toISOString()), "moments when the surface was a different element").toEqual([]);
      soft(await page.locator(SURFACE).count(), "the focus view is still open").toBe(1);
      soft(
        samples.filter((sample) => `${sample.status} ${sample.dead}`.includes(FAILED_START_COPY)).map((sample) => new Date(sample.t).toISOString()),
        `moments when the view read "${FAILED_START_COPY}"`,
      ).toEqual([]);
      await checkNoFailedStartCopy(surface, SEAT.id);

      if (mode === "continue") {
        // Usable as it is: an empty input box on the FRESH process, click in, type a word.
        const fresh = genSeat(sandbox, SEAT.id, 2);
        await fresh.control({ screen: { mode: "idle" } });
        await expectSeatState(page, SEAT.id, "idle");
        await focusTerminal(page, surface);
        await page.keyboard.type("pong");
        await soft.poll(() => inputOf(sandbox, SEAT.id, 2), { message: "the fresh generation's input after typing", timeout: 15_000 }).toContain("pong");
        await soft.poll(async () => squash(await screenOf(page, SEAT.id)), { message: "the screen after typing", timeout: 15_000 }).toContain("pong");
        await evidence.shot(page, "4-typed-into-the-fresh-process");
      } else {
        // Recorded: what a resting seat's view shows and offers, and where typing goes.
        const last = samples.at(-1);
        mark(`resting view: status="${last?.status ?? ""}" overlay="${last?.dead ?? ""}" reopen=${String(last?.reopen ?? false)}`, "resting-view-copy");
        mark(`resting view offers: ${(await buttonsOn(surface)).join(", ") || "no buttons"}`, "resting-view-buttons");
        const clicked = await surface
          .locator(".xterm-screen")
          .click({ timeout: 3_000 })
          .then(() => true)
          .catch(() => false);
        const keyboardIn = await page.evaluate(() => document.activeElement?.closest(".native-terminal-surface") != null);
        await page.keyboard.type("pong");
        await sleep(3_000);
        const inputs = await inputsOf(sandbox, SEAT.id);
        mark(
          `typing into the resting view: click reached the terminal=${String(clicked)}, keyboard in the terminal=${String(keyboardIn)}, ` +
            `processes now=${String(inputs.length)}, word reached=${inputs.map((input, index) => (input.includes("pong") ? `generation ${String(index + 1)}` : "")).filter(Boolean).join(", ") || "nothing"}`,
          "resting-view-typing",
        );
        await evidence.shot(page, "4-resting-after-typing");
      }

      // P2 to the end, then P3: the old turn ends and its process is wound down.
      await windDown(expect, evidence, junto, SEAT.id, run);
      await checkOldOutputHidden(evidence, page, SEAT.id, marker, surface);
      if (mode === "continue") soft(await isAlive(genSeat(sandbox, SEAT.id, 2)), "the fresh process is untouched by the old one's end").toBe(true);
      await evidence.shot(page, "5-old-process-wound-down");
    });
  });
};

focusViewFlow("rest");
focusViewFlow("continue");

test("SA3 [fake-tui] a view the operator stopped stays stopped when mail wakes the seat, until Reopen", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const SEAT = codexSeat("closer", "Closer", 120, 220);
  await walk(testInfo, "SA3", docOf([SEAT]), async (junto, evidence) => {
    const { page, sandbox } = junto;
    const { mark } = evidence;
    await crewPlayFactory(page);
    await startSeat(junto, SEAT);
    const mailer = await startSeat(junto, MAILER);
    const surface = await openFocusView(page, SEAT.id);

    // The operator presses Stop, then confirms (terminal-kill-ux.ts: two clicks).
    await surface.getByRole("button", { name: "Stop this agent's process", exact: true }).click();
    await surface.getByRole("button", { name: "Confirm: stop this agent's process", exact: true }).click();
    const overlay = surface.locator(".native-terminal-surface__dead");
    const reopen = overlay.getByRole("button", { name: "Reopen", exact: true });
    await expect(reopen, "the stopped view offers Reopen").toBeVisible({ timeout: 30_000 });
    await expect.poll(async () => isLive(await sessionOf(page, SEAT.id)), { message: "the seat's process is stopped", timeout: 15_000 }).toBe(false);
    mark(`stopped view copy: ${JSON.stringify(((await overlay.allTextContents()) as string[]).join(" ").replace(/\s+/gu, " ").trim())}`, "stopped-copy");
    await evidence.shot(page, "1-stopped-by-the-operator");

    // Mail wakes the seat behind the stopped view.
    const wake = "wake up: retry the nightly sync";
    void mailer.op("msg.send", { target: SEAT.id, text: wake }).catch(() => undefined);
    await expect.poll(() => launches(sandbox, SEAT.id), { message: "mail wakes the seat: a second process", timeout: DELIVERY_MS }).toBe(2);
    await expect.poll(() => inputOf(sandbox, SEAT.id, 2), { message: "the woken process gets the mail", timeout: DELIVERY_MS }).toContain(wake);
    mark("the seat was woken by mail behind the stopped view");

    // The operator's stop is not overridden: the view stays stopped.
    await watchFocusView(page);
    await sleep(STOPPED_STAYS_MS);
    const samples = await stopWatch(page);
    for (const line of storyOf(samples)) mark(`focus view while woken behind: ${line}`);
    soft(samples.length, "the view was sampled").toBeGreaterThan(10);
    soft(
      samples.filter((sample) => !sample.reopen || sample.dead === "").map((sample) => new Date(sample.t).toISOString()),
      "moments when the stopped view stopped showing as stopped, without Reopen being clicked",
    ).toEqual([]);
    soft(await launches(sandbox, SEAT.id), "the view started nothing itself").toBe(2);
    await evidence.shot(page, "2-still-stopped-while-the-seat-runs");

    // Reopen: recorded.
    await reopen.click();
    await sleep(3_000);
    mark(`after Reopen: processes=${String(await launches(sandbox, SEAT.id))}, live=${String(isLive(await sessionOf(page, SEAT.id)))}`, "after-reopen");
    mark(`after Reopen the view offers: ${(await buttonsOn(surface)).join(", ") || "no buttons"}`, "after-reopen-buttons");
    mark(`after Reopen the stopped overlay is shown: ${String((await overlay.count()) > 0)}`, "after-reopen-overlay");
    mark(`after Reopen the screen shows the mail: ${String(squash(await screenOf(page, SEAT.id)).includes(squash(wake)))}`, "after-reopen-screen");
    mark(`screen after Reopen: ${JSON.stringify((await screenOf(page, SEAT.id)).trim().slice(-300))}`);
    await evidence.shot(page, "3-after-reopen");
  });
});

// ===========================================================================
// SB: several seats offboard in the same second (P7)
// ===========================================================================

test("SB [fake-tui] four seats in the grid offboard in the same second, mid-turn: three continue, one rests, each on its own", async ({}, testInfo) => {
  test.setTimeout(600_000);
  const ids = ["g1", "g2", "g3", "g4"] as const;
  const RESTS = "g4";
  const seats = ids.map((id, index) => codexSeat(id, `Grid ${String(index + 1)}`, 40 + index * 300, 120));
  await walk(testInfo, "SB", docOf(seats), async (junto, evidence) => {
    const { page, sandbox } = junto;
    const { mark } = evidence;
    await crewPlayFactory(page);
    const handles = new Map<string, CrewSeat>();
    for (const node of seats) handles.set(node.id, await startSeat(junto, node));
    const mailer = await startSeat(junto, MAILER);
    const epochs = new Map<string, string | undefined>();
    for (const id of ids) {
      opData(await handles.get(id)!.op("onboard", {}));
      epochs.set(id, (await sessionOf(page, id))?.epoch);
    }

    // The grid, opened from the selection's menu (terminal-grid-keyboard.spec.ts:31-35).
    await page.locator(".react-flow__pane").click({ position: { x: 20, y: 600 } });
    for (const id of ids) await seatCard(page, id).click({ modifiers: ["Shift"] });
    await seatCard(page, "g2").click({ button: "right" });
    await page.getByRole("button", { name: "Open 4 agents in a grid" }).click();
    const grid = page.getByTestId("terminal-grid-focus");
    const cells = grid.locator(".terminal-grid__cell");
    await expect(cells).toHaveCount(4, { timeout: 10_000 });
    const cell = (id: string): Locator => grid.locator(`.terminal-grid__cell[data-node-id="${id}"]`);

    for (const id of ids) await startTurn(junto, mailer, id);
    await evidence.shot(page, "1-grid-open-all-mid-turn");

    // All four offboard together, mid-turn. Nobody goes idle.
    const began = mark("four offboards begin");
    const runs = await Promise.all(ids.map((id) => offboardRun(junto, testInfo, id, 1, epochs.get(id), id === RESTS ? undefined : NEXT)));
    mark(`the four offboards returned within ${String(Math.max(...runs.map((run) => run.fired.offboardedAt)) - began)} ms of the first being run`, "offboards-span");
    const runOf = (id: string): Run => runs[ids.indexOf(id as (typeof ids)[number])]!;
    const markers = new Map<string, string>();
    for (const id of ids) markers.set(id, await printFromOld(evidence, id, runOf(id)));
    await evidence.shot(page, "2-after-the-offboards");

    const continuing = ids.filter((id) => id !== RESTS);
    for (const id of ids) {
      await checkMovedOn(soft, evidence, id, runOf(id));
      await checkOldSilent(soft, evidence, sandbox, id, runOf(id));
      if (id !== RESTS) {
        await checkContinued(soft, evidence, junto, id, runOf(id));
        checkLinePrompt(soft, evidence, id, runOf(id));
      }
    }
    const restartLatency = continuing.map((id) => {
      const run = runOf(id);
      return run.restartedAt === undefined ? undefined : run.restartedAt - run.fired.offboardedAt;
    });
    const known = restartLatency.filter((ms): ms is number => ms !== undefined);
    mark(`offboard to restarted, per continuing seat: ${JSON.stringify(restartLatency)}`, "restart-latencies");
    if (known.length === continuing.length) {
      soft(Math.max(...known) - Math.min(...known), "spread between the first and the last to restart, in ms").toBeLessThan(RESTART_SPREAD_MS);
    }

    // The tiles follow by themselves, and show nothing of the old processes.
    for (const id of continuing) await checkViewFollows(evidence, junto, id, runOf(id), cell(id));
    await soft(cells, "the grid still has its four tiles").toHaveCount(4);

    await sleep(QUIET_MS);
    for (const id of ids) {
      const counts = await lineCounts(sandbox, id);
      mark(`${id}: processes=${String(counts.length)}, continuation lines per generation=${JSON.stringify(counts)}`, `lines-${id}`);
      if (id === RESTS) {
        soft(counts, `${id} rests: no fresh process, no continuation line`).toEqual([0]);
        await soft(cell(id), `${id}: its tile says it offboarded`).toContainText(RESTING_COPY);
        await soft.poll(() => offboardStage(page, id), { message: `${id}: where its offboard stands`, timeout: 10_000 }).toBe("resting");
      } else {
        soft(counts, `${id}: none in the old generation, exactly one in the fresh one`).toEqual([0, 1]);
      }
      soft(await nodeSessionId(page, id), `${id}: its node no longer names the old session`).not.toBe(`${CODEX_SESSION}-${id}`);
      await checkNoFailedStartCopy(cell(id), `${id} tile`);
      await checkOldOutputHidden(evidence, page, id, markers.get(id)!, cell(id));
      mark(`${id} tile text: ${JSON.stringify(((await cell(id).allTextContents().catch(() => [])) as string[]).join(" ").replace(/\s+/gu, " ").trim().slice(0, 300))}`);
    }
    await evidence.shot(page, "3-grid-after-the-offboards");

    // The four old turns end together: four wind-downs, side by side.
    const gone = await Promise.all(ids.map((id) => windDown(soft, evidence, junto, id, runOf(id))));
    mark(`old processes gone at: ${JSON.stringify(gone.map((at) => (at === undefined ? null : new Date(at).toISOString())))}`);
    for (const id of continuing) soft(await isAlive(genSeat(sandbox, id, 2)), `${id}: its fresh process is untouched`).toBe(true);
    await evidence.shot(page, "4-old-processes-wound-down");
  });
});

test("SB5 [fake-tui] five seats continue in the same second, mid-turn, and the one that ignores SIGTERM delays nobody", async ({}, testInfo) => {
  test.setTimeout(600_000);
  const ids = ["f1", "f2", "f3", "f4", "f5"] as const;
  const STUBBORN = "f5";
  const seats = ids.map((id, index) => codexSeat(id, `Five ${String(index + 1)}`, 40 + (index % 4) * 300, 100 + Math.floor(index / 4) * 160));
  await walk(testInfo, "SB5", docOf(seats), async (junto, evidence) => {
    const { page, sandbox } = junto;
    const { mark } = evidence;
    await crewPlayFactory(page);
    // Before it ever starts: this seat's processes ignore SIGTERM.
    await mkdir(seatDir(sandbox, STUBBORN), { recursive: true });
    await writeFile(join(seatDir(sandbox, STUBBORN), "ignore-term"), "", "utf8");
    const handles = new Map<string, CrewSeat>();
    for (const node of seats) handles.set(node.id, await startSeat(junto, node));
    const mailer = await startSeat(junto, MAILER);
    const epochs = new Map<string, string | undefined>();
    for (const id of ids) {
      opData(await handles.get(id)!.op("onboard", {}));
      epochs.set(id, (await sessionOf(page, id))?.epoch);
    }
    for (const id of ids) await startTurn(junto, mailer, id);
    await evidence.shot(page, "1-all-mid-turn");

    const began = mark("five offboards begin");
    const runs = await Promise.all(ids.map((id) => offboardRun(junto, testInfo, id, 1, epochs.get(id), NEXT)));
    mark(`the five offboards returned within ${String(Math.max(...runs.map((run) => run.fired.offboardedAt)) - began)} ms of the first being run`, "offboards-span");
    const runOf = (id: string): Run => runs[ids.indexOf(id as (typeof ids)[number])]!;

    for (const id of ids) {
      await checkMovedOn(soft, evidence, id, runOf(id));
      await checkOldSilent(soft, evidence, sandbox, id, runOf(id));
      await checkContinued(soft, evidence, junto, id, runOf(id));
    }
    const latency = ids.map((id) => {
      const run = runOf(id);
      return run.restartedAt === undefined ? undefined : run.restartedAt - run.fired.offboardedAt;
    });
    const known = latency.filter((ms): ms is number => ms !== undefined);
    mark(`offboard to restarted, per seat: ${JSON.stringify(latency)}`, "restart-latencies");
    soft(known.length, "all five restarted").toBe(5);
    if (known.length > 1) soft(Math.max(...known) - Math.min(...known), "spread between the first and the last to restart, in ms").toBeLessThan(RESTART_SPREAD_MS);

    await sleep(QUIET_MS);
    for (const id of ids) {
      const counts = await lineCounts(sandbox, id);
      mark(`${id}: continuation lines per generation=${JSON.stringify(counts)}`, `lines-${id}`);
      soft(counts, `${id}: none in the old generation, exactly one in the fresh one`).toEqual([0, 1]);
      await soft.poll(() => offboardStage(page, id), { message: `${id}: where its offboard stands`, timeout: 10_000 }).toBe("started");
    }

    // The five old turns end together. The one that ignores SIGTERM takes
    // its 1.5 s more; the other four must not wait for it.
    const endAt = mark("the five old turns end");
    const gone = await Promise.all(ids.map((id) => windDown(soft, evidence, junto, id, runOf(id), { stubborn: id === STUBBORN })));
    const ordinary = ids.filter((id) => id !== STUBBORN).map((id) => gone[ids.indexOf(id)]);
    const ordinaryKnown = ordinary.filter((at): at is number => at !== undefined);
    mark(
      `idle to gone, the four ordinary seats: ${JSON.stringify(ordinary.map((at) => (at === undefined ? null : at - endAt)))}; the one ignoring SIGTERM: ${String(gone[ids.indexOf(STUBBORN)] === undefined ? null : gone[ids.indexOf(STUBBORN)]! - endAt)}`,
      "wind-down-latencies",
    );
    if (ordinaryKnown.length > 1) {
      soft(Math.max(...ordinaryKnown) - Math.min(...ordinaryKnown), "spread between the first and the last ordinary old process to go, in ms").toBeLessThan(RESTART_SPREAD_MS);
    }
    for (const id of ids) soft(await isAlive(genSeat(sandbox, id, 2)), `${id}: its fresh process is untouched`).toBe(true);
    await evidence.shot(page, "2-after-the-wind-downs");
  });
});

test("SB-again-codex [fake-tui] a second offboard from a fresh Codex session, which has no session id yet, is refused and changes nothing (recorded)", async ({}, testInfo) => {
  test.setTimeout(360_000);
  const SEAT = codexSeat("closer", "Closer", 120, 220);
  await walk(testInfo, "SB-again-codex", docOf([SEAT]), async (junto, evidence) => {
    const { page, sandbox } = junto;
    const { mark } = evidence;
    const running = await seatMidTurn(junto, SEAT, { onboard: true });
    const first = await offboardRun(junto, testInfo, SEAT.id, 1, running.oldEpoch, NEXT);
    await checkMovedOn(expect, evidence, SEAT.id, first);
    await checkContinued(expect, evidence, junto, SEAT.id, first);
    await expectSeatState(page, SEAT.id, "working");

    // Codex announces its own session id (a capture harness) and the fake
    // never does, so the fresh session has none: a second offboard is turned
    // away (work/control.ts:1305-1313). On record, not judged hard.
    const fresh = genSeat(sandbox, SEAT.id, 2);
    const stateOf = async (): Promise<string> =>
      JSON.stringify({
        freshInput: await inputOf(sandbox, SEAT.id, 2),
        processes: await launches(sandbox, SEAT.id),
        epoch: (await sessionOf(page, SEAT.id))?.epoch,
        session: await nodeSessionId(page, SEAT.id),
        stage: await offboardStage(page, SEAT.id),
      });
    const before = await stateOf();
    const answer = await fresh.op("offboard", { notes: NOTES, continuation: NEXT });
    mark(`second offboard, from the fresh Codex session: ${JSON.stringify(answer)}`, "second-offboard-answer");
    soft(answer.ok, "the second offboard is refused").toBe(false);
    if (!answer.ok) {
      soft(answer.error.type, "the refusal's type").toBe("InvalidTransition");
      soft(answer.error.message, "the refusal's message").toBe("Junto does not know this session's id yet");
      mark(`refusal details: ${JSON.stringify(answer.error.details ?? null)}`, "second-offboard-next-step");
    }
    await sleep(3_000);
    soft(await stateOf(), "nothing changed: the fresh session, the seat's process, its node and its offboard stage are as they were").toBe(before);
    soft(await launches(sandbox, SEAT.id), "still two processes: one old one winding down, one fresh").toBe(2);
    soft(await isAlive(first.old), "the old process still winds down").toBe(true);
    soft(await isAlive(fresh), "the fresh process runs on").toBe(true);
    await evidence.shot(page, "1-second-offboard-refused");

    await windDown(expect, evidence, junto, SEAT.id, first);
    soft(await isAlive(fresh), "the fresh process is untouched by the old one's end").toBe(true);
  });
});

test("SB-again-claude [fake-tui] a seat on a pin harness offboards again from its fresh session while its first old process still runs", async ({}, testInfo) => {
  test.setTimeout(480_000);
  // The Claude-template fake of SF (see there for what it does not emulate):
  // a pin harness, so the fresh session has a session id from its launch.
  const OLD_SESSION = "22222222-2222-4222-8222-222222222222";
  const base = agentTextNode({ id: "claudia", key: "local:claudia", label: "Claudia", harness: "claude", x: 120, y: 220 });
  const SEAT: TextNode = { ...base, ether: { ...base.ether, terminal: { ...base.ether!.terminal!, sessionId: OLD_SESSION } } };
  const claudeIdle = { mode: "attention", text: CLAUDE_IDLE } as const;
  const claudeWorking = { mode: "attention", text: CLAUDE_WORKING } as const;

  await walk(testInfo, "SB-again-claude", crewDoc([SEAT]), async (junto, evidence) => {
    const { page, sandbox } = junto;
    const { mark } = evidence;
    /** Leave the next process an empty Claude prompt box to come up on. */
    const leaveIdleBoxForNext = (): Promise<void> =>
      writeFile(
        join(seatDir(sandbox, SEAT.id), "control.next.json"),
        JSON.stringify({ screen: claudeIdle, screenRequestId: `fresh-idle-${String(Date.now())}` }),
        "utf8",
      );
    await crewPlayFactory(page);
    const g1 = genSeat(sandbox, SEAT.id, 1);
    await crewOccupySeat(page, CANVAS, SEAT, g1);
    await g1.control({ screen: claudeIdle });
    await expectSeatState(page, SEAT.id, "idle");
    opData(await g1.op("onboard", {}));
    await g1.control({ screen: claudeWorking });
    await soft.poll(async () => (await seatState(page, SEAT.id)) ?? "none", { message: "the seat reads working", timeout: 20_000 }).toBe("working");

    // First offboard, mid-turn.
    await leaveIdleBoxForNext();
    const first = await offboardRun(junto, testInfo, SEAT.id, 1, (await sessionOf(page, SEAT.id))?.epoch, NEXT);
    await checkMovedOn(expect, evidence, SEAT.id, first);
    await checkContinued(expect, evidence, junto, SEAT.id, first);
    const secondSession = await nodeSessionId(page, SEAT.id);
    mark(`session ids so far: ${OLD_SESSION} then ${String(secondSession)}`);
    expect(secondSession, "the fresh session has a pinned id at once").toBeTruthy();
    expect(secondSession, "and it is not the first one").not.toBe(OLD_SESSION);

    // The fresh session is mid-turn on its line. It offboards too.
    const g2 = genSeat(sandbox, SEAT.id, 2);
    await g2.control({ screen: claudeWorking });
    await soft.poll(async () => (await seatState(page, SEAT.id)) ?? "none", { message: "the fresh session reads working", timeout: 20_000 }).toBe("working");
    await leaveIdleBoxForNext();
    const second = await offboardRun(junto, testInfo, SEAT.id, 2, (await sessionOf(page, SEAT.id))?.epoch, NEXT);
    mark(`second offboard answer: ${String(await second.fired.answer)}`, "second-offboard-answer");
    await checkMovedOn(expect, evidence, SEAT.id, second);
    await checkContinued(expect, evidence, junto, SEAT.id, second);
    expect(await launches(sandbox, SEAT.id), "the seat is on its third process").toBe(3);
    expect(await isAlive(first.old), "the first old process still runs").toBe(true);
    expect(await isAlive(second.old), "the second old process still runs").toBe(true);
    mark("two old processes are winding down, the seat is on a third");
    await evidence.shot(page, "1-two-old-processes");

    // Three sessions, three different ids.
    const thirdSession = await nodeSessionId(page, SEAT.id);
    mark(`session ids: ${OLD_SESSION}, ${String(secondSession)}, ${String(thirdSession)}`, "session-ids");
    expect(thirdSession, "the third session has a pinned id").toBeTruthy();
    expect(new Set([OLD_SESSION, secondSession, thirdSession]).size, "all three session ids differ").toBe(3);
    const pinFlag = templateFor("claude").argvSpec.sessionIdFlag ?? "--session-id";
    const pinOf = async (generation: number): Promise<string | undefined> => {
      const argv = await argvOf(sandbox, SEAT.id, generation);
      const at = argv.indexOf(pinFlag);
      return at >= 0 ? argv[at + 1] : undefined;
    };
    soft([await pinOf(1), await pinOf(2), await pinOf(3)], "each process was launched on its own session").toEqual([OLD_SESSION, secondSession, thirdSession]);

    await sleep(QUIET_MS);
    expect(await lineCounts(sandbox, SEAT.id), "continuation lines per generation").toEqual([0, 1, 1]);
    await checkOldSilent(expect, evidence, sandbox, SEAT.id, first);
    // The second old process was typed its own line before it offboarded: silence counts from its offboard.
    await checkOldSilent(expect, evidence, sandbox, SEAT.id, second);

    // Each is wound down when its own turn ends: the second first, then the first.
    await windDown(expect, evidence, junto, SEAT.id, second, { idle: claudeIdle, settledLines: 1 });
    expect(await isAlive(first.old), "the first old process is not stopped by the second one's end").toBe(true);
    await windDown(expect, evidence, junto, SEAT.id, first, { idle: claudeIdle, settledLines: 2 });
    expect(await isAlive(genSeat(sandbox, SEAT.id, 3)), "the seat's third process runs on").toBe(true);
    soft(isLive(await sessionOf(page, SEAT.id)), "the seat is live on it").toBe(true);
    soft(await nodeSessionId(page, SEAT.id), "and still names its third session").toBe(thirdSession);
    await evidence.shot(page, "2-both-wound-down");
  });
});

// ===========================================================================
// SC: a turn that never ends (P4). Ten minutes: run it apart, with -g "slow-cap".
// ===========================================================================

test("SC [slow-cap] [fake-tui] an old process that never goes idle is stopped at ten minutes", async ({}, testInfo) => {
  test.setTimeout(13 * 60 * 1_000);
  const SEAT = codexSeat("closer", "Closer", 120, 220);
  await walk(testInfo, "SC", docOf([SEAT]), async (junto, evidence) => {
    const { page, sandbox } = junto;
    const { mark } = evidence;
    const running = await seatMidTurn(junto, SEAT, { onboard: true });
    const run = await offboardRun(junto, testInfo, SEAT.id, 1, running.oldEpoch, undefined);
    await checkMovedOn(expect, evidence, SEAT.id, run);
    await evidence.shot(page, "1-resting-old-process-working");

    // Nothing ends its turn. The cap does.
    const goneAt = await waitGone(run.old, CAP_MS + CAP_LATE_MS);
    const ms = goneAt === undefined ? undefined : goneAt - run.fired.offboardedAt;
    mark(`old process ${ms === undefined ? `NOT gone within ${String(CAP_MS + CAP_LATE_MS)} ms` : `gone ${String(ms)} ms after the offboard`}`, "offboard-to-cap");
    expect(goneAt, "the old process was stopped without ever going idle").toBeDefined();
    expect(ms!, "it ran until the cap, in ms").toBeGreaterThan(CAP_MS - CAP_EARLY_MS);
    expect(ms!, "and no longer, in ms").toBeLessThan(CAP_MS + CAP_LATE_MS);
    await expect
      .poll(() => offboardLines(evidence.mainLog()).join("\n"), { message: "main's [offboard] lines", timeout: 15_000 })
      .toContain(endedLine(SEAT.id, "cap"));
    const rows = drainRows(sandbox, SEAT.id);
    mark(`session rows (detached, ended, how): ${JSON.stringify(rows)}`, "drain-rows");
    if (rows.length > 0) soft(rows.at(-1)?.endedHow, 'the session row says it ended at the "cap"').toBe("cap");
    await checkOldSilent(soft, evidence, sandbox, SEAT.id, run);
    await evidence.shot(page, "2-stopped-at-the-cap");
  });
});

// ===========================================================================
// SG: a process that ignores SIGTERM, at its wind-down
// ===========================================================================

test("SG [fake-tui] an old process that ignores SIGTERM is still gone a few seconds after its turn ends", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const SEAT = codexSeat("stubborn", "Stubborn", 120, 220);
  await walk(testInfo, "SG", docOf([SEAT]), async (junto, evidence) => {
    const { page, sandbox } = junto;
    await mkdir(seatDir(sandbox, SEAT.id), { recursive: true });
    await writeFile(join(seatDir(sandbox, SEAT.id), "ignore-term"), "", "utf8");
    const running = await seatMidTurn(junto, SEAT, { onboard: true });

    const run = await offboardRun(junto, testInfo, SEAT.id, 1, running.oldEpoch, NEXT);
    await checkMovedOn(expect, evidence, SEAT.id, run);
    await checkOldSilent(expect, evidence, sandbox, SEAT.id, run);
    await checkContinued(expect, evidence, junto, SEAT.id, run);
    await soft.poll(() => offboardStage(page, SEAT.id), { message: "where the seat's offboard stands", timeout: 10_000 }).toBe("started");
    await sleep(QUIET_MS);
    expect(await lineCounts(sandbox, SEAT.id), "continuation lines per generation").toEqual([0, 1]);

    // Its turn ends: TERM, ignored, then KILL. Still gone within the bound.
    await windDown(expect, evidence, junto, SEAT.id, run, { stubborn: true });
    soft(evidence.mainLog(), "main did not have to give up on the stop").not.toContain("stop unconfirmed");
    soft(await isAlive(genSeat(sandbox, SEAT.id, 2)), "the fresh process is untouched").toBe(true);
    await evidence.shot(page, "1-wound-down");
  });
});

// ===========================================================================
// SD: a draft in the input box
// ===========================================================================

const draftFlow = (mode: "rest" | "continue"): void => {
  const id = mode === "rest" ? "SD-rest" : "SD-continue";
  test(`${id} [fake-tui] an unsent operator draft does not hold the seat back (${mode})`, async ({}, testInfo) => {
    test.setTimeout(300_000);
    const SEAT = codexSeat("closer", "Closer", 120, 220);
    const DRAFT = "half a li";
    await walk(testInfo, id, docOf([SEAT]), async (junto, evidence) => {
      const { page, sandbox } = junto;
      const { mark } = evidence;
      const running = await seatMidTurn(junto, SEAT, { onboard: true });
      const surface = await openFocusView(page, SEAT.id);
      await focusTerminal(page, surface);
      // Half a line, not sent, while the seat works. (The fake keeps typed
      // text in its composer mid-turn but paints it only on an idle screen.)
      await page.keyboard.type(DRAFT);
      await expect.poll(() => inputOf(sandbox, SEAT.id, 1), { message: "the draft reached the seat", timeout: 15_000 }).toContain(DRAFT);
      mark("the operator typed half a line and did not send it");
      await evidence.shot(page, "1-draft-typed-mid-turn");

      const run = await offboardRun(junto, testInfo, SEAT.id, 1, running.oldEpoch, mode === "continue" ? NEXT : undefined);
      // The draft does not hold the seat: it moves on all the same.
      await checkMovedOn(expect, evidence, SEAT.id, run);
      await checkOldSilent(soft, evidence, sandbox, SEAT.id, run);
      await evidence.shot(page, "2-after-the-offboard");
      if (mode === "continue") {
        await checkContinued(expect, evidence, junto, SEAT.id, run);
        checkLinePrompt(soft, evidence, SEAT.id, run);
      } else {
        await soft.poll(() => offboardStage(page, SEAT.id), { message: "where the seat's offboard stands", timeout: 10_000 }).toBe("resting");
      }

      // Recorded: what became of the draft.
      await sleep(QUIET_MS);
      const inputs = await inputsOf(sandbox, SEAT.id);
      mark(`processes: ${String(inputs.length)}; the draft is in generation(s): ${inputs.map((input, index) => (input.includes(DRAFT) ? String(index + 1) : "")).filter(Boolean).join(", ") || "none"}`, "draft-reached");
      mark(`anything of the draft in the fresh session: ${inputs.slice(1).some((input) => input.includes(DRAFT)) ? "yes" : "no"}`, "draft-in-fresh-session");
      const screen = await screenOf(page, SEAT.id);
      mark(`the draft is on the seat's view at the end: ${squash(screen).includes(squash(DRAFT)) ? "yes" : "no"}`, "draft-on-screen-at-end");
      mark(`the view offers: ${(await buttonsOn(surface)).join(", ") || "no buttons"}`, "view-buttons-at-end");
      if (mode === "continue") soft(await lineCounts(sandbox, SEAT.id), "continuation lines per generation").toEqual([0, 1]);
      await checkNoFailedStartCopy(surface, SEAT.id);
      await evidence.shot(page, "3-at-the-end");

      // The old turn ends (its draft goes with its idle screen), and it is wound down.
      await windDown(expect, evidence, junto, SEAT.id, run);
    });
  });
};

draftFlow("rest");
draftFlow("continue");

// ===========================================================================
// SJ: hijack attempts in the moment after the offboard returns (P2)
// ===========================================================================

type Mode = "rest" | "continue";

/** Each text reached a fresh session exactly once, and the old process never. */
const checkDeliveredOnceToFresh = async (
  evidence: Evidence,
  junto: JuntoHandle,
  nodeId: string,
  texts: ReadonlyArray<string>,
  what: string,
): Promise<void> => {
  for (const text of texts) {
    await expect
      .poll(async () => countIn((await inputsOf(junto.sandbox, nodeId)).slice(1), text), {
        message: `${what} "${text}" in a fresh session of ${nodeId}`,
        timeout: DELIVERY_MS,
      })
      .toBeGreaterThanOrEqual(1);
  }
  await sleep(QUIET_MS);
  const inputs = await inputsOf(junto.sandbox, nodeId);
  for (const text of texts) {
    const perGeneration = inputs.map((input) => occurrences(input, text));
    evidence.mark(`${what} "${text}" per generation: ${JSON.stringify(perGeneration)}`, `delivered-${text}`);
    expect(perGeneration[0], `${what} "${text}" did not reach the OLD process`).toBe(0);
    expect(countIn(inputs.slice(1), text), `${what} "${text}" reached the fresh session exactly once`).toBe(1);
  }
};

const hijackByMail = (mode: Mode): void => {
  const id = `SJ1-mail-${mode}`;
  test(`${id} [fake-tui] mail sent the moment after offboard goes to the fresh session, once, never the old process`, async ({}, testInfo) => {
    test.setTimeout(360_000);
    const SEAT = codexSeat("closer", "Closer", 120, 220);
    const texts = ["hijack-mail-one", "hijack-mail-two"] as const;
    await walk(testInfo, id, docOf([SEAT]), async (junto, evidence) => {
      const { page, sandbox } = junto;
      const running = await seatMidTurn(junto, SEAT, { onboard: true });
      const run = await offboardRun(junto, testInfo, SEAT.id, 1, running.oldEpoch, mode === "continue" ? NEXT : undefined, async () => {
        // At once, and again a moment later. Not awaited: a send may wait on its delivery.
        void running.mailer.op("msg.send", { target: SEAT.id, text: texts[0] }).catch(() => undefined);
        evidence.mark(`mail "${texts[0]}" sent`);
        await sleep(HIJACK_AGAIN_MS);
        void running.mailer.op("msg.send", { target: SEAT.id, text: texts[1] }).catch(() => undefined);
        evidence.mark(`mail "${texts[1]}" sent`);
      });
      await checkMovedOn(expect, evidence, SEAT.id, run);
      await checkOldSilent(expect, evidence, sandbox, SEAT.id, run);
      if (mode === "continue") await checkContinued(expect, evidence, junto, SEAT.id, run);
      else await expect.poll(() => launches(sandbox, SEAT.id), { message: "the mail wakes the resting seat into a fresh process", timeout: FRESH_WATCH_MS }).toBeGreaterThanOrEqual(2);
      await checkDeliveredOnceToFresh(evidence, junto, SEAT.id, texts, "mail");
      const counts = await lineCounts(sandbox, SEAT.id);
      evidence.mark(`processes=${String(counts.length)}, continuation lines per generation=${JSON.stringify(counts)}`, "lines");
      soft(counts.reduce((sum, count) => sum + count, 0), "continuation lines in all").toBe(mode === "continue" ? 1 : 0);
      soft(counts[0], "none in the old process").toBe(0);
      await evidence.shot(page, "1-at-the-end");
      await windDown(expect, evidence, junto, SEAT.id, run);
    });
  });
};

const hijackByPrompt = (mode: Mode): void => {
  const id = `SJ2-prompt-${mode}`;
  test(`${id} [fake-tui] an operator prompt sent the moment after offboard goes to the fresh session, once, never the old process`, async ({}, testInfo) => {
    test.setTimeout(360_000);
    const SEAT = codexSeat("closer", "Closer", 120, 220);
    const texts = ["hijack-prompt-one", "hijack-prompt-two"] as const;
    await walk(testInfo, id, docOf([SEAT]), async (junto, evidence) => {
      const { page, sandbox } = junto;
      const running = await seatMidTurn(junto, SEAT, { onboard: true });
      // The seat's message composer, open and filled before the offboard (seat-message.spec.ts:75-110).
      await seatCard(page, SEAT.id).click();
      await page.getByTestId("seat-message-open").click();
      const composer = page.getByRole("dialog", { name: "Message Closer" });
      const field = composer.getByTestId("seat-message-field");
      await expect(field).toBeFocused();
      await field.fill(texts[0]);
      const status = composer.getByTestId("seat-message-status");
      await evidence.shot(page, "1-composer-ready");

      const run = await offboardRun(junto, testInfo, SEAT.id, 1, running.oldEpoch, mode === "continue" ? NEXT : undefined, async () => {
        await field.press("Enter");
        evidence.mark(`prompt "${texts[0]}" sent; composer says: ${JSON.stringify(await status.textContent().catch(() => null))}`);
        await sleep(HIJACK_AGAIN_MS);
        await field.fill(texts[1]);
        await field.press("Enter");
        evidence.mark(`prompt "${texts[1]}" sent; composer says: ${JSON.stringify(await status.textContent().catch(() => null))}`);
      });
      await evidence.shot(page, "2-prompts-sent");
      await checkMovedOn(expect, evidence, SEAT.id, run);
      await checkOldSilent(expect, evidence, sandbox, SEAT.id, run);
      if (mode === "continue") await checkContinued(expect, evidence, junto, SEAT.id, run);
      else await expect.poll(() => launches(sandbox, SEAT.id), { message: "the prompt wakes the resting seat into a fresh process", timeout: FRESH_WATCH_MS }).toBeGreaterThanOrEqual(2);
      await checkDeliveredOnceToFresh(evidence, junto, SEAT.id, texts, "prompt");
      const counts = await lineCounts(sandbox, SEAT.id);
      evidence.mark(`processes=${String(counts.length)}, continuation lines per generation=${JSON.stringify(counts)}`, "lines");
      if (mode === "continue") {
        // The fresh session holds prompt one, the continuation line and
        // prompt two, each once, in any order, and no nudge ahead of the line.
        const fresh = (await inputsOf(sandbox, SEAT.id)).slice(1).join("");
        expect(counts[0], "no continuation line in the old process").toBe(0);
        expect(occurrences(fresh, CONTINUATION_LINE), "the continuation line is in the fresh session exactly once").toBe(1);
        const lineAt = fresh.indexOf(CONTINUATION_LINE);
        const nudgeAt = fresh.indexOf(NUDGE);
        evidence.mark(
          `fresh session order (offsets in its input): ${texts.map((text) => `${text}@${String(fresh.indexOf(text))}`).join(", ")}, continuation line@${String(lineAt)}, ` +
            `onboarding nudges: ${String(occurrences(fresh, NUDGE))}${nudgeAt >= 0 ? `, first@${String(nudgeAt)}` : ""}`,
          "fresh-session-order",
        );
        expect(nudgeAt >= 0 && nudgeAt < lineAt, "an onboarding nudge was typed BEFORE the continuation line").toBe(false);
      }
      soft(counts.reduce((sum, count) => sum + count, 0), "continuation lines in all").toBe(mode === "continue" ? 1 : 0);
      evidence.mark(`composer says at the end: ${JSON.stringify(await status.textContent().catch(() => null))}`, "composer-status");
      await evidence.shot(page, "3-at-the-end");
      await windDown(expect, evidence, junto, SEAT.id, run);
    });
  });
};

const hijackByKeys = (mode: Mode): void => {
  const id = `SJ3-keys-${mode}`;
  test(`${id} [fake-tui] keystrokes typed in the open view the moment after offboard do not reach the old process${mode === "continue" ? ", and a draft they leave holds the continuation line" : ""}`, async ({}, testInfo) => {
    test.setTimeout(360_000);
    const SEAT = codexSeat("closer", "Closer", 120, 220);
    const words = ["hijack-keys-one", "hijack-keys-two"] as const;
    await walk(testInfo, id, docOf([SEAT]), async (junto, evidence) => {
      const { page, sandbox } = junto;
      const { mark } = evidence;
      const running = await seatMidTurn(junto, SEAT, { onboard: true });
      const surface = await openFocusView(page, SEAT.id);
      await focusTerminal(page, surface);
      let lastKeyAt: number | undefined;

      // Every note the seat shows, as it shows it: a held line is said once, for a few seconds.
      await page.evaluate((seatId) => {
        const seen: Array<{ t: number; text: string; tone: string | null; action: string | null }> = [];
        (window as unknown as { __walkNotes: typeof seen }).__walkNotes = seen;
        const look = (): void => {
          for (const el of Array.from(document.querySelectorAll(`[data-testid="node-preamble"][data-node-id="${seatId}"]`))) {
            const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
            const tone = el.getAttribute("data-tone");
            const action = el.getAttribute("data-action");
            if (text && !seen.some((note) => note.text === text && note.action === action)) seen.push({ t: Date.now(), text, tone, action });
          }
        };
        new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
      }, SEAT.id);
      const notesSeen = (): Promise<ReadonlyArray<{ readonly t: number; readonly text: string; readonly tone: string | null; readonly action: string | null }>> =>
        page.evaluate(() => [...((window as unknown as { __walkNotes?: Array<{ t: number; text: string; tone: string | null; action: string | null }> }).__walkNotes ?? [])]);

      const run = await offboardRun(
        junto,
        testInfo,
        SEAT.id,
        1,
        running.oldEpoch,
        mode === "continue" ? NEXT : undefined,
        async () => {
          await page.keyboard.type(words[0]);
          mark(`typed "${words[0]}"`);
          await sleep(HIJACK_AGAIN_MS);
          await page.keyboard.type(words[1]);
          lastKeyAt = mark(`typed "${words[1]}"`);
        },
        // The line may be held by what was just typed: do not wait long for it here.
        LINE_AFTER_FRESH_MS,
      );
      await checkMovedOn(expect, evidence, SEAT.id, run);
      // The one hard line: the old process did not get them.
      await checkOldSilent(expect, evidence, sandbox, SEAT.id, run);

      // Recorded: where they went.
      const inputs = await inputsOf(sandbox, SEAT.id);
      for (const word of words) {
        const where = inputs.map((input, index) => (input.includes(word) ? `generation ${String(index + 1)}` : "")).filter(Boolean);
        mark(`"${word}" went to: ${where.join(", ") || "nowhere (lost)"}`, `keys-${word}`);
        expect(inputs[0] ?? "", `"${word}" did not reach the old process`).not.toContain(word);
      }

      if (mode === "continue") {
        const freshSeat = genSeat(sandbox, SEAT.id, 2);
        const freshInput = await inputOf(sandbox, SEAT.id, 2);
        const drafted = words.filter((word) => freshInput.includes(word));
        const screen = await screenOf(page, SEAT.id);
        mark(
          `typed text in the fresh session's box: ${drafted.join(", ") || "none"}; on the seat's screen: ${words.filter((word) => squash(screen).includes(word)).join(", ") || "none"}`,
          "draft-in-fresh-box",
        );
        soft(run.restartedAt, "a fresh process started by itself").toBeDefined();

        if (drafted.length > 0 && run.lineAt === undefined) {
          // INTENDED: Junto never types over or into what the operator is
          // writing, mail or continuation line alike. The line waits, and says so.
          await evidence.shot(page, "1-draft-holds-the-line");
          soft(occurrences(freshInput, CONTINUATION_LINE), "the line is not typed while the operator's draft is in the box").toBe(0);

          // Main's log names the wait (injection-supervisor.ts:162; the draft's reason at :567).
          const waitingLines = (): ReadonlyArray<string> =>
            offboardLines(evidence.mainLog()).filter((line) => line.includes(`${bindingOf(SEAT.id)}: the continuation line is waiting: `));
          await soft.poll(() => waitingLines().join("\n"), { message: "main's lines for the waiting continuation", timeout: 10_000 }).toContain("box draft");
          const reasons = waitingLines().map((line) => line.slice(line.indexOf("is waiting: ") + "is waiting: ".length).trim());
          mark(`reasons main logged for the wait: ${JSON.stringify(reasons)}`, "waiting-reasons");

          // The seat says so in amber, the way it says held mail (preamble-sources.ts:207-239).
          const notes = await notesSeen();
          mark(`notes the seat showed: ${JSON.stringify(notes)}`, "seat-notes");
          const held = notes.filter((note) => note.text.includes("waits for your draft"));
          soft(held.length, 'the seat showed a note that something "waits for your draft"').toBeGreaterThan(0);
          soft(held.every((note) => note.tone === "amber" && note.action === "mail-held"), "and it is the amber held note").toBe(true);

          // The operator sends the draft (the fake composer has no backspace), and that turn ends.
          await focusTerminal(page, surface);
          await page.keyboard.press("Enter");
          const sentAt = mark("the operator sent the draft");
          await freshSeat.control({ screen: { mode: "idle" } });
          await expectSeatState(page, SEAT.id, "idle");
          const emptyAt = mark("the fresh session's box is empty and the seat idle");
          let lineAt: number | undefined;
          while (Date.now() < emptyAt + DELIVERY_MS) {
            if ((await inputOf(sandbox, SEAT.id, 2)).includes(CONTINUATION_LINE)) {
              lineAt = Date.now();
              break;
            }
            await sleep(POLL_MS);
          }
          mark(
            `continuation line ${lineAt === undefined ? `NOT within ${String(DELIVERY_MS)} ms` : `${String(Math.max(0, lineAt - emptyAt))} ms after the box was empty and the seat idle (${String(lineAt - sentAt)} ms after the draft was sent)`}`,
            "line-after-draft",
          );
          expect(lineAt, "the continuation line arrives once the draft is gone").toBeDefined();
          expect(Math.max(0, lineAt! - emptyAt), "from the box being empty and the seat idle to the line, in ms").toBeLessThan(LINE_AFTER_DRAFT_MS);
          const after = await inputOf(sandbox, SEAT.id, 2);
          expect(after.indexOf(CONTINUATION_LINE), "the line came after the draft, not into it").toBeGreaterThan(Math.max(...drafted.map((word) => after.indexOf(word))));
        } else {
          // Neither word stayed as a draft in the fresh session: the line is not held.
          checkLinePrompt(soft, evidence, SEAT.id, run, lastKeyAt);
        }
        soft(await isAlive(run.old), "the old process is still running: it is not stopped until it goes idle").toBe(true);
        await sleep(QUIET_MS);
        expect(await lineCounts(sandbox, SEAT.id), "continuation lines per generation: exactly one, in the fresh session").toEqual([0, 1]);
      } else {
        await sleep(QUIET_MS);
      }
      await checkNoFailedStartCopy(surface, SEAT.id);
      await evidence.shot(page, "2-at-the-end");
      await windDown(expect, evidence, junto, SEAT.id, run);
    });
  });
};

test("SJ4-nudge [fake-tui] a seat that never onboarded offboards on the turn its second nudge is due: the old process is not nudged", async ({}, testInfo) => {
  test.setTimeout(480_000);
  const SEAT = codexSeat("closer", "Closer", 120, 220);
  await walk(testInfo, "SJ4-nudge", docOf([SEAT]), async (junto, evidence) => {
    const { page, sandbox } = junto;
    const { mark } = evidence;
    // Turn one starts on real mail; the seat never runs junto onboard.
    const running = await seatMidTurn(junto, SEAT, { onboard: false });
    await sleep(TURN_GAP_MS);
    mark(`after turn 1: nudges typed into the session: ${String(occurrences(await inputOf(sandbox, SEAT.id, 1), NUDGE))}`, "nudges-after-turn-1");
    // Turns two and three. The second nudge is due into the third turn after
    // the first one (intervention/policy.ts NUDGE_AFTER_TURNS [1, 3]): turn four.
    for (const turn of [2, 3]) {
      await running.seat.control({ screen: { mode: "idle" } });
      await expectSeatState(page, SEAT.id, "idle");
      await running.seat.control({ screen: { mode: "working" } });
      await expectSeatState(page, SEAT.id, "working");
      await sleep(TURN_GAP_MS);
      mark(`after turn ${String(turn)}: nudges typed into the session: ${String(occurrences(await inputOf(sandbox, SEAT.id, 1), NUDGE))}`);
    }
    await running.seat.control({ screen: { mode: "idle" } });
    await expectSeatState(page, SEAT.id, "idle");
    const nudgesBeforeTurn4 = occurrences(await inputOf(sandbox, SEAT.id, 1), NUDGE);

    // Turn four begins, and the agent runs offboard at once: the nudge that
    // is now due races it.
    await running.seat.control({ screen: { mode: "working" } });
    const turn4At = mark("turn 4 began");
    const run = await offboardRun(junto, testInfo, SEAT.id, 1, running.oldEpoch, NEXT);
    // The session as it stood when the offboard had returned.
    const atOffboard = await inputOf(sandbox, SEAT.id, 1);
    mark(`junto offboard returned ${String(run.fired.offboardedAt - turn4At)} ms into turn 4`);
    await checkMovedOn(expect, evidence, SEAT.id, run);

    const writes = await driveWrites(sandbox, SEAT.id);
    mark(
      `onboarding nudges in the OLD process: ${String(nudgesBeforeTurn4)} before turn 4, ${String(occurrences(atOffboard, NUDGE))} when the offboard had returned; ` +
        `drive writes from turn 4 to the offboard: ${writesBetween(writes, turn4At, run.fired.offboardedAt).join(", ") || "none"}`,
      "nudge-into-old-process",
    );
    // Hard: nothing, and so no nudge, reaches the old process once the offboard has returned.
    await checkOldSilent(expect, evidence, sandbox, SEAT.id, run, atOffboard);

    await checkContinued(expect, evidence, junto, SEAT.id, run);
    await sleep(FRESH_NUDGE_WATCH_MS);
    const fresh = await inputOf(sandbox, SEAT.id, 2);
    mark(
      `the fresh session was nudged within ${String(FRESH_NUDGE_WATCH_MS)} ms of its continuation line: ${occurrences(fresh, NUDGE) > 0 ? `yes, ${String(occurrences(fresh, NUDGE))} time(s)` : "no"}`,
      "fresh-session-nudged",
    );
    soft(await lineCounts(sandbox, SEAT.id), "continuation lines per generation").toEqual([0, 1]);
    await evidence.shot(page, "1-at-the-end");
    // To its end: still nothing since the offboard, nudge included.
    await windDown(expect, evidence, junto, SEAT.id, run, { snapshot: atOffboard });
    expect(occurrences(await inputOf(sandbox, SEAT.id, 1), NUDGE), "no nudge reached the old process after the offboard").toBe(occurrences(atOffboard, NUDGE));
  });
});

for (const mode of ["rest", "continue"] as const) {
  hijackByMail(mode);
  hijackByPrompt(mode);
  hijackByKeys(mode);
}

// ===========================================================================
// SK: junto, run from the old process after the offboard (P5)
// ===========================================================================

test("SK [fake-tui] junto run from the old process after the offboard is refused, and changes nothing", async ({}, testInfo) => {
  test.setTimeout(360_000);
  const SEAT = codexSeat("closer", "Closer", 120, 220);
  await walk(testInfo, "SK", docOf([SEAT]), async (junto, evidence) => {
    const { page, sandbox } = junto;
    const { mark } = evidence;
    const running = await seatMidTurn(junto, SEAT, { onboard: true });
    const run = await offboardRun(junto, testInfo, SEAT.id, 1, running.oldEpoch, NEXT);
    await checkMovedOn(expect, evidence, SEAT.id, run);
    await checkContinued(expect, evidence, junto, SEAT.id, run);
    await sleep(QUIET_MS);

    const fresh = genSeat(sandbox, SEAT.id, 2);
    const stateOf = async (): Promise<string> =>
      JSON.stringify({
        freshInput: await inputOf(sandbox, SEAT.id, 2),
        mailerInput: await inputOf(sandbox, MAILER_ID, 1),
        session: await nodeSessionId(page, SEAT.id),
        stage: await offboardStage(page, SEAT.id),
        processes: await launches(sandbox, SEAT.id),
        epoch: (await sessionOf(page, SEAT.id))?.epoch,
      });
    const before = await stateOf();

    // The old process still holds its old identity. It asks, and is refused.
    const stolen = "written-by-the-old-process";
    const calls: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
      ["onboard (a read)", () => run.old.op("onboard", {})],
      ["msg.send to the mailer (a write)", () => run.old.op("msg.send", { target: MAILER_ID, text: stolen })],
      ["offboard again (a write)", () => run.old.op("offboard", { notes: NOTES })],
      ...(CLI_BUILT
        ? ([
            ["junto onboard (CLI)", () => run.old.cli(["onboard"])],
            ["junto capabilities (CLI)", () => run.old.cli(["capabilities"])],
          ] as const)
        : []),
    ];
    for (const [what, call] of calls) {
      const answer = await call().catch((error: unknown) => ({ threw: String(error) }));
      const text = JSON.stringify(answer);
      mark(`from the old process, ${what}: ${text.slice(0, 600)}`);
      expect((answer as { readonly ok?: unknown }).ok, `${what} from the old process is refused`).not.toBe(true);
      expect(text, `${what}: the refusal says why`).toContain(OFFBOARDED_SESSION_MESSAGE);
    }
    await sleep(2_000);
    expect(await stateOf(), "nothing changed: not the fresh session, the mailer, the node, the stage or the seat's process").toBe(before);
    expect(await inputOf(sandbox, MAILER_ID, 1), "the mailer received nothing from the old process").not.toContain(stolen);

    // The fresh process, on the seat, is answered as ever.
    soft((await fresh.op("onboard", {})).ok, "junto onboard from the fresh process is answered").toBe(true);
    await evidence.shot(page, "1-refused");
    await windDown(expect, evidence, junto, SEAT.id, run);
  });
});

// ===========================================================================
// SE: Junto quits around an offboard (P8)
// ===========================================================================

/**
 * What the source says. A process that is winding down does not outlive
 * Junto: at the quit the host stops everything it holds and the drain manager
 * records what was still draining as ended by "quit" (seat-sessions/drain.ts,
 * `quit`). Whatever a run left open is closed at the next start, logged
 * "N offboarded session(s) ended when Junto last quit" (ipc.ts:2122-2126).
 * The line owed to a fresh session that has not had it is on disk
 * (`<home>/.junto/seats/<seat>/continuation.pending`,
 * seat-sessions/continuation-pending.ts) and is armed again at startup.
 * Operator ruling: after a relaunch Junto does not start the seat by itself;
 * the handoff is caught when the seat next onboards.
 */
const mainEnvOf = (junto: JuntoHandle): Promise<Record<string, string>> =>
  junto.app.evaluate(() => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") out[key] = value;
    return out;
  });

/** Quit the app and start a second one by hand on the same sandbox (see region-environment-walk.spec.ts). */
const quitAndRelaunch = async (
  junto: JuntoHandle,
  env: Record<string, string>,
  betweenRuns: () => Promise<void>,
): Promise<ElectronApplication> => {
  const child = junto.app.process();
  const gone = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  await junto.app.close();
  await gone;
  await betweenRuns();
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron") as string,
    args: [process.cwd(), `--user-data-dir=${junto.sandbox.userDataDir}`, "--mute-audio"],
    env,
    timeout: 60_000,
  });
  // The quit gate cannot be clicked in a hidden window: accept it, as launch.ts does.
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
  return app;
};

const quitFlow = (variant: "winding-down" | "fresh-held"): void => {
  const id = variant === "winding-down" ? "SE-quit-while-winding-down" : "SE-quit-before-the-line";
  const title =
    variant === "winding-down"
      ? "Junto quits while an old process winds down, the fresh session already on its line"
      : "Junto quits while an old process winds down and the fresh process has not had its line";
  test(`${id} [fake-tui] ${title}`, async ({}, testInfo) => {
    test.setTimeout(480_000);
    const SEAT = codexSeat("closer", "Closer", 120, 220);
    const evidence = evidenceFor(testInfo, id);
    const { mark } = evidence;
    const junto = await launchJunto({
      seedCanvases: { [CANVAS]: docOf([SEAT]) },
      afterSeed: installSurfaceSeatHarness,
      extraEnv: { JUNTO_PTY_TRACE: "1" },
    });
    evidence.listen(junto.app, "first run");
    const { sandbox } = junto;
    evidence.seats(sandbox, [SEAT.id, MAILER_ID]);
    let second: ElectronApplication | undefined;
    let secondLog: () => string = () => "";
    let page = junto.page;
    const pendingFile = join(sandbox.homeDir, ".junto", "seats", SEAT.id, "continuation.pending");
    const dir = seatDir(sandbox, SEAT.id);
    try {
      await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
      const running = await seatMidTurn(junto, SEAT, { onboard: true });
      const env = await mainEnvOf(junto);
      // The fresh process is held before its fake starts, so it cannot take a line before the quit.
      if (variant === "fresh-held") await writeFile(join(dir, "hold.2"), "", "utf8");

      const run = await offboardRun(junto, testInfo, SEAT.id, 1, running.oldEpoch, NEXT);
      await checkMovedOn(expect, evidence, SEAT.id, run);
      expect(run.restartedAt, "a fresh process was started").toBeDefined();
      if (variant === "winding-down") {
        expect(run.lineAt, "the fresh session has its line before the quit").toBeDefined();
        expect(await lineCounts(sandbox, SEAT.id), "continuation lines per generation before the quit").toEqual([0, 1]);
      } else {
        await soft.poll(() => existsSync(pendingFile), { message: "the owed line is written to disk", timeout: 15_000 }).toBe(true);
        soft(await lineCounts(sandbox, SEAT.id), "no line typed before the quit").toEqual([0, 0]);
      }
      mark(`before the quit: old process running=${String(await isAlive(run.old))}, continuation.pending on disk=${String(existsSync(pendingFile))}`, "before-the-quit");
      await evidence.shot(page, "1-before-the-quit");

      // Quit while the old process is still mid-turn.
      const firstLogSoFar = evidence.mainLog().length;
      const quitAt = mark("quitting Junto");
      second = await quitAndRelaunch(junto, env, async () => {
        // It is stopped with the app: no process of the seat outlives the quit.
        const oldGone = await waitGone(run.old, GONE_AFTER_QUIT_MS);
        mark(`after the quit the old process ${oldGone === undefined ? "is STILL running" : `is gone (last heartbeat ${String(Math.max(0, oldGone - quitAt))} ms after the quit began)`}`, "old-gone-after-quit");
        expect(oldGone, "the old process was stopped with the app").toBeDefined();
        if (variant === "winding-down") {
          soft(await waitGone(genSeat(sandbox, SEAT.id, 2), GONE_AFTER_QUIT_MS), "the fresh process was stopped with the app too").toBeDefined();
        }
        await rm(join(dir, "hold.2"), { force: true });
      });
      const secondChunks: string[] = [];
      second.process().stdout?.on("data", (chunk: Buffer) => secondChunks.push(String(chunk)));
      second.process().stderr?.on("data", (chunk: Buffer) => secondChunks.push(String(chunk)));
      secondLog = () => secondChunks.join("");
      evidence.listen(second, "second run");
      page = await second.firstWindow();
      await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
      await page.waitForFunction(() => Boolean(window.junto?.readCanvas), undefined, { timeout: 30_000 });
      mark(`Junto is up again (first run printed ${String(firstLogSoFar)} characters before the quit)`);
      // The relaunch line speaks only for rows the quit could not close in time (a crash or a kill).
      // A clean quit logs "(quit)" itself and leaves nothing open, so its absence here is expected: recorded, not judged.
      await sleep(3_000);
      evidence.mark(`second run says "${ENDED_AT_QUIT}": ${String(offboardLines(secondLog()).join("\n").includes(ENDED_AT_QUIT))}`);
      const rows = drainRows(sandbox, SEAT.id);
      mark(`session rows after the relaunch (detached, ended, how): ${JSON.stringify(rows)}`, "drain-rows");
      if (rows.length > 0) soft(rows.at(-1)?.endedHow, 'the session row says it ended at the "quit"').toBe("quit");

      const before = await launches(sandbox, SEAT.id);
      mark(
        `canvas pause state after the relaunch: ${(await page.getByTestId("factory-pause").getAttribute("data-pause-state").catch(() => null)) ?? "not read"}`,
        "pause-state-after-relaunch",
      );
      await crewPlayFactory(page);

      // After a relaunch Junto does not start the seat by itself (operator ruling).
      await sleep(SELF_START_MS);
      const selfStarted = (await launches(sandbox, SEAT.id)) > before;
      const liveAfterRelaunch = isLive(await sessionOf(page, SEAT.id).catch(() => undefined));
      mark(`after the relaunch: started by itself=${String(selfStarted)}, a process is running=${String(liveAfterRelaunch)}`, "started-by-itself");
      soft(selfStarted, `Junto did not start the seat by itself within ${String(SELF_START_MS)} ms of the relaunch`).toBe(false);
      soft(liveAfterRelaunch, "the seat is not running after the relaunch").toBe(false);

      // The test starts it, as the operator would.
      await page.evaluate(
        async ([canvasName, node]) => {
          await window.junto!.terminalCreate({ node, canvasName }).catch(() => undefined);
        },
        [CANVAS, SEAT] as const,
      );
      await expect.poll(() => launches(sandbox, SEAT.id), { message: "the seat starts when asked", timeout: FRESH_WATCH_MS }).toBeGreaterThan(before);
      const startedGeneration = await launches(sandbox, SEAT.id);
      const started = genSeat(sandbox, SEAT.id, startedGeneration);
      mark(`the seat was started by the test: generation ${String(startedGeneration)}`);
      await soft.poll(async () => (await seatState(page, SEAT.id)) ?? "none", { message: "the started seat's state", timeout: SEAT_STATE_MS }).toBe("idle");
      await evidence.shot(page, "2-after-the-relaunch");

      // `junto onboard` there hands over the continuation note.
      const onboard = await started.op("onboard", {}).catch((error: unknown) => ({ ok: false as const, error: { type: "none", message: String(error) } }));
      const handoff = onboard.ok ? ((onboard.data ?? {}) as { readonly handoff?: { readonly continuation?: unknown; readonly from_session?: unknown } }).handoff : undefined;
      mark(`junto onboard after the relaunch, handoff: ${JSON.stringify(handoff ?? null)}${onboard.ok ? "" : ` (${JSON.stringify(onboard)})`}`, "handoff-after-relaunch");
      soft(String(handoff?.continuation ?? ""), "junto onboard returns the handoff with the continuation note").toContain("next");
      soft(handoff?.from_session, "the handoff names the session that offboarded").toBe(`${CODEX_SESSION}-${SEAT.id}`);

      await sleep(QUIET_MS);
      const counts = await lineCounts(sandbox, SEAT.id);
      mark(`processes: ${String(counts.length)}; continuation lines per generation: ${JSON.stringify(counts)}`, "continuation-lines");
      soft(counts[0], "none in the old process (generation 1)").toBe(0);
      if (variant === "winding-down") {
        soft(counts.reduce((sum, count) => sum + count, 0), "exactly one continuation line across both app lifetimes").toBe(1);
        soft(counts[1], "and it is in generation 2, the fresh session").toBe(1);
        soft(counts.slice(2), "no second continuation line after the relaunch").toEqual(counts.slice(2).map(() => 0));
      } else {
        // Whether the line owed on disk is typed into the generation started
        // after the relaunch is recorded; a second one never is.
        soft(counts[1], "none in the held generation 2").toBe(0);
        soft(counts.reduce((sum, count) => sum + count, 0), "at most one continuation line across both app lifetimes").toBeLessThanOrEqual(1);
      }
      mark(`continuation.pending on disk at the end: ${String(existsSync(pendingFile))}`, "pending-file-at-end");
      mark(`node session id at the end: ${String(await nodeSessionId(page, SEAT.id))}`, "session-id-at-end");
      soft(await nodeSessionId(page, SEAT.id), "the node no longer names the old session").not.toBe(`${CODEX_SESSION}-${SEAT.id}`);
      soft(await inputOf(sandbox, SEAT.id, 1), "nothing reached the old process after its offboard, to its end").toBe(run.before);
      await evidence.shot(page, "3-at-the-end");
    } catch (error) {
      await evidence.shot(page, "on-failure").catch(() => undefined);
      throw error;
    } finally {
      await evidence.flush();
      await keepTrace(sandbox, id).catch(() => undefined);
      if (second !== undefined) await second.close().catch(() => undefined);
      await junto.close();
    }
  });
};

quitFlow("winding-down");
quitFlow("fresh-held");

// ===========================================================================
// SF: a seat on the Claude template
// ===========================================================================

// Claude's prompt box as the seat-state rules read it: the body between the
// last two horizontal rules holds a bare glyph (rules/claude.ts
// `empty_prompt_idle`, composer probe `bare_prompt_empty`), the frame
// tests/pty-e2e/scripted-tui.ts paints. While working, Claude's live status
// line sits above the box (`live_status_line_working`).
const CLAUDE_RULE = "─".repeat(60);
const CLAUDE_IDLE = [CLAUDE_RULE, "❯ ", CLAUDE_RULE, "  ? for shortcuts"].join("\r\n");
const CLAUDE_WORKING = ["✻ Puzzling… (12s, 1.2k tokens)", "", CLAUDE_IDLE].join("\r\n");

test("SF [fake-tui] a Claude-template seat that offboards to continue launches on a new pinned session, not a resume", async ({}, testInfo) => {
  test.setTimeout(360_000);
  // What this fake is: the crew fixture's fake codex, seated under the binary
  // name the Claude template launches, with Claude's prompt box painted
  // through the fake's control channel (its "attention" screen prints the
  // given text verbatim). It does not emulate: Claude's terminal title, its
  // startup screens, its paste chips, or any reaction to its own arguments
  // (it ignores --session-id and --resume; the wrapper records them).
  const OLD_SESSION = "11111111-1111-4111-8111-111111111111";
  const template = templateFor("claude");
  const base = agentTextNode({ id: "claudia", key: "local:claudia", label: "Claudia", harness: "claude", x: 120, y: 220 });
  const SEAT: TextNode = { ...base, ether: { ...base.ether, terminal: { ...base.ether!.terminal!, sessionId: OLD_SESSION } } };

  await walk(testInfo, "SF", crewDoc([SEAT]), async (junto, evidence) => {
    const { page, sandbox } = junto;
    const { mark } = evidence;
    await crewPlayFactory(page);
    const seat = genSeat(sandbox, SEAT.id, 1);
    await crewOccupySeat(page, CANVAS, SEAT, seat);
    const oldPid = (await seat.ready()).pid;
    await seat.control({ screen: { mode: "attention", text: CLAUDE_IDLE } });
    await expectSeatState(page, SEAT.id, "idle");
    const oldEpoch = (await sessionOf(page, SEAT.id))?.epoch;
    opData(await seat.op("onboard", {}));

    // Mid-turn, and it stays there. The fresh process is left an empty
    // Claude prompt box to come up on (the wrapper hands it over at launch).
    await seat.control({ screen: { mode: "attention", text: CLAUDE_WORKING } });
    await soft.poll(async () => (await seatState(page, SEAT.id)) ?? "none", { message: "the seat reads working", timeout: 20_000 }).toBe("working");
    await writeFile(
      join(seatDir(sandbox, SEAT.id), "control.next.json"),
      JSON.stringify({ screen: { mode: "attention", text: CLAUDE_IDLE }, screenRequestId: "fresh-idle" }),
      "utf8",
    );
    await evidence.shot(page, "1-mid-turn");

    const run = await offboardRun(junto, testInfo, SEAT.id, 1, oldEpoch, NEXT);
    await checkMovedOn(expect, evidence, SEAT.id, run);
    expect(run.restartedAt, "a fresh process started by itself").toBeDefined();
    await expect.poll(async () => (await genSeat(sandbox, SEAT.id, 2).ready()).pid, { message: "the fresh process's pid", timeout: 30_000 }).not.toBe(oldPid);
    mark(`fresh process ${String(run.restartedAt! - run.fired.offboardedAt)} ms after the offboard`, "timing");

    // The two launches' arguments.
    const first = await argvOf(sandbox, SEAT.id, 1);
    const fresh = await argvOf(sandbox, SEAT.id, 2);
    mark(`first launch arguments: ${JSON.stringify(first)}`, "argv-first");
    mark(`fresh launch arguments: ${JSON.stringify(fresh)}`, "argv-fresh");
    const pinFlag = template.argvSpec.sessionIdFlag ?? "--session-id";
    const resumeFlag = template.argvSpec.resumeFlag ?? "--resume";
    const after = (argv: ReadonlyArray<string>, flag: string): string | undefined => {
      const at = argv.indexOf(flag);
      return at >= 0 ? argv[at + 1] : undefined;
    };
    const firstPin = after(first, pinFlag);
    const freshPin = after(fresh, pinFlag);
    soft(firstPin, `the first launch pins a session (${pinFlag})`).toBe(OLD_SESSION);
    expect(freshPin, `the fresh launch pins a session (${pinFlag})`).toBeTruthy();
    expect(freshPin, "the fresh launch's session id differs from the first launch's").not.toBe(firstPin);
    expect(fresh, `the fresh launch carries no ${resumeFlag}`).not.toContain(resumeFlag);
    expect(fresh, "the fresh launch does not name the old session").not.toContain(OLD_SESSION);
    soft(fresh, "nor any continue flag").not.toContain("--continue");

    // Claude pins: the node carries a new, non-empty session id.
    const nodeSession = await nodeSessionId(page, SEAT.id);
    expect(nodeSession, "the node names a session").toBeTruthy();
    expect(nodeSession, "and it is not the old one").not.toBe(OLD_SESSION);
    soft(nodeSession, "it is the one the fresh process was launched on").toBe(freshPin);
    mark(`session ids: ${OLD_SESSION} then ${String(nodeSession)}`, "session-ids");

    // The fresh session is told once; the old process nothing.
    await checkOldSilent(soft, evidence, sandbox, SEAT.id, run);
    soft(run.lineAt, "the fresh session was typed its continuation line").toBeDefined();
    await sleep(QUIET_MS);
    soft(await lineCounts(sandbox, SEAT.id), "continuation lines per generation").toEqual([0, 1]);
    await evidence.shot(page, "2-fresh-session");

    // The old turn ends on Claude's empty prompt box, and it is wound down.
    await windDown(soft, evidence, junto, SEAT.id, run, { idle: { mode: "attention", text: CLAUDE_IDLE } });
  });
});
