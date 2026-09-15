import { createHash, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CanvasDoc, CanvasEdge } from "../src/shared/canvas";
import { readMailExtension } from "../src/shared/crew";
import { IntentFactBasis } from "../src/shared/work-protocol";
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
import { WorkLive, WorkService, type WorkOpResult } from "../src/main/vellum-command/work/service";

const root = join(tmpdir(), `vellum-command-checkout-receipt-writer-${randomUUID()}`);
const repositories = Layer.provideMerge(
  Layer.mergeAll(
    WorkRepositoryLive, CrewRepositoryLive, StationRepositoryLive, StationFleetTargetRepositoryLive,
    makeSettingsLive({ ensureDefaultCommandCenter: false }),
    makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
  ),
  Layer.mergeAll(
    makeStateEngineLive(join(root, "vellum-command.db")),
    makeInstallOpsLive(join(root, "install-ops.db")),
  ),
);
const runtime = ManagedRuntime.make(Layer.provideMerge(
  WorkLive,
  Layer.mergeAll(Layer.provideMerge(CanvasesLive, repositories), StationLivePeerRegistryLive),
));
let canvases: Context.Service.Shape<typeof CanvasesService>;
let work: Context.Service.Shape<typeof WorkService>;
let repository: Context.Service.Shape<typeof WorkRepository>;
let crew: Context.Service.Shape<typeof CrewRepository>;
let state: Context.Service.Shape<typeof StateEngine>;

beforeAll(async () => {
  const settings = await runtime.runPromise(SettingsService);
  await runtime.runPromise(settings.setStationTopology({
    role: "command-center", hostId: "local", supervisedPreferred: true,
  }));
  canvases = await runtime.runPromise(CanvasesService);
  work = await runtime.runPromise(WorkService);
  repository = await runtime.runPromise(WorkRepository);
  crew = await runtime.runPromise(CrewRepository);
  state = await runtime.runPromise(StateEngine);
});
afterAll(async () => {
  await runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const applied = <T>(result: WorkOpResult<T>): T => {
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.message);
  expect(result.disposition).toBe("applied");
  return result.data;
};
const fixture = async (canvas: string) => {
  const agent = (id: string): CanvasDoc["nodes"][number] => ({
    id, type: "text", text: id, x: 0, y: 0, width: 200, height: 100,
    ether: {
      entity: { kind: "agent", name: `local:${canvas}-${id}` }, host: "local",
      terminal: { bindingId: `${canvas}-${id}`, harness: "claude", launch: { kind: "harness", argv: ["claude"] } },
    },
  });
  const reviewEdges: CanvasEdge[] = ["reviewer", "second-reviewer"].map((id) => ({
    id: `review-${id}`, fromNode: id, toNode: "author", ether: { verb: "reviews" },
  }));
  const doc: CanvasDoc = {
    nodes: [agent("author"), agent("reviewer"), agent("second-reviewer"), {
      id: "tasks", type: "text", text: "tasks", x: 400, y: 0, width: 200, height: 100,
      ether: { entity: { kind: "task" }, tasks: { items: [], contract: { incoming: { admission: "auto" } } } },
    }],
    edges: [
      ...["author", "second-reviewer"].map((id): CanvasEdge => ({
        id: `claim-${id}`, fromNode: "tasks", toNode: id, ether: { verb: "works" },
      })),
      ...reviewEdges,
    ],
  };
  await runtime.runPromise(canvases.write(canvas, doc));
  const read = await runtime.runPromise(canvases.read(canvas));
  const actor = (id: string) => {
    const found = read.actorRefs.find((ref) => ref.nodeId === id);
    if (found === undefined) throw new Error(`Missing fixture actor ${id}`);
    return found;
  };
  const author = actor("author");
  const reviewer = actor("reviewer");
  const secondReviewer = actor("second-reviewer");
  const task = applied(await runtime.runPromise(work.workTaskCreate(
    canvas, "tasks", "Review observed commits", { details: "Standalone checkout receipt" },
    undefined, undefined, undefined, undefined, undefined, { admission: "auto" },
  )));
  applied(await runtime.runPromise(work.workTaskClaim(canvas, "tasks", task.id, author)));
  const input = async (shas: readonly string[]) => {
    const { intentWitness } = await runtime.runPromise(canvases.readWithIntentWitness(canvas));
    return {
      basis: Schema.decodeUnknownSync(IntentFactBasis)({ kind: "authorial-intent", ...intentWitness }),
      canvasName: canvas, nodeId: "tasks", taskId: task.id, checkoutKey: `${canvas}-checkout`, shas,
      author: {
        fromSeat: author.seatId, senderNodeId: author.nodeId,
        senderGeneration: "observed-generation", senderHarness: "claude",
      },
    };
  };
  const rows = () => state.read("test.checkout-receipt.rows", (reader) => ({
    receipts: reader.all<{
      readonly message_id: string; readonly ref_sha: string;
      readonly author_seat_id: string; readonly reviewer_seat_id: string;
    }>(`SELECT message_id, ref_sha, author_seat_id, reviewer_seat_id
       FROM work_review_receipts WHERE canvas_name = ? ORDER BY reviewer_seat_id, ref_sha`, [canvas]),
    messages: reader.all<{ readonly message_id: string; readonly node_id: string }>(
      "SELECT message_id, node_id FROM work_messages WHERE canvas_name = ? ORDER BY node_id, position", [canvas],
    ),
    facts: reader.all<{ readonly event_home: string; readonly entity_home: string; readonly seq: number }>(
      "SELECT event_home, entity_home, seq FROM work_facts ORDER BY event_home, entity_home, seq",
    ),
  }));
  return {
    canvas, author, reviewer, secondReviewer, task, input, rows,
    sha: (seed: string) => createHash("sha1").update(`${canvas}:${seed}`).digest("hex"),
    publish: async (shas: readonly string[]) => runtime.runPromise(repository.publishCheckoutReceipts(await input(shas))),
    inbox: async (nodeId: string) => (await runtime.runPromise(repository.readSnapshot(canvas, nodeId))).messages.items,
    snapshot: async () => (await runtime.runPromise(repository.readSnapshot(canvas, "tasks"))).tasks.items,
    replaceReviews: (edges: readonly CanvasEdge[]) => runtime.runPromise(canvases.write(canvas, {
      ...doc, edges: [...doc.edges.filter((edge) => !edge.id.startsWith("review-")), ...edges],
    })),
    reviewEdges,
  };
};

describe("checkout receipt writer", () => {
  it("commits all mail, dedupe and author provenance before exposing standalone subjects", async () => {
    const f = await fixture("checkout-writer-standalone");
    const sha = "c".repeat(40);
    const beforeTask = await f.snapshot();
    expect(await runtime.runPromise(crew.firstAuthorForSha(sha))).toBeUndefined();
    const atNotification: number[] = [];
    const unsubscribe = repository.subscribeChanges((canvas) => {
      if (canvas === f.canvas) atNotification.push(Effect.runSync(f.rows()).receipts.length);
    });
    let records;
    try {
      records = await f.publish([sha, f.sha("second"), sha.toUpperCase()]);
    } finally {
      unsubscribe();
    }
    expect(records).toHaveLength(4);
    expect(atNotification).toEqual([4]);
    const durable = await runtime.runPromise(f.rows());
    expect(durable.receipts).toHaveLength(4);
    expect(durable.messages.map((row) => row.message_id).sort()).toEqual(records.map((record) => record.message.messageId).sort());
    expect(await runtime.runPromise(crew.firstAuthorForSha(sha))).toBe(f.author.seatId);
    for (const record of records) {
      expect(await f.inbox(record.nodeId)).toContainEqual(record.message);
      expect(record.message.taskId).toBeUndefined();
      expect(record.message.metadata?.reviewSubject).toEqual({ kind: "commit", sha: expect.any(String) });
      expect(readMailExtension(record.message.metadata)).toMatchObject({
        fromSeat: f.author.seatId, senderNodeId: f.author.nodeId,
        senderGeneration: "observed-generation", senderHarness: "claude",
      });
    }
    // The real service resolves author provenance from the just-committed
    // receipt, without an observation, task evidence, or manually seeded row.
    const posted = applied(await runtime.runPromise(work.workVerdictPost(
      f.canvas, f.author.nodeId, { subject: { kind: "commit", sha }, kind: "green" }, f.reviewer,
    )));
    expect(posted).toMatchObject({ effect: "none", epoch: 0, authorSeatId: f.author.seatId });
    expect(await f.snapshot()).toEqual(beforeTask);
    expect(await runtime.runPromise(crew.verdictsForSubject({ kind: "commit", sha }))).toEqual([
      expect.objectContaining({ verdictId: posted.verdictId, authorSeatId: f.author.seatId }),
    ]);
    const afterVerdict = await runtime.runPromise(f.rows());
    expect(await f.publish([sha, f.sha("second")])).toEqual([]);
    expect(await runtime.runPromise(f.rows())).toEqual(afterVerdict);
  });

  it("rolls back an earlier recipient's mail and dedupe when the second receipt insert fails", async () => {
    const f = await fixture("checkout-writer-rollback");
    const before = await runtime.runPromise(f.rows());
    const changed = vi.fn();
    const unsubscribe = repository.subscribeChanges(changed);
    await runtime.runPromise(state.transaction("test.checkout-receipt.abort-install", (writer) => {
      writer.run(`CREATE TRIGGER checkout_receipt_abort_second
        BEFORE INSERT ON work_review_receipts
        WHEN NEW.canvas_name = 'checkout-writer-rollback'
          AND (SELECT count(*) FROM work_review_receipts WHERE canvas_name = NEW.canvas_name) = 1
        BEGIN SELECT RAISE(ABORT, 'second checkout receipt rejected'); END`);
    }));
    try {
      await expect(f.publish([f.sha("rollback")])).rejects.toThrow(/second checkout receipt rejected/);
      expect(await runtime.runPromise(f.rows())).toEqual(before);
      expect(changed).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
      await runtime.runPromise(state.transaction("test.checkout-receipt.abort-remove", (writer) => {
        writer.run("DROP TRIGGER checkout_receipt_abort_second");
      }));
    }
    expect(await f.publish([f.sha("rollback")])).toHaveLength(2);
    expect((await runtime.runPromise(f.rows())).receipts).toHaveLength(2);
  });

  it.each(["removed", "reversed", "masked"] as const)("refuses stale intent and honors the current %s review edge", async (change) => {
    const f = await fixture(`checkout-writer-edge-${change}`);
    const pending = repository.publishCheckoutReceipts(await f.input([f.sha("edge")]));
    const original = f.reviewEdges[0]!;
    const replacement = change === "removed" ? [] : [change === "reversed"
      ? { ...original, fromNode: original.toNode, toNode: original.fromNode }
      : { ...original, ether: { verb: "reviews" as const, mask: [] } }];
    await f.replaceReviews([...replacement, f.reviewEdges[1]!]);
    const before = await runtime.runPromise(f.rows());
    await expect(runtime.runPromise(pending)).rejects.toThrow(/authorial intent changed/);
    expect(await runtime.runPromise(f.rows())).toEqual(before);
    const receipts = await f.publish([f.sha("edge")]);
    expect(receipts.map((receipt) => receipt.nodeId)).toEqual([f.secondReviewer.nodeId]);
    expect(await f.inbox(f.reviewer.nodeId)).toEqual([]);
  });

  it("rechecks the live claimant inside the deferred writer", async () => {
    const f = await fixture("checkout-writer-author-race");
    const pending = repository.publishCheckoutReceipts(await f.input([f.sha("claim")]));
    applied(await runtime.runPromise(work.workTaskTransition(f.canvas, "tasks", f.task.id, "submitted", "Hand off")));
    applied(await runtime.runPromise(work.workTaskClaim(f.canvas, "tasks", f.task.id, f.secondReviewer)));
    const before = await runtime.runPromise(f.rows());
    await expect(runtime.runPromise(pending)).rejects.toThrow(/author no longer matches the current task claimant/);
    expect(await runtime.runPromise(f.rows())).toEqual(before);
  });

  it("coalesces parallel reviews edges into one receipt per stable reviewer seat", async () => {
    const f = await fixture("checkout-writer-parallel-edges");
    await f.replaceReviews([
      ...f.reviewEdges,
      { ...f.reviewEdges[0]!, id: "review-parallel", ether: { verb: "reviews", mask: ["verdict.post"] } },
    ]);
    const records = await f.publish([f.sha("parallel")]);
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.nodeId).sort()).toEqual(["reviewer", "second-reviewer"]);
    const durable = await runtime.runPromise(f.rows());
    expect(durable.messages).toHaveLength(2);
    expect(durable.receipts).toHaveLength(2);
    expect(await f.inbox(f.reviewer.nodeId)).toHaveLength(1);
  });

  it("refuses the entire batch when a later checkout would relabel an already attributed SHA", async () => {
    const f = await fixture("checkout-writer-provenance-conflict");
    const knownSha = "d".repeat(40);
    const freshSha = "e".repeat(40);
    await f.publish([knownSha]);
    expect(await runtime.runPromise(crew.firstAuthorForSha(knownSha))).toBe(f.author.seatId);
    applied(await runtime.runPromise(work.workTaskTransition(f.canvas, "tasks", f.task.id, "submitted", "Hand off")));
    applied(await runtime.runPromise(work.workTaskClaim(f.canvas, "tasks", f.task.id, f.secondReviewer)));
    await f.replaceReviews([{
      id: "review-new-author", fromNode: f.reviewer.nodeId, toNode: f.secondReviewer.nodeId,
      ether: { verb: "reviews" },
    }]);
    const input = await f.input([freshSha, knownSha]);
    const before = await runtime.runPromise(f.rows());
    await expect(runtime.runPromise(repository.publishCheckoutReceipts({
      ...input, checkoutKey: "another-tracked-checkout",
      author: { ...input.author, fromSeat: f.secondReviewer.seatId, senderNodeId: f.secondReviewer.nodeId },
    }))).rejects.toThrow(/author|provenance/);
    expect(await runtime.runPromise(f.rows())).toEqual(before);
    expect(await runtime.runPromise(crew.firstAuthorForSha(freshSha))).toBeUndefined();
    expect(await runtime.runPromise(crew.firstAuthorForSha(knownSha))).toBe(f.author.seatId);
  });
});
