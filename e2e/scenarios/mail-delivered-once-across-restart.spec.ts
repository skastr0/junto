import { modelFixture, modelMessagesWire, modelSeat, type ModelFixture } from "../harness/model";
/**
 * Mail is delivered once, across a quit and a reopen [fake-tui].
 *
 *   bun run test:e2e:fast e2e/scenarios/mail-delivered-once-across-restart.spec.ts
 *
 * The defect this guards against: a delivered mail's receipt was not written,
 * so after Junto was quit and reopened the same mail (same message id), which
 * had already been typed into its seat, read as pending. The boot scan then
 * woke the seat by itself and typed the mail a second time, into a fresh
 * process.
 *
 *   M1  a mail delivered before a quit is not typed again after reopening
 *   M2  a mail that could not be delivered before the quit is delivered once after
 *   M3  a stopped seat that had read its mail is not woken by a restart
 *
 * Two fake Codex seats on a playing canvas: Ada sends, Bo receives. Each
 * process of a seat has a folder of its own (the wrapper gives launch N the
 * folder gen<N>, and the patched fake keeps its input log there and writes
 * the time into `alive` ten times a second), so what a process was typed is
 * its own, and "no new process" and "nothing typed" can be read without a pid.
 *
 * Each test quits the app and starts a second one by hand on the same
 * sandbox, with the first one's environment and the quit question answered
 * as harness/launch.ts answers it. The ending writes the evidence first and
 * then has ENDING_DEADLINE_MS to close everything.
 *
 * Evidence, in MAIL_RESTART_DIR when set and the test's output folder
 * otherwise: `<id>-mail-log.txt` (the timeline, main's delivery and wake
 * lines, every seat's input per generation) and screenshots.
 */
import { appendFile, chmod, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { Locator, Page, TestInfo } from "@playwright/test";
import { _electron as electron, type ElectronApplication } from "playwright-core";
import type { AgentSeatStateEvent } from "../../src/shared/agent-seat-state";
import type { Seat } from "../../src/shared/model";
import { buildOnboardNudge } from "../../src/shared/managed-terminal-injection";
import type { TerminalSessionSummary } from "../../src/shared/terminal";
import { seededHarnessBinDir } from "../harness/agent-harness-fixture";
import {
  crewMessageCount,
  crewOccupySeat,
  crewPlayFactory,
  crewReceipts,
  CrewSeat,
  crewSeatDir,
  crewSeatsDir,
  installCrewSeatHarness,
  type CrewReceiptFacts,
  type WorkEnvelope,
} from "../harness/crew-fixture";
import { expect, launchJunto, test, type JuntoHandle } from "../harness/launch";
import type { Sandbox } from "../harness/sandbox";

const CANVAS = "mailrestart";
const NUDGE = buildOnboardNudge();
const SURFACE = ".workbench-pane:not(.workbench-pane--parked) .native-terminal-surface";

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

/** After a reopen: how long the seat is watched for a start or a retype nobody asked for. The boot scan runs 10 s in (ipc.ts:2688). */
const AFTER_REOPEN_WATCH_MS = 60_000;
/** After the seat is started by hand: how long its new process is watched for the old mail. */
const AFTER_START_WATCH_MS = 20_000;
/** Mail, a receipt or a seat's start must be seen within this. */
const DELIVERY_MS = 60_000;
/** After a quit, every process the app held must be gone within this. */
const GONE_AFTER_QUIT_MS = 15_000;
/** Everything after a walk's last check (closing apps, the harness teardown) gets this long, then is left behind. */
const ENDING_DEADLINE_MS = 60_000;
const HEARTBEAT_MS = 100;
const HEARTBEAT_STALE_MS = 700;
const POLL_MS = 50;

const soft = expect.configure({ soft: true });

// ---------------------------------------------------------------------------
// Canvas
// ---------------------------------------------------------------------------

const ADA = modelSeat({ id: "ada", label: "Ada", x: 120, y: 200 });
const BO = modelSeat({ id: "bo", label: "Bo", x: 480, y: 200 });
const DOC: ModelFixture = modelFixture([ADA, BO], [modelMessagesWire("e-ada-bo", ADA.id, BO.id, [ADA, BO])]);

// ---------------------------------------------------------------------------
// Fake seat harness: one folder per process generation
// ---------------------------------------------------------------------------

/** The fake, changed so each launch keeps its files in the folder the wrapper names and says ten times a second that it runs. */
const patchFake = (source: string): string => {
  const edits: ReadonlyArray<readonly [string, string]> = [
    ["const dir = path.join(", "const dir = process.env.WALK_SEAT_DIR || path.join("],
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

/** The crew fake (patched), behind a wrapper that gives every launch of a seat its own folder gen<N> and leaves a launch.<N> mark. */
const installSeatHarness = async (sandbox: Sandbox): Promise<void> => {
  await installCrewSeatHarness(sandbox);
  const bin = seededHarnessBinDir(sandbox);
  const fake = join(bin, "codex-crew-fake");
  await rename(join(bin, "codex"), fake);
  await writeFile(fake, patchFake(await readFile(fake, "utf8")), "utf8");
  await chmod(fake, 0o755);
  const script = [
    "#!/bin/sh",
    "# [fake-tui] mail-delivered-once-across-restart: one folder per generation, then become the crew fake.",
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

/** One generation of a seat (1 is its first process). */
const genSeat = (sandbox: Sandbox, nodeId: string, generation: number): CrewSeat =>
  new CrewSeat(join(seatDir(sandbox, nodeId), `gen${String(generation)}`));

/** How many processes this seat has had. */
const launches = async (sandbox: Sandbox, nodeId: string): Promise<number> =>
  (await readdir(seatDir(sandbox, nodeId)).catch(() => [] as string[])).filter((name) => /^launch\.\d+$/u.test(name)).length;

/** Every generation's input, oldest first: only that process writes its log. */
const inputsOf = async (sandbox: Sandbox, nodeId: string): Promise<ReadonlyArray<string>> => {
  const count = await launches(sandbox, nodeId);
  return Promise.all(Array.from({ length: count }, (_unused, index) => genSeat(sandbox, nodeId, index + 1).stdinLog()));
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const lastAlive = async (seat: CrewSeat): Promise<number | undefined> => {
  const at = Number(await readFile(join(seat.dir, "alive"), "utf8").catch(() => ""));
  return Number.isFinite(at) && at > 0 ? at : undefined;
};

const isAlive = async (seat: CrewSeat): Promise<boolean> => {
  const at = await lastAlive(seat);
  return at !== undefined && Date.now() - at < HEARTBEAT_STALE_MS;
};

const waitGone = async (seat: CrewSeat, withinMs: number): Promise<boolean> => {
  const until = Date.now() + withinMs;
  while (Date.now() < until) {
    if (!(await isAlive(seat))) return true;
    await sleep(POLL_MS);
  }
  return false;
};

/** Is any process of this seat running? */
const anyAlive = async (sandbox: Sandbox, nodeId: string): Promise<boolean> => {
  const count = await launches(sandbox, nodeId);
  for (let generation = 1; generation <= count; generation += 1) {
    if (await isAlive(genSeat(sandbox, nodeId, generation))) return true;
  }
  return false;
};

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

// ---------------------------------------------------------------------------
// App-side reads
// ---------------------------------------------------------------------------

const seatState = async (page: Page, nodeId: string): Promise<string> => {
  const events = (await page.evaluate(() => window.junto!.agentSeatStateSnapshot())) as ReadonlyArray<AgentSeatStateEvent>;
  return events.find((event) => event.bindingId === `local:${nodeId}`)?.state ?? "none";
};

const expectSeatState = async (page: Page, nodeId: string, state: string): Promise<void> => {
  await expect.poll(() => seatState(page, nodeId), { message: `seat ${nodeId} state`, timeout: 30_000 }).toBe(state);
};

const isLiveOnSeat = async (page: Page, nodeId: string): Promise<boolean> => {
  const session = (await page.evaluate((id) => window.junto!.terminalGet(id), `local:${nodeId}`).catch(() => undefined)) as
    | TerminalSessionSummary
    | undefined;
  return session?.status === "running" || session?.status === "starting";
};

const opData = (envelope: WorkEnvelope): Record<string, unknown> => {
  expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
  return ((envelope as { readonly data?: unknown }).data ?? {}) as Record<string, unknown>;
};

/** The mail's own receipt on the receiver's mailbox, read through the app (crew-fixture.ts crewReceipts). */
const receiptOf = async (page: Page, nodeId: string, messageId: string): Promise<CrewReceiptFacts | undefined> =>
  (await crewReceipts(page, CANVAS, nodeId)).find((row) => row.messageId === messageId);

/** Start a seat by hand, the way opening its terminal does. */
const startByHand = async (page: Page, node: Seat): Promise<void> => {
  await page.evaluate(
    async ([canvasName, seatNode]) => {
      await window.junto!.modelStart({ canvas: canvasName, id: seatNode.id }).catch(() => undefined);
    },
    [CANVAS, node] as const,
  );
};

// ---------------------------------------------------------------------------
// Quit and reopen on the same sandbox
// ---------------------------------------------------------------------------

const mainEnvOf = (junto: JuntoHandle): Promise<Record<string, string>> =>
  junto.app.evaluate(() => {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) if (typeof value === "string") out[key] = value;
    return out;
  });

/** Quit the app and start a second one by hand on the same sandbox, with the first one's environment and launch.ts's arguments. */
const quitAndReopen = async (junto: JuntoHandle, env: Record<string, string>, betweenRuns: () => Promise<void>): Promise<ElectronApplication> => {
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

// ---------------------------------------------------------------------------
// The walk: one app pair, evidence first, an ending with a deadline
// ---------------------------------------------------------------------------

type Walk = {
  readonly junto: JuntoHandle;
  readonly sandbox: Sandbox;
  /** A fact for the timeline, and an annotation when `as` is given. */
  readonly mark: (line: string, as?: string) => number;
  readonly shot: (page: Page, name: string) => Promise<void>;
  /** Quit the first app and reopen on the same sandbox; hands back the second app's page. */
  readonly reopen: () => Promise<Page>;
};

const walk = async (testInfo: TestInfo, id: string, body: (walk: Walk) => Promise<void>): Promise<void> => {
  const dir = process.env.MAIL_RESTART_DIR ?? testInfo.outputPath();
  await mkdir(dir, { recursive: true });
  const junto = await launchJunto({ seedModels: { [CANVAS]: DOC }, afterSeed: installSeatHarness, extraEnv: { JUNTO_PTY_TRACE: "1" } });
  const { sandbox } = junto;
  const chunks: string[] = [];
  const reopened: ElectronApplication[] = [];
  const tap = (app: ElectronApplication): void => {
    const keep = (chunk: Buffer): void => {
      chunks.push(String(chunk));
    };
    app.process().stdout?.on("data", keep);
    app.process().stderr?.on("data", keep);
  };
  tap(junto.app);
  const timeline: string[] = [];
  const mark = (line: string, as?: string): number => {
    const at = Date.now();
    timeline.push(`${new Date(at).toISOString()} ${line}`);
    if (as !== undefined) testInfo.annotations.push({ type: `${id}-${as}`, description: line });
    return at;
  };
  const shot = async (page: Page, name: string): Promise<void> => {
    await page.screenshot({ path: join(dir, `${id}-${name}.png`), timeout: 15_000 }).catch((error: unknown) => {
      mark(`frame ${name} could not be taken: ${String(error)}`);
    });
  };
  let current: Page = junto.page;
  const reopen = async (): Promise<Page> => {
    const env = await mainEnvOf(junto);
    mark("quitting Junto");
    const app = await quitAndReopen(junto, env, async () => {
      // Every process the first app held is gone with it.
      for (const node of [ADA, BO]) {
        const count = await launches(sandbox, node.id);
        for (let generation = 1; generation <= count; generation += 1) {
          const gone = await waitGone(genSeat(sandbox, node.id, generation), GONE_AFTER_QUIT_MS);
          if (!gone) mark(`${node.id} generation ${String(generation)} was STILL running ${String(GONE_AFTER_QUIT_MS)} ms after the quit`);
        }
      }
    });
    reopened.push(app);
    tap(app);
    current = await app.firstWindow();
    await expect(current.locator(".react-flow")).toBeVisible({ timeout: 60_000 });
    await current.waitForFunction(() => Boolean(window.junto?.modelOpen), undefined, { timeout: 30_000 });
    mark("Junto is open again");
    return current;
  };

  let failure: unknown;
  try {
    await expect(junto.page.locator(".react-flow")).toBeVisible({ timeout: 30_000 });
    await body({ junto, sandbox, mark, shot, reopen });
  } catch (error) {
    failure = error;
    await shot(current, "on-failure");
  }

  // The evidence is written before anything is closed.
  const inputs: string[] = [];
  for (const node of [ADA, BO]) {
    const generations = await inputsOf(sandbox, node.id).catch(() => [] as ReadonlyArray<string>);
    generations.forEach((input, index) => inputs.push(`### ${node.id}, generation ${String(index + 1)}`, JSON.stringify(input), ""));
    if (generations.length === 0) inputs.push(`### ${node.id}: never started`, "");
  }
  const failed = testInfo.errors.map((error) => (error.message ?? String(error.value ?? "")).split("\n").slice(0, 6).join("\n"));
  const logPath = join(dir, `${id}-mail-log.txt`);
  const text = [
    `# ${id}: ${testInfo.title}`,
    "",
    `## failed checks (${String(failed.length + (failure === undefined ? 0 : 1))})`,
    ...failed.flatMap((message) => [message, ""]),
    ...(failure === undefined ? [] : [String(failure), ""]),
    "## main: delivery and wake lines",
    ...chunks
      .join("")
      .split("\n")
      .filter((line) => line.includes("[delivery]") || line.includes("[wake]")),
    "",
    "## test timeline",
    ...timeline,
    "",
    "## seat input logs, one block per process",
    ...inputs,
  ].join("\n");
  await writeFile(logPath, text, "utf8").catch(() => undefined);
  await testInfo.attach(`${id}-mail-log`, { body: text, contentType: "text/plain" }).catch(() => undefined);

  // The ending: close what this test opened, then the harness's own teardown, all inside one deadline.
  let pending = "closing the reopened app";
  let closeError: unknown;
  const ending = (async (): Promise<void> => {
    for (const app of reopened) await app.close().catch(() => undefined);
    pending = "the harness teardown";
    await junto.close().catch((error: unknown) => {
      closeError = error;
    });
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finished = await Promise.race([
    ending.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ENDING_DEADLINE_MS);
    }),
  ]);
  clearTimeout(timer);
  if (!finished) {
    testInfo.annotations.push({ type: `${id}-ending`, description: `ending did not finish in 60 s: ${pending}` });
    await appendFile(logPath, `\n## ending\nending did not finish in 60 s: ${pending}\n`, "utf8").catch(() => undefined);
  }
  if (failure !== undefined) throw failure;
  if (finished && closeError !== undefined) throw closeError;
};

/** Play the canvas and start both seats' fakes. */
const stage = async (junto: JuntoHandle): Promise<{ readonly ada: CrewSeat; readonly bo: CrewSeat }> => {
  const { page, sandbox } = junto;
  await crewPlayFactory(page);
  const start = async (node: Seat): Promise<CrewSeat> => {
    const seat = genSeat(sandbox, node.id, 1);
    await crewOccupySeat(page, CANVAS, node, seat);
    await expectSeatState(page, node.id, "idle");
    return seat;
  };
  return { ada: await start(ADA), bo: await start(BO) };
};

/** A snapshot of everything a watch must find unchanged. */
const snapshotOf = async (sandbox: Sandbox): Promise<string> =>
  JSON.stringify({
    adaProcesses: await launches(sandbox, ADA.id),
    boProcesses: await launches(sandbox, BO.id),
    adaInputs: await inputsOf(sandbox, ADA.id),
    boInputs: await inputsOf(sandbox, BO.id),
  });

// ===========================================================================

test("M1 [fake-tui] a mail delivered before a quit is not typed again after reopening", async ({}, testInfo) => {
  // Expected wall time: about 3 minutes (the 60 s and 20 s watches, two app starts, one quit).
  test.setTimeout(8 * 60_000);
  const TEXT = "restart-mail-one: typed once only";
  await walk(testInfo, "M1", async ({ junto, sandbox, mark, shot, reopen }) => {
    const { page } = junto;
    const { ada, bo } = await stage(junto);

    // Ada mails Bo: delivered, typed once, and the receipt says so.
    const sent = opData(await ada.op("msg.send", { target: BO.id, text: TEXT }));
    const messageId = String(sent.messageId);
    mark(`message id ${messageId}; msg.send answered delivery=${JSON.stringify(sent.delivery)}`, "message-id");
    await expect.poll(() => bo.stdinLog(), { message: "Bo's first process is typed the mail", timeout: DELIVERY_MS }).toContain(TEXT);
    await expect
      .poll(async () => (await receiptOf(page, BO.id, messageId))?.deliveredAt, { message: "the mail's own receipt carries deliveredAt", timeout: DELIVERY_MS })
      .toBeDefined();
    const receiptBefore = await receiptOf(page, BO.id, messageId);
    mark(`receipt before the quit: ${JSON.stringify(receiptBefore ?? null)}`, "receipt-before");
    soft(sent.delivery, "msg.send answered delivered").toBe("delivered");
    const sentView = opData(await ada.op("msg.sent", {}));
    const mine = ((sentView.items ?? []) as ReadonlyArray<Record<string, unknown>>).find((item) => item.messageId === messageId);
    mark(`Ada's msg sent view of it: ${JSON.stringify(mine ?? null)}`, "msg-sent-view");
    soft(mine, "Ada's msg sent lists the mail").toBeDefined();
    soft(JSON.stringify(mine ?? {}), "and reports it delivered").toContain("deliveredAt");

    // Bo's turn ends.
    await bo.control({ screen: { mode: "idle" } });
    await expectSeatState(page, BO.id, "idle");
    await sleep(1_500);
    expect(occurrences(await bo.stdinLog(), TEXT), "the mail was typed once into Bo's first process").toBe(1);
    const countBefore = await crewMessageCount(page, CANVAS, BO.id);
    await shot(page, "1-delivered-before-the-quit");

    // Quit, reopen, and let the canvas play: a paused canvas would hide a retype.
    const second = await reopen();
    mark(`canvas pause state on reopening: ${(await second.getByTestId("factory-pause").getAttribute("data-pause-state").catch(() => null)) ?? "not read"}`, "pause-state");
    await crewPlayFactory(second);
    const before = await snapshotOf(sandbox);
    await sleep(AFTER_REOPEN_WATCH_MS);
    const after = await snapshotOf(sandbox);
    const boInputs = await inputsOf(sandbox, BO.id);
    mark(`Bo after ${String(AFTER_REOPEN_WATCH_MS)} ms open: processes=${String(boInputs.length)}, inputs=${JSON.stringify(boInputs)}`, "generations-after-reopen");
    // Core claim: Junto did not start Bo, and typed the mail nowhere.
    expect(await launches(sandbox, BO.id), "Junto did not start Bo by itself after the reopen").toBe(1);
    expect(boInputs.slice(1).reduce((sum, input) => sum + occurrences(input, TEXT), 0), "the delivered mail was typed 0 times after the reopen").toBe(0);
    soft(await isLiveOnSeat(second, BO.id), "no process is on Bo's seat").toBe(false);
    soft(await anyAlive(sandbox, BO.id), "no process of Bo's is running").toBe(false);
    soft(after, "nothing was started or typed anywhere during the watch").toBe(before);
    const receiptAfter = await receiptOf(second, BO.id, messageId);
    mark(`receipt after the reopen: ${JSON.stringify(receiptAfter ?? null)}`, "receipt-after");
    soft(receiptAfter?.deliveredAt, "the receipt still reads delivered, with the same time").toBe(receiptBefore?.deliveredAt);
    soft(await crewMessageCount(second, CANVAS, BO.id), "Bo's message count is unchanged").toBe(countBefore);
    await shot(second, "2-after-the-reopen");

    // Bo is started by hand: its new process is not typed the old mail.
    await startByHand(second, BO);
    await expect.poll(() => launches(sandbox, BO.id), { message: "Bo starts when asked", timeout: DELIVERY_MS }).toBe(2);
    await sleep(AFTER_START_WATCH_MS);
    const fresh = await genSeat(sandbox, BO.id, 2).stdinLog();
    mark(`Bo's process started by hand received: ${JSON.stringify(fresh)}`, "fresh-process-input");
    mark(`onboarding nudges in it: ${String(occurrences(fresh, NUDGE))} (allowed, recorded)`, "fresh-process-nudges");
    expect(occurrences(fresh, TEXT), "the old mail was typed 0 times into the process started by hand").toBe(0);
    soft(fresh, "nor any mail line at all").not.toContain("mail from");
    soft((await receiptOf(second, BO.id, messageId))?.deliveredAt, "the receipt is still the same").toBe(receiptBefore?.deliveredAt);
    await shot(second, "3-started-by-hand");
  });
});

test("M2 [fake-tui] a mail that could not be delivered before the quit is delivered once after", async ({}, testInfo) => {
  // Expected wall time: about 3.5 minutes (up to 60 s for the wake, the 60 s watch, two app starts, one quit).
  test.setTimeout(9 * 60_000);
  const TEXT = "restart-mail-two: held then once";
  const DRAFT = "half a thought";
  await walk(testInfo, "M2", async ({ junto, sandbox, mark, shot, reopen }) => {
    const { page } = junto;
    const { ada, bo } = await stage(junto);

    // The operator has an unsent draft in Bo's box: mail for Bo is held.
    await page.locator(`.react-flow__node[data-id="${BO.id}"]`).dblclick();
    const surface: Locator = page.locator(SURFACE);
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await surface.locator(".xterm-screen").click();
    await page.keyboard.type(DRAFT);
    await expect.poll(() => bo.stdinLog(), { message: "the draft reached Bo's box", timeout: 15_000 }).toContain(DRAFT);
    await sleep(800);

    const sent = opData(await ada.op("msg.send", { target: BO.id, text: TEXT }));
    const messageId = String(sent.messageId);
    mark(`message id ${messageId}; msg.send answered delivery=${JSON.stringify(sent.delivery)}`, "message-id");
    soft(sent.delivery, "msg.send did not answer delivered").not.toBe("delivered");
    await sleep(3_000);
    const receiptBefore = await receiptOf(page, BO.id, messageId);
    mark(`receipt before the quit: ${JSON.stringify(receiptBefore ?? null)}`, "receipt-before");
    expect(receiptBefore?.deliveredAt, "the held mail has no delivery receipt").toBeUndefined();
    expect(await bo.stdinLog(), "nothing of the mail was typed over the draft").not.toContain(TEXT);
    await shot(page, "1-held-by-the-draft");

    // Quit and reopen. What the source says: the boot scan, ten seconds after
    // start, delivers every pending message (work/message-delivery.ts
    // onBooted, :502-530; ipc.ts:2688), and a pending message whose seat has
    // no process starts that seat (deliver, :314-319, `wake` :440-455), under
    // the pause law. So on a playing canvas Bo is woken for it, by Junto.
    const second = await reopen();
    mark(`canvas pause state on reopening: ${(await second.getByTestId("factory-pause").getAttribute("data-pause-state").catch(() => null)) ?? "not read"}`, "pause-state");
    await crewPlayFactory(second);
    const reopenedAt = Date.now();
    let wokenAt: number | undefined;
    while (Date.now() < reopenedAt + AFTER_REOPEN_WATCH_MS) {
      if ((await launches(sandbox, BO.id)) >= 2) {
        wokenAt = Date.now();
        break;
      }
      await sleep(250);
    }
    mark(
      wokenAt === undefined
        ? `Junto did NOT wake Bo for the pending mail within ${String(AFTER_REOPEN_WATCH_MS)} ms`
        : `Junto woke Bo for the pending mail ${String(wokenAt - reopenedAt)} ms after the canvas played`,
      "woken-by-itself",
    );
    soft(wokenAt, "pending mail wakes its seat after a reopen (the boot scan)").toBeDefined();
    if (wokenAt === undefined) {
      await startByHand(second, BO);
      await expect.poll(() => launches(sandbox, BO.id), { message: "Bo starts when asked", timeout: DELIVERY_MS }).toBeGreaterThanOrEqual(2);
      mark("Bo was started by hand");
    }

    // Bo runs with an empty box: the mail is typed, and its receipt written.
    const typedIn = async (): Promise<number> => (await inputsOf(sandbox, BO.id)).reduce((sum, input) => sum + occurrences(input, TEXT), 0);
    await expect.poll(typedIn, { message: "the pending mail is typed into Bo", timeout: DELIVERY_MS }).toBeGreaterThanOrEqual(1);
    await soft
      .poll(async () => (await receiptOf(second, BO.id, messageId))?.deliveredAt, { message: "its receipt gets deliveredAt", timeout: DELIVERY_MS })
      .toBeDefined();
    const receiptAfter = await receiptOf(second, BO.id, messageId);
    mark(`receipt after delivery: ${JSON.stringify(receiptAfter ?? null)}`, "receipt-after");
    await shot(second, "2-delivered-after-the-reopen");

    // And not a second time.
    await sleep(AFTER_REOPEN_WATCH_MS);
    const inputs = await inputsOf(sandbox, BO.id);
    const perGeneration = inputs.map((input) => occurrences(input, TEXT));
    mark(`Bo's processes=${String(inputs.length)}, the mail per generation=${JSON.stringify(perGeneration)}, inputs=${JSON.stringify(inputs)}`, "generations");
    expect(perGeneration.reduce((sum, count) => sum + count, 0), "the mail was typed exactly once, across both runs").toBe(1);
    expect(perGeneration[0], "and not into the process that held the draft").toBe(0);
    soft((await receiptOf(second, BO.id, messageId))?.deliveredAt, "the receipt did not change again").toBe(receiptAfter?.deliveredAt);
    soft(await launches(sandbox, BO.id), "Bo was started once after the reopen").toBe(2);
    await shot(second, "3-not-typed-again");
  });
});

test("M3 [fake-tui] a stopped seat that had read its mail is not woken by a restart", async ({}, testInfo) => {
  // Expected wall time: about 2.5 minutes (the 60 s watch, two app starts, one quit).
  test.setTimeout(7 * 60_000);
  const TEXT = "restart-mail-three: read, then rest";
  await walk(testInfo, "M3", async ({ junto, sandbox, mark, shot, reopen }) => {
    const { page } = junto;
    const { ada, bo } = await stage(junto);

    const sent = opData(await ada.op("msg.send", { target: BO.id, text: TEXT }));
    const messageId = String(sent.messageId);
    mark(`message id ${messageId}; msg.send answered delivery=${JSON.stringify(sent.delivery)}`, "message-id");
    await expect.poll(() => bo.stdinLog(), { message: "Bo is typed the mail", timeout: DELIVERY_MS }).toContain(TEXT);
    await expect
      .poll(async () => (await receiptOf(page, BO.id, messageId))?.deliveredAt, { message: "the mail's receipt carries deliveredAt", timeout: DELIVERY_MS })
      .toBeDefined();
    const receiptBefore = await receiptOf(page, BO.id, messageId);
    mark(`receipt before the quit: ${JSON.stringify(receiptBefore ?? null)}`, "receipt-before");

    // The operator stops Bo: Stop, then confirm, in its terminal view (terminal-kill-ux.ts).
    await page.locator(`.react-flow__node[data-id="${BO.id}"]`).dblclick();
    const surface = page.locator(SURFACE);
    await expect(surface).toBeVisible({ timeout: 30_000 });
    await surface.getByRole("button", { name: "Stop this agent's process", exact: true }).click();
    await surface.getByRole("button", { name: "Confirm: stop this agent's process", exact: true }).click();
    await expect.poll(() => isLiveOnSeat(page, BO.id), { message: "Bo's process is stopped", timeout: 20_000 }).toBe(false);
    expect(await waitGone(bo, 15_000), "Bo's process is gone").toBe(true);
    mark("the operator stopped Bo");
    const countBefore = await crewMessageCount(page, CANVAS, BO.id);
    await shot(page, "1-stopped-by-the-operator");

    const second = await reopen();
    mark(`canvas pause state on reopening: ${(await second.getByTestId("factory-pause").getAttribute("data-pause-state").catch(() => null)) ?? "not read"}`, "pause-state");
    await crewPlayFactory(second);
    const before = await snapshotOf(sandbox);
    await sleep(AFTER_REOPEN_WATCH_MS);
    const inputs = await inputsOf(sandbox, BO.id);
    mark(`Bo after ${String(AFTER_REOPEN_WATCH_MS)} ms open: processes=${String(inputs.length)}, inputs=${JSON.stringify(inputs)}`, "generations-after-reopen");
    expect(await launches(sandbox, BO.id), "Bo stays down: Junto did not start it").toBe(1);
    expect(inputs.slice(1).reduce((sum, input) => sum + occurrences(input, TEXT), 0), "the mail was typed 0 times after the reopen").toBe(0);
    soft(await isLiveOnSeat(second, BO.id), "no process is on Bo's seat").toBe(false);
    soft(await anyAlive(sandbox, BO.id), "no process of Bo's is running").toBe(false);
    soft(await snapshotOf(sandbox), "nothing was started or typed anywhere during the watch").toBe(before);
    const receiptAfter = await receiptOf(second, BO.id, messageId);
    mark(`receipt after the reopen: ${JSON.stringify(receiptAfter ?? null)}`, "receipt-after");
    soft(receiptAfter?.deliveredAt, "the receipt still reads delivered, with the same time").toBe(receiptBefore?.deliveredAt);
    soft(await crewMessageCount(second, CANVAS, BO.id), "Bo's message count is unchanged").toBe(countBefore);
    await shot(second, "2-after-the-reopen");
  });
});
