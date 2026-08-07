import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "../src/shared/canvas";
import {
  multiPromptAgents,
  multiPromptTargetsFromNodes,
} from "../src/renderer/lib/multi-prompt";

describe("multiPromptTargetsFromNodes", () => {
  const base = { x: 0, y: 0, width: 200, height: 80 } as const;

  it("requires managed terminal binding on agent nodes", () => {
    const nodes: CanvasNode[] = [
      {
        ...base,
        id: "a",
        type: "text",
        text: "alpha",
        ether: {
          entity: { kind: "agent", name: "local:alpha" },
          terminal: {
            bindingId: "bind-a",
            harness: "claude",
            launch: { kind: "harness", argv: ["claude"] },
          },
        },
      },
      {
        ...base,
        id: "b",
        type: "text",
        text: "no bind",
        ether: { entity: { kind: "agent", name: "local:beta" } },
      },
      {
        ...base,
        id: "c",
        type: "text",
        text: "note",
      },
    ];
    expect(multiPromptTargetsFromNodes(nodes)).toEqual([
      { nodeId: "a", bindingId: "bind-a", agentKey: "local:alpha" },
    ]);
  });
});

describe("multiPromptAgents", () => {
  const writePrompt = vi.fn();

  beforeEach(() => {
    writePrompt.mockReset();
    writePrompt.mockResolvedValue({ ok: true });
  });

  it("no-ops on empty text or targets", async () => {
    await expect(multiPromptAgents([], "hi", { writePrompt })).resolves.toEqual({
      sent: 0,
      failed: [],
    });
    await expect(
      multiPromptAgents(
        [{ nodeId: "n", bindingId: "b", agentKey: "a:b" }],
        "  ",
        { writePrompt },
      ),
    ).resolves.toEqual({ sent: 0, failed: [] });
    expect(writePrompt).not.toHaveBeenCalled();
  });

  it("wakes and prompts each managed seat", async () => {
    const result = await multiPromptAgents(
      [
        { nodeId: "1", bindingId: "bind-a", agentKey: "local:a" },
        { nodeId: "2", bindingId: "bind-b", agentKey: "local:b" },
      ],
      "do the thing",
      { writePrompt, canvasName: "factory" },
    );

    expect(writePrompt).toHaveBeenCalledTimes(2);
    expect(writePrompt).toHaveBeenCalledWith({
      bindingId: "bind-a",
      text: "do the thing",
      canvasName: "factory",
      nodeId: "1",
    });
    expect(writePrompt).toHaveBeenCalledWith({
      bindingId: "bind-b",
      text: "do the thing",
      canvasName: "factory",
      nodeId: "2",
    });
    expect(result.sent).toBe(2);
    expect(result.failed).toEqual([]);
  });

  it("records write failure without throwing", async () => {
    writePrompt.mockResolvedValue({ ok: false, error: "prompt refused" });

    const result = await multiPromptAgents(
      [{ nodeId: "1", bindingId: "bind-dead", agentKey: "local:dead" }],
      "hello",
      { writePrompt, canvasName: "factory" },
    );

    expect(result.sent).toBe(0);
    expect(result.failed).toEqual([
      { nodeId: "1", agentKey: "local:dead", error: "prompt refused" },
    ]);
  });
});
