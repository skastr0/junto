import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import type { CanvasReadResult } from "../src/shared/ipc";
import { deriveBoxHostActivity } from "../src/main/vellum/box/activity-policy";

const workerSeatId = Schema.decodeUnknownSync(ActorSeatId)(
  `seat_${"a".repeat(64)}`,
);

const read = (
  state: "submitted" | "working" | "input-required" | "completed",
  options: {
    readonly actorHost?: string;
    readonly includeActorRef?: boolean;
  } = {},
): CanvasReadResult => ({
  name: "factory",
  revision: "revision",
  workRevision: "work-revision",
  actorRefs:
    options.includeActorRef === false
      ? []
      : [
          {
            seatId: workerSeatId,
            canvasName: "factory",
            nodeId: "worker",
          },
        ],
  doc: {
    nodes: [
      {
        id: "worker",
        type: "text",
        x: 0,
        y: 0,
        width: 200,
        height: 80,
        text: "worker",
        ether: {
          entity: { kind: "agent", name: "worker" },
          ...(options.actorHost === undefined
            ? {}
            : { host: options.actorHost }),
        },
      },
      {
        id: "tasks",
        type: "text",
        x: 240,
        y: 0,
        width: 200,
        height: 80,
        text: "tasks",
        ether: {
          entity: { kind: "task", name: "tasks" },
          tasks: {
            items: [
              {
                id: "task-1",
                state,
                ...(state === "submitted"
                  ? {}
                  : { claimedBy: workerSeatId }),
                history: [],
              },
            ],
          },
        },
      },
      {
        id: "placed-note",
        type: "text",
        x: 480,
        y: 0,
        width: 200,
        height: 80,
        text: "placement is not activity",
        ether: { host: "box-note-only" },
      },
    ],
    edges: [],
  },
});

describe("Box activity policy", () => {
  it("pins only the host of an actor with active claimed work", () => {
    expect(
      deriveBoxHostActivity([
        read("working", { actorHost: "box-worker" }),
      ]),
    ).toEqual({
      activeHostIds: new Set(["box-worker"]),
      hasUnresolvedActiveWork: false,
    });
  });

  it.each(["submitted", "completed"] as const)(
    "does not treat %s work or mere placement as activity",
    (state) => {
      expect(
        deriveBoxHostActivity([
          read(state, { actorHost: "box-worker" }),
        ]),
      ).toEqual({
        activeHostIds: new Set(),
        hasUnresolvedActiveWork: false,
      });
    },
  );

  it("keeps machines awake when active work cannot resolve an exact host", () => {
    expect(
      deriveBoxHostActivity([
        read("input-required", {
          actorHost: "box-worker",
          includeActorRef: false,
        }),
      ]),
    ).toEqual({
      activeHostIds: new Set(),
      hasUnresolvedActiveWork: true,
    });
  });
});
