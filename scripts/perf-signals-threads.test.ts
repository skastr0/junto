/** Phase bench for operator signal answers and thread writes on the anonymised factory shape. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { ulid } from "ulid";
import { it } from "vitest";
import { OperatorThreadSend } from "../src/shared/mail-threads";
import { makeUserMessage } from "../src/shared/task";
import { mailExtensionMetadata } from "../src/shared/crew";
import { OPERATOR_SEAT_ID } from "../src/shared/work-reference";
import { ModelStoresLive, seedCanvasRows } from "../tests/support/seed-canvas";
import { nameThisMachine } from "../tests/support/name-this-machine";
import { WorkLive } from "../src/core/work/service";
import { WorkService } from "../src/core/work/service";
import { CrewRepositoryLive } from "../src/core/work/crew-repository";
import { WorkRepositoryLive, WorkRepository } from "../src/core/work/repository";
import { MachineRepositoryLive } from "../src/core/machines/repository";
import { SettingsLive } from "../src/core/settings/service";
import { makeContentServiceLive } from "../src/core/content/service";
import { makeStateEngineLive } from "../src/core/state/engine";
import { makeInstallOpsLive } from "../src/core/install-ops/engine";
import { RulingRecorderLive } from "../src/core/work/ruling-recorder";
import { TaskRepositoryLive } from "../src/core/work/task-repository";
import { ArtifactRepositoryLive } from "../src/core/work/artifact-repository";
import { AgentSignalRepositoryLive, AgentSignalRepository } from "../src/core/signals/repository";
import { PausePlaneAllPlaying } from "../src/core/pause-plane";
import { sendOperatorThreadMail, deliverOperatorThreadMail, seatThreadsPage, seatThreadMessagesPage } from "../src/core/work/operator-threads";
import { answerAgentSignal } from "../src/core/signals/operator";
import { makeMessageDeliveryStore } from "../src/core/work/message-delivery-store";
import { messageDelivery, type MessageDeliveryStore } from "../src/core/work/message-delivery";
import { setHostsSnapshot } from "../src/core/hosts/snapshot";
import { defaultRemoteHostsDocument } from "../src/shared/remote-hosts";
import { stampMailboxDeliveryReceipt } from "../src/core/work/delivery-receipts";
import { mailboxMessageDeliveryId, mailboxMessageReadId } from "../src/core/work/mailbox-receipts";
import { armMainThreadBudget, resetStatementTiming, statementTimingTop } from "../src/node/observability/main-thread-budget";

const CANVAS = "factory";
const root = mkdtempSync(join(tmpdir(), "junto-perf-signals-"));
const fixture = JSON.parse(readFileSync("e2e/scenarios/zz-proof-factory-shape.json", "utf8")).model;
const seats = fixture.nodes.filter((n: any) => n.kind === "agent");
const target = seats[0].id;
const binding = seats[0].bindingId;

const makeRuntime = () => {
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      MachineRepositoryLive,
      SettingsLive,
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
      AgentSignalRepositoryLive,
    ),
    Layer.mergeAll(makeStateEngineLive(join(root, "state", "junto.db")), makeInstallOpsLive(join(root, "state", "install-ops.db"))),
  );
  const rulersLive = Layer.provide(Layer.mergeAll(TaskRepositoryLive, ArtifactRepositoryLive), RulingRecorderLive);
  const canvasesLive = Layer.provideMerge(Layer.mergeAll(ModelStoresLive, rulersLive), repositoriesLive);
  return ManagedRuntime.make(Layer.mergeAll(Layer.provideMerge(WorkLive, canvasesLive), PausePlaneAllPlaying));
};

type Stat = { ms: number; calls: number; max: number };
const stats = new Map<string, Stat>();
const note = (name: string, ms: number) => {
  const held = stats.get(name) ?? { ms: 0, calls: 0, max: 0 };
  held.ms += ms; held.calls += 1; held.max = Math.max(held.max, ms);
  stats.set(name, held);
};
const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
  const at = performance.now();
  try { return await run(); } finally { note(name, performance.now() - at); }
};
const resetStats = () => stats.clear();
const statRows = () => [...stats.entries()].map(([name, s]) => ({ name, ms: round(s.ms), calls: s.calls, max: round(s.max), mean: round(s.ms / s.calls) })).sort((a, b) => b.ms - a.ms);
const round = (n: number) => Math.round(n * 100) / 100;
const runEff = <T>(runtime: ReturnType<typeof makeRuntime>, effect: Effect.Effect<T, unknown, any>): Promise<T> =>
  runtime.runPromise(effect as Effect.Effect<T, unknown, never>);

const seedMail = async (runtime: ReturnType<typeof makeRuntime>) => {
  const active = seats.slice(0, 30);
  const rows: Array<{ nodeId: string; message: any }> = [];
  for (const seat of active) {
    for (let thread = 0; thread < 20; thread += 1) {
      const rootId = ulid();
      for (let index = 0; index < 10; index += 1) {
        const messageId = index === 0 ? rootId : ulid();
        rows.push({
          nodeId: seat.id,
          message: makeUserMessage({
            messageId,
            text: `seed mail ${thread}/${index}`,
            contextId: CANVAS,
            metadata: {
              factoryMail: true,
              deliveredAt: "2026-01-01T00:00:00.000Z",
              readAt: "2026-01-01T00:00:01.000Z",
              ...mailExtensionMetadata({ mailKind: "notice", fromSeat: OPERATOR_SEAT_ID, senderNodeId: "operator", senderName: "operator", senderGeneration: "operator", senderHarness: "unknown" }),
              ...(index === 0 ? {} : { threadId: rootId }),
            },
          }),
        });
      }
    }
  }
  await runEff(runtime, Effect.gen(function* () {
    const work = yield* WorkService;
    for (const row of rows) yield* work.workSystemMailboxNotify(CANVAS, row.nodeId, row.message);
  }));
  return rows;
};

const configureDelivery = async (runtime: ReturnType<typeof makeRuntime>, writeDelayMs = 0) => {
  const store = await runEff(runtime, makeMessageDeliveryStore() as Effect.Effect<MessageDeliveryStore, unknown, any>);
  const wrapped = {
    ...store,
    readModel: (canvas: string, site: any) => timed("delivery.store.readModel", () => store.readModel(canvas, site)),
    readMessage: (canvas: string, nodeId: string, messageId: string) => timed("delivery.store.readMessage", () => store.readMessage(canvas, nodeId, messageId)),
    editsCanvas: store.editsCanvas === undefined ? undefined : (canvas: string) => timed("delivery.store.editsCanvas", () => store.editsCanvas!(canvas)),
    signalOf: store.signalOf === undefined ? undefined : (signalId: string) => timed("delivery.store.signalOf", () => store.signalOf!(signalId)),
    acceptMessageDelivery: (canvas: string, nodeId: string, messageId: string, read: boolean) => timed("delivery.store.acceptMessageDelivery", () => store.acceptMessageDelivery(canvas, nodeId, messageId, read)),
  };
  messageDelivery.configure({
    store: wrapped as any,
    transport: {
      seatLive: () => true,
      seatReadyForQuiet: () => true,
      seatOnboarded: () => true,
      writeMail: async () => {
        await timed("delivery.transport.writeMail", async () => {
          if (writeDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, writeDelayMs));
        });
        return "written" as const;
      },
    },
  });
};


const timedEffect = <A, E, R>(name: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const at = yield* Effect.sync(() => performance.now());
    const value = yield* effect;
    note(name, performance.now() - at);
    return value;
  });

const measureReceipts = async (runtime: ReturnType<typeof makeRuntime>, rows: ReadonlyArray<{ nodeId: string; message: any }>) =>
  runEff(runtime, Effect.gen(function* () {
    const repository = yield* WorkRepository;
    const wrapped = {
      ...repository,
      acceptedDeliveries: (sink: any, deliveryIds: ReadonlyArray<string>) =>
        timedEffect("receipt.repo.acceptedDeliveries", repository.acceptedDeliveries(sink, deliveryIds)),
      acceptDelivery: (input: any) =>
        timedEffect("receipt.repo.acceptDelivery", repository.acceptDelivery(input)),
    };
    const totals: number[] = [];
    resetStats();
    armMainThreadBudget({ enabled: true, throwOnViolation: false, force: true });
    resetStatementTiming();
    for (const row of rows) {
      const at = performance.now();
      yield* stampMailboxDeliveryReceipt({
        canvas: CANVAS,
        nodeId: row.nodeId,
        messageId: row.message.messageId,
        deliveryId: mailboxMessageDeliveryId(CANVAS, row.nodeId, row.message.messageId),
        readId: mailboxMessageReadId(CANVAS, row.nodeId, row.message.messageId),
      }).pipe(Effect.provideService(WorkRepository, wrapped as any));
      totals.push(performance.now() - at);
    }
    const ordered = [...totals].sort((a, b) => a - b);
    return {
      count: totals.length,
      medianMs: round(ordered[Math.floor(ordered.length / 2)]!),
      bestMs: round(ordered[0]!),
      maxMs: round(ordered[ordered.length - 1]!),
      phases: statRows(),
      statements: statementTimingTop(12).map((row) => ({ ...row, totalMs: round(row.totalMs), maxMs: round(row.maxMs) })),
    };
  }));

const decodeSend = Schema.decodeUnknownSync(OperatorThreadSend);
const writeThread = (runtime: ReturnType<typeof makeRuntime>, input: object) =>
  runEff(runtime, sendOperatorThreadMail(decodeSend(input)) as any);

const measure = async () => {
  const runtime = makeRuntime();
  try {
    await runEff(runtime, nameThisMachine as any);
    setHostsSnapshot(defaultRemoteHostsDocument("studio").hosts);
    await runEff(runtime, seedCanvasRows({ seq: 1, canvases: new Map([[CANVAS, { nodes: fixture.nodes as any, wires: fixture.wires as any }]]) }) as any);
    const seeded = await seedMail(runtime);
    const mailCount = seeded.length;
    await configureDelivery(runtime, Number(process.env.PERF_WRITE_DELAY_MS ?? 0));
    const out: any = { canvas: { seats: seats.length, nodes: fixture.nodes.length, wires: fixture.wires.length, seededMails: mailCount }, cases: [] };

    const measureDeliveryCase = async (name: string, write: () => Promise<any>) => {
      resetStats();
      const writeAt = performance.now();
      const written = await write();
      const writeMs = performance.now() - writeAt;
      const phasesAfterWrite = statRows();
      resetStats();
      const deliverAt = performance.now();
      const sent = await deliverOperatorThreadMail(CANVAS, target, written as any);
      const deliveryMs = performance.now() - deliverAt;
      const phasesDelivery = statRows();
      resetStats();
      const readAt = performance.now();
      await runEff(runtime, seatThreadsPage(CANVAS, target, { limit: 50 }) as any);
      const threadsListMs = performance.now() - readAt;
      const msgAt = performance.now();
      if ((written as any).threadId !== undefined) await runEff(runtime, seatThreadMessagesPage(CANVAS, target, (written as any).threadId, { limit: 50 }) as any);
      const threadMessagesMs = performance.now() - msgAt;
      out.cases.push({ name, writeMs: round(writeMs), deliveryMs: round(deliveryMs), delivery: sent, writePhases: phasesAfterWrite, deliveryPhases: phasesDelivery, reread: { seatThreadsPageMs: round(threadsListMs), seatThreadMessagesPageMs: round(threadMessagesMs) } });
      return written;
    };

    const created = await measureDeliveryCase("thread-create-1-recipient", () => writeThread(runtime, { canvasName: CANVAS, nodeId: target, text: "measure thread create" }));
    await measureDeliveryCase("thread-reply-1-recipient", () => writeThread(runtime, { canvasName: CANVAS, nodeId: target, threadId: (created as any).threadId, inReplyTo: (created as any).messageId, text: "measure thread reply" }));

    resetStats();
    const signalIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const raised = await runEff(runtime, Effect.flatMap(AgentSignalRepository, (repo) => repo.raise({ canvasName: CANVAS, nodeId: target, kind: "blocked", text: `measure signal ${i}` })) as any);
      signalIds.push((raised as any).signalId);
    }
    const signalRuns: any[] = [];
    for (const signalId of signalIds) {
      resetStats();
      const at = performance.now();
      const answered = await runEff(runtime, answerAgentSignal(signalId, "measure answer", { attachments: [] }) as any);
      const answerMs = performance.now() - at;
      resetStats();
      const deliverAt = performance.now();
      const delivery = await messageDelivery.deliver(CANVAS, target, (answered as any).messageId);
      const deliveryMs = performance.now() - deliverAt;
      signalRuns.push({ signalId, answerMs: round(answerMs), deliveryMs: round(deliveryMs), delivery, deliveryPhases: statRows() });
    }
    out.signalAnswer = signalRuns;
    out.deliveryReceipt = await measureReceipts(runtime, seeded.filter((row) => row.nodeId === target).slice(0, 24));
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await runtime.dispose();
    messageDelivery.resetForTest();
    rmSync(root, { recursive: true, force: true });
  }
};

if (process.env.VITEST === "true") {
  it("measures signal answers and thread writes by phase", async () => {
    await measure();
  }, 180_000);
} else {
  await measure();
}
