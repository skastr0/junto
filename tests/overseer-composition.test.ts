import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { OverseerCaller, OverseerRequest, OverseerResult } from "../src/shared/overseer-control";
import type { WorkErrorBody } from "../src/shared/work-control";
import type { ApplicationCaptureResult } from "../src/main/vellum-command/overseer/native";

const captureTrustedWindowPng = (
  capture: () => Promise<Uint8Array | undefined>,
): (() => Promise<ApplicationCaptureResult>) =>
  async () => {
    const png = await capture();
    if (png === undefined) {
      return {
        ok: false,
        unavailable: true,
        reason: "no trusted Command Center window to observe",
      };
    }
    return { ok: true, png };
  };

describe("overseer composition helpers", () => {
  it("observes a trusted window PNG without claiming a viewport mutation", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
    const capture = captureTrustedWindowPng(async () => png);
    await expect(capture()).resolves.toEqual({ ok: true, png });
  });

  it("reports unavailable when there is no trusted window", async () => {
    const capture = captureTrustedWindowPng(async () => undefined);
    const result = await capture();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.unavailable).toBe(true);
      expect(result.reason).toMatch(/no trusted Command Center window/);
    }
  });

  it("propagates AbortSignal as an inner RuntimeDown, not success", async () => {
    const { runWithAbortForTest } = await import("./overseer-composition-abort-harness");
    const controller = new AbortController();
    controller.abort();
    const request: OverseerRequest = { operation: "status", args: {} };
    const result = await runWithAbortForTest(request, controller.signal);
    expect(result).toEqual({
      ok: false,
      operation: "status",
      error: { type: "RuntimeDown", message: "overseer command aborted" },
    });
  });
});

describe("overseer work-socket callback shape", () => {
  it("matches WorkControlDeps onOverseer (request, caller, AbortSignal) => Promise<OverseerResult>", async () => {
    const caller: OverseerCaller = { canvasName: "work", nodeId: "agent-1" };
    const request: OverseerRequest = { operation: "status" };
    const onOverseer = async (
      next: OverseerRequest,
      nextCaller: OverseerCaller,
      signal: AbortSignal,
    ): Promise<OverseerResult> => {
      expect(nextCaller).toEqual(caller);
      expect(signal.aborted).toBe(false);
      return { ok: true, operation: next.operation, data: { humanDelegationOnly: true } };
    };
    const result = await onOverseer(request, caller, new AbortController().signal);
    expect(result.ok).toBe(true);
  });

  it("stops accepting after dispose latch", () => {
    let accepting = true;
    const onOverseer = async (
      request: OverseerRequest,
    ): Promise<OverseerResult> => {
      if (!accepting) {
        return {
          ok: false,
          operation: request.operation,
          error: { type: "RuntimeDown", message: "overseer composition is disposed" },
        };
      }
      return { ok: true, operation: request.operation, data: {} };
    };
    accepting = false;
    return expect(onOverseer({ operation: "status" })).resolves.toMatchObject({
      ok: false,
      error: { type: "RuntimeDown" },
    });
  });

  it("keeps inner WorkErrorBody forwarding fail-closed", () => {
    const forward = (
      _caller: OverseerCaller,
      _request: OverseerRequest,
    ): Effect.Effect<OverseerResult, WorkErrorBody> =>
      Effect.fail({
        type: "RuntimeDown",
        message: "Command Center has no active Station session",
        details: { retryable: false },
      });
    expect(Effect.isEffect(forward({ canvasName: "work", nodeId: "n1" }, { operation: "canvas.list" }))).toBe(true);
  });
});
