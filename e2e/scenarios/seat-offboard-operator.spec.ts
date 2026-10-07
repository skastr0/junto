import { modelFixture, modelMessagesWire, modelNote, modelSeat } from "../harness/model";
import { readModelSeat, grantOverseer } from "../harness/model";
/**
 * Operator offboard [fake-tui]: the two engineers' walks, as probes.
 *
 *   OFFBOARD_UI_DIR=/some/folder bun run test:e2e:fast e2e/scenarios/seat-offboard-operator.spec.ts --workers=1
 *   ... -g "slow-rules"            auto offboard at wake and at mail, the clock file, the nudge (about 74 minutes)
 *   ... --grep-invert "slow-rules" everything else (about 19 minutes)
 *
 * pty-mail's walks (the UI): W0 Settings, WA the popup above a card, WB a
 * working seat is refused, WC1 and WC2 the bottom bar, WD the Sessions tab.
 * pty-stream's walks (main): S1 to S5. Where the two overlap there is ONE
 * test body and each block names both step labels:
 *
 *   W0  + S5a (S5-1, S5-2)        Settings defaults and the refusal sentences
 *   WA  + S1 + S3 + S4-1          Offboard now on one idle seat, then its next session
 *   WB  + S2 (the popup sentences) a working seat and a seat on a dialog are refused
 *   WC2 + S2 + S4-2               a selection, with one refusal, and an ask of two
 *   S5r-3 to S5r-8 [slow-rules], S5r-cli (fast)  walk 5 as revised: the resting seat, cut at its wake;
 *                                 the clock file; the idle nudge; the overseer's CLI
 *   WE WF                         the right-click menus (pty-mail, main a28b9a038 or later)
 *   WG                            re-seating an agent keeps its name (pty-mail, main f4286e6c8 or later)
 *   S6a S6b S6b-paused S6c S6d [slow-rules]  auto offboard as mail arrives (pty-stream, main 85982a0d4 or later)
 *
 * Which main. From 85982a0d4 no session is ended on a timer
 * (operator-offboard.ts:513-527): a cold session is cut only as its seat is
 * about to be woken or mailed. The tests of the once-a-minute close (S5b,
 * S5c) and of the nudge as it then was (S5e) are gone with that rule.
 *
 * Every step is one labelled block ("A7", "C2-1", "S5-3"): a failure names its
 * step. PASS lines are soft, so a miss does not stop the later steps or their
 * frames; only a gesture a walk cannot go on without is hard.
 *
 * Time. Nothing in the source shortens the clock: SeatMotionClock runs on
 * Date.now() (operator-offboard-live.ts:173), the rules wait
 * OFFBOARD_START_GRACE_MS = 5 minutes after the app opens and then look every
 * OFFBOARD_TICK_MS = 60 s, one seat per pass (operator-offboard.ts:460-466),
 * with no env var and no clock port wired in the app. The shortest legal cache
 * window is 2 minutes: intervals start at 1 (shared/seat-offboard.ts:30) and
 * the idle nudge must be below the window even when it is off
 * (shared/seat-offboard.ts:184-187). So each test sets its rules through
 * window.junto.settingsPatch (W0 alone walks the Settings screen) and then
 * waits the real time, asking main (seatOffboardStatus) until it says the seat
 * is past the window. A saved clock file can only age a seat that is NOT
 * running: any output of a started seat moves its clock
 * (operator-offboard-live.ts:265-269), so it is no shortcut for an idle seat.
 *
 * The fake has no transcript. The auto offboard only takes a seat whose
 * session has something on disk (operator-offboard.ts:414-416, read through
 * harnessSessionExists, which for Codex is a file under ~/.codex/sessions
 * whose name holds the session id: term/session-existence.ts:298-325). The
 * fake codex writes no rollout, so this spec plants one per seeded session,
 * with a first line Codex discovery ignores (templates/codex-session.ts:105).
 * Each of those seats is also given a real turn first, by mail from a peer.
 *
 * Evidence, in OFFBOARD_UI_DIR when set and the test's output folder
 * otherwise: `<step>-<what>.png` at every step, `<test>-offboard-log.txt`
 * (failed step labels, main's `[offboard]` lines, the timeline) and, for S5,
 * copies of offboard-clock.json at every point a walk reads it.
 */
import { existsSync } from "node:fs";
import { appendFile, chmod, copyFile, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import type { AgentSeatStateEvent } from "../../src/shared/agent-seat-state";
import type { Node, Seat, Wire } from "../../src/shared/model";
import type { ModelFixture } from "../harness/model";
import { templateFor, type HarnessId } from "../../src/shared/managed-terminal-templates";
import {
  DEFAULT_OFFBOARD_RULES,
  OFFBOARD_REFUSAL_REASON,
  type OffboardRules,
  type OffboardRulesPatch,
  type SeatOffboardStatus,
} from "../../src/shared/seat-offboard";
import { composeOffboardAsk, type SeatOffboardProgress } from "../../src/shared/seat-sessions";
import { seededHarnessBinDir } from "../harness/agent-harness-fixture";
import { crewOccupySeat, crewPlayFactory, crewReceipts, crewSeat, crewSeatDir, crewSeatsDir, installCrewSeatHarness, type CrewSeat, type WorkEnvelope } from "../harness/crew-fixture";
import { expect, launchJunto, test, type JuntoHandle } from "../harness/launch";
import { type Sandbox } from "../harness/sandbox";
import { readSeatMailbox } from "../harness/work-mail";

// Only [A-Za-z0-9._-] in the canvas name and node ids: the wrapper turns the
// one ":" of JUNTO_NODE_REF into the "--" the fake names its folder with.
const CANVAS = "operator-offboard";

const soft = expect.configure({ soft: true });

// ---------------------------------------------------------------------------
// The exact copy the walks quote, each with where the product composes it
// ---------------------------------------------------------------------------

/** shared/seat-offboard.ts:296-300. The constant is what is asserted; the walk's literal is checked against it once. */
const REFUSED_WORKING = OFFBOARD_REFUSAL_REASON.working;
const REFUSED_ATTENTION = OFFBOARD_REFUSAL_REASON.attention;
const WALK_REFUSED_WORKING = "This seat is working. Offboard now only closes a seat that is idle, offline or resting.";
const WALK_REFUSED_ATTENTION =
  "This seat is waiting on you. Offboard now only closes a seat that is idle, offline or resting.";

/** shared/seat-sessions.ts:154-165: the first line of each prompt. */
const ASK_CONTINUE_FIRST = composeOffboardAsk("continue").split("\n")[0]!;
const ASK_REST_FIRST = composeOffboardAsk("rest").split("\n")[0]!;
const WALK_ASK_CONTINUE_FIRST = "The operator asks you to offboard and continue in a fresh session.";
const WALK_ASK_REST_FIRST = "The operator asks you to offboard this session.";

/** nodes/SeatOffboard.tsx:252 and rts/SeatOffboardKey.tsx:21. */
const TIP_ONE = "Offboard: end this agent's session";
/** renderer/lib/seat-offboard.ts:110, 128, 133, 115. */
const LINE_CLOSED_ONE = "Session closed. The seat is resting.";
const LINE_ASKED_REST = "Asked to offboard and rest.";
const LINE_ASKED_CONTINUE = "Asked to offboard and continue.";
/** renderer/lib/seat-offboard.ts:161-167. */
const IDLE_FRESH = /^Idle [01]m, inside the cache window: a turn is still cheap\.$/u;
const IDLE_PAST = /^Idle [23]m, past the cache window: a turn now is expensive\.$/u;
const IDLE_NONE_PAST = "None is past the cache window.";
/** renderer/lib/seat-offboard.ts:186. */
const NONE_CLOSABLE = "None of these agents can be closed right now.";
/** sessions/OffboardControls.tsx:64-65. */
const SESSIONS_WHERE =
  "To end this agent's session, use Offboard on the seat: in the popup above its card, or in the bottom bar for one agent or a whole selection.";

/** The rules every UI walk runs on: the shortest legal window, and no rule acting by itself. */
const WALK_RULES: OffboardRulesPatch = {
  cacheWindowMinutes: 2,
  nudge: { enabled: false, minutes: 1 },
  auto: { enabled: false },
};

/** operator-offboard.ts:460-463. Not imported: that module pulls main-process aliases the spec has no need of. */
const TICK_MS = 60_000;
const GRACE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

const bindingOf = (nodeId: string): string => `local:${nodeId}`;
const sessionIdOf = (nodeId: string): string => `sess-operator-${nodeId}-0001`;

/** A fake Codex seat. With `session`, its node names a session to close (seat-offboard.spec.ts:77-80). */
const seatNode = (id: string, label: string, x: number, y: number, session = true): Seat =>
  modelSeat({ id, label, x, y, ...(session ? { sessionId: sessionIdOf(id) } : {}) });

/** Cards are 240 by 96 (harness/sandbox.ts:539-540): three to a row, clear of each other. */
const COLUMN = [100, 400, 700] as const;
const ROW = [220, 440] as const;

const fixtureOf = (nodes: ReadonlyArray<Node>, mail: ReadonlyArray<readonly [from: string, to: string]> = []): ModelFixture => {
  const edges: Wire[] = mail.map(([from, to]) => modelMessagesWire(`e-${from}-${to}`, from, to, [...nodes]));
  return modelFixture([...nodes], edges);
};

/** Where this spec plants a session's transcript (see the header). */
const transcriptPathOf = (sandbox: Sandbox, sessionId: string): string =>
  join(sandbox.homeDir, ".codex", "sessions", "2026", "01", "01", `rollout-e2e-planted-${sessionId}.jsonl`);

/**
 * The crew fixture's fake codex behind the wrapper seat-offboard.spec.ts uses
 * (lines 176-198): at every launch of a seat the previous process's stdin.log
 * moves to stdin.gen<N>.log, so each generation's input is its own file.
 */
const installSeatHarness =
  (sessions: ReadonlyArray<string>) =>
  async (sandbox: Sandbox): Promise<void> => {
    await installCrewSeatHarness(sandbox);
    const bin = seededHarnessBinDir(sandbox);
    const fake = join(bin, "codex-crew-fake");
    await rename(join(bin, "codex"), fake);
    const script = [
      "#!/bin/sh",
      "# [fake-tui] seat-offboard-operator: one input log per seat generation, then become the crew fake.",
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
    for (const sessionId of sessions) {
      const path = transcriptPathOf(sandbox, sessionId);
      await mkdir(join(path, ".."), { recursive: true });
      // Not a session_meta line: Codex discovery never takes this for a seat's new thread.
      await writeFile(
        path,
        `${JSON.stringify({ type: "e2e_planted", note: "the fake codex writes no rollout; planted by seat-offboard-operator.spec.ts", session: sessionId })}\n`,
        "utf8",
      );
    }
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
  if ((await launches(sandbox, nodeId)) !== generation) return "";
  return decodeInput(await readFile(join(dir, "stdin.log"), "utf8").catch(() => ""));
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const seatState = async (page: Page, nodeId: string): Promise<string> => {
  const events = (await page.evaluate(() => window.junto!.agentSeatStateSnapshot())) as ReadonlyArray<AgentSeatStateEvent>;
  return events.find((event) => event.bindingId === bindingOf(nodeId))?.state ?? "none";
};

const expectSeatState = (page: Page, nodeId: string, state: string): Promise<void> =>
  expect.poll(() => seatState(page, nodeId), { message: `seat ${nodeId} state`, timeout: 30_000 }).toBe(state);

const opData = (envelope: WorkEnvelope): Record<string, unknown> => {
  expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
  return ((envelope as { readonly data?: unknown }).data ?? {}) as Record<string, unknown>;
};

/** The session id the seat's node names. */
const nodeSessionId = async (page: Page, nodeId: string): Promise<string | undefined> => {
  return (await readModelSeat(page, CANVAS, nodeId))?.sessionId;
};

/** Where the seat's latest offboard stands, as the closer keeps it (shared/seat-sessions.ts:215-231). */
const progressOf = async (page: Page, nodeId: string): Promise<SeatOffboardProgress | undefined> => {
  const all = (await page.evaluate(() => window.junto!.seatOffboardProgressList?.() ?? [])) as ReadonlyArray<SeatOffboardProgress>;
  return all.find((entry) => entry.seatId === nodeId && entry.canvasName === CANVAS);
};

/** Main's own answer, the one the panel shows (preload/index.ts:485). */
const statusOf = (page: Page, nodeIds: ReadonlyArray<string>): Promise<ReadonlyArray<SeatOffboardStatus>> =>
  page.evaluate(([canvas, ids]) => window.junto!.seatOffboardStatus!(canvas, ids), [CANVAS, [...nodeIds]] as const) as Promise<
    ReadonlyArray<SeatOffboardStatus>
  >;

/** The texts of the mail in a seat's own mailbox, through its own `junto msg list` op (crew-mail.spec.ts:232). */
const mailTexts = async (seat: CrewSeat): Promise<ReadonlyArray<string>> => {
  const items = (opData(await seat.op("msg.list", {})).items ?? []) as ReadonlyArray<{
    readonly parts?: ReadonlyArray<{ readonly text?: string }>;
  }>;
  return items.map((item) => (item.parts ?? []).map((part) => part.text ?? "").join("\n"));
};

// ---------------------------------------------------------------------------
// One app per test, with its evidence
// ---------------------------------------------------------------------------

const evidenceDir = (testInfo: TestInfo): string => process.env.OFFBOARD_UI_DIR ?? testInfo.outputPath();

const note = (testInfo: TestInfo, type: string, description: string): void => {
  testInfo.annotations.push({ type, description });
};

type Walk = {
  readonly junto: JuntoHandle;
  readonly sandbox: Sandbox;
  readonly dir: string;
  /** Just before the app was started, and once its window was up: the app's clock started between the two. */
  readonly launchStartedAt: number;
  readonly appReadyAt: number;
  /** Main's stdout and stderr so far, every app this test started. */
  readonly mainLog: () => string;
  readonly offboardLines: () => ReadonlyArray<string>;
  /** Keep a reopened app's output too, and hand it to the walk, whose ending closes it (S5r-6 and S5r-7 reopen). */
  readonly tap: (app: ElectronApplication) => void;
  readonly mark: (line: string) => number;
  /** Full page, `<step>-<what>.png`. */
  readonly shot: (page: Page, step: string, what: string) => Promise<void>;
  /** One labelled step. `also` names the other engineer's step when the two overlap. */
  readonly step: (label: string, title: string, body: () => Promise<void>, also?: string) => Promise<void>;
};

type WalkSetup = {
  readonly doc: ModelFixture;
  /** Harnesses planted as no-op binaries, so the app lists them as installed. */
  readonly harnessInstalls?: ReadonlyArray<HarnessId>;
  /** Session ids to plant a transcript for. */
  readonly transcripts?: ReadonlyArray<string>;
};

/** Everything after a walk's last check (closing apps, the harness teardown) gets this long, then is left behind. */
const ENDING_DEADLINE_MS = 60_000;

const walk = async (testInfo: TestInfo, id: string, setup: WalkSetup, body: (walk: Walk) => Promise<void>): Promise<void> => {
  const dir = evidenceDir(testInfo);
  await mkdir(dir, { recursive: true });
  const launchStartedAt = Date.now();
  const junto = await launchJunto({
    seedModels: { [CANVAS]: setup.doc },
    // Planted before afterSeed (harness/launch.ts:480-487), so the fake codex below is not overwritten.
    ...(setup.harnessInstalls !== undefined ? { seedHarnessInstalls: setup.harnessInstalls } : {}),
    afterSeed: installSeatHarness(setup.transcripts ?? []),
    extraEnv: { JUNTO_PTY_TRACE: "1" },
    windowContentSize: { width: 1440, height: 1000 },
  });
  const chunks: string[] = [];
  /** Apps this test reopened by hand: the walk's ending closes them, never the test body. */
  const reopened: ElectronApplication[] = [];
  const tap = (app: ElectronApplication): void => {
    const keep = (chunk: Buffer): void => {
      chunks.push(String(chunk));
    };
    app.process().stdout?.on("data", keep);
    app.process().stderr?.on("data", keep);
    if (app !== junto.app) reopened.push(app);
  };
  tap(junto.app);
  const mainLog = (): string => chunks.join("");
  const offboardLines = (): ReadonlyArray<string> => mainLog().split("\n").filter((line) => line.includes("[offboard]"));
  const timeline: string[] = [];
  const mark = (line: string): number => {
    const at = Date.now();
    timeline.push(`${new Date(at).toISOString()} ${line}`);
    return at;
  };
  const shot = async (page: Page, step: string, what: string): Promise<void> => {
    await page.screenshot({ path: join(dir, `${step}-${what}.png`), fullPage: true, timeout: 15_000 }).catch((error: unknown) => {
      mark(`frame ${step}-${what} could not be taken: ${String(error)}`);
    });
  };
  const failed: string[] = [];
  const step = async (label: string, title: string, run: () => Promise<void>, also?: string): Promise<void> => {
    const name = also === undefined ? label : `${label} / ${also}`;
    const before = testInfo.errors.length;
    mark(`step ${name}: ${title}`);
    try {
      await test.step(`${name} ${title}`, run);
    } catch (error) {
      failed.push(`${name} (the walk stopped here): ${title}`);
      throw error;
    }
    if (testInfo.errors.length > before) failed.push(`${name}: ${title}`);
  };
  try {
    await expect(junto.page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    // Dark, the way region-environment-walk.spec.ts does it (lines 111-114).
    await junto.page.evaluate(() => window.junto!.settingsPatch({ appearance: { theme: "dark" } }));
    await expect(junto.page.locator("html")).not.toHaveAttribute("data-theme", "bright");
    const appReadyAt = mark("the app is up");
    await body({ junto, sandbox: junto.sandbox, dir, launchStartedAt, appReadyAt, mainLog, offboardLines, tap, mark, shot, step });
  } catch (error) {
    await shot(junto.page, id, "on-failure");
    throw error;
  } finally {
    const text = [
      `## ${id}: failed steps`,
      ...(failed.length > 0 ? failed : ["none"]),
      "",
      "## main: lines containing [offboard]",
      ...offboardLines(),
      "",
      "## test timeline",
      ...timeline,
      "",
    ].join("\n");
    // The evidence first: nothing below can lose it.
    await writeFile(join(dir, `${id}-offboard-log.txt`), text, "utf8").catch(() => undefined);
    await testInfo.attach(`${id}-offboard-log`, { body: text, contentType: "text/plain" }).catch(() => undefined);
    // Then the ending, against a deadline of its own. A close that hangs (an app whose quit asks a question
    // nobody answers, a teardown that waits on a process) is recorded and left to Playwright's own teardown.
    let pending = "nothing yet";
    let closeError: unknown;
    const ending = (async (): Promise<void> => {
      for (const [index, app] of reopened.entries()) {
        pending = `closing the app this test reopened by hand (${String(index + 1)} of ${String(reopened.length)})`;
        const closed = await Promise.race([
          app.close().then(() => true, () => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000)),
        ]);
        if (!closed) {
          note(testInfo, `${id}-ending-reopened-app`, "the reopened app did not close in 20 s; its process was killed");
          app.process().kill("SIGKILL");
        }
      }
      pending = "the harness's close of the first app and the sandbox";
      await junto.close();
      pending = "nothing";
    })().catch((error: unknown) => {
      closeError = error;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finished = await Promise.race([
      ending.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ENDING_DEADLINE_MS);
      }),
    ]);
    clearTimeout(timer);
    if (!finished) {
      note(testInfo, `${id}-ending`, `ending did not finish in 60 s: ${pending}`);
      await appendFile(join(dir, `${id}-offboard-log.txt`), `\n## ending\nending did not finish in 60 s: ${pending}\n`, "utf8").catch(() => undefined);
    } else if (closeError !== undefined) {
      // As before: a teardown that finished but failed is the test's to report.
      throw closeError;
    }
  }
};

/** Set the rules the way the Settings screen saves them, and read them back. */
const setRules = async (page: Page, patch: OffboardRulesPatch): Promise<OffboardRules> => {
  await page.evaluate((offboard) => window.junto!.settingsPatch({ offboard }), patch);
  const stored = (await page.evaluate(async () => (await window.junto!.settingsGet()).settings?.offboard)) as OffboardRules | undefined;
  expect(stored, "the offboard rules as stored").toBeDefined();
  return stored!;
};

/** Start a seat's fake, wait until it reads idle, and have its agent onboard (so no onboarding nudge is typed later). */
const startSeat = async (page: Page, sandbox: Sandbox, node: Seat): Promise<CrewSeat> => {
  const seat = crewSeat(sandbox, CANVAS, node.id);
  await crewOccupySeat(page, CANVAS, node, seat);
  await expectSeatState(page, node.id, "idle");
  opData(await seat.op("onboard", {}));
  return seat;
};

/**
 * Wait, in real time, until main says every one of these seats is past the
 * cache window. Nothing is typed, clicked or printed on these seats meanwhile.
 */
/** What a wait on main's answer hands back once the answer is the one waited for. */
const AS_WAITED_FOR = "as waited for";

/**
 * For a poll on main's own answer: the fixed word when it is what was waited
 * for, and otherwise the whole answer and the rules in force, so that a
 * timeout prints them as what was received.
 */
const answerOf = async (page: Page, reached: boolean, what: string, answer: unknown): Promise<string> => {
  if (reached) return AS_WAITED_FOR;
  const rules = await page.evaluate(async () => (await window.junto!.settingsGet()).settings?.offboard).catch(() => "unreadable");
  return `not yet: ${what}. main's seatOffboardStatus answer: ${JSON.stringify(answer)}; offboard rules in force: ${JSON.stringify(rules)}`;
};

const waitPastWindow = async (
  ctx: Walk,
  testInfo: TestInfo,
  nodeIds: ReadonlyArray<string>,
  label: string,
  /** Run at every look, for OTHER seats that must be kept in their state meanwhile. */
  meanwhile?: () => Promise<void>,
): Promise<void> => {
  const from = ctx.mark(`${label}: waiting for ${nodeIds.join(", ")} to pass the cache window`);
  await expect
    .poll(async () => {
      await meanwhile?.();
      const answer = await statusOf(ctx.junto.page, nodeIds);
      return answerOf(ctx.junto.page, answer.length === nodeIds.length && answer.every((status) => status.pastWindow), "every seat past the cache window", answer);
    }, {
      message: `${nodeIds.join(", ")} past the cache window, by main's own answer`,
      timeout: 200_000,
      intervals: [5_000],
    })
    .toBe(AS_WAITED_FOR);
  const waited = ctx.mark(`${label}: past the window`) - from;
  note(testInfo, `${label}-waited-ms`, String(waited));
  note(testInfo, `${label}-status-before-any-gesture`, JSON.stringify(await statusOf(ctx.junto.page, nodeIds)));
};

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

/** e2e/scenarios/seat-message.spec.ts:75. */
const card = (page: Page, nodeId: string): Locator => page.locator(`.react-flow__node[data-id="${nodeId}"]`);
/** nodes/SeatOffboard.tsx:140. */
const panelOf = (page: Page): Locator => page.getByTestId("seat-offboard-panel");

/** Esc closes the popover (ui/Popover.tsx:107). */
const closePanel = async (page: Page): Promise<void> => {
  if ((await panelOf(page).count()) === 0) return;
  await page.keyboard.press("Escape");
  await expect(panelOf(page)).toHaveCount(0, { timeout: 5_000 });
};

/**
 * The ids of the cards the app itself marks selected: a selected card's
 * accessible name ends in ", selected" (Canvas.tsx:141-143, set on the node at
 * :240-242 from the selection the app holds, :233).
 */
const selectedIds = (page: Page): Promise<ReadonlyArray<string>> =>
  page.evaluate(() =>
    [...document.querySelectorAll(".react-flow__node")]
      .filter((node) => (node.getAttribute("aria-label") ?? "").endsWith(", selected"))
      .map((node) => node.getAttribute("data-id") ?? "")
      .sort(),
  );

/**
 * Clear the selection with the app's own gesture: one click on the empty
 * canvas (Canvas.tsx:668-670, `clearSelection`, lib/state.ts:129). A plain
 * click on a card of a multi-selection does NOT clear it, and a shift-click
 * on a selected card takes it out: starting from a stale selection is what
 * made an earlier run pick the wrong seats. Escape is the fallback (the
 * "Close or clear" key, shared/key-table.ts:469-473).
 */
const clearSelection = async (page: Page): Promise<void> => {
  await closePanel(page);
  if ((await page.locator(".canvas-action-menu").count()) > 0) await page.keyboard.press("Escape");
  const point = await page.evaluate(() => {
    const pane = document.querySelector(".react-flow__pane");
    if (pane === null) return null;
    const rect = pane.getBoundingClientRect();
    for (let fy = 0.08; fy < 0.95; fy += 0.06) {
      for (let fx = 0.04; fx < 0.98; fx += 0.06) {
        const x = rect.left + rect.width * fx;
        const y = rect.top + rect.height * fy;
        if (document.elementFromPoint(x, y) === pane) return { x, y };
      }
    }
    return null;
  });
  if (point !== null) await page.mouse.click(point.x, point.y);
  for (let press = 0; press < 3 && (await selectedIds(page)).length > 0; press += 1) {
    await page.waitForTimeout(300);
    if ((await selectedIds(page)).length > 0) await page.keyboard.press("Escape");
  }
  await expect.poll(() => selectedIds(page), { message: "nothing is selected", timeout: 5_000 }).toEqual([]);
};

/**
 * The selection is exactly these nodes, by what the app shows: each card's
 * own selected mark, and the bottom bar's count of agents (the composer's
 * label "multi-prompt — N agents", rts/KindSurface.tsx:344, and the key
 * "Offboard N agents" / "Offboard agent", rts/SeatOffboardKey.tsx:16).
 */
const expectSelection = async (page: Page, nodeIds: ReadonlyArray<string>, agents: number = nodeIds.length): Promise<void> => {
  await expect.poll(() => selectedIds(page), { message: "the selected cards", timeout: 10_000 }).toEqual([...nodeIds].sort());
  if (agents >= 2) {
    await expect(page.getByTestId("rts-multi-prompt").locator(".chat-composer__eyebrow"), "the bar's count of agents").toHaveText(
      `multi-prompt — ${String(agents)} agents`,
      { timeout: 10_000 },
    );
    await expect(page.getByTestId("rts-seat-offboard"), "the bar's offboard key").toHaveAttribute("aria-label", `Offboard ${String(agents)} agents`);
  } else if (agents === 1) {
    await expect(page.getByTestId("rts-seat-offboard"), "the bar's offboard key").toHaveAttribute("aria-label", "Offboard agent", { timeout: 10_000 });
  }
};

/**
 * Select exactly these nodes: clear first, click the first card, shift-click
 * each of the others (each by its own data-id), then prove the selection.
 * `agents` is how many of them are agent seats (all, unless said).
 */
const select = async (page: Page, nodeIds: ReadonlyArray<string>, agents: number = nodeIds.length): Promise<void> => {
  await clearSelection(page);
  for (const [index, id] of nodeIds.entries()) {
    await expect(card(page, id), `the card of ${id}`).toBeVisible({ timeout: 60_000 });
    await card(page, id).click(index === 0 ? {} : { modifiers: ["Shift"] });
  }
  await expectSelection(page, nodeIds, agents);
};

/** The card button (nodes/SeatOffboard.tsx:255) and the dialog it opens (label at :269, role at ui/Popover.tsx:153). */
const openCardPanel = async (page: Page, nodeId: string, name: string): Promise<Locator> => {
  await select(page, [nodeId]);
  const open = page.getByTestId("seat-offboard-open");
  await expect(open).toBeVisible({ timeout: 10_000 });
  await open.click();
  const dialog = page.getByRole("dialog", { name: `Offboard ${name}` });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.getByTestId("seat-offboard-panel")).toBeVisible();
  return dialog;
};

/** The bottom bar key (rts/SeatOffboardKey.tsx:23) and the panel it opens. */
const openBarPanel = async (page: Page): Promise<Locator> => {
  const key = page.getByTestId("rts-seat-offboard");
  await expect(key).toBeVisible({ timeout: 10_000 });
  await key.click();
  await expect(panelOf(page)).toBeVisible({ timeout: 10_000 });
  return panelOf(page);
};

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
const boxOf = async (locator: Locator): Promise<Box | undefined> => (await locator.first().boundingBox().catch(() => null)) ?? undefined;
const inside = (inner: Box | undefined, outer: Box | undefined, slack = 0.5): boolean =>
  inner !== undefined &&
  outer !== undefined &&
  inner.x >= outer.x - slack &&
  inner.y >= outer.y - slack &&
  inner.x + inner.width <= outer.x + outer.width + slack &&
  inner.y + inner.height <= outer.y + outer.height + slack;
const overlap = (a: Box | undefined, b: Box | undefined): boolean =>
  a !== undefined && b !== undefined && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** What sits on top at the middle of an element: the test id of the nearest ancestor that has one. */
const topmostAt = (page: Page, box: Box): Promise<string> =>
  page.evaluate(
    ([x, y]) => {
      let node = document.elementFromPoint(x!, y!);
      while (node !== null && node.getAttribute("data-testid") === null) node = node.parentElement;
      return node?.getAttribute("data-testid") ?? "";
    },
    [box.x + box.width / 2, box.y + box.height / 2] as const,
  );

/** The tooltip a `title` becomes on hover (TooltipLayer.tsx:96, 315; seat-message.spec.ts:82). */
const expectTip = async (page: Page, target: Locator, text: string, message: string): Promise<void> => {
  await target.hover();
  await soft(page.locator(".junto-tooltip[data-positioned='true']"), message).toHaveText(text, { timeout: 5_000 });
};

/** Which of the panel's two choices carries the preferred mark (nodes/SeatOffboard.tsx:150, 179, 232). */
const preferredSide = async (panel: Locator): Promise<string> => {
  const choices = panel.locator(".seat-offboard-panel__choice");
  const ask = (await choices.nth(0).getAttribute("data-preferred")) === "true";
  const now = (await choices.nth(1).getAttribute("data-preferred")) === "true";
  const marks = await panel.getByTestId("seat-offboard-preferred").count();
  return `ask=${String(ask)} now=${String(now)} marks=${String(marks)}`;
};

/**
 * Where the PREFERRED word sits (nodes/SeatOffboard.tsx:176-178 and :204-206 at
 * d0c9bbbd0): on its own line directly above the row of buttons of the choice
 * it marks, and nowhere near the other choice.
 */
const expectPreferredAbove = async (testInfo: TestInfo, panel: Locator, side: "ask" | "now", label: string): Promise<void> => {
  const choices = panel.locator(".seat-offboard-panel__choice");
  const mine = choices.nth(side === "ask" ? 0 : 1);
  const other = choices.nth(side === "ask" ? 1 : 0);
  const marks = panel.getByTestId("seat-offboard-preferred");
  const boxes = {
    marks: await marks.evaluateAll((elements) => elements.map((element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })),
    askRow: await boxOf(choices.nth(0).locator(".seat-offboard-panel__buttons")),
    nowRow: await boxOf(choices.nth(1).locator(".seat-offboard-panel__buttons")),
    askChoice: await boxOf(choices.nth(0)),
    nowChoice: await boxOf(choices.nth(1)),
  };
  note(testInfo, `${label}-preferred-mark-boxes`, JSON.stringify(boxes));
  soft(boxes.marks.length, `${label}: one preferred mark in the panel`).toBe(1);
  await soft(mine.getByTestId("seat-offboard-preferred"), `${label}: the mark belongs to the ${side} choice`).toHaveCount(1);
  await soft(other.getByTestId("seat-offboard-preferred"), `${label}: no mark in the other choice`).toHaveCount(0);
  const mark = boxes.marks[0];
  const row = side === "ask" ? boxes.askRow : boxes.nowRow;
  const otherChoice = side === "ask" ? boxes.nowChoice : boxes.askChoice;
  if (mark === undefined || row === undefined) {
    soft(mark, `${label}: the mark has a box`).toBeDefined();
    soft(row, `${label}: the row of buttons has a box`).toBeDefined();
    return;
  }
  soft(mark.y + mark.height, `${label}: the mark's bottom edge is at or above the top of its row of buttons`).toBeLessThanOrEqual(row.y + 0.5);
  soft(row.y - (mark.y + mark.height), `${label}: directly above: no more than a line's gap between the mark and its row (px)`).toBeLessThan(16);
  soft(mark.x < row.x + row.width && row.x < mark.x + mark.width, `${label}: the mark overlaps its row horizontally`).toBe(true);
  soft(overlap(mark, otherChoice), `${label}: the mark is nowhere in the other choice`).toBe(false);
};

const paint = (locator: Locator): Promise<string> =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return `background ${style.backgroundColor}, border ${style.borderTopColor}, text ${style.color}`;
  });

/** Every status line the panel shows from now on, in order (a "Closing…" line can be gone in a frame). */
const watchStatus = (page: Page): Promise<void> =>
  page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __offboardStatusSeen?: string[] }).__offboardStatusSeen = seen;
    const read = (): void => {
      const line = document.querySelector('[data-testid="seat-offboard-status"]');
      if (line === null) return;
      const text = `${line.getAttribute("data-tone") ?? ""}|${line.textContent ?? ""}`;
      if (seen[seen.length - 1] !== text) seen.push(text);
    };
    new MutationObserver(read).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    read();
  });
const statusSeen = (page: Page): Promise<ReadonlyArray<string>> =>
  page.evaluate(() => (window as unknown as { __offboardStatusSeen?: string[] }).__offboardStatusSeen ?? []);

/** Settings, section Offboard (TopBar.tsx:333, SettingsPanel.tsx:72 and :1192). */
const openOffboardSettings = async (page: Page): Promise<Locator> => {
  await page.getByRole("button", { name: "Open settings" }).click();
  await page.locator(".settings-nav__item", { hasText: "Offboard" }).first().click();
  const section = page.getByTestId("offboard-settings");
  await expect(section).toBeVisible({ timeout: 10_000 });
  return section;
};

/** Type a value into a minutes field and leave it with Tab (settings/OffboardSettingsSection.tsx:73-74). */
const typeMinutes = async (field: Locator, value: string): Promise<void> => {
  await field.click();
  await field.fill(value);
  await field.press("Tab");
};

// ---------------------------------------------------------------------------
// The clock file (S5)
// ---------------------------------------------------------------------------

type ClockFile = {
  readonly savedAt: number;
  readonly seats: Readonly<Record<string, { readonly movedAt: number; readonly offboarded?: boolean; readonly nudged?: boolean }>>;
};

/** `<home>/.junto/seats/offboard-clock.json` (operator-offboard-live.ts:71). */
const clockPath = (sandbox: Sandbox): string => join(sandbox.homeDir, ".junto", "seats", "offboard-clock.json");

const readClock = async (sandbox: Sandbox): Promise<ClockFile | undefined> => {
  try {
    return JSON.parse(await readFile(clockPath(sandbox), "utf8")) as ClockFile;
  } catch {
    return undefined;
  }
};

/** Read the clock file and keep a copy of exactly what was read. */
const keepClock = async (ctx: Walk, id: string, what: string): Promise<ClockFile | undefined> => {
  const dest = join(ctx.dir, `${id}-offboard-clock-${what}.json`);
  if (!existsSync(clockPath(ctx.sandbox))) {
    await writeFile(dest, "the clock file does not exist\n", "utf8").catch(() => undefined);
    ctx.mark(`clock file read (${what}): missing`);
    return undefined;
  }
  await copyFile(clockPath(ctx.sandbox), dest).catch(() => undefined);
  const clock = await readClock(ctx.sandbox);
  ctx.mark(`clock file read (${what}): ${JSON.stringify(clock)}`);
  return clock;
};

/** How long is left until `ms` after `from`, never less than `floor`. */
const until = (from: number, ms: number, floor = 30_000): number => Math.max(floor, from + ms - Date.now());

// ===========================================================================
// W0 + S5a: Settings
// ===========================================================================

test("W0 S5a [fake-tui] Settings, Offboard: the defaults, what is refused and why, and the switch that stays off", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const doc = fixtureOf([seatNode("ada", "Ada", COLUMN[0], ROW[0])]);
  await walk(testInfo, "W0", { doc }, async ({ junto, shot, step }) => {
    const { page } = junto;
    let section = page.getByTestId("offboard-settings");
    const cacheWindow = (): Locator => section.getByTestId("offboard-cache-window");
    const nudgeOn = (): Locator => section.getByTestId("offboard-nudge-on");
    const nudgeMinutes = (): Locator => section.getByTestId("offboard-nudge-minutes");
    const autoOn = (): Locator => section.getByTestId("offboard-auto-on");
    const autoMinutes = (): Locator => section.getByTestId("offboard-auto-minutes");
    const problem = (): Locator => section.getByTestId("offboard-settings-problem");

    await step(
      "W0-1",
      "open Settings, section Offboard: the defaults",
      async () => {
        section = await openOffboardSettings(page);
        const labels = (await page.locator(".settings-nav__item").allTextContents()).map((text) => text.trim());
        const at = labels.findIndex((text) => text.startsWith("Notifications"));
        // Where Offboard sits among the sections is recorded, not judged: other sections come and go around it.
        soft(labels.some((text) => text.startsWith("Offboard")), "Settings lists an Offboard section").toBe(true);
        testInfo.annotations.push({ type: "W0-1-settings-sections", description: `${labels.join(" | ")} (Notifications at ${String(at)})` });
        // The walk's three defaults, field by field (shared/seat-offboard.ts:138-143 at main d96ebd59f).
        soft(DEFAULT_OFFBOARD_RULES.cacheWindowMinutes, "default cache window").toBe(60);
        soft(DEFAULT_OFFBOARD_RULES.nudge, "default idle nudge").toEqual({ enabled: false, minutes: 40 });
        soft(DEFAULT_OFFBOARD_RULES.auto, "default auto offboard").toEqual({ enabled: true, minutes: 120 });
        // What makes a session worth cutting, as the source states it (shared/seat-offboard.ts:136).
        soft((DEFAULT_OFFBOARD_RULES as { readonly worth?: unknown }).worth, "default worth thresholds").toEqual({ workMinutes: 30, tokens: 200_000 });
        // Their two fields (settings/OffboardSettingsSection.tsx:197, 211).
        await soft(section.getByTestId("offboard-worth-work"), "Worth cutting: work time").toHaveValue("30");
        await soft(section.getByTestId("offboard-worth-tokens"), "Worth cutting: session size").toHaveValue("200000");
        await soft(cacheWindow(), "Cache window").toHaveValue("60");
        await soft(nudgeOn(), "Idle nudge switch").not.toBeChecked();
        await soft(nudgeMinutes(), "Idle nudge minutes").toHaveValue("40");
        await soft(autoOn(), "Auto offboard switch").toBeChecked();
        await soft(autoMinutes(), "Auto offboard minutes").toHaveValue("120");
        await shot(page, "W0-1", "offboard-settings-defaults");
      },
      "S5-1",
    );

    await step("W0-1s", "the two switches at their defaults: pill shaped, off is grey with the knob left, on is amber with the knob right, and clear of the minutes field", async () => {
      // c5349dfad (settings/offboard-settings.css): the switch is no longer squashed by its row. The knob is the
      // switch's ::after (ui/Switch.tsx), so it has no box of its own: its transform and colour are read instead.
      const read = async (name: "nudge" | "auto", toggle: Locator, minutes: Locator): Promise<{ readonly box?: Box; readonly knob: string; readonly track: string }> => {
        const box = await boxOf(toggle);
        const field = await boxOf(minutes);
        const styles = await toggle
          .evaluate((element) => {
            const track = getComputedStyle(element);
            const knob = getComputedStyle(element, "::after");
            return { track: `${track.backgroundColor}, border ${track.borderTopColor}`, knob: `${knob.backgroundColor}, transform ${knob.transform}` };
          })
          .catch(() => ({ track: "unreadable", knob: "unreadable" }));
        const checked = await toggle.isChecked().catch(() => false);
        const gap = box !== undefined && field !== undefined ? Math.max(field.x - (box.x + box.width), box.x - (field.x + field.width)) : Number.NaN;
        note(testInfo, `W0-switch-${name}`, JSON.stringify({ state: checked ? "on" : "off", switch: box, minutesField: field, gapPx: gap, ...styles }));
        soft(box, `${name}: the switch has a box`).toBeDefined();
        if (box !== undefined) {
          soft(box.width / box.height, `${name}: the switch is about twice as wide as tall (width over height)`).toBeGreaterThanOrEqual(1.5);
          soft(box.width / box.height, `${name}: the switch is about twice as wide as tall (width over height)`).toBeLessThanOrEqual(3);
        }
        soft(overlap(box, field), `${name}: the switch touches or covers the minutes field`).toBe(false);
        soft(gap, `${name}: the gap between the switch and the minutes field (px)`).toBeGreaterThanOrEqual(4);
        // A tight crop of the row (settings/FieldRow.tsx:27).
        const row = await boxOf(toggle.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' settings-field ')][1]"));
        if (row !== undefined && row.width > 0 && row.height > 0) {
          await page.screenshot({ path: join(evidenceDir(testInfo), `W0-switch-${name}.png`), clip: row }).catch((error: unknown) => {
            note(testInfo, `W0-switch-${name}-crop`, `not taken: ${String(error)}`);
          });
        } else {
          note(testInfo, `W0-switch-${name}-crop`, "not taken: the row has no box");
        }
        return { ...(box !== undefined ? { box } : {}), ...styles };
      };
      const off = await read("nudge", nudgeOn(), nudgeMinutes());
      const on = await read("auto", autoOn(), autoMinutes());
      await soft(nudgeOn(), "the nudge switch is the off one").not.toBeChecked();
      await soft(autoOn(), "the auto switch is the on one").toBeChecked();
      soft(off.track, "off and on are painted differently (the track)").not.toBe(on.track);
      soft(off.knob, "off and on differ in the knob (colour and position)").not.toBe(on.knob);
      await shot(page, "W0-1s", "switches-at-their-defaults");
    });

    await step("S5-2", "idle nudge 70, then auto offboard 30: both refused, with the sentence for a 60 minute window", async () => {
      await typeMinutes(nudgeMinutes(), "70");
      await soft(problem(), "the refusal for a nudge at 70").toHaveText(
        "Not saved. The idle nudge must come before the cache window (60 min): it asks the agent for a turn, which is only cheap while the cache is warm.",
      );
      await soft(nudgeMinutes(), "the nudge field shows the stored value again").toHaveValue("40");
      await shot(page, "S5-2", "nudge-70-refused");
      await typeMinutes(autoMinutes(), "30");
      await soft(problem(), "the refusal for an auto offboard at 30").toHaveText(
        "Not saved. The auto offboard must come at or after the cache window (60 min): before that the session is still cheap to continue.",
      );
      await soft(autoMinutes(), "the auto field shows the stored value again").toHaveValue("120");
      await shot(page, "S5-2", "auto-30-refused");
    });

    await step("W0-2", "type 2 into Cache window, Tab: nothing saved", async () => {
      await typeMinutes(cacheWindow(), "2");
      await soft(problem(), "the red line").toHaveText(
        "Not saved. The idle nudge must come before the cache window (2 min): it asks the agent for a turn, which is only cheap while the cache is warm.",
      );
      await soft(cacheWindow(), "the field shows 60 again").toHaveValue("60");
      soft(
        (await page.evaluate(async () => (await window.junto!.settingsGet()).settings?.offboard?.cacheWindowMinutes)) ?? 60,
        "the stored cache window",
      ).toBe(60);
      await shot(page, "W0-2", "cache-window-2-refused");
    });

    await step("W0-3", "type 1 into the Idle nudge minutes, Tab: saved", async () => {
      await typeMinutes(nudgeMinutes(), "1");
      await soft(nudgeMinutes(), "the field shows 1").toHaveValue("1");
      await soft(problem(), "the red line is gone").toHaveCount(0);
      await soft
        .poll(() => page.evaluate(async () => (await window.junto!.settingsGet()).settings?.offboard?.nudge.minutes), {
          message: "the stored nudge minutes",
          timeout: 10_000,
        })
        .toBe(1);
      await shot(page, "W0-3", "nudge-1-saved");
    });

    await step("W0-4", "type 2 into Cache window, Tab: saved", async () => {
      await typeMinutes(cacheWindow(), "2");
      await soft(cacheWindow(), "the field shows 2").toHaveValue("2");
      await soft(problem(), "no red line").toHaveCount(0);
      await soft
        .poll(() => page.evaluate(async () => (await window.junto!.settingsGet()).settings?.offboard?.cacheWindowMinutes), {
          message: "the stored cache window",
          timeout: 10_000,
        })
        .toBe(2);
      await shot(page, "W0-4", "cache-window-2-saved");
    });

    await step("W0-5", "type 1 into Auto offboard minutes, Tab: not saved", async () => {
      await typeMinutes(autoMinutes(), "1");
      await soft(autoMinutes(), "the field shows 120").toHaveValue("120");
      await soft(problem(), "the red line").toContainText(
        "Not saved. The auto offboard must come at or after the cache window (2 min)",
      );
      soft(((await problem().textContent().catch(() => "")) ?? "").startsWith("Not saved. The auto offboard must come at or after the cache window (2 min)"), "the red line starts with that sentence").toBe(true);
      await shot(page, "W0-5", "auto-1-refused");
    });

    await step("W0-6", "turn Auto offboard off: it stays off after reopening Settings", async () => {
      await autoOn().click();
      await soft(autoOn(), "the switch is off").not.toBeChecked();
      await shot(page, "W0-6", "auto-switched-off");
      await page.locator(".settings-panel__close").click();
      await expect(page.getByTestId("offboard-settings")).toHaveCount(0, { timeout: 5_000 });
      section = await openOffboardSettings(page);
      await soft(autoOn(), "the switch after reopening Settings").not.toBeChecked();
      await soft(cacheWindow(), "the cache window after reopening Settings").toHaveValue("2");
      await soft(nudgeMinutes(), "the nudge minutes after reopening Settings").toHaveValue("1");
      soft(
        await page.evaluate(async () => (await window.junto!.settingsGet()).settings?.offboard),
        "the stored rules at the end of the walk",
      ).toMatchObject({ cacheWindowMinutes: 2, nudge: { enabled: false, minutes: 1 }, auto: { enabled: false, minutes: 120 } });
      await shot(page, "W0-6", "auto-still-off-after-reopen");
    });

    await step("W0-7", "Add a harness: a row with its own window, a switch and minutes for each rule, and Remove; then remove it", async () => {
      // settings/OffboardSettingsSection.tsx:302-309 (the picker), :239-298 (the row).
      const add = section.getByRole("button", { name: "Add an override for a harness" });
      await soft(add, "the Add a harness picker").toBeVisible();
      if (!(await add.isVisible().catch(() => false))) return;
      await add.click();
      const option = page.getByRole("option").first();
      await soft(option, "a harness to pick").toBeVisible({ timeout: 5_000 });
      if (!(await option.isVisible().catch(() => false))) return;
      const name = ((await option.textContent()) ?? "").trim();
      await option.click();
      const row = section.locator(".offboard-settings__harness").first();
      await soft(row, `the row for ${name}`).toBeVisible({ timeout: 10_000 });
      const controls = await row
        .evaluate((element) => ({
          testId: element.getAttribute("data-testid"),
          name: element.querySelector(".offboard-settings__harness-name")?.textContent ?? "",
          fields: [...element.querySelectorAll("input[type='number']")].map((input) => `${input.getAttribute("aria-label") ?? ""} = ${(input as HTMLInputElement).value}`),
          switches: [...element.querySelectorAll("input[role='switch']")].map(
            (input) => `${input.getAttribute("aria-label") ?? ""} (${input.getAttribute("data-testid") ?? "no test id"}) = ${(input as HTMLInputElement).checked ? "on" : "off"}`,
          ),
          buttons: [...element.querySelectorAll("button")].map((button) => `${button.getAttribute("aria-label") ?? ""}: ${button.textContent ?? ""}`),
        }))
        .catch(() => null);
      note(testInfo, "W0-7-harness-row-controls", JSON.stringify(controls));
      await shot(page, "W0-7", "harness-row-added");
      // The row starts on what the installation runs on now (lib/seat-offboard.ts, seedHarnessOverride): window 2, nudge off at 1, auto off at 120.
      await soft(row.locator(".offboard-settings__harness-name"), "the row's name").toHaveText(name);
      await soft(row.getByLabel(`${name} cache window, minutes`), "the row's window").toHaveValue("2");
      await soft(row.getByRole("switch", { name: `${name} idle nudge` }), "the row's nudge switch").not.toBeChecked();
      await soft(row.getByLabel(`${name} idle nudge after, minutes`), "the row's nudge minutes").toHaveValue("1");
      await soft(row.getByRole("switch", { name: `${name} auto offboard` }), "the row's auto switch").not.toBeChecked();
      await soft(row.getByLabel(`${name} auto offboard after, minutes`), "the row's auto minutes").toHaveValue("120");
      await soft(row.getByRole("switch"), "two switches in the row").toHaveCount(2);
      const remove = row.getByRole("button", { name: `Remove the ${name} override` });
      await soft(remove, "Remove").toBeVisible();
      if (await remove.isVisible().catch(() => false)) await remove.click();
      await soft(section.locator(".offboard-settings__harness"), "no row once removed").toHaveCount(0, { timeout: 10_000 });
      soft(
        ((await page.evaluate(async () => (await window.junto!.settingsGet()).settings?.offboard)) ?? {}) as { readonly harness?: unknown },
        "no override is left in the stored rules",
      ).not.toHaveProperty("harness");
      await shot(page, "W0-7", "harness-row-removed");
    });
  });
});

// ===========================================================================
// WA + S1 + S3 + S4-1: the popup above one seat's card
// ===========================================================================

test("WA S1 S3 S4-1 [fake-tui] the popup above a card: preferred flips at the cache window, Offboard now closes an idle seat with nothing typed, and its next session is told there are no notes", async ({}, testInfo) => {
  // One real wait of a little over 2 minutes (step A4). About 5 minutes in all.
  test.setTimeout(600_000);
  const ADA = seatNode("ada", "Ada", COLUMN[0], ROW[0]);
  const BO = seatNode("bo", "Bo", COLUMN[1], ROW[0]);
  const CY = seatNode("cy", "Cy", COLUMN[2], ROW[0]);
  const doc = fixtureOf([ADA, BO, CY], [["bo", "ada"]]);
  await walk(testInfo, "WA", { doc, transcripts: [sessionIdOf("ada")] }, async (ctx) => {
    const { junto, sandbox, shot, step, mark, offboardLines } = ctx;
    const { page } = junto;
    let ada!: CrewSeat;
    let bo!: CrewSeat;
    let cy!: CrewSeat;
    let adaPid = 0;
    let dialog!: Locator;

    await step("A0", "setup: rules (window 2, nothing automatic), three fake seats started, idle and onboarded", async () => {
      soft(REFUSED_WORKING, "the working sentence in shared/seat-offboard.ts:297-298").toBe(WALK_REFUSED_WORKING);
      soft(ASK_CONTINUE_FIRST, "the continue prompt's first line in shared/seat-sessions.ts:157").toBe(WALK_ASK_CONTINUE_FIRST);
      soft(ASK_REST_FIRST, "the rest prompt's first line in shared/seat-sessions.ts:162").toBe(WALK_ASK_REST_FIRST);
      const rules = await setRules(page, WALK_RULES);
      expect(rules.cacheWindowMinutes, "the cache window in force").toBe(2);
      await crewPlayFactory(page);
      ada = await startSeat(page, sandbox, ADA);
      bo = await startSeat(page, sandbox, BO);
      cy = await startSeat(page, sandbox, CY);
      adaPid = (await ada.ready()).pid;
      expect(await nodeSessionId(page, "ada"), "the session Ada starts on").toBe(sessionIdOf("ada"));
      mark("Ada, Bo and Cy are idle");
      await shot(page, "A0", "three-seats-idle");
    });

    await step("A1", "click Ada's card once: a new button right after the message button, with its tip", async () => {
      await select(page, ["ada"]);
      const open = page.getByTestId("seat-offboard-open");
      await expect(open).toBeVisible({ timeout: 10_000 });
      // nodes/TextNode.tsx:586-587: message, then offboard.
      const order = await page.evaluate(() => {
        const message = document.querySelector('[data-testid="seat-message-open"]');
        const toolbar: ParentNode = message?.closest(".react-flow__node-toolbar") ?? document;
        return [...toolbar.querySelectorAll("button")].map(
          (button) => button.getAttribute("data-testid") ?? button.getAttribute("aria-label") ?? "",
        );
      });
      note(testInfo, "A1-toolbar-buttons-in-order", JSON.stringify(order));
      soft(order[order.indexOf("seat-message-open") + 1], "the button right after the message button").toBe("seat-offboard-open");
      await expectTip(page, open, TIP_ONE, "the tip on the card button");
      await shot(page, "A1", "toolbar-with-offboard-button");
    });

    await step(
      "A2",
      "press it: the panel opens above the toolbar, titled Offboard Ada, top to bottom as the walk lists",
      async () => {
        dialog = await openCardPanel(page, "ada", "Ada");
        const panel = dialog.getByTestId("seat-offboard-panel");
        await soft(panel.locator(".seat-offboard-panel__title"), "the title").toHaveText("Offboard Ada");
        const askContinue = dialog.getByTestId("seat-offboard-ask-continue");
        const askRest = dialog.getByTestId("seat-offboard-ask-rest");
        const now = dialog.getByTestId("seat-offboard-now");
        const hints = panel.locator(".seat-offboard-panel__hint");
        await soft(askContinue, "the first button").toHaveText("Ask to offboard");
        await soft(askRest, "the second button").toHaveText("Ask, then rest");
        await soft(now, "the third button").toHaveText("Offboard now");
        await soft(hints, "two grey hints").toHaveCount(2);
        // The session line (nodes/SeatOffboard.tsx:169-173; words at lib/seat-offboard.ts:186-195): a seat
        // that has done no work is under the threshold, and the line says so.
        const session = dialog.getByTestId("seat-offboard-session");
        await soft(session, "the session line of a seat under the threshold").toHaveText(
          /^This session: 0m of work(?:, about [\d.]+[kM]? tokens)?\. Too small for the automatic rules to act on\.$/u,
          { timeout: 10_000 },
        );
        note(testInfo, "A2-session-line", ((await session.textContent().catch(() => "")) ?? "") || "no session line");
        const sessionBox = await boxOf(session);
        const idleLineBox = await boxOf(dialog.getByTestId("seat-offboard-idle"));
        note(testInfo, "A2-session-line-boxes", JSON.stringify({ idle: idleLineBox, session: sessionBox }));
        if (idleLineBox !== undefined) soft(sessionBox?.y ?? -1, "the session line is under the idle line").toBeGreaterThanOrEqual(idleLineBox.y + idleLineBox.height - 0.5);
        soft(sessionBox?.y ?? Number.MAX_SAFE_INTEGER, "and above the buttons").toBeLessThanOrEqual((await boxOf(askContinue))?.y ?? 0);
        await soft(askContinue, "Ask to offboard stays pressable whatever the session line says").toBeEnabled();
        await soft(askRest, "Ask, then rest stays pressable whatever the session line says").toBeEnabled();
        await soft(now, "S1-1: Offboard now is enabled on an idle seat").toBeEnabled();
        const boxes = {
          title: await boxOf(panel.locator(".seat-offboard-panel__title")),
          idle: await boxOf(dialog.getByTestId("seat-offboard-idle")),
          askContinue: await boxOf(askContinue),
          askRest: await boxOf(askRest),
          hintOne: await boxOf(hints.nth(0)),
          now: await boxOf(now),
          hintTwo: await boxOf(hints.nth(1)),
          panel: await boxOf(panel),
          toolbar: await boxOf(page.locator(".react-flow__node-toolbar")),
          card: await boxOf(card(page, "ada")),
        };
        note(testInfo, "A2-boxes", JSON.stringify(boxes));
        const order = [boxes.title, boxes.askContinue, boxes.hintOne, boxes.now, boxes.hintTwo].map((box) => box?.y ?? Number.NaN);
        soft(order, "title, ask buttons, hint, Offboard now, hint: top to bottom").toEqual([...order].sort((left, right) => left - right));
        soft(order.some((y) => Number.isNaN(y)), "every part of the panel has a box").toBe(false);
        soft(Math.abs((boxes.askContinue?.y ?? 0) - (boxes.askRest?.y ?? 1_000)), "the two ask buttons share a row").toBeLessThan(8);
        if (boxes.idle !== undefined) soft(boxes.idle.y, "the idle line is above the buttons").toBeLessThanOrEqual(boxes.askContinue?.y ?? 0);
        // Nothing covers the panel, and it does not cover the card.
        for (const [name, box] of Object.entries({ askContinue: boxes.askContinue, askRest: boxes.askRest, now: boxes.now })) {
          if (box !== undefined) soft(await topmostAt(page, box), `what is on top at ${name}`).toBe(`seat-offboard-${name === "askContinue" ? "ask-continue" : name === "askRest" ? "ask-rest" : "now"}`);
        }
        soft(overlap(boxes.panel, boxes.card), "the panel covers Ada's card").toBe(false);
        soft((boxes.panel?.y ?? 0) + (boxes.panel?.height ?? 0), "the panel sits above the toolbar").toBeLessThanOrEqual((boxes.toolbar?.y ?? 0) + 0.5);
        await shot(page, "A2", "panel-open-above-toolbar");
      },
      "S1-1",
    );

    await step("A3", "fresh seat, under 2 minutes: preferred sits directly above the ask row, Ask to offboard is the amber one", async () => {
      const panel = dialog.getByTestId("seat-offboard-panel");
      const idle = dialog.getByTestId("seat-offboard-idle");
      const idleText = (await idle.count()) > 0 ? ((await idle.textContent()) ?? "") : "";
      note(testInfo, "A3-idle-line", idleText === "" ? "no idle line" : idleText);
      if (idleText !== "") soft(idleText, "the idle line of a fresh seat").toMatch(IDLE_FRESH);
      await soft.poll(() => preferredSide(panel), { message: "where the preferred mark sits", timeout: 10_000 }).toBe("ask=true now=false marks=1");
      const preferred = dialog.getByTestId("seat-offboard-preferred");
      await soft(preferred, "the mark's word").toHaveText(/^preferred$/iu);
      // c5349dfad: the word is on its own line directly ABOVE the ask row, and nothing is above Offboard now.
      await expectPreferredAbove(testInfo, panel, "ask", "A3");
      const paints = {
        askContinue: await paint(dialog.getByTestId("seat-offboard-ask-continue")),
        now: await paint(dialog.getByTestId("seat-offboard-now")),
        preferred: await paint(preferred).catch(() => "no mark"),
      };
      note(testInfo, "A3-paint", JSON.stringify(paints));
      soft(paints.askContinue, "Ask to offboard is painted differently from the plain Offboard now").not.toBe(paints.now);
      await shot(page, "A3", "fresh-preferred-on-ask");
    });

    await step("A4", "close with Esc, leave Ada untouched for a little over 2 minutes, reopen: preferred is now directly above Offboard now", async () => {
      await closePanel(page);
      await waitPastWindow(ctx, testInfo, ["ada"], "A4");
      dialog = await openCardPanel(page, "ada", "Ada");
      const panel = dialog.getByTestId("seat-offboard-panel");
      await soft(dialog.getByTestId("seat-offboard-idle"), "the idle line past the window").toHaveText(IDLE_PAST, { timeout: 10_000 });
      await soft.poll(() => preferredSide(panel), { message: "where the preferred mark sits", timeout: 10_000 }).toBe("ask=false now=true marks=1");
      // c5349dfad: directly above Offboard now, and nothing above the ask row.
      await expectPreferredAbove(testInfo, panel, "now", "A4");
      const paints = {
        askContinue: await paint(dialog.getByTestId("seat-offboard-ask-continue")),
        now: await paint(dialog.getByTestId("seat-offboard-now")),
      };
      note(testInfo, "A4-paint", JSON.stringify(paints));
      soft(paints.now, "Offboard now is painted differently from the plain Ask to offboard").not.toBe(paints.askContinue);
      note(
        testInfo,
        "A4-recorded-only",
        "Not driven: leaving the panel OPEN across the 2 minute mark and watching it flip by itself (the panel re-asks every 60 s, nodes/SeatOffboard.tsx:26). It would cost a second 2 to 3 minute wait.",
      );
      await shot(page, "A4", "past-window-preferred-on-now");
    });

    const inputBefore = { value: "" };
    await step(
      "A5",
      "press Offboard now once: it turns red and reads Close this session?, nothing else changes",
      async () => {
        inputBefore.value = await inputOf(sandbox, "ada", 1);
        await watchStatus(page);
        const now = dialog.getByTestId("seat-offboard-now");
        await expect(now).toBeEnabled();
        await now.click();
        await soft(now, "the armed button").toHaveText("Close this session?");
        await soft(now, "the armed mark").toHaveAttribute("data-armed", "true");
        note(testInfo, "A5-armed-paint", await paint(now));
        await soft(dialog.getByTestId("seat-offboard-status"), "no status line yet").toHaveCount(0);
        soft(pidAlive(adaPid), "Ada's process is still running").toBe(true);
        soft(await seatState(page, "ada"), "Ada's state").toBe("idle");
        await shot(page, "A5", "armed-close-this-session");
      },
      "S1-2",
    );

    await step("A6", "wait 4 seconds without pressing: it reads Offboard now again, by itself", async () => {
      await page.waitForTimeout(4_000);
      const now = dialog.getByTestId("seat-offboard-now");
      await soft(now, "the button after the arm ran out").toHaveText("Offboard now");
      await soft(now, "no armed mark").not.toHaveAttribute("data-armed", "true");
      soft(pidAlive(adaPid), "Ada's process is still running").toBe(true);
      await shot(page, "A6", "disarmed-by-itself");
    });

    await step(
      "A7",
      "press Offboard now, and again within 3 seconds: Closing, then Session closed; Ada rests; nothing was typed into her",
      async () => {
        const now = dialog.getByTestId("seat-offboard-now");
        await now.click();
        await now.click();
        const closedAt = mark("Offboard now pressed twice on Ada");
        const status = dialog.getByTestId("seat-offboard-status");
        await soft(status, "the green line").toHaveText(LINE_CLOSED_ONE, { timeout: 30_000 });
        await soft(status, "its tone").toHaveAttribute("data-tone", "done");
        const seen = await statusSeen(page);
        note(testInfo, "A7-status-lines-in-order", JSON.stringify(seen));
        soft(seen, "a Closing line came first").toContain("busy|Closing…");
        await shot(page, "A7", "session-closed-the-seat-is-resting");

        // S1: the process ends by itself within a few seconds. An idle seat's
        // process is taken off the seat (drain-seat.ts:117-127) and, reading
        // idle, stopped after the 2 s settle (drain.ts:51, 98-103); when it
        // cannot be detached it is stopped at once (drain-seat.ts:118-123).
        await soft.poll(() => pidAlive(adaPid), { message: "Ada's old process is still alive", timeout: 20_000 }).toBe(false);
        note(testInfo, "S1-pressed-to-process-gone-ms", String(mark("Ada's old process is gone, or 20 s passed") - closedAt));
        const lines = (): string => offboardLines().join("\n");
        soft(lines(), "main's line for the close (offboard-close.ts:195)").toContain("ada offboarded; its session closed and the seat rests");
        soft(lines(), "no [offboard] line says failed").not.toMatch(/failed/u);
        const detached = lines().includes("ada: its offboarded session is detached and winding down");
        note(testInfo, "S1-how-the-process-ended", detached ? "detached, left to settle, then stopped" : "not detached: stopped at once");
        if (detached) {
          await soft
            .poll(lines, { message: "the wind-down's end (drain-seat.ts:82), as settled", timeout: 20_000 })
            .toContain("ada: its offboarded session ended (settled)");
        }

        // The seat rests: no process, no state of a live seat, and the closer's own account.
        const progress = await progressOf(page, "ada");
        note(testInfo, "S1-progress", JSON.stringify(progress ?? null));
        soft(progress?.stage, "the seat's offboard stands at resting").toBe("resting");
        soft(progress?.by, "closed by the operator").toBe("operator");
        soft(progress?.notes, "without notes").toBe(false);
        soft(await seatState(page, "ada"), "the resting seat's state is not that of a live seat").not.toMatch(/^(idle|working|attention)$/u);
        soft(await launches(sandbox, "ada"), "no fresh process started by itself").toBe(1);
        soft(await nodeSessionId(page, "ada"), "S1: the node no longer names the closed session (a Codex id is cleared, rotate.ts:106-107)").not.toBe(sessionIdOf("ada"));
        note(
          testInfo,
          "A7-recorded-only-card",
          `What Ada's card reads once resting is recorded, not asserted (no element says "resting" in the source read): line "${(await card(page, "ada").getByTestId("agent-seat-line").textContent().catch(() => "")) ?? ""}", seat state "${await seatState(page, "ada")}".`,
        );

        // Nothing was typed into Ada's terminal: her input log has no new bytes.
        await sleep(3_000);
        soft(await inputOf(sandbox, "ada", 1), "Ada's input log, before the first press and now").toBe(inputBefore.value);
        await shot(page, "A7", "ada-card-resting");
      },
      "S1-2",
    );

    await step("A8", "Bo: open his panel, press Ask, then rest: he is mailed the rest prompt", async () => {
      const panel = await openCardPanel(page, "bo", "Bo");
      await panel.getByTestId("seat-offboard-ask-rest").click();
      const status = panel.getByTestId("seat-offboard-status");
      await soft(status, "the green line").toHaveText(LINE_ASKED_REST, { timeout: 30_000 });
      await soft(status, "its tone").toHaveAttribute("data-tone", "done");
      await shot(page, "A8", "bo-asked-to-offboard-and-rest");
      await soft
        .poll(() => inputOf(sandbox, "bo", 1), { message: "Bo's input: a mail notice from the operator", timeout: 60_000 })
        .toContain("mail from operator");
      const mail = await mailTexts(bo);
      note(testInfo, "A8-bo-mailbox", JSON.stringify(mail));
      soft(mail.filter((text) => text.includes(ASK_REST_FIRST)).length, "Bo's mailbox holds the rest prompt, once").toBe(1);
      soft(mail.join("\n"), "and not the continue prompt").not.toContain(ASK_CONTINUE_FIRST);
      soft((await progressOf(page, "bo"))?.stage, "Bo's offboard stands at asked").toBe("asked");
      soft((await progressOf(page, "bo"))?.mode, "to rest").toBe("rest");
    });

    await step(
      "A9",
      "Cy: open her panel, press Ask to offboard: she is mailed the continue prompt, and her line reads asked",
      async () => {
        const panel = await openCardPanel(page, "cy", "Cy");
        await panel.getByTestId("seat-offboard-ask-continue").click();
        const status = panel.getByTestId("seat-offboard-status");
        await soft(status, "the green line").toHaveText(LINE_ASKED_CONTINUE, { timeout: 30_000 });
        await soft(status, "its tone").toHaveAttribute("data-tone", "done");
        await shot(page, "A9", "cy-asked-to-offboard-and-continue");
        await soft
          .poll(() => inputOf(sandbox, "cy", 1), { message: "S4-1: a mail line arrives in the seat's terminal", timeout: 60_000 })
          .toContain("mail from operator");
        await soft
          .poll(() => inputOf(sandbox, "cy", 1), { message: "S4-1: the prompt, from its first sentence", timeout: 30_000 })
          .toContain(ASK_CONTINUE_FIRST);
        const mail = await mailTexts(cy);
        note(testInfo, "A9-cy-mailbox", JSON.stringify(mail));
        soft(mail.filter((text) => text.startsWith(ASK_CONTINUE_FIRST)).length, "Cy's mailbox holds the continue prompt, once, and it begins with that sentence").toBe(1);
        soft((await progressOf(page, "cy"))?.stage, "S4-1: the seat's line reads asked").toBe("asked");
        soft((await progressOf(page, "cy"))?.mode, "to continue").toBe("continue");
        await closePanel(page);
      },
      "S4-1",
    );

    await step("S3-1", "mail Ada so she wakes, and have her agent run junto onboard: told there are no notes, and no handoff", async () => {
      expect(pidAlive(adaPid), "Ada's old process must be gone before the fresh one is asked anything").toBe(false);
      const wake = "wake up, ada: retry the nightly sync";
      opData(await bo.op("msg.send", { target: "ada", text: wake }));
      await expect.poll(() => launches(sandbox, "ada"), { message: "a fresh process starts for the mail", timeout: 60_000 }).toBe(2);
      await expect.poll(async () => (await ada.ready()).pid, { message: "the fresh process's pid", timeout: 30_000 }).not.toBe(adaPid);
      await soft.poll(() => inputOf(sandbox, "ada", 2), { message: "the fresh session's input", timeout: 60_000 }).toContain(wake);
      soft(await inputOf(sandbox, "ada", 1), "the mail did not go to the closed session").toBe(inputBefore.value);
      const onboard = opData(await ada.op("onboard", {}));
      note(testInfo, "S3-onboard-payload", JSON.stringify(onboard));
      const without = onboard.previous_session_without_notes as
        | { readonly session_id?: unknown; readonly transcript_path?: unknown; readonly ended_by?: unknown; readonly ended_because?: unknown }
        | undefined;
      soft(without, "previous_session_without_notes (work/control.ts:1010-1026, 1196-1197)").toBeDefined();
      soft(without?.session_id, "the old session id").toBe(sessionIdOf("ada"));
      soft(without?.transcript_path, "its transcript path (the rollout this spec planted)").toBe(transcriptPathOf(sandbox, sessionIdOf("ada")));
      soft(without?.ended_by, "who ended it").toBe("operator");
      soft(onboard.handoff, "no handoff block").toBeUndefined();
      await shot(page, "S3-1", "ada-woken-and-onboarded");
    });
  });
});

// ===========================================================================
// WB + S2 (the popup sentences): a working seat is refused
// ===========================================================================

test("WB S2 [fake-tui] a working seat and a seat on a dialog: Offboard now is greyed with the reason, the asks stay, and a race is refused", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const WREN = seatNode("wren", "Wren", COLUMN[0], ROW[0]);
  const ROOK = seatNode("rook", "Rook", COLUMN[1], ROW[0]);
  await walk(testInfo, "WB", { doc: fixtureOf([WREN, ROOK]) }, async ({ junto, sandbox, shot, step, mark }) => {
    const { page } = junto;
    let wren!: CrewSeat;
    let rook!: CrewSeat;

    await step("B0", "setup: rules, two fake seats started, idle and onboarded", async () => {
      soft(REFUSED_WORKING, "the working sentence in shared/seat-offboard.ts:297-298").toBe(WALK_REFUSED_WORKING);
      soft(REFUSED_ATTENTION, "the attention sentence in shared/seat-offboard.ts:299-300").toBe(WALK_REFUSED_ATTENTION);
      await setRules(page, WALK_RULES);
      await crewPlayFactory(page);
      wren = await startSeat(page, sandbox, WREN);
      rook = await startSeat(page, sandbox, ROOK);
    });

    const refusedPanel = async (label: string, reason: string, what: string): Promise<void> => {
      const panel = await openCardPanel(page, "wren", "Wren");
      const now = panel.getByTestId("seat-offboard-now");
      const block = panel.getByTestId("seat-offboard-now-block");
      await soft(block, "the reason under Offboard now").toHaveText(reason, { timeout: 10_000 });
      await soft(now, "Offboard now cannot be pressed").toBeDisabled();
      await soft(panel.getByTestId("seat-offboard-idle"), "no idle line").toHaveCount(0);
      await soft(panel.getByTestId("seat-offboard-ask-continue"), "Ask to offboard is pressable").toBeEnabled();
      await soft(panel.getByTestId("seat-offboard-ask-rest"), "Ask, then rest is pressable").toBeEnabled();
      note(testInfo, `${label}-paint`, JSON.stringify({ block: await paint(block).catch(() => "no block"), now: await paint(now) }));
      await shot(page, label, what);
      await closePanel(page);
    };

    await step(
      "B1",
      "make the seat work and open its panel: greyed, with the working sentence",
      async () => {
        await wren.control({ screen: { mode: "working" } });
        await expectSeatState(page, "wren", "working");
        await refusedPanel("B1", REFUSED_WORKING, "working-seat-refused");
      },
      "S2-1 popup",
    );

    await step(
      "B2",
      "put the seat on a dialog and reopen: the same, with the waiting on you sentence",
      async () => {
        await wren.control({ screen: { mode: "attention" } });
        await soft.poll(() => seatState(page, "wren"), { message: "the seat on a dialog reads attention", timeout: 30_000 }).toBe("attention");
        note(testInfo, "B2-seat-state", await seatState(page, "wren"));
        await refusedPanel("B2", REFUSED_ATTENTION, "seat-on-a-dialog-refused");
      },
      "S2-1 dialog",
    );

    await step("B3", "race: panel open on an idle seat, it starts working, Offboard now pressed twice: refused, and the turn is not cut", async () => {
      const pid = (await rook.ready()).pid;
      const panel = await openCardPanel(page, "rook", "Rook");
      const now = panel.getByTestId("seat-offboard-now");
      await expect(now, "Offboard now on the idle seat").toBeEnabled({ timeout: 10_000 });
      await rook.control({ screen: { mode: "working" } });
      await expectSeatState(page, "rook", "working");
      const before = await inputOf(sandbox, "rook", 1);
      if (!(await now.isEnabled())) {
        note(testInfo, "B3-recorded-only", "The panel had already re-asked and greyed Offboard now, so the race could not be pressed. The refusal is the one B1 shows.");
        await shot(page, "B3", "race-not-reachable-button-already-greyed");
        return;
      }
      await now.click();
      await now.click();
      mark("Offboard now pressed twice on a seat that began working");
      const status = panel.getByTestId("seat-offboard-status");
      await soft(status, "the red line").toHaveText(`Not closed. ${REFUSED_WORKING}`, { timeout: 30_000 });
      await soft(status, "its tone").toHaveAttribute("data-tone", "refused");
      await shot(page, "B3", "race-refused-not-closed");
      await sleep(3_000);
      soft(pidAlive(pid), "the seat's process is still running").toBe(true);
      soft(await seatState(page, "rook"), "the seat keeps working").toBe("working");
      soft(await launches(sandbox, "rook"), "no other process was started").toBe(1);
      soft(await inputOf(sandbox, "rook", 1), "nothing was typed into it").toBe(before);
      soft((await progressOf(page, "rook"))?.stage, "no close is on record for it").toBeUndefined();
    });
  });
});

// ===========================================================================
// WC1: bottom bar, one agent selected
// ===========================================================================

test("WC1 [fake-tui] bottom bar, one agent: the row of keys ends with the offboard key, and it opens the same panel", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const ADA = seatNode("ada", "Ada", COLUMN[0], ROW[0]);
  await walk(testInfo, "WC1", { doc: fixtureOf([ADA]) }, async ({ junto, sandbox, shot, step }) => {
    const { page } = junto;

    await step("C1-0", "setup: rules, one fake seat started, idle and onboarded", async () => {
      await setRules(page, WALK_RULES);
      await crewPlayFactory(page);
      await startSeat(page, sandbox, ADA);
    });

    let fromCard = { idle: "", preferred: "" };
    await step("C1-1", "click one idle seat: the agent's row of keys ends with a new key, same icon, same tip", async () => {
      // What the seat shows from its card, to compare in C1-2.
      const dialog = await openCardPanel(page, "ada", "Ada");
      const cardPanel = dialog.getByTestId("seat-offboard-panel");
      await soft.poll(() => preferredSide(cardPanel), { message: "the card panel has its preferred mark", timeout: 10_000 }).toMatch(/marks=1/u);
      const idle = dialog.getByTestId("seat-offboard-idle");
      fromCard = { idle: (await idle.count()) > 0 ? ((await idle.textContent()) ?? "") : "", preferred: await preferredSide(cardPanel) };
      const cardIcon = await page.getByTestId("seat-offboard-open").locator("svg").first().getAttribute("class");
      await select(page, ["ada"]);
      const key = page.getByTestId("rts-seat-offboard");
      await expect(key).toBeVisible({ timeout: 10_000 });
      // rts/RtsBottomBar.tsx:527 (the middle section) and rts/KindSurface.tsx:543-545 (the strip, the key last).
      const middle = page.locator(".rts-panel--mid");
      soft(inside(await boxOf(key), await boxOf(middle)), "the key is inside the middle section").toBe(true);
      const keys = await middle.locator(".rts-kind-strip button").evaluateAll((buttons) =>
        buttons.map((button) => button.getAttribute("data-testid") ?? button.getAttribute("aria-label") ?? ""),
      );
      note(testInfo, "C1-1-keys-in-order", JSON.stringify(keys));
      soft(keys[keys.length - 1], "the last key of the row").toBe("rts-seat-offboard");
      soft(await key.locator("svg").first().getAttribute("class"), "the same icon as the card button").toBe(cardIcon);
      await expectTip(page, key, TIP_ONE, "the tip on the bar key");
      await shot(page, "C1-1", "bar-row-ends-with-offboard-key");
    });

    await step("C1-2", "press it: the same panel opens above the key, with the idle line and preferred mark the card shows", async () => {
      const key = page.getByTestId("rts-seat-offboard");
      const panel = await openBarPanel(page);
      await soft(panel.locator(".seat-offboard-panel__title"), "the title").toHaveText("Offboard Ada");
      await soft.poll(() => preferredSide(panel), { message: "the preferred mark, as from the card", timeout: 10_000 }).toBe(fromCard.preferred);
      const idle = panel.getByTestId("seat-offboard-idle");
      soft((await idle.count()) > 0 ? ((await idle.textContent()) ?? "") : "", "the idle line, as from the card (a minute may tick between the two)").toBe(fromCard.idle);
      await soft(panel.getByTestId("seat-offboard-ask-continue"), "Ask to offboard").toBeVisible();
      await soft(panel.getByTestId("seat-offboard-ask-rest"), "Ask, then rest").toBeVisible();
      await soft(panel.getByTestId("seat-offboard-now"), "Offboard now").toBeEnabled();
      const panelBox = await boxOf(panel);
      const keyBox = await boxOf(key);
      note(testInfo, "C1-2-boxes", JSON.stringify({ panel: panelBox, key: keyBox }));
      soft((panelBox?.y ?? 0) + (panelBox?.height ?? 0), "the panel is above the key").toBeLessThanOrEqual((keyBox?.y ?? 0) + 0.5);
      await shot(page, "C1-2", "bar-panel-above-key");
      await closePanel(page);
    });
  });
});

// ===========================================================================
// WC2 + S2 + S4-2: bottom bar, several agents selected
// ===========================================================================

test("WC2 S2 S4-2 [fake-tui] bottom bar, a selection: the strip above the composer, Offboard now closes the idle ones and refuses the working one, and an ask reaches a working seat", async ({}, testInfo) => {
  // One real wait of a little over 2 minutes (C2-prep). About 6 minutes in all.
  test.setTimeout(720_000);
  // Eight seats, four to a row, so that no step needs a seat an earlier step changed:
  //   ada, bo        idle, never asked: pass the window, closed in C2-4
  //   cy, dee        put to work in C2-prep and kept working (a line printed every few seconds)
  //   eve            idle, never touched until S4-2
  //   fay, gus, hal  idle, never touched until C2-6, which runs last (an asked fake starts a
  //                  turn and, left alone, later reads attention: nothing is asked of it again)
  const X = [60, 340, 620, 900] as const;
  const ADA = seatNode("ada", "Ada", X[0], ROW[0]);
  const BO = seatNode("bo", "Bo", X[1], ROW[0]);
  const CY = seatNode("cy", "Cy", X[2], ROW[0]);
  const DEE = seatNode("dee", "Dee", X[3], ROW[0]);
  const EVE = seatNode("eve", "Eve", X[0], ROW[1]);
  const FAY = seatNode("fay", "Fay", X[1], ROW[1]);
  const GUS = seatNode("gus", "Gus", X[2], ROW[1]);
  const HAL = seatNode("hal", "Hal", X[3], ROW[1]);
  const ALL = [ADA, BO, CY, DEE, EVE, FAY, GUS, HAL];
  await walk(testInfo, "WC2", { doc: fixtureOf(ALL) }, async (ctx) => {
    const { junto, sandbox, dir, shot, step, mark, offboardLines } = ctx;
    const { page } = junto;
    const seats: Record<string, CrewSeat> = {};
    const pids: Record<string, number> = {};
    let line = 0;
    /** A working fake that prints nothing comes to read as stalled (attention): keep its turn visibly going. */
    const keepWorking = async (): Promise<void> => {
      line += 1;
      for (const id of ["cy", "dee"]) await seats[id]!.print(`working: step ${String(line)}`);
    };
    const expectWorking = async (ids: ReadonlyArray<string>): Promise<void> => {
      await keepWorking();
      for (const id of ids) await expectSeatState(page, id, "working");
    };
    const expectIdle = async (ids: ReadonlyArray<string>): Promise<void> => {
      for (const id of ids) expect(await seatState(page, id), `${id} is idle`).toBe("idle");
    };

    await step("C2-0", "setup: rules, eight fake seats started, idle and onboarded", async () => {
      await setRules(page, WALK_RULES);
      await crewPlayFactory(page);
      for (const node of ALL) {
        seats[node.id] = await startSeat(page, sandbox, node);
        pids[node.id] = (await seats[node.id]!.ready()).pid;
      }
      await shot(page, "C2-0", "eight-seats-idle");
    });

    // Run first, while every seat is still fresh: blocks are labelled by walk step, not by time.
    await step("C2-7", "select all eight seats, every one inside the window: None is past the cache window.", async () => {
      await expectIdle(ALL.map((node) => node.id));
      await select(page, ALL.map((node) => node.id));
      const panel = await openBarPanel(page);
      await soft(panel.locator(".seat-offboard-panel__title"), "the title").toHaveText("Offboard 8 agents");
      await soft(panel.getByTestId("seat-offboard-idle"), "the idle line").toHaveText(IDLE_NONE_PAST, { timeout: 10_000 });
      await soft(panel.getByTestId("seat-offboard-preferred"), "no preferred mark on a selection").toHaveCount(0);
      await shot(page, "C2-7", "selection-none-past-the-window");
      await closePanel(page);
    });

    await step("C2-prep", "Cy and Dee are put to work; Ada and Bo pass the window in real time, untouched", async () => {
      await clearSelection(page);
      await seats.cy!.control({ screen: { mode: "working" } });
      await seats.dee!.control({ screen: { mode: "working" } });
      await expectWorking(["cy", "dee"]);
      await waitPastWindow(ctx, testInfo, ["ada", "bo"], "C2-prep", keepWorking);
      await expectIdle(["ada", "bo"]);
      await expectWorking(["cy", "dee"]);
    });

    await step("C2-1", "shift-click Ada, Bo (idle, past the window) and Cy (working): a one-key strip ABOVE the composer, and the composer is not clipped", async () => {
      await select(page, ["ada", "bo", "cy"]);
      // rts/KindSurface.tsx:417-418 (the strip), :350 (the composer), chat/ChatComposer.tsx:76, 84, 115.
      const shell = page.locator(".rts-shell");
      const middle = page.locator(".rts-panel--mid");
      const strip = middle.getByRole("toolbar", { name: "Selected agents actions" });
      const key = page.getByTestId("rts-seat-offboard");
      const composer = page.getByTestId("rts-multi-prompt");
      const field = composer.locator(".chat-composer__input");
      const label = composer.locator(".chat-composer__eyebrow");
      const send = composer.locator(".chat-composer__send");
      await soft(strip, "the strip").toBeVisible({ timeout: 10_000 });
      await soft(composer, "the composer").toBeVisible({ timeout: 10_000 });
      // The frames first, whatever the verdict.
      await page.screenshot({ path: join(dir, "C2-1-multi-selection-strip-and-composer.png"), fullPage: true }).catch(() => undefined);
      const viewport = await page.evaluate(() => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }));
      const boxes = {
        viewport,
        bottomBar: await boxOf(shell),
        middleSection: await boxOf(middle),
        strip: await boxOf(strip),
        key: await boxOf(key),
        composer: await boxOf(composer),
        field: await boxOf(field),
        label: await boxOf(label),
        send: await boxOf(send),
      };
      note(testInfo, "C2-1-boxes", JSON.stringify(boxes));
      mark(`C2-1 boxes: ${JSON.stringify(boxes)}`);
      for (const [name, clip] of [
        ["bottom-bar", boxes.bottomBar],
        ["middle-section", boxes.middleSection],
      ] as const) {
        if (clip === undefined || clip.width <= 0 || clip.height <= 0) {
          note(testInfo, `C2-1-crop-${name}`, "not taken: the element has no box");
          continue;
        }
        await page.screenshot({ path: join(dir, `C2-1-${name}-crop.png`), clip }).catch((error: unknown) => {
          note(testInfo, `C2-1-crop-${name}`, `not taken: ${String(error)}`);
        });
      }

      await soft(strip.locator("button"), "one key in the strip").toHaveCount(1);
      await soft(key, "and it is the offboard key").toHaveAttribute("aria-label", "Offboard 3 agents");
      await soft(field, "the composer's text field").toHaveAttribute("placeholder", "Message all selected agents…");
      await soft(label, "the composer's label").toHaveText("multi-prompt — 3 agents");
      await soft(send, "the composer's send button").toHaveAttribute("aria-label", "Send to all selected agents");
      soft((boxes.strip?.y ?? 0) + (boxes.strip?.height ?? 0), "the strip ends above where the composer starts").toBeLessThanOrEqual((boxes.composer?.y ?? 0) + 0.5);
      for (const [name, box] of [
        ["text field", boxes.field],
        ["label", boxes.label],
        ["send button", boxes.send],
      ] as const) {
        soft(box, `the ${name} has a box`).toBeDefined();
        soft(inside(box, boxes.middleSection), `the ${name} is fully inside the middle section of the bar`).toBe(true);
        soft(inside(box, boxes.bottomBar), `the ${name} is fully inside the bottom bar`).toBe(true);
        soft(inside(box, boxes.viewport), `the ${name} is fully inside the window`).toBe(true);
      }
      soft(inside(boxes.strip, boxes.middleSection), "the strip is fully inside the middle section").toBe(true);
      // Still usable: it takes text, and nothing lies over its field or its send button.
      await field.fill("probe: is the composer usable");
      await soft(field, "the field takes text").toHaveValue("probe: is the composer usable");
      await soft(send, "the send button is pressable with text in the field").toBeEnabled();
      if (boxes.field !== undefined) soft(await topmostAt(page, boxes.field), "what is on top at the text field").toBe("rts-multi-prompt");
      if (boxes.send !== undefined) soft(await topmostAt(page, boxes.send), "what is on top at the send button").toBe("rts-multi-prompt");
      await shot(page, "C2-1", "composer-with-text");
      await field.fill("");
      await expectSelection(page, ["ada", "bo", "cy"]);
    });

    let panel!: Locator;
    await step(
      "C2-2",
      "press the key (Ada, Bo, Cy still selected): Offboard 3 agents, 2 of 3 are past the cache window, no preferred mark",
      async () => {
        await expectWorking(["cy"]);
        await expectSelection(page, ["ada", "bo", "cy"]);
        panel = await openBarPanel(page);
        await soft(panel.locator(".seat-offboard-panel__title"), "the title").toHaveText("Offboard 3 agents");
        await soft(panel.getByTestId("seat-offboard-idle"), "the idle line").toHaveText("2 of 3 are past the cache window.", { timeout: 10_000 });
        await soft(panel.getByTestId("seat-offboard-preferred"), "no preferred mark anywhere").toHaveCount(0);
        // A selection's panel has no session line (lib/seat-offboard.ts:187), and both asks stay pressable.
        await soft(panel.getByTestId("seat-offboard-session"), "no session line on a selection's panel").toHaveCount(0);
        await soft(panel.getByTestId("seat-offboard-ask-continue"), "Ask to offboard is pressable").toBeEnabled();
        await soft(panel.getByTestId("seat-offboard-ask-rest"), "Ask, then rest is pressable").toBeEnabled();
        await soft(panel.getByTestId("seat-offboard-now"), "Offboard now is pressable").toBeEnabled();
        await shot(page, "C2-2", "selection-panel-two-of-three-past");
      },
      "S2-1",
    );

    const before: Record<string, string> = {};
    await step("C2-3", "press Offboard now once (Ada, Bo, Cy): Close 2 sessions?", async () => {
      await keepWorking();
      for (const id of ["ada", "bo", "cy"]) before[id] = await inputOf(sandbox, id, 1);
      await watchStatus(page);
      const now = panel.getByTestId("seat-offboard-now");
      await expect(now).toBeEnabled();
      await now.click();
      await soft(now, "the armed button").toHaveText("Close 2 sessions?");
      await soft(now, "the armed mark").toHaveAttribute("data-armed", "true");
      await shot(page, "C2-3", "armed-close-2-sessions");
    });

    await step(
      "C2-4",
      "press again within 3 seconds: 2 closed, 1 is working; Ada and Bo rest, Cy keeps working",
      async () => {
        await panel.getByTestId("seat-offboard-now").click();
        mark("Offboard now confirmed on Ada, Bo and Cy");
        const status = panel.getByTestId("seat-offboard-status");
        await soft(status, "the amber line (S2: in the form Offboard now: 2 closed, 1 is working)").toHaveText("2 closed, 1 is working", { timeout: 30_000 });
        await soft(status, "its tone").toHaveAttribute("data-tone", "partial");
        note(testInfo, "C2-4-status-lines-in-order", JSON.stringify(await statusSeen(page)));
        await shot(page, "C2-4", "two-closed-one-is-working");
        for (const id of ["ada", "bo"]) {
          await soft.poll(() => pidAlive(pids[id]!), { message: `${id}: its old process is still alive`, timeout: 20_000 }).toBe(false);
          const progress = await progressOf(page, id);
          soft(progress?.stage, `${id} rests`).toBe("resting");
          soft(progress?.by, `${id} was closed by the operator`).toBe("operator");
          soft(progress?.notes, `${id} was closed without notes`).toBe(false);
          soft(await nodeSessionId(page, id), `S2: ${id} no longer names the closed session`).not.toBe(sessionIdOf(id));
          soft(await launches(sandbox, id), `${id}: no fresh process started by itself`).toBe(1);
        }
        await sleep(3_000);
        for (const id of ["ada", "bo", "cy"]) {
          soft(await inputOf(sandbox, id, 1), `${id}: nothing was typed into it`).toBe(before[id]);
        }
        await keepWorking();
        soft(pidAlive(pids.cy!), "S2: the working seat's process is untouched").toBe(true);
        soft(await seatState(page, "cy"), "S2: its turn keeps running").toBe("working");
        soft(await nodeSessionId(page, "cy"), "it still names its session").toBe(sessionIdOf("cy"));
        soft(offboardLines().join("\n"), "no [offboard] line says failed").not.toMatch(/failed/u);
        note(
          testInfo,
          "S2-recorded-only",
          "S2 asks for one of the two closed seats to be an already resting seat (C). Here both closed seats were idle and running, which is what C2 asks for; a resting seat in the selection is not covered.",
        );
        await closePanel(page);
      },
      "S2-1",
    );

    await step("C2-5", "select only working seats (Cy and Dee): Offboard now greyed, None of these agents can be closed right now.", async () => {
      await expectWorking(["cy", "dee"]);
      await select(page, ["cy", "dee"]);
      const two = await openBarPanel(page);
      await soft(two.locator(".seat-offboard-panel__title"), "the title").toHaveText("Offboard 2 agents");
      await soft(two.getByTestId("seat-offboard-now-block"), "the amber text").toHaveText(NONE_CLOSABLE, { timeout: 10_000 });
      await soft(two.getByTestId("seat-offboard-now"), "Offboard now cannot be pressed").toBeDisabled();
      await shot(page, "C2-5", "only-working-seats-none-can-be-closed");
      await closePanel(page);
    });

    await step("S4-2", "select Eve (idle) and Dee (working), press Ask to offboard: both are asked", async () => {
      await expectIdle(["eve"]);
      await expectWorking(["dee"]);
      await select(page, ["eve", "dee"]);
      const two = await openBarPanel(page);
      await soft(two.locator(".seat-offboard-panel__title"), "the title").toHaveText("Offboard 2 agents");
      await two.getByTestId("seat-offboard-ask-continue").click();
      const status = two.getByTestId("seat-offboard-status");
      await soft(status, "the green line (S4: in the form Ask to offboard: 2 asked)").toHaveText("Asked 2 agents to offboard and continue", { timeout: 30_000 });
      await soft(status, "its tone").toHaveAttribute("data-tone", "done");
      await shot(page, "S4-2", "idle-and-working-both-asked");
      for (const id of ["eve", "dee"]) {
        soft((await progressOf(page, id))?.stage, `${id}: its line reads asked`).toBe("asked");
        await soft
          .poll(async () => (await mailTexts(seats[id]!)).filter((text) => text.includes(ASK_CONTINUE_FIRST)).length, {
            message: `${id}: one continue prompt in its mailbox`,
            timeout: 30_000,
          })
          .toBe(1);
      }
      await soft.poll(() => inputOf(sandbox, "eve", 1), { message: "Eve, idle, is typed the prompt", timeout: 60_000 }).toContain(ASK_CONTINUE_FIRST);
      note(
        testInfo,
        "S4-2-working-seat-input",
        `Whether the prompt was typed into Dee (working) yet is recorded, not asserted (mail to a working seat may wait for its turn): ${String((await inputOf(sandbox, "dee", 1)).includes(ASK_CONTINUE_FIRST))}`,
      );
      await closePanel(page);
    });

    // Last: the three seats nothing has touched since they started.
    await step("C2-6", "select three idle seats (Fay, Gus, Hal), press Ask to offboard: three asked, each gets the continue prompt once", async () => {
      const trio = ["fay", "gus", "hal"];
      await expectIdle(trio);
      await select(page, trio);
      const three = await openBarPanel(page);
      await soft(three.locator(".seat-offboard-panel__title"), "the title").toHaveText("Offboard 3 agents");
      await three.getByTestId("seat-offboard-ask-continue").click();
      const status = three.getByTestId("seat-offboard-status");
      await soft(status, "the green line").toHaveText("Asked 3 agents to offboard and continue", { timeout: 30_000 });
      await soft(status, "its tone").toHaveAttribute("data-tone", "done");
      await shot(page, "C2-6", "three-asked-to-offboard-and-continue");
      for (const id of trio) {
        await soft.poll(() => inputOf(sandbox, id, 1), { message: `${id}: the continue prompt on its input`, timeout: 60_000 }).toContain(ASK_CONTINUE_FIRST);
      }
      await sleep(3_000);
      for (const id of trio) {
        soft(occurrences(await inputOf(sandbox, id, 1), ASK_CONTINUE_FIRST), `${id}: the prompt was typed once`).toBe(1);
        soft((await mailTexts(seats[id]!)).filter((text) => text.includes(ASK_CONTINUE_FIRST)).length, `${id}: one prompt in its mailbox`).toBe(1);
        soft((await progressOf(page, id))?.stage, `${id}: its line reads asked`).toBe("asked");
      }
      for (const id of ["ada", "bo", "cy", "eve"]) {
        soft(occurrences(await inputOf(sandbox, id, 1), ASK_CONTINUE_FIRST), `${id}, not in this selection, was not typed a second prompt`).toBe(id === "eve" ? 1 : 0);
      }
      await closePanel(page);
    });
  });
});

// ===========================================================================
// WD: the Sessions tab
// ===========================================================================

test("WD [fake-tui] the Sessions tab: no buttons, where to find Offboard, and the three steps of an ask with the first one done", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const BO = seatNode("bo", "Bo", COLUMN[0], ROW[0]);
  await walk(testInfo, "WD", { doc: fixtureOf([BO]) }, async ({ junto, sandbox, shot, step }) => {
    const { page } = junto;

    await step("D0", "setup: one fake seat, asked to offboard and rest from its popup, as in A8", async () => {
      await setRules(page, WALK_RULES);
      await crewPlayFactory(page);
      await startSeat(page, sandbox, BO);
      const panel = await openCardPanel(page, "bo", "Bo");
      await panel.getByTestId("seat-offboard-ask-rest").click();
      await expect(panel.getByTestId("seat-offboard-status")).toHaveText(LINE_ASKED_REST, { timeout: 30_000 });
      await closePanel(page);
    });

    await step("D1", "select the seat, open Customize, tab sessions", async () => {
      // seat-offboard-modes.spec.ts:76-85; agent-editor/AgentEditor.tsx:127, 221.
      const customize = page.getByTestId("toolbar-customize-agent");
      if (!(await customize.isVisible().catch(() => false))) await select(page, ["bo"]);
      await expect(customize).toBeVisible({ timeout: 10_000 });
      await customize.click();
      const editor = page.getByTestId("agent-editor");
      await expect(editor).toBeVisible({ timeout: 10_000 });
      await editor.getByRole("tab", { name: "sessions" }).click();
      const block = editor.getByTestId("seat-offboard");
      await expect(block).toBeVisible({ timeout: 10_000 });
      await soft(block.getByRole("button"), "no buttons in the offboard block").toHaveCount(0);
      await soft(block.getByTestId("seat-offboard-where"), "where to find Offboard").toHaveText(SESSIONS_WHERE);
      const progress = block.getByTestId("seat-offboard-progress");
      await soft(progress, "the offboard stands at asked").toHaveAttribute("data-stage", "asked", { timeout: 20_000 });
      await soft(progress, "to rest").toHaveAttribute("data-mode", "rest");
      const steps = progress.locator(".seat-offboard__step");
      await soft(steps, "the three steps, in order").toHaveText(["Asked", "Notes saved", "Session closed, seat resting"]);
      // sessions/OffboardControls.tsx:71-72: a done step carries data-done and a green dot.
      await soft(steps.nth(0), "the first step is done").toHaveAttribute("data-done", "true");
      await soft(steps.nth(1), "the second is not").not.toHaveAttribute("data-done", "true");
      await soft(steps.nth(2), "the third is not").not.toHaveAttribute("data-done", "true");
      note(
        testInfo,
        "D1-dots",
        JSON.stringify(await steps.evaluateAll((items) => items.map((item) => (item.firstElementChild ? getComputedStyle(item.firstElementChild).backgroundColor : "no dot")))),
      );
      await shot(page, "D1", "sessions-tab-offboard-block");
    });
  });
});

// ===========================================================================
// WE and WF: the right-click menus (main a28b9a038 or later)
// ===========================================================================

/** The open canvas menu (Canvas.tsx:1224 for a selection, :1273 for one agent). */
const canvasMenu = (page: Page): Locator => page.locator(".canvas-action-menu");
/** nodes/SeatOffboard.tsx:288 and :309. */
const menuAsk = (page: Page): Locator => canvasMenu(page).getByTestId("menu-offboard-ask");
const menuNow = (page: Page): Locator => canvasMenu(page).getByTestId("menu-offboard-now");

const closeMenu = async (page: Page): Promise<void> => {
  if ((await canvasMenu(page).count()) === 0) return;
  await page.keyboard.press("Escape");
  const closed = await canvasMenu(page).waitFor({ state: "detached", timeout: 3_000 }).then(() => true, () => false);
  // A menu that Esc did not close is the step's own finding; a click on the empty canvas (Canvas.tsx:1707-1709)
  // closes it so the walk can go on.
  if (!closed) await clearSelection(page);
  await expect(canvasMenu(page)).toHaveCount(0, { timeout: 5_000 });
};

/** Select the nodes, then right-click one of them (seat-message.spec.ts:171-175). */
const openSelectionMenu = async (page: Page, nodeIds: ReadonlyArray<string>, on: string, agents: number = nodeIds.length): Promise<Locator> => {
  await closeMenu(page);
  await select(page, nodeIds, agents);
  await card(page, on).click({ button: "right" });
  const menu = page.getByRole("toolbar", { name: `Actions for ${String(nodeIds.length)} nodes` });
  await expect(menu).toBeVisible({ timeout: 10_000 });
  return menu;
};

/** The labels of the menu's rows, in order, as the source writes them (the caps are CSS). */
const rowLabels = async (menu: Locator): Promise<ReadonlyArray<string>> =>
  (await menu.locator("button strong").allTextContents()).map((text) => text.trim().toUpperCase());

test("WE [fake-tui] right-click on a selection: the two offboard rows, the two presses, the result lines, and the menu opened low stays in view", async ({}, testInfo) => {
  test.setTimeout(360_000);
  const ADA = seatNode("ada", "Ada", COLUMN[0], ROW[0]);
  const BO = seatNode("bo", "Bo", COLUMN[1], ROW[0]);
  const EVE = seatNode("eve", "Eve", COLUMN[2], ROW[0]);
  const DEE = seatNode("dee", "Dee", COLUMN[0], ROW[1]);
  // Low on the canvas: the seat the selection is right-clicked on.
  const CY = seatNode("cy", "Cy", COLUMN[1], 640);
  const SEATS = [ADA, BO, EVE, DEE, CY];
  const NOTES = [modelNote("note-one", "A note", COLUMN[2], ROW[1]), modelNote("note-two", "Another note", COLUMN[2], 640)];
  const doc = modelFixture([...SEATS, ...NOTES]);
  await walk(testInfo, "WE", { doc }, async ({ junto, sandbox, dir, shot, step: walkStep, mark }) => {
    const { page } = junto;
    const seats: Record<string, CrewSeat> = {};
    const pids: Record<string, number> = {};
    let menu!: Locator;
    // Seats by step: E8 Ada, Bo, Eve (idle); E9 the two notes; E1 to E5 and E10 Ada, Bo (idle) and Cy (working);
    // E7 Cy and Dee (working). A working fake that prints nothing comes to read as stalled (attention),
    // so Cy and Dee print a line at the start of every step.
    let line = 0;
    const step = (label: string, title: string, body: () => Promise<void>): Promise<void> =>
      walkStep(label, title, async () => {
        line += 1;
        for (const id of ["cy", "dee"]) await seats[id]?.print(`working: step ${String(line)}`);
        await body();
      });

    await step("E0", "setup: rules, five fake seats (three idle, two working) and two notes", async () => {
      await setRules(page, WALK_RULES);
      await crewPlayFactory(page);
      for (const node of SEATS) {
        seats[node.id] = await startSeat(page, sandbox, node);
        pids[node.id] = (await seats[node.id]!.ready()).pid;
      }
      await seats.cy!.control({ screen: { mode: "working" } });
      await seats.dee!.control({ screen: { mode: "working" } });
      await expectSeatState(page, "cy", "working");
      await expectSeatState(page, "dee", "working");
      await shot(page, "E0", "seats-and-notes");
    });

    // E8 and E9 run first, while the idle seats are still running: blocks are labelled by walk step, not by time.
    await step("E8", "two idle seats: both can close now; three idle seats: all 3 can close now", async () => {
      await openSelectionMenu(page, ["ada", "bo"], "bo");
      await soft(menuNow(page).locator("small"), "two idle seats").toHaveText("both can close now", { timeout: 10_000 });
      await shot(page, "E8", "two-idle-both-can-close-now");
      await openSelectionMenu(page, ["ada", "bo", "eve"], "eve");
      await soft(menuNow(page).locator("small"), "three idle seats").toHaveText("all 3 can close now", { timeout: 10_000 });
      await shot(page, "E8", "three-idle-all-3-can-close-now");
      await closeMenu(page);
    });

    await step("E9", "a selection with no agent in it (two notes): neither row is there", async () => {
      menu = await openSelectionMenu(page, ["note-one", "note-two"], "note-two", 0);
      await soft(menuAsk(page), "no ask row").toHaveCount(0);
      await soft(menuNow(page), "no offboard now row").toHaveCount(0);
      note(testInfo, "E9-rows", JSON.stringify(await rowLabels(menu)));
      await shot(page, "E9", "two-notes-no-offboard-rows");
      await closeMenu(page);
    });

    await step("E1", "select two idle seats and a working one, right-click the low one: the rows in order, and the menu is fully in view", async () => {
      expect(await seatState(page, "ada"), "Ada is idle").toBe("idle");
      expect(await seatState(page, "bo"), "Bo is idle").toBe("idle");
      await expectSeatState(page, "cy", "working");
      menu = await openSelectionMenu(page, ["ada", "bo", "cy"], "cy");
      await soft(menuNow(page).locator("small"), "the grey line under OFFBOARD NOW").toHaveText("2 of 3 can close now", { timeout: 10_000 });
      // The frame first, whatever the verdict.
      await page.screenshot({ path: join(dir, "E-menu-opened-low.png"), fullPage: true }).catch(() => undefined);
      const viewport = await page.evaluate(() => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }));
      const boxes = { viewport, menu: await boxOf(menu), clickedCard: await boxOf(card(page, "cy")), bottomBar: await boxOf(page.locator(".rts-shell")) };
      note(testInfo, "E-menu-opened-low-boxes", JSON.stringify(boxes));
      mark(`E-menu-opened-low boxes: ${JSON.stringify(boxes)}`);
      soft(boxes.menu, "the menu has a box").toBeDefined();
      soft(inside(boxes.menu, viewport), "the menu is fully inside the window").toBe(true);
      const cardMiddle = (boxes.clickedCard?.y ?? 0) + (boxes.clickedCard?.height ?? 0) / 2;
      note(testInfo, "E-menu-opened-low-how-low", `the right-click was ${String(Math.round(viewport.height - cardMiddle))} px above the bottom of a ${String(viewport.height)} px window`);
      soft(cardMiddle, "the right-clicked seat is in the lower half of the window (else this frame does not show the low case)").toBeGreaterThan(viewport.height / 2);

      const labels = await rowLabels(menu);
      note(testInfo, "E1-rows-in-order", JSON.stringify(labels));
      soft(labels.slice(0, 9), "the rows, in order").toEqual([
        "MESSAGE",
        "CONNECT",
        "OPEN",
        "DISCONNECT",
        "STOP",
        "CHECK",
        "ASK TO OFFBOARD",
        "OFFBOARD NOW",
        "SAVE AS SQUAD",
      ]);
      await soft(menuAsk(page).locator("small"), "the grey line under ASK TO OFFBOARD").toHaveText("3 agents, continue");
      note(
        testInfo,
        "E1-row-paint",
        JSON.stringify({
          askLabel: await menuAsk(page).locator("strong").evaluate((element) => `${getComputedStyle(element).textTransform}, ${getComputedStyle(element).color}`),
          checkLabel: await menu.locator("button strong", { hasText: "check" }).first().evaluate((element) => `${getComputedStyle(element).textTransform}, ${getComputedStyle(element).color}`).catch(() => "no check row"),
          askLine: await paint(menuAsk(page).locator("small")),
        }),
      );
      await shot(page, "E1", "selection-menu-rows");
    });

    await step("E2", "press OFFBOARD NOW once: the menu stays open, CLOSE 2 SESSIONS? and press again to close, no notes", async () => {
      await menuNow(page).click();
      await soft(menu, "the menu stays open").toBeVisible();
      await soft(menuNow(page).locator("strong"), "the armed label").toHaveText("CLOSE 2 SESSIONS?", { ignoreCase: true });
      await soft(menuNow(page).locator("small"), "the armed grey line").toHaveText("press again to close, no notes");
      await soft(menuNow(page), "the armed mark").toHaveAttribute("data-armed", "true");
      note(testInfo, "E2-armed-paint", await paint(menuNow(page).locator("strong")));
      for (const id of ["ada", "bo", "cy"]) {
        soft(pidAlive(pids[id]!), `${id}: its process is still running`).toBe(true);
        soft(await progressOf(page, id), `${id}: no offboard on record`).toBeUndefined();
      }
      await shot(page, "E2", "armed-close-2-sessions");
    });

    await step("E3", "wait 4 seconds: OFFBOARD NOW and 2 of 3 can close now again, by itself", async () => {
      await page.waitForTimeout(4_000);
      await soft(menu, "the menu is still open").toBeVisible();
      await soft(menuNow(page).locator("strong"), "the label").toHaveText("OFFBOARD NOW", { ignoreCase: true });
      await soft(menuNow(page).locator("small"), "the grey line").toHaveText("2 of 3 can close now");
      await soft(menuNow(page), "no armed mark").not.toHaveAttribute("data-armed", "true");
      await shot(page, "E3", "disarmed-by-itself");
    });

    await step("E10", "keyboard: arrow down through the rows, the two new rows take focus in order, Enter on OFFBOARD NOW arms it", async () => {
      // The menu was opened with the pointer, which leaves focus alone (Canvas.tsx:884-885, 893): the walk starts from its first row.
      const rows = menu.locator("button:not(:disabled)");
      await rows.first().focus();
      const focused = (): Promise<string> =>
        page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.querySelector("strong")?.textContent ?? "");
      const order: string[] = [await focused()];
      for (let press = 0; press < 12 && order[order.length - 1] !== "menu-offboard-now"; press += 1) {
        await page.keyboard.press("ArrowDown");
        order.push(await focused());
      }
      note(testInfo, "E10-focus-order", JSON.stringify(order));
      const at = order.indexOf("menu-offboard-ask");
      soft(at, "ASK TO OFFBOARD took focus").toBeGreaterThan(0);
      soft(order[at + 1], "and OFFBOARD NOW right after it").toBe("menu-offboard-now");
      soft(order[at - 1]?.trim().toUpperCase(), "the row before them is CHECK").toBe("CHECK");
      await soft(menuNow(page), "OFFBOARD NOW has the focus").toBeFocused();
      await page.keyboard.press("Enter");
      await soft(menuNow(page), "Enter arms it").toHaveAttribute("data-armed", "true");
      await soft(menuNow(page).locator("strong"), "the armed label").toHaveText("CLOSE 2 SESSIONS?", { ignoreCase: true });
      await shot(page, "E10", "armed-by-enter");
      // Let the arm run out: E4 presses twice itself.
      await page.waitForTimeout(4_000);
      await soft(menuNow(page), "disarmed again").not.toHaveAttribute("data-armed", "true");
    });

    const before: Record<string, string> = {};
    await step("E4", "press it, and again within 3 seconds: 2 closed, 1 is working; the idle two rest, the working one keeps working", async () => {
      for (const id of ["ada", "bo", "cy"]) before[id] = await inputOf(sandbox, id, 1);
      await menuNow(page).click();
      await menuNow(page).click();
      mark("OFFBOARD NOW confirmed in the selection menu");
      await soft(menuNow(page).locator("small"), "the grey line").toHaveText("2 closed, 1 is working", { timeout: 30_000 });
      await soft(menuNow(page), "its tone (amber)").toHaveAttribute("data-tone", "partial");
      await soft(menu, "the menu stays open").toBeVisible();
      note(testInfo, "E4-line-paint", await paint(menuNow(page).locator("small")).catch(() => "no line"));
      await shot(page, "E4", "two-closed-one-is-working");
      for (const id of ["ada", "bo"]) {
        await soft.poll(() => pidAlive(pids[id]!), { message: `${id}: its old process is still alive`, timeout: 20_000 }).toBe(false);
        soft((await progressOf(page, id))?.stage, `${id} rests`).toBe("resting");
        soft((await progressOf(page, id))?.by, `${id} was closed by the operator`).toBe("operator");
      }
      await sleep(3_000);
      for (const id of ["ada", "bo", "cy"]) soft(await inputOf(sandbox, id, 1), `${id}: nothing was typed into it`).toBe(before[id]);
      soft(pidAlive(pids.cy!), "the working seat's process is untouched").toBe(true);
      soft(await seatState(page, "cy"), "it keeps working").toBe("working");
    });

    await step("E5", "press ASK TO OFFBOARD: the grey line says how many were asked (recorded word for word)", async () => {
      if ((await canvasMenu(page).count()) === 0) {
        note(testInfo, "E5-menu-reopened", "The menu had closed after E4; it was opened again for E5.");
        menu = await openSelectionMenu(page, ["ada", "bo", "cy"], "cy");
      }
      await menuAsk(page).click();
      const line = menuAsk(page).locator("small");
      await soft(line, "the grey line after the ask").toHaveText(/^Asked /u, { timeout: 30_000 });
      const text = ((await line.textContent().catch(() => "")) ?? "").trim();
      note(testInfo, "E5-grey-line", text);
      note(testInfo, "E5-grey-line-tone-and-paint", `${(await menuAsk(page).getAttribute("data-tone")) ?? "none"}; ${await paint(line).catch(() => "no line")}`);
      mark(`E5 grey line: ${text}`);
      soft(text, "all three asked, or a count of those that could not be").toMatch(
        /^(?:Asked 3 agents to offboard and continue|Asked [12] agents? to offboard and continue, [12] could not be asked)$/u,
      );
      await shot(page, "E5", "asked-to-offboard");
    });

    await step("E6", "press Esc: the menu closes", async () => {
      await page.keyboard.press("Escape");
      await soft(canvasMenu(page), "the menu").toHaveCount(0, { timeout: 5_000 });
      await shot(page, "E6", "menu-closed");
    });

    await step("E7", "select only working seats (two), right-click: OFFBOARD NOW greyed, none can close now: 2 are working", async () => {
      expect(await seatState(page, "cy"), "Cy is working").toBe("working");
      expect(await seatState(page, "dee"), "Dee is working").toBe("working");
      await openSelectionMenu(page, ["dee", "cy"], "cy");
      await soft(menuNow(page).locator("small"), "the grey line").toHaveText("none can close now: 2 are working", { timeout: 10_000 });
      await soft(menuNow(page), "OFFBOARD NOW cannot be pressed").toBeDisabled();
      await soft(menuAsk(page), "ASK TO OFFBOARD is pressable").toBeEnabled();
      await shot(page, "E7", "only-working-none-can-close-now");
      await closeMenu(page);
    });
  });
});

test("WF [fake-tui] right-click on one agent: a rule, then the two offboard rows; two presses close an idle seat; a working seat is greyed", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const FIG = seatNode("fig", "Fig", COLUMN[0], ROW[0]);
  const WIL = seatNode("wil", "Wil", COLUMN[1], ROW[0]);
  await walk(testInfo, "WF", { doc: fixtureOf([FIG, WIL]) }, async ({ junto, sandbox, shot, step }) => {
    const { page } = junto;
    let wil!: CrewSeat;
    let figPid = 0;
    /** Canvas.tsx:1273. */
    const seatMenu = page.getByTestId("seat-menu");
    const openSeatMenu = async (nodeId: string): Promise<void> => {
      await closeMenu(page);
      await select(page, [nodeId]);
      await card(page, nodeId).click({ button: "right" });
      await expect(seatMenu).toBeVisible({ timeout: 10_000 });
    };

    await step("F0", "setup: rules, two fake seats started, idle and onboarded", async () => {
      await setRules(page, WALK_RULES);
      await crewPlayFactory(page);
      figPid = (await (await startSeat(page, sandbox, FIG)).ready()).pid;
      wil = await startSeat(page, sandbox, WIL);
    });

    await step("F1", "right-click one idle seat: the existing rows, a thin rule, then the two offboard rows", async () => {
      await openSeatMenu("fig");
      const labels = await rowLabels(seatMenu);
      note(testInfo, "F1-rows-in-order", JSON.stringify(labels));
      soft(labels, "the rows, in order").toEqual([
        "CUSTOMIZE CHARACTER",
        "RENAME",
        "SOUL AND INSTRUCTIONS",
        "SAVE AS PROFILE",
        "ASK TO OFFBOARD",
        "OFFBOARD NOW",
      ]);
      soft(
        await menuAsk(page).evaluate((row) => `${row.previousElementSibling?.tagName ?? ""}.${row.previousElementSibling?.className ?? ""}`),
        "a rule sits right above ASK TO OFFBOARD (Canvas.tsx:1275)",
      ).toBe("HR.canvas-action-menu__rule");
      await soft(menuAsk(page).locator("small"), "the grey line under ASK TO OFFBOARD").toHaveText("continue in a fresh session");
      await soft(menuNow(page).locator("small"), "the grey line under OFFBOARD NOW").toHaveText("no notes, the seat rests", { timeout: 10_000 });
      await soft(menuNow(page), "OFFBOARD NOW is pressable").toBeEnabled();
      const viewport = await page.evaluate(() => ({ x: 0, y: 0, width: window.innerWidth, height: window.innerHeight }));
      note(testInfo, "F1-boxes", JSON.stringify({ viewport, menu: await boxOf(seatMenu) }));
      soft(inside(await boxOf(seatMenu), viewport), "the menu is fully inside the window").toBe(true);
      await shot(page, "F1", "one-agent-menu-rows");
    });

    await step("F2", "press OFFBOARD NOW twice within 3 seconds: armed, then Session closed. The seat is resting.", async () => {
      const before = await inputOf(sandbox, "fig", 1);
      await menuNow(page).click();
      await soft(menuNow(page).locator("strong"), "the armed label").toHaveText("CLOSE THIS SESSION?", { ignoreCase: true });
      await soft(menuNow(page).locator("small"), "the armed grey line").toHaveText("press again to close, no notes");
      await shot(page, "F2", "armed-close-this-session");
      await menuNow(page).click();
      await soft(menuNow(page).locator("small"), "the grey line after the close").toHaveText(LINE_CLOSED_ONE, { timeout: 30_000 });
      await soft(menuNow(page), "its tone (green)").toHaveAttribute("data-tone", "done");
      note(testInfo, "F2-line-paint", await paint(menuNow(page).locator("small")).catch(() => "no line"));
      await shot(page, "F2", "session-closed-the-seat-is-resting");
      await soft.poll(() => pidAlive(figPid), { message: "Fig's old process is still alive", timeout: 20_000 }).toBe(false);
      soft((await progressOf(page, "fig"))?.stage, "the seat rests").toBe("resting");
      soft((await progressOf(page, "fig"))?.by, "closed by the operator").toBe("operator");
      await sleep(3_000);
      soft(await inputOf(sandbox, "fig", 1), "nothing was typed into it").toBe(before);
      // One Esc closes the menu. The same press may also clear the selection: either way the menu must be gone.
      await page.keyboard.press("Escape");
      await soft(seatMenu, "one Esc closes the menu after Offboard now").toHaveCount(0, { timeout: 5_000 });
      note(testInfo, "F2-selection-after-esc", JSON.stringify(await selectedIds(page)));
      await shot(page, "F2", "after-esc");
      await closeMenu(page);
    });

    await step("F2b", "the same without any offboard: right-click a SELECTED seat, press no row, press Esc once: the menu closes", async () => {
      // Wil: idle, selected, and untouched so far.
      expect(await seatState(page, "wil"), "Wil is idle").toBe("idle");
      await openSeatMenu("wil");
      await expectSelection(page, ["wil"]);
      await shot(page, "F2b", "menu-open-on-a-selected-seat");
      await page.keyboard.press("Escape");
      await soft(seatMenu, "one Esc closes the menu").toHaveCount(0, { timeout: 5_000 });
      note(testInfo, "F2b-selection-after-esc", JSON.stringify(await selectedIds(page)));
      await shot(page, "F2b", "after-esc");
      await closeMenu(page);
    });

    await step("F3", "right-click a working seat: OFFBOARD NOW greyed, this agent is working; on a dialog: this agent is waiting on you", async () => {
      await wil.control({ screen: { mode: "working" } });
      await expectSeatState(page, "wil", "working");
      await openSeatMenu("wil");
      await soft(menuNow(page).locator("small"), "the grey line of a working seat").toHaveText("this agent is working", { timeout: 10_000 });
      await soft(menuNow(page), "OFFBOARD NOW cannot be pressed").toBeDisabled();
      await soft(menuAsk(page), "ASK TO OFFBOARD is pressable").toBeEnabled();
      await shot(page, "F3", "working-seat-greyed");
      await closeMenu(page);
      await wil.control({ screen: { mode: "attention" } });
      await soft.poll(() => seatState(page, "wil"), { message: "the seat on a dialog reads attention", timeout: 30_000 }).toBe("attention");
      await openSeatMenu("wil");
      await soft(menuNow(page).locator("small"), "the grey line of a seat on a dialog").toHaveText("this agent is waiting on you", { timeout: 10_000 });
      await soft(menuNow(page), "OFFBOARD NOW cannot be pressed").toBeDisabled();
      await shot(page, "F3", "seat-on-a-dialog-greyed");
      await closeMenu(page);
    });
  });
});

// ===========================================================================
// WG: re-seating an agent keeps its name (main f4286e6c8 or later)
// ===========================================================================

/** The harness the seats are re-seated to: a no-op binary planted by launchJunto's seedHarnessInstalls (harness/agent-harness-fixture.ts:22-45). */
const RESEAT_TO: HarnessId = "grok";

test("WG [fake-tui] re-seat keeps the name: a renamed seat and a never renamed one both read as before, with the new harness under them", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const CID = seatNode("cid", "Cid", COLUMN[0], ROW[0], false);
  // Never renamed: its card reads the name it was created with, here the walk's own example.
  const DEF = seatNode("def", "Codex", COLUMN[1], ROW[0], false);
  await walk(testInfo, "WG", { doc: fixtureOf([CID, DEF]), harnessInstalls: [RESEAT_TO] }, async ({ junto, sandbox, shot, step, mark }) => {
    const { page } = junto;
    const target = templateFor(RESEAT_TO).displayName;
    /** rts/KindSurface.tsx:84-90: the bar's identity, the name and the harness under it. */
    const barName = page.locator(".rts-kind-id__name");
    const barHarness = page.locator(".rts-kind-id__live");
    const nodeOf = (nodeId: string) => readModelSeat(page, CANVAS, nodeId);
    const cardText = async (nodeId: string): Promise<string> => ((await card(page, nodeId).textContent().catch(() => "")) ?? "").replace(/\s+/gu, " ").trim();

    /** Step 2's gesture: the key, the list, the pick, the confirm when it asks. */
    const reseat = async (nodeId: string, label: string): Promise<void> => {
      await select(page, [nodeId]);
      // rts/AgentReseatControl.tsx:80-82 (the key), :95-109 (the popover); reseat-layers.spec.ts:16-18.
      const key = page.getByRole("button", { name: "Re-seat agent" });
      await expect(key).toBeVisible({ timeout: 10_000 });
      await expectTip(page, key, "Swap harness (stops current process, starts new seat)", `${label}: the tip on the re-seat key`);
      await key.click();
      const pop = page.locator('[data-layer="popover"].agent-reseat-pop');
      await expect(pop).toBeVisible({ timeout: 10_000 });
      // node-palette/AgentHarnessPick.tsx:332 (a row's name), :423 (a click picks the bare harness).
      const row = pop.getByRole("button", { name: target, exact: true });
      await expect(row, `${label}: the list offers ${target}`).toBeVisible({ timeout: 30_000 });
      note(testInfo, `${label}-harnesses-offered`, JSON.stringify(await pop.locator(".agent-harness-pick__item").evaluateAll((rows) => rows.map((item) => item.getAttribute("aria-label") ?? ""))));
      await shot(page, label, "reseat-list");
      await row.click();
      // rts/ReseatConfirmDialog.tsx:23-24: asked unless "Do not show again" was ticked before.
      const confirm = page.locator('[data-layer="working-dialog"]').getByRole("button", { name: "Stop and re-seat" });
      const asked = await confirm.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
      if (asked) {
        await shot(page, label, "reseat-confirm");
        await confirm.click();
      } else {
        note(testInfo, `${label}-confirm`, "no confirm dialog was shown");
      }
      mark(`${label}: re-seated ${nodeId} to ${RESEAT_TO}`);
      await expect
        .poll(async () => (await nodeOf(nodeId))?.harness, { message: `${nodeId}: the harness on its node`, timeout: 30_000 })
        .toBe(RESEAT_TO);
    };

    await step("G0", "setup: two fake seats started and idle; the sandbox lists a second harness as installed", async () => {
      await crewPlayFactory(page);
      await startSeat(page, sandbox, CID);
      await startSeat(page, sandbox, DEF);
      await shot(page, "G0", "two-seats");
    });

    await step("G1", "rename the first seat's card to cli-identity, with the pencil key in the bottom bar", async () => {
      await select(page, ["cid"]);
      // rts-controls.spec.ts:119-126; the field is nodes/TextNode.tsx:348.
      await page.locator(".rts-kind-surface .rts-kind-strip").getByRole("button", { name: "Rename" }).click();
      const field = page.getByRole("textbox", { name: "Rename agent node" });
      await expect(field).toBeVisible({ timeout: 10_000 });
      await field.fill("cli-identity");
      await field.press("Enter");
      await expect(field).toBeHidden({ timeout: 10_000 });
      await expect(card(page, "cid"), "the card reads the new name").toContainText("cli-identity", { timeout: 10_000 });
      note(testInfo, "G1-node-after-rename", JSON.stringify({ label: (await nodeOf("cid"))?.label }));
      await shot(page, "G1", "renamed-to-cli-identity");
    });

    await step("G2", "re-seat it to another harness: the card, the bar and the terminal still say cli-identity, with the new harness under it", async () => {
      await reseat("cid", "G2");
      const text = await cardText("cid");
      note(testInfo, "G2-card-text", text);
      note(testInfo, "G2-node-after-reseat", JSON.stringify(await nodeOf("cid")));
      await soft(card(page, "cid"), "the card still reads cli-identity").toContainText("cli-identity");
      soft(text, "the card does not read the harness name").not.toMatch(new RegExp(`^${target}\\b`, "u"));
      soft(text.includes(`${target} - `), "the card does not read <Harness> - <model>").toBe(false);
      await select(page, ["cid"]);
      await soft(barName, "the bar's identity").toHaveText("cli-identity");
      await soft(barHarness, "the new harness under it").toHaveText(RESEAT_TO);
      await shot(page, "G2", "card-and-bar-after-reseat");
      // The terminal: its title (terminal/TerminalSurface.tsx:2071) and what runs in it.
      await card(page, "cid").dblclick();
      const surface = page.locator(TERMINAL_SURFACE);
      await soft(surface, "the seat's terminal opens").toBeVisible({ timeout: 30_000 });
      if (await surface.isVisible().catch(() => false)) {
        await soft(surface.getByTestId("terminal-header-name").first(), "the terminal's title").toContainText("cli-identity", { timeout: 10_000 });
        note(testInfo, "G2-terminal-title", ((await surface.getByTestId("terminal-header-name").first().textContent().catch(() => "")) ?? "").trim());
        note(testInfo, "G2-terminal-header", ((await surface.locator("header").first().textContent().catch(() => "")) ?? "").replace(/\s+/gu, " ").trim());
        // What the terminal shows, read from the test registry (seat-session-checklist.spec.ts:282-288). The planted
        // harness is a no-op that exits at once, so an exit notice here is expected.
        const screen = await page
          .evaluate(() => {
            const registry = (window as unknown as { __juntoTermScreenText?: Map<string, () => string> }).__juntoTermScreenText;
            return registry ? [...registry.values()].map((read) => read()).join("\n---\n") : "no screen registry";
          })
          .catch((error: unknown) => `unreadable: ${String(error)}`);
        note(testInfo, "G2-terminal-screen", screen.slice(0, 1_500));
        const session = (await page.evaluate((id) => window.junto!.terminalGet(id), (await nodeOf("cid"))?.bindingId ?? "").catch(() => undefined)) as
          | { readonly status?: string; readonly harness?: string; readonly label?: string }
          | undefined;
        note(testInfo, "G2-terminal-session", JSON.stringify(session ?? null));
        soft(session?.harness ?? RESEAT_TO, "the terminal runs the new harness").toBe(RESEAT_TO);
        await shot(page, "G2", "terminal-titled-cli-identity");
        await surface.getByRole("button", { name: "Close view" }).first().click().catch(() => undefined);
        await soft(page.locator(TERMINAL_SURFACE), "the terminal view closes").toHaveCount(0, { timeout: 10_000 });
      }
    });

    await step("G3", "a seat that was never renamed, re-seated: its card still reads the name it had", async () => {
      const nameBefore = (await nodeOf("def"))?.label ?? "";
      const textBefore = await cardText("def");
      await reseat("def", "G3");
      const textAfter = await cardText("def");
      note(testInfo, "G3-card-text", JSON.stringify({ before: textBefore, after: textAfter }));
      note(testInfo, "G3-node-after-reseat", JSON.stringify(await nodeOf("def")));
      soft(nameBefore, "the name it was created with").toBe("Codex");
      await soft(card(page, "def"), "the card still reads the name it had").toContainText("Codex");
      soft(textAfter, "the card does not take the new harness's name").not.toContain(target);
      soft((await nodeOf("def"))?.label, "the seat's own label is unchanged").toBe(nameBefore);
      await select(page, ["def"]);
      await soft(barName, "the bar's identity").toHaveText("Codex");
      await soft(barHarness, "the new harness under it").toHaveText(RESEAT_TO);
      await shot(page, "G3", "never-renamed-seat-after-reseat");
    });
  });
});

// ===========================================================================
// Quit and reopen on the same sandbox (used by S5r-6 and S5r-7)
// ===========================================================================

/**
 * Quit the app, as region-environment-walk.spec.ts does before its relaunch
 * (lines 985-998), and hand back the environment it ran with.
 */
const quitApp = async (junto: JuntoHandle): Promise<Record<string, string>> => {
  const env = await junto.app.evaluate(() => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") out[key] = value;
    return out;
  });
  const child = junto.app.process();
  const gone = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });
  await junto.app.close();
  await gone;
  return env;
};

/**
 * A second Electron on the same sandbox, with the arguments launch.ts passes
 * (region-environment-walk.spec.ts:999-1004).
 *
 * And with the quit gate answered. Junto asks before quitting over live work,
 * in a native dialog; launch.ts answers it for the app it starts
 * (harness/launch.ts:597-605) and seat-offboard-surfaces.spec.ts does the same
 * for the app it relaunches (lines 2079-2082). Without this a reopened app
 * with a seat mid-turn never quits: its close() waits on a question in a
 * hidden window. That is what hung S5r-6, whose reopened app had just typed
 * the wake mail into a seat; S5r-7's reopened app runs no seat, so it quit.
 */
const reopenApp = async (junto: JuntoHandle, env: Record<string, string>): Promise<ElectronApplication> => {
  const app = await electron.launch({
    executablePath: createRequire(import.meta.url)("electron") as string,
    args: [process.cwd(), `--user-data-dir=${junto.sandbox.userDataDir}`, "--mute-audio"],
    env,
    timeout: 60_000,
  });
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
  });
  return app;
};


// ===========================================================================
// S6 [slow-rules]: auto offboard as mail arrives at a running, idle seat
// (main 85982a0d4 or later)
// ===========================================================================
//
// The rule, at main b674fe353. Mail about to be typed into a seat asks first
// (work/message-delivery.ts:323-333, wired at ipc.ts:2501-2504), and
// cutIfCold (seat-sessions/operator-offboard.ts:532-557) ends the session
// only when ALL of these hold: the seat names a session (:535), it is running
// and idle (:536), its canvas is not paused (:538), the operator did not just
// ask it to offboard (:541, ten minutes at :326), auto offboard is on (:543),
// it has sat still for the auto interval (:545), and its session is worth
// cutting (:549). The 5 minute warm-up is NOT on this path: it guards only
// the idle nudge's pass (:586), so these tests wait for stillness alone.
//
// "Worth cutting" (shared/seat-offboard.ts:371-377): the session worked at
// all, and either worked for the threshold's minutes or its transcript holds
// the threshold's tokens. Work is the time the seat's state read `working`,
// summed by the clock (operator-offboard.ts:201-217) from the seat-state
// events (operator-offboard-live.ts:284-286). So "works for over a minute"
// is made true like this: the seat is given a real turn by mail from a peer,
// the fake then shows its working screen and prints a line every few seconds
// (a turn in progress), and the test goes on only once main's own status
// answers workMinutes >= 1 and worthCutting for that seat. The threshold is
// set to its lowest value, 1 minute (worth.workMinutes, :72 and :30).

/** Walk 6's settings: cache window 2, idle nudge off, auto offboard on at 2, work threshold 1 minute. */
const S6_RULES = {
  cacheWindowMinutes: 2,
  nudge: { enabled: false, minutes: 1 },
  auto: { enabled: true, minutes: 2 },
  worth: { workMinutes: 1 },
} as unknown as OffboardRulesPatch;

type WorkStatus = SeatOffboardStatus & { readonly workMinutes?: number; readonly worthCutting?: boolean };

const workStatusOf = async (page: Page, nodeId: string): Promise<WorkStatus | undefined> =>
  (await statusOf(page, [nodeId]))[0] as WorkStatus | undefined;

/** Start a real turn on each seat: mail from the peer, which the fake submits and starts working on. */
const startTurns = async (page: Page, sandbox: Sandbox, peer: CrewSeat, nodeIds: ReadonlyArray<string>): Promise<void> => {
  for (const id of nodeIds) {
    const text = `start a turn, ${id}: wire the parser`;
    opData(await peer.op("msg.send", { target: id, text }));
    await expect.poll(() => inputOf(sandbox, id, 1), { message: `${id}: the mail that starts its turn`, timeout: 60_000 }).toContain(text);
    await expectSeatState(page, id, "working");
  }
};

/** Keep the seats' turns visibly in progress until main says each has worked a minute and is worth cutting. */
const workOverAMinute = async (
  ctx: Walk,
  testInfo: TestInfo,
  seats: Readonly<Record<string, CrewSeat>>,
  nodeIds: ReadonlyArray<string>,
  label: string,
): Promise<void> => {
  const from = ctx.mark(`${label}: ${nodeIds.join(", ")} working; waiting for a minute of work by main's clock`);
  let line = 0;
  await expect
    .poll(
      async () => {
        line += 1;
        for (const id of nodeIds) await seats[id]!.print(`working: step ${String(line)}`);
        const all = await Promise.all(nodeIds.map((id) => workStatusOf(ctx.junto.page, id)));
        const states = await Promise.all(nodeIds.map((id) => seatState(ctx.junto.page, id)));
        return answerOf(
          ctx.junto.page,
          all.every((status) => (status?.workMinutes ?? 0) >= 1 && status?.worthCutting === true),
          `workMinutes >= 1 and worthCutting for each of ${nodeIds.join(", ")} (seat states now: ${states.join(", ")})`,
          all,
        );
      },
      { message: `${nodeIds.join(", ")}: a minute of work and worth cutting, by main's own answer`, timeout: 180_000, intervals: [8_000] },
    )
    .toBe(AS_WAITED_FOR);
  note(testInfo, `${label}-worked-ms-by-the-test-clock`, String(ctx.mark(`${label}: over a minute of work`) - from));
  for (const id of nodeIds) note(testInfo, `${label}-status-${id}-after-work`, JSON.stringify(await workStatusOf(ctx.junto.page, id)));
};

/**
 * For the record only: receipt rows with deliveredAt on the seat's WHOLE mailbox. One row per message, so this
 * says nothing about how many times any one mail was typed; that is judged by `expectDeliveredOnce`.
 */
const deliveryOf = async (page: Page, nodeId: string): Promise<string> => {
  const rows = await crewReceipts(page, CANVAS, nodeId).catch(() => []);
  return `${String(rows.filter((row) => row.deliveredAt !== undefined).length)} message(s) with a delivered receipt on ${nodeId}'s whole mailbox (one row per message)`;
};

/** The id of the mail in a seat's mailbox that carries this text, read off the canvas the app projects. */
const messageIdByText = async (page: Page, nodeId: string, text: string): Promise<string | undefined> =>
  (await readSeatMailbox(page, CANVAS, nodeId)).find((message) =>
    message.parts.some((part) => part.kind === "text" && part.text.includes(text)),
  )?.messageId;

/**
 * "Delivered exactly once", judged on the mail itself:
 *   its OWN receipt row carries deliveredAt (the row is found by the message id kept from the send);
 *   its text is on the input of the session it should reach exactly once;
 *   and not at all on the input of the session it should not reach.
 * A seat's input is one file per process: the wrapper in front of the fake moves stdin.log aside at every launch
 * (installSeatHarness), so generation N is `inputOf(sandbox, seat, N)`.
 */
const expectDeliveredOnce = async (
  ctx: Walk,
  testInfo: TestInfo,
  page: Page,
  input: {
    readonly nodeId: string;
    readonly mail: string;
    /** From the send's own answer; looked up by the mail's text when the send did not hand one back. */
    readonly messageId?: string;
    /** The generation that should have been typed the mail. */
    readonly into: number;
    /** The generation that must not have been. */
    readonly notInto?: number;
    readonly label: string;
  },
): Promise<void> => {
  const { nodeId, mail, into, notInto, label } = input;
  const messageId = input.messageId || (await messageIdByText(page, nodeId, mail));
  soft(messageId, `${nodeId}: the mail's message id is known`).toBeTruthy();
  const ownRow = async () => (await crewReceipts(page, CANVAS, nodeId).catch(() => [])).find((row) => row.messageId === messageId);
  await soft
    .poll(async () => (await ownRow())?.deliveredAt !== undefined, { message: `${nodeId}: the mail's own receipt carries deliveredAt`, timeout: 30_000 })
    .toBe(true);
  const typed = occurrences(await inputOf(ctx.sandbox, nodeId, into), mail);
  soft(typed, `${nodeId}: the mail's text on the input of generation ${String(into)} (the session it should reach)`).toBe(1);
  let elsewhere: number | undefined;
  if (notInto !== undefined) {
    elsewhere = occurrences(await inputOf(ctx.sandbox, nodeId, notInto), mail);
    soft(elsewhere, `${nodeId}: the mail's text on the input of generation ${String(notInto)} (the old session)`).toBe(0);
  }
  note(
    testInfo,
    `${label}-delivered-once-${nodeId}`,
    `message ${String(messageId)}; own receipt ${JSON.stringify((await ownRow()) ?? null)}; typed ${String(typed)} time(s) into generation ${String(into)}${
      elsewhere === undefined ? "" : `, ${String(elsewhere)} into generation ${String(notInto)}`
    }`,
  );
};

/** The pass of every counter-case: nothing is cut. */
const expectNotCut = async (ctx: Walk, nodeId: string, pid: number): Promise<void> => {
  const { page } = ctx.junto;
  soft(await progressOf(page, nodeId), `${nodeId}: no offboard on record`).toBeUndefined();
  soft(await launches(ctx.sandbox, nodeId), `${nodeId}: still its first process`).toBe(1);
  soft(pidAlive(pid), `${nodeId}: that process is running`).toBe(true);
  soft(await nodeSessionId(page, nodeId), `${nodeId}: it still names its session`).toBe(sessionIdOf(nodeId));
};

test("S6a [slow-rules] [fake-tui] mail to a running seat idle past the interval: the session is cut first and the mail arrives in the fresh one, once", async ({}, testInfo) => {
  // Expected wall time: about 5 minutes (a minute of work, 2 to 3 minutes still, then the mail).
  test.setTimeout(11 * 60_000);
  const HAL = seatNode("hal", "Hal", COLUMN[0], ROW[0]);
  const PAT = seatNode("pat", "Pat", COLUMN[1], ROW[0], false);
  const doc = fixtureOf([HAL, PAT], [["pat", "hal"]]);
  await walk(testInfo, "S6a", { doc, transcripts: [sessionIdOf("hal")] }, async (ctx) => {
    const { junto, sandbox, shot, step, mark, offboardLines } = ctx;
    const { page } = junto;
    let hal!: CrewSeat;
    let pat!: CrewSeat;
    let pid = 0;
    let before = "";

    await step("S6-1", "settings as walk 5.3 with the work threshold at 1 minute; H works for over a minute, then sits idle, running, past the interval", async () => {
      const rules = await setRules(page, S6_RULES);
      expect(rules, "the rules in force").toMatchObject({ cacheWindowMinutes: 2, auto: { enabled: true, minutes: 2 }, worth: { workMinutes: 1 } });
      await crewPlayFactory(page);
      hal = await startSeat(page, sandbox, HAL);
      pat = await startSeat(page, sandbox, PAT);
      pid = (await hal.ready()).pid;
      await startTurns(page, sandbox, pat, ["hal"]);
      await workOverAMinute(ctx, testInfo, { hal }, ["hal"], "S6-1");
      await hal.control({ screen: { mode: "idle" } });
      await expectSeatState(page, "hal", "idle");
      await shot(page, "S6-1", "h-idle-after-a-minute-of-work");
      // The walk says 3 minutes; the rule needs 2 whole ones. Main's own answer ends the wait.
      await waitPastWindow(ctx, testInfo, ["hal"], "S6-1");
      before = await inputOf(sandbox, "hal", 1);
      expect(pidAlive(pid), "H's agent is still running").toBe(true);
      expect(await seatState(page, "hal"), "and idle").toBe("idle");
      await keepClock(ctx, "S6a", "before-the-mail");
      await shot(page, "S6-1", "h-idle-past-the-interval");
    });

    await step("S6-2", "send H a mail: not typed into the old session; closed automatically, without notes; the mail arrives in the fresh session, once", async () => {
      const text = "S6 mail: retry the nightly sync";
      const sent = opData(await pat.op("msg.send", { target: "hal", text }));
      const sentAt = mark(`mail sent to H: ${JSON.stringify(sent)}`);
      await expect.poll(() => launches(sandbox, "hal"), { message: "a fresh process starts for the mail", timeout: 90_000 }).toBe(2);
      await expect.poll(async () => (await hal.ready()).pid, { message: "the fresh process's pid", timeout: 30_000 }).not.toBe(pid);
      await soft.poll(() => inputOf(sandbox, "hal", 2), { message: "the mail on the fresh session's input", timeout: 60_000 }).toContain(text);
      note(testInfo, "S6-2-mail-to-fresh-session-ms", String(mark("the mail reached the fresh session, or 60 s passed") - sentAt));
      await shot(page, "S6-2", "h-cut-and-woken-by-the-mail");
      await sleep(5_000);
      await expectDeliveredOnce(ctx, testInfo, page, { nodeId: "hal", mail: text, messageId: String(sent.messageId ?? ""), into: 2, notInto: 1, label: "S6-2" });
      soft(await inputOf(sandbox, "hal", 1), "nothing at all was typed into the old session").toBe(before);
      const progress = await progressOf(page, "hal");
      note(testInfo, "S6-2-progress", JSON.stringify(progress ?? null));
      soft(progress?.by, "H's line: closed automatically").toBe("automatic");
      soft(progress?.notes, "without notes").toBe(false);
      await soft.poll(() => pidAlive(pid), { message: "the old process is still alive (it winds down by itself)", timeout: 20_000 }).toBe(false);
      soft(await nodeSessionId(page, "hal"), "H no longer names the old session (a Codex id is cleared, not replaced)").not.toBe(sessionIdOf("hal"));
      const lines = offboardLines().join("\n");
      soft(lines, "main's line for the close (offboard-close.ts)").toContain("hal offboarded; its session closed and the seat rests");
      soft(lines, "no [offboard] line says failed or did not go through").not.toMatch(/failed|did not go through/u);
      const onboard = opData(await hal.op("onboard", {}));
      note(testInfo, "S6-2-onboard-payload", JSON.stringify(onboard));
      const without = onboard.previous_session_without_notes as { readonly session_id?: unknown; readonly ended_by?: unknown } | undefined;
      soft(without?.session_id, "junto onboard in the fresh session: the old session id").toBe(sessionIdOf("hal"));
      soft(without?.ended_by, "ended_by").toBe("automatic");
      soft(onboard.handoff, "no handoff block").toBeUndefined();
      await keepClock(ctx, "S6a", "after-the-mail");
    });
  });
});

test("S6b [slow-rules] [fake-tui] counter-cases on a playing canvas: mid-turn, a dialog up, idle only 1 minute, under the work threshold: nothing is cut and the mail goes to the same session (for the dialog seat, once its dialog is answered)", async ({}, testInfo) => {
  // Expected wall time: about 6 minutes (four seats brought to their states in one app, mailed at the end).
  test.setTimeout(12 * 60_000);
  const MID = seatNode("mid", "Mid", COLUMN[0], ROW[0]);
  const DIA = seatNode("dia", "Dia", COLUMN[1], ROW[0]);
  const ONE = seatNode("one", "One", COLUMN[2], ROW[0]);
  const LOW = seatNode("low", "Low", COLUMN[0], ROW[1]);
  const PAT = seatNode("pat", "Pat", COLUMN[1], ROW[1], false);
  const IDS = ["mid", "dia", "one", "low"] as const;
  const doc = fixtureOf([MID, DIA, ONE, LOW, PAT], IDS.map((id) => ["pat", id] as const));
  await walk(testInfo, "S6b", { doc }, async (ctx) => {
    const { junto, sandbox, shot, step, mark, offboardLines } = ctx;
    const { page } = junto;
    const seats: Record<string, CrewSeat> = {};
    const pids: Record<string, number> = {};
    let pat!: CrewSeat;
    let diaMail = "";
    let diaMessageId = "";
    let diaTypedWhileDialogUp = false;
    let diaDeliveryWhileDialogUp = "";

    await step("S6-3a", "four seats, each brought to its own state: mid-turn, a dialog up, idle 1 minute, under a minute of work", async () => {
      await setRules(page, S6_RULES);
      await crewPlayFactory(page);
      pat = await startSeat(page, sandbox, PAT);
      for (const node of [MID, DIA, ONE, LOW]) {
        seats[node.id] = await startSeat(page, sandbox, node);
        pids[node.id] = (await seats[node.id]!.ready()).pid;
      }
      await startTurns(page, sandbox, pat, IDS);
      // Low: a short turn, well under a minute, then idle for the whole wait.
      await sleep(15_000);
      await seats.low!.control({ screen: { mode: "idle" } });
      await expectSeatState(page, "low", "idle");
      mark("Low is idle after a short turn");
      // The other three work for over a minute.
      await workOverAMinute(ctx, testInfo, seats, ["mid", "dia", "one"], "S6-3a");
      // Dia: a dialog up, for longer than the interval.
      await seats.dia!.control({ screen: { mode: "attention" } });
      await soft.poll(() => seatState(page, "dia"), { message: "Dia, on a dialog, reads attention", timeout: 30_000 }).toBe("attention");
      const dialogAt = mark("Dia has a dialog up");
      // One: goes idle a minute later, so that it has sat idle only 1 minute when mailed. Mid keeps working throughout.
      let line = 0;
      while (Date.now() < dialogAt + 60_000) {
        line += 1;
        await seats.mid!.print(`still working: step ${String(line)}`);
        await seats.one!.print(`still working: step ${String(line)}`);
        await sleep(8_000);
      }
      await seats.one!.control({ screen: { mode: "idle" } });
      await expectSeatState(page, "one", "idle");
      mark("One is idle");
      await expect
        .poll(
          async () => {
            line += 1;
            await seats.mid!.print(`still working: step ${String(line)}`);
            const low = await workStatusOf(page, "low");
            const one = await workStatusOf(page, "one");
            const dialogFor = Date.now() - dialogAt;
            return answerOf(
              page,
              (low?.idleMinutes ?? 0) >= 2 && one?.idleMinutes === 1 && dialogFor >= 125_000,
              `Low idleMinutes >= 2, One idleMinutes exactly 1, Dia on its dialog 125 s (now ${String(Math.round(dialogFor / 1000))} s)`,
              { low, one },
            );
          },
          { message: "Low idle 2 minutes, One idle exactly 1, Dia on its dialog over 2 minutes, by main's own answer", timeout: 240_000, intervals: [5_000] },
        )
        .toBe(AS_WAITED_FOR);
      for (const id of IDS) note(testInfo, `S6-3-status-${id}-before-the-mail`, `${await seatState(page, id)} ${JSON.stringify(await workStatusOf(page, id))}`);
      soft((await workStatusOf(page, "low"))?.workMinutes, "Low did under a minute of work").toBe(0);
      soft(await seatState(page, "mid"), "Mid is mid-turn").toBe("working");
      await keepClock(ctx, "S6b", "before-the-mails");
      await shot(page, "S6-3", "four-seats-in-their-states");
    });

    await step("S6-3", "mail each: nothing is cut, and the mail is typed into the same session", async () => {
      const mails: Record<string, string> = {};
      const sent: Record<string, Record<string, unknown>> = {};
      for (const id of ["mid", "dia", "one"]) {
        mails[id] = `S6 counter-case mail for ${id}`;
        sent[id] = opData(await pat.op("msg.send", { target: id, text: mails[id] }));
        mark(`mail sent to ${id}: ${JSON.stringify(sent[id])}`);
      }
      // Low is mailed with the threshold back at 30, as the walk says: its short turn is under either.
      const rules = await setRules(page, { worth: { workMinutes: 30 } } as unknown as OffboardRulesPatch);
      note(testInfo, "S6-3-rules-for-low", JSON.stringify(rules));
      mails.low = "S6 counter-case mail for low";
      mark(`mail sent to low: ${JSON.stringify(opData(await pat.op("msg.send", { target: "low", text: mails.low })))}`);
      // Dia has a dialog up: its mail is HELD, by rule. Mail is typed only into an available input box; while a
      // dialog is up it waits, in order, is retried every minute, and the wait is told on the seat every minute
      // (work/message-delivery.ts:21-27; the same gate holds the onboarding nudge, term/intervention/policy.ts:151).
      for (const id of IDS.filter((seat) => seat !== "dia")) {
        await soft
          .poll(() => inputOf(sandbox, id, 1), { message: `${id}: the mail is typed into the session that is there`, timeout: 60_000 })
          .toContain(mails[id]!);
      }
      await sleep(5_000);
      for (const id of IDS) {
        await expectNotCut(ctx, id, pids[id]!);
        soft(occurrences(await inputOf(sandbox, id, 1), mails[id]!), `${id}: the mail was typed at most once`).toBeLessThanOrEqual(1);
        if (id !== "dia") note(testInfo, `S6-3-delivery-${id}`, await deliveryOf(page, id));
      }
      diaMail = mails.dia!;
      diaMessageId = String(sent.dia?.messageId ?? "");
      // Judged: nothing typed while the dialog is up, and the sender is told waiting, not delivered.
      diaTypedWhileDialogUp = (await inputOf(sandbox, "dia", 1)).includes(diaMail);
      soft(diaTypedWhileDialogUp, "dia: nothing is typed while the dialog is up").toBe(false);
      soft(sent.dia?.delivery, "dia: the sender's answer says waiting (work/message-delivery.ts:61)").toBe("waiting");
      const diaReceipt = (await crewReceipts(page, CANVAS, "dia").catch(() => [])).find((row) => row.messageId === diaMessageId);
      soft(diaReceipt?.deliveredAt, "dia: no delivered receipt while the dialog is up").toBeUndefined();
      diaDeliveryWhileDialogUp = `msg.send answered delivery=${JSON.stringify(sent.dia?.delivery)}; receipt ${JSON.stringify(diaReceipt ?? null)}`;
      soft(await seatState(page, "dia"), "dia: the dialog is still up").toBe("attention");
      // The held notice on the seat: the amber bubble (lib/preamble-sources.ts:207-210, 230-238; shown for 12 s,
      // :47, and told again every minute for a dialog), as seat-session-checklist.spec.ts:538-541 reads the draft one.
      const held = page.locator('[data-testid="node-preamble"][data-node-id="dia"]').filter({ hasText: "waits: this seat is showing a dialog" }).first();
      await soft(held, "dia: the held notice on the seat").toContainText(/mail from Pat waits: this seat is showing a dialog/u, { timeout: 80_000 });
      await soft(held, "dia: it is the mail-held notice").toHaveAttribute("data-action", "mail-held", { timeout: 5_000 });
      await shot(page, "S6-3", "dialog-seat-mail-held-notice");
      soft(offboardLines().filter((line) => /offboarded;|auto offboard/u.test(line)), "no [offboard] line speaks of a close").toEqual([]);
      await keepClock(ctx, "S6b", "after-the-mails");
      await shot(page, "S6-3", "four-seats-mailed-none-cut");
    });

    await step("S6-3d", "the seat with a dialog up: once the dialog is answered, the held mail arrives in the SAME session, exactly once, within about a minute", async () => {
      soft((await inputOf(sandbox, "dia", 1)).includes(diaMail), "dia: still nothing typed just before the dialog is answered").toBe(false);
      // Answering the dialog: the fake goes back to its idle prompt.
      await seats.dia!.control({ screen: { mode: "idle" } });
      const answeredAt = mark("Dia's dialog is answered");
      await soft.poll(() => seatState(page, "dia"), { message: "Dia, its dialog answered, reads idle", timeout: 30_000 }).toBe("idle");
      // Written when the box is available again, or at the retry that runs every minute (message-delivery.ts:24-25).
      await soft
        .poll(() => inputOf(sandbox, "dia", 1), { message: "dia: the held mail is typed once the dialog is answered", timeout: 90_000, intervals: [1_000] })
        .toContain(diaMail);
      const arrivedMs = mark("Dia's held mail arrived, or 90 s passed") - answeredAt;
      await sleep(5_000);
      const typed = occurrences(await inputOf(sandbox, "dia", 1), diaMail);
      soft(typed, "dia: the mail was typed exactly once").toBe(1);
      await expectNotCut(ctx, "dia", pids.dia!);
      await soft
        .poll(async () => (await crewReceipts(page, CANVAS, "dia").catch(() => [])).find((row) => row.messageId === diaMessageId)?.deliveredAt !== undefined, {
          message: "dia: the receipt says delivered once the mail is typed",
          timeout: 30_000,
        })
        .toBe(true);
      note(
        testInfo,
        "S6-3-dialog-seat-mail",
        `while the dialog was up: typed ${String(diaTypedWhileDialogUp)}, ${diaDeliveryWhileDialogUp}; after the dialog was answered: arrived after ${String(arrivedMs)} ms, typed ${String(typed)} time(s), receipt ${JSON.stringify((await crewReceipts(page, CANVAS, "dia").catch(() => [])).find((row) => row.messageId === diaMessageId) ?? null)}, seat state ${await seatState(page, "dia")}`,
      );
      await shot(page, "S6-3d", "dialog-answered-mail-typed");
    });
  });
});

test("S6b-paused [slow-rules] [fake-tui] counter-case on a paused canvas: a seat that would be cut is left alone", async ({}, testInfo) => {
  // Expected wall time: about 5 minutes.
  test.setTimeout(11 * 60_000);
  const PIA = seatNode("pia", "Pia", COLUMN[0], ROW[0]);
  const PAT = seatNode("pat", "Pat", COLUMN[1], ROW[0], false);
  const doc = fixtureOf([PIA, PAT], [["pat", "pia"]]);
  await walk(testInfo, "S6b-paused", { doc }, async (ctx) => {
    const { junto, sandbox, shot, step, mark, offboardLines } = ctx;
    const { page } = junto;
    let pid = 0;

    await step("S6-3p", "a seat that worked over a minute and sat idle past the interval, on a canvas paused meanwhile, is mailed: nothing is cut", async () => {
      await setRules(page, S6_RULES);
      await crewPlayFactory(page);
      const pia = await startSeat(page, sandbox, PIA);
      const pat = await startSeat(page, sandbox, PAT);
      pid = (await pia.ready()).pid;
      await startTurns(page, sandbox, pat, ["pia"]);
      await workOverAMinute(ctx, testInfo, { pia }, ["pia"], "S6-3p");
      await pia.control({ screen: { mode: "idle" } });
      await expectSeatState(page, "pia", "idle");
      // Pause the canvas (TopBar.tsx:191-192).
      const pause = page.getByTestId("factory-pause");
      await pause.click();
      await expect(pause).toHaveAttribute("data-pause-state", "paused", { timeout: 15_000 });
      mark("the canvas is paused");
      await shot(page, "S6-3p", "canvas-paused");
      await waitPastWindow(ctx, testInfo, ["pia"], "S6-3p");
      note(testInfo, "S6-3p-seat-before-the-mail", `state ${await seatState(page, "pia")}, process alive ${String(pidAlive(pid))}, ${JSON.stringify(await workStatusOf(page, "pia"))}`);
      const before = await inputOf(sandbox, "pia", 1);
      // A seat's own msg.send is refused on a paused canvas, so the mail is the operator's (preload/index.ts:886).
      const text = "S6 counter-case mail on a paused canvas";
      const sent = await page.evaluate(
        ([canvasName, bindingId, body]) => window.junto!.terminalManagedPrompt({ bindingId, text: body, canvasName, nodeId: "pia" }),
        [CANVAS, bindingOf("pia"), text] as const,
      );
      mark(`operator mail sent to Pia: ${JSON.stringify(sent)}`);
      await sleep(15_000);
      await expectNotCut(ctx, "pia", pid);
      soft(offboardLines().filter((line) => /offboarded;|auto offboard/u.test(line)), "no [offboard] line speaks of a close").toEqual([]);
      const typed = (await inputOf(sandbox, "pia", 1)).includes(text);
      note(testInfo, "S6-3p-mail", `typed into the same session within 15 s: ${String(typed)}; ${await deliveryOf(page, "pia")}; input grew by ${String((await inputOf(sandbox, "pia", 1)).length - before.length)} characters`);
      soft(typed, "the mail is typed into the same session (the walk's pass line; a paused canvas may hold it instead: see the annotation)").toBe(true);
      await shot(page, "S6-3p", "paused-seat-mailed-not-cut");
    });
  });
});

test("S6c [slow-rules] [fake-tui] Ask to offboard on a running seat idle past the interval: the prompt is typed into THAT session, and the agent offboards with notes", async ({}, testInfo) => {
  // Expected wall time: about 5 minutes.
  test.setTimeout(11 * 60_000);
  const KIT = seatNode("kit", "Kit", COLUMN[0], ROW[0]);
  const PAT = seatNode("pat", "Pat", COLUMN[1], ROW[0], false);
  const doc = fixtureOf([KIT, PAT], [["pat", "kit"]]);
  await walk(testInfo, "S6c", { doc, transcripts: [sessionIdOf("kit")] }, async (ctx) => {
    const { junto, sandbox, shot, step, mark } = ctx;
    const { page } = junto;
    let kit!: CrewSeat;
    let pid = 0;

    await step("S6-4a", "a seat that would be cut by mail: over a minute of work, idle and running past the interval", async () => {
      await setRules(page, S6_RULES);
      await crewPlayFactory(page);
      kit = await startSeat(page, sandbox, KIT);
      const pat = await startSeat(page, sandbox, PAT);
      pid = (await kit.ready()).pid;
      await startTurns(page, sandbox, pat, ["kit"]);
      await workOverAMinute(ctx, testInfo, { kit }, ["kit"], "S6-4a");
      await kit.control({ screen: { mode: "idle" } });
      await expectSeatState(page, "kit", "idle");
      await waitPastWindow(ctx, testInfo, ["kit"], "S6-4a");
    });

    await step("S6-4", "press Ask to offboard: the prompt is typed into that session, not cut first; then the agent offboards with notes", async () => {
      const panel = await openCardPanel(page, "kit", "Kit");
      await panel.getByTestId("seat-offboard-ask-continue").click();
      await soft(panel.getByTestId("seat-offboard-status"), "the green line").toHaveText(LINE_ASKED_CONTINUE, { timeout: 30_000 });
      await shot(page, "S6-4", "asked-on-a-cold-idle-seat");
      await soft.poll(() => inputOf(sandbox, "kit", 1), { message: "the ask prompt on the same session's input", timeout: 60_000 }).toContain(ASK_CONTINUE_FIRST);
      await sleep(5_000);
      soft(await launches(sandbox, "kit"), "still the first process: the session was not cut under the ask").toBe(1);
      soft(pidAlive(pid), "and it is running").toBe(true);
      soft(await nodeSessionId(page, "kit"), "the seat still names its session").toBe(sessionIdOf("kit"));
      soft((await progressOf(page, "kit"))?.stage, "its line reads asked").toBe("asked");
      soft((await progressOf(page, "kit"))?.by, "nobody closed it").toBeUndefined();
      await closePanel(page);
      // The agent does what it was asked, through the seat's own work-control op (seat-offboard.spec.ts:353-356).
      const offboarded = await kit.op("offboard", {
        notes: "# Parser wired\n\n- Why it matters: the nightly sync fails without it.",
        continuation: "next: pick up the retry on 429 in the feed importer",
      });
      mark(`the agent ran junto offboard: ${JSON.stringify(offboarded)}`);
      soft(offboarded.ok, "the agent can offboard with notes").toBe(true);
      await soft.poll(() => launches(sandbox, "kit"), { message: "a fresh session starts for the continuation", timeout: 60_000 }).toBe(2);
      // The fake's turn never ends by itself, and the old process and the fresh one read the same
      // control folder: end the turn so the detached one settles and stops (drain.ts:51, 98-103)
      // before anything is asked of "the seat", or the old process could answer.
      await kit.control({ screen: { mode: "idle" } });
      await soft.poll(() => pidAlive(pid), { message: "the asked session's process is still alive", timeout: 30_000 }).toBe(false);
      const progress = await progressOf(page, "kit");
      note(testInfo, "S6-4-progress-after-the-agent-offboarded", JSON.stringify(progress ?? null));
      soft(progress?.notes, "the close is not marked as without notes").not.toBe(false);
      const onboard = opData(await kit.op("onboard", {}));
      note(testInfo, "S6-4-onboard-payload", JSON.stringify(onboard));
      soft((onboard.handoff as { readonly from_session?: unknown } | undefined)?.from_session, "the fresh session is handed the notes of the asked one").toBe(sessionIdOf("kit"));
      soft(onboard.previous_session_without_notes, "and is not told its predecessor left none").toBeUndefined();
      await shot(page, "S6-4", "agent-offboarded-with-notes");
    });
  });
});

/** The open seat terminal (seat-session-checklist.spec.ts:68, 260-275). */
const TERMINAL_SURFACE = ".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface";

test("S6d [slow-rules] [fake-tui] typing into the seat's terminal yourself: nothing is cut, the text goes to the session that is there", async ({}, testInfo) => {
  // Expected wall time: about 5 minutes.
  test.setTimeout(11 * 60_000);
  const HAL = seatNode("hal", "Hal", COLUMN[0], ROW[0]);
  const PAT = seatNode("pat", "Pat", COLUMN[1], ROW[0], false);
  const doc = fixtureOf([HAL, PAT], [["pat", "hal"]]);
  await walk(testInfo, "S6d", { doc }, async (ctx) => {
    const { junto, sandbox, shot, step, mark, offboardLines } = ctx;
    const { page } = junto;
    let pid = 0;

    await step("S6-5a", "a seat that would be cut by mail: over a minute of work, idle and running past the interval", async () => {
      await setRules(page, S6_RULES);
      await crewPlayFactory(page);
      const hal = await startSeat(page, sandbox, HAL);
      const pat = await startSeat(page, sandbox, PAT);
      pid = (await hal.ready()).pid;
      await startTurns(page, sandbox, pat, ["hal"]);
      await workOverAMinute(ctx, testInfo, { hal }, ["hal"], "S6-5a");
      await hal.control({ screen: { mode: "idle" } });
      await expectSeatState(page, "hal", "idle");
      await waitPastWindow(ctx, testInfo, ["hal"], "S6-5a");
    });

    await step("S6-5", "open H's terminal and type into it: nothing is cut, and the text reaches that session", async () => {
      await card(page, "hal").dblclick();
      const surface = page.locator(TERMINAL_SURFACE);
      await expect(surface).toBeVisible({ timeout: 30_000 });
      await surface.locator(".xterm-screen").click();
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.closest(".native-terminal-surface") != null), { message: "the keyboard is in the terminal" })
        .toBe(true);
      // Opening the view may itself count as movement; what main says right before the keys is on record.
      note(testInfo, "S6-5-status-with-the-terminal-open-before-typing", JSON.stringify(await workStatusOf(page, "hal")));
      const typed = "typed by the operator, not mailed";
      await page.keyboard.type(typed);
      await page.keyboard.press("Enter");
      mark("the operator typed into H's terminal");
      await soft.poll(() => inputOf(sandbox, "hal", 1), { message: "the typed text on the same session's input", timeout: 30_000 }).toContain(typed);
      await shot(page, "S6-5", "typed-into-the-terminal");
      await sleep(5_000);
      await expectNotCut(ctx, "hal", pid);
      soft(offboardLines().filter((line) => /offboarded;|auto offboard/u.test(line)), "no [offboard] line speaks of a close").toEqual([]);
    });
  });
});

// ===========================================================================
// S5r [slow-rules]: walk 5 as revised. The RESTING seat, cut at its wake.
// ===========================================================================
//
// A resting seat is cut on the kernel's wake path, not at mail delivery:
// mail to a seat with no process asks for a wake (work/message-delivery.ts:316-320),
// and the wake first asks cutBeforeWake (kernel/service.ts:1314), which is
// cutIfCold with moment "wake" (seat-sessions/operator-offboard.ts:532-557):
// the seat must NOT be running (:536), and the rest is as for S6.
//
// Staging "a resting seat that worked over the threshold". The seat is given
// a real turn by mail, works until main's own status says a minute of work
// (as in S6), ends its turn, and is then stopped with the operator's own Stop,
// window.junto.terminalKill (preload/index.ts:855), the gesture
// real-harness-resume.spec.ts:385-388 uses to make a seat cold. What that
// leaves, each of which the tests assert before going on:
//   no process, which is what "resting" is to offboard
//     (operator-offboard-live.ts:103, operator-offboard.ts:344);
//   the node's session id: a stop does not touch it; only a rotation clears
//     or replaces it (seat-sessions/rotate.ts:105-115);
//   the worked time: leaving `working` adds the stretch to workMs and nothing
//     but a new session resets it (operator-offboard.ts:201-210, 225-236),
//     and it is saved with the clock (:265-277) and restored at start (:153-165).
// The fake's own exit (control.json `exit`) would also leave no process, but
// it is the agent quitting, not the operator stopping it, so it is not used.

/** Stop a seat's process as the operator's Stop does, and wait until it is gone. */
const stopSeat = async (ctx: Walk, nodeId: string, pid: number): Promise<number> => {
  await ctx.junto.page.evaluate((id) => window.junto!.terminalKill(id), bindingOf(nodeId));
  await expect.poll(() => pidAlive(pid), { message: `${nodeId}: its process after the operator's stop`, timeout: 30_000 }).toBe(false);
  return ctx.mark(`${nodeId} was stopped and rests`);
};

/**
 * Bring seats to rest with over a minute of work behind them: a real turn,
 * a minute of work by main's clock, the turn ends, the operator stops them.
 */
const restAfterWork = async (
  ctx: Walk,
  testInfo: TestInfo,
  peer: CrewSeat,
  seats: Readonly<Record<string, CrewSeat>>,
  pids: Readonly<Record<string, number>>,
  nodeIds: ReadonlyArray<string>,
  label: string,
): Promise<void> => {
  const { page } = ctx.junto;
  await startTurns(page, ctx.sandbox, peer, nodeIds);
  await workOverAMinute(ctx, testInfo, seats, nodeIds, label);
  for (const id of nodeIds) {
    await seats[id]!.control({ screen: { mode: "idle" } });
    await expectSeatState(page, id, "idle");
  }
  for (const id of nodeIds) await stopSeat(ctx, id, pids[id]!);
  for (const id of nodeIds) {
    const status = await workStatusOf(page, id);
    note(testInfo, `${label}-status-${id}-at-rest`, JSON.stringify(status));
    expect(await nodeSessionId(page, id), `${id}: the stop left its session id on the node`).toBe(sessionIdOf(id));
    expect(status?.workMinutes ?? 0, `${id}: its worked minutes survive the stop`).toBeGreaterThanOrEqual(1);
    expect(status?.worthCutting, `${id}: worth cutting, by main's own answer`).toBe(true);
    expect(status?.now.allowed, `${id}: a resting seat may be closed`).toBe(true);
  }
};

/** The [offboard] lines that speak of a session being closed. */
const closeLines = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.filter((line) => /offboarded;|auto offboard|offboard now \(/u.test(line));

/** "Nothing happens to it": still its first process's count, no offboard on record, its session id on the node. */
const expectLeftAlone = async (ctx: Walk, page: Page, nodeId: string, launchesExpected = 1): Promise<void> => {
  soft(await progressOf(page, nodeId), `${nodeId}: no offboard on record`).toBeUndefined();
  soft(await launches(ctx.sandbox, nodeId), `${nodeId}: no process was started for it`).toBe(launchesExpected);
  soft(await nodeSessionId(page, nodeId), `${nodeId}: it still names its session`).toBe(sessionIdOf(nodeId));
};

/**
 * The pass of 5.3 (and 5.5, 5.6): the old session is ended first, the seat
 * starts on a new session, the mail arrives there once, and `junto onboard`
 * there says the previous session was ended automatically, without notes.
 */
const expectCutAtWake = async (
  ctx: Walk,
  testInfo: TestInfo,
  page: Page,
  nodeId: string,
  seat: CrewSeat,
  mail: string,
  inputBefore: string,
  label: string,
  /** The wake mail's own id, from the send's answer. */
  messageId?: string,
  launchesAfter = 2,
): Promise<void> => {
  const { sandbox } = ctx;
  await expect.poll(() => launches(sandbox, nodeId), { message: `${nodeId}: a process starts for the mail`, timeout: 90_000 }).toBe(launchesAfter);
  await soft.poll(() => inputOf(sandbox, nodeId, launchesAfter), { message: `${nodeId}: the mail on the fresh session's input`, timeout: 60_000 }).toContain(mail);
  await sleep(5_000);
  await expectDeliveredOnce(ctx, testInfo, page, {
    nodeId,
    mail,
    ...(messageId ? { messageId } : {}),
    into: launchesAfter,
    notInto: launchesAfter - 1,
    label,
  });
  soft(await inputOf(sandbox, nodeId, launchesAfter - 1), `${nodeId}: nothing at all was typed into the old session`).toBe(inputBefore);
  const progress = await progressOf(page, nodeId);
  note(testInfo, `${label}-progress-${nodeId}`, JSON.stringify(progress ?? null));
  soft(progress?.by, `${nodeId}: its offboard line says closed automatically`).toBe("automatic");
  soft(progress?.notes, `${nodeId}: without notes`).toBe(false);
  soft(await nodeSessionId(page, nodeId), `${nodeId}: it no longer names the old session (a Codex id is cleared, not replaced)`).not.toBe(sessionIdOf(nodeId));
  const lines = ctx.offboardLines().join("\n");
  soft(lines, "main's line for the close (offboard-close.ts)").toContain(`${nodeId} offboarded; its session closed and the seat rests`);
  soft(lines, "no [offboard] line says failed or did not go through").not.toMatch(/failed|did not go through/u);
  const onboard = opData(await seat.op("onboard", {}));
  note(testInfo, `${label}-onboard-payload-${nodeId}`, JSON.stringify(onboard));
  const without = onboard.previous_session_without_notes as
    | { readonly session_id?: unknown; readonly transcript_path?: unknown; readonly ended_by?: unknown }
    | undefined;
  soft(without?.session_id, `${nodeId}: junto onboard names the old session`).toBe(sessionIdOf(nodeId));
  soft(without?.transcript_path, `${nodeId}: and its transcript path (the rollout this spec planted)`).toBe(transcriptPathOf(sandbox, sessionIdOf(nodeId)));
  soft(without?.ended_by, `${nodeId}: ended_by`).toBe("automatic");
  soft(onboard.handoff, `${nodeId}: no handoff block`).toBeUndefined();
};

test("S5r-3 [slow-rules] [fake-tui] auto offboard at wake: a resting seat that worked and sat still is left alone until mailed, then starts fresh and gets the mail once", async ({}, testInfo) => {
  // Expected wall time: about 5 minutes (a minute of work, 2 to 3 minutes at rest, then the mail).
  test.setTimeout(11 * 60_000);
  const EVE = seatNode("eve", "Eve", COLUMN[0], ROW[0]);
  const PAT = seatNode("pat", "Pat", COLUMN[1], ROW[0], false);
  await walk(testInfo, "S5r-3", { doc: fixtureOf([EVE, PAT], [["pat", "eve"]]), transcripts: [sessionIdOf("eve")] }, async (ctx) => {
    const { junto, sandbox, shot, step, mark, offboardLines } = ctx;
    const { page } = junto;
    let eve!: CrewSeat;
    let pat!: CrewSeat;
    let before = "";

    await step("S5r-3.1", "E really works for over a minute in its session", async () => {
      const rules = await setRules(page, S6_RULES);
      expect(rules, "the rules in force").toMatchObject({ cacheWindowMinutes: 2, auto: { enabled: true, minutes: 2 }, worth: { workMinutes: 1 } });
      await crewPlayFactory(page);
      eve = await startSeat(page, sandbox, EVE);
      pat = await startSeat(page, sandbox, PAT);
      await restAfterWork(ctx, testInfo, pat, { eve }, { eve: (await eve.ready()).pid }, ["eve"], "S5r-3.1");
      await shot(page, "S5r-3.1", "e-stopped-after-a-minute-of-work");
    });

    await step("S5r-3.2", "E rests; wait past the interval: nothing happens to it, and no close line appears", async () => {
      // The walk says 3 minutes; the rule needs 2 whole ones. Main's own answer ends the wait.
      await waitPastWindow(ctx, testInfo, ["eve"], "S5r-3.2");
      await expectLeftAlone(ctx, page, "eve");
      soft(closeLines(offboardLines()), "no [offboard] close line").toEqual([]);
      before = await inputOf(sandbox, "eve", 1);
      await keepClock(ctx, "S5r-3", "before-the-mail");
      await shot(page, "S5r-3.2", "e-resting-past-the-interval");
    });

    await step("S5r-3.3", "send E a mail: its session is ended first, it starts on a new one, and the mail is delivered there, once", async () => {
      const mail = "S5r-3 mail: retry the nightly sync";
      const sent = opData(await pat.op("msg.send", { target: "eve", text: mail }));
      mark(`mail sent to E: ${JSON.stringify(sent)}`);
      await expectCutAtWake(ctx, testInfo, page, "eve", eve, mail, before, "S5r-3.3", String(sent.messageId ?? ""));
      await keepClock(ctx, "S5r-3", "after-the-mail");
      await shot(page, "S5r-3.3", "e-woken-on-a-fresh-session");
    });
  });
});

test("S5r-4 [slow-rules] [fake-tui] the gate: a resting seat that worked under the threshold wakes on its SAME session", async ({}, testInfo) => {
  // Expected wall time: about 4 minutes.
  test.setTimeout(10 * 60_000);
  const FAY = seatNode("fay", "Fay", COLUMN[0], ROW[0]);
  const PAT = seatNode("pat", "Pat", COLUMN[1], ROW[0], false);
  await walk(testInfo, "S5r-4", { doc: fixtureOf([FAY, PAT], [["pat", "fay"]]), transcripts: [sessionIdOf("fay")] }, async (ctx) => {
    const { junto, sandbox, shot, step, mark, offboardLines } = ctx;
    const { page } = junto;
    let fay!: CrewSeat;
    let pat!: CrewSeat;

    await step("S5r-4.1a", "the work threshold back at 30 minutes; F works for under a minute, then rests past the interval", async () => {
      const rules = await setRules(page, { ...(S6_RULES as Record<string, unknown>), worth: { workMinutes: 30 } } as unknown as OffboardRulesPatch);
      expect(rules, "the rules in force").toMatchObject({ cacheWindowMinutes: 2, auto: { enabled: true, minutes: 2 }, worth: { workMinutes: 30 } });
      await crewPlayFactory(page);
      fay = await startSeat(page, sandbox, FAY);
      pat = await startSeat(page, sandbox, PAT);
      const pid = (await fay.ready()).pid;
      await startTurns(page, sandbox, pat, ["fay"]);
      await sleep(15_000);
      await fay.control({ screen: { mode: "idle" } });
      await expectSeatState(page, "fay", "idle");
      await stopSeat(ctx, "fay", pid);
      await waitPastWindow(ctx, testInfo, ["fay"], "S5r-4.1a");
      const status = await workStatusOf(page, "fay");
      note(testInfo, "S5r-4-status-before-the-mail", JSON.stringify(status));
      soft(status?.workMinutes, "F did under a minute of work").toBe(0);
      soft(status?.worthCutting, "and is not worth cutting").toBe(false);
      await shot(page, "S5r-4.1", "f-resting-under-the-threshold");
    });

    await step("S5r-4.1", "mail F: it wakes on its SAME session id; nothing was cut; no close line", async () => {
      const mail = "S5r-4 mail: under the threshold";
      mark(`mail sent to F: ${JSON.stringify(opData(await pat.op("msg.send", { target: "fay", text: mail })))}`);
      await expect.poll(() => launches(sandbox, "fay"), { message: "F is woken by the mail", timeout: 90_000 }).toBe(2);
      await soft.poll(() => inputOf(sandbox, "fay", 2), { message: "the mail on the woken seat's input", timeout: 60_000 }).toContain(mail);
      await sleep(5_000);
      soft(await nodeSessionId(page, "fay"), "F still names the SAME session").toBe(sessionIdOf("fay"));
      soft(await progressOf(page, "fay"), "no offboard on record").toBeUndefined();
      soft(closeLines(offboardLines()), "no [offboard] close line").toEqual([]);
      const onboard = opData(await fay.op("onboard", {}));
      note(testInfo, "S5r-4-onboard-payload", JSON.stringify(onboard));
      soft(onboard.previous_session_without_notes, "junto onboard does not speak of a session ended without notes").toBeUndefined();
      await shot(page, "S5r-4.1", "f-woken-on-the-same-session");
    });
  });
});

test("S5r-5 [slow-rules] [fake-tui] one seat at a time: of three qualifying resting seats, only the mailed one gets a fresh session", async ({}, testInfo) => {
  // Expected wall time: about 5.5 minutes.
  test.setTimeout(12 * 60_000);
  const IDS = ["rea", "reb", "rec"] as const;
  const NODES = IDS.map((id, index) => seatNode(id, id.toUpperCase(), COLUMN[index]!, ROW[0]));
  const PAT = seatNode("pat", "Pat", COLUMN[0], ROW[1], false);
  const doc = fixtureOf([...NODES, PAT], IDS.map((id) => ["pat", id] as const));
  await walk(testInfo, "S5r-5", { doc, transcripts: IDS.map(sessionIdOf) }, async (ctx) => {
    const { junto, sandbox, shot, step, mark, offboardLines } = ctx;
    const { page } = junto;
    const seats: Record<string, CrewSeat> = {};
    const pids: Record<string, number> = {};
    let pat!: CrewSeat;
    let before = "";

    await step("S5r-5.1a", "three seats each work over a minute, are stopped, and rest past the interval", async () => {
      await setRules(page, S6_RULES);
      await crewPlayFactory(page);
      pat = await startSeat(page, sandbox, PAT);
      for (const node of NODES) {
        seats[node.id] = await startSeat(page, sandbox, node);
        pids[node.id] = (await seats[node.id]!.ready()).pid;
      }
      await restAfterWork(ctx, testInfo, pat, seats, pids, IDS, "S5r-5.1a");
      await waitPastWindow(ctx, testInfo, IDS, "S5r-5.1a");
      for (const id of IDS) await expectLeftAlone(ctx, page, id);
      before = await inputOf(sandbox, "reb", 1);
      await shot(page, "S5r-5.1", "three-resting-seats-past-the-interval");
    });

    await step("S5r-5.1", "mail one of them (REB): only that one gets a fresh session; the other two keep theirs and nothing is logged for them", async () => {
      const mail = "S5r-5 mail: only for reb";
      const sent = opData(await pat.op("msg.send", { target: "reb", text: mail }));
      mark(`mail sent to REB: ${JSON.stringify(sent)}`);
      await expectCutAtWake(ctx, testInfo, page, "reb", seats.reb!, mail, before, "S5r-5.1", String(sent.messageId ?? ""));
      // Give a batch, if there were one, time to show.
      await sleep(20_000);
      for (const id of ["rea", "rec"]) {
        await expectLeftAlone(ctx, page, id);
        soft(offboardLines().filter((line) => line.includes(id)), `no [offboard] line names ${id}`).toEqual([]);
      }
      await keepClock(ctx, "S5r-5", "after-the-mail");
      await shot(page, "S5r-5.1", "one-fresh-two-untouched");
    });
  });
});

test("S5r-6 [slow-rules] [fake-tui] restart: a qualifying resting seat is left alone for ten minutes after reopening, and is cut when mailed", async ({}, testInfo) => {
  // Expected wall time: about 16 minutes (4 before the quit, the walk's ten minutes after the reopen, 1.5 for the
  // mail and its checks). The timeout is that plus two; the ending has a deadline of its own (ENDING_DEADLINE_MS).
  test.setTimeout(18 * 60_000);
  const GIA = seatNode("gia", "Gia", COLUMN[0], ROW[0]);
  const PAT = seatNode("pat", "Pat", COLUMN[1], ROW[0], false);
  await walk(testInfo, "S5r-6", { doc: fixtureOf([GIA, PAT], [["pat", "gia"]]), transcripts: [sessionIdOf("gia")] }, async (ctx) => {
    const { junto, sandbox, shot, step, mark, tap, offboardLines } = ctx;
    let second: ElectronApplication | undefined;
    let reopenedAt = 0;
    let linesBeforeReopen = 0;
    let before = "";
    try {
      await step("S5r-6.1a", "first run: G works over a minute, is stopped, rests past the interval, and the clock is saved with its work", async () => {
        const { page } = junto;
        await setRules(page, S6_RULES);
        await crewPlayFactory(page);
        const gia = await startSeat(page, sandbox, GIA);
        const pat = await startSeat(page, sandbox, PAT);
        await restAfterWork(ctx, testInfo, pat, { gia }, { gia: (await gia.ready()).pid }, ["gia"], "S5r-6.1a");
        const restingFrom = Date.now();
        await waitPastWindow(ctx, testInfo, ["gia"], "S5r-6.1a");
        await expect
          .poll(async () => {
            const clock = await readClock(sandbox);
            const entry = clock?.seats[bindingOf("gia")] as { readonly workMs?: number } | undefined;
            return (clock?.savedAt ?? 0) > restingFrom && (entry?.workMs ?? 0) >= 60_000;
          }, { message: "a pass saved the clock with G's work after it came to rest", timeout: 2 * TICK_MS, intervals: [2_000] })
          .toBe(true);
        await keepClock(ctx, "S5r-6", "before-the-quit");
        before = await inputOf(sandbox, "gia", 1);
        await expectLeftAlone(ctx, page, "gia");
        await shot(page, "S5r-6.1", "g-resting-before-the-quit");
      });

      await step("S5r-6.1", "quit, reopen, wait ten minutes without mailing anyone: no session is ended, no close line, G's session id unchanged", async () => {
        const env = await quitApp(junto);
        mark("the first app has quit");
        await keepClock(ctx, "S5r-6", "after-the-quit");
        linesBeforeReopen = offboardLines().length;
        reopenedAt = mark("reopening on the same sandbox");
        second = await reopenApp(junto, env);
        tap(second);
        const page = await second.firstWindow();
        await page.waitForFunction(() => Boolean(window.junto?.settingsPatch), undefined, { timeout: 60_000 });
        await expect(page.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
        // A wake is refused on a paused canvas: make sure this one plays, whatever the reopen restored.
        note(testInfo, "S5r-6-pause-state-after-reopen", (await page.getByTestId("factory-pause").getAttribute("data-pause-state").catch(() => null)) ?? "unknown");
        await crewPlayFactory(page);
        await shot(page, "S5r-6.1", "after-the-reopen");
        let looks = 0;
        let disturbedAt: string | undefined;
        while (Date.now() < reopenedAt + 10 * TICK_MS) {
          await sleep(30_000);
          looks += 1;
          const disturbed =
            (await progressOf(page, "gia")) !== undefined ||
            (await launches(sandbox, "gia")) !== 1 ||
            (await nodeSessionId(page, "gia")) !== sessionIdOf("gia");
          if (disturbed && disturbedAt === undefined) disturbedAt = `${String(Math.round((Date.now() - reopenedAt) / 1000))} s after the reopen`;
        }
        note(testInfo, "S5r-6-ten-minute-watch", `${String(looks)} looks, 30 s apart; first disturbance: ${disturbedAt ?? "none"}`);
        soft(disturbedAt, "G was left alone for the whole ten minutes").toBeUndefined();
        await expectLeftAlone(ctx, page, "gia");
        const sinceReopen = offboardLines().slice(linesBeforeReopen);
        note(testInfo, "S5r-6-offboard-lines-since-reopen", JSON.stringify(sinceReopen));
        soft(closeLines(sinceReopen), "no [offboard] close line since the reopen").toEqual([]);
        note(testInfo, "S5r-6-status-after-ten-minutes", JSON.stringify(await workStatusOf(page, "gia")));
        await keepClock(ctx, "S5r-6", "ten-minutes-after-the-reopen");
        await shot(page, "S5r-6.1", "ten-minutes-after-the-reopen-nothing-ended");
      });

      await step("S5r-6.2", "mail G: fresh session, as 5.3", async () => {
        const page = await second!.firstWindow();
        // No seat is running after the reopen, so the mail is the operator's (preload/index.ts:886); it wakes the seat.
        const mail = "S5r-6 mail: after the restart";
        const sent = await page.evaluate(
          ([canvasName, bindingId, body]) => window.junto!.terminalManagedPrompt({ bindingId, text: body, canvasName, nodeId: "gia" }),
          [CANVAS, bindingOf("gia"), mail] as const,
        );
        mark(`operator mail sent to G: ${JSON.stringify(sent)}`);
        const sentId = (sent as { readonly messageId?: unknown } | undefined)?.messageId;
        await expectCutAtWake(ctx, testInfo, page, "gia", crewSeat(sandbox, CANVAS, "gia"), mail, before, "S5r-6.2", typeof sentId === "string" ? sentId : undefined);
        // Leave no turn in flight for the quit: the wake mail started one on the fake. The seat's turn ends here.
        await crewSeat(sandbox, CANVAS, "gia").control({ screen: { mode: "idle" } }).catch(() => undefined);
        await keepClock(ctx, "S5r-6", "after-the-mail");
        await shot(page, "S5r-6.2", "g-woken-on-a-fresh-session");
      });
    } finally {
      // The reopened app is closed by the walk's ending, after the evidence is written and against its deadline.
    }
  });
});

test("S5r-7 [slow-rules] [fake-tui] the clock file: what it holds for a seat that worked and for one closed from outside, and what survives a quit and reopen", async ({}, testInfo) => {
  // Expected wall time: about 5 minutes.
  test.setTimeout(11 * 60_000);
  const WES = seatNode("wes", "Wes", COLUMN[0], ROW[0]);
  const CLO = seatNode("clo", "Clo", COLUMN[1], ROW[0]);
  const PAT = seatNode("pat", "Pat", COLUMN[2], ROW[0], false);
  await walk(testInfo, "S5r-7", { doc: fixtureOf([WES, CLO, PAT], [["pat", "wes"]]), transcripts: [sessionIdOf("wes")] }, async (ctx) => {
    const { junto, sandbox, shot, step, mark, tap } = ctx;
    let second: ElectronApplication | undefined;
    type Entry = { readonly movedAt?: number; readonly workMs?: number; readonly sessionId?: string; readonly offboarded?: boolean };
    let wesBefore: Entry | undefined;
    let savedBefore = 0;
    try {
      await step("S5r-7.1", "after a minute: savedAt, seats by binding id with movedAt; the seat that worked has workMs and sessionId; the one closed from outside has offboarded and no workMs", async () => {
        const { page } = junto;
        await setRules(page, S6_RULES);
        await crewPlayFactory(page);
        const wes = await startSeat(page, sandbox, WES);
        await startSeat(page, sandbox, CLO);
        const pat = await startSeat(page, sandbox, PAT);
        // Wes: over a minute of work, then at rest, and never touched again.
        await restAfterWork(ctx, testInfo, pat, { wes }, { wes: (await wes.ready()).pid }, ["wes"], "S5r-7.1");
        // Clo: idle, closed from outside by the operator's Offboard now (the call the buttons make, preload/index.ts:483).
        const closed = await page.evaluate(
          ([canvasName]) => window.junto!.seatOffboardRun!({ canvasName, seatIds: ["clo"], action: "now" }),
          [CANVAS] as const,
        );
        const stagedAt = mark(`Clo closed from outside: ${JSON.stringify(closed)}`);
        await expect
          .poll(async () => (await readClock(sandbox))?.savedAt ?? 0, { message: "a pass saved the clock after the staging", timeout: 2 * TICK_MS + 15_000, intervals: [2_000] })
          .toBeGreaterThan(stagedAt + 3_000);
        const clock = (await keepClock(ctx, "S5r-7", "first-read")) as (ClockFile & { readonly seats: Readonly<Record<string, Entry>> }) | undefined;
        soft(typeof clock?.savedAt, "savedAt is a number").toBe("number");
        soft(Object.keys(clock?.seats ?? {}).sort(), "seats are keyed by binding id").toEqual(expect.arrayContaining([bindingOf("clo"), bindingOf("wes")]));
        for (const [binding, entry] of Object.entries(clock?.seats ?? {})) soft(typeof entry.movedAt, `${binding}: movedAt is a number`).toBe("number");
        wesBefore = clock?.seats[bindingOf("wes")];
        savedBefore = clock?.savedAt ?? 0;
        soft(wesBefore?.workMs ?? 0, "the seat that worked has workMs, over a minute").toBeGreaterThanOrEqual(60_000);
        soft(wesBefore?.sessionId, "and its sessionId").toBe(sessionIdOf("wes"));
        const cloEntry = clock?.seats[bindingOf("clo")];
        note(testInfo, "S5r-7-clo-entry", JSON.stringify(cloEntry ?? null));
        soft(cloEntry?.offboarded, "the seat closed from outside has offboarded: true").toBe(true);
        soft(cloEntry?.workMs, "and no workMs").toBeUndefined();
        await shot(page, "S5r-7.1", "clock-file-first-read");
      });

      await step("S5r-7.2", "quit and reopen, wait a minute, read again: the untouched seat's movedAt and workMs are unchanged; savedAt is newer", async () => {
        const env = await quitApp(junto);
        await keepClock(ctx, "S5r-7", "after-the-quit");
        const reopenedAt = mark("reopening on the same sandbox");
        second = await reopenApp(junto, env);
        tap(second);
        const page = await second.firstWindow();
        await page.waitForFunction(() => Boolean(window.junto?.settingsPatch), undefined, { timeout: 60_000 });
        await expect
          .poll(async () => (await readClock(sandbox))?.savedAt ?? 0, { message: "the reopened app saved the clock", timeout: 2 * TICK_MS + 15_000, intervals: [2_000] })
          .toBeGreaterThan(reopenedAt);
        const clock = (await keepClock(ctx, "S5r-7", "after-the-reopen")) as (ClockFile & { readonly seats: Readonly<Record<string, Entry>> }) | undefined;
        const wesAfter = clock?.seats[bindingOf("wes")];
        soft(wesAfter?.movedAt, "the untouched seat's movedAt").toBe(wesBefore?.movedAt);
        soft(wesAfter?.workMs, "its workMs").toBe(wesBefore?.workMs);
        soft(clock?.savedAt ?? 0, "savedAt is newer").toBeGreaterThan(savedBefore);
        note(testInfo, "S5r-7-wes-processes-after-reopen", `launches so far: ${String(await launches(sandbox, "wes"))} (2 would mean the reopened app started it, which moves its clock)`);
        await shot(page, "S5r-7.2", "clock-file-after-the-reopen");
      });
    } finally {
      // The reopened app is closed by the walk's ending, after the evidence is written and against its deadline.
    }
  });
});

test("S5r-8 [slow-rules] [fake-tui] the idle nudge: a seat that worked is asked once, a second one a minute later, and a seat that did no work is never asked", async ({}, testInfo) => {
  // Expected wall time: about 9 minutes (the nudge waits 5 minutes after the app opens, then one seat per pass, then two passes watched).
  test.setTimeout(16 * 60_000);
  const NAN = seatNode("nan", "Nan", COLUMN[0], ROW[0]);
  const NEL = seatNode("nel", "Nel", COLUMN[1], ROW[0]);
  const MOE = seatNode("moe", "Moe", COLUMN[2], ROW[0]);
  const PAT = seatNode("pat", "Pat", COLUMN[0], ROW[1], false);
  const doc = fixtureOf([NAN, NEL, MOE, PAT], [["pat", "nan"], ["pat", "nel"]]);
  await walk(testInfo, "S5r-8", { doc }, async (ctx) => {
    const { junto, sandbox, shot, step, mark, offboardLines } = ctx;
    const { page } = junto;
    const seats: Record<string, CrewSeat> = {};
    /** operator-offboard-live.ts:303. */
    const NUDGE_LINE = "[offboard] idle nudge: 1 asked, 0 not done";

    await step("S5r-8.1a", "rules: cache window 5, idle nudge on at 2, auto offboard 30, work threshold 1; N and a second seat work over a minute then sit idle; M sits idle having done no work", async () => {
      const rules = await setRules(page, {
        cacheWindowMinutes: 5,
        nudge: { enabled: true, minutes: 2 },
        auto: { enabled: true, minutes: 30 },
        worth: { workMinutes: 1 },
      } as unknown as OffboardRulesPatch);
      expect(rules, "the rules in force").toMatchObject({ cacheWindowMinutes: 5, nudge: { enabled: true, minutes: 2 }, auto: { enabled: true, minutes: 30 }, worth: { workMinutes: 1 } });
      await crewPlayFactory(page);
      const pat = await startSeat(page, sandbox, PAT);
      for (const node of [NAN, NEL, MOE]) seats[node.id] = await startSeat(page, sandbox, node);
      await startTurns(page, sandbox, pat, ["nan", "nel"]);
      await workOverAMinute(ctx, testInfo, seats, ["nan", "nel"], "S5r-8.1a");
      for (const id of ["nan", "nel"]) {
        await seats[id]!.control({ screen: { mode: "idle" } });
        await expectSeatState(page, id, "idle");
        // "While it stays idle": the default fake echoes a paste and starts a turn on Enter
        // (crew-fixture.ts), which is output and so a new stretch. From here these two swallow the
        // paste and ignore the Enter: they print nothing and stay idle; their input logs still record every byte.
        await seats[id]!.control({ paste: "swallow", submit: "ignore" });
      }
      mark("Nan and Nel are idle after a minute of work; Moe is idle with none");
      soft((await workStatusOf(page, "moe"))?.workMinutes, "M has done no work").toBe(0);
      await shot(page, "S5r-8.1", "two-worked-one-did-not");
    });

    await step("S5r-8.1", "once still 2 minutes and the app open 5: asked once each, one per minute, not again while idle; M gets nothing", async () => {
      const askedAt = async (): Promise<Readonly<Record<string, number>>> => {
        const out: Record<string, number> = {};
        for (const id of ["nan", "nel", "moe"]) {
          const progress = await progressOf(page, id);
          if (progress?.stage === "asked") out[id] = progress.at;
        }
        return out;
      };
      await expect
        .poll(async () => Object.keys(await askedAt()).length, { message: "seats asked by the nudge", timeout: until(ctx.launchStartedAt, GRACE_MS + 2.5 * TICK_MS), intervals: [1_000] })
        .toBeGreaterThanOrEqual(1);
      const first = await askedAt();
      soft(Object.keys(first).length, "at the first ask, only one seat is asked").toBe(1);
      await shot(page, "S5r-8.1", "first-seat-asked");
      await keepClock(ctx, "S5r-8", "after-the-first-ask");
      await expect
        .poll(async () => Object.keys(await askedAt()).length, { message: "seats asked by the nudge", timeout: 2.5 * TICK_MS, intervals: [2_000] })
        .toBe(2);
      const both = await askedAt();
      const times = Object.values(both).sort((left, right) => left - right);
      note(testInfo, "S5r-8-asked-at", JSON.stringify(Object.fromEntries(Object.entries(both).map(([id, at]) => [id, `${String(Math.round((at - ctx.launchStartedAt) / 1000))} s after start`]))));
      soft(Object.keys(both).sort(), "the two seats that worked are the two asked").toEqual(["nan", "nel"]);
      soft(times[0]! - ctx.launchStartedAt, "the first ask is not before the app had been open 5 minutes").toBeGreaterThanOrEqual(GRACE_MS);
      soft(times[1]! - times[0]!, "the two asks are a pass apart, not together (ms)").toBeGreaterThanOrEqual(TICK_MS - 5_000);
      await shot(page, "S5r-8.1", "second-seat-asked");
      // Two more passes: a repeat would land at one of them.
      await sleep(Math.max(0, times[1]! + 2 * TICK_MS + 15_000 - Date.now()));
      const lines = offboardLines();
      note(testInfo, "S5r-8-offboard-lines", JSON.stringify(lines));
      soft(lines.filter((line) => line.includes(NUDGE_LINE)).length, "passes that asked one seat").toBe(2);
      soft(lines.filter((line) => /idle nudge: (?:[2-9]|\d{2,}) asked|idle nudge could not ask|idle nudge: \d+ asked, [1-9]/u.test(line)), "no pass asked two, and none failed").toEqual([]);
      for (const id of ["nan", "nel"]) {
        soft(await seatState(page, id), `${id} stayed idle`).toBe("idle");
        await soft.poll(() => inputOf(sandbox, id, 1), { message: `${id}: the ask prompt on its input`, timeout: 30_000 }).toContain(ASK_CONTINUE_FIRST);
        note(testInfo, `S5r-8-prompt-occurrences-on-input-${id}`, String(occurrences(await inputOf(sandbox, id, 1), ASK_CONTINUE_FIRST)));
      }
      soft(await progressOf(page, "moe"), "M was never asked").toBeUndefined();
      soft(await inputOf(sandbox, "moe", 1), "nothing was typed into M").not.toContain(ASK_CONTINUE_FIRST);
      await keepClock(ctx, "S5r-8", "two-passes-after-the-second-ask");
      // Read last: each mailbox is the count of asks that were sent.
      for (const id of ["nan", "nel"]) {
        soft((await mailTexts(seats[id]!)).filter((text) => text.startsWith(ASK_CONTINUE_FIRST)).length, `${id}: exactly one ask prompt in its mailbox`).toBe(1);
      }
      soft((await mailTexts(seats.moe!)).filter((text) => text.includes(ASK_CONTINUE_FIRST)).length, "M: no ask prompt in its mailbox").toBe(0);
      await shot(page, "S5r-8.1", "two-passes-later-no-repeat");
    });
  });
});

/** The standalone CLI a seat's `cli` runs (overseer-offboard-cli.spec.ts:56). */
const CLI_BUILT = existsSync(join(process.cwd(), "dist", "junto"));

test("S5r-cli [fake-tui] the overseer's CLI closes a resting seat that had a turn: exit 0, one row closed, none refused, and the next start is a fresh session", async ({}, testInfo) => {
  // Expected wall time: about 1.5 minutes. Needs dist/junto (bun run cli:build). Not a slow test any more: the
  // overseer's own close is not held to "worth cutting" (that gate is the automatic rules' only:
  // seat-sessions/operator-offboard.ts:549 and :608; closeOne, :426-465, never asks it), so no minute of work is staged.
  test.skip(!CLI_BUILT, "SETUP: dist/junto is missing; this test runs the CLI itself. Build it with `bun run cli:build`.");
  test.setTimeout(5 * 60_000);
  const BOSS = seatNode("boss", "Boss", COLUMN[0], ROW[0], false);
  const TIA = seatNode("tia", "Tia", COLUMN[1], ROW[0]);
  const PAT = seatNode("pat", "Pat", COLUMN[2], ROW[0], false);
  await walk(testInfo, "S5r-cli", { doc: fixtureOf([BOSS, TIA, PAT], [["pat", "tia"]]), transcripts: [sessionIdOf("tia")] }, async (ctx) => {
    const { junto, sandbox, dir, shot, step, mark, offboardLines } = ctx;
    const { page } = junto;
    let boss!: CrewSeat;
    let tia!: CrewSeat;
    let pat!: CrewSeat;
    let before = "";

    await step("S5r-cli.0", "a seat that had one real turn, went idle and was stopped, so it rests on its session; then an overseer seat with the grant", async () => {
      // Nothing automatic: the close under test is the overseer's own.
      await setRules(page, WALK_RULES);
      await crewPlayFactory(page);
      tia = await startSeat(page, sandbox, TIA);
      pat = await startSeat(page, sandbox, PAT);
      const pid = (await tia.ready()).pid;
      await startTurns(page, sandbox, pat, ["tia"]);
      await sleep(3_000);
      await tia.control({ screen: { mode: "idle" } });
      await expectSeatState(page, "tia", "idle");
      await stopSeat(ctx, "tia", pid);
      const status = await workStatusOf(page, "tia");
      // worthCutting false is expected here, and is informational: it does not gate this close.
      note(testInfo, "S5r-cli-status-at-rest", JSON.stringify(status));
      expect(status?.now.allowed, "a resting seat may be closed").toBe(true);
      // Only now the overseer: started and granted after the staging, so neither can bear on it.
      boss = await startSeat(page, sandbox, BOSS);
      // The grant, through the human seam (overseer-offboard-cli.spec.ts:264-279).
      await grantOverseer(page, CANVAS, BOSS.id);
      await expect(card(page, "boss").locator(".junto-node")).toHaveAttribute("data-overseer", "true", { timeout: 15_000 });
      expect(await nodeSessionId(page, "tia"), "Tia still names her session after the grant").toBe(sessionIdOf("tia"));
      expect(await launches(sandbox, "tia"), "and was not started again").toBe(1);
      note(testInfo, "S5r-cli-rules-after-the-grant", JSON.stringify(await page.evaluate(async () => (await window.junto!.settingsGet()).settings?.offboard)));
      before = await inputOf(sandbox, "tia", 1);
      await shot(page, "S5r-cli.0", "overseer-and-a-resting-seat");
    });

    await step("S5r-cli.1", "junto overseer agent offboard with action now, typed in the overseer seat: exit 0, one row ok true outcome closed, refused 0", async () => {
      // What the overseer sees first, for the record (worthCutting false is expected and gates nothing).
      const seen = await boss.cli(["overseer", "agent", "offboard-status", JSON.stringify({ nodeIds: ["tia"] })]);
      note(testInfo, "S5r-cli-offboard-status", `exit ${String(seen.exitCode)}; stdout ${seen.stdout.trim().slice(0, 700)}; stderr ${seen.stderr.trim().slice(0, 200)}`);
      const argv = ["overseer", "agent", "offboard", JSON.stringify({ nodeIds: ["tia"], action: "now" })];
      const result = await boss.cli(argv);
      await writeFile(
        join(dir, "S5r-cli-cli.txt"),
        [`$ junto ${argv.join(" ")}`, `exit code: ${String(result.exitCode)}`, "", "--- stdout ---", result.stdout, "--- stderr ---", result.stderr, ""].join("\n"),
        "utf8",
      ).catch(() => undefined);
      mark(`the CLI answered: exit ${String(result.exitCode)}; ${result.stdout.trim().slice(0, 400)}`);
      note(testInfo, "S5r-cli-output", `exit ${String(result.exitCode)}; stdout ${result.stdout.trim().slice(0, 600)}; stderr ${result.stderr.trim().slice(0, 300)}`);
      soft(result.exitCode, "exit code").toBe(0);
      let envelope: { readonly ok?: unknown; readonly data?: { readonly results?: ReadonlyArray<Record<string, unknown>> } } | undefined;
      for (const text of result.stdout.split("\n").reverse()) {
        if (!text.trim().startsWith("{")) continue;
        try {
          envelope = JSON.parse(text.trim()) as typeof envelope;
          break;
        } catch {
          // Not the line.
        }
      }
      soft(envelope?.ok, "stdout is a success envelope").toBe(true);
      const rows = envelope?.data?.results ?? [];
      soft((envelope?.data as { readonly refused?: unknown } | undefined)?.refused, "refused").toBe(0);
      soft(rows.length, "one row").toBe(1);
      soft(rows[0]?.ok, "the row is ok").toBe(true);
      soft(rows[0]?.outcome, "its outcome").toBe("closed");
      const progress = await progressOf(page, "tia");
      note(testInfo, "S5r-cli-progress", JSON.stringify(progress ?? null));
      soft(progress?.stage, "the seat's offboard stands at resting").toBe("resting");
      soft(await nodeSessionId(page, "tia"), "the seat no longer names the closed session").not.toBe(sessionIdOf("tia"));
      soft(await launches(sandbox, "tia"), "nothing was started by the close").toBe(1);
      soft(offboardLines().join("\n"), "no [offboard] line says failed").not.toMatch(/failed/u);
      await shot(page, "S5r-cli.1", "closed-by-the-overseer-cli");
    });

    await step("S5r-cli.2", "the seat's next start is a fresh session, and junto onboard there says the previous one ended without notes", async () => {
      const mail = "S5r-cli mail: wake up";
      opData(await pat.op("msg.send", { target: "tia", text: mail }));
      await expect.poll(() => launches(sandbox, "tia"), { message: "a process starts for the mail", timeout: 90_000 }).toBe(2);
      await soft.poll(() => inputOf(sandbox, "tia", 2), { message: "the mail on the fresh session's input", timeout: 60_000 }).toContain(mail);
      soft(await inputOf(sandbox, "tia", 1), "nothing was typed into the closed session").toBe(before);
      soft(await nodeSessionId(page, "tia"), "it does not name the closed session").not.toBe(sessionIdOf("tia"));
      const onboard = opData(await tia.op("onboard", {}));
      note(testInfo, "S5r-cli-onboard-payload", JSON.stringify(onboard));
      const without = onboard.previous_session_without_notes as { readonly session_id?: unknown; readonly ended_by?: unknown } | undefined;
      soft(without?.session_id, "junto onboard in the fresh session names the closed one").toBe(sessionIdOf("tia"));
      // The overseer's call passes by "overseer" (overseer/offboard.ts:77); closeOne records it beside the session
      // (seat-sessions/operator-offboard.ts:455-457), and onboard reads it back (work/control.ts:1025, 1038).
      soft(without?.ended_by, "ended by the overseer").toBe("overseer");
      soft(onboard.handoff, "no handoff block: the session ended without notes").toBeUndefined();
      await shot(page, "S5r-cli.2", "woken-on-a-fresh-session");
    });
  });
});
