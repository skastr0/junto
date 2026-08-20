import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context, Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  isArtifactArchived,
  workArtifactArchive,
  workArtifactDelete,
  workArtifactPublish,
  workMessageAppend,
  workRequestCreate,
  workRequestResolve,
  workTaskClaim,
  workTaskApproveProposal,
  workTaskRejectProposal,
  workTaskCreate,
  workTaskDescribe,
  workTaskRespond,
  workTaskPropose,
  workTaskTransition,
  WorkError,
} from "../src/shared/work";
import type { Artifact, CanvasDoc, CanvasNode, Message } from "../src/shared/canvas";
import {
  canTransitionTaskState,
} from "../src/shared/task";
import {
  ActorRef,
  IntentFactBasis,
  type IntentFactBasis as IntentFactBasisValue,
} from "../src/shared/work-protocol";
import { InstallationId } from "../src/shared/installation-id";
import { HostId } from "../src/shared/remote-hosts";
import {
  ConfigureRequest,
  LogicalSequence,
  PairRequest,
  ProjectRequest,
  STATION_API_PROTOCOL,
  StationHostId,
} from "../src/shared/station-api";

const ids = (() => {
  let n = 0;
  return {
    id: () => `id-${++n}`,
    messageId: () => `msg-${++n}`,
  };
})();

const actorRef = (
  digit: string,
  nodeId: string,
  canvasName = "alpha"
) =>
  Schema.decodeUnknownSync(ActorRef)({
    seatId: `seat_${digit.repeat(64)}`,
    canvasName,
    nodeId,
  });

const installationId = Schema.decodeUnknownSync(InstallationId);
const remoteHostId = Schema.decodeUnknownSync(HostId);
const stationHostId = Schema.decodeUnknownSync(StationHostId);
const logicalSequence = Schema.decodeUnknownSync(LogicalSequence);

const emptyTaskNode = (id = "tasks"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "tasks",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "task" } },
});

const emptyRequestsNode = (id = "req"): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "0 pending",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: { entity: { kind: "requests" } },
});

const agentNode = (
  id = "agent",
  hostId = "local"
): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: "mira",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: `${hostId}:${id}` },
    terminal: {
      bindingId: `binding-${id}`,
      launch: { kind: "harness", argv: ["claude"] },
      harness: "claude",
    },
    host: hostId,
  },
});

describe("work pure transforms", () => {
  it("keeps actor proposals outside the executable task queue until approval", () => {
    const worker = actorRef("1", "worker-1");
    const initial: CanvasDoc = {
      nodes: [emptyTaskNode()],
      edges: [{ id: "edge", fromNode: "worker-1", toNode: "tasks" }],
    };
    const proposed = workTaskPropose(
      initial,
      "alpha",
      "tasks",
      "add keyboard navigation",
      { title: "Keyboard navigation", details: "Keyboard navigation" },
      ids,
      worker,
      "accessibility gap"
    );

    expect(proposed.proposal.state).toBe("pending");
    expect(proposed.proposal.proposedBy).toEqual(worker);
    expect(proposed.doc.nodes[0]?.ether?.tasks?.items).toEqual([]);
    expect(proposed.doc.nodes[0]?.ether?.tasks?.proposals).toHaveLength(1);
    expect(() =>
      workTaskClaim(
        proposed.doc,
        "alpha",
        "tasks",
        proposed.proposal.id,
        worker,
        ids
      )
    ).toThrow(/not found/);

    const approved = workTaskApproveProposal(
      proposed.doc,
      "alpha",
      "tasks",
      proposed.proposal.id,
      ids
    );
    expect(approved.proposal.state).toBe("approved");
    expect(approved.proposal.approvedTaskId).toBe(approved.task.id);
    const claimed = workTaskClaim(
      approved.doc,
      "alpha",
      "tasks",
      approved.task.id,
      worker,
      ids
    );
    expect(claimed.task.state).toBe("working");
  });

  it("rejects a pending proposal without minting a task", () => {
    const worker = actorRef("1", "worker-1");
    const initial: CanvasDoc = {
      nodes: [emptyTaskNode()],
      edges: [{ id: "edge", fromNode: "worker-1", toNode: "tasks" }],
    };
    const proposed = workTaskPropose(
      initial,
      "alpha",
      "tasks",
      "noise draft",
      { title: "Noise", details: "discard me" },
      ids,
      worker,
    );
    const rejected = workTaskRejectProposal(
      proposed.doc,
      "tasks",
      proposed.proposal.id,
    );
    expect(rejected.proposal.state).toBe("rejected");
    expect(rejected.proposal.approvedTaskId).toBeUndefined();
    expect(rejected.doc.nodes[0]?.ether?.tasks?.items).toEqual([]);
    expect(
      rejected.doc.nodes[0]?.ether?.tasks?.proposals?.find(
        (proposal) => proposal.id === proposed.proposal.id,
      )?.state,
    ).toBe("rejected");
    expect(() =>
      workTaskApproveProposal(
        rejected.doc,
        "alpha",
        "tasks",
        proposed.proposal.id,
        ids,
      ),
    ).toThrow(/not pending/);
  });

  it("carries media, dependsOn, and finishCriteria through propose → approve", () => {
    const worker = actorRef("1", "worker-1");
    const seed = workTaskCreate({ nodes: [emptyTaskNode()], edges: [] }, "alpha", "tasks", "prerequisite", { details: "prerequisite" }, ids );
    const media = [
      {
        kind: "raw" as const,
        bytesBase64: Buffer.from("png").toString("base64"),
        mediaType: "image/png",
      },
    ];
    const proposed = workTaskPropose(
      seed.doc,
      "alpha",
      "tasks",
      "ship with proof",
      { title: "Ship with proof", details: "Ship with proof" },
      ids,
      worker,
      undefined,
      media,
      [seed.task.id],
      { description: "PR green", git: { minCommits: 1 } }
    );
    expect(proposed.proposal.dependsOn).toEqual([seed.task.id]);
    expect(proposed.proposal.finishCriteria).toEqual({
      description: "PR green",
      git: { minCommits: 1 },
    });
    expect(proposed.proposal.brief.parts.some((part) => part.kind === "raw")).toBe(
      true
    );

    const approved = workTaskApproveProposal(
      proposed.doc,
      "alpha",
      "tasks",
      proposed.proposal.id,
      ids
    );
    expect(approved.task.dependsOn).toEqual([seed.task.id]);
    expect(approved.task.finishCriteria).toEqual({
      description: "PR green",
      git: { minCommits: 1 },
    });
    expect(approved.task.history[0]?.parts.some((part) => part.kind === "raw")).toBe(
      true
    );
  });

  it("carries station-addressed claims at creation, direct and via propose → approve", () => {
    const worker = actorRef("1", "worker-1");
    const claim = {
      id: "claim-1",
      text: "Ship notes filed",
      severity: "hard" as const,
      station: "tasks",
    };

    const created = workTaskCreate(
      { nodes: [emptyTaskNode()], edges: [] },
      "alpha",
      "tasks",
      "direct create",
      { details: "direct create" },
      ids,
      undefined,
      undefined,
      undefined,
      undefined,
      [claim],
    );
    expect(created.task.claims).toEqual([claim]);

    const proposed = workTaskPropose(
      { nodes: [emptyTaskNode()], edges: [] },
      "alpha",
      "tasks",
      "propose then approve",
      { details: "propose then approve" },
      ids,
      worker,
      undefined,
      undefined,
      undefined,
      undefined,
      [claim],
    );
    expect(proposed.proposal.claims).toEqual([claim]);

    const approved = workTaskApproveProposal(
      proposed.doc,
      "alpha",
      "tasks",
      proposed.proposal.id,
      ids,
    );
    expect(approved.task.claims).toEqual([claim]);
  });

  it("rejects create and propose without a non-empty description", () => {
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    expect(() =>
      workTaskCreate(doc, "alpha", "tasks", "title only", undefined, ids)
    ).toThrow(/description must be non-empty/);
    expect(() =>
      workTaskCreate(doc, "alpha", "tasks", "title only", { details: "   " }, ids)
    ).toThrow(/description must be non-empty/);
    expect(() =>
      workTaskPropose(
        doc,
        "alpha",
        "tasks",
        "title only",
        { title: "Title only" },
        ids,
        actorRef("1", "worker-1")
      )
    ).toThrow(/description must be non-empty/);
    const created = workTaskCreate(
      doc,
      "alpha",
      "tasks",
      "title only",
      { details: "  full context  " },
      ids
    );
    expect(created.task.metadata?.details).toBe("full context");
  });

  it("create → claim → transition, with contextId from canvas name", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "alpha", "tasks", "ship docs", { details: "ship docs" }, ids);
    doc = created.doc;
    expect(created.task.state).toBe("submitted");
    expect(created.task.history[0]?.parts[0]).toEqual({ kind: "text", text: "ship docs" });
    expect(created.task.history[0]?.contextId).toBe("alpha");
    expect((doc.nodes[0] as { text: string }).text).toBe("ship docs");

    const worker = actorRef("1", "worker-1");
    const claimed = workTaskClaim(doc, "alpha", "tasks", created.task.id, worker, ids);
    doc = claimed.doc;
    expect(claimed.task.state).toBe("working");
    expect(claimed.task.claimedBy).toBe(worker.seatId);
    expect(claimed.claimedBy).toEqual(worker);

    const historyLength = claimed.task.history.length;
    const alias = actorRef("1", "worker-alias", "beta");
    const replayed = workTaskClaim(
      doc,
      "alpha",
      "tasks",
      created.task.id,
      alias,
      ids
    );
    doc = replayed.doc;
    expect(replayed.task.history).toHaveLength(historyLength);
    expect(replayed.task.claimedBy).toBe(worker.seatId);
    expect(replayed.claimedBy).toEqual(alias);

    expect(() =>
      workTaskClaim(
        doc,
        "alpha",
        "tasks",
        created.task.id,
        actorRef("2", "other-agent"),
        ids
      )
    ).toThrow(WorkError);
    try {
      workTaskClaim(
        doc,
        "alpha",
        "tasks",
        created.task.id,
        actorRef("2", "other-agent"),
        ids
      );
    } catch (e) {
      expect(e).toBeInstanceOf(WorkError);
      expect((e as WorkError).code).toBe("claim_contention");
    }

    const done = workTaskTransition(
      doc,
      "alpha",
      "tasks",
      created.task.id,
      "completed",
      "shipped",
      ids
    );
    expect(done.task.state).toBe("completed");
    expect(done.task.history.at(-1)?.role).toBe("agent");
    expect(done.task.history.at(-1)?.parts[0]).toEqual({ kind: "text", text: "shipped" });
  });

  it("generic transition cannot turn unclaimed submitted work into attention", () => {
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "c", "tasks", "needs answer", { details: "needs answer" }, ids);
    for (const state of ["input-required", "auth-required"] as const) {
      expect(() =>
        workTaskTransition(
          created.doc,
          "c",
          "tasks",
          created.task.id,
          state,
          undefined,
          ids
        )
      ).toThrowError(
        expect.objectContaining<Partial<WorkError>>({
          code: "illegal_transition",
        })
      );
    }
  });

  it("releases active work back to Queue and clears its claimant atomically", () => {
    const created = workTaskCreate({ nodes: [emptyTaskNode()], edges: [] }, "alpha", "tasks", "release me", { details: "release me" }, ids );
    const claimed = workTaskClaim(
      created.doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("1", "worker-1"),
      ids
    );

    const released = workTaskTransition(
      claimed.doc,
      "alpha",
      "tasks",
      created.task.id,
      "submitted",
      undefined,
      ids
    );

    expect(released.task.state).toBe("submitted");
    expect(released.task.claimedBy).toBeUndefined();
    expect(released.task.history).toHaveLength(
      claimed.task.history.length + 1
    );
    expect(released.task.history.at(-1)).toMatchObject({
      role: "user",
      parts: [{ kind: "text", text: "Released to Queue by operator." }],
      metadata: {
        "vellum.taskRelease.actorSeatId": claimed.task.claimedBy,
      },
    });
  });

  it("rejects completed work with a QA comment, requeues it, and counts the rejection", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "alpha", "tasks", "prove the release", { details: "prove the release" }, ids );
    const claimed = workTaskClaim(
      created.doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("1", "worker-1"),
      ids
    );
    const completed = workTaskTransition(
      claimed.doc,
      "alpha",
      "tasks",
      created.task.id,
      "completed",
      "shipped",
      ids
    );

    expect(() =>
      workTaskTransition(
        completed.doc,
        "alpha",
        "tasks",
        created.task.id,
        "submitted",
        undefined,
        ids
      )
    ).toThrow(/QA rejection comment is required/);

    const rejected = workTaskTransition(
      completed.doc,
      "alpha",
      "tasks",
      created.task.id,
      "submitted",
      "The proof does not include the release receipt.",
      ids
    );
    expect(rejected.task.state).toBe("submitted");
    expect(rejected.task.claimedBy).toBeUndefined();
    expect(rejected.task.metadata?.rejectedTimes).toBe(1);
    expect(rejected.task.completionEvidence).toBeUndefined();
    expect(rejected.task.history.at(-1)).toMatchObject({
      role: "user",
      parts: [{ kind: "text", text: "The proof does not include the release receipt." }],
      metadata: {
        "vellum.taskRelease.actorSeatId": claimed.task.claimedBy,
      },
    });

    const reclaimed = workTaskClaim(
      rejected.doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("2", "worker-2"),
      ids
    );
    const completedAgain = workTaskTransition(
      reclaimed.doc,
      "alpha",
      "tasks",
      created.task.id,
      "completed",
      "updated proof",
      ids
    );
    const rejectedAgain = workTaskTransition(
      completedAgain.doc,
      "alpha",
      "tasks",
      created.task.id,
      "submitted",
      "The updated proof still omits the receipt.",
      ids
    );
    expect(rejectedAgain.task.metadata?.rejectedTimes).toBe(2);
  });

  it("respond atomically records one operator message and resolves attention", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "alpha", "tasks", "need direction", { details: "need direction" }, ids);
    const claimed = workTaskClaim(
      created.doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("1", "worker-1"),
      ids
    );
    const waiting = workTaskTransition(
      claimed.doc,
      "alpha",
      "tasks",
      created.task.id,
      "input-required",
      "need the deployment region",
      ids
    );
    doc = waiting.doc;

    const responded = workTaskRespond(
      doc,
      "alpha",
      "tasks",
      created.task.id,
      "  Deploy to us-east-1.  ",
      "working",
      ids
    );

    expect(responded.task.state).toBe("working");
    expect(responded.task.history.at(-1)).toMatchObject({
      role: "user",
      taskId: created.task.id,
      parts: [{ kind: "text", text: "Deploy to us-east-1." }],
    });
    expect(() =>
      workTaskRespond(
        responded.doc,
        "alpha",
        "tasks",
        created.task.id,
        "another response",
        "working",
        ids
      )
    ).toThrowError(expect.objectContaining({ code: "illegal_transition" }));
    expect(
      (responded.doc.nodes[0]?.ether?.tasks?.items.find(
        (task) => task.id === created.task.id
      )?.history.length)
    ).toBe(responded.task.history.length);
  });

  it("describe re-authors the brief in place, keeps later notes, updates mirror text", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "alpha", "tasks", "ship docs", { details: "ship docs" }, ids);
    doc = created.doc;
    const noted = workTaskClaim(
      doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("1", "worker-1"),
      ids
    );
    doc = noted.doc;

    const described = workTaskDescribe(doc, "alpha", "tasks", created.task.id, "ship the docs site", ids);
    doc = described.doc;
    expect(described.task.history[0]?.parts[0]).toEqual({ kind: "text", text: "ship the docs site" });
    expect(described.task.history[0]?.role).toBe("user");
    expect(described.task.history.at(-1)?.parts[0]).toEqual({
      kind: "text",
      text: `claimed by ${actorRef("1", "worker-1").seatId}`,
    });
    expect(described.task.state).toBe("working");
    expect((doc.nodes[0] as { text: string }).text).toBe("ship the docs site");
  });

  it("describe rejects empty briefs, terminal states, and unknown ids", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "c", "tasks", "x", { details: "x" }, ids);
    doc = created.doc;

    expect(() => workTaskDescribe(doc, "c", "tasks", created.task.id, "   ", ids)).toThrow(WorkError);
    expect(() => workTaskDescribe(doc, "c", "tasks", "nope", "y", ids)).toThrow(WorkError);

    const done = workTaskTransition(doc, "c", "tasks", created.task.id, "completed", undefined, ids);
    doc = done.doc;
    try {
      workTaskDescribe(doc, "c", "tasks", created.task.id, "rewrite history", ids);
      expect.unreachable("terminal task must not be re-described");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkError);
      expect((e as WorkError).code).toBe("illegal_transition");
    }
  });

  it("rejects illegal transitions and unknown ids", () => {
    let doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "c", "tasks", "x", { details: "x" }, ids);
    doc = created.doc;
    expect(() =>
      workTaskTransition(
        doc,
        "c",
        "tasks",
        created.task.id,
        "working",
        undefined,
        ids
      )
    ).toThrow(/cannot transition/);
    const completed = workTaskTransition(
      doc,
      "c",
      "tasks",
      created.task.id,
      "completed",
      undefined,
      ids
    );
    doc = completed.doc;
    expect(() =>
      workTaskTransition(doc, "c", "tasks", created.task.id, "working", undefined, ids)
    ).toThrow(/cannot transition/);
    expect(() => workTaskCreate(doc, "c", "missing", "x", { details: "x" }, ids)).toThrow(
      /not found/
    );
  });

  it("finish criteria gate blocks complete without evidence; skip when off-home", () => {
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "c", "tasks", "gated", { details: "gated" }, ids, undefined, undefined, undefined, { git: { minCommits: 1 } } );
    expect(created.task.finishCriteria?.git?.minCommits).toBe(1);
    expect(() =>
      workTaskTransition(
        created.doc,
        "c",
        "tasks",
        created.task.id,
        "completed",
        undefined,
        ids
      )
    ).toThrow(/finish criteria unsatisfied/);
    const skipped = workTaskTransition(
      created.doc,
      "c",
      "tasks",
      created.task.id,
      "completed",
      undefined,
      ids,
      undefined,
      { evaluateFinishCriteria: false }
    );
    expect(skipped.task.state).toBe("completed");
    const withEvidence = workTaskTransition(
      created.doc,
      "c",
      "tasks",
      created.task.id,
      "completed",
      undefined,
      ids,
      { artifacts: [], git: { commits: ["3f8a2c9d1b4e5f60718293a4b5c6d7e8f9012345"] } }
    );
    expect(withEvidence.task.completionEvidence?.git?.commits).toEqual(["3f8a2c9d1b4e5f60718293a4b5c6d7e8f9012345"]);
  });

  it("rejects the retired metadata claimant instead of tolerating a dual shape", () => {
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    expect(() =>
      workTaskCreate(
        doc,
        "c",
        "tasks",
        "x",
        { claimedBy: actorRef("1", "worker-1", "c").seatId },
        ids
      )
    ).toThrow(/metadata\.claimedBy is retired/);
  });

  it("request raised by an actor is claimed by that actor at birth, with its reason", () => {
    const doc: CanvasDoc = { nodes: [emptyRequestsNode()], edges: [] };
    const raised = workRequestCreate(
      doc,
      "c",
      "req",
      "need a key",
      undefined,
      ids,
      actorRef("7", "actor-7", "c"),
      "signing is gated on the operator's key"
    );
    expect(raised.task.state).toBe("input-required");
    expect(raised.task.claimedBy).toBe(actorRef("7", "actor-7", "c").seatId);
    expect(raised.task.reason).toBe("signing is gated on the operator's key");
  });

  it("rejects title-only request create (no reason and no metadata.details)", () => {
    const doc: CanvasDoc = { nodes: [emptyRequestsNode()], edges: [] };
    expect(() =>
      workRequestCreate(
        doc,
        "c",
        "req",
        "title only is not enough",
        { class: "review" },
        ids,
        actorRef("7", "actor-7", "c"),
      ),
    ).toThrow(/request body required/);
    expect(() =>
      workRequestCreate(
        doc,
        "c",
        "req",
        "title only is not enough",
        undefined,
        ids,
        actorRef("7", "actor-7", "c"),
      ),
    ).toThrow(/request body required/);
    expect(() =>
      workRequestCreate(
        doc,
        "c",
        "req",
        "title only is not enough",
        { details: "   " },
        ids,
        actorRef("7", "actor-7", "c"),
        "   ",
      ),
    ).toThrow(/request body required/);
  });

  it("task create records its reason first-class", () => {
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(doc, "c", "tasks", "port the map", { details: "port the map" }, ids, "fleet epic");
    expect(created.task.reason).toBe("fleet epic");
    const bare = workTaskCreate(doc, "c", "tasks", "port the map", { details: "port the map" }, ids);
    expect(bare.task.reason).toBeUndefined();
  });

  it("task create attaches first-class media raw parts on the brief", () => {
    const pngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const doc: CanvasDoc = { nodes: [emptyTaskNode()], edges: [] };
    const created = workTaskCreate(
      doc,
      "c",
      "tasks",
      "fix the screenshot bug",
      { title: "screenshot bug", details: "see attached" },
      ids,
      undefined,
      [{ kind: "raw", bytesBase64: pngBase64, mediaType: "image/png" }]
    );
    expect(created.task.history[0]?.parts).toEqual([
      { kind: "text", text: "fix the screenshot bug" },
      { kind: "raw", bytesBase64: pngBase64, mediaType: "image/png" },
    ]);
    expect(() =>
      workTaskCreate(doc, "c", "tasks", "bad media", { details: "bad media" }, ids, undefined, [
        { kind: "raw", bytesBase64: pngBase64, mediaType: "application/pdf" },
      ])
    ).toThrow(/mediaType not allowed/);
    expect(() =>
      workTaskCreate(doc, "c", "tasks", "empty media", { details: "empty media" }, ids, undefined, [
        { kind: "raw", bytesBase64: "", mediaType: "image/png" },
      ])
    ).toThrow(/empty/);
  });

  it("request create + resolve appends user message and clears input-required", () => {
    let doc: CanvasDoc = { nodes: [emptyRequestsNode()], edges: [] };
    const created = workRequestCreate(
      doc,
      "c",
      "req",
      "need approval",
      { class: "review", details: "ship checklist before release" },
      ids,
      actorRef("4", "actor-4", "c")
    );
    doc = created.doc;
    expect(created.task.state).toBe("input-required");
    expect(created.task.metadata?.class).toBe("review");
    expect(created.task.claimedBy).toBe(actorRef("4", "actor-4", "c").seatId);
    expect((doc.nodes[0] as { text: string }).text.startsWith("1 pending")).toBe(true);

    const resolved = workRequestResolve(
      doc,
      "c",
      "req",
      created.task.id,
      "approved",
      "completed",
      ids
    );
    expect(resolved.task.state).toBe("completed");
    expect(resolved.task.history.at(-1)?.role).toBe("user");
    // The answer is first-class on the item, not only buried in history.
    expect(resolved.task.response).toBe("approved");
    expect((resolved.doc.nodes[0] as { text: string }).text.startsWith("0 pending")).toBe(true);
  });

  it("message append to agent list and task history", () => {
    let doc: CanvasDoc = {
      nodes: [emptyTaskNode(), agentNode()],
      edges: [],
    };
    const created = workTaskCreate(doc, "c", "tasks", "brief", { details: "brief" }, ids);
    doc = created.doc;
    const msg: Message = {
      messageId: "manual-1",
      role: "agent",
      parts: [{ kind: "text", text: "status note" }],
    };
    const onTask = workMessageAppend(doc, "c", "tasks", created.task.id, msg);
    doc = onTask.doc;
    const task = doc.nodes
      .find((n) => n.id === "tasks")
      ?.ether?.tasks?.items.find((t) => t.id === created.task.id);
    expect(task?.history.some((h) => h.messageId === "manual-1")).toBe(true);

    const onAgent = workMessageAppend(doc, "c", "agent", null, {
      messageId: "manual-2",
      role: "user",
      parts: [{ kind: "text", text: "ping" }],
    });
    const messages = onAgent.doc.nodes.find((n) => n.id === "agent")?.ether?.messages?.items;
    expect(messages?.some((m) => m.messageId === "manual-2")).toBe(true);
    expect(messages?.[0]?.contextId).toBe("c");
  });

  it("uses region label as contextId when node is inside a group", () => {
    const doc: CanvasDoc = {
      nodes: [
        {
          id: "reg",
          type: "group",
          label: "forge-lane",
          x: 0,
          y: 0,
          width: 400,
          height: 300,
        },
        {
          id: "tasks",
          type: "text",
          text: "tasks",
          x: 40,
          y: 40,
          width: 120,
          height: 80,
          ether: { entity: { kind: "task" } },
        },
      ],
      edges: [],
    };
    const created = workTaskCreate(doc, "canvas-name", "tasks", "inside", { details: "inside" }, ids);
    expect(created.task.history[0]?.contextId).toBe("forge-lane");
  });

  it("links artifacts only to an exact claimed task in the same canvas", () => {
    const artifactNode: CanvasDoc["nodes"][number] = {
      id: "artifacts",
      type: "text",
      text: "artifacts",
      x: 240,
      y: 0,
      width: 200,
      height: 100,
      ether: { entity: { kind: "artifacts" } },
    };
    let doc: CanvasDoc = {
      nodes: [emptyTaskNode(), artifactNode],
      edges: [],
    };
    const created = workTaskCreate(doc, "alpha", "tasks", "ship", { details: "ship" }, ids );
    doc = created.doc;

    const artifact = {
      artifactId: "artifact-task-proof",
      parts: [{ kind: "text" as const, text: "proof" }],
      task: {
        kind: "task" as const,
        itemId: created.task.id,
        sink: { canvasName: "alpha", nodeId: "tasks" },
      },
    };

    expect(() =>
      workArtifactPublish(doc, "alpha", "artifacts", artifact)
    ).toThrow(/must be claimed/);

    const claimed = workTaskClaim(
      doc,
      "alpha",
      "tasks",
      created.task.id,
      actorRef("1", "worker-1"),
      ids
    );
    doc = claimed.doc;
    expect(
      workArtifactPublish(doc, "alpha", "artifacts", artifact).artifact.task
    ).toEqual(artifact.task);

    expect(() =>
      workArtifactPublish(doc, "alpha", "artifacts", {
        ...artifact,
        artifactId: "artifact-missing-task",
        task: { ...artifact.task, itemId: "missing" },
      })
    ).toThrow(/not found/);

    expect(() =>
      workArtifactPublish(doc, "alpha", "artifacts", {
        ...artifact,
        artifactId: "artifact-cross-canvas",
        task: {
          ...artifact.task,
          sink: { ...artifact.task.sink, canvasName: "other" },
        },
      })
    ).toThrow(/artifact canvas/);
  });

  it("artifact archive soft-hides and delete removes from the sink", () => {
    const artifactNode: CanvasNode = {
      id: "artifacts",
      type: "text",
      text: "artifacts",
      x: 0,
      y: 0,
      width: 200,
      height: 100,
      ether: { entity: { kind: "artifacts" } },
    };
    let doc: CanvasDoc = { nodes: [artifactNode], edges: [] };
    const published = workArtifactPublish(doc, "alpha", "artifacts", {
      artifactId: "a1",
      name: "proof.md",
      parts: [{ kind: "text", text: "body" }],
    });
    doc = published.doc;
    expect(isArtifactArchived(published.artifact)).toBe(false);

    const archived = workArtifactArchive(doc, "artifacts", "a1", true);
    doc = archived.doc;
    expect(isArtifactArchived(archived.artifact)).toBe(true);
    expect(
      doc.nodes[0]?.ether?.artifacts?.items.find((a) => a.artifactId === "a1")
        ?.metadata?.archived,
    ).toBe(true);

    const restored = workArtifactArchive(doc, "artifacts", "a1", false);
    doc = restored.doc;
    expect(isArtifactArchived(restored.artifact)).toBe(false);
    expect(restored.artifact.metadata?.archived).toBeUndefined();

    const deleted = workArtifactDelete(doc, "artifacts", "a1");
    expect(deleted.artifactId).toBe("a1");
    expect(deleted.doc.nodes[0]?.ether?.artifacts?.items).toEqual([]);
    expect(() => workArtifactDelete(deleted.doc, "artifacts", "a1")).toThrow(
      /not found/,
    );
  });

  it("state machine: completed work only exits through the QA Queue path", () => {
    expect(canTransitionTaskState("completed", "working")).toBe(false);
    expect(canTransitionTaskState("completed", "submitted")).toBe(true);
    expect(canTransitionTaskState("submitted", "working")).toBe(false);
    expect(canTransitionTaskState("input-required", "rejected")).toBe(true);
    expect(canTransitionTaskState("input-required", "failed")).toBe(true);
    // No producer may enter auth-required; residual rows may still heal out.
    expect(canTransitionTaskState("working", "auth-required")).toBe(false);
    expect(canTransitionTaskState("input-required", "auth-required")).toBe(false);
    expect(canTransitionTaskState("auth-required", "completed")).toBe(true);
    expect(canTransitionTaskState("auth-required", "input-required")).toBe(true);
  });
});

// --- service serialization under concurrent claims -------------------------

const mockCanvasesHome = join(tmpdir(), `vellum-command-work-${randomUUID()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockCanvasesHome };
});

vi.mock("@shared/canvas", () => import("../src/shared/canvas"));
vi.mock("@shared/seed", () => import("../src/shared/seed"));

import { CanvasesLive, CanvasesService } from "../src/main/vellum/canvases";
import { WorkLive, WorkService } from "../src/main/vellum/work/service";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import { makeStateEngineLive } from "../src/main/vellum/state/engine";
import {
  StationRepository,
  StationRepositoryLive,
  stationProjectionContentSha256,
} from "../src/main/vellum/station/repository";
import {
  StationFleetTargetRepository,
  StationFleetTargetRepositoryLive,
} from "../src/main/vellum/station/fleet-target-repository";
import {
  StationLivePeerRegistryLive,
} from "../src/main/vellum/station/session-registry";
import {
  makeSettingsLive,
  SettingsService,
} from "../src/main/vellum/settings/service";
import {
  compileStationPortfolioBody,
} from "../src/main/vellum/station/portfolio";
import {
  makeContentServiceLive,
} from "../src/main/vellum/content/service";
import { makeInstallOpsLive } from "../src/main/vellum/install-ops/engine";

const makeWorkRuntime = (databasePath: string) => {
  const installRoot = join(databasePath, "..");
  const stateLive = makeStateEngineLive(databasePath);
  const repositoriesLive = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      StationRepositoryLive,
      StationFleetTargetRepositoryLive,
      // Blank-slate station for Remote offline fixtures; tests configure role.
      makeSettingsLive({ ensureDefaultCommandCenter: false }),
      makeContentServiceLive({
        root: join(installRoot, "content"),
        skipInlineMediaMigration: true,
      }),
    ),
    Layer.mergeAll(
      stateLive,
      makeInstallOpsLive(join(installRoot, "install-ops.db")),
    ),
  );
  const canvasesLive = Layer.provideMerge(
    CanvasesLive,
    repositoriesLive
  );
  return ManagedRuntime.make(((
    Layer.provideMerge(
      WorkLive,
      Layer.mergeAll(canvasesLive, StationLivePeerRegistryLive) as never) as never)
    )
  );
};

const activeIntentBasis = async (
  runtime: ReturnType<typeof makeWorkRuntime>,
  kind: IntentFactBasisValue["kind"]
): Promise<IntentFactBasisValue> => {
  const canvases = await runtime.runPromise(CanvasesService);
  const witness = await runtime.runPromise(canvases.activeIntentWitness());
  return Schema.decodeUnknownSync(IntentFactBasis, {
    onExcessProperty: "error",
  })({
    kind,
    ...witness,
  });
};

const workRuntime = makeWorkRuntime(
  join(mockCanvasesHome, "state", "vellum-command.db")
);
let work: Context.Service.Shape<typeof WorkService>;
let canvases: Context.Service.Shape<typeof CanvasesService>;
let repository: Context.Service.Shape<typeof WorkRepository>;

beforeAll(async () => {
  const settings = await workRuntime.runPromise(SettingsService);
  await workRuntime.runPromise(
    settings.setStationTopology({
      role: "command-center",
      hostId: "local",
      supervisedPreferred: true,
    })
  );
  work = await workRuntime.runPromise(WorkService);
  canvases = await workRuntime.runPromise(CanvasesService);
  repository = await workRuntime.runPromise(WorkRepository);
});

afterAll(async () => {
  await workRuntime.dispose();
  await rm(mockCanvasesHome, { recursive: true, force: true });
});

describe("WorkService — concurrent ops", () => {
  it("reads task home through the app-owned WorkService seam", async () => {
    const name = "work-task-home";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [emptyTaskNode()],
        edges: [],
      })
    );
    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "tasks", "prove the task home", { details: "prove the task home" })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const station = await workRuntime.runPromise(StationRepository);
    const localInstallationId = await workRuntime.runPromise(
      station.installationId
    );
    await expect(
      workRuntime.runPromise(
        work.workTaskHome(name, "tasks", created.data.id)
      )
    ).resolves.toBe(localInstallationId);

    const missing = await workRuntime.runPromise(
      work.workTaskHome(name, "tasks", "missing-task").pipe(Effect.result)
    );
    expect(missing._tag).toBe("Failure");
    if (missing._tag === "Failure") {
      expect(missing.failure.code).toBe("task_not_found");
    }
  });

  it("serializes concurrent claims; second actor loses with claim_contention", async () => {
    const name = "work-race";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          {
            id: "tasks",
            type: "text",
            text: "tasks",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
          agentNode("actor-a"),
          agentNode("actor-b"),
          agentNode("actor-c"),
        ],
        edges: [
          { id: "edge-a", fromNode: "actor-a", toNode: "tasks" },
          { id: "edge-b", fromNode: "actor-b", toNode: "tasks" },
          { id: "edge-c", fromNode: "actor-c", toNode: "tasks" },
        ],
      })
    );
    const authorialBefore = await workRuntime.runPromise(canvases.read(name));
    const actors = ["actor-a", "actor-b", "actor-c"].map((nodeId) => {
      const actor = authorialBefore.actorRefs.find(
        (candidate) => candidate.nodeId === nodeId
      );
      if (actor === undefined) throw new Error(`missing actor ref for ${nodeId}`);
      return actor;
    });

    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "tasks", "race me", { details: "race me" })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.disposition).toBe("applied");
    const taskId = created.data.id;

    // First claim must win; concurrent claims by different actors.
    const results = await Promise.all(
      actors.map((actor) =>
        workRuntime.runPromise(
          work.workTaskClaim(name, "tasks", taskId, actor)
        )
      )
    );

    const wins = results.filter((r) => r.ok);
    const losses = results.filter((r) => !r.ok);
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(2);
    expect(
      losses.every((result) => !result.ok && result.code === "claim_contention")
    ).toBe(true);

    const snapshot = await workRuntime.runPromise(
      repository.readSnapshot(name, "tasks")
    );
    const task = snapshot.tasks.items.find((item) => item.id === taskId);
    expect(task?.state).toBe("working");
    expect(actors.map((actor) => actor.seatId)).toContain(task?.claimedBy);

    // Explicit second claim by different actor after settle
    const other = await workRuntime.runPromise(
      work.workTaskClaim(
        name,
        "tasks",
        taskId,
        actors.find((actor) => actor.seatId !== task?.claimedBy)!
      )
    );
    expect(other.ok).toBe(false);
    if (!other.ok) expect(other.code).toBe("claim_contention");

    const authorialAfter = await workRuntime.runPromise(canvases.read(name));
    expect(authorialAfter.revision).toBe(authorialBefore.revision);
    const authority = await workRuntime.runPromise(canvases.authoritySnapshot());
    expect(
      authority.documents.get(name)?.nodes[0]?.ether?.tasks
    ).toBeUndefined();
  });

  it("rejects bad canvas / node / illegal transition", async () => {
    const name = "work-errors";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          {
            id: "tasks",
            type: "text",
            text: "tasks",
            x: 0,
            y: 0,
            width: 100,
            height: 50,
            ether: { entity: { kind: "task" } },
          },
        ],
        edges: [],
      })
    );
    const missingNode = await workRuntime.runPromise(
      work.workTaskCreate(name, "nope", "x", { details: "x" })
    );
    expect(missingNode.ok).toBe(false);
    if (!missingNode.ok) expect(missingNode.code).toBe("node_not_found");

    const created = await workRuntime.runPromise(work.workTaskCreate(name, "tasks", "t", { details: "t" }));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await workRuntime.runPromise(
      work.workTaskTransition(name, "tasks", created.data.id, "completed")
    );
    const illegal = await workRuntime.runPromise(
      work.workTaskTransition(name, "tasks", created.data.id, "working")
    );
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) expect(illegal.code).toBe("illegal_transition");
  });

  it("records a Command Center operator response with its transition in one task fact", async () => {
    const name = "work-operator-response";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [emptyTaskNode(), agentNode("operator-response-worker")],
        edges: [{ id: "worker-tasks", fromNode: "operator-response-worker", toNode: "tasks" }],
      })
    );
    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "tasks", "need a deployment decision", { details: "need a deployment decision" })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.data.id;
    const actor = (await workRuntime.runPromise(canvases.read(name))).actorRefs.find(
      (candidate) => candidate.nodeId === "operator-response-worker"
    );
    if (actor === undefined) throw new Error("missing operator response worker");
    await workRuntime.runPromise(work.workTaskClaim(name, "tasks", taskId, actor));
    const basis = await activeIntentBasis(
      workRuntime,
      "authorial-intent"
    );
    await workRuntime.runPromise(
      repository.transitionTask({
        sink: { canvasName: name, nodeId: "tasks" },
        taskId,
        state: "input-required",
        basis,
      })
    );

    const result = await workRuntime.runPromise(
      work.workTaskRespond(
        name,
        "tasks",
        taskId,
        "Deploy to us-east-1.",
        "working"
      )
    );
    expect(result).toMatchObject({ ok: true, disposition: "applied" });
    const snapshot = await workRuntime.runPromise(repository.readSnapshot(name, "tasks"));
    const task = snapshot.tasks.items.find((candidate) => candidate.id === taskId);
    expect(task).toMatchObject({ state: "working" });
    expect(task?.history.at(-1)).toMatchObject({
      role: "user",
      parts: [{ kind: "text", text: "Deploy to us-east-1." }],
    });
    const historyLength = task?.history.length;

    const invalid = await workRuntime.runPromise(
      work.workTaskRespond(name, "tasks", taskId, "not accepted", "working")
    );
    expect(invalid).toMatchObject({ ok: false, code: "illegal_transition" });
    const afterInvalid = await workRuntime.runPromise(repository.readSnapshot(name, "tasks"));
    expect(afterInvalid.tasks.items.find((candidate) => candidate.id === taskId)?.history)
      .toHaveLength(historyLength ?? 0);
  });

  it("persists requests, inbox messages, and artifacts without authorial generations", async () => {
    const name = "work-lanes";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          emptyRequestsNode("requests"),
          agentNode("sender"),
          agentNode("recipient"),
          {
            id: "artifacts",
            type: "text",
            text: "artifacts",
            x: 420,
            y: 0,
            width: 200,
            height: 100,
            ether: {
              entity: { kind: "artifacts" },
            },
          },
        ],
        edges: [
          { id: "edge-request", fromNode: "sender", toNode: "requests" },
          {
            id: "edge-message",
            fromNode: "sender",
            toNode: "recipient",
            ether: { ports: ["msg.send"] },
          },
          { id: "edge-artifact", fromNode: "sender", toNode: "artifacts" },
        ],
      })
    );
    const authorialBefore = await workRuntime.runPromise(canvases.read(name));
    const actor = authorialBefore.actorRefs.find(
      (candidate) => candidate.nodeId === "sender"
    );
    if (actor === undefined) throw new Error("missing actor ref for sender");

    const request = await workRuntime.runPromise(
      work.workRequestCreate(
        name,
        "requests",
        "approve release",
        undefined,
        actor,
        "cannot ship without sign-off"
      )
    );
    expect(request.ok).toBe(true);
    if (!request.ok) return;
    const resolved = await workRuntime.runPromise(
      work.workRequestResolve(
        name,
        "requests",
        request.data.id,
        "approved",
        "completed"
      )
    );
    expect(resolved.ok).toBe(true);

    const inboxMessage: Message = {
      messageId: "inbox-lane-1",
      role: "user",
      parts: [{ kind: "text", text: "start" }],
    };
    const appended = await workRuntime.runPromise(
      work.workMessageAppend(
        name,
        "recipient",
        null,
        inboxMessage,
        actor
      )
    );
    if (!appended.ok) {
      throw new Error(`${appended.code}: ${appended.message}`);
    }
    expect(appended).toMatchObject({ ok: true });

    const artifact: Artifact = {
      artifactId: "artifact-lane-1",
      name: "release receipt",
      parts: [{ kind: "text", text: "sha256:abc" }],
    };
    const published = await workRuntime.runPromise(
      work.workArtifactPublish(name, "artifacts", artifact, actor)
    );
    expect(published.ok).toBe(true);

    const snapshots = await workRuntime.runPromise(
      repository.snapshotsForCanvas(name)
    );
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "requests")?.requests
        .items[0]
    ).toMatchObject({ state: "completed", response: "approved" });
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "recipient")?.messages
        .items
    ).toEqual([expect.objectContaining({ messageId: "inbox-lane-1" })]);
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "artifacts")?.artifacts
        .items
    ).toEqual([expect.objectContaining({ artifactId: "artifact-lane-1" })]);

    const authorialAfter = await workRuntime.runPromise(canvases.read(name));
    expect(authorialAfter.revision).toBe(authorialBefore.revision);
    const authority = await workRuntime.runPromise(canvases.authoritySnapshot());
    expect(
      authority.documents.get(name)?.nodes.find(
        (node) => node.id === "requests"
      )?.ether?.requests
    ).toBeUndefined();
  });

  it("returns task and request notes from normalized thread history", async () => {
    const name = "work-thread-messages";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          emptyTaskNode(),
          emptyRequestsNode("requests"),
          agentNode("sender"),
        ],
        edges: [
          {
            id: "task-note",
            fromNode: "sender",
            toNode: "tasks",
          },
          {
            id: "request-note",
            fromNode: "sender",
            toNode: "requests",
          },
        ],
      })
    );
    const read = await workRuntime.runPromise(canvases.read(name));
    const sender = read.actorRefs.find(
      (candidate) => candidate.nodeId === "sender"
    );
    if (sender === undefined) throw new Error("missing sender actor");
    const task = await workRuntime.runPromise(
      work.workTaskCreate(name, "tasks", "Thread task", { details: "Thread task" })
    );
    const request = await workRuntime.runPromise(
      work.workRequestCreate(
        name,
        "requests",
        "Thread request",
        undefined,
        sender,
        "need operator thread context"
      )
    );
    if (!task.ok || !request.ok) {
      throw new Error("failed to seed thread work");
    }

    const taskNote = await workRuntime.runPromise(
      work.workMessageAppend(
        name,
        "tasks",
        task.data.id,
        {
          messageId: "service-task-note",
          role: "agent",
          parts: [{ kind: "text", text: "Task progress" }],
          taskId: task.data.id,
        },
        sender
      )
    );
    const requestNote = await workRuntime.runPromise(
      work.workMessageAppend(
        name,
        "requests",
        request.data.id,
        {
          messageId: "service-request-note",
          role: "agent",
          parts: [{ kind: "text", text: "Request context" }],
          taskId: request.data.id,
        },
        sender
      )
    );
    expect(taskNote).toMatchObject({ ok: true, disposition: "applied" });
    expect(requestNote).toMatchObject({
      ok: true,
      disposition: "applied",
    });
    if (!taskNote.ok || !requestNote.ok) return;
    expect(
      taskNote.doc.nodes
        .find((node) => node.id === "tasks")
        ?.ether?.tasks?.items[0]?.history.map(({ messageId }) => messageId)
    ).toContain("service-task-note");
    expect(
      requestNote.doc.nodes
        .find((node) => node.id === "requests")
        ?.ether?.requests?.items[0]?.history.map(({ messageId }) => messageId)
    ).toContain("service-request-note");
    expect(
      taskNote.doc.nodes.find((node) => node.id === "tasks")?.ether?.messages
        ?.items ?? []
    ).toEqual([]);
    expect(
      requestNote.doc.nodes.find((node) => node.id === "requests")?.ether
        ?.messages?.items ?? []
    ).toEqual([]);
  });

  it("rejects actor-originated work when the compiled actor is homed on another installation", async () => {
    const name = "work-cross-home-actor";
    const remoteHost = remoteHostId("remote-actor");
    const remoteInstallation = installationId("remote-actor-installation");
    const fleetTargets = await workRuntime.runPromise(
      StationFleetTargetRepository
    );
    await workRuntime.runPromise(
      fleetTargets.bind(
        {
          hostId: remoteHost,
          stationInstallationId: remoteInstallation,
        },
        "2026-07-28T00:00:00.000Z"
      )
    );
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          emptyRequestsNode("requests"),
          agentNode("remote-sender", remoteHost),
          agentNode("recipient"),
          {
            id: "artifacts",
            type: "text",
            text: "artifacts",
            x: 420,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "artifacts" } },
          },
        ],
        edges: [
          {
            id: "request",
            fromNode: "remote-sender",
            toNode: "requests",
          },
          {
            id: "message",
            fromNode: "remote-sender",
            toNode: "recipient",
            ether: { ports: ["msg.send"] },
          },
          {
            id: "artifact",
            fromNode: "remote-sender",
            toNode: "artifacts",
          },
        ],
      })
    );
    const read = await workRuntime.runPromise(canvases.read(name));
    const remoteActor = read.actorRefs.find(
      (candidate) => candidate.nodeId === "remote-sender"
    );
    if (remoteActor === undefined) throw new Error("missing Remote actor ref");

    const results = await Promise.all([
      workRuntime.runPromise(
        work.workMessageAppend(
          name,
          "recipient",
          null,
          {
            messageId: "cross-home-message",
            role: "agent",
            parts: [{ kind: "text", text: "forged locally" }],
          },
          remoteActor
        )
      ),
      workRuntime.runPromise(
        work.workRequestCreate(
          name,
          "requests",
          "forged request",
          undefined,
          remoteActor,
          "forged body for locality test"
        )
      ),
      workRuntime.runPromise(
        work.workArtifactPublish(
          name,
          "artifacts",
          {
            artifactId: "cross-home-artifact",
            parts: [{ kind: "text", text: "forged locally" }],
          },
          remoteActor
        )
      ),
    ]);

    for (const result of results) {
      expect(result).toMatchObject({ ok: false, code: "invalid" });
      if (!result.ok) {
        expect(result.message).toContain(
          "must originate on the installation that owns actor"
        );
      }
    }
    const snapshots = await workRuntime.runPromise(
      repository.snapshotsForCanvas(name)
    );
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "recipient")?.messages
        .items ?? []
    ).toEqual([]);
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "requests")?.requests
        .items ?? []
    ).toEqual([]);
    expect(
      snapshots.find((snapshot) => snapshot.nodeId === "artifacts")?.artifacts
        .items ?? []
    ).toEqual([]);
  });

  it("lets a Remote-local actor queue mail and create requests and artifacts offline", async () => {
    const isolatedRoot = join(
      tmpdir(),
      `vellum-command-work-remote-mail-${randomUUID()}`
    );
    const runtime = makeWorkRuntime(
      join(isolatedRoot, "state", "vellum-command.db")
    );
    const commandCenter = installationId("command-center-mail");
    const hostId = stationHostId("studio");

    try {
      const station = await runtime.runPromise(StationRepository);
      const local = await runtime.runPromise(station.installationId);
      await runtime.runPromise(
        station.pair(
          PairRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "pair",
            commandCenterInstallationId: commandCenter,
            stationInstallationId: local,
            stationLabel: "Studio",
            appVersion: "test",
          })
        )
      );
      await runtime.runPromise(
        station.configureRemote(
          ConfigureRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "configure",
            installationId: local,
            configuration: {
              role: "remote",
              hostId,
              agentHostId: hostId,
              commandCenterInstallationId: commandCenter,
              supervisedPreferred: true,
            },
            host: {
              id: hostId,
              label: "Studio",
              kind: "remote",
              capabilities: ["terminal"],
            },
          })
        )
      );

      const canvasName = "remote-mail";
      const body = compileStationPortfolioBody(
        new Map([
          [
            canvasName,
            {
              nodes: [
                agentNode("sender", hostId),
                agentNode("recipient", hostId),
                emptyTaskNode("tasks"),
                emptyRequestsNode("requests"),
                {
                  id: "artifacts",
                  type: "text",
                  text: "artifacts",
                  x: 420,
                  y: 0,
                  width: 200,
                  height: 100,
                  ether: { entity: { kind: "artifacts" } },
                },
              ],
              edges: [
                {
                  id: "mail",
                  fromNode: "sender",
                  toNode: "recipient",
                  ether: { ports: ["msg.send"] },
                },
                {
                  id: "request",
                  fromNode: "sender",
                  toNode: "requests",
                },
                {
                  id: "artifact",
                  fromNode: "sender",
                  toNode: "artifacts",
                },
              ],
            } satisfies CanvasDoc,
          ],
        ]),
        new Map([[hostId, local]])
      );
      await runtime.runPromise(
        station.installProjection(
          ProjectRequest.make({
            protocol: STATION_API_PROTOCOL,
            op: "project",
            stationInstallationId: local,
            projection: {
              scope: "full",
              generation: logicalSequence("1"),
              sourceCanvasGeneration: logicalSequence("1"),
              sourceIntentSha256:
                stationProjectionContentSha256("remote work source"),
              body,
              contentSha256: stationProjectionContentSha256(body),
              createdAt: "2026-07-27T12:00:00.000Z",
            },
          })
        )
      );

      const canvases = await runtime.runPromise(CanvasesService);
      const read = await runtime.runPromise(canvases.read(canvasName));
      const sender = read.actorRefs.find(
        (candidate) => candidate.nodeId === "sender"
      );
      if (sender === undefined) throw new Error("missing Remote sender actor");
      const remoteWork = await runtime.runPromise(WorkService);
      const remoteRepository = await runtime.runPromise(WorkRepository);
      const basis = await activeIntentBasis(
        runtime,
        "projected-intent"
      );
      await runtime.runPromise(
        remoteRepository.createTask({
          sink: { canvasName, nodeId: "tasks" },
          task: {
            id: "remote-operator-response",
            state: "submitted",
            history: [
              {
                messageId: "remote-operator-response-brief",
                role: "agent",
                parts: [{ kind: "text", text: "need approval" }],
                taskId: "remote-operator-response",
                contextId: canvasName,
              },
            ],
          },
          basis,
        })
      );
      await runtime.runPromise(
        remoteRepository.claimLocalTask({
          sink: { canvasName, nodeId: "tasks" },
          taskId: "remote-operator-response",
          actor: sender,
          basis,
        })
      );
      await runtime.runPromise(
        remoteRepository.transitionTask({
          sink: { canvasName, nodeId: "tasks" },
          taskId: "remote-operator-response",
          state: "input-required",
          basis,
        })
      );
      const deniedResponse = await runtime.runPromise(
        remoteWork.workTaskRespond(
          canvasName,
          "tasks",
          "remote-operator-response",
          "approved",
          "working"
        )
      );
      expect(deniedResponse).toMatchObject({ ok: false, code: "invalid" });
      expect(
        (await runtime.runPromise(remoteRepository.readSnapshot(canvasName, "tasks")))
          .tasks.items[0]?.history
      ).toHaveLength(1);
      const appended = await runtime.runPromise(
        remoteWork.workMessageAppend(
          canvasName,
          "recipient",
          null,
          {
            messageId: "remote-mail-1",
            role: "user",
            parts: [{ kind: "text", text: "from the station" }],
          },
          sender
        )
      );
      expect(appended).toMatchObject({
        ok: true,
        disposition: "queued",
      });
      const request = await runtime.runPromise(
        remoteWork.workRequestCreate(
          canvasName,
          "requests",
          "need operator input",
          undefined,
          sender,
          "blocked without operator decision"
        )
      );
      expect(request).toMatchObject({
        ok: true,
        disposition: "applied",
      });
      const artifact = await runtime.runPromise(
        remoteWork.workArtifactPublish(
          canvasName,
          "artifacts",
          {
            artifactId: "remote-artifact-1",
            parts: [{ kind: "text", text: "created while offline" }],
          },
          sender
        )
      );
      expect(artifact).toMatchObject({
        ok: true,
        disposition: "applied",
      });

      const pending = await runtime.runPromise(
        remoteRepository.pendingCommands
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({
        resolution: undefined,
        command: {
          operation: "message.append",
          id: {
            route: {
              eventHome: local,
              entityHome: commandCenter,
            },
          },
          item: {
            kind: "message",
            itemId: "remote-mail-1",
            sink: { canvasName, nodeId: "recipient" },
          },
          body: {
            operation: "message.append",
            sentBy: sender,
          },
        },
      });
      const snapshots = await runtime.runPromise(
        remoteRepository.snapshotsForCanvas(canvasName)
      );
      expect(
        snapshots.find((snapshot) => snapshot.nodeId === "requests")?.requests
          .items
      ).toEqual([
        expect.objectContaining({
          state: "input-required",
          claimedBy: sender.seatId,
        }),
      ]);
      expect(
        snapshots.find((snapshot) => snapshot.nodeId === "artifacts")?.artifacts
          .items
      ).toEqual([
        expect.objectContaining({ artifactId: "remote-artifact-1" }),
      ]);
    } finally {
      await runtime.dispose();
      await rm(isolatedRoot, { recursive: true, force: true });
    }
  });
});

describe("WorkService — pipeline", () => {
  // NOTE: sink contracts (`ether.tasks.contract`) are currently erased by the
  // authorial write path (canvases stripRuntimeWorkProjection drops the whole
  // tasks bag) — restoring them on write belongs to the contract-editor
  // mutations phase. These service tests therefore author law through REGION
  // contracts, which survive writes; sink-contract enforcement is covered at
  // the pure layer (tests/work-pipeline.test.ts, tests/claims-stack.test.ts).
  it("forwards a completed task along the flow edge and re-homes it submitted", async () => {
    const name = "pipeline-forward";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          {
            id: "law-region",
            type: "group",
            label: "Law",
            x: -50,
            y: -50,
            width: 300,
            height: 200,
            ether: {
              region: {
                contract: {
                  claims: [
                    { id: "c-hard", text: "prove the change", severity: "hard" },
                  ],
                },
              },
            },
          },
          {
            id: "s1",
            type: "text",
            text: "tasks",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
          {
            id: "s2",
            type: "text",
            text: "tasks",
            x: 400,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
        ],
        edges: [
          {
            id: "flow-1",
            fromNode: "s1",
            toNode: "s2",
            ether: { flow: { source: "s1", destination: "s2" } },
          },
        ],
      })
    );
    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "s1", "walk the line", { details: "walk the line" })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.data.id;

    // Claims gate: an unanswered hard claim blocks the completion.
    const blocked = await workRuntime.runPromise(
      work.workTaskTransition(name, "s1", taskId, "completed", undefined, {
        artifacts: [],
      })
    );
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) {
      expect(blocked.message).toContain("claims unsatisfied");
    }

    const forwarded = await workRuntime.runPromise(
      work.workTaskTransition(
        name,
        "s1",
        taskId,
        "completed",
        "checked and packaged",
        {
          artifacts: [],
          responses: [{ claimId: "c-hard", response: "verified by rerun" }],
        }
      )
    );
    expect(forwarded.ok).toBe(true);
    if (!forwarded.ok) return;
    expect(forwarded.data.state).toBe("completed");
    expect(forwarded.data.journey?.at(-1)?.exit).toBe("forwarded");

    const read = await workRuntime.runPromise(canvases.read(name));
    const s1Item = read.doc.nodes
      .find((n) => n.id === "s1")
      ?.ether?.tasks?.items.find((t) => t.id === taskId);
    const s2Item = read.doc.nodes
      .find((n) => n.id === "s2")
      ?.ether?.tasks?.items.find((t) => t.id === taskId);
    expect(s1Item?.state).toBe("completed");
    expect(s1Item?.completionEvidence?.responses?.[0]?.claimId).toBe("c-hard");
    expect(s2Item?.state).toBe("submitted");
    expect(s2Item?.claimedBy).toBeUndefined();
    expect(s2Item?.journey?.at(-1)?.nodeId).toBe("s2");

    // Defect-back: rejecting at s2 with a defect re-opens the s1 row, epoch 1.
    const defected = await workRuntime.runPromise(
      work.workTaskTransition(
        name,
        "s2",
        taskId,
        "rejected",
        undefined,
        undefined,
        { defect: { summary: "misses the acceptance case" } }
      )
    );
    expect(defected.ok).toBe(true);
    if (!defected.ok) return;
    expect(defected.data.state).toBe("rejected");

    const after = await workRuntime.runPromise(canvases.read(name));
    const returned = after.doc.nodes
      .find((n) => n.id === "s1")
      ?.ether?.tasks?.items.find((t) => t.id === taskId);
    const rejectedRow = after.doc.nodes
      .find((n) => n.id === "s2")
      ?.ether?.tasks?.items.find((t) => t.id === taskId);
    expect(returned?.state).toBe("submitted");
    expect(returned?.epoch).toBe(1);
    expect(returned?.completionEvidence).toBeUndefined();
    expect(rejectedRow?.state).toBe("rejected");
    expect(rejectedRow?.journey?.at(-1)?.exit).toBe("rejected-back");
  });

  it("holds a forwarded task from seat claims until its holdUntil passes", async () => {
    const name = "pipeline-hold";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          {
            id: "h1",
            type: "text",
            text: "tasks",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
          {
            id: "h2",
            type: "text",
            text: "tasks",
            x: 400,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
          agentNode("worker-1"),
        ],
        edges: [
          {
            id: "flow-h",
            fromNode: "h1",
            toNode: "h2",
            ether: { flow: { source: "h1", destination: "h2" } },
          },
          { id: "e-w", fromNode: "worker-1", toNode: "h2" },
        ],
      })
    );
    const read = await workRuntime.runPromise(canvases.read(name));
    const actor = read.actorRefs.find((ref) => ref.nodeId === "worker-1");
    if (actor === undefined) throw new Error("missing actor ref");

    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "h1", "bake me", { details: "bake me" })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const forwarded = await workRuntime.runPromise(
      work.workTaskTransition(
        name,
        "h1",
        created.data.id,
        "completed",
        undefined,
        { artifacts: [] },
        { holdForMs: 60 * 60_000 }
      )
    );
    expect(forwarded.ok).toBe(true);

    const refused = await workRuntime.runPromise(
      work.workTaskClaim(name, "h2", created.data.id, actor)
    );
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.message).toContain("not claimable before");
    }

    // Promotion applies only to operator-gated sinks.
    const misPromoted = await workRuntime.runPromise(
      work.workTaskPromote(name, "h2", created.data.id)
    );
    expect(misPromoted.ok).toBe(false);
    if (!misPromoted.ok) {
      expect(misPromoted.message).toContain("operator-gated");
    }
  });

  it("serves show/claims/rulings views with onion-scoped journeys", async () => {
    const name = "pipeline-views";
    await workRuntime.runPromise(
      canvases.write(name, {
        nodes: [
          {
            id: "region-1",
            type: "group",
            label: "Quality",
            x: -50,
            y: -50,
            width: 800,
            height: 400,
            ether: {
              region: {
                contract: {
                  claims: [
                    { id: "r-claim", text: "law of the land", severity: "soft" },
                  ],
                  rulings: [
                    {
                      id: "ruling-1",
                      text: "always cite the rerun",
                      pinnedAt: "2026-08-20T00:00:00.000Z",
                    },
                  ],
                },
              },
            },
          },
          {
            id: "v1",
            type: "text",
            text: "tasks",
            x: 0,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
          {
            id: "v2",
            type: "text",
            text: "tasks",
            x: 400,
            y: 0,
            width: 200,
            height: 100,
            ether: { entity: { kind: "task" } },
          },
        ],
        edges: [
          {
            id: "flow-v",
            fromNode: "v1",
            toNode: "v2",
            ether: { flow: { source: "v1", destination: "v2" } },
          },
        ],
      })
    );
    const created = await workRuntime.runPromise(
      work.workTaskCreate(name, "v1", "onion test", { details: "onion test" })
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const taskId = created.data.id;
    const forwarded = await workRuntime.runPromise(
      work.workTaskTransition(name, "v1", taskId, "completed", "the emission", {
        artifacts: [],
        responses: [
          {
            claimId: "r-claim",
            response: "region law satisfied",
            refs: ["docs/receipt.md"],
          },
        ],
      })
    );
    expect(forwarded.ok).toBe(true);

    const seatView = await workRuntime.runPromise(
      work.workTaskShow(name, "v2", taskId, "seat")
    );
    const priorPassage = seatView.journey.find((p) => p.nodeId === "v1");
    expect(priorPassage?.emissionNote).toBe("the emission");
    expect(priorPassage?.refs).toEqual(["docs/receipt.md"]);
    // Onion: seat view never carries prior interiors.
    expect(priorPassage?.evidence).toBeUndefined();
    // The seat's task thread is brief + arrival marker, not the v1 interior.
    expect(seatView.task.history.some((m) =>
      m.parts.some((p) => p.kind === "text" && p.text.includes("region law satisfied"))
    )).toBe(false);

    const operatorView = await workRuntime.runPromise(
      work.workTaskShow(name, "v2", taskId, "operator")
    );
    expect(
      operatorView.journey.find((p) => p.nodeId === "v1")?.evidence?.responses?.[0]
        ?.response
    ).toBe("region law satisfied");

    const claimsView = await workRuntime.runPromise(
      work.workTaskClaims(name, "v2", taskId)
    );
    expect(claimsView.stack.map((entry) => entry.claim.id)).toEqual(["r-claim"]);
    expect(
      claimsView.readiness?.unanswered.map((entry) => entry.claimId)
    ).toEqual([]);

    const rulings = await workRuntime.runPromise(
      work.workRulingsList(name, "v2")
    );
    expect(rulings.regions[0]?.rulings[0]?.id).toBe("ruling-1");
  });
});
