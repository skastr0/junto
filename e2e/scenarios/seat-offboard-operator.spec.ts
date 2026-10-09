import { readSeatSession } from "../harness/seat-session";
import { modelFixture, modelSeatSession, modelMessagesWire, modelSeat } from "../harness/model";
import { readModelSeat, grantOverseer } from "../harness/model";
/** Operator offboard gestures and settings, without waits for product time to pass. */
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
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
import { type SeatOffboardProgress } from "../../src/shared/seat-sessions";
import { seededHarnessBinDir } from "../harness/agent-harness-fixture";
import { crewOccupySeat, crewPlayFactory, crewSeat, crewSeatDir, crewSeatsDir, installCrewSeatHarness, type CrewSeat, type WorkEnvelope } from "../harness/crew-fixture";
import { expect, launchJunto, test, type JuntoHandle } from "../harness/launch";
import { type Sandbox } from "../harness/sandbox";

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

/** nodes/SeatOffboard.tsx:252 and rts/SeatOffboardKey.tsx:21. */
const TIP_ONE = "Offboard: end this agent's session";
const LINE_ASKED_REST = "Asked to offboard and rest.";
/** sessions/OffboardControls.tsx:64-65. */
const SESSIONS_WHERE =
  "To end this agent's session, use Offboard on the seat: in the popup above its card, or in the bottom bar for one agent or a whole selection.";

/** The rules every UI walk runs on: the shortest legal window, and no rule acting by itself. */
const WALK_RULES: OffboardRulesPatch = {
  cacheWindowMinutes: 2,
  nudge: { enabled: false, minutes: 1 },
  auto: { enabled: false },
};

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

const bindingOf = (nodeId: string): string => `local:${nodeId}`;
const sessionIdOf = (nodeId: string): string => `sess-operator-${nodeId}-0001`;

/** A fake Codex seat. With `session`, its node names a session to close (seat-offboard.spec.ts:77-80). */
const sessionPins = new WeakMap<Seat, string>();
const seatNode = (id: string, label: string, x: number, y: number, session = true): Seat => {
  const seat = modelSeat({ id, label, x, y });
  if (session) sessionPins.set(seat, sessionIdOf(id));
  return seat;
};

/** Cards are 240 by 96 (harness/sandbox.ts:539-540): three to a row, clear of each other. */
const COLUMN = [100, 400, 700] as const;
const ROW = [220, 440] as const;

const fixtureOf = (nodes: ReadonlyArray<Node>, mail: ReadonlyArray<readonly [from: string, to: string]> = []): ModelFixture => {
  const edges: Wire[] = mail.map(([from, to]) => modelMessagesWire(`e-${from}-${to}`, from, to, [...nodes]));
  return modelFixture([...nodes], edges, nodes.flatMap(node => {
    const pin = node.kind === "agent" ? sessionPins.get(node) : undefined;
    return node.kind === "agent" && pin ? [modelSeatSession(node, pin)] : [];
  }));
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

/** The machine's private pin for this seat. */
const sessionPin = async (sandbox: Sandbox, nodeId: string): Promise<string | undefined> =>
  readSeatSession(sandbox, nodeId);

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
  readonly offboardLines: () => ReadonlyArray<string>;
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
  const junto = await launchJunto({
    seedModels: { [CANVAS]: setup.doc },
    // Planted before afterSeed (harness/launch.ts:480-487), so the fake codex below is not overwritten.
    ...(setup.harnessInstalls !== undefined ? { seedHarnessInstalls: setup.harnessInstalls } : {}),
    afterSeed: installSeatHarness(setup.transcripts ?? []),
    extraEnv: { JUNTO_PTY_TRACE: "1" },
    windowContentSize: { width: 1440, height: 1000 },
  });
  const chunks: string[] = [];
  const keep = (chunk: Buffer): void => {
    chunks.push(String(chunk));
  };
  junto.app.process().stdout?.on("data", keep);
  junto.app.process().stderr?.on("data", keep);
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
    mark("the app is up");
    await body({ junto, sandbox: junto.sandbox, dir, offboardLines, mark, shot, step });
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

const paint = (locator: Locator): Promise<string> =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return `background ${style.backgroundColor}, border ${style.borderTopColor}, text ${style.color}`;
  });

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

/** The open seat terminal (seat-session-checklist.spec.ts:68, 260-275). */
const TERMINAL_SURFACE = ".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface";

/** Stop a seat's process as the operator's Stop does, and wait until it is gone. */
const stopSeat = async (ctx: Walk, nodeId: string, pid: number): Promise<number> => {
  await ctx.junto.page.evaluate((id) => window.junto!.terminalKill(id), bindingOf(nodeId));
  await expect.poll(() => pidAlive(pid), { message: `${nodeId}: its process after the operator's stop`, timeout: 30_000 }).toBe(false);
  return ctx.mark(`${nodeId} was stopped and rests`);
};

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
      expect(await sessionPin(sandbox, "tia"), "Tia still names her session after the grant").toBe(sessionIdOf("tia"));
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
      soft(await sessionPin(sandbox, "tia"), "the seat no longer names the closed session").not.toBe(sessionIdOf("tia"));
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
      soft(await sessionPin(sandbox, "tia"), "it does not name the closed session").not.toBe(sessionIdOf("tia"));
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
