import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CanvasesLive, CanvasesService } from "../src/main/junto/canvases";
import { CanvasEntityRepositoryLive } from "../src/main/junto/entities/repository";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";
import type { StateBindings, StateEngineShape } from "../src/main/junto/state/service";
import { CrewRepository, CrewRepositoryLive, subjectHashOf } from "../src/main/junto/work/crew-repository";
import { mailboxMessageDeliveryId, mailboxMessageReactId, mailboxMessageReadId } from "../src/main/junto/work/mailbox-receipts";
import { createAuthorialTaskDependencyScopeCapability, WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import type { CanvasDoc } from "../src/shared/canvas";
import { type ReviewVerdict } from "../src/shared/crew";
import type { CompletionEvidence, Task } from "../src/shared/work-model";
import { IntentFactBasis } from "../src/shared/work-protocol";

const CANVAS = "crew-projection";
const FOREIGN_CANVAS = "crew-projection-other";
const INSTALLATION = "cc-crew-projection";
const mailSink = { canvasName: CANVAS, nodeId: "recipient" };
const taskSink = { canvasName: CANVAS, nodeId: "tasks" };
const iso = (offset: number) => new Date(Date.UTC(2026, 8, 15) + offset).toISOString();
const roots: string[] = [];
const runtimes: Array<{ dispose: () => Promise<unknown> }> = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()!.dispose();
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

const document: CanvasDoc = {
  nodes: [
    ...["author", "recipient", "other-recipient"].map((id) => ({
      id, type: "text" as const, text: id, x: 0, y: 0, width: 200, height: 100,
      ether: {
        entity: { kind: "agent", name: `local:crew-projection-${id}` },
        host: "local",
        terminal: {
          bindingId: `crew-projection-${id}`,
          launch: { kind: "harness" as const, argv: ["claude"] },
          harness: "claude" as const,
        },
      },
    })),
    ...["tasks", "other-tasks"].map((id) => ({
      id, type: "text" as const, text: id, x: 300, y: 0, width: 200, height: 100,
      ether: { entity: { kind: "task" }, tasks: { items: [] } },
    })),
  ],
  edges: [
    { id: "claim", fromNode: "tasks", toNode: "author", ether: { verb: "works" } },
    { id: "mail", fromNode: "author", toNode: "recipient", ether: { verb: "messages" } },
  ],
};

const openFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-crew-projection-"));
  roots.push(root);
  const queries: Array<{ sql: string; bindings?: StateBindings }> = [];
  // Decorate the reader on the one real engine. CanvasesService and both
  // repositories share that same connection, schema, transactions and cache.
  const countedState = Layer.provide(
    Layer.effect(StateEngine, Effect.map(StateEngine, (state): StateEngineShape => ({
      ...state,
      read: (operation, body) => state.read(operation, (reader) => body({
        get: (sql, bindings) => {
          queries.push({ sql, bindings });
          return reader.get(sql, bindings);
        },
        all: (sql, bindings) => {
          queries.push({ sql, bindings });
          return reader.all(sql, bindings);
        },
      })),
    }))),
    makeStateEngineLive(join(root, "state", "junto.db")),
  );
  const runtime = ManagedRuntime.make(Layer.provideMerge(
    CanvasesLive,
    Layer.provideMerge(
      Layer.mergeAll(WorkRepositoryLive, CrewRepositoryLive, CanvasEntityRepositoryLive),
      countedState,
    ),
  ));
  runtimes.push(runtime);
  const state = await runtime.runPromise(StateEngine);
  await runtime.runPromise(state.transaction("test.crew-projection.installation", (writer) => {
    writer.run("INSERT INTO station_known_installations(installation_id, registered_at) VALUES (?, ?)", [INSTALLATION, iso(0)]);
    writer.run("INSERT INTO station_installation(singleton, installation_id, created_at) VALUES (1, ?, ?)", [INSTALLATION, iso(0)]);
    writer.run(`INSERT INTO station_configuration(singleton, role, host_id, agent_host_id,
      command_center_installation_id, supervised_preferred, configured_at)
      VALUES (1, 'command-center', 'local', NULL, NULL, 1, ?)`, [iso(0)]);
  }));
  const canvases = await runtime.runPromise(CanvasesService);
  const work = await runtime.runPromise(WorkRepository);
  const crew = await runtime.runPromise(CrewRepository);
  await runtime.runPromise(canvases.write(CANVAS, document));
  await runtime.runPromise(canvases.write(FOREIGN_CANVAS, {
    nodes: document.nodes.filter((node) => node.id === "tasks"), edges: [],
  }));
  const initial = await runtime.runPromise(canvases.read(CANVAS));
  const author = initial.actorRefs.find((actor) => actor.nodeId === "author")!;
  const recipient = initial.actorRefs.find((actor) => actor.nodeId === "recipient")!;
  expect(author).toBeDefined();
  expect(recipient).toBeDefined();
  const witness = await runtime.runPromise(canvases.activeIntentWitness());
  const basis = Schema.decodeUnknownSync(IntentFactBasis)({ kind: "authorial-intent", ...witness });
  const authority = await runtime.runPromise(canvases.authorityMaterialSnapshot());
  const dependencyScope = createAuthorialTaskDependencyScopeCapability({ authority, authoringSink: taskSink });
  const read = async () => (await runtime.runPromise(canvases.read(CANVAS))).doc;
  const message = async (id: string) => {
    const found = (await read()).nodes.find((node) => node.id === mailSink.nodeId)
      ?.ether?.messages?.items.find((item) => item.messageId === id);
    expect(found, `projected mailbox message ${id}`).toBeDefined();
    return found!;
  };
  const task = async (id: string) => {
    const found = (await read()).nodes.find((node) => node.id === taskSink.nodeId)
      ?.ether?.tasks?.items.find((item) => item.id === id);
    expect(found, `projected task ${id}`).toBeDefined();
    return found!;
  };
  const appendMessage = (id: string) => runtime.runPromise(work.appendMessage({
    sink: mailSink, basis, sentBy: author, destination: { kind: "mailbox" },
    message: { messageId: id, role: "user", parts: [{ kind: "text", text: "Review the delivery" }], metadata: { note: "keep original metadata" } },
    originAt: iso(0), receivedAt: iso(0),
  }));
  const createTask = (id: string, metadata?: Task["metadata"], sink = taskSink) => runtime.runPromise(work.createTask({
    sink, basis,
    dependencyScope: createAuthorialTaskDependencyScopeCapability({ authority, authoringSink: sink }),
    task: { id, state: "submitted", epoch: 2, history: [{ messageId: `brief-${id}`, role: "user", parts: [{ kind: "text", text: "Review the exact evidence" }] }], ...(metadata ? { metadata } : {}) },
    originAt: iso(0), receivedAt: iso(0),
  }));
  const verdict = (
    id: string, taskId: string, epoch: number, hash: string,
    kind: ReviewVerdict["kind"], postedAtMs: number,
  ): ReviewVerdict => ({
    verdictId: id, kind, reviewerSeatId: recipient.seatId,
    reviewerNodeId: recipient.nodeId, authorSeatId: author.seatId,
    subject: { kind: "task", installationId: INSTALLATION, ...taskSink, taskId, epoch, subjectHash: hash },
    subjectHash: hash, epoch, findings: kind === "blocking" ? ["Repair the boundary"] : [],
    refs: [{ kind: "commit", sha: "a".repeat(40) }], postedAtMs,
  });
  return { runtime, canvases, work, crew, state, queries, author, recipient, basis, dependencyScope, read, message, task, appendMessage, createTask, verdict };
};

describe("Crew facts in the actual CanvasesService overlay", () => {
  it("projects independently timestamped delivery, read and reaction receipts onto the message", async () => {
    const f = await openFixture();
    const id = "attempt-and-receipts";
    await f.appendMessage(id);
    for (const [deliveryId, at] of [
      [mailboxMessageDeliveryId(CANVAS, mailSink.nodeId, id), iso(1)],
      [mailboxMessageReadId(CANVAS, mailSink.nodeId, id), iso(2)],
      [mailboxMessageReactId(CANVAS, mailSink.nodeId, id, "ack"), iso(3)],
    ]) {
      await f.runtime.runPromise(f.work.acceptDelivery({
        sink: mailSink, basis: f.basis,
        receipt: { deliveryId, deliveredItem: { kind: "message", itemId: id, sink: mailSink }, actor: f.recipient, acceptedAt: at },
      }));
    }
    const after = await f.message(id);
    expect(after.metadata).toMatchObject({
      note: "keep original metadata",
      deliveredAt: Date.parse(iso(1)),
      readAt: Date.parse(iso(2)),
      reactions: [{ kind: "ack", at: Date.parse(iso(3)) }],
    });
  });

  it("refreshes the full exact-identity verdict chain and recomputes the current subject from task evidence", async () => {
    const f = await openFixture();
    const id = "same-task-id";
    const staleHash = "stale-metadata-must-not-win";
    await f.createTask(id, { reviewSubject: { epoch: 1, subjectHash: staleHash } });
    // These rows make the colliding verdicts eligible for the task join, so
    // only the complete identity can keep them out of this task's history.
    await f.createTask(id, undefined, { ...taskSink, nodeId: "other-tasks" });
    await f.createTask(id, undefined, { ...taskSink, canvasName: FOREIGN_CANVAS });
    const emptyHash = subjectHashOf({ kind: "task", installationId: INSTALLATION, ...taskSink, taskId: id, epoch: 2 });
    expect((await f.task(id)).subjectHash).toBe(emptyHash);
    expect((await f.task(id)).verdicts).toEqual([]);
    const history = [
      f.verdict("old-blocking", id, 0, "subject-old", "blocking", 100),
      f.verdict("old-green", id, 0, "subject-old", "green", 200),
      f.verdict("previous-epoch", id, 1, "subject-previous", "green", 300),
      f.verdict("current-empty", id, 2, emptyHash, "green", 400),
    ];
    for (const verdict of history) await f.runtime.runPromise(f.crew.postVerdict(verdict));
    // All four posts occur after the read memo was populated.
    expect.soft((await f.task(id)).verdicts).toEqual(history);
    for (const [verdictId, patch] of [
      ["foreign-home", { installationId: "another-home" }],
      ["foreign-sink", { nodeId: "other-tasks" }],
      ["foreign-canvas", { canvasName: FOREIGN_CANVAS }],
    ] as const) {
      const unrelated = f.verdict(verdictId, id, 2, emptyHash, "green", 500);
      await f.runtime.runPromise(f.crew.postVerdict({ ...unrelated, subject: { ...unrelated.subject, ...patch } }));
    }
    expect.soft((await f.task(id)).verdicts).toEqual(history);

    await f.runtime.runPromise(f.work.claimLocalTask({ sink: taskSink, basis: f.basis, dependencyScope: f.dependencyScope, taskId: id, actor: f.author }));
    const evidence: CompletionEvidence = {
      artifacts: [{ nodeId: "Artifacts", artifactId: "Proof" }],
      git: { commits: ["a".repeat(40), "b".repeat(40)] },
      claims: [{ ruleId: "receipt", text: "The probe passed", refs: ["Capture/Exact"] }],
    };
    await f.runtime.runPromise(f.work.transitionTask({ sink: taskSink, basis: f.basis, taskId: id, state: "completed", completionEvidence: evidence }));
    const expected = subjectHashOf({ kind: "task", installationId: INSTALLATION, ...taskSink, taskId: id, epoch: 2, commitShas: evidence.git!.commits, artifactRefs: evidence.artifacts, claimRefs: ["Capture/Exact"] });
    const current = await f.task(id);
    expect(current.completionEvidence).toEqual(evidence);
    expect(current.subjectHash).toBe(expected);
    expect(current.subjectHash).not.toBe(emptyHash);
    expect(current.subjectHash).not.toBe(staleHash);
    const exactSubject = { kind: "task" as const, installationId: INSTALLATION, ...taskSink, taskId: id, epoch: 2, commitShas: evidence.git!.commits, artifactRefs: evidence.artifacts, claimRefs: ["Capture/Exact"] };
    for (const changed of [
      { ...exactSubject, artifactRefs: [{ nodeId: "artifacts", artifactId: "Proof" }] },
      { ...exactSubject, artifactRefs: [{ nodeId: "Artifacts", artifactId: "proof" }] },
      { ...exactSubject, claimRefs: ["Capture/exact"] },
    ]) expect(current.subjectHash).not.toBe(subjectHashOf(changed));
    expect(current.metadata?.reviewSubject).toEqual({ epoch: 1, subjectHash: staleHash });
    expect(current.verdicts).toEqual(history);
    const currentVerdict = f.verdict("current-evidence", id, 2, expected, "blocking", 600);
    await f.runtime.runPromise(f.crew.postVerdict(currentVerdict));
    expect((await f.task(id)).verdicts).toEqual([...history, currentVerdict]);
  });

  it("loads task verdicts in a fixed number of queries as the lane grows", async () => {
    const f = await openFixture();
    const counts = () => f.queries.filter(({ sql, bindings }) =>
      /\bFROM\s+work_review_verdicts\b/i.test(sql) &&
      Array.isArray(bindings) && bindings[0] === CANVAS && bindings[1] === taskSink.nodeId,
    ).length;
    const grow = async (from: number, until: number) => {
      for (let n = from; n < until; n++) {
        const id = `batch-${n}`;
        await f.appendMessage(id);
        await f.createTask(id);
        await f.runtime.runPromise(f.crew.postVerdict(f.verdict(`verdict-${id}`, id, 1, `hash-${n}`, "green", n + 1)));
      }
      f.queries.length = 0;
      const projected = await f.read();
      const messages = projected.nodes.find((node) => node.id === mailSink.nodeId)?.ether?.messages?.items;
      expect(messages).toHaveLength(until);
      const tasks = projected.nodes.find((node) => node.id === taskSink.nodeId)?.ether?.tasks?.items;
      expect(tasks).toHaveLength(until);
      for (let n = 0; n < until; n++) {
        expect(tasks?.find((task) => task.id === `batch-${n}`)?.verdicts?.map((verdict) => verdict.verdictId)).toEqual([`verdict-batch-${n}`]);
      }
      return counts();
    };
    expect(await grow(0, 1)).toBe(1);
    expect(await grow(1, 8)).toBe(1);
  });
});
