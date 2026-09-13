import { describe, expect, it, vi } from "vitest";
import type { OverseerHostEvent, OverseerHostRun } from "../src/shared/overseer-host-control";
import { runOverseerTurn } from "../src/overseer-host/session";
import { overseerHostTools } from "../src/overseer-host/tools";
import { earlyDispatchFromArgv } from "../src/cli/early-dispatch";

const assignment = (): OverseerHostRun => ({
  type: "run", sessionId: "session", requestId: "request", intentRevision: 1,
  model: "controller-test", apiKey: "test-private-key", instructions: "Use verified canvas facts.",
  context: "Move the selected task.", operationIds: ["op-main-1", "op-main-2"], expectedRevision: "revision-1",
});
const call = (name: string, args: unknown) => ({ status: "completed", output: [
  { type: "function_call", call_id: "call-1", name, arguments: JSON.stringify(args) },
] });

describe("native Overseer host", () => {
  it("ships as one internal command in the existing packaged CLI", () => {
    expect(earlyDispatchFromArgv(["bun", "/app/vellum-command", "overseer-host"])).toEqual({ kind: "overseer-host", args: [] });
    const tools = overseerHostTools();
    expect(tools.some((tool) => tool.name === "canvas__batch")).toBe(true);
    expect(tools.every((tool) => tool.parameters.type === "object")).toBe(true);
  });

  it("correlates tools with main-minted IDs and preserves reasoning/output receipts between Responses calls", async () => {
    const events: OverseerHostEvent[] = [];
    const respond = vi.fn().mockResolvedValueOnce({ status: "completed", output: [
      { type: "reasoning", id: "r1", encrypted_content: "encrypted", summary: [] },
      ...call("node__move", { nodeId: "task", x: 1, y: 2 }).output,
    ] }).mockResolvedValueOnce({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "The task moved." }] }] });
    const tool = vi.fn().mockResolvedValue({ ok: true, operation: "node.move", data: { node: { id: "task", x: 1, y: 2 } } });
    await runOverseerTurn(assignment(), { respond, tool, event: async (event) => { events.push(event); }, control: vi.fn() }, new AbortController().signal);
    expect(tool.mock.calls[0]?.[0]).toMatchObject({ operation: "node.move", live: {
      operationId: "op-main-1", sessionId: "session", requestId: "request", intentRevision: 1, expectedRevision: "revision-1",
    } });
    expect(respond.mock.calls[1]?.[0]).toMatchObject({ store: false, include: ["reasoning.encrypted_content"], parallel_tool_calls: false });
    expect(respond.mock.calls[1]?.[0].input).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "reasoning", encrypted_content: "encrypted" }),
      expect.objectContaining({ type: "function_call_output", call_id: "call-1" }),
    ]));
    expect(events.at(-1)).toMatchObject({ type: "completed", message: "The task moved." });
  });

  it("does not call tools or claim completion for a failed/incomplete Responses outcome", async () => {
    for (const status of ["failed", "cancelled", "incomplete"]) {
      const events: OverseerHostEvent[] = [];
      const tool = vi.fn();
      await runOverseerTurn(assignment(), {
        respond: async () => ({ status, output: [] }), tool, control: vi.fn(), event: async (event) => { events.push(event); },
      }, new AbortController().signal);
      expect(tool).not.toHaveBeenCalled();
      expect(events.at(-1)?.type).toBe("failed");
    }
  });

  it("does not replay a tool whose transport failed after dispatch", async () => {
    const events: OverseerHostEvent[] = [];
    const tool = vi.fn().mockRejectedValue(new Error("UncertainCompletion"));
    const respond = vi.fn().mockResolvedValue(call("agent__prompt", { nodeId: "worker", text: "Investigate" }));
    await runOverseerTurn(assignment(), { respond, tool, control: vi.fn(), event: async (event) => { events.push(event); } }, new AbortController().signal);
    expect(tool).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe("failed");
  });

  it("fences a cancellation that arrives before a model tool result", async () => {
    const controller = new AbortController();
    const tool = vi.fn();
    const events: OverseerHostEvent[] = [];
    await runOverseerTurn(assignment(), {
      respond: async () => { controller.abort(); return call("node__move", { nodeId: "task", x: 1, y: 2 }); },
      tool, control: vi.fn(), event: async (event) => { events.push(event); },
    }, controller.signal);
    expect(tool).not.toHaveBeenCalled();
    expect(events.at(-1)?.type).toBe("cancelled");
  });

  it("routes an explicit spoken correction through the authenticated controller protocol", async () => {
    const control = vi.fn().mockResolvedValue({ type: "idle" });
    const respond = vi.fn().mockResolvedValueOnce(call("request__steer", { targetRequestId: "prior", text: "Use the other worker" }))
      .mockResolvedValueOnce({ status: "completed", output: [] });
    await runOverseerTurn(assignment(), { respond, tool: vi.fn(), control, event: async () => {} }, new AbortController().signal);
    expect(control.mock.calls[0]?.[0]).toEqual({ type: "steer", sessionId: "session", requestId: "request", intentRevision: 1,
      targetRequestId: "prior", text: "Use the other worker" });
  });
});
