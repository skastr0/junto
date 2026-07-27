import { describe, expect, it } from "vitest";
import { factoryClaimTick } from "../src/shared/factory-tick";
import type { CanvasDoc } from "../src/shared/canvas";
import { deliveryTargetOf, isPendingDelivery } from "../src/shared/message-delivery";

const doc: CanvasDoc = {
  nodes: [
    {
      id: "worker",
      type: "text",
      text: "claude",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      ether: {
        entity: { kind: "agent", name: "local:claude" },
        terminal: { bindingId: "bind-1", harness: "claude" },
      },
    },
    {
      id: "tasks",
      type: "text",
      text: "tasks",
      x: 200,
      y: 0,
      width: 100,
      height: 80,
      ether: {
        entity: { kind: "task" },
        tasks: {
          items: [
            {
              id: "t1",
              state: "submitted",
              history: [
                {
                  messageId: "m0",
                  role: "user",
                  parts: [{ kind: "text", text: "ship the loop" }],
                  contextId: "demo",
                },
              ],
            },
          ],
        },
      },
    },
  ],
  edges: [{ id: "e1", fromNode: "worker", toNode: "tasks" }],
};

describe("factoryClaimTick agent nudge", () => {
  it("claims and appends a pending user message on the managed actor", () => {
    const { doc: next, claimed } = factoryClaimTick(doc, "demo");
    expect(claimed).toEqual([{ taskId: "t1", actor: "worker" }]);
    const actor = next.nodes.find((n) => n.id === "worker")!;
    const items = actor.ether?.messages?.items ?? [];
    expect(items.length).toBe(1);
    expect(items[0]!.role).toBe("user");
    expect(items[0]!.parts[0]).toMatchObject({
      kind: "text",
    });
    expect(String((items[0]!.parts[0] as { text: string }).text)).toContain(
      "vellum onboard",
    );
    expect(isPendingDelivery(items[0]!)).toBe(true);
    expect(deliveryTargetOf(actor)).toEqual({
      bindingId: "bind-1",
    });
  });
});
