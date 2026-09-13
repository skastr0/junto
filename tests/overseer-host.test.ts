import { describe, expect, it, vi } from "vitest";
import type { OverseerHostEvent, OverseerHostRun } from "../src/shared/overseer-host-control";
import { requestBackendResponse, runOverseerTurn } from "../src/overseer-host/session";
import { decodeHostTool, overseerHostTools } from "../src/overseer-host/tools";
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
    expect(tools.find((tool) => tool.name === "canvas__list")?.parameters).toEqual({ type: "object", properties: {}, additionalProperties: false });
  });

  it("does not expose worker dispatch or task mutations in the POC", () => {
    for (const name of ["agent__start", "agent__prompt", "agent__interrupt", "tasks__create", "tasks__describe", "tasks__update"]) {
      expect(overseerHostTools().some((tool) => tool.name === name)).toBe(false);
      expect(() => decodeHostTool(name, "{}")).toThrow("outside the controller catalog");
    }
  });

  it("uses a fresh canvas read revision for the follow-up edit", async () => {
    const events: OverseerHostEvent[] = [];
    const respond = vi.fn()
      .mockResolvedValueOnce(call("canvas__read", {}))
      .mockResolvedValueOnce(call("node__move", { nodeId: "task", x: 10, y: 20 }))
      .mockResolvedValueOnce({ status: "completed", output: [] });
    const tool = vi.fn()
      .mockResolvedValueOnce({ ok: true, operation: "canvas.read", data: { revision: "fresh-revision" } })
      .mockResolvedValueOnce({ ok: true, operation: "node.move", data: {} });
    const conversation = [{ role: "user", content: "Earlier request" }, { role: "assistant", content: "Earlier answer" }];
    await runOverseerTurn({ ...assignment(), conversation }, {
      respond, tool, event: async (event) => { events.push(event); }, control: vi.fn(),
    }, new AbortController().signal);
    expect(respond.mock.calls[0]?.[0].input.slice(0, 2)).toEqual(conversation);
    expect(tool.mock.calls[1]?.[0]).toMatchObject({ live: { expectedRevision: "fresh-revision", operationId: "op-main-2" } });
    expect(events.at(-1)?.type).toBe("completed");
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
    const respond = vi.fn().mockResolvedValue(call("node__move", { nodeId: "task", x: 1, y: 2 }));
    await runOverseerTurn(assignment(), { respond, tool, control: vi.fn(), event: async (event) => { events.push(event); } }, new AbortController().signal);
    expect(tool).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(events.at(-1)?.type).toBe("failed");
  });

  it("reports provider failure once without retrying or invoking tools", async () => {
    const events: OverseerHostEvent[] = [];
    const respond = vi.fn().mockRejectedValue(new Error("The controller API returned HTTP 429."));
    const tool = vi.fn();
    await runOverseerTurn(assignment(), { respond, tool, control: vi.fn(), event: async (event) => { events.push(event); } }, new AbortController().signal);
    expect(respond).toHaveBeenCalledTimes(1);
    expect(tool).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({ type: "failed", message: "The controller API returned HTTP 429." });
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

describe("controller HTTP response", () => {
  const waitingFetch = () => vi.fn((_url: string, init: RequestInit): Promise<Response> => new Promise((_resolve, reject) => {
    const signal = init.signal!;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));

  it("bounds a stalled provider request with a deadline", async () => {
    const fetch = waitingFetch();
    await expect(requestBackendResponse({}, "test", new AbortController().signal, { fetch, timeoutMs: 10 })).rejects.toThrow("timed out");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts an in-flight provider request on cancellation", async () => {
    const fetch = waitingFetch();
    const controller = new AbortController();
    const pending = requestBackendResponse({}, "test", controller.signal, { fetch });
    controller.abort(new Error("Request cancelled"));
    await expect(pending).rejects.toThrow("Request cancelled");
  });

  it("does not send a request that was already cancelled", async () => {
    const fetch = waitingFetch();
    const controller = new AbortController();
    controller.abort();
    await expect(requestBackendResponse({}, "test", controller.signal, { fetch })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a completed JSON response and fails on an HTTP error", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ status: "completed", output: [] })))
      .mockResolvedValueOnce(new Response("private provider detail", { status: 401 }));
    await expect(requestBackendResponse({}, "test", new AbortController().signal, { fetch })).resolves.toEqual({ status: "completed", output: [] });
    await expect(requestBackendResponse({}, "test", new AbortController().signal, { fetch })).rejects.toThrow("HTTP 401");
  });
});
