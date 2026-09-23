import { readFileSync } from "node:fs";
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { ActorRefResolver } from "../src/shared/attention";
import {
  actorsNeedingWake,
  isClaimableTaskSink,
  selectFactoryClaims,
} from "../src/shared/factory-tick";
import { BOARD_ENABLED, TASKS_ENABLED } from "../src/shared/features";
import { ActorRef } from "../src/shared/work-protocol";
import {
  admitOverseerWorkTarget,
  admitWorkTarget,
} from "../src/main/junto/work/authz";
import { taskItem } from "./helpers/task-fixtures";
import { seat } from "./helpers/physics-seats";

/**
 * A seat wakes on its own only for a reason the operator can see. A canvas
 * carried over from a build with tasks and board on still holds those sinks
 * and their rows; with the gate off, none of them may start a seat. Each case
 * below is one kernel wake path, asserted against the build's own gate so the
 * all-on lane proves the same fixture does wake when the surface is visible.
 */

const worker = Schema.decodeUnknownSync(ActorRef)({
  seatId: `seat_${"1".repeat(64)}`,
  canvasName: "c",
  nodeId: "w1",
});

const resolver: ActorRefResolver = (ref) =>
  ref.canvasName === worker.canvasName && ref.nodeId === worker.nodeId
    ? worker
    : undefined;

/** A carried-over task board holding `items`, worked by w1. */
const carriedOverTaskBoard = (
  items: ReadonlyArray<ReturnType<typeof taskItem>>,
): CanvasDoc => ({
  nodes: [
    {
      id: "t",
      type: "text",
      text: "tasks",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      ether: {
        entity: { kind: "task" },
        tasks: { items: [...items] },
      },
    },
    seat("w1", "actor", { label: "worker" }),
  ],
  edges: [{ id: "e1", fromNode: "t", toNode: "w1", ether: { verb: "works" } }],
});

/** A carried-over board a seat participates in (compiled wake: true). */
const carriedOverBoard = (): CanvasDoc => ({
  nodes: [
    {
      id: "b",
      type: "text",
      text: "board",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      ether: { entity: { kind: "board", name: "b" } },
    },
    seat("w1", "actor", { label: "worker" }),
  ],
  edges: [{ id: "e1", fromNode: "w1", toNode: "b", ether: { verb: "participates" } }],
});

const kernelSource = (): string =>
  readFileSync("src/main/junto/kernel/service.ts", "utf8");

describe("seat wake follows the visible surface", () => {
  it("wakes a seat for queued tasks only when tasks are in the build (startManagedSeats)", () => {
    const doc = carriedOverTaskBoard([taskItem("queued", "ship it", "submitted")]);
    const wanted = actorsNeedingWake(doc, "c", resolver, {
      isAwake: () => false,
    });
    expect(wanted.has("w1")).toBe(TASKS_ENABLED);
    expect(selectFactoryClaims(doc, "c", resolver).length > 0).toBe(
      TASKS_ENABLED,
    );
    // The launch pass asks exactly this selector which seats to start.
    expect(kernelSource()).toMatch(
      /const startManagedSeats = [\s\S]*?actorsNeedingWake\(doc, canvasName, registry\.resolve/u,
    );
  });

  it("redelivers a working claim only when tasks are in the build (deliverWorkingClaims)", () => {
    const sink = carriedOverTaskBoard([
      { ...taskItem("held", "in flight", "working"), claimedBy: worker.seatId },
    ]).nodes[0]!;
    expect(isClaimableTaskSink(sink)).toBe(TASKS_ENABLED);
    expect(kernelSource()).toMatch(
      /const deliverWorkingClaims = [\s\S]*?if \(!isClaimableTaskSink\(sink\)\) continue;/u,
    );
  });

  it("lets no agent or overseer post a waking board message when the board is off", () => {
    const doc = carriedOverBoard();
    const agentPost = admitWorkTarget(doc, "w1", "b", "board.post");
    const overseerTopic = admitOverseerWorkTarget(doc, "b", "board.create_topic");
    expect(Result.isSuccess(agentPost)).toBe(BOARD_ENABLED);
    expect(Result.isSuccess(overseerTopic)).toBe(BOARD_ENABLED);
    if (!BOARD_ENABLED && Result.isFailure(agentPost)) {
      expect(agentPost.failure.message).toMatch(/disabled in this Junto build/u);
    }

    // The operator megaphone and notify channels exist only with the board.
    const ipc = readFileSync("src/main/junto/ipc.ts", "utf8");
    for (const channel of ["workBoardNotify", "workBoardPost"]) {
      expect(ipc).toContain(
        `if (BOARD_ENABLED) privilegedIpc.handle(\n    IPC_CHANNELS.${channel},`,
      );
    }
  });
});
