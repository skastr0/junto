import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  QUALIFICATION_WORK_ACTOR_NODE_ID,
  QUALIFICATION_WORK_EDGE_ID,
  QUALIFICATION_WORK_SINK_NODE_ID,
  qualificationWorkDocument,
} from "../src/main/vellum/hosts/operator-qualification-work";
import {
  ALL_PORTS,
  admitPure,
  asNodeId,
  canvasDocToCapabilityView,
} from "../src/shared/physics";
import { HostId } from "../src/shared/remote-hosts";

describe("operator qualification work projection", () => {
  it("grants its Remote actor exactly task claim and update authority", () => {
    const document = qualificationWorkDocument(
      "qualification-run",
      Schema.decodeUnknownSync(HostId)("qualification-remote"),
    );
    const edge = document.edges.find(
      (candidate) => candidate.id === QUALIFICATION_WORK_EDGE_ID,
    );

    expect(edge).toMatchObject({
      fromNode: QUALIFICATION_WORK_ACTOR_NODE_ID,
      toNode: QUALIFICATION_WORK_SINK_NODE_ID,
      ether: {
        ports: ["tasks.claim", "tasks.update"],
      },
    });

    const view = canvasDocToCapabilityView(document);
    const granted = ALL_PORTS.filter((port) =>
      Either.isRight(
        admitPure(
          view,
          asNodeId(QUALIFICATION_WORK_ACTOR_NODE_ID),
          asNodeId(QUALIFICATION_WORK_SINK_NODE_ID),
          port,
        ),
      ),
    );

    expect(granted).toEqual(["tasks.claim", "tasks.update"]);
  });
});
