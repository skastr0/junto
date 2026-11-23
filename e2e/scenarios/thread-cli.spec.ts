import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page, TestInfo } from "@playwright/test";
import type { Seat } from "../../src/shared/model";
import { crewOccupySeat, crewPlayFactory, crewSeat, installCrewSeatHarness, type CrewCliResult, type CrewSeat } from "../harness/crew-fixture";
import { canvasReady } from "../harness/canvas";
import { expect, launchJunto, test } from "../harness/launch";
import { grantOverseer, modelFixture, modelMessagesWire, modelSeat } from "../harness/model";
/**
 * A seat reads threads through its own CLI [fake-tui].
 *
 *   bun run cli:build && bun run test:e2e:fast e2e/scenarios/thread-cli.spec.ts
 *
 * The real-binary check of `junto thread list|show` (ac162eff0, port
 * threads.read 8ccce6457). Every command runs in a seat, through the built
 * dist/junto, as a child of the seat process with the seat's own token
 * (CrewSeat.cli, e2e/harness/crew-fixture.ts). The operator writes the
 * threads through the window's own send, and the seats answer in them, so
 * the operator has unread in each.
 *
 *   A   the reader: every command runs here.
 *   B   wired from A with every port: --seat by name and by node id.
 *   C   no edge to A: --seat is refused with ScopeError.
 *   D   wired from A with threads.read masked off: --seat is refused, and
 *       `seat read` on the same edge still answers.
 *   O   an overseer (GrantOverseer, the human seam) with no edge at all:
 *       `junto overseer thread list|show` reads every seat's threads.
 *
 * Laws:
 *   1. no --seat lists and shows the caller's own threads;
 *   2. --seat reads a connected seat's threads, by name or node id;
 *   3. a seat with no edge is refused with ScopeError;
 *   4. threads.read masked off refuses --seat while seat read still works;
 *   5. no read moves the operator's unread count or read points;
 *   6. an overseer lists every thread and reads any seat's, no edge needed;
 *   7. an ordinary seat is refused the overseer thread commands.
 *
 * Evidence, in THREAD_CLI_DIR when set and the test's output folder
 * otherwise: `<step>-cli.txt` per command (argv, exit code, stdout, stderr).
 */

const CANVAS = "threadcli";
const CLI_BUILT = existsSync(join(process.cwd(), "dist", "junto"));
const CLI_MISSING =
  "SETUP: dist/junto is missing. This walk tests the CLI's own output, so it does not run without it. Build it with `bun run cli:build` in the checkout the run starts from.";

const soft = expect.configure({ soft: true });

const A = modelSeat({ id: "reader", label: "Reader", x: 60, y: 80 });
const B = modelSeat({ id: "peer", label: "Peer", x: 360, y: 80 });
const C = modelSeat({ id: "stranger", label: "Stranger", x: 660, y: 80 });
const D = modelSeat({ id: "terminalonly", label: "Terminal only", x: 360, y: 300 });
const O = modelSeat({ id: "overseer", label: "Overseer", x: 60, y: 520 });
/** The seats the operator writes to; O is the overseer and holds no thread. */
const NODES = [A, B, C, D];
const SEATS = [...NODES, O];
const DOC = modelFixture(SEATS, [
  modelMessagesWire("e-reader-peer", A.id, B.id, SEATS),
  // Every port the messages verb grants a seat pair, but threads.read.
  modelMessagesWire("e-reader-terminalonly", A.id, D.id, SEATS, ["msg.list", "msg.send", "msg.prompt", "seat.wait", "terminal.read"]),
]);

type Envelope = {
  readonly ok?: unknown;
  readonly command?: unknown;
  readonly data?: Record<string, unknown>;
  readonly error?: { readonly type?: unknown; readonly message?: unknown; readonly details?: Record<string, unknown> };
};

/** The one JSON line a stream holds, or undefined when it holds none. */
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

type ThreadRow = { readonly threadId?: unknown; readonly title?: unknown };
type ThreadMessage = { readonly messageId?: unknown };

const threadIdsOf = (data: Record<string, unknown> | undefined): ReadonlyArray<string> =>
  ((data?.threads ?? []) as ReadonlyArray<ThreadRow>).map((row) => String(row.threadId));

const messageIdsOf = (data: Record<string, unknown> | undefined): ReadonlyArray<string> =>
  ((data?.messages ?? []) as ReadonlyArray<ThreadMessage>).map((row) => String(row.messageId));

/** The operator writes a new thread into a seat's mailbox, through the window's own send. */
const operatorStarts = async (page: Page, nodeId: string, text: string): Promise<{ messageId: string; threadId: string }> => {
  const sent = (await page.evaluate(
    ([canvasName, id, body]) => window.junto!.seatThreadSend({ canvasName, nodeId: id, text: body }),
    [CANVAS, nodeId, text] as const,
  )) as { ok: boolean; messageId?: string; threadId?: string; message?: string };
  if (!sent.ok || sent.messageId === undefined || sent.threadId === undefined) {
    throw new Error(`operator send to ${nodeId} refused: ${JSON.stringify(sent)}`);
  }
  return { messageId: sent.messageId, threadId: sent.threadId };
};

/** The operator's unread count for a seat and read points, as the window reads them. */
const operatorReadState = (page: Page, nodeId: string) =>
  page.evaluate(
    async ([canvasName, id]) => ({
      unread: await window.junto!.seatThreadUnread({ canvasName, nodeId: id }),
      reads: await window.junto!.seatThreadReads({ canvasName, nodeId: id }),
    }),
    [CANVAS, nodeId] as const,
  );

test("[fake-tui] a seat reads its own threads and a connected seat's through the built CLI", async ({}, testInfo: TestInfo) => {
  test.setTimeout(420_000);
  if (!CLI_BUILT) throw new Error(CLI_MISSING);
  const dir = process.env.THREAD_CLI_DIR ?? testInfo.outputPath();
  await mkdir(dir, { recursive: true });
  const junto = await launchJunto({ seedModels: { [CANVAS]: DOC }, afterSeed: installCrewSeatHarness });
  const { page, sandbox } = junto;

  type Ran = { readonly result: CrewCliResult; readonly out?: Envelope; readonly err?: Envelope };
  const run = async (step: string, seat: CrewSeat, argv: ReadonlyArray<string>): Promise<Ran> => {
    const result = await seat.cli(argv);
    await writeFile(
      join(dir, `${step}-cli.txt`),
      [`$ junto ${argv.join(" ")}`, `exit code: ${String(result.exitCode)}`, "", "--- stdout ---", result.stdout, "--- stderr ---", result.stderr, ""].join("\n"),
      "utf8",
    );
    testInfo.annotations.push({
      type: `step-${step}`,
      description: `$ junto ${argv.join(" ")} → exit ${String(result.exitCode)}; stdout ${result.stdout.trim().slice(0, 400)}; stderr ${result.stderr.trim().slice(0, 400)}`,
    });
    return { result, out: jsonLine(result.stdout), err: jsonLine(result.stderr) };
  };
  const expectPass = (step: string, ran: Ran, command: string): void => {
    soft(ran.result.exitCode, `${step}: exit code; stderr ${ran.result.stderr.trim().slice(0, 400)}`).toBe(0);
    soft(ran.out?.ok, `${step}: stdout is a success envelope`).toBe(true);
    soft(ran.out?.command, `${step}: the envelope names the command`).toBe(command);
  };
  const expectRefused = (step: string, ran: Ran, type: string): void => {
    soft(ran.result.exitCode, `${step}: exit code`).not.toBe(0);
    soft(ran.err?.ok, `${step}: stderr is a failure envelope: ${ran.result.stderr.trim().slice(0, 400)}`).toBe(false);
    soft(ran.err?.error?.type, `${step}: the refusal's type`).toBe(type);
    soft(ran.out, `${step}: nothing on stdout`).toBeUndefined();
  };

  try {
    await canvasReady(page, { timeout: 30_000 });
    await crewPlayFactory(page);
    const start = async (node: Seat): Promise<CrewSeat> => {
      const seat = crewSeat(sandbox, CANVAS, node.id);
      await crewOccupySeat(page, CANVAS, node, seat);
      return seat;
    };
    const a = await start(A);
    const seats = new Map<string, CrewSeat>([[A.id, a]]);
    for (const node of [B, C, D]) seats.set(node.id, await start(node));
    await grantOverseer(page, CANVAS, O.id);
    const o = await start(O);

    // The operator starts one thread with each seat, and each seat answers in it.
    const threads = new Map<string, { messageId: string; threadId: string }>();
    for (const node of NODES) {
      const sent = await operatorStarts(page, node.id, `Operator to ${node.label}: a question for you`);
      threads.set(node.id, sent);
      const reply = await seats.get(node.id)!.op("msg.reply", { target: "operator", inReplyTo: sent.messageId, text: `${node.label} answers the operator` });
      expect(reply.ok, `${node.id} answers the operator: ${JSON.stringify(reply)}`).toBe(true);
    }
    const before = new Map<string, Awaited<ReturnType<typeof operatorReadState>>>();
    for (const node of NODES) {
      await expect.poll(async () => (await operatorReadState(page, node.id)).unread, { message: `operator unread for ${node.id}`, timeout: 15_000 }).toBeGreaterThan(0);
      before.set(node.id, await operatorReadState(page, node.id));
    }
    await writeFile(join(dir, "operator-before.json"), JSON.stringify(Object.fromEntries(before), null, 2), "utf8");

    // 1. Own threads, no --seat.
    const own = await run("1-own-list", a, ["thread", "list"]);
    expectPass("1-own-list", own, "thread list");
    soft(own.out?.data?.seat, "1-own-list: the seat named is the caller").toBeTruthy();
    soft(threadIdsOf(own.out?.data), "1-own-list: the operator's thread with A is listed").toContain(threads.get(A.id)!.threadId);
    soft(threadIdsOf(own.out?.data), "1-own-list: B's thread is not A's").not.toContain(threads.get(B.id)!.threadId);
    const ownShow = await run("1-own-show", a, ["thread", "show", threads.get(A.id)!.threadId]);
    expectPass("1-own-show", ownShow, "thread show");
    soft(messageIdsOf(ownShow.out?.data), "1-own-show: the operator's opening mail is in it").toContain(threads.get(A.id)!.messageId);
    soft(messageIdsOf(ownShow.out?.data).length, "1-own-show: the opening and A's answer").toBeGreaterThanOrEqual(2);

    // 2. A connected seat, by name and by node id.
    const byName = await run("2-peer-list-name", a, ["thread", "list", "--seat", B.label ?? B.id]);
    expectPass("2-peer-list-name", byName, "thread list");
    soft(threadIdsOf(byName.out?.data), "2-peer-list-name: B's thread is listed").toContain(threads.get(B.id)!.threadId);
    const byId = await run("2-peer-list-id", a, ["thread", "list", "--seat", B.id]);
    expectPass("2-peer-list-id", byId, "thread list");
    soft(threadIdsOf(byId.out?.data), "2-peer-list-id: B's thread is listed").toContain(threads.get(B.id)!.threadId);
    const peerShow = await run("2-peer-show", a, ["thread", "show", threads.get(B.id)!.threadId, "--seat", B.id]);
    expectPass("2-peer-show", peerShow, "thread show");
    soft(messageIdsOf(peerShow.out?.data), "2-peer-show: the operator's opening mail to B").toContain(threads.get(B.id)!.messageId);
    const notInIt = await run("2-peer-show-not-theirs", a, ["thread", "show", threads.get(A.id)!.threadId, "--seat", B.id]);
    expectRefused("2-peer-show-not-theirs", notInIt, "UnknownTarget");

    // 3. No edge.
    const stranger = await run("3-stranger-list", a, ["thread", "list", "--seat", C.id]);
    expectRefused("3-stranger-list", stranger, "ScopeError");
    const strangerShow = await run("3-stranger-show", a, ["thread", "show", threads.get(C.id)!.threadId, "--seat", C.id]);
    expectRefused("3-stranger-show", strangerShow, "ScopeError");

    // 4. threads.read masked off; seat read on the same edge still answers.
    const masked = await run("4-masked-list", a, ["thread", "list", "--seat", D.id]);
    expectRefused("4-masked-list", masked, "ScopeError");
    const maskedShow = await run("4-masked-show", a, ["thread", "show", threads.get(D.id)!.threadId, "--seat", D.id]);
    expectRefused("4-masked-show", maskedShow, "ScopeError");
    const seatRead = await run("4-masked-seat-read", a, ["seat", "read", D.id, "--lines", "5"]);
    expectPass("4-masked-seat-read", seatRead, "seat read");

    // 6. The overseer: every thread with no seat, any seat's with --seat, no edge.
    const every = await run("6-overseer-list-every", o, ["overseer", "thread", "list"]);
    expectPass("6-overseer-list-every", every, "overseer thread list");
    for (const node of NODES) {
      soft(threadIdsOf(every.out?.data), `6-overseer-list-every: ${node.id}'s thread is listed`).toContain(threads.get(node.id)!.threadId);
    }
    soft(JSON.stringify(every.out?.data ?? {}), "6-overseer-list-every: no operator read state").not.toMatch(/"(unread|readAt)"/);
    const searched = await run("6-overseer-list-search", o, ["overseer", "thread", "list", "--search", "Stranger"]);
    expectPass("6-overseer-list-search", searched, "overseer thread list");
    soft(threadIdsOf(searched.out?.data), "6-overseer-list-search: the stranger's thread alone").toEqual([threads.get(C.id)!.threadId]);
    const oneSeat = await run("6-overseer-list-seat", o, ["overseer", "thread", "list", "--seat", C.label ?? C.id]);
    expectPass("6-overseer-list-seat", oneSeat, "overseer thread list");
    soft(threadIdsOf(oneSeat.out?.data), "6-overseer-list-seat: the stranger's thread, with no edge").toContain(threads.get(C.id)!.threadId);
    const oShow = await run("6-overseer-show", o, ["overseer", "thread", "show", threads.get(C.id)!.threadId, "--seat", C.id]);
    expectPass("6-overseer-show", oShow, "overseer thread show");
    soft(messageIdsOf(oShow.out?.data), "6-overseer-show: the operator's opening mail to the stranger").toContain(threads.get(C.id)!.messageId);
    const oMasked = await run("6-overseer-show-masked-seat", o, ["overseer", "thread", "show", threads.get(D.id)!.threadId, "--seat", D.id]);
    expectPass("6-overseer-show-masked-seat", oMasked, "overseer thread show");

    // 7. An ordinary seat is refused the overseer's commands.
    const notOverseer = await run("7-ordinary-overseer-list", a, ["overseer", "thread", "list"]);
    soft(notOverseer.result.exitCode, "7-ordinary-overseer-list: exit code").not.toBe(0);
    soft(`${notOverseer.result.stdout}${notOverseer.result.stderr}`, "7-ordinary-overseer-list: no thread printed").not.toContain(threads.get(A.id)!.threadId);
    const notOverseerShow = await run("7-ordinary-overseer-show", a, ["overseer", "thread", "show", threads.get(C.id)!.threadId, "--seat", C.id]);
    soft(notOverseerShow.result.exitCode, "7-ordinary-overseer-show: exit code").not.toBe(0);
    soft(`${notOverseerShow.result.stdout}${notOverseerShow.result.stderr}`, "7-ordinary-overseer-show: no mail printed").not.toContain("a question for you");

    // 5. Nothing any seat read moved the operator's unread or read points.
    const after = new Map<string, Awaited<ReturnType<typeof operatorReadState>>>();
    for (const node of NODES) {
      after.set(node.id, await operatorReadState(page, node.id));
      soft(after.get(node.id), `5: operator read state for ${node.id} is unchanged`).toEqual(before.get(node.id));
    }
    await writeFile(join(dir, "operator-after.json"), JSON.stringify(Object.fromEntries(after), null, 2), "utf8");
  } finally {
    await junto.close();
  }
});
