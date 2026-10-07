/**
 * Seat offboard [fake-tui]: what happens to a seat after its agent runs
 * `junto offboard`, to rest (O1) and to continue (O2, O3).
 *
 *   bun run test:e2e:fast e2e/scenarios/seat-offboard.spec.ts
 *
 * The seat is the crew fixture's fake codex. Its agent runs `junto offboard`
 * mid-turn through the seat's own CLI, the turn ends, and the offboard
 * closer (main/junto/seat-sessions/offboard-close.ts) ends the session once
 * the seat has sat idle for its settle time:
 *
 *   O1 rest      the process stops, the seat rests on a fresh session id,
 *                nothing is typed into the old session, and the next mail
 *                starts a fresh process on the new session.
 *   O2 continue  the process stops and a fresh one starts by itself on a new
 *                session id, and is typed exactly one line, CONTINUATION_LINE.
 *   O3 continue, on a seat that never ran `junto onboard`. Same flow, soft,
 *                and it records whether the onboarding nudge is typed into
 *                the old session between the offboard and the close.
 *
 * Old and fresh input. The fake appends everything its PTY input receives to
 * one stdin.log per seat, whichever process is running, so the two sessions
 * would run together. A wrapper in front of the fake (installOffboardSeatHarness)
 * moves the log aside at every launch: generation N's input ends up in
 * stdin.gen<N>.log once generation N+1 starts, and the running generation
 * writes stdin.log. The drive's own journal (JUNTO_PTY_TRACE=1) is the second
 * witness: every physical write into the seat's PTY, with its time.
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
  crewSeat,
  crewSeatDir,
  crewSeatNode,
  crewSeatsDir,
  installCrewSeatHarness,
  type CrewSeat,
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

/**
 * The crew fixture's fake codex, behind a wrapper that, at every launch of a
 * seat, moves the previous process's stdin.log to stdin.gen<N>.log and leaves
 * a launch.<N+1> mark. Then it execs the fake, so the seat process is the
 * fake itself (same pid, same process-bound identity).
 */
const installOffboardSeatHarness = async (sandbox: Sandbox): Promise<void> => {
  await installCrewSeatHarness(sandbox);
  const bin = seededHarnessBinDir(sandbox);
  const fake = join(bin, "codex-crew-fake");
  await rename(join(bin, "codex"), fake);
  const script = [
    "#!/bin/sh",
    "# [fake-tui] seat-offboard: one input log per seat generation, then become the crew fake.",
    'if [ -n "${JUNTO_NODE_REF:-}" ]; then',
    `  dir='${crewSeatsDir(sandbox)}'/$(printf '%s' "$JUNTO_NODE_REF" | sed 's/:/--/')`,
    '  mkdir -p "$dir"',
    "  n=1",
    '  while [ -e "$dir/launch.$n" ]; do n=$((n + 1)); done',
    '  if [ -f "$dir/stdin.log" ]; then mv "$dir/stdin.log" "$dir/stdin.gen$((n - 1)).log"; fi',
    '  date +%s > "$dir/launch.$n"',
    "fi",
    `exec '${fake}' "$@"`,
    "",
  ].join("\n");
  const wrapper = join(bin, "codex");
  await writeFile(wrapper, script, "utf8");
  await chmod(wrapper, 0o755);
};

const seatDir = (sandbox: Sandbox, nodeId: string): string => crewSeatDir(sandbox, CANVAS, nodeId);

/** How many processes this seat has had. */
const launches = async (sandbox: Sandbox, nodeId: string): Promise<number> =>
  (await readdir(seatDir(sandbox, nodeId)).catch(() => [] as string[])).filter((name) => /^launch\.\d+$/u.test(name)).length;

const decodeInput = (raw: string): string =>
  raw
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => Buffer.from(line, "base64").toString("utf8"))
    .join("");

/** Everything generation `generation` (1 is the first process) received on its PTY input. */
const inputOf = async (sandbox: Sandbox, nodeId: string, generation: number): Promise<string> => {
  const dir = seatDir(sandbox, nodeId);
  const moved = await readFile(join(dir, `stdin.gen${String(generation)}.log`), "utf8").catch(() => undefined);
  if (moved !== undefined) return decodeInput(moved);
  // Not moved aside: it is the running generation's log, or it typed nothing.
  if ((await launches(sandbox, nodeId)) !== generation) return "";
  return decodeInput(await readFile(join(dir, "stdin.log"), "utf8").catch(() => ""));
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
  const seat = crewSeat(junto.sandbox, CANVAS, node.id);
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

  // The turn ends: the seat goes idle.
  await seat.control({ screen: { mode: "idle" } });
  await expectSeatState(page, SEAT_ID, "idle");
  const idleAt = mark("the seat is idle");

  // The closer ends the session: the old process is gone.
  let closedAt: number | undefined;
  const until = idleAt + 30_000;
  while (Date.now() < until) {
    const session = await sessionOf(page, SEAT_ID).catch(() => undefined);
    if (!isLive(session) || session?.epoch !== oldEpoch) {
      closedAt = mark(`the old process is gone (session now: ${session ? `${session.status} ${session.epoch}` : "none"})`);
      break;
    }
    await sleep(50);
  }
  note(testInfo, "idle-to-closed-ms", closedAt === undefined ? "not closed within 30 s of idle" : String(closedAt - idleAt));
  return { seat, peer, oldPid: oldReady.pid, offboardedAt, idleAt, closedAt, oldInputAtOffboard };
};

/** What the drive wrote into the seat between two moments, for the log and the checks. */
const writesBetween = (writes: ReadonlyArray<DriveWrite>, from: number, to: number): ReadonlyArray<string> =>
  writes.filter((write) => write.at > from && write.at < to).map((write) => `${write.ts} ${write.stage}`);

// ===========================================================================

test("O1 [fake-tui] offboard to rest: the session closes, the seat rests on a fresh session id, and mail wakes the fresh session", async ({}, testInfo) => {
  test.setTimeout(360_000);
  await walk(testInfo, "O1", async (ctx) => {
    const { junto, mark, shot, mainLog } = ctx;
    const { page, sandbox } = junto;
    const closed = await offboardMidTurn(ctx, testInfo, { onboardFirst: true });

    // Within about 5 s of going idle its process stops.
    expect(closed.closedAt, "the seat's process stopped after it went idle").toBeDefined();
    expect(closed.closedAt! - closed.idleAt, "idle to stopped, in ms").toBeLessThan(10_000);
    expect(isLive(await sessionOf(page, SEAT_ID)), "no process is running on the seat").toBe(false);

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
    await expect
      .poll(async () => (await closed.seat.ready()).pid, { message: "the fresh process's pid", timeout: 30_000 })
      .not.toBe(closed.oldPid);
    await expect.poll(() => inputOf(sandbox, SEAT_ID, 2), { message: "the fresh session's input", timeout: 60_000 }).toContain(wakeMail);
    mark("the fresh process received the mail");
    expect(await inputOf(sandbox, SEAT_ID, 1), "the old session's input is as it was when offboard returned").toBe(closed.oldInputAtOffboard);
    expect(await inputOf(sandbox, SEAT_ID, 1), "the mail did not go to the old session").not.toContain(wakeMail);
    expect(await nodeSessionId(page, SEAT_ID), "the node still names the fresh session").toBe(freshSession);
    await expect
      .poll(
        async () =>
          (opData(await closed.seat.op("onboard", {})).sessions as { readonly current?: { readonly session_id?: unknown } } | undefined)
            ?.current?.session_id,
        { message: "the session the fresh process is on", timeout: 30_000 },
      )
      .not.toBe(FIRST_SESSION);
    await shot("woken-by-mail");
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

  check(closed.closedAt, "the old process stopped after the seat went idle").toBeDefined();
  if (closed.closedAt !== undefined) check(closed.closedAt - closed.idleAt, "idle to stopped, in ms").toBeLessThan(10_000);

  // A fresh process starts by itself: no mail, no click.
  await check.poll(() => launches(sandbox, SEAT_ID), { message: "a fresh process starts by itself", timeout: 60_000 }).toBe(2);
  await check
    .poll(async () => (await closed.seat.ready()).pid, { message: "the fresh process's pid", timeout: 30_000 })
    .not.toBe(closed.oldPid);
  const freshAt = mark("a fresh process is up");
  note(testInfo, `${id}-idle-to-fresh-ms`, String(freshAt - closed.idleAt));
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
  const closedAt = closed.closedAt ?? freshAt;
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
    check(between, "drive writes into the seat between offboard and the close").toEqual([]);
  } else {
    // O3: the nudge is recorded above, never failed on. Anything else typed is a miss.
    check(typedText(typedAfter.split(NUDGE).join("")).replace(/\[vc-[0-9a-f]{8}\]\s*/gu, ""), "nothing but a nudge was typed into the old session after offboard").toBe("");
  }
  check(before.length, "the drive journal is alive: it holds the mail that started the turn").toBeGreaterThan(0);

  // The closer's own account.
  await check.poll(() => offboardStage(page, SEAT_ID), { message: "where the seat's offboard stands", timeout: 10_000 }).toBe("started");
  check(offboardLines(mainLog()).join("\n"), "main's [offboard] line").toContain(`${SEAT_ID} offboarded; continuing in a fresh session`);

  // `junto onboard` in the fresh session hands it the continuation.
  const onboard = opData(await closed.seat.op("onboard", {}));
  const handoff = onboard.handoff as { readonly continuation?: unknown; readonly from_session?: unknown } | undefined;
  mark(`junto onboard in the fresh session, handoff: ${JSON.stringify(handoff ?? null)}`);
  check(String(handoff?.continuation ?? ""), "the handoff carries the continuation note").toContain("next");
  check(handoff?.from_session, "and names the session it came from").toBe(FIRST_SESSION);
  check(
    (onboard.sessions as { readonly current?: { readonly session_id?: unknown } } | undefined)?.current?.session_id,
    "the fresh process is not on the closed session",
  ).not.toBe(FIRST_SESSION);
  await shot("fresh-session-onboarded");
};

test("O2 [fake-tui] offboard to continue: a fresh session starts by itself and is typed one line", async ({}, testInfo) => {
  test.setTimeout(360_000);
  await walk(testInfo, "O2", (ctx) => continueFlow(ctx, testInfo, "O2", expect, true));
});

test("O3 [fake-tui] offboard to continue on a seat that never onboarded: same flow, and what the nudge does is recorded", async ({}, testInfo) => {
  test.setTimeout(360_000);
  await walk(testInfo, "O3", (ctx) => continueFlow(ctx, testInfo, "O3", soft, false));
});
