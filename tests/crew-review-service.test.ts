import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CanvasDoc, CanvasEdge } from "../src/shared/canvas";
import { readMailExtension, type MailSenderStamp } from "../src/shared/crew";
import type { CompletionEvidence } from "../src/shared/work-model";
import type { ActorRef } from "../src/shared/work-reference";
import { CanvasesLive, CanvasesService } from "../src/main/vellum-command/canvases";
import { makeContentServiceLive } from "../src/main/vellum-command/content/service";
import { makeInstallOpsLive } from "../src/main/vellum-command/install-ops/engine";
import { makeSettingsLive, SettingsService } from "../src/main/vellum-command/settings/service";
import { makeStateEngineLive, StateEngine } from "../src/main/vellum-command/state/engine";
import { StationFleetTargetRepositoryLive } from "../src/main/vellum-command/station/fleet-target-repository";
import { StationRepositoryLive } from "../src/main/vellum-command/station/repository";
import { StationLivePeerRegistryLive } from "../src/main/vellum-command/station/session-registry";
import { CrewRepository, CrewRepositoryLive } from "../src/main/vellum-command/work/crew-repository";
import { WorkRepository, WorkRepositoryLive } from "../src/main/vellum-command/work/repository";
import { reviewSubjectProjection } from "../src/main/vellum-command/work/reviews";
import { WorkLive, WorkService, type WorkOpResult, type WorkTaskShowView } from "../src/main/vellum-command/work/service";

const root = join(tmpdir(), `vellum-command-crew-review-service-${randomUUID()}`);
const makeRuntime = () => {
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      CrewRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      makeSettingsLive({ ensureDefaultCommandCenter: false }),
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(
      makeStateEngineLive(join(root, "vellum-command.db")),
      makeInstallOpsLive(join(root, "install-ops.db")),
    ),
  );
  return ManagedRuntime.make(Layer.provideMerge(
    WorkLive,
    Layer.mergeAll(Layer.provideMerge(CanvasesLive, repositories), StationLivePeerRegistryLive),
  ));
};
let runtime = makeRuntime();

let work: Context.Service.Shape<typeof WorkService>;
let canvases: Context.Service.Shape<typeof CanvasesService>;
let repository: Context.Service.Shape<typeof WorkRepository>;
let crew: Context.Service.Shape<typeof CrewRepository>;
let state: Context.Service.Shape<typeof StateEngine>;

const readServices = async () => {
  work = await runtime.runPromise(WorkService);
  canvases = await runtime.runPromise(CanvasesService);
  repository = await runtime.runPromise(WorkRepository);
  crew = await runtime.runPromise(CrewRepository);
  state = await runtime.runPromise(StateEngine);
};

beforeAll(async () => {
  const settings = await runtime.runPromise(SettingsService);
  await runtime.runPromise(settings.setStationTopology({
    role: "command-center", hostId: "local", supervisedPreferred: true,
  }));
  await readServices();
});

afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const REVIEW_RULE = "independent-review";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

const agent = (id: string, canvas: string): CanvasDoc["nodes"][number] => ({
  id, type: "text", text: id, x: 0, y: 0, width: 200, height: 100,
  ether: {
    entity: { kind: "agent", name: `local:${canvas}-${id}` },
    host: "local",
    terminal: {
      bindingId: `binding-${canvas}-${id}`,
      launch: { kind: "harness", argv: ["claude"] },
      harness: "claude",
    },
  },
});

const reviewEdge: CanvasEdge = {
  id: "review", fromNode: "reviewer", toNode: "author", ether: { verb: "reviews" },
};

const board = (id: string, requiresReview = false): CanvasDoc["nodes"][number] => ({
  id, type: "text", text: id, x: 400, y: 0, width: 200, height: 100,
  ether: {
    entity: { kind: "task" },
    tasks: {
      items: [],
      contract: {
        incoming: { admission: "auto" },
        ...(requiresReview ? {
          rules: [{ id: REVIEW_RULE, text: "Independent review is green", kind: "requires-review" as const }],
        } : {}),
      },
    },
  },
});

const applied = <T>(result: WorkOpResult<T>): T => {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.message);
  expect(result.disposition).toBe("applied");
  return result.data;
};

const evidence = (commits: readonly string[] = []): CompletionEvidence => ({
  artifacts: [],
  git: { commits },
  claims: [{ ruleId: REVIEW_RULE, text: "The independent verdict is available" }],
});

const fixture = async (canvas: string, withNextBoard = false) => {
  const doc: CanvasDoc = {
    nodes: [agent("author", canvas), agent("reviewer", canvas), board("tasks", true), ...(withNextBoard ? [board("next")] : [])],
    edges: [
      { id: "claim", fromNode: "tasks", toNode: "author", ether: { verb: "works" } },
      reviewEdge,
      ...(withNextBoard ? [{ id: "path", fromNode: "tasks", toNode: "next", ether: { verb: "feeds" as const } }] : []),
    ],
  };
  await runtime.runPromise(canvases.write(canvas, doc));
  const read = await runtime.runPromise(canvases.read(canvas));
  const actor = (nodeId: string): ActorRef => {
    const found = read.actorRefs.find((ref) => ref.nodeId === nodeId);
    if (found === undefined) throw new Error(`Missing actor ref for ${nodeId}`);
    return found;
  };
  const author = actor("author");
  const reviewer = actor("reviewer");
  const task = applied(await runtime.runPromise(work.workTaskCreate(
    canvas, "tasks", "Review the change", { details: "Prove the current commit refs" },
    undefined, undefined, undefined, undefined, undefined, { admission: "auto" },
  )));
  applied(await runtime.runPromise(work.workTaskClaim(canvas, "tasks", task.id, author)));
  const show = () => runtime.runPromise(work.workTaskShow(canvas, "tasks", task.id, "operator"));
  const snapshot = async () => {
    const read = await runtime.runPromise(repository.readSnapshot(canvas, "tasks"));
    const persisted = read.tasks.items.find((item) => item.id === task.id);
    if (persisted === undefined) throw new Error(`Missing task ${task.id}`);
    return persisted;
  };
  const replaceReviewEdge = (edge: CanvasEdge | undefined) => runtime.runPromise(canvases.write(canvas, {
    ...doc,
    edges: [...doc.edges.filter((entry) => entry.id !== "review"), ...(edge === undefined ? [] : [edge])],
  }));
  return { canvas, taskId: task.id, author, reviewer, show, snapshot, replaceReviewEdge };
};

const expectedSubject = (shown: WorkTaskShowView) => ({
  kind: "task" as const,
  taskId: shown.task.id,
  epoch: shown.reviewSubject.epoch,
  subjectHash: shown.reviewSubject.subjectHash,
});

describe("crew reviews through the real WorkService", () => {
  it("commits first-board blocking and its epoch together, then refuses the stale verdict", async () => {
    const f = await fixture("crew-review-atomic");
    const before = await f.show();
    const originalTask = await f.snapshot();
    const input = {
      subject: expectedSubject(before), kind: "blocking" as const,
      findings: ["The acceptance case is missing"], refs: [{ kind: "commit" as const, sha: SHA_A }],
    };

    await runtime.runPromise(state.transaction("test.crew-review-abort-install", (writer) => {
      writer.run(`CREATE TRIGGER crew_review_abort_task_update
        BEFORE UPDATE ON work_tasks
        WHEN NEW.canvas_name = 'crew-review-atomic'
        BEGIN SELECT RAISE(ABORT, 'crew review injected write failure'); END`);
    }));
    try {
      const aborted = await runtime.runPromise(work.workVerdictPost(f.canvas, "tasks", input, f.reviewer));
      expect(aborted.ok).toBe(false);
      if (aborted.ok) throw new Error("Blocking verdict escaped the injected task-write failure");
      expect(aborted.message).toContain("crew review injected write failure");
      expect(await f.snapshot()).toEqual(originalTask);
      expect((await f.show()).verdicts).toEqual([]);
    } finally {
      await runtime.runPromise(state.transaction("test.crew-review-abort-remove", (writer) => {
        writer.run("DROP TRIGGER crew_review_abort_task_update");
      }));
    }

    const posted = applied(await runtime.runPromise(work.workVerdictPost(f.canvas, "tasks", input, f.reviewer)));
    expect(posted).toMatchObject({ epoch: 0, authorSeatId: f.author.seatId, effect: "rejected", newEpoch: 1 });
    const after = await f.show();
    expect(after.task).toMatchObject({ state: "submitted", epoch: 1, defects: [{ epoch: 1, target: "tasks" }] });
    expect(after.task.claimedBy).toBeUndefined();
    expect(after.task.completionEvidence).toBeUndefined();
    expect(after.verdicts).toHaveLength(1);
    expect(after.verdicts[0]).toMatchObject({ verdictId: posted.verdictId, kind: "blocking", epoch: 0 });
    expect(after.reviewSubject.epoch).toBe(1);
    expect(after.reviewSubject.subjectHash).not.toBe(before.reviewSubject.subjectHash);

    applied(await runtime.runPromise(work.workTaskClaim(f.canvas, "tasks", f.taskId, f.author)));
    const beforeReplay = await f.snapshot();
    const stale = await runtime.runPromise(work.workVerdictPost(f.canvas, "tasks", input, f.reviewer));
    expect(stale).toMatchObject({ ok: false, details: { reason: "stale-subject" } });
    expect(await f.snapshot()).toEqual(beforeReplay);
    expect((await f.show()).verdicts.map((verdict) => verdict.verdictId)).toEqual([posted.verdictId]);
  });

  it("rechecks directed and masked review authority at posting and completion", async () => {
    const f = await fixture("crew-review-live-edge");
    const shown = await f.show();
    const input = { subject: expectedSubject(shown), kind: "green" as const };
    const posted = applied(await runtime.runPromise(work.workVerdictPost(f.canvas, "tasks", input, f.reviewer)));
    const working = await f.snapshot();
    const revoked: readonly [string, CanvasEdge | undefined][] = [
      ["masked", { ...reviewEdge, ether: { verb: "reviews", mask: [] } }],
      ["reversed", { ...reviewEdge, fromNode: "author", toNode: "reviewer" }],
      ["removed", undefined],
    ];
    for (const [label, edge] of revoked) {
      await f.replaceReviewEdge(edge);
      const denied = await runtime.runPromise(work.workVerdictPost(f.canvas, "tasks", input, f.reviewer));
      expect(denied, label).toMatchObject({ ok: false, details: { reason: "reviews-edge-missing" } });
      const completion = await runtime.runPromise(work.workTaskTransition(
        f.canvas, "tasks", f.taskId, "completed", undefined, evidence(),
      ));
      expect(completion.ok, label).toBe(false);
      expect(await f.snapshot(), label).toEqual(working);
      expect((await f.show()).verdicts.map((verdict) => verdict.verdictId), label).toEqual([posted.verdictId]);
    }
    await f.replaceReviewEdge(reviewEdge);
    const completed = applied(await runtime.runPromise(work.workTaskTransition(
      f.canvas, "tasks", f.taskId, "completed", undefined, evidence(),
    )));
    expect(completed.state).toBe("completed");
  });

  it("requires green for the incoming completion refs before writing evidence or hopping boards", async () => {
    const f = await fixture("crew-review-incoming-refs", true);
    const before = await f.show();
    applied(await runtime.runPromise(work.workVerdictPost(f.canvas, "tasks", {
      subject: expectedSubject(before), kind: "green",
    }, f.reviewer)));
    const original = await f.snapshot();
    const incoming = evidence([SHA_B]);
    const refused = await runtime.runPromise(work.workTaskTransition(
      f.canvas, "tasks", f.taskId, "completed", undefined, incoming,
    ));
    expect(refused.ok).toBe(false);
    expect(await f.snapshot()).toEqual(original);
    const untouchedNext = await runtime.runPromise(repository.readSnapshot(f.canvas, "next"));
    expect(untouchedNext.tasks.items).toEqual([]);

    // Seed only the exact review decision; completion still traverses WorkService.
    const candidate = reviewSubjectProjection({
      installationId: before.reviewSubject.installationId,
      canvasName: f.canvas, nodeId: "tasks", task: { ...before.task, completionEvidence: incoming },
    });
    expect(candidate.subjectHash).not.toBe(before.reviewSubject.subjectHash);
    await runtime.runPromise(crew.postVerdict({
      verdictId: `incoming-${randomUUID()}`, kind: "green",
      reviewerSeatId: f.reviewer.seatId, reviewerNodeId: f.reviewer.nodeId,
      authorSeatId: f.author.seatId,
      subject: {
        kind: "task", installationId: candidate.installationId, canvasName: f.canvas,
        nodeId: "tasks", taskId: f.taskId, epoch: candidate.epoch, subjectHash: candidate.subjectHash,
      },
      epoch: candidate.epoch, subjectHash: candidate.subjectHash,
      findings: [], refs: [{ kind: "commit", sha: SHA_B }], postedAtMs: Date.now(),
    }));
    const completed = applied(await runtime.runPromise(work.workTaskTransition(
      f.canvas, "tasks", f.taskId, "completed", undefined, incoming,
    )));
    expect(completed).toMatchObject({ state: "completed", completionEvidence: incoming });
    const persisted = await f.show();
    expect(persisted.reviewSubject.subjectHash).toBe(candidate.subjectHash);
    expect(persisted.reviewSubject.refs).toEqual([{ kind: "commit", sha: SHA_B }]);
    const next = await runtime.runPromise(repository.readSnapshot(f.canvas, "next"));
    expect(next.tasks.items).toHaveLength(1);
    expect(next.tasks.items[0]).toMatchObject({ id: f.taskId, state: "submitted" });
  });

  it("commits working refs and reviewer receipt together and retains both across restart", async () => {
    const f = await fixture("crew-review-receipt-atomic");
    const before = await f.show();
    const staged: CompletionEvidence = { artifacts: [], git: { commits: [SHA_A] } };
    const sender: MailSenderStamp = {
      fromSeat: f.author.seatId, senderGeneration: "test-generation",
      senderHarness: "claude", senderNodeId: f.author.nodeId,
    };
    const reviewerInbox = async () => (await runtime.runPromise(
      repository.readSnapshot(f.canvas, f.reviewer.nodeId),
    )).messages.items;
    const durableRows = () => runtime.runPromise(state.read("test.crew-review-receipt-rows", (reader) => ({
      facts: reader.all<{ readonly event_home: string; readonly entity_home: string; readonly seq: number }>(
        "SELECT event_home, entity_home, seq FROM work_facts ORDER BY event_home, entity_home, seq",
      ),
      receipts: reader.all<{
        readonly source_kind: string; readonly source_id: string; readonly ref_sha: string;
        readonly reviewer_seat_id: string; readonly author_seat_id: string; readonly message_id: string | null;
      }>(`SELECT source_kind, source_id, ref_sha, reviewer_seat_id, author_seat_id, message_id
          FROM work_review_receipts WHERE canvas_name = ? ORDER BY source_kind, source_id, ref_sha, reviewer_seat_id`,
      [f.canvas]),
    })));
    const originalTask = await f.snapshot();
    const originalInbox = await reviewerInbox();
    const originalRows = await durableRows();
    expect(originalInbox).toEqual([]);
    expect(originalRows.receipts).toEqual([]);

    const wrongClaimant = await runtime.runPromise(work.workTaskTransition(
      f.canvas, "tasks", f.taskId, "working", undefined, staged, undefined,
      { ...sender, fromSeat: f.reviewer.seatId, senderNodeId: f.reviewer.nodeId },
    ));
    expect(wrongClaimant).toMatchObject({ ok: false, details: { reason: "receipt-author-mismatch" } });
    expect(await f.snapshot()).toEqual(originalTask);
    expect(await reviewerInbox()).toEqual(originalInbox);
    expect(await durableRows()).toEqual(originalRows);

    await runtime.runPromise(state.transaction("test.crew-review-receipt-abort-install", (writer) => {
      writer.run(`CREATE TRIGGER crew_review_abort_receipt_insert
        BEFORE INSERT ON work_review_receipts
        WHEN NEW.canvas_name = 'crew-review-receipt-atomic'
        BEGIN SELECT RAISE(ABORT, 'crew receipt injected write failure'); END`);
    }));
    try {
      const aborted = await runtime.runPromise(work.workTaskTransition(
        f.canvas, "tasks", f.taskId, "working", undefined, staged, undefined, sender,
      ));
      expect(aborted.ok).toBe(false);
      if (aborted.ok) throw new Error("Task update escaped the injected receipt-write failure");
      expect(aborted.message).toContain("crew receipt injected write failure");
      expect(await f.snapshot()).toEqual(originalTask);
      expect(await reviewerInbox()).toEqual(originalInbox);
      expect(await durableRows()).toEqual(originalRows);
    } finally {
      await runtime.runPromise(state.transaction("test.crew-review-receipt-abort-remove", (writer) => {
        writer.run("DROP TRIGGER crew_review_abort_receipt_insert");
      }));
    }

    const updated = applied(await runtime.runPromise(work.workTaskTransition(
      f.canvas, "tasks", f.taskId, "working", undefined, staged, undefined, sender,
    )));
    expect(updated).toMatchObject({ state: "working", claimedBy: f.author.seatId, completionEvidence: staged });
    const persisted = await f.show();
    const expected = reviewSubjectProjection({
      installationId: before.reviewSubject.installationId, canvasName: f.canvas,
      nodeId: "tasks", task: { ...originalTask, completionEvidence: staged },
    });
    expect(persisted.reviewSubject).toEqual(expected);
    expect(persisted.reviewSubject.subjectHash).not.toBe(before.reviewSubject.subjectHash);
    const mail = await reviewerInbox();
    expect(mail).toHaveLength(1);
    expect(mail[0]?.taskId).toBe(f.taskId);
    expect(readMailExtension(mail[0]?.metadata)).toMatchObject({
      mailKind: "receipt", refs: [{ kind: "task", taskId: f.taskId }, { kind: "commit", sha: SHA_A }],
      fromSeat: f.author.seatId, senderGeneration: sender.senderGeneration, senderHarness: sender.senderHarness,
    });
    expect(mail[0]?.metadata?.reviewSubject).toEqual(expectedSubject(persisted));
    const receiptText = mail[0]!.parts
      .flatMap((part) => part.kind === "text" ? [part.text] : [])
      .join("\n");
    expect(receiptText).toContain("at tasks");
    expect(receiptText).toContain(persisted.reviewSubject.subjectHash);
    const committedRows = await durableRows();
    expect(committedRows.facts.length).toBeGreaterThan(originalRows.facts.length);
    expect(committedRows.receipts).toEqual([expect.objectContaining({
      source_kind: "task-fact", ref_sha: SHA_A,
      reviewer_seat_id: f.reviewer.seatId, author_seat_id: f.author.seatId, message_id: mail[0]!.messageId,
    })]);

    await runtime.dispose();
    runtime = makeRuntime();
    await readServices();
    expect(await f.snapshot()).toEqual(persisted.task);
    expect((await f.show()).reviewSubject).toEqual(expected);
    expect(await reviewerInbox()).toEqual(mail);
    expect(await durableRows()).toEqual(committedRows);
  });

  it("rejects an old-epoch blocking write after the winning send-back is reclaimed", async () => {
    const f = await fixture("crew-review-concurrent-blocking");
    const before = await f.show();
    const input = {
      subject: expectedSubject(before), kind: "blocking" as const,
      findings: ["Concurrent reviews found the same missing case"],
    };
    let arrivals = 0;
    let reachedBoth!: () => void;
    const releases: Array<() => void> = [];
    let barrierTimer: ReturnType<typeof setTimeout> | undefined;
    const bothArrived = new Promise<void>((resolve, reject) => {
      reachedBoth = resolve;
      barrierTimer = setTimeout(() => reject(new Error("Both verdict preflights did not reach sendTaskBack")), 3_000);
    });
    const released = [0, 1].map(() => new Promise<void>((resolve) => { releases.push(resolve); }));
    const original = repository.sendTaskBack.bind(repository);
    const scheduling = vi.spyOn(repository, "sendTaskBack").mockImplementation((args) => {
      const write = original(args);
      return Effect.promise(async () => {
        const arrival = arrivals++;
        if (arrivals === 2) reachedBoth();
        await released[arrival];
      }).pipe(Effect.flatMap(() => write));
    });
    const attempts = [
      runtime.runPromise(work.workVerdictPost(f.canvas, "tasks", input, f.reviewer)),
      runtime.runPromise(work.workVerdictPost(f.canvas, "tasks", input, f.reviewer)),
    ];
    try {
      await bothArrived;
      expect(arrivals).toBe(2);
      releases[0]!();
      const winner = await Promise.race(attempts.map(async (attempt, index) => ({
        index, result: await attempt,
      })));
      const committed = applied(winner.result);
      const after = await f.show();
      expect(after.task).toMatchObject({ state: "submitted", epoch: 1 });
      expect(after.task.defects).toEqual([expect.objectContaining({ epoch: 1, target: "tasks" })]);
      expect(after.verdicts).toHaveLength(1);
      expect(after.verdicts[0]).toMatchObject({ verdictId: committed.verdictId, kind: "blocking", epoch: 0 });

      applied(await runtime.runPromise(work.workTaskClaim(f.canvas, "tasks", f.taskId, f.author)));
      const reclaimed = await f.snapshot();
      expect(reclaimed).toMatchObject({ state: "working", epoch: 1, claimedBy: f.author.seatId });

      releases[1]!();
      const stale = await attempts[1 - winner.index]!;
      expect(stale.ok).toBe(false);
      expect(await f.snapshot()).toEqual(reclaimed);
      expect((await f.show()).verdicts.map((verdict) => verdict.verdictId)).toEqual([committed.verdictId]);
    } finally {
      if (barrierTimer !== undefined) clearTimeout(barrierTimer);
      for (const release of releases) release();
      scheduling.mockRestore();
      await Promise.allSettled(attempts);
    }
  });

  it("refuses a green verdict when the task refs change after service preflight", async () => {
    const f = await fixture("crew-review-green-stale-refs");
    const before = await f.show();
    let reachedWriter!: () => void;
    let release!: () => void;
    let barrierTimer: ReturnType<typeof setTimeout> | undefined;
    const arrived = new Promise<void>((resolve, reject) => {
      reachedWriter = resolve;
      barrierTimer = setTimeout(() => reject(new Error("Green verdict preflight did not reach postVerdict")), 3_000);
    });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const original = crew.postVerdict.bind(crew);
    const scheduling = vi.spyOn(crew, "postVerdict").mockImplementation((...args) => {
      const write = original(...args);
      return Effect.promise(async () => {
        reachedWriter();
        await released;
      }).pipe(Effect.flatMap(() => write));
    });
    const posting = runtime.runPromise(work.workVerdictPost(f.canvas, "tasks", {
      subject: expectedSubject(before), kind: "green",
    }, f.reviewer));
    try {
      await arrived;
      const evidenceB: CompletionEvidence = { artifacts: [], git: { commits: [SHA_B] } };
      applied(await runtime.runPromise(work.workTaskTransition(
        f.canvas, "tasks", f.taskId, "working", undefined, evidenceB,
      )));
      const staged = await f.snapshot();
      expect(staged).toMatchObject({ state: "working", claimedBy: f.author.seatId, completionEvidence: evidenceB });
      const current = await f.show();
      expect(current.reviewSubject.epoch).toBe(before.reviewSubject.epoch);
      expect(current.reviewSubject.subjectHash).not.toBe(before.reviewSubject.subjectHash);

      release();
      const stale = await posting;
      expect(stale.ok).toBe(false);
      expect(await f.snapshot()).toEqual(staged);
      expect((await f.show()).verdicts).toEqual([]);
    } finally {
      if (barrierTimer !== undefined) clearTimeout(barrierTimer);
      release();
      scheduling.mockRestore();
      await Promise.allSettled([posting]);
    }
  });

  it("refuses a send-on when review authority is revoked after completion preflight", async () => {
    const f = await fixture("crew-review-send-on-revoked", true);
    const before = await f.show();
    const approved = applied(await runtime.runPromise(work.workVerdictPost(f.canvas, "tasks", {
      subject: expectedSubject(before), kind: "green",
    }, f.reviewer)));
    const originalTask = await f.snapshot();
    let reachedWriter!: () => void;
    let release!: () => void;
    let barrierTimer: ReturnType<typeof setTimeout> | undefined;
    const arrived = new Promise<void>((resolve, reject) => {
      reachedWriter = resolve;
      barrierTimer = setTimeout(() => reject(new Error("Completion preflight did not reach sendTaskOn")), 3_000);
    });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const original = repository.sendTaskOn.bind(repository);
    const scheduling = vi.spyOn(repository, "sendTaskOn").mockImplementation((...args) => {
      const write = original(...args);
      return Effect.promise(async () => {
        reachedWriter();
        await released;
      }).pipe(Effect.flatMap(() => write));
    });
    const sending = runtime.runPromise(work.workTaskTransition(
      f.canvas, "tasks", f.taskId, "completed", undefined, evidence(),
    ));
    try {
      await arrived;
      await f.replaceReviewEdge(undefined);
      const revoked = await runtime.runPromise(canvases.read(f.canvas));
      expect(revoked.doc.edges.some((edge) => edge.id === reviewEdge.id)).toBe(false);

      release();
      const refused = await sending;
      expect(refused.ok).toBe(false);
      expect(await f.snapshot()).toEqual(originalTask);
      const next = await runtime.runPromise(repository.readSnapshot(f.canvas, "next"));
      expect(next.tasks.items).toEqual([]);
      expect((await f.show()).verdicts.map((verdict) => verdict.verdictId)).toEqual([approved.verdictId]);
    } finally {
      if (barrierTimer !== undefined) clearTimeout(barrierTimer);
      release();
      scheduling.mockRestore();
      await Promise.allSettled([sending]);
    }
  });

  it("keeps a standalone commit verdict separate from its provenance task", async () => {
    const f = await fixture("crew-review-standalone-commit");
    const sha = "c".repeat(40);
    const originalTask = await f.snapshot();
    await runtime.runPromise(crew.recordReviewReceipt({
      canvasName: f.canvas,
      sourceKind: "checkout",
      sourceId: "crew-review-standalone-checkout",
      refSha: sha,
      reviewerSeatId: f.reviewer.seatId,
      authorSeatId: f.author.seatId,
      taskId: f.taskId,
      createdAt: "2026-09-15T00:00:00.000Z",
    }));
    const input = {
      subject: { kind: "commit" as const, sha },
      kind: "blocking" as const,
      findings: ["This commit needs another pass"],
    };
    const wrongAuthor = await runtime.runPromise(work.workVerdictPost(
      f.canvas, "reviewer", input, f.reviewer,
    ));
    expect(wrongAuthor).toMatchObject({ ok: false, details: { reason: "commit-author-mismatch" } });
    expect(await runtime.runPromise(crew.verdictsForSubject({ kind: "commit", sha }))).toEqual([]);

    const posted = applied(await runtime.runPromise(work.workVerdictPost(
      f.canvas, "author", input, f.reviewer,
    )));
    expect(posted).toMatchObject({ effect: "none", epoch: 0, authorSeatId: f.author.seatId });
    expect(posted.newEpoch).toBeUndefined();
    expect(await f.snapshot()).toEqual(originalTask);
    expect((await f.show()).verdicts).toEqual([]);
    expect(await runtime.runPromise(crew.verdictsForSubject({ kind: "commit", sha }))).toEqual([
      expect.objectContaining({ verdictId: posted.verdictId, kind: "blocking", epoch: 0 }),
    ]);
  });
});
