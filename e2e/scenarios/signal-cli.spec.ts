import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import type { AgentSignal } from "../../src/shared/agent-signals";
import type { Seat } from "../../src/shared/model";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness, type CrewCliResult, type CrewSeat } from "../harness/crew-fixture";
import { canvasReady } from "../harness/canvas";
import { expect, launchJunto, test } from "../harness/launch";
import { modelFixture, modelMessagesWire, modelRegion, modelSeat, modelTask } from "../harness/model";
/**
 * A seat raises signals in an order, in a thread, and as a batch, through its
 * own CLI [fake-tui].
 *
 *   bun run cli:build && SIGNAL_CLI_V75_DB=<store> bun run test:e2e:fast e2e/scenarios/signal-cli.spec.ts
 *
 * The real-binary check of the signal commands (25356fcc4, the store of
 * 430070fa5 with 1465a7048 and f4f08b4f1). Every command runs in a seat
 * through the built dist/junto (CrewSeat.cli, e2e/harness/crew-fixture.ts).
 * An earlier signal is closed by the seat withdrawing it (`junto signal
 * clear`): readiness counts every close alike (signalReadiness,
 * src/shared/wire/agent-signals.ts).
 *
 *   1. ten signals with `junto signal batch`, and ten with --depends-on-last:
 *      the first ready, each after the one before, and closing one makes the
 *      next ready;
 *   2. --thread in a thread the operator started is one act: the signal names
 *      the thread and its mail, the mail is the seat's next in the thread;
 *      a plain `junto msg reply` raises nothing;
 *   3. refusals, each writing nothing: a thread the operator never wrote in, a
 *      task's thread, a ninth --depends-on, another seat's signal;
 *   4. --depends-on-last passes over an automation's signal on the seat
 *      (a5878d359): a seat whose automation signal is newer than its own
 *      comes after its own last signal, and a seat with only an
 *      automation's signal comes after nothing;
 *   5. a store v0.11.14 wrote (schema 75, SIGNAL_CLI_V75_DB, made by
 *      make-v75-store.ts in that release's checkout) opens in this build, and
 *      its old signals list ready, with no thread and nothing they come after.
 *
 * Evidence, in SIGNAL_CLI_DIR when set and the test's output folder
 * otherwise: `<step>-cli.txt` per command.
 */

const CANVAS = "signalcli";
const CLI_BUILT = existsSync(join(process.cwd(), "dist", "junto"));
const CLI_MISSING =
  "SETUP: dist/junto is missing. This walk tests the CLI's own output, so it does not run without it. Build it with `bun run cli:build` in the checkout the run starts from.";

const soft = expect.configure({ soft: true });

const A = modelSeat({ id: "raiser", label: "Raiser", x: 60, y: 80 });
const B = modelSeat({ id: "peer", label: "Peer", x: 360, y: 80 });
const T = modelTask("board", 660, 80);
const C = modelSeat({ id: "mixed", label: "Mixed", x: 60, y: 260 });
const D = modelSeat({ id: "fresh", label: "Fresh", x: 360, y: 260 });
const R = modelRegion({ id: "room", label: "Room", x: 0, y: 0, width: 1000, height: 480 });
const NODES = [R, A, B, C, D, T];

/**
 * An automation's signal on each of C and D, seeded before boot, newer than
 * anything the seats raise in the run (a5878d359's case, through the CLI).
 */
const AUTOMATION_ID = "01M852PM9NWTBBVNYYPSPR0HNV";
const automationSignal = (signalId: string, nodeId: string): AgentSignal => ({
  signalId,
  canvasName: CANVAS,
  nodeId,
  source: { kind: "automation", automationId: AUTOMATION_ID, nodeId },
  kind: "feedback",
  text: `An automation raised this on ${nodeId}, later than the seat`,
  createdAt: Date.now() + 365 * 24 * 3_600_000,
  state: "open",
});
const AUTOMATION_ON_C = "01M8S0000000000000000000MC";
const AUTOMATION_ON_D = "01M8S0000000000000000000FD";
const SEEDED = [automationSignal(AUTOMATION_ON_C, C.id), automationSignal(AUTOMATION_ON_D, D.id)];
const DOC = modelFixture(NODES, [
  modelMessagesWire("e-raiser-peer", A.id, B.id, NODES),
  modelMessagesWire("e-peer-raiser", B.id, A.id, NODES),
]);

type Envelope = {
  readonly ok?: unknown;
  readonly command?: unknown;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly type?: unknown; readonly message?: unknown; readonly details?: Record<string, unknown> };
};

const jsonLine = (text: string): Envelope | undefined => {
  for (const line of text.split("\n").reverse()) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      return JSON.parse(trimmed) as Envelope;
    } catch {
      // Not the line.
    }
  }
  return undefined;
};

type Listed = {
  readonly signalId: string;
  readonly state?: string;
  readonly ready?: boolean;
  readonly waitingOn?: ReadonlyArray<string>;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly threadId?: string;
  readonly messageId?: string;
  readonly followsSignalId?: string;
};

type Ran = { readonly result: CrewCliResult; readonly out?: Envelope; readonly err?: Envelope };

/** Run CLI steps in a seat, keep each as a file, and judge the envelope. */
const walker = (dir: string, testInfo: TestInfo) => {
  const run = async (step: string, seat: CrewSeat, argv: ReadonlyArray<string>): Promise<Ran> => {
    const result = await seat.cli(argv);
    await writeFile(
      join(dir, `${step}-cli.txt`),
      [`$ junto ${argv.map((arg) => (/[\s'"{]/.test(arg) ? `'${arg}'` : arg)).join(" ")}`, `exit code: ${String(result.exitCode)}`, "", "--- stdout ---", result.stdout, "--- stderr ---", result.stderr, ""].join("\n"),
      "utf8",
    );
    testInfo.annotations.push({
      type: `step-${step}`,
      description: `exit ${String(result.exitCode)}; stdout ${result.stdout.trim().slice(0, 300)}; stderr ${result.stderr.trim().slice(0, 300)}`,
    });
    return { result, out: jsonLine(result.stdout), err: jsonLine(result.stderr) };
  };
  const pass = (step: string, ran: Ran): Record<string, unknown> => {
    soft(ran.result.exitCode, `${step}: exit code; stderr ${ran.result.stderr.trim().slice(0, 400)}`).toBe(0);
    soft(ran.out?.ok, `${step}: stdout is a success envelope`).toBe(true);
    return ran.out?.data ?? {};
  };
  const refused = (step: string, ran: Ran, type: string): void => {
    soft(ran.result.exitCode, `${step}: exit code`).not.toBe(0);
    soft(ran.err?.ok, `${step}: stderr is a failure envelope: ${ran.result.stderr.trim().slice(0, 400)}`).toBe(false);
    soft(ran.err?.error?.type, `${step}: the refusal's type: ${ran.result.stderr.trim().slice(0, 400)}`).toBe(type);
  };
  /** Every signal `junto signal list` shows for the seat, by id. */
  const list = async (step: string, seat: CrewSeat): Promise<Map<string, Listed>> => {
    const data = pass(step, await run(step, seat, ["signal", "list"]));
    return new Map(((data.signals ?? []) as ReadonlyArray<Listed>).map((signal) => [signal.signalId, signal]));
  };
  const openIds = (listed: Map<string, Listed>): ReadonlyArray<string> =>
    [...listed.values()].filter((signal) => signal.state === "open").map((signal) => signal.signalId).sort();
  return { run, pass, refused, list, openIds };
};

/** Each of `ids` is listed after the one before it: the first `firstReady`, each later one waiting on the one before while that is open. */
const expectChain = (step: string, listed: Map<string, Listed>, ids: ReadonlyArray<string>, closedUpTo: number): void => {
  ids.forEach((id, index) => {
    const signal = listed.get(id);
    soft(signal, `${step}: signal ${String(index + 1)} is listed`).toBeDefined();
    if (signal === undefined) return;
    if (index > 0) soft(signal.dependsOn, `${step}: signal ${String(index + 1)} comes after signal ${String(index)}`).toEqual([ids[index - 1]]);
    if (index < closedUpTo) {
      soft(signal.state, `${step}: signal ${String(index + 1)} is closed`).not.toBe("open");
      return;
    }
    const ready = index === closedUpTo;
    soft(signal.ready, `${step}: signal ${String(index + 1)} ${ready ? "is ready" : "waits"}`).toBe(ready);
    soft(signal.waitingOn ?? [], `${step}: what signal ${String(index + 1)} waits on`).toEqual(ready ? [] : [ids[index - 1]]);
  });
};

const operatorStarts = async (page: Page, nodeId: string, text: string): Promise<{ messageId: string; threadId: string }> => {
  const sent = (await page.evaluate(
    ([canvasName, id, body]) => window.junto!.seatThreadSend({ canvasName, nodeId: id, text: body }),
    [CANVAS, nodeId, text] as const,
  )) as { ok: boolean; messageId?: string; threadId?: string };
  if (!sent.ok || sent.messageId === undefined || sent.threadId === undefined) throw new Error(`operator send refused: ${JSON.stringify(sent)}`);
  return { messageId: sent.messageId, threadId: sent.threadId };
};

const TOPICS = Array.from({ length: 10 }, (_, index) => `Topic ${String(index + 1)} of ten`);

test("[fake-tui] a seat raises signals in an order, in a thread and as a batch, through the built CLI", async ({}, testInfo) => {
  test.setTimeout(600_000);
  if (!CLI_BUILT) throw new Error(CLI_MISSING);
  const dir = process.env.SIGNAL_CLI_DIR ?? testInfo.outputPath();
  await mkdir(dir, { recursive: true });
  const { run, pass, refused, list, openIds } = walker(dir, testInfo);
  const junto = await launchJunto({ seedModels: { [CANVAS]: DOC }, seedAgentSignals: SEEDED, afterSeed: installCrewSeatHarness });
  const { page, sandbox } = junto;
  try {
    await canvasReady(page, { timeout: 30_000 });
    await crewPlayFactory(page);
    const start = async (node: Seat): Promise<CrewSeat> => {
      const seat = crewSeat(sandbox, CANVAS, node.id);
      await crewOccupySeat(page, CANVAS, node, seat);
      return seat;
    };
    const a = await start(A);
    const b = await start(B);

    // 1a. Ten in order with junto signal batch: each after the one before.
    const batch = pass("1a-batch", await run("1a-batch", a, ["signal", "batch", JSON.stringify(TOPICS.map((text) => ({ kind: "escalate", text: `Batch: ${text}` })))]));
    const batchIds = ((batch.signals ?? []) as ReadonlyArray<{ readonly signalId?: string; readonly signal?: { readonly signalId: string } }>)
      .map((item) => item.signalId ?? item.signal?.signalId ?? "");
    soft(batchIds, "1a-batch: ten signals raised").toHaveLength(10);
    expectChain("1a-list-0", await list("1a-list-0", a), batchIds, 0);
    for (let closed = 1; closed <= batchIds.length; closed++) {
      pass(`1a-clear-${String(closed)}`, await run(`1a-clear-${String(closed)}`, a, ["signal", "clear", batchIds[closed - 1]!]));
      expectChain(`1a-list-${String(closed)}`, await list(`1a-list-${String(closed)}`, a), batchIds, closed);
    }

    // 1b. The same ten, one at a time, each with --depends-on-last.
    const lastIds: Array<string> = [];
    for (const [index, text] of TOPICS.entries()) {
      const step = `1b-raise-${String(index + 1)}`;
      const raised = pass(step, await run(step, a, ["escalate", `Last: ${text}`, "--depends-on-last"]));
      lastIds.push(String((raised.signal as { signalId?: string } | undefined)?.signalId ?? ""));
    }
    const first = (await list("1b-list-0", a)).get(lastIds[0]!);
    // Its --depends-on-last named the batch's last signal, closed: so it is ready.
    soft(first?.dependsOn, "1b-list-0: the first comes after the batch's last signal").toEqual([batchIds[9]]);
    soft(first?.ready, "1b-list-0: the first is ready").toBe(true);
    expectChain("1b-list-0", await list("1b-list-0b", a), lastIds, 0);
    for (let closed = 1; closed <= lastIds.length; closed++) {
      pass(`1b-clear-${String(closed)}`, await run(`1b-clear-${String(closed)}`, a, ["signal", "clear", lastIds[closed - 1]!]));
      expectChain(`1b-list-${String(closed)}`, await list(`1b-list-${String(closed)}`, a), lastIds, closed);
    }

    // 2. A signal in the operator's thread is one act; a plain reply raises nothing.
    const opened = await operatorStarts(page, A.id, "Operator to Raiser: which store should we use?");
    const inThread = pass("2-raise-in-thread", await run("2-raise-in-thread", a, ["escalate", "Raiser needs a ruling on the store", "--thread", opened.threadId]));
    const signal = inThread.signal as Listed | undefined;
    soft(signal?.threadId, "2-raise-in-thread: the signal names the thread").toBe(opened.threadId);
    soft(typeof signal?.messageId, "2-raise-in-thread: the signal names its mail").toBe("string");
    const shown = pass("2-thread-show", await run("2-thread-show", a, ["thread", "show", opened.threadId]));
    const messages = (shown.messages ?? []) as ReadonlyArray<{ readonly messageId?: string; readonly text?: string; readonly from?: { readonly kind?: string } }>;
    const last = messages[messages.length - 1];
    soft(last?.messageId, "2-thread-show: the seat's next mail in the thread is the signal's").toBe(signal?.messageId);
    soft(last?.text, "2-thread-show: the mail carries the words").toContain("Raiser needs a ruling on the store");
    const afterRaise = await list("2-list-after-raise", a);
    soft(afterRaise.get(signal?.signalId ?? "")?.threadId, "2-list-after-raise: signal list shows the thread").toBe(opened.threadId);
    const windowThread = (await page.evaluate(
      ([canvasName, nodeId, threadId]) => window.junto!.seatThreadMessages({ canvasName, nodeId, threadId }),
      [CANVAS, A.id, opened.threadId] as const,
    )) as { readonly messages: ReadonlyArray<{ readonly messageId: string }> };
    await writeFile(join(dir, "2-window-thread.json"), JSON.stringify(windowThread, null, 2), "utf8");
    soft(windowThread.messages.map((message) => message.messageId), "2-window-thread: the window's thread holds the signal's mail").toContain(signal?.messageId);
    const openBeforeReply = openIds(afterRaise);
    pass("2-plain-reply", await run("2-plain-reply", a, ["msg", "reply", JSON.stringify({ target: "operator", inReplyTo: opened.messageId, text: "A plain answer, no signal" })]));
    soft(openIds(await list("2-list-after-reply", a)), "2-list-after-reply: a plain reply raised nothing").toEqual(openBeforeReply);

    // 3. Refusals, each writing nothing.
    const openBefore = openIds(await list("3-list-before", a));
    pass("3a-peer-mails", await run("3a-peer-mails", b, ["msg", "send", JSON.stringify({ target: A.id, text: "Peer to Raiser, no operator in this thread" })]));
    const inbox = pass("3a-inbox", await run("3a-inbox", a, ["msg", "list"]));
    const inboxItems = (inbox.items ?? inbox.messages ?? []) as ReadonlyArray<{ readonly messageId: string; readonly text?: string; readonly parts?: unknown }>;
    const peerMail = inboxItems.find((item) => JSON.stringify(item).includes("Peer to Raiser, no operator"));
    soft(peerMail, "3a-inbox: the peer's mail is in the raiser's inbox").toBeDefined();
    refused("3a-no-operator-thread", await run("3a-no-operator-thread", a, ["escalate", "In the peer's thread", "--thread", peerMail?.messageId ?? "01M852PM9NWTBBVNYYPSPR0HNV"]), "ScopeError");

    const created = await run("3b-task-create", b, ["task", "create", "A task for the raiser", "--body", "Subject thread check", "--node", T.id]);
    pass("3b-task-create", created);
    const createdData = (created.out?.data ?? {}) as { readonly taskId?: unknown; readonly task?: { readonly taskId?: unknown; readonly id?: unknown } };
    const taskRef = String(createdData.taskId ?? createdData.task?.taskId ?? createdData.task?.id ?? "#1");
    pass("3b-task-assign", await run("3b-task-assign", b, ["task", "assign", taskRef, `@${A.label ?? A.id}`]));
    await expect.poll(async () => {
      const box = (await run("3b-inbox", a, ["msg", "list"])).out?.data ?? {};
      return ((box.items ?? box.messages ?? []) as ReadonlyArray<unknown>).some((item) => JSON.stringify(item).includes("threadSubject") || JSON.stringify(item).includes("subjectNotice"));
    }, { message: "3b: the task's notice reaches the raiser", timeout: 20_000 }).toBe(true);
    const taskBox = (await run("3b-inbox", a, ["msg", "list"])).out?.data ?? {};
    const notice = ((taskBox.items ?? taskBox.messages ?? []) as ReadonlyArray<{ readonly messageId: string }>)
      .find((item) => JSON.stringify(item).includes("threadSubject") || JSON.stringify(item).includes("subjectNotice"));
    refused("3b-task-thread", await run("3b-task-thread", a, ["escalate", "In the task's thread", "--thread", notice?.messageId ?? "01M852PM9NWTBBVNYYPSPR0HNV"]), "ScopeError");

    const nine = [...batchIds.slice(0, 9)].flatMap((id) => ["--depends-on", id]);
    const ninth = await run("3c-ninth-depends-on", a, ["escalate", "After nine", ...nine]);
    refused("3c-ninth-depends-on", ninth, "InputError");
    soft(ninth.err?.error?.details?.path, "3c-ninth-depends-on: names the flag").toBe("--depends-on");

    const theirs = pass("3d-peer-raises", await run("3d-peer-raises", b, ["feedback", "The peer's own signal"]));
    const theirId = String((theirs.signal as { signalId?: string } | undefined)?.signalId ?? "");
    refused("3d-other-seat-signal", await run("3d-other-seat-signal", a, ["escalate", "After the peer's", "--depends-on", theirId]), "UnknownTarget");

    soft(openIds(await list("3-list-after", a)), "3-list-after: no refusal wrote a signal").toEqual(openBefore);

    // 4. --depends-on-last passes over an automation's signal on the seat.
    const c = await start(C);
    const seededC = (await list("4a-list-seeded", c)).get(AUTOMATION_ON_C);
    soft(seededC?.state, "4a-list-seeded: the automation's signal is on the seat, open").toBe("open");
    const own = pass("4a-own", await run("4a-own", c, ["escalate", "Mixed raises its own first"]));
    const ownId = String((own.signal as { signalId?: string } | undefined)?.signalId ?? "");
    const afterOwn = pass("4a-after-own", await run("4a-after-own", c, ["escalate", "Mixed, after its own last", "--depends-on-last"]));
    soft((afterOwn.signal as Listed | undefined)?.dependsOn, "4a-after-own: comes after the seat's own signal, not the automation's newer one").toEqual([ownId]);
    const listedC = (await list("4a-list-after", c)).get(String((afterOwn.signal as Listed | undefined)?.signalId ?? ""));
    soft(listedC?.ready, "4a-list-after: waits while its own signal is open").toBe(false);
    soft(listedC?.waitingOn, "4a-list-after: on the seat's own signal").toEqual([ownId]);

    const d = await start(D);
    const alone = pass("4b-only-automation", await run("4b-only-automation", d, ["escalate", "Fresh has raised nothing itself", "--depends-on-last"]));
    const aloneSignal = alone.signal as Listed | undefined;
    soft(aloneSignal?.dependsOn ?? [], "4b-only-automation: comes after nothing").toEqual([]);
    const listedD = (await list("4b-list-after", d)).get(String(aloneSignal?.signalId ?? ""));
    soft(listedD?.ready, "4b-list-after: is ready").toBe(true);
    soft(listedD?.waitingOn ?? [], "4b-list-after: waits on nothing").toEqual([]);
  } finally {
    await junto.close();
  }
});

test("[fake-tui] a store v0.11.14 wrote opens in this build, its old signals ready with no thread", async ({}, testInfo) => {
  test.setTimeout(300_000);
  if (!CLI_BUILT) throw new Error(CLI_MISSING);
  const store = process.env.SIGNAL_CLI_V75_DB;
  if (store === undefined || !existsSync(store)) throw new Error("SETUP: SIGNAL_CLI_V75_DB names no file: make it with make-v75-store.ts in a v0.11.14 checkout.");
  const dir = join(process.env.SIGNAL_CLI_DIR ?? testInfo.outputPath(), "old-store");
  await mkdir(dir, { recursive: true });
  const { run, pass, list } = walker(dir, testInfo);
  const junto = await launchJunto({ seedDatabasePath: store, afterSeed: installCrewSeatHarness });
  const { page, sandbox } = junto;
  try {
    await canvasReady(page, { timeout: 30_000 });
    await crewPlayFactory(page);
    const veteran = crewSeat(sandbox, "signalold", "veteran");
    await crewOccupySeat(page, "signalold", { id: "veteran" }, veteran);
    const listed = await list("5-old-list", veteran);
    const old = ["01M8S00000000000000000000A", "01M8S00000000000000000000B", "01M8S00000000000000000000C", "01M8S00000000000000000000D"];
    for (const id of old) {
      const signal = listed.get(id);
      soft(signal, `5-old-list: old signal ${id} is listed`).toBeDefined();
      if (signal === undefined) continue;
      soft(signal.ready, `5-old-list: ${id} is ready`).toBe(true);
      soft(signal.waitingOn ?? [], `5-old-list: ${id} waits on nothing`).toEqual([]);
      soft(signal.dependsOn ?? [], `5-old-list: ${id} comes after nothing`).toEqual([]);
      soft(signal.threadId, `5-old-list: ${id} has no thread`).toBeUndefined();
      soft(signal.followsSignalId, `5-old-list: ${id} follows nothing`).toBeUndefined();
    }
    // The old open signal can be named by a new one, which then waits on it.
    const raised = pass("5-new-after-old", await run("5-new-after-old", veteran, ["escalate", "New, after the old open one", "--depends-on", old[0]!]));
    const newId = String((raised.signal as { signalId?: string } | undefined)?.signalId ?? "");
    const after = (await list("5-list-after-new", veteran)).get(newId);
    soft(after?.ready, "5-list-after-new: the new one waits").toBe(false);
    soft(after?.waitingOn, "5-list-after-new: on the old open signal").toEqual([old[0]]);
  } finally {
    await junto.close();
  }
});
