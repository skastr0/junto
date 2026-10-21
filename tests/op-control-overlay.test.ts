/**
 * `op show` and `op list` carry what this machine reads of a queued write
 * over its ruled state (read-your-writes, 02): the overlay entry of each
 * queued artifact write, replayed over the whole queue of this machine. A
 * ruled write, and a write of a domain with no overlay reader, carry none.
 */
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import type { QueuedCommand } from "../src/shared/command-row";
import type { InstallationId } from "../src/shared/installation-id";
import type { OpView } from "../src/shared/op-control";
import { asNodeId } from "../src/shared/physics/schema";
import { mintItemId, mintOpId, type PendingEntry } from "../src/shared/resource-command";
import { ArtifactRepository } from "../src/main/junto/work/artifact-repository";
import { handleOpOp } from "../src/main/junto/work/op-control";
import { OpRepository } from "../src/main/junto/work/op-repository";

const mini = "mini" as InstallationId;
const seat = { kind: "seat" as const, seatId: `seat_${"b".repeat(64)}`, nodeId: asNodeId("a") };
const queuedCommand = (kind: "artifact" | "task", op: unknown): QueuedCommand =>
  ({ opId: mintOpId(), canvasName: "factory", actor: seat, target: { kind, nodeId: asNodeId("n"), itemId: mintItemId() }, basis: null, after: [], op }) as never;

const edit = queuedCommand("artifact", { op: "edit", edit: { kind: "replace", baseVersion: 2, body: { type: "document", markdown: "" } } });
const task = queuedCommand("task", { kind: "start" });
const ruled = { state: "refused", opId: mintOpId(), error: { type: "Stale", message: "x" }, root: mintOpId() } as OpView;

/** What the artifact overlay saw, and what it answered. */
let replayed: ReadonlyArray<string> = [];
let reachOnTheCanvas: boolean | undefined;
const answer: PendingEntry = { opId: edit.opId, status: "at_risk", waiting: "base_not_pulled", root: edit.opId };

const services = Layer.mergeAll(
  Layer.succeed(OpRepository, OpRepository.of({
    show: (_scope, opId) => Effect.succeed(opId === ruled.opId ? ruled : { state: "queued", opId }),
    list: () => Effect.succeed({ ops: [{ state: "queued", opId: edit.opId }, { state: "queued", opId: task.opId }, ruled], more: false }),
    unruled: () => Effect.succeed({ writer: mini, commands: [edit, task] }),
  })),
  Layer.succeed(ArtifactRepository, {
    overlay: (
      _canvas: string,
      _writer: InstallationId,
      queued: ReadonlyArray<{ readonly opId: string }>,
      context: { readonly inReach: (actor: unknown, target: unknown) => boolean },
    ) => {
      replayed = queued.map(({ opId }) => opId);
      reachOnTheCanvas = context.inReach({ kind: "operator" }, { kind: "artifact", nodeId: "gone" });
      return Effect.succeed([answer]);
    },
  } as never),
);

const run = (op: "op.show" | "op.list", args: unknown) =>
  Effect.runPromise(handleOpOp(op, args, { canvasName: "factory", nodeId: asNodeId("a"), canvas: { nodes: new Map(), wires: new Map() } as never }).pipe(Effect.provide(services)));

describe("op show and op list over the overlay", () => {
  it("op show gives a queued artifact write its overlay entry, replaying only artifact commands", async () => {
    expect(await run("op.show", { opId: edit.opId })).toEqual({
      op: { state: "queued", opId: edit.opId, overlay: { status: "at_risk", waiting: "base_not_pulled", root: edit.opId } },
    });
    expect(replayed).toEqual([edit.opId]);
    // The replay judges reach on the caller's canvas, as the ruler does: a node it does not hold is out of reach.
    expect(reachOnTheCanvas).toBe(false);
  });

  it("op list gives the overlay to the queued artifact write only", async () => {
    const listed = await run("op.list", {});
    expect(listed).toEqual({
      ops: [
        { state: "queued", opId: edit.opId, overlay: { status: "at_risk", waiting: "base_not_pulled", root: edit.opId } },
        { state: "queued", opId: task.opId },
        ruled,
      ],
      more: false,
    });
  });

  it("op show of a ruled write reads no overlay", async () => {
    replayed = [];
    expect(await run("op.show", { opId: ruled.opId })).toEqual({ op: ruled });
    expect(replayed).toEqual([]);
  });
});
