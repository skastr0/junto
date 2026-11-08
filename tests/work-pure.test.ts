import { describe, expect, it } from "vitest";
import { workMessageAppend, type WorkPolicyRead } from "../src/shared/work";
import { canvasOf, region, seat } from "./support/model-nodes";
const work: WorkPolicyRead = { itemsOf: () => [], taskAt: () => undefined, artifactsOf: () => [], artifactsByNode: new Map() };

const agentNode = (frame: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 200, height: 100 }) =>
  seat("agent", {
    ...frame,
    label: "profile-13",
    agentKey: "local:agent",
    launch: { kind: "harness", argv: ["claude"] },
  });

describe("work pure transforms", () => {
  it("appends mail to an agent inbox, keyed to the canvas", () => {
    const onAgent = workMessageAppend(work, canvasOf([agentNode()], [], "c"), "c", "agent", null, {
      messageId: "manual-2",
      role: "user",
      parts: [{ kind: "text", text: "ping" }],
    });
    expect(onAgent).not.toHaveProperty("doc");
    expect(onAgent.message.messageId).toBe("manual-2");
    expect(onAgent.message.contextId).toBe("c");
  });

  it("uses region label as contextId when the agent is inside a group", () => {
    const canvas = canvasOf([
      region("reg", { x: 0, y: 0, width: 400, height: 300 }, { label: "forge-lane" }),
      agentNode({ x: 40, y: 40, width: 120, height: 80 }),
    ], [], "c");
    const appended = workMessageAppend(work, canvas, "canvas-name", "agent", null, {
      messageId: "inside-1",
      role: "user",
      parts: [{ kind: "text", text: "inside" }],
    });
    expect(appended.message.contextId).toBe("forge-lane");
  });
});
