/**
 * The overseer's offboard commands, typed in an overseer seat [fake-tui].
 *
 *   bun run cli:build && bun run test:e2e:fast e2e/scenarios/overseer-offboard-cli.spec.ts
 *
 * The CLI team's ten-step walk, on fake Codex seats:
 *
 *   O  the overseer: the grant is set through the human seam
 *      (canvasOverseerSet, as overseer-seat.spec.ts does). Every command of
 *      steps 1 to 9 runs in O, through its own CLI.
 *   W  working: mid-turn on real mail from a peer, and left there.
 *   I  idle at its prompt, with one turn behind it.
 *   R  offline: a seat that was never started. To offboard, "resting" and
 *      "offline" are the same thing, a seat with no process up
 *      (main/junto/seat-sessions/operator-offboard.ts, OffboardSeat.running).
 *   N  a seat with no grant, for step 10.
 *
 * What is under test is the CLI itself: its exit code, its stdout and its
 * stderr. So the spec needs the built CLI (dist/junto) and refuses to start
 * without it; it never falls back to a work-control op. CrewSeat.cli runs the
 * seat's own `junto` as a child of the seat process and hands back
 * { ok, exitCode, stdout, stderr } (e2e/harness/crew-fixture.ts).
 *
 * One test for the whole walk: the steps share state and their order
 * matters (7 to 9 change the rules, 9 restores them). Each block is labelled
 * with its step; every check is soft, so every step runs and reports.
 *
 * Evidence, in OVERSEER_CLI_DIR when set and the test's output folder
 * otherwise: `<step>-cli.txt` for each command (arguments, exit code, stdout,
 * stderr), `offboard-log.txt` (main's `[offboard]` lines), and screenshots.
 */
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import type { AgentSeatStateEvent } from "../../src/shared/agent-seat-state";
import type { CanvasDoc, TextNode } from "../../src/shared/canvas";
import { DEFAULT_OFFBOARD_RULES, OFFBOARD_REFUSAL_REASON } from "../../src/shared/seat-offboard";
import { composeOffboardAsk } from "../../src/shared/seat-sessions";
import type { TerminalSessionSummary } from "../../src/shared/terminal";
import {
  crewDoc,
  crewMessageCount,
  crewMessagesEdge,
  crewOccupySeat,
  crewPlayFactory,
  crewSeat,
  crewSeatNode,
  installCrewSeatHarness,
  type CrewCliResult,
  type CrewSeat,
  type WorkEnvelope,
} from "../harness/crew-fixture";
import { expect, launchJunto, test } from "../harness/launch";

const CANVAS = "overseercli";
const CLI_BUILT = existsSync(join(process.cwd(), "dist", "junto"));
const CLI_MISSING =
  "SETUP: dist/junto is missing. This walk tests the CLI's own exit codes and output, so it does not run without it. Build it with `bun run cli:build` in the checkout the run starts from.";

const soft = expect.configure({ soft: true });

// The walk's literals, as the CLI team wrote them. Compared once to what the
// shared modules export, so a drift in either is named at the top of the run.
const WALK_RULES = {
  cacheWindowMinutes: 60,
  auto: { enabled: true, minutes: 120 },
  nudge: { enabled: false, minutes: 40 },
  worth: { workMinutes: 30, tokens: 200_000 },
} as const;
const WALK_WORKING = "This seat is working. Offboard now only closes a seat that is idle, offline or resting.";
const WALK_NOT_A_SEAT = "Junto could not find that seat.";
const WALK_ASK_OPENS = "The operator asks you to offboard and continue in a fresh session.";
const WALK_NUDGE_REFUSAL =
  "The idle nudge must come before the cache window (60 min): it asks the agent for a turn, which is only cheap while the cache is warm.";
/** What a seat without the grant hears (main/junto/work/control.ts:3389). */
const NOT_AN_OVERSEER = "only a human-enabled overseer seat may administer the canvas";
/** Why `mode` is refused with `now` (shared/overseer-control.ts:692). */
const MODE_ONLY_WITH_ASK = "mode is only allowed when action is ask";

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

/** A codex seat that names a session, seeded the way seat-sessions.spec.ts does. */
const sessionSeat = (id: string, label: string, x: number, y: number): TextNode => {
  const base = crewSeatNode({ id, label, x, y });
  return { ...base, ether: { ...base.ether, terminal: { ...base.ether!.terminal!, sessionId: `sess-overseercli-${id}` } } };
};

const O = crewSeatNode({ id: "overseer", label: "Overseer", x: 60, y: 80 });
const W = sessionSeat("working", "Working", 360, 80);
const I = sessionSeat("idle", "Idle", 660, 80);
const R = sessionSeat("resting", "Resting", 960, 80);
const N = crewSeatNode({ id: "nogrant", label: "No grant", x: 60, y: 300 });
const PEER = crewSeatNode({ id: "peer", label: "Peer", x: 500, y: 300 });
const NODES = [O, W, I, R, N, PEER];
const DOC: CanvasDoc = crewDoc(NODES, [
  crewMessagesEdge("e-peer-working", PEER.id, W.id, NODES),
  crewMessagesEdge("e-peer-idle", PEER.id, I.id, NODES),
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const bindingOf = (nodeId: string): string => `local:${nodeId}`;

const seatState = async (page: Page, nodeId: string): Promise<string> => {
  const events = (await page.evaluate(() => window.junto!.agentSeatStateSnapshot())) as ReadonlyArray<AgentSeatStateEvent>;
  return events.find((event) => event.bindingId === bindingOf(nodeId))?.state ?? "none";
};

const expectSeatState = async (page: Page, nodeId: string, state: string): Promise<void> => {
  await expect.poll(() => seatState(page, nodeId), { message: `seat ${nodeId} state`, timeout: 30_000 }).toBe(state);
};

const sessionOf = (page: Page, nodeId: string): Promise<TerminalSessionSummary | undefined> =>
  page.evaluate((id) => window.junto!.terminalGet(id), bindingOf(nodeId)) as Promise<TerminalSessionSummary | undefined>;

const isLive = (session: TerminalSessionSummary | undefined): boolean =>
  session?.status === "running" || session?.status === "starting";

const nodeSessionId = async (page: Page, nodeId: string): Promise<string | undefined> => {
  const doc = (await page.evaluate(async (name) => (await window.junto!.readCanvas(name)).doc, CANVAS)) as CanvasDoc;
  return doc.nodes.find((node) => node.id === nodeId)?.ether?.terminal?.sessionId;
};

const opData = (envelope: WorkEnvelope): Record<string, unknown> => {
  expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
  return ((envelope as { readonly data?: unknown }).data ?? {}) as Record<string, unknown>;
};

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The one JSON line a stream holds, or undefined when it holds none. */
const jsonLine = (text: string): Record<string, unknown> | undefined => {
  for (const line of text.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not the line.
    }
  }
  return undefined;
};

type Ran = {
  readonly result: CrewCliResult;
  /** stdout's JSON line. */
  readonly out: Record<string, unknown> | undefined;
  /** stderr's JSON line. */
  readonly err: Record<string, unknown> | undefined;
  /** `data` of a success envelope. */
  readonly data: Record<string, unknown>;
  /** `error` of a failure envelope. */
  readonly error: { readonly type?: unknown; readonly message?: unknown };
};

type RuleSet = {
  readonly cacheWindowMinutes?: unknown;
  readonly auto?: { readonly enabled?: unknown; readonly minutes?: unknown };
  readonly nudge?: { readonly enabled?: unknown; readonly minutes?: unknown };
  readonly worth?: { readonly workMinutes?: unknown; readonly tokens?: unknown };
  readonly harness?: Record<string, unknown>;
};

// ===========================================================================

test("[fake-tui] the overseer's offboard commands: rules, status, now, ask, a refused mode, configure, and no grant", async ({}, testInfo) => {
  test.setTimeout(600_000);
  if (!CLI_BUILT) throw new Error(CLI_MISSING);

  // The walk's words and the product's, compared once.
  expect(DEFAULT_OFFBOARD_RULES, "the walk's default rules are the product's (shared/seat-offboard.ts DEFAULT_OFFBOARD_RULES)").toEqual(WALK_RULES);
  expect(OFFBOARD_REFUSAL_REASON.working, "the walk's working sentence is the product's").toBe(WALK_WORKING);
  expect(OFFBOARD_REFUSAL_REASON["not-a-seat"], "the walk's not-a-seat sentence is the product's").toBe(WALK_NOT_A_SEAT);
  expect(composeOffboardAsk("continue").split("\n")[0], "the walk's continue prompt opens as the product's does").toBe(WALK_ASK_OPENS);

  const dir = process.env.OVERSEER_CLI_DIR ?? testInfo.outputPath();
  await mkdir(dir, { recursive: true });
  const junto = await launchJunto({ seedCanvases: { [CANVAS]: DOC }, afterSeed: installCrewSeatHarness });
  const chunks: string[] = [];
  const keep = (chunk: Buffer): void => {
    chunks.push(String(chunk));
  };
  junto.app.process().stdout?.on("data", keep);
  junto.app.process().stderr?.on("data", keep);
  const { page, sandbox } = junto;
  const shot = async (name: string): Promise<void> => {
    await page.screenshot({ path: join(dir, `${name}.png`) });
  };

  /** Run one command in a seat through its own CLI, and keep everything it said. */
  const run = async (step: string, seat: CrewSeat, argv: ReadonlyArray<string>): Promise<Ran> => {
    const result = await seat.cli(argv);
    const out = jsonLine(result.stdout);
    const err = jsonLine(result.stderr);
    await writeFile(
      join(dir, `${step}-cli.txt`),
      [`$ junto ${argv.join(" ")}`, `exit code: ${String(result.exitCode)}`, "", "--- stdout ---", result.stdout, "--- stderr ---", result.stderr, ""].join("\n"),
      "utf8",
    );
    testInfo.annotations.push({ type: `step-${step}`, description: `exit ${String(result.exitCode)}; stdout ${result.stdout.trim().slice(0, 300)}; stderr ${result.stderr.trim().slice(0, 300)}` });
    return {
      result,
      out,
      err,
      data: ((out?.data ?? {}) as Record<string, unknown>) ?? {},
      error: ((err?.error ?? {}) as { type?: unknown; message?: unknown }) ?? {},
    };
  };
  const input = (value: unknown): string => JSON.stringify(value);
  /** A pass: exit 0, one success envelope on stdout for this command, nothing on stderr. */
  const expectPass = (step: string, ran: Ran, command: string, exitCode = 0): void => {
    soft(ran.result.exitCode, `step ${step}: exit code`).toBe(exitCode);
    soft(ran.out?.ok, `step ${step}: stdout is a success envelope: ${ran.result.stdout.trim().slice(0, 400)}`).toBe(true);
    soft(ran.out?.command, `step ${step}: the envelope names the command`).toBe(command);
    soft(ran.err, `step ${step}: no failure envelope on stderr: ${ran.result.stderr.trim().slice(0, 400)}`).toBeUndefined();
  };
  /** A command error: exit 1, a failure envelope on stderr, no result on stdout. */
  const expectError = (step: string, ran: Ran): void => {
    soft(ran.result.exitCode, `step ${step}: exit code`).toBe(1);
    soft(ran.err?.ok, `step ${step}: stderr is a failure envelope: ${ran.result.stderr.trim().slice(0, 400)}`).toBe(false);
    soft(ran.out, `step ${step}: nothing printed on stdout: ${ran.result.stdout.trim().slice(0, 400)}`).toBeUndefined();
  };
  const baseOf = (set: RuleSet | undefined): unknown => ({
    cacheWindowMinutes: set?.cacheWindowMinutes,
    auto: set?.auto,
    nudge: set?.nudge,
    worth: set?.worth,
  });

  try {
    await expect(page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await crewPlayFactory(page);

    // ── Staging ────────────────────────────────────────────────────────────
    const seatOf = (node: TextNode): CrewSeat => crewSeat(sandbox, CANVAS, node.id);
    const start = async (node: TextNode): Promise<CrewSeat> => {
      const seat = seatOf(node);
      await crewOccupySeat(page, CANVAS, node, seat);
      await expectSeatState(page, node.id, "idle");
      return seat;
    };
    const o = await start(O);
    const w = await start(W);
    const i = await start(I);
    const n = await start(N);
    const peer = await start(PEER);
    // R is never started: no process, which is what offline and resting both are to offboard.
    expect(isLive(await sessionOf(page, R.id)), "R has no process").toBe(false);

    // O: the grant, through the human seam, before anything else is edited.
    await page.evaluate(
      async ([canvasName, nodeId]) => {
        const api = window.junto!;
        for (let attempt = 0; ; attempt += 1) {
          const read = await api.readCanvas(canvasName);
          try {
            await api.canvasOverseerSet({ canvasName, nodeId, overseer: true, expectedRevision: read.revision });
            return;
          } catch (error) {
            if (attempt === 2) throw error;
          }
        }
      },
      [CANVAS, O.id] as const,
    );
    await expect(page.locator(`.react-flow__node[data-id="${O.id}"] .junto-node`)).toHaveAttribute("data-overseer", "true", { timeout: 15_000 });

    // I: one turn behind it, then idle at its prompt.
    opData(await peer.op("msg.send", { target: I.id, text: "a first turn for the idle seat" }));
    await expect.poll(() => i.stdinLog(), { message: "I's first turn", timeout: 60_000 }).toContain("a first turn for the idle seat");
    await expectSeatState(page, I.id, "working");
    await i.control({ screen: { mode: "idle" } });
    await expectSeatState(page, I.id, "idle");

    // W: a real turn from peer mail, and it stays mid-turn.
    opData(await peer.op("msg.send", { target: W.id, text: "start a turn: wire the parser" }));
    await expect.poll(() => w.stdinLog(), { message: "W's turn", timeout: 60_000 }).toContain("start a turn: wire the parser");
    await expectSeatState(page, W.id, "working");
    // Let whatever follows the mail land whole before anything is compared.
    await sleep(2_000);
    await shot("0-staged");

    // ── 1. offboard-rules ──────────────────────────────────────────────────
    const s1 = await run("1", o, ["overseer", "agent", "offboard-rules"]);
    expectPass("1", s1, "overseer agent offboard-rules");
    const rules1 = s1.data.rules as RuleSet | undefined;
    soft(rules1, "step 1: data.rules are the defaults, with no harness key").toEqual(WALK_RULES);
    soft(rules1 !== undefined && "harness" in rules1, "step 1: data.rules has no harness key").toBe(false);
    const effective1 = (s1.data.effective ?? {}) as Record<string, RuleSet>;
    soft(Object.keys(effective1).length, "step 1: data.effective has an entry per harness the build offers").toBeGreaterThan(0);
    soft(Object.keys(effective1), "step 1: codex and claude are among them").toEqual(expect.arrayContaining(["codex", "claude"]));
    for (const [harness, set] of Object.entries(effective1)) {
      soft(set, `step 1: data.effective.${harness} equals the base rules`).toEqual(WALK_RULES);
    }

    // ── 2. offboard-status ─────────────────────────────────────────────────
    const s2 = await run("2", o, ["overseer", "agent", "offboard-status", input({ nodeIds: [W.id, I.id, R.id] })]);
    expectPass("2", s2, "overseer agent offboard-status");
    const rows2 = (Array.isArray(s2.out?.data) ? s2.out?.data : []) as ReadonlyArray<Record<string, unknown>>;
    soft(rows2.map((row) => row.seatId), "step 2: three rows, in the order asked, keyed seatId").toEqual([W.id, I.id, R.id]);
    soft(rows2[0]?.now, "step 2: W cannot be closed now, and says why").toEqual({ allowed: false, code: "working", reason: WALK_WORKING });
    soft(rows2[0]?.idleMinutes, "step 2: W is not motionless").toBeNull();
    soft(rows2[1]?.now, "step 2: I may be closed now").toEqual({ allowed: true });
    soft(rows2[2]?.now, "step 2: R may be closed now").toEqual({ allowed: true });
    for (const row of rows2) {
      const who = String(row.seatId);
      soft(typeof row.pastWindow, `step 2: ${who} has pastWindow`).toBe("boolean");
      soft(row.preferred, `step 2: ${who} prefers ask unless it is past the window`).toBe(row.pastWindow === true ? "now" : "ask");
      soft(typeof row.workMinutes, `step 2: ${who} has workMinutes`).toBe("number");
      soft(typeof row.worthCutting, `step 2: ${who} has worthCutting`).toBe("boolean");
      soft(row.sessionTokens === undefined || typeof row.sessionTokens === "number", `step 2: ${who} sessionTokens is a number or absent`).toBe(true);
    }

    // ── 3. offboard now: one working, one idle, one that is not a seat ─────
    const wInputBefore3 = await w.stdinLog();
    const wMailBefore3 = await crewMessageCount(page, CANVAS, W.id);
    const iInputBefore3 = await i.stdinLog();
    const iSessionBefore = await nodeSessionId(page, I.id);
    const s3 = await run("3", o, ["overseer", "agent", "offboard", input({ nodeIds: [W.id, I.id, "nope"], action: "now" })]);
    // A refused seat is not a command error: the result prints whole, and the exit code says so.
    expectPass("3", s3, "overseer agent offboard", 1);
    const results3 = (s3.data.results ?? []) as ReadonlyArray<Record<string, unknown>>;
    soft(results3.map((row) => row.seatId), "step 3: three rows, in the order asked").toEqual([W.id, I.id, "nope"]);
    soft(results3[0], "step 3: W is refused as working").toMatchObject({ ok: false, code: "working", reason: WALK_WORKING });
    soft(results3[1], "step 3: I is closed").toMatchObject({ ok: true, action: "now", outcome: "closed" });
    soft(results3[2], "step 3: nope is not a seat").toMatchObject({ ok: false, code: "not-a-seat", reason: WALK_NOT_A_SEAT });
    soft({ closed: s3.data.closed, asked: s3.data.asked, refused: s3.data.refused }, "step 3: the counts").toEqual({ closed: 1, asked: 0, refused: 2 });
    // On the canvas.
    await sleep(3_000);
    soft(await seatState(page, W.id), "step 3: W is still working").toBe("working");
    soft(await w.stdinLog(), "step 3: nothing was typed into W").toBe(wInputBefore3);
    soft(await crewMessageCount(page, CANVAS, W.id), "step 3: no mail was queued for W").toBe(wMailBefore3);
    await soft.poll(async () => isLive(await sessionOf(page, I.id)), { message: "step 3: I rests (no process on the seat)", timeout: 15_000 }).toBe(false);
    soft(await i.stdinLog(), "step 3: nothing was typed into I").toBe(iInputBefore3);
    soft(iSessionBefore, "step 3: I named a session before").toBe("sess-overseercli-idle");
    await soft.poll(() => nodeSessionId(page, I.id), { message: "step 3: I's node no longer names its old session", timeout: 15_000 }).not.toBe(iSessionBefore);
    await shot("3-after-now");

    // ── 4. offboard now: the seat with no process ──────────────────────────
    const s4 = await run("4", o, ["overseer", "agent", "offboard", input({ nodeIds: [R.id], action: "now" })]);
    expectPass("4", s4, "overseer agent offboard");
    const results4 = (s4.data.results ?? []) as ReadonlyArray<Record<string, unknown>>;
    soft(results4.length, "step 4: one row").toBe(1);
    soft(results4[0], "step 4: R is closed").toMatchObject({ seatId: R.id, ok: true, outcome: "closed" });
    soft(s4.data.refused, "step 4: nothing refused").toBe(0);

    // ── 5. offboard, ask (the default action): W gets the prompt as mail ──
    const s5 = await run("5", o, ["overseer", "agent", "offboard", input({ nodeIds: [W.id] })]);
    expectPass("5", s5, "overseer agent offboard");
    const results5 = (s5.data.results ?? []) as ReadonlyArray<Record<string, unknown>>;
    soft(results5.length, "step 5: one row").toBe(1);
    soft(results5[0], "step 5: W is asked").toMatchObject({ seatId: W.id, ok: true, action: "ask", outcome: "asked" });
    await soft.poll(() => w.stdinLog(), { message: "step 5: W's input, with the offboard prompt", timeout: 60_000 }).toContain(WALK_ASK_OPENS);
    await sleep(4_000);
    const wInputAfter5 = await w.stdinLog();
    soft(occurrences(wInputAfter5, WALK_ASK_OPENS), "step 5: the continue prompt reached W exactly once").toBe(1);
    soft(wInputAfter5.startsWith(wInputBefore3), "step 5: it came after what W already had").toBe(true);
    soft(wInputAfter5.slice(wInputBefore3.length), "step 5: it came as mail from the operator").toContain("mail from");
    await shot("5-after-ask");

    // ── 6. a mode with now is refused, and nothing reaches the seat ────────
    const iInputBefore6 = await i.stdinLog();
    const iLiveBefore6 = isLive(await sessionOf(page, I.id));
    const s6 = await run("6", o, ["overseer", "agent", "offboard", input({ nodeIds: [I.id], action: "now", mode: "rest" })]);
    expectError("6", s6);
    soft(s6.error.type, "step 6: an InputError").toBe("InputError");
    soft(`${String(s6.error.message ?? "")} ${s6.result.stderr}`, "step 6: it says mode goes only with ask").toContain(MODE_ONLY_WITH_ASK);
    await sleep(2_000);
    soft(await i.stdinLog(), "step 6: nothing reached I").toBe(iInputBefore6);
    soft(isLive(await sessionOf(page, I.id)), "step 6: I was not started or stopped by it").toBe(iLiveBefore6);

    // ── 7. offboard-configure: two fields ──────────────────────────────────
    const s7 = await run("7", o, ["overseer", "agent", "offboard-configure", input({ auto: { minutes: 180 }, worth: { workMinutes: 20 } })]);
    expectPass("7", s7, "overseer agent offboard-configure");
    const expected7 = {
      cacheWindowMinutes: 60,
      auto: { enabled: true, minutes: 180 },
      nudge: { enabled: false, minutes: 40 },
      worth: { workMinutes: 20, tokens: 200_000 },
    };
    const rules7 = s7.data.rules as RuleSet | undefined;
    soft(rules7?.auto?.minutes, "step 7: auto.minutes").toBe(180);
    soft(rules7?.worth, "step 7: worth").toEqual({ workMinutes: 20, tokens: 200_000 });
    soft(rules7, "step 7: everything else as in step 1, and no harness key").toEqual(expected7);
    // The Offboard settings page shows them.
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.locator(".settings-nav__item", { hasText: "Offboard" }).click();
    const settings = page.getByTestId("offboard-settings");
    await soft(settings, "step 7: the Offboard settings page opens").toBeVisible({ timeout: 10_000 });
    await soft(settings.getByTestId("offboard-auto-minutes"), "step 7: Settings shows the auto offboard at 180").toHaveValue("180", { timeout: 10_000 });
    await soft(settings.getByTestId("offboard-worth-work"), "step 7: Settings shows the work time at 20").toHaveValue("20", { timeout: 10_000 });
    await soft(settings.getByTestId("offboard-cache-window"), "step 7: the cache window is untouched").toHaveValue("60");
    await soft(settings.getByTestId("offboard-nudge-minutes"), "step 7: the idle nudge is untouched").toHaveValue("40");
    await soft(settings.getByTestId("offboard-worth-tokens"), "step 7: the session size is untouched").toHaveValue("200000");
    await shot("7-settings-offboard");
    await page.locator(".settings-panel__close").click();

    // ── 8. a change the rules refuse, and nothing is saved ────────────────
    const s8 = await run("8a", o, ["overseer", "agent", "offboard-configure", input({ nudge: { minutes: 60 } })]);
    expectError("8", s8);
    soft(s8.error.type, "step 8: error.type").toBe("InvalidArguments");
    soft(s8.error.message, "step 8: error.message").toBe(WALK_NUDGE_REFUSAL);
    const s8b = await run("8b", o, ["overseer", "agent", "offboard-rules"]);
    expectPass("8 (rules again)", s8b, "overseer agent offboard-rules");
    soft(s8b.data.rules, "step 8: the rules are exactly as step 7 left them").toEqual(expected7);

    // ── 9. an override for one harness, then everything back ──────────────
    const s9 = await run("9a", o, [
      "overseer",
      "agent",
      "offboard-configure",
      input({ harness: { claude: { cacheWindowMinutes: 300, auto: { minutes: 300 } } } }),
    ]);
    expectPass("9", s9, "overseer agent offboard-configure");
    soft((s9.data.rules as RuleSet | undefined)?.harness?.claude, "step 9: data.rules.harness.claude is the override").toEqual({
      cacheWindowMinutes: 300,
      auto: { minutes: 300 },
    });
    const effective9 = (s9.data.effective ?? {}) as Record<string, RuleSet>;
    soft(effective9.claude?.cacheWindowMinutes, "step 9: claude's cache window").toBe(300);
    soft(effective9.claude?.auto?.minutes, "step 9: claude's auto offboard").toBe(300);
    soft(baseOf(effective9.claude), "step 9: claude differs from the installation's rules").not.toEqual(expected7);
    const untouched = Object.entries(effective9).filter(
      ([harness, set]) => harness !== "claude" && set.cacheWindowMinutes === 60 && set.auto?.minutes === 180,
    );
    soft(untouched.length, `step 9: another harness still has 60 and 180 (${Object.keys(effective9).join(", ")})`).toBeGreaterThan(0);
    for (const [harness, set] of Object.entries(effective9)) {
      if (harness !== "claude") soft(baseOf(set), `step 9: ${harness} is not touched by claude's override`).toEqual(expected7);
    }
    const s9b = await run("9b", o, [
      "overseer",
      "agent",
      "offboard-configure",
      input({ harness: { claude: null }, auto: { minutes: 120 }, worth: { workMinutes: 30 } }),
    ]);
    expectPass("9 (restore)", s9b, "overseer agent offboard-configure");
    const rules9b = s9b.data.rules as RuleSet | undefined;
    soft(rules9b, "step 9: the rules are step 1's again").toEqual(WALK_RULES);
    soft(rules9b !== undefined && "harness" in rules9b, "step 9: with no harness key").toBe(false);

    // ── 10. a seat without the grant ───────────────────────────────────────
    const s10 = await run("10", n, ["overseer", "agent", "offboard-rules"]);
    expectError("10", s10);
    soft(`${String(s10.error.message ?? "")} ${s10.result.stderr}`, "step 10: refused as not an overseer").toContain(NOT_AN_OVERSEER);
    soft(`${s10.result.stdout}${s10.result.stderr}`, "step 10: no rules printed").not.toContain("cacheWindowMinutes");
    testInfo.annotations.push({ type: "step-10-error-type", description: String(s10.error.type) });
    await shot("10-at-the-end");
  } catch (error) {
    await shot("on-failure").catch(() => undefined);
    throw error;
  } finally {
    const lines = chunks
      .join("")
      .split("\n")
      .filter((line) => line.includes("[offboard]"));
    await writeFile(join(dir, "offboard-log.txt"), `${lines.join("\n")}\n`, "utf8").catch(() => undefined);
    await testInfo.attach("offboard-log", { body: lines.join("\n"), contentType: "text/plain" }).catch(() => undefined);
    await junto.close();
  }
});
