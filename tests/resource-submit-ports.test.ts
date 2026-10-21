/**
 * The task and artifact store ports on a machine that does not edit the
 * canvas: a write goes through ResourceSubmit, and its answer becomes the
 * port's outcome; the CLI's result says queued with the opId, a success.
 */
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { ArtifactRepository } from "../src/main/junto/work/artifact-repository";
import { liveArtifactPorts, writeResult } from "../src/main/junto/work/artifact-control";
import { ResourceSubmit, type QueuedOutcome } from "../src/main/junto/work/resource-submit";
import { liveTaskPorts, writeResultOf } from "../src/main/junto/work/task-control";
import { TaskRepository } from "../src/main/junto/work/task-repository";
import type { ArtifactOp } from "../src/shared/artifact";
import { asNodeId } from "../src/shared/physics/schema";
import type { ResourceCommand } from "../src/shared/resource-command";
import type { TaskCommand } from "../src/shared/task-model";
import type { ItemId, OpId } from "../src/shared/work-ids";

const OP = "01M5EZ00000000000000000001" as OpId;
const ITEM = "01M5EZ0000000000000000000A" as ItemId;
const seatActor = { kind: "seat", seatId: `seat_${"2".repeat(64)}`, nodeId: asNodeId("s1") } as never;
const EDITOR = "macbook" as never;

const command = <Op>(kind: "task" | "artifact", nodeId: string, op: Op): ResourceCommand<Op> => ({
  opId: OP,
  canvasName: "factory",
  actor: seatActor,
  target: { kind, nodeId: asNodeId(nodeId), itemId: ITEM },
  basis: null,
  after: [],
  op,
});

/** A machine that does not edit the canvas: every write is queued, and answers this. */
const remote = (answer: QueuedOutcome, queued: Array<OpId>) =>
  ResourceSubmit.of({
    route: () => Effect.succeed({ kind: "editor", editor: EDITOR }),
    queue: (sent) => Effect.sync(() => (queued.push(sent.opId), answer)),
  });

/** A store that must never rule here. */
const neverRules = { submit: () => Effect.die("ruled on a machine that does not edit the canvas") };

describe("a write on a machine that does not edit the canvas", () => {
  it("is queued for tasks, and the CLI's result says queued with the task", async () => {
    const queued: Array<OpId> = [];
    const written = command<TaskCommand>("task", "board-1", { kind: "start" });
    const result = await Effect.runPromise(
      liveTaskPorts.submit(written, { inReach: () => true }, {} as never).pipe(
        Effect.flatMap((outcome) => writeResultOf(outcome, written)),
        Effect.provideService(ResourceSubmit, remote({ kind: "queued" }, queued)),
        Effect.provideService(TaskRepository, neverRules as never),
      ),
    );
    expect(queued).toEqual([OP]);
    expect(result).toEqual({ disposition: "queued", opId: OP, taskId: ITEM });
  });

  it("is queued for artifacts, and the CLI's result says queued with the artifact", async () => {
    const queued: Array<OpId> = [];
    const written = command<ArtifactOp>("artifact", "A", { op: "retitle", title: "x" } as never);
    const result = await Effect.runPromise(
      liveArtifactPorts.submit(written, { inReach: () => true }).pipe(
        Effect.flatMap((outcome) => writeResult(outcome, written)),
        Effect.provideService(ResourceSubmit, remote({ kind: "queued" }, queued)),
        Effect.provideService(ArtifactRepository, neverRules as never),
      ),
    );
    expect(queued).toEqual([OP]);
    expect(result).toEqual({ disposition: "queued", opId: OP, artifactId: ITEM });
  });

  it("answers an artifact ruling that came back applied at the version held here", async () => {
    const written = command<ArtifactOp>("artifact", "A", { op: "retitle", title: "x" } as never);
    const ruling = { operation: "ruling.applied", writer: "mini", opId: OP, actor: seatActor, kind: "artifact", facts: [{ fact: "artifact.retitled", artifactId: ITEM, title: "x", at: 1 }] } as never;
    const repo = { ...neverRules, head: () => Effect.succeed(Option.some({ artifact: { version: 4 } })) };
    const result = await Effect.runPromise(
      liveArtifactPorts.submit(written, { inReach: () => true }).pipe(
        Effect.flatMap((outcome) => writeResult(outcome, written)),
        Effect.provideService(ResourceSubmit, remote({ kind: "applied", ruling }, [])),
        Effect.provideService(ArtifactRepository, repo as never),
      ),
    );
    expect(result).toEqual({ disposition: "applied", opId: OP, artifactId: ITEM, version: 4 });
  });

  it("carries a refusal that came back as the ruler's error, with the opId", async () => {
    const written = command<TaskCommand>("task", "board-1", { kind: "start" });
    const error = { type: "InvalidTransition", message: "no", details: { reason: "invalid_transition" } } as const;
    const exit = await Effect.runPromiseExit(
      liveTaskPorts.submit(written, { inReach: () => true }, {} as never).pipe(
        Effect.flatMap((outcome) => writeResultOf(outcome, written)),
        Effect.provideService(ResourceSubmit, remote({ kind: "refused", error, root: OP }, [])),
        Effect.provideService(TaskRepository, neverRules as never),
      ),
    );
    expect(JSON.stringify(exit)).toContain("invalid_transition");
    expect(JSON.stringify(exit)).toContain(OP);
  });
});
