/**
 * Global threads: the operator's threads across every seat of a canvas
 * (src/core/work/thread-rows.ts), through the real stores, schema and seat
 * mail. Hundreds of seats in two regions, one of them on another machine, and
 * thousands of mails: only the threads the operator is in, one row per thread,
 * newest first in pages that cover every row once, the region, seat, search
 * and unread filters with their counts, a watch that pushes what changed, and
 * the time to the first page.
 */
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/sql";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ulid } from "ulid";
import { encodeWorkFrame } from "../src/shared/work-control";
import { mailExtensionMetadata } from "../src/shared/crew";
import { makeUserMessage } from "../src/shared/task";
import { operatorActorRef } from "../src/shared/work-reference";
import type { OperatorThreadRow, OperatorThreadsChanged } from "../src/shared/operator-threads";
import { publishSeatCredential } from "./helpers/seat-credential";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { region, seat as seatNode, wire } from "./support/model-nodes";
import { startWorkControlServer, type WorkControlServer } from "../src/core/work/control";
import { WorkLive, WorkService } from "../src/core/work/service";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import { makeContentServiceLive } from "../src/core/content/service";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { makeStateEngineLive } from "../src/core/state/engine";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { MachineRepositoryLive } from "../src/core/machines/repository";
import { SettingsLive } from "../src/core/settings/service";
import { nameThisMachine } from "./support/name-this-machine";
import { PausePlaneAllPlaying } from "../src/core/pause-plane";
import { markRead } from "../src/core/work/mail-reads";
import { stampMailboxDeliveryReceipt } from "../src/core/work/delivery-receipts";
import { mailboxMessageDeliveryId } from "../src/core/work/mailbox-receipts";
import { makeThreadRowsWatches, operatorThreadsPage, operatorThreadsView, threadRowsPage } from "../src/core/work/thread-rows";
import { createMainAuthoringGate } from "../src/node/main-authoring-gate";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();

const CANVAS = "across";
/** Seats per region; two regions. */
const PER_REGION = 100;
/** Operator threads each seat has, two mails each. */
const OPERATOR_THREADS_PER_SEAT = 10;
/** The seat that runs on another machine. */
const REMOTE = "s-mini";

const makeRuntime = (root: string) => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "state", "junto.db")),
      makeInstallOpsLive(join(root, "state", "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(ModelStoresLive, repositoriesLive);
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive, canvasesLive), PausePlaneAllPlaying, testLog.log.loggerLayer));
};

const seatId = (n: number): string => `s-${String(n).padStart(3, "0")}`;
const seatAt = (id: string, x: number, y: number, more: Parameters<typeof seatNode>[1] = {}) =>
  seatNode(id, { x, y, width: 120, height: 48, bindingId: `bind-${id}` as never, launch: { kind: "harness", argv: ["claude"] }, ...more });

let root: string;
let runtime: ReturnType<typeof makeRuntime>;
let server: WorkControlServer;
const tokens: Record<string, string> = {};
let seeded = 0;
/** The operator's mail written into each seat, by seat. */
const operatorMail = new Map<string, string[]>();
let firstPageMs = 0;
let warmPageMs = 0;

const call = (as: string, op: string, args: unknown = {}): Promise<any> =>
  new Promise((resolve, reject) => {
    const socket = createConnection({ path: server.socketPath });
    let buffer = "";
    socket.on("connect", () => socket.write(encodeWorkFrame({ token: tokens[as]!, op, args })));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      socket.destroy();
      resolve(JSON.parse(buffer.slice(0, newline)));
    });
    socket.on("error", reject);
  });

/** The operator's mail into a seat, as the desktop writes it: a new thread, or a row in `threadId`. */
const write = (to: string, text: string, threadId?: string) =>
  Effect.flatMap(WorkService, (work) => {
    const sender = operatorActorRef(CANVAS);
    const extension = mailExtensionMetadata({ mailKind: "prompt", fromSeat: sender.seatId, senderNodeId: sender.nodeId, senderName: "operator", senderGeneration: "operator", senderHarness: "unknown" });
    return work.workSystemMailboxNotify(
      CANVAS,
      to,
      makeUserMessage({
        messageId: ulid(),
        text,
        contextId: CANVAS,
        metadata: { factoryMail: true, ...extension, ...(threadId === undefined ? {} : { threadId }) },
      }),
    );
  }).pipe(
    Effect.flatMap((appended) => (appended.ok ? Effect.succeed(appended.data.messageId) : Effect.die(appended.message))),
    Effect.tap(() => Effect.sync(() => (seeded += 1))),
  );

const page = (query: Omit<Parameters<typeof operatorThreadsPage>[0], "canvasName"> = {}) =>
  runtime.runPromise(operatorThreadsPage({ canvasName: CANVAS as never, ...query }));

/** Every row the filter holds, page by page. */
const everyRow = async (query: Omit<Parameters<typeof operatorThreadsPage>[0], "canvasName"> = {}) => {
  const rows: OperatorThreadRow[] = [];
  let after: string | undefined;
  for (;;) {
    const read = await page({ ...query, limit: 200, ...(after === undefined ? {} : { after }) });
    rows.push(...read.rows);
    if (read.next === undefined) return { rows, total: read.total, unread: read.unread };
    after = read.next;
  }
};

const ALL_SEATS = [...Array.from({ length: PER_REGION * 2 }, (_, n) => seatId(n)), REMOTE];

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-threads-across-"));
  const workHome = join(root, "work");
  mkdirSync(workHome, { recursive: true });
  process.env.JUNTO_WORK_HOME = workHome;
  runtime = makeRuntime(root);
  await runtime.runPromise(nameThisMachine);
  // The mini is a machine this one has pinned, so a seat may live there.
  await runtime.runPromise(
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO known_installations (installation_id, registered_at) VALUES ('mini-installation', 'now')`;
        yield* sql`INSERT INTO machine_peers (machine_name, installation_id, bound_at) VALUES ('mini', 'mini-installation', 'now')`;
      }),
    )),
  );
  server = await startWorkControlServer({
    version: "test",
    workHome,
    home: root,
    run: (effect) => runtime.runPromise(effect),
    authoringGate: createMainAuthoringGate(),
  });
  for (const id of [seatId(0), seatId(1)]) tokens[id] = publishSeatCredential(server.credentials, { agentKey: `local:${id}` });
  // Two regions side by side, a hundred seats each; the seat on the mini sits in the second.
  const seats = [
    ...Array.from({ length: PER_REGION }, (_, n) => seatAt(seatId(n), 40 + (n % 20) * 160, 40 + Math.floor(n / 20) * 80)),
    ...Array.from({ length: PER_REGION }, (_, n) => seatAt(seatId(PER_REGION + n), 40 + (n % 20) * 160, 1040 + Math.floor(n / 20) * 80)),
    seatAt(REMOTE, 40, 1600, { host: "mini" as never }),
  ];
  await runtime.runPromise(
    seedCanvas(CANVAS, [
      region("r-alpha", { x: 0, y: 0, width: 3400, height: 900 }, { label: "Alpha" } as never),
      region("r-beta", { x: 0, y: 1000, width: 3400, height: 900 }, { label: "Beta" } as never),
      ...seats,
    ], [wire("w-01", seatId(0), seatId(1), "messages"), wire("w-10", seatId(1), seatId(0), "messages")]),
  );
  // Operator threads in every seat, two mails each.
  await runtime.runPromise(
    Effect.forEach(ALL_SEATS, (to) =>
      Effect.gen(function* () {
        for (let k = 0; k < OPERATOR_THREADS_PER_SEAT; k += 1) {
          const root = yield* write(to, `ask ${to} number ${String(k)}${k === 0 ? " about the zebra" : ""}`);
          const more = yield* write(to, `and more for ${to}`, root);
          operatorMail.set(to, [...(operatorMail.get(to) ?? []), root, more]);
        }
      }),
    ),
  );
  // And a thread between two seats, which the operator's list never shows.
  const opened = await call(seatId(1), "msg.send", { target: seatId(0), text: "between seats, can you look?" });
  await call(seatId(0), "msg.reply", { target: seatId(1), text: "between seats, on it", inReplyTo: opened.data.messageId });
  // Time to the first page, the index cold (every mailbox read once), then warm.
  let started = performance.now();
  await page({ limit: 50 });
  firstPageMs = performance.now() - started;
  started = performance.now();
  await page({ limit: 50 });
  warmPageMs = performance.now() - started;
  process.stderr.write(
    `[operator-threads-across] ${String(ALL_SEATS.length)} seats, ${String(seeded)} mails: first page ${firstPageMs.toFixed(1)} ms cold, ${warmPageMs.toFixed(1)} ms warm\n`,
  );
}, 300_000);

afterAll(async () => {
  await server?.close();
  await runtime?.dispose();
  await rm(root, { recursive: true, force: true });
  delete process.env.JUNTO_WORK_HOME;
});

describe("the operator's threads across every seat", () => {
  it("holds only the operator's threads, one row each, newest first, and pages cover every row once", async () => {
    const { rows, total } = await everyRow();
    expect(total).toBe(ALL_SEATS.length * OPERATOR_THREADS_PER_SEAT);
    expect(rows).toHaveLength(total);
    expect(new Set(rows.map((row) => row.threadId)).size).toBe(total);
    for (let n = 1; n < rows.length; n += 1) expect(rows[n - 1]!.lastAt).toBeGreaterThanOrEqual(rows[n]!.lastAt);
    // Mail between seats never makes a row.
    expect(rows.some((row) => row.title.startsWith("between seats"))).toBe(false);
    // The row's seat holds the thread, and its last mail is the operator's second.
    const one = rows.find((row) => row.title === `ask ${seatId(7)} number 3`)!;
    expect(one.seat).toEqual({ nodeId: seatId(7), name: seatId(7), portraitIdentity: seatId(7) });
    expect(one.messageCount).toBe(2);
    expect(one.last.from).toEqual({ kind: "operator" });
  });

  it("holds a seat on another machine, as every agent seat whatever its host", async () => {
    const { rows } = await everyRow({ seats: [REMOTE as never] });
    expect(rows).toHaveLength(OPERATOR_THREADS_PER_SEAT);
    expect(rows.every((row) => row.seat.nodeId === REMOTE)).toBe(true);
    expect(rows[0]!.region.path).toEqual(["Beta"]);
  });

  it("narrows by region, seat and search, and counts each strip with its own part left out", async () => {
    const alpha = await page({ region: ["Alpha"], limit: 10 });
    expect(alpha.total).toBe(PER_REGION * OPERATOR_THREADS_PER_SEAT);
    expect(alpha.rows.every((row) => row.region.path[0] === "Alpha")).toBe(true);
    // The region strip counts the filter without its region: both regions are named.
    const strip = new Map(alpha.regions.map((count) => [count.region.label, count.total]));
    expect(strip.get("Alpha")).toBe(PER_REGION * OPERATOR_THREADS_PER_SEAT);
    expect(strip.get("Beta")).toBe((PER_REGION + 1) * OPERATOR_THREADS_PER_SEAT);
    // The seat strip, under Alpha, names Alpha's seats alone.
    expect(alpha.seatCounts).toHaveLength(PER_REGION);

    const zebra = await everyRow({ search: "ZEBRA ask" });
    expect(zebra.total).toBe(ALL_SEATS.length);
    const one = await page({ search: "zebra", seats: [seatId(3) as never] });
    expect(one.rows.map((row) => row.seat.nodeId)).toEqual([seatId(3)]);
    expect(one.seatCounts).toHaveLength(ALL_SEATS.length);
  });

  it("counts the operator's unread from a seat's reply, and the unread filter keeps only those", async () => {
    const thread = (await page({ seats: [seatId(0) as never], search: "zebra" })).rows[0]!;
    await call(seatId(0), "msg.reply", { target: "operator", text: "done, see the diff", inReplyTo: thread.threadId });
    await call(seatId(0), "msg.reply", { target: "operator", text: "and one more", inReplyTo: thread.threadId });
    const unread = await page({ unread: true });
    expect(unread.total).toBe(1);
    // The page counts threads with something unread (one thread, two mails); the row's own unread is its mails.
    expect(unread.unread).toBe(1);
    expect(unread.regions.reduce((sum, region) => sum + region.unread, 0)).toBe(1);
    expect(unread.seatCounts.find((count) => count.seat.nodeId === seatId(0))?.unread).toBe(1);
    expect(unread.rows[0]).toMatchObject({ threadId: thread.threadId, unread: 2, last: { text: "and one more", from: { kind: "seat", nodeId: seatId(0) } } });
    // A seat's mail never waits.
    expect(unread.rows[0]!.last.waiting).toBeUndefined();
    // A read without the operator's points shows none: the CLI's.
    const seatRead = await runtime.runPromise(threadRowsPage(CANVAS, { who: "operator", seats: [seatId(0) as never], search: "zebra" }));
    expect(seatRead.rows[0]!.unread).toBe(0);
    await runtime.runPromise(markRead(CANVAS, seatId(0), thread.threadId));
    expect((await page({ unread: true })).total).toBe(0);
  });

  it("takes every thread, between seats included, for an overseer's read", async () => {
    for (const nodeId of [seatId(0), seatId(1)]) {
      const all = await runtime.runPromise(threadRowsPage(CANVAS, { who: "all", seats: [nodeId as never], limit: 200 }));
      // Its own ten with the operator (one more for s-000, which answered in one), and the one between the two.
      expect(all.rows.filter((row) => row.title.startsWith("between seats"))).toHaveLength(1);
      const operator = await runtime.runPromise(threadRowsPage(CANVAS, { who: "operator", seats: [nodeId as never], limit: 200 }));
      expect(all.total).toBe(operator.total + 1);
    }
  });

  it("a watch pushes the rows that changed and those that left, stamped after the page", async () => {
    const sent: OperatorThreadsChanged[] = [];
    const watches = makeThreadRowsWatches({
      run: (effect) => void runtime.runFork(effect as never),
      send: (_subscriber, change) => sent.push(change),
      read: (canvasName) => operatorThreadsView(canvasName) as never,
    });
    const before = await page({ region: ["Alpha"], limit: 5 });
    await runtime.runPromise(watches.watch(1, { canvasName: CANVAS as never, region: ["Alpha"] }));
    const root = await runtime.runPromise(write(seatId(9), "a new ask in alpha"));
    await runtime.runPromise(write(seatId(150), "a new ask in beta"));
    watches.changed(CANVAS);
    await expect.poll(() => sent.length, { timeout: 5_000 }).toBe(1);
    const change = sent[0]!;
    expect(change.rows.map((row) => row.threadId)).toEqual([root]);
    expect(change.gone).toEqual([]);
    expect(change.total).toBe(before.total + 1);
    expect(change.generation).toBeGreaterThan(before.generation);

    // The operator's next mail moves the row; nothing else is pushed.
    await runtime.runPromise(write(seatId(9), "and a follow up", root));
    watches.changed(CANVAS);
    await expect.poll(() => sent.length, { timeout: 5_000 }).toBe(2);
    expect(sent[1]!.rows.map((row) => [row.threadId, row.messageCount])).toEqual([[root, 2]]);

    // A change with nothing new pushes nothing; a window gone ends its watch.
    watches.changed(CANVAS);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(sent).toHaveLength(2);
    watches.windowGone(1);
    expect(watches.size()).toBe(0);
  });

  it("marks the operator's mail waiting until its seat has it, and a thousand receipts at once clear it live", async () => {
    // No seat is running here, so every mail of the operator still waits for its seat.
    const seats = Array.from({ length: 50 }, (_, n) => seatId(20 + n));
    const kept = { seats: seats as never[] };
    const before = await everyRow(kept);
    expect(before.rows.every((held) => held.last.waiting === true)).toBe(true);
    const sent: OperatorThreadsChanged[] = [];
    const watches = makeThreadRowsWatches({
      run: (effect) => void runtime.runFork(effect as never),
      send: (_subscriber, change) => sent.push(change),
      read: (canvasName) => operatorThreadsView(canvasName) as never,
    });
    await runtime.runPromise(watches.watch(2, { canvasName: CANVAS as never, ...kept }));

    // Every mail of fifty seats reaches its seat at once.
    const receipts = seats.flatMap((nodeId) => (operatorMail.get(nodeId) ?? []).map((messageId) => ({ nodeId, messageId })));
    expect(receipts).toHaveLength(seats.length * OPERATOR_THREADS_PER_SEAT * 2);
    await runtime.runPromise(
      Effect.forEach(receipts, ({ nodeId, messageId }) =>
        stampMailboxDeliveryReceipt({ canvas: CANVAS, nodeId, messageId, deliveryId: mailboxMessageDeliveryId(CANVAS, nodeId, messageId) }),
      ),
    );
    const started = performance.now();
    const after = await everyRow(kept);
    const clearedMs = performance.now() - started;
    process.stderr.write(`[operator-threads-across] ${String(receipts.length)} receipts at once: every row read again in ${clearedMs.toFixed(1)} ms\n`);
    expect(after.rows).toHaveLength(before.rows.length);
    expect(after.rows.some((held) => held.last.waiting === true)).toBe(false);
    // A seat none of it reached still waits.
    expect((await page({ seats: [seatId(150) as never], limit: 1 })).rows[0]!.last.waiting).toBe(true);
    // The watch pushed every row of those seats, its mark gone.
    watches.changed(CANVAS);
    await expect.poll(() => new Set(sent.flatMap((change) => change.rows.filter((held) => held.last.waiting === undefined).map((held) => held.threadId))).size, { timeout: 10_000 }).toBe(before.rows.length);
    watches.windowGone(2);
    expect(clearedMs).toBeLessThan(2_000);
  }, 120_000);

  it("pages under new mail: a thread that moves is pushed, and the pages repeat nothing and lose nothing", async () => {
    const kept = { seats: Array.from({ length: 10 }, (_, n) => seatId(180 + n)) as never[] };
    const all = (await everyRow(kept)).rows.map((held) => held.threadId);
    expect(all).toHaveLength(10 * OPERATOR_THREADS_PER_SEAT);
    const sent: OperatorThreadsChanged[] = [];
    const watches = makeThreadRowsWatches({
      run: (effect) => void runtime.runFork(effect as never),
      send: (_subscriber, change) => sent.push(change),
      read: (canvasName) => operatorThreadsView(canvasName) as never,
    });
    await runtime.runPromise(watches.watch(3, { canvasName: CANVAS as never, ...kept }));

    const first = await page({ ...kept, limit: 30 });
    // New mail in a thread page one holds, and in one page two would hold.
    const onFirst = first.rows[5]!;
    const onSecond = all[40]!;
    const seatOf = (threadId: string) => kept.seats.find((nodeId) => (operatorMail.get(nodeId) ?? []).includes(threadId))!;
    await runtime.runPromise(write(seatOf(onFirst.threadId), "news on page one", onFirst.threadId));
    await runtime.runPromise(write(seatOf(onSecond), "news on page two", onSecond));
    watches.changed(CANVAS);

    const paged = [...first.rows.map((held) => held.threadId)];
    let after = first.next;
    while (after !== undefined) {
      const next = await page({ ...kept, limit: 30, after });
      paged.push(...next.rows.map((held) => held.threadId));
      after = next.next;
    }
    // Nothing twice; the thread that moved above the cursor is the one the pages lost.
    expect(new Set(paged).size).toBe(paged.length);
    expect(paged).not.toContain(onSecond);
    expect(paged).toHaveLength(all.length - 1);
    // The watch pushed both moved threads, so pages and pushes hold every thread.
    await expect.poll(() => new Set(sent.flatMap((change) => change.rows.map((held) => held.threadId))), { timeout: 10_000 }).toEqual(new Set([onFirst.threadId, onSecond]));
    expect(new Set([...paged, ...sent.flatMap((change) => change.rows.map((held) => held.threadId))])).toEqual(new Set(all));
    watches.windowGone(3);
  }, 60_000);

  it("reads the first page in time on thousands of mails", () => {
    expect(seeded).toBeGreaterThanOrEqual(4_000);
    // A loose bound for a loaded machine; the number itself is printed above.
    expect(warmPageMs).toBeLessThan(500);
  });
});
