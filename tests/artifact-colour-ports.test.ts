/**
 * `junto artifact colour` through the live ports (0.11, 03 Colours, C4): the
 * write targets the Artifacts node with no item, is ruled by submitNode on the
 * editing machine and queued elsewhere, and an applied ruling reads no head
 * back, since a colour belongs to no artifact.
 */
import { Effect, Option } from "effect";
import { describe, expect, it } from "vitest";
import { ArtifactRepository } from "../src/main/junto/work/artifact-repository";
import { liveArtifactPorts, type LabelColourWrite } from "../src/main/junto/work/artifact-control";
import { ResourceSubmit, type QueuedOutcome } from "../src/main/junto/work/resource-submit";
import type { ArtifactLabel } from "../src/shared/artifact-labels";
import type { ArtifactOp } from "../src/shared/artifact";
import { asNodeId } from "../src/shared/physics/schema";
import type { ResourceCommand } from "../src/shared/resource-command";
import type { OpId } from "../src/shared/work-ids";

const OP = "01M5EZ00000000000000000001" as OpId;
const write: LabelColourWrite = {
  opId: OP,
  canvasName: "factory",
  actor: { kind: "seat", seatId: `seat_${"2".repeat(64)}`, nodeId: asNodeId("s1") } as never,
  nodeId: asNodeId("shelf"),
  label: "planning" as ArtifactLabel,
  colour: "teal",
};
const everywhere = { inReach: () => true };

/** A store that rules node commands here, and must never be asked for a head. */
const editing = (ruled: Array<ResourceCommand<ArtifactOp>>) =>
  ({
    localWriter: () => Effect.succeed(Option.some("mini")),
    submitNode: (_writer: unknown, command: ResourceCommand<ArtifactOp>) =>
      Effect.sync(() => (ruled.push(command), { kind: "applied", opId: command.opId, facts: [] })),
    submit: () => Effect.die("an item write for a node command"),
    head: () => Effect.die("a head read for a node command"),
  }) as never;

const remote = (answer: QueuedOutcome, queued: Array<ResourceCommand<ArtifactOp>>) =>
  ResourceSubmit.of({
    route: () => Effect.succeed({ kind: "editor", editor: "macbook" as never }),
    queue: (sent) => Effect.sync(() => (queued.push(sent as never), answer)),
  });

const colour = (repo: never, submit?: ReturnType<typeof remote>) => {
  const effect = liveArtifactPorts.colourLabel!(write, everywhere).pipe(Effect.provideService(ArtifactRepository, repo));
  return Effect.runPromise(submit === undefined ? effect : effect.pipe(Effect.provideService(ResourceSubmit, submit)));
};

describe("a label colour write through the live ports", () => {
  it("is ruled by submitNode on the editing machine, on the node with no item", async () => {
    const ruled: Array<ResourceCommand<ArtifactOp>> = [];
    expect(await colour(editing(ruled))).toEqual({ kind: "applied", opId: OP });
    expect(ruled[0]?.target).toEqual({ kind: "artifact", nodeId: "shelf" });
    expect(ruled[0]?.op).toEqual({ op: "labelColour", label: "planning", colour: "teal" });
  });

  it("is queued off the editing machine, and an applied or refused answer reads no head", async () => {
    const queued: Array<ResourceCommand<ArtifactOp>> = [];
    const never = editing([]);
    expect(await colour(never, remote({ kind: "queued" }, queued))).toEqual({ kind: "queued", opId: OP });
    expect(queued[0]?.target).toEqual({ kind: "artifact", nodeId: "shelf" });
    const applied = { kind: "applied", ruling: { facts: [{ fact: "artifact.label.coloured" }] } } as unknown as QueuedOutcome;
    expect(await colour(never, remote(applied, []))).toEqual({ kind: "applied", opId: OP });
    const error = { type: "InputError", message: "no", details: { retryable: false } };
    const refused = { kind: "refused", error, root: OP } as unknown as QueuedOutcome;
    expect(await colour(never, remote(refused, []))).toEqual({ kind: "refused", opId: OP, error });
  });
});
