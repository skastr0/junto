import { multiPromptTargetsOf } from "../src/renderer/lib/multi-prompt";
import { note as modelNote, seat as modelSeat } from "./support/model-nodes";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalManagedPromptResult } from "../src/shared/ipc";
import {
  formatMultiPromptStatus,
  multiPromptAgents,
} from "../src/renderer/lib/multi-prompt";

describe("multiPromptAgents", () => {
  const writePrompt = vi.fn();

  beforeEach(() => {
    writePrompt.mockReset();
    writePrompt.mockResolvedValue({
      ok: true,
      disposition: "submitted",
    } satisfies TerminalManagedPromptResult);
  });

  it("no-ops on empty text or targets", async () => {
    await expect(multiPromptAgents([], "hi", { writePrompt })).resolves.toEqual({
      sent: 0,
      queued: [],
      failed: [],
    });
    await expect(
      multiPromptAgents(
        [{ nodeId: "n", bindingId: "b", agentKey: "a:b" }],
        "  ",
        { writePrompt },
      ),
    ).resolves.toEqual({ sent: 0, queued: [], failed: [] });
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
    expect(result.queued).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("records write failure without throwing", async () => {
    writePrompt.mockResolvedValue({
      ok: false,
      disposition: "failed",
      error: "prompt refused",
    } satisfies TerminalManagedPromptResult);

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

  it("returns per-seat dispositions so the composer can keep the draft", async () => {
    const byBinding: Record<string, TerminalManagedPromptResult> = {
      "bind-a": { ok: true, disposition: "submitted", messageId: "m-sent" },
      "bind-b": {
        ok: true,
        disposition: "queued",
        messageId: "m-queued",
      },
      "bind-d": {
        ok: false,
        disposition: "failed",
        error: "Immediate prompts require a local managed seat",
      },
    };
    writePrompt.mockImplementation(async (input: { bindingId: string }) => {
      const next = byBinding[input.bindingId];
      if (next === undefined) throw new Error(`unexpected binding ${input.bindingId}`);
      return next;
    });

    const result = await multiPromptAgents(
      [
        { nodeId: "1", bindingId: "bind-a", agentKey: "local:a" },
        { nodeId: "2", bindingId: "bind-b", agentKey: "local:b" },
        { nodeId: "4", bindingId: "bind-d", agentKey: "remote:d" },
      ],
      "broadcast",
      { writePrompt, canvasName: "factory" },
    );

    expect(result.sent).toBe(1);
    expect(result.queued).toEqual([
      {
        nodeId: "2",
        agentKey: "local:b",
        error: "waiting for the seat to start",
        messageId: "m-queued",
      },
    ]);
    expect(result.failed).toEqual([
      {
        nodeId: "4",
        agentKey: "remote:d",
        error: "Immediate prompts require a local managed seat",
      },
    ]);
    expect(formatMultiPromptStatus(result)).toBe(
      "sent 1 — queued 1 — failed 1 — local:b, remote:d",
    );
  });
});

describe("formatMultiPromptStatus", () => {
  it("shows sent queued failed immediately, with seat keys when any did not submit", () => {
    expect(
      formatMultiPromptStatus({
        sent: 2,
        queued: [{ nodeId: "q", agentKey: "local:busy" }],
        failed: [],
      }),
    ).toBe("sent 2 — queued 1 — failed 0 — local:busy");
    expect(
      formatMultiPromptStatus({
        sent: 3,
        queued: [],
        failed: [],
      }),
    ).toBe("sent 3 — queued 0 — failed 0");
  });
});

describe("multiPromptTargetsOf", () => {
  it("makes one target per seat from model nodes, by the seat's own binding", () => {
    expect(multiPromptTargetsOf([modelNote("n"), modelSeat("a", { bindingId: "bind-a" as never }), modelSeat("b")])).toEqual([
      { nodeId: "a", bindingId: "bind-a", agentKey: "local:a" },
      { nodeId: "b", bindingId: "binding-b", agentKey: "local:b" },
    ]);
  });
});
