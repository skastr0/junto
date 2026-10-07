/**
 * Seat offboard [fake-tui]: what happens to a seat after its agent runs
 * `junto offboard`, to rest (O1) and to continue (O2, O3).
 *
 *   bun run test:e2e:fast e2e/scenarios/seat-offboard.spec.ts
 *
 * The seat is the crew fixture's fake codex. Its agent runs `junto offboard`
 * mid-turn through the seat's own CLI. The seat moves on at once: the old
 * process is taken off the seat without being signalled, and is left to
 * finish its turn (main/junto/seat-sessions/drain.ts). It is stopped two
 * seconds after it reads idle, and main logs how it ended.
 *
 *   O1 rest      the seat is vacant within a moment while the old process
 *                still runs; the seat rests and no longer names the old
 *                session; nothing is typed into the old session; the next
 *                mail starts a fresh process on the new session.
 *   O2 continue  a fresh process starts by itself while the old one still
 *                runs, and is typed exactly one line, CONTINUATION_LINE.
 *   O3 continue, on a seat that never ran `junto onboard`. Same flow, soft,
 *                and it records whether the onboarding nudge is typed into
 *                the old session after the offboard.
 *   All three end by letting the old turn finish (the OLD fake is set idle)
 *   and require the old process gone a few seconds later, logged "(settled)".
 *
 * Old and fresh processes run side by side now, so each generation of a seat
 * has a folder of its own. A wrapper in front of the fake
 * (installOffboardSeatHarness) gives launch N the folder gen<N> under the
 * seat's folder, and the fake (a patched copy) keeps everything there: its
 * input log, its control file, its events. The old process is addressed
 * through gen1's control file alone; the fresh one never reads it. The
 * patched fake also writes the time into an `alive` file ten times a second,
 * which is how a process is shown to be running, and when it stopped, without
 * a pid or a signal. The drive's own journal (JUNTO_PTY_TRACE=1) is kept as a
 * second witness, but it is keyed by seat, not by process: once a fresh
 * process exists, only the per-generation input logs say who was typed to.
 *
 * Evidence: main's `[offboard]` lines and the test's own timeline are written
 * to `<id>-offboard-log.txt`, with the screenshots, in OFFBOARD_WALK_DIR when
 * it is set and in the test's output folder otherwise.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import type { AgentSeatStateEvent } from "../../src/shared/agent-seat-state";
import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import { buildOnboardNudge } from "../../src/shared/managed-terminal-injection";
import { CONTINUATION_LINE, type SeatOffboardProgress } from "../../src/shared/seat-sessions";
import type { TerminalSessionSummary } from "../../src/shared/terminal";
import { seededHarnessBinDir } from "../harness/agent-harness-fixture";
import {
  crewDoc,
  crewMessagesEdge,
  crewOccupySeat,
  crewPlayFactory,
  crewSeatDir,
  crewSeatNode,
  crewSeatsDir,
  CrewSeat,
  installCrewSeatHarness,
  type WorkEnvelope,
} from "../harness/crew-fixture";
import { expect, launchJunto, test, type JuntoHandle } from "../harness/launch";
import type { Sandbox } from "../harness/sandbox";

// Only [A-Za-z0-9._-] in the canvas name and node ids: the wrapper turns the
// one ":" of JUNTO_NODE_REF into the "--" the fake names its folder with.
const CANVAS = "offboard";
const SEAT_ID = "closer";
const PEER_ID = "peer";
const FIRST_SESSION = "sess-offboard-0001";

/** The standalone CLI the fake seat's `cli` proxy runs (seat-env.ts injects JUNTO_CLI from it). */
const CLI_BUILT = existsSync(join(process.cwd(), "dist", "junto"));

const NOTES = "# Parser wired for all three feeds\n\n- Why it matters: the nightly sync fails without it.";
const NEXT = "next: pick up the retry on 429 in the feed importer, the nightly sync fails without it";
const NUDGE = buildOnboardNudge();

const soft = expect.configure({ soft: true });

const seatBase = crewSeatNode({ id: SEAT_ID, label: "Closer", x: 120, y: 220 });
/** A seat with a session to close, seeded the way seat-sessions.spec.ts does (line 36). */
const SEAT: TextNode = {
  ...seatBase,
  ether: { ...seatBase.ether, terminal: { ...seatBase.ether!.terminal!, sessionId: FIRST_SESSION } },
};
const PEER = crewSeatNode({ id: PEER_ID, label: "Peer", x: 480, y: 220 });
const DOC: CanvasDoc = crewDoc([SEAT, PEER], [crewMessagesEdge("e-peer-closer", PEER.id, SEAT.id, [SEAT, PEER])]);

// ---------------------------------------------------------------------------
// Launch, evidence
// ---------------------------------------------------------------------------

const walkDir = (testInfo: TestInfo): string => process.env.OFFBOARD_WALK_DIR ?? testInfo.outputPath();

const note = (testInfo: TestInfo, type: string, description: string): void => {
  testInfo.annotations.push({ type, description });
};

type Walk = {
  readonly junto: JuntoHandle;
  /** Main's stdout and stderr so far. */
  readonly mainLog: () => string;
  /** A line for the test's own timeline, kept in the log file. */
  readonly mark: (line: string) => number;
  readonly shot: (name: string) => Promise<void>;
};

const offboardLines = (log: string): ReadonlyArray<string> => log.split("\n").filter((line) => line.includes("[offboard]"));

/**
 * One app per test. Main's output is kept from the first moment the harness
 * hands the app over; its `[offboard]` lines and the timeline are written and
 * attached whatever the outcome.
 */
const walk = async (testInfo: TestInfo, id: string, body: (walk: Walk) => Promise<void>): Promise<void> => {
  const junto = await launchJunto({
    seedCanvases: { [CANVAS]: DOC },
    afterSeed: installOffboardSeatHarness,
    extraEnv: { JUNTO_PTY_TRACE: "1" },
  });
  const chunks: string[] = [];
  const keep = (chunk: Buffer): void => {
    chunks.push(String(chunk));
  };
  junto.app.process().stdout?.on("data", keep);
  junto.app.process().stderr?.on("data", keep);
  const timeline: string[] = [];
  const mark = (line: string): number => {
    const at = Date.now();
    timeline.push(`${new Date(at).toISOString()} ${line}`);
    return at;
  };
  const dir = walkDir(testInfo);
  const shot = async (name: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await junto.page.screenshot({ path: join(dir, `${id}-${name}.png`) });
  };
  try {
    await expect(junto.page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await body({ junto, mainLog: () => chunks.join(""), mark, shot });
  } catch (error) {
    await shot("on-failure").catch(() => undefined);
    throw error;
  } finally {
    const text = [
      "## main: lines containing [offboard]",
      ...offboardLines(chunks.join("")),
      "",
      "## test timeline",
      ...timeline,
      "",
    ].join("\n");
    await mkdir(dir, { recursive: true }).catch(() => undefined);
    await writeFile(join(dir, `${id}-offboard-log.txt`), text, "utf8").catch(() => undefined);
    await testInfo.attach(`${id}-offboard-log`, { body: text, contentType: "text/plain" }).catch(() => undefined);
    // Keep the delivery trace: the sandbox is deleted on close.
    const traceDir = process.env.PTY_WALK_TRACE_DIR;
    if (traceDir) {
      const { cpSync, mkdirSync } = await import("node:fs");
      const logs = join(junto.sandbox.homeDir, ".junto", "logs");
      const dest = join(traceDir, id);
      mkdirSync(dest, { recursive: true });
      if (existsSync(logs)) cpSync(logs, join(dest, "logs"), { recursive: true });
      const seats = crewSeatsDir(junto.sandbox);
      if (existsSync(seats)) cpSync(seats, join(dest, "crew-seats"), { recursive: true });
    }
    await junto.close();
  }
};

// ---------------------------------------------------------------------------
// Fake seat harness, with one input log per generation
// ---------------------------------------------------------------------------

/** The seat's move-on after an offboard must be seen within this (expected: about a second). */
const MOVED_ON_AFTER_OFFBOARD_MS = 4_000;
/** The old process must be gone this long after it is set idle (expected: 2 to 4 s; drain.ts DRAIN_SETTLE_MS is 2 s). */
const GONE_AFTER_IDLE_MS = 8_000;
/** How long the test looks for the old process to go at all. */
const GONE_WATCH_MS = 30_000;
/** The fake writes the time this often; a process silent for HEARTBEAT_STALE_MS is gone. */
const HEARTBEAT_MS = 100;
const HEARTBEAT_STALE_MS = 700;

/**
 * The fake, changed in three places so that two generations of one seat can
 * run side by side and be told apart: it keeps its files in the folder the
 * wrapper names (WALK_SEAT_DIR), it writes the time into `alive` every
 * HEARTBEAT_MS, and it records `sigterm` before it exits on one.
 */
const patchFake = (source: string): string => {
  const edits: ReadonlyArray<readonly [string, string]> = [
    ["const dir = path.join(", "const dir = process.env.WALK_SEAT_DIR || path.join("],
    ['process.on("SIGTERM", () => process.exit(0));', 'process.on("SIGTERM", () => { ev("sigterm"); process.exit(0); });'],
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
 * The crew fixture's fake codex (patched, see patchFake), behind a wrapper
 * that gives every launch of a seat a folder of its own, gen<N>, and leaves a
 * launch.<N> mark. Then it execs the fake, so the seat process is the fake
 * itself (same pid, same process-bound identity).
 */
const installOffboardSeatHarness = async (sandbox: Sandbox): Promise<void> => {
  await installCrewSeatHarness(sandbox);
  const bin = seededHarnessBinDir(sandbox);
  const fake = join(bin, "codex-crew-fake");
  await rename(join(bin, "codex"), fake);
  await writeFile(fake, patchFake(await readFile(fake, "utf8")), "utf8");
  await chmod(fake, 0o755);
  const script = [
    "#!/bin/sh",
    "# [fake-tui] seat-offboard: one folder per seat generation, then become the crew fake.",
    'if [ -n "${JUNTO_NODE_REF:-}" ]; then',
    `  dir='${crewSeatsDir(sandbox)}'/$(printf '%s' "$JUNTO_NODE_REF" | sed 's/:/--/')`,
    '  mkdir -p "$dir"',
    "  n=1",
    '  while [ -e "$dir/launch.$n" ]; do n=$((n + 1)); done',
    '  mkdir -p "$dir/gen$n"',
    '  date +%s > "$dir/launch.$n"',
    '  WALK_SEAT_DIR="$dir/gen$n"',
    "  export WALK_SEAT_DIR",
    "fi",
    `exec '${fake}' "$@"`,
    "",
  ].join("\n");
  const wrapper = join(bin, "codex");
  await writeFile(wrapper, script, "utf8");
  await chmod(wrapper, 0o755);
};

const seatDir = (sandbox: Sandbox, nodeId: string): string => crewSeatDir(sandbox, CANVAS, nodeId);

/** One generation of a seat (1 is its first process): its own control file, input log and events. */
const genSeat = (sandbox: Sandbox, nodeId: string, generation: number): CrewSeat =>
  new CrewSeat(join(seatDir(sandbox, nodeId), `gen${String(generation)}`));

/** How many processes this seat has had. */
const launches = async (sandbox: Sandbox, nodeId: string): Promise<number> =>
  (await readdir(seatDir(sandbox, nodeId)).catch(() => [] as string[])).filter((name) => /^launch\.\d+$/u.test(name)).length;

/** Everything generation `generation` received on its PTY input. */
const inputOf = (sandbox: Sandbox, nodeId: string, generation: number): Promise<string> => genSeat(sandbox, nodeId, generation).stdinLog();

/** The last time this process said it was running; undefined before it ever did. */
const lastAlive = async (seat: CrewSeat): Promise<number | undefined> => {
  const at = Number(await readFile(join(seat.dir, "alive"), "utf8").catch(() => ""));
  return Number.isFinite(at) && at > 0 ? at : undefined;
};

/** The process is running: it said so within the last HEARTBEAT_STALE_MS. */
const isAlive = async (seat: CrewSeat): Promise<boolean> => {
  const at = await lastAlive(seat);
  return at !== undefined && Date.now() - at < HEARTBEAT_STALE_MS;
};

type DriveWrite = { readonly at: number; readonly ts: string; readonly stage: string };

/** Every physical write the drive made into this seat's PTY (drive/pty-delivery-trace.ts, managed-terminal-drive.ts `write.begin`). */
const driveWrites = async (sandbox: Sandbox, bindingId: string): Promise<ReadonlyArray<DriveWrite>> => {
  const raw = await readFile(join(sandbox.homeDir, ".junto", "logs", "pty-delivery.jsonl"), "utf8").catch(() => "");
  const out: DriveWrite[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"write.begin"')) continue;
    try {
      const event = JSON.parse(line) as { ts?: string; bindingId?: string; event?: string; fields?: { stage?: unknown } };
      if (event.event !== "write.begin" || event.bindingId !== bindingId || typeof event.ts !== "string") continue;
      out.push({ at: Date.parse(event.ts), ts: event.ts, stage: String(event.fields?.stage ?? "") });
    } catch {
      // A torn last line is not a write.
    }
  }
  return out;
};

const bindingOf = (nodeId: string): string => `local:${nodeId}`;

const seatState = async (page: Page, nodeId: string): Promise<string | undefined> => {
  const events = (await page.evaluate(() => window.junto!.agentSeatStateSnapshot())) as ReadonlyArray<AgentSeatStateEvent>;
  return events.find((event) => event.bindingId === bindingOf(nodeId))?.state;
};

const expectSeatState = async (page: Page, nodeId: string, state: string | RegExp): Promise<void> => {
  // "none" until main has a state for the seat, so a miss prints a word.
  const poll = expect.poll(async () => (await seatState(page, nodeId)) ?? "none", {
    message: `seat ${nodeId} state`,
    timeout: 30_000,
  });
  if (typeof state === "string") await poll.toBe(state);
  else await poll.toMatch(state);
};

/** Start the seat's fake and wait until it reads idle. */
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

/** The session id the seat's node names (seat-sessions.spec.ts:36, 69: `ether.terminal.sessionId`). */
const nodeSessionId = async (page: Page, nodeId: string): Promise<string | undefined> => {
  const doc = (await page.evaluate(async (name) => (await window.junto!.readCanvas(name)).doc, CANVAS)) as CanvasDoc;
  return doc.nodes.find((node) => node.id === nodeId)?.ether?.terminal?.sessionId;
};

/** Where the seat's latest offboard stands, as the operator's panel reads it (shared/seat-sessions.ts SEAT_OFFBOARD_STAGES). */
const offboardStage = async (page: Page, nodeId: string): Promise<string> => {
  const all = (await page.evaluate(() => window.junto!.seatOffboardProgressList?.() ?? [])) as ReadonlyArray<SeatOffboardProgress>;
  const mine = all.find((entry) => entry.seatId === nodeId && entry.canvasName === CANVAS);
  return mine ? `${mine.stage}${mine.message ? `: ${mine.message}` : ""}` : "none";
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

/** What was typed, without the paste brackets and line ends around it. */
const typedText = (input: string): string =>
  input
    .replace(/\u001b\[20[01]~/gu, "")
    .replace(/[\r\n]+/gu, "\n")
    .trim();

// ---------------------------------------------------------------------------
// The flow all three tests share, up to the moment the old session closes
// ---------------------------------------------------------------------------

type Closed = {
  readonly seat: CrewSeat;
  readonly peer: CrewSeat;
  readonly oldPid: number;
  /** Just after `junto offboard` returned. */
  readonly offboardedAt: number;
  /** When the seat was first read idle after its turn. */
  readonly idleAt: number;
  /** When the old process was first seen gone (not live, or another generation). */
  readonly closedAt: number | undefined;
  /** The old session's input when offboard returned, and now. */
  readonly oldInputAtOffboard: string;
};

const offboardMidTurn = async (
  { junto, mark, shot }: Walk,
  testInfo: TestInfo,
  options: { readonly onboardFirst: boolean; readonly continuation?: string },
): Promise<Closed> => {
  const { page, sandbox } = junto;
  await crewPlayFactory(page);
  const seat = await startSeat(junto, SEAT);
  const peer = await startSeat(junto, PEER);
  const oldReady = await seat.ready();
  const oldEpoch = (await sessionOf(page, SEAT_ID))?.epoch;
  expect(await nodeSessionId(page, SEAT_ID), "the session the seat starts on").toBe(FIRST_SESSION);

  if (options.onboardFirst) {
    opData(await seat.op("onboard", {}));
    mark("the seat ran junto onboard");
  }

  // A real turn: mail from the peer, which the fake submits and starts working on.
  const turnMail = "start a turn: wire the parser";
  opData(await peer.op("msg.send", { target: SEAT_ID, text: turnMail }));
  await expect.poll(() => inputOf(sandbox, SEAT_ID, 1), { message: "the mail that starts the turn", timeout: 60_000 }).toContain(turnMail);
  await expectSeatState(page, SEAT_ID, "working");
  mark("the seat is mid-turn (working)");
  // Let whatever follows the turn's first message (a nudge) land whole.
  await sleep(1_500);

  // The agent runs `junto offboard`, mid-turn, through the seat's own CLI.
  const argv = ["offboard", NOTES, ...(options.continuation === undefined ? [] : ["--continue", options.continuation])];
  if (CLI_BUILT) {
    const result = await seat.cli(argv);
    expect(result.ok, `junto offboard: ${result.stdout}${result.stderr}`).toBe(true);
  } else {
    note(testInfo, "offboard-via", "dist/junto is missing: ran the `offboard` work-control op from the seat instead of the CLI");
    opData(
      await seat.op("offboard", { notes: NOTES, ...(options.continuation === undefined ? {} : { continuation: options.continuation }) }),
    );
  }
  const offboardedAt = mark("junto offboard returned");
  const oldInputAtOffboard = await inputOf(sandbox, SEAT_ID, 1);
  await shot("offboarded-mid-turn");

  // The seat moves on at once: it is still mid-turn, and nothing here ends
  // the turn for it. The clock starts at the offboard.
  const idleAt = offboardedAt;

  // The seat no longer points at the old process (vacant, or a fresh one).
  let closedAt: number | undefined;
  const until = idleAt + 30_000;
  while (Date.now() < until) {
    const session = await sessionOf(page, SEAT_ID).catch(() => undefined);
    if (!isLive(session) || session?.epoch !== oldEpoch) {
      closedAt = mark(`the seat has moved on (session now: ${session ? `${session.status} ${session.epoch}` : "none"})`);
      break;
    }
    await sleep(50);
  }
  note(testInfo, "offboard-to-moved-on-ms", closedAt === undefined ? "not moved on within 30 s of the offboard" : String(closedAt - idleAt));
  // The old process was not stopped: it is still running, off the seat.
  const oldAlive = await isAlive(seat);
  mark(`the old process is still running after the seat moved on: ${String(oldAlive)}`);
  expect(oldAlive, "the old process is still alive after the offboard (it is left to finish its turn)").toBe(true);
  return { seat, peer, oldPid: oldReady.pid, offboardedAt, idleAt, closedAt, oldInputAtOffboard };
};

/**
 * Let the old turn end and watch the old process go. The OLD fake is set
 * idle through its own generation's control file (the fresh process has its
 * own and never reads this one). Before that, its input must still be what it
 * was when the offboard returned: nothing reached it in all the time since.
 */
const windDown = async (ctx: Walk, testInfo: TestInfo, check: typeof expect, closed: Closed, allow: (typedAfter: string) => string = (typed) => typed): Promise<void> => {
  const { junto, mark, mainLog } = ctx;
  const old = closed.seat;
  const before = await inputOf(junto.sandbox, SEAT_ID, 1);
  const typedAfter = before.startsWith(closed.oldInputAtOffboard) ? before.slice(closed.oldInputAtOffboard.length) : before;
  check(allow(typedAfter), "nothing reached the old process in all its time off the seat").toBe("");
  check(await isAlive(old), "the old process is still running until its turn ends").toBe(true);
  await old.control({ screen: { mode: "idle" } });
  const idleAt = mark("the old process's turn ended: its screen is idle");
  let goneAt: number | undefined;
  while (Date.now() < idleAt + GONE_WATCH_MS) {
    const at = await lastAlive(old);
    if (at !== undefined && Date.now() - at >= HEARTBEAT_STALE_MS) {
      goneAt = at;
      break;
    }
    await sleep(50);
  }
  const ms = goneAt === undefined ? undefined : Math.max(0, goneAt - idleAt);
  mark(`the old process ${ms === undefined ? `was NOT gone within ${String(GONE_WATCH_MS)} ms of idle` : `was gone ${String(ms)} ms after it went idle (last heartbeat)`}`);
  note(testInfo, "old-idle-to-gone-ms", ms === undefined ? "not gone" : String(ms));
  check(goneAt, "the old process is gone once its turn has ended").toBeDefined();
  if (ms !== undefined) check(ms, "old process idle to gone, in ms").toBeLessThan(GONE_AFTER_IDLE_MS);
  const events = (await old.events()).filter((event) => event.event === "sigterm").length;
  mark(`the old process recorded SIGTERM ${String(events)} time(s)`);
  await check
    .poll(() => offboardLines(mainLog()).join("\n"), { message: "main's [offboard] lines", timeout: 10_000 })
    .toContain(`${SEAT_ID}: its offboarded session ended (settled)`);
  check(await inputOf(junto.sandbox, SEAT_ID, 1), "the old process's input never changed after the offboard, to its end").toBe(before);
};

/** What the drive wrote into the seat between two moments, for the log and the checks. */
const writesBetween = (writes: ReadonlyArray<DriveWrite>, from: number, to: number): ReadonlyArray<string> =>
  writes.filter((write) => write.at > from && write.at < to).map((write) => `${write.ts} ${write.stage}`);

// ===========================================================================

test("O1 [fake-tui] offboard to rest: the seat moves on at once and rests, the old process finishes its turn, and mail wakes a fresh session", async ({}, testInfo) => {
  test.setTimeout(360_000);
  await walk(testInfo, "O1", async (ctx) => {
    const { junto, mark, shot, mainLog } = ctx;
    const { page, sandbox } = junto;
    const closed = await offboardMidTurn(ctx, testInfo, { onboardFirst: true });

    // Within about a second of the offboard the seat is vacant, mid-turn.
    expect(closed.closedAt, "the seat moved on after the offboard").toBeDefined();
    expect(closed.closedAt! - closed.idleAt, "offboard to seat vacant, in ms").toBeLessThan(MOVED_ON_AFTER_OFFBOARD_MS);
    expect(isLive(await sessionOf(page, SEAT_ID)), "no process is on the seat").toBe(false);

    // The seat rests: the closer says so, to the operator's panel and on the log.
    await expect.poll(() => offboardStage(page, SEAT_ID), { message: "where the seat's offboard stands", timeout: 10_000 }).toBe("resting");
    soft(offboardLines(mainLog()).join("\n"), "main's [offboard] line").toContain(
      `${SEAT_ID} offboarded; its session closed and the seat rests`,
    );
    note(testInfo, "O1-seat-state-at-rest", (await seatState(page, SEAT_ID)) ?? "none");
    await shot("resting");

    // A different session id than before.
    const freshSession = await nodeSessionId(page, SEAT_ID);
    // Codex captures its session id from the harness (managed-terminal-templates
    // capabilityBadges.sessionId "capture"), so the close CLEARS the node's id
    // (seat-sessions/rotate.ts:83-84 mints one only for a "pin" harness) and the
    // fake reports none: the node must simply no longer name the old session.
    expect(freshSession, "the node no longer names the closed session").not.toBe(FIRST_SESSION);
    note(testInfo, "O1-session-ids", `${FIRST_SESSION} then ${String(freshSession)}`);

    // It stays at rest: nothing starts it, and nothing is typed anywhere.
    await sleep(4_000);
    expect(await launches(sandbox, SEAT_ID), "no fresh process started by itself").toBe(1);
    expect(await inputOf(sandbox, SEAT_ID, 1), "nothing was typed into the old session after offboard").toBe(closed.oldInputAtOffboard);
    const restedAt = mark("still resting, about to send mail");
    const writes = await driveWrites(sandbox, bindingOf(SEAT_ID));
    mark(`drive writes before offboard: ${writesBetween(writes, 0, closed.offboardedAt).join(", ") || "none"}`);
    soft(writesBetween(writes, 0, closed.offboardedAt).length, "the drive journal is alive: it holds the mail that started the turn").toBeGreaterThan(0);
    expect(writesBetween(writes, closed.offboardedAt, restedAt), "drive writes into the seat after offboard, while it rests").toEqual([]);

    // Mail from the second seat: a fresh process, on the new session, gets it.
    const wakeMail = "wake up: retry the nightly sync";
    opData(await closed.peer.op("msg.send", { target: SEAT_ID, text: wakeMail }));
    mark("mail sent to the resting seat");
    await expect.poll(() => launches(sandbox, SEAT_ID), { message: "a fresh process starts for the mail", timeout: 60_000 }).toBe(2);
    const fresh = genSeat(sandbox, SEAT_ID, 2);
    await expect
      .poll(async () => (await fresh.ready()).pid, { message: "the fresh process's pid", timeout: 30_000 })
      .not.toBe(closed.oldPid);
    await expect.poll(() => inputOf(sandbox, SEAT_ID, 2), { message: "the fresh session's input", timeout: 60_000 }).toContain(wakeMail);
    mark("the fresh process received the mail");
    expect(await inputOf(sandbox, SEAT_ID, 1), "the old session's input is as it was when offboard returned").toBe(closed.oldInputAtOffboard);
    expect(await inputOf(sandbox, SEAT_ID, 1), "the mail did not go to the old session").not.toContain(wakeMail);
    expect(await nodeSessionId(page, SEAT_ID), "the node still names the fresh session").toBe(freshSession);
    await expect
      .poll(
        async () =>
          (opData(await fresh.op("onboard", {})).sessions as { readonly current?: { readonly session_id?: unknown } } | undefined)
            ?.current?.session_id,
        { message: "the session the fresh process is on", timeout: 30_000 },
      )
      .not.toBe(FIRST_SESSION);
    await shot("woken-by-mail");

    // The old turn ends: its process is wound down, and main says how.
    await windDown(ctx, testInfo, expect, closed);
    expect(await isAlive(fresh), "the fresh process is untouched by the old one's end").toBe(true);
  });
});

/** O2 and O3 share everything but how hard they hold it. */
const continueFlow = async (
  ctx: Walk,
  testInfo: TestInfo,
  id: string,
  check: typeof expect,
  onboardFirst: boolean,
): Promise<void> => {
  const { junto, mark, shot, mainLog } = ctx;
  const { page, sandbox } = junto;
  const closed = await offboardMidTurn(ctx, testInfo, { onboardFirst, continuation: NEXT });

  check(closed.closedAt, "the seat moved on after the offboard").toBeDefined();
  if (closed.closedAt !== undefined) check(closed.closedAt - closed.idleAt, "offboard to seat moved on, in ms").toBeLessThan(MOVED_ON_AFTER_OFFBOARD_MS);
  const fresh = genSeat(sandbox, SEAT_ID, 2);

  // A fresh process starts by itself: no mail, no click.
  await check.poll(() => launches(sandbox, SEAT_ID), { message: "a fresh process starts by itself", timeout: 60_000 }).toBe(2);
  await check
    .poll(async () => (await fresh.ready()).pid, { message: "the fresh process's pid", timeout: 30_000 })
    .not.toBe(closed.oldPid);
  const freshAt = mark("a fresh process is up");
  check(await isAlive(closed.seat), "the old process still runs beside the fresh one").toBe(true);
  note(testInfo, `${id}-offboard-to-fresh-ms`, String(freshAt - closed.idleAt));
  const freshSession = await nodeSessionId(page, SEAT_ID);
  check(freshSession, "the node no longer names the closed session").not.toBe(FIRST_SESSION);
  note(testInfo, `${id}-session-ids`, `${FIRST_SESSION} then ${String(freshSession)}`);

  // Exactly one line is typed into the fresh session.
  await check
    .poll(() => inputOf(sandbox, SEAT_ID, 2), { message: "the fresh session's input", timeout: 60_000 })
    .toContain(CONTINUATION_LINE);
  mark("the continuation line reached the fresh session");
  await shot("continued");
  // Give anything else that would follow it time to arrive.
  await sleep(5_000);
  const freshInput = await inputOf(sandbox, SEAT_ID, 2);
  mark(`fresh session input: ${JSON.stringify(freshInput)}`);
  check(occurrences(freshInput, CONTINUATION_LINE), "the continuation line is typed once").toBe(1);
  // A seat marker (`[vc-xxxxxxxx] `) may lead a typed line: it is transport, not a second line.
  check(typedText(freshInput).replace(/^\[vc-[0-9a-f]{8}\]\s*/u, ""), "and it is the only thing typed into the fresh session").toBe(
    CONTINUATION_LINE,
  );
  check(freshInput, "no onboarding nudge beside it").not.toContain(NUDGE);

  // Nothing was typed into the old session after offboard.
  const oldInput = await inputOf(sandbox, SEAT_ID, 1);
  const typedAfter = oldInput.startsWith(closed.oldInputAtOffboard) ? oldInput.slice(closed.oldInputAtOffboard.length) : oldInput;
  mark(`old session input when offboard returned: ${JSON.stringify(closed.oldInputAtOffboard)}`);
  mark(`old session input typed after offboard: ${JSON.stringify(typedAfter)}`);
  const writes = await driveWrites(sandbox, bindingOf(SEAT_ID));
  // The journal is keyed by seat: it speaks for the old process only until the fresh one exists.
  const closedAt = Math.min(closed.closedAt ?? freshAt, freshAt);
  const before = writesBetween(writes, 0, closed.offboardedAt);
  const between = writesBetween(writes, closed.offboardedAt, closedAt);
  const after = writesBetween(writes, closedAt, Number.MAX_SAFE_INTEGER);
  mark(`drive writes before offboard: ${before.join(", ") || "none"}`);
  mark(`drive writes between offboard and close: ${between.join(", ") || "none"}`);
  mark(`drive writes after the close: ${after.join(", ") || "none"}`);

  // The nudge, for the record: was it typed into the old session, and when.
  const nudgeBefore = occurrences(closed.oldInputAtOffboard, NUDGE);
  const nudgeAfter = occurrences(typedAfter, NUDGE);
  const nudgeLine =
    `onboarding nudge in the OLD session: ${String(nudgeBefore)} before offboard, ${String(nudgeAfter)} between offboard and close` +
    ` (offboard ${new Date(closed.offboardedAt).toISOString()}, close ${new Date(closedAt).toISOString()};` +
    ` journal writes in that window: ${between.join(", ") || "none"})`;
  mark(nudgeLine);
  note(testInfo, `${id}-nudge-into-old-session`, nudgeLine);

  if (onboardFirst) {
    check(oldInput, "nothing was typed into the old session after offboard").toBe(closed.oldInputAtOffboard);
    // The drive journal is keyed by the seat's binding, which the fresh
    // process shares, so a write in this window may be the continuation line
    // going to the fresh session. The old process's own input log, above, is
    // the witness; the journal window is recorded, not judged.
  } else {
    // O3: the nudge is recorded above, never failed on. Anything else typed is a miss.
    check(typedText(typedAfter.split(NUDGE).join("")).replace(/\[vc-[0-9a-f]{8}\]\s*/gu, ""), "nothing but a nudge was typed into the old session after offboard").toBe("");
  }
  check(before.length, "the drive journal is alive: it holds the mail that started the turn").toBeGreaterThan(0);

  // The closer's own account.
  await check.poll(() => offboardStage(page, SEAT_ID), { message: "where the seat's offboard stands", timeout: 10_000 }).toBe("started");
  check(offboardLines(mainLog()).join("\n"), "main's [offboard] line").toContain(`${SEAT_ID} offboarded; continuing in a fresh session`);

  // `junto onboard` in the fresh session hands it the continuation.
  const onboard = opData(await fresh.op("onboard", {}));
  const handoff = onboard.handoff as { readonly continuation?: unknown; readonly from_session?: unknown } | undefined;
  mark(`junto onboard in the fresh session, handoff: ${JSON.stringify(handoff ?? null)}`);
  check(String(handoff?.continuation ?? ""), "the handoff carries the continuation note").toContain("next");
  check(handoff?.from_session, "and names the session it came from").toBe(FIRST_SESSION);
  check(
    (onboard.sessions as { readonly current?: { readonly session_id?: unknown } } | undefined)?.current?.session_id,
    "the fresh process is not on the closed session",
  ).not.toBe(FIRST_SESSION);
  await shot("fresh-session-onboarded");

  // The old turn ends: its process is wound down, and main says how. In O3
  // a nudge typed into the old session is recorded above, never failed on.
  await windDown(ctx, testInfo, check, closed, (typed) =>
    onboardFirst ? typed : typedText(typed.split(NUDGE).join("")).replace(/\[vc-[0-9a-f]{8}\]\s*/gu, ""),
  );
  check(await isAlive(fresh), "the fresh process is untouched by the old one's end").toBe(true);
};

test("O2 [fake-tui] offboard to continue: a fresh session starts by itself and is typed one line", async ({}, testInfo) => {
  test.setTimeout(360_000);
  await walk(testInfo, "O2", (ctx) => continueFlow(ctx, testInfo, "O2", expect, true));
});

test("O3 [fake-tui] offboard to continue on a seat that never onboarded: same flow, and what the nudge does is recorded", async ({}, testInfo) => {
  test.setTimeout(360_000);
  await walk(testInfo, "O3", (ctx) => continueFlow(ctx, testInfo, "O3", soft, false));
});
