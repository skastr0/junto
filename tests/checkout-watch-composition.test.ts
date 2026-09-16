import { randomUUID } from "node:crypto";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { readMailExtension } from "../src/shared/crew";
import type { TerminalSessionSummary } from "../src/shared/terminal";
import { IntentFactBasis } from "../src/shared/work-protocol";
import { runCli } from "../src/main/junto/adapters/exec";
import { CanvasError, CanvasesLive, CanvasesService } from "../src/main/junto/canvases";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { makeSettingsLive, SettingsService } from "../src/main/junto/settings/service";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";
import { StationFleetTargetRepositoryLive } from "../src/main/junto/station/fleet-target-repository";
import { StationRepositoryLive } from "../src/main/junto/station/repository";
import { StationLivePeerRegistryLive } from "../src/main/junto/station/session-registry";
import { makeCheckoutWatchComposition } from "../src/main/junto/work/checkout-watch-composition";
import { CrewRepository, CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { MessageDeliveryService } from "../src/main/junto/work/message-delivery";
import { WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { WorkLive, WorkService, type WorkOpResult } from "../src/main/junto/work/service";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});
afterEach(() => vi.restoreAllMocks());

const applied = <T>(result: WorkOpResult<T>): T => {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.message);
  expect(result.disposition).toBe("applied");
  return result.data;
};

const git = async (args: readonly string[]): Promise<string> => {
  const result = await runCli("git", args, 15_000);
  if (!result.ok) throw new Error(result.error ?? result.stdout);
  return result.stdout.trim();
};

const checkout = async (path: string) => {
  await mkdir(path, { recursive: true });
  await git(["init", "-q", "-b", "main", path]);
  const cwd = await realpath(path);
  let sequence = 0;
  const commit = async () => {
    await writeFile(join(cwd, "change.txt"), `change ${++sequence}\n`);
    await git(["-C", cwd, "add", "change.txt"]);
    await git([
      "-C", cwd, "-c", "user.name=Checkout test", "-c", "user.email=checkout@local",
      "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null",
      "commit", "-q", "-m", `change ${sequence}`,
    ]);
    return git(["-C", cwd, "rev-parse", "HEAD"]);
  };
  const baseline = await commit();
  return { cwd, commit, baseline };
};

const fixture = async (canvas: string) => {
  const root = join(tmpdir(), `junto-checkout-composition-${randomUUID()}`);
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive, CrewRepositoryLive, StationRepositoryLive, StationFleetTargetRepositoryLive,
      makeSettingsLive({ ensureDefaultCommandCenter: false }),
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "junto.db")),
      makeInstallOpsLive(join(root, "install-ops.db")),
    ),
  );
  const runtime = ManagedRuntime.make(Layer.provideMerge(
    WorkLive,
    Layer.mergeAll(Layer.provideMerge(CanvasesLive, repositories), StationLivePeerRegistryLive),
  ));
  cleanups.push(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  const settings = await runtime.runPromise(SettingsService);
  await runtime.runPromise(settings.setStationTopology({
    role: "command-center", hostId: "local", supervisedPreferred: true,
  }));
  const canvases = await runtime.runPromise(CanvasesService);
  const work = await runtime.runPromise(WorkService);
  const workRepository = await runtime.runPromise(WorkRepository);
  const crew = await runtime.runPromise(CrewRepository);
  const state = await runtime.runPromise(StateEngine);
  const liveCheckout = await checkout(join(root, "live-checkout"));
  const launchCheckout = await checkout(join(root, "launch-checkout"));
  const agent = (id: string, name: string): CanvasDoc["nodes"][number] => ({
    id, type: "text", text: id, x: 0, y: 0, width: 200, height: 100,
    ether: {
      entity: { kind: "agent", name: `local:${name}-${id}` }, host: "local",
      terminal: {
        bindingId: `${name}-${id}`, harness: "claude",
        launch: { kind: "harness", argv: ["claude"], cwd: launchCheckout.cwd },
      },
    },
  });
  const seedCanvas = async (name: string) => {
    await runtime.runPromise(canvases.write(name, {
      nodes: [agent("author", name), agent("reviewer", name), {
        id: "tasks", type: "text", text: "tasks", x: 400, y: 0, width: 200, height: 100,
        ether: { entity: { kind: "task" }, tasks: { items: [], contract: { incoming: { admission: "auto" } } } },
      }],
      edges: [
        { id: "claim", fromNode: "tasks", toNode: "author", ether: { verb: "works" } },
        { id: "review", fromNode: "reviewer", toNode: "author", ether: { verb: "reviews" } },
      ],
    }));
    const read = await runtime.runPromise(canvases.read(name));
    const author = read.actorRefs.find((ref) => ref.nodeId === "author");
    const reviewer = read.actorRefs.find((ref) => ref.nodeId === "reviewer");
    if (author === undefined || reviewer === undefined) throw new Error("Missing fixture actor refs");
    const task = applied(await runtime.runPromise(work.workTaskCreate(
      name, "tasks", "Observe checkout commits", { details: "Publish independent review receipts" },
      undefined, undefined, undefined, undefined, undefined, { admission: "auto" },
    )));
    applied(await runtime.runPromise(work.workTaskClaim(name, "tasks", task.id, author)));
    return { author, reviewer, task };
  };
  const { author, reviewer, task } = await seedCanvas(canvas);

  const originalSession: TerminalSessionSummary = {
    bindingId: `${canvas}-author`, epoch: "checkout-generation-1", hostId: "local",
    status: "running", pid: 12_345, detached: false, canvasName: canvas, nodeId: "author",
    createdAt: 1, harness: "claude", agentKey: `local:${canvas}-author`, cwd: liveCheckout.cwd,
  };
  const sessions = new Map<string, TerminalSessionSummary>([[originalSession.bindingId, originalSession]]);
  const host = { get: (bindingId: string) => sessions.get(bindingId) };
  let successfulWrites = 0;
  let heldWrite: { readonly arrive: () => void; readonly released: Promise<void> } | undefined;
  const write = async <A, E>(effect: Effect.Effect<A, E>): Promise<A> => {
    const held = heldWrite;
    heldWrite = undefined;
    if (held !== undefined) {
      held.arrive();
      await held.released;
    }
    const value = await runtime.runPromise(effect);
    successfulWrites += 1;
    return value;
  };
  const rows = () => state.read("test.checkout-watch.receipts", (reader) => ({
    receipts: reader.all<{
      readonly message_id: string; readonly ref_sha: string;
      readonly author_seat_id: string; readonly reviewer_seat_id: string;
    }>("SELECT message_id, ref_sha, author_seat_id, reviewer_seat_id FROM work_review_receipts WHERE canvas_name = ? ORDER BY ref_sha", [canvas]),
    messages: reader.all<{ readonly message_id: string }>(
      "SELECT message_id FROM work_messages WHERE canvas_name = ? AND node_id = 'reviewer' ORDER BY position", [canvas],
    ),
    observations: reader.all<{ readonly sha: string; readonly seat_id: string | null }>(
      "SELECT sha, seat_id FROM work_review_checkout_observations WHERE checkout_key = ? ORDER BY sha", [liveCheckout.cwd],
    ),
  }));
  const notificationRows = () => Effect.runSync(rows());
  const atNotification: Array<{
    readonly successfulWrites: number;
    readonly messageId: string;
    readonly rows: ReturnType<typeof notificationRows>;
  }> = [];
  const delivery = new MessageDeliveryService();
  const originalNotify = delivery.notifyAppended.bind(delivery);
  const notify = vi.spyOn(delivery, "notifyAppended").mockImplementation((name, nodeId, message) => {
    atNotification.push({ successfulWrites, messageId: message.messageId, rows: notificationRows() });
    originalNotify(name, nodeId, message);
  });
  const errors: unknown[] = [];
  const supervisor = makeCheckoutWatchComposition({
    canvases, settings, host, crew, workRepository, messageDelivery: delivery,
    basisFor: (witness) => Schema.decodeUnknownSync(IntentFactBasis)({ kind: "authorial-intent", ...witness }),
    run: (effect) => runtime.runPromise(effect), write,
    onError: (error) => errors.push(error),
  });
  cleanups.push(async () => { supervisor.stop(); delivery.suspend(); });
  const scan = () => runtime.runPromise(supervisor.scanOnce());
  const inbox = async () => (await runtime.runPromise(workRepository.readSnapshot(canvas, "reviewer"))).messages.items;
  const holdNextWrite = () => {
    let arrive!: () => void;
    let release!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arrived = new Promise<void>((resolve, reject) => {
      arrive = () => { if (timer !== undefined) clearTimeout(timer); resolve(); };
      timer = setTimeout(() => reject(new Error(`Checkout receipt did not reach the write gate: ${JSON.stringify(errors)}`)), 3_000);
    });
    const released = new Promise<void>((resolve) => { release = resolve; });
    heldWrite = { arrive, released };
    return { arrived, release: () => { if (timer !== undefined) clearTimeout(timer); release(); } };
  };
  return {
    canvas, author, reviewer, task, canvases, runtime, supervisor, scan, inbox, notify, atNotification,
    liveCheckout, launchCheckout, originalSession, errors, holdNextWrite,
    rows: () => runtime.runPromise(rows()),
    setSession: (next: TerminalSessionSummary | undefined) => {
      if (next === undefined) sessions.delete(originalSession.bindingId);
      else sessions.set(originalSession.bindingId, next);
    },
    addCompetingCanvas: async (name: string) => {
      const competing = await seedCanvas(name);
      const bindingId = `${name}-author`;
      const competingSession: TerminalSessionSummary = {
        ...originalSession, bindingId, canvasName: name,
        epoch: "competing-generation", pid: 12_347, agentKey: `local:${name}-author`,
      };
      sessions.set(bindingId, competingSession);
      return {
        ...competing,
        setLive: (live: boolean) => {
          if (live) sessions.set(bindingId, competingSession);
          else sessions.delete(bindingId);
        },
        inbox: async () => (await runtime.runPromise(workRepository.readSnapshot(name, "reviewer"))).messages.items,
      };
    },
  };
};

describe("checkout watch application composition", () => {
  it("uses only an actual live session cwd and attaches with a silent Git baseline", async () => {
    const f = await fixture("checkout-live-cwd");
    f.setSession(undefined);
    expect((await f.scan())[0]?.receipt.checkouts).toBe(0);
    await f.launchCheckout.commit();
    const { cwd: _cwd, ...withoutCwd } = f.originalSession;
    f.setSession(withoutCwd);
    expect((await f.scan())[0]?.receipt.checkouts).toBe(0);
    f.setSession(f.originalSession);
    expect((await f.scan())[0]?.receipt).toMatchObject({ checkouts: 1, observed: 0, receiptsDelivered: 0 });
    await f.launchCheckout.commit();
    expect((await f.scan())[0]?.receipt.observed).toBe(0);
    expect(await f.inbox()).toEqual([]);
    expect(await f.rows()).toEqual({ receipts: [], messages: [], observations: [] });
    expect(f.notify).not.toHaveBeenCalled();
  });

  it("commits real checkout receipts before notification with the current sender generation", async () => {
    const f = await fixture("checkout-receipt-commit");
    await f.scan();
    const sha = await f.liveCheckout.commit();
    const receipt = (await f.scan())[0]?.receipt;
    expect(receipt, JSON.stringify(f.errors)).toMatchObject({ observed: 1, attributed: 1, receiptsDelivered: 1, receiptsAppended: 1, failed: 0 });
    const mail = await f.inbox();
    expect(mail).toHaveLength(1);
    expect(readMailExtension(mail[0]!.metadata)).toMatchObject({
      mailKind: "receipt", fromSeat: f.author.seatId,
      senderGeneration: f.originalSession.epoch, senderHarness: f.originalSession.harness,
      refs: [{ kind: "commit", sha }],
    });
    expect(f.notify).toHaveBeenCalledExactlyOnceWith(f.canvas, "reviewer", mail[0]);
    expect(f.atNotification).toEqual([expect.objectContaining({
      successfulWrites: 1, messageId: mail[0]!.messageId,
      rows: expect.objectContaining({
        messages: [{ message_id: mail[0]!.messageId }],
        receipts: [{ message_id: mail[0]!.messageId, ref_sha: sha, author_seat_id: f.author.seatId, reviewer_seat_id: f.reviewer.seatId }],
      }),
    })]);
    const durable = await f.rows();
    expect(durable.observations).toEqual([{ sha, seat_id: f.author.seatId }]);
    await f.scan();
    expect(await f.rows()).toEqual(durable);
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it("preserves the Git baseline across one failed canvas read and recovers the real commit", async () => {
    const f = await fixture("checkout-read-recovery");
    await f.scan();
    const sha = await f.liveCheckout.commit();
    vi.spyOn(f.canvases, "readWithIntentWitness").mockImplementationOnce(() =>
      Effect.fail(new CanvasError({ message: "injected checkout canvas read failure" })),
    );
    await expect(f.scan()).rejects.toThrow(/injected checkout canvas read failure/);
    expect(await f.rows()).toEqual({ receipts: [], messages: [], observations: [] });
    expect((await f.scan())[0]?.receipt).toMatchObject({ observed: 1, receiptsDelivered: 1, failed: 0 });
    const mail = await f.inbox();
    expect(mail).toHaveLength(1);
    expect(readMailExtension(mail[0]!.metadata)?.refs).toEqual([{ kind: "commit", sha }]);
    expect(f.notify).toHaveBeenCalledTimes(1);
  });

  it("refuses a held receipt on generation change and preserves original provenance when retried", async () => {
    const f = await fixture("checkout-generation-race");
    await f.scan();
    const oldSha = await f.liveCheckout.commit();
    const gate = f.holdNextWrite();
    const pending = f.scan();
    try {
      await gate.arrived;
      f.setSession({ ...f.originalSession, epoch: "checkout-generation-2", pid: 12_346 });
      gate.release();
      expect((await pending)[0]?.receipt.failed).toBeGreaterThan(0);
      expect(await f.inbox()).toEqual([]);
      expect(f.notify).not.toHaveBeenCalled();
      await f.scan();
      const retried = await f.inbox();
      expect(retried).toHaveLength(1);
      expect(readMailExtension(retried[0]!.metadata)).toMatchObject({
        senderGeneration: f.originalSession.epoch, senderHarness: f.originalSession.harness,
        refs: [{ kind: "commit", sha: oldSha }],
      });
      const newSha = await f.liveCheckout.commit();
      await f.scan();
      const mail = await f.inbox();
      expect(mail).toHaveLength(2);
      expect(mail[0]).toEqual(retried[0]);
      expect(readMailExtension(mail[1]!.metadata)).toMatchObject({
        senderGeneration: "checkout-generation-2", refs: [{ kind: "commit", sha: newSha }],
      });
      expect((await f.rows()).receipts.map((receipt) => receipt.ref_sha).sort()).toEqual([oldSha, newSha].sort());
    } finally {
      gate.release();
      await Promise.allSettled([pending]);
    }
  });

  it("stops a queued receipt write before it can persist or notify", async () => {
    const f = await fixture("checkout-stop-queued-write");
    await f.scan();
    await f.liveCheckout.commit();
    const gate = f.holdNextWrite();
    const pending = f.scan();
    try {
      await gate.arrived;
      f.supervisor.stop();
      gate.release();
      await pending;
      expect(await f.rows()).toEqual({ receipts: [], messages: [], observations: [] });
      expect(await f.inbox()).toEqual([]);
      expect(f.notify).not.toHaveBeenCalled();
    } finally {
      gate.release();
      await Promise.allSettled([pending]);
    }
  });

  it("keeps a commit unattributed when live authors on two canvases share its checkout", async () => {
    const f = await fixture("checkout-shared-first");
    const other = await f.addCompetingCanvas("checkout-shared-second");
    expect(other.author.seatId).not.toBe(f.author.seatId);
    const baseline = await f.scan();
    expect(baseline.map((entry) => entry.canvasName)).toEqual([f.canvas, "checkout-shared-second"]);
    expect(baseline.map((entry) => entry.receipt.observed)).toEqual([0, 0]);
    const sha = await f.liveCheckout.commit();
    const originalRead = f.canvases.readWithIntentWitness.bind(f.canvases);
    let failForeignRead = true;
    const failedRead = vi.spyOn(f.canvases, "readWithIntentWitness").mockImplementation((...args) => {
      if (args[0] === "checkout-shared-second" && failForeignRead) {
        failForeignRead = false;
        return Effect.fail(new CanvasError({ message: "injected competing-canvas read failure" }));
      }
      return originalRead(...args);
    });
    await expect(f.scan()).rejects.toThrow(/injected competing-canvas read failure/);
    expect(await f.rows()).toEqual({ receipts: [], messages: [], observations: [] });
    failedRead.mockRestore();
    await f.scan();
    expect(await f.inbox()).toEqual([]);
    expect(await other.inbox()).toEqual([]);
    expect(f.notify).not.toHaveBeenCalled();
    expect(await f.rows()).toEqual({ receipts: [], messages: [], observations: [{ sha, seat_id: null }] });
  });

  it("rechecks cross-canvas ambiguity when a competing author starts behind the receipt write gate", async () => {
    const f = await fixture("checkout-gate-first");
    const other = await f.addCompetingCanvas("checkout-gate-second");
    other.setLive(false);
    const baseline = await f.scan();
    expect(baseline.map((entry) => entry.receipt.checkouts)).toEqual([1, 0]);
    const before = await f.runtime.runPromise(f.canvases.readWithIntentWitness(f.canvas));
    await f.liveCheckout.commit();
    const gate = f.holdNextWrite();
    const pending = f.scan();
    try {
      await gate.arrived;
      other.setLive(true);
      const afterStart = await f.runtime.runPromise(f.canvases.readWithIntentWitness(f.canvas));
      expect(afterStart.intentWitness).toEqual(before.intentWitness);
      expect(afterStart.read.doc).toEqual(before.read.doc);
      gate.release();
      const scan = await pending;
      expect(scan.find((entry) => entry.canvasName === f.canvas)?.receipt.failed).toBeGreaterThan(0);
      expect(await f.inbox()).toEqual([]);
      expect(await other.inbox()).toEqual([]);
      expect((await f.rows()).receipts).toEqual([]);
      expect(f.notify).not.toHaveBeenCalled();
      await f.scan();
      expect(await f.inbox()).toEqual([]);
      expect(await other.inbox()).toEqual([]);
      expect(f.notify).not.toHaveBeenCalled();
    } finally {
      gate.release();
      await Promise.allSettled([pending]);
    }
  });
});
