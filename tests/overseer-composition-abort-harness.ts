import type { OverseerRequest, OverseerResult } from "../src/shared/overseer-control";

export const runWithAbortForTest = (
  request: OverseerRequest,
  signal: AbortSignal,
): Promise<OverseerResult> => {
  if (signal.aborted) {
    return Promise.resolve({
      ok: false,
      operation: request.operation,
      error: { type: "RuntimeDown", message: "overseer command aborted" },
    });
  }
  return Promise.resolve({
    ok: true,
    operation: request.operation,
    data: {},
  });
};
