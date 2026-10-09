import { OPERATOR_PROTOCOL_VERSION, type OperatorRequestEnvelope, type OperatorResponseEnvelope } from "@shared/operator-control";

export interface OperatorCoordinator {
  readonly dispatch: (request: OperatorRequestEnvelope) => Promise<OperatorResponseEnvelope>;
}

/** Companion calls are routed by the window host before reaching this fallback. */
export const makeOperatorCoordinator = (machines?: OperatorCoordinator): OperatorCoordinator => ({
  dispatch: async (request) => request.op.startsWith("machine.") && machines !== undefined ? machines.dispatch(request) : ({
    protocol: OPERATOR_PROTOCOL_VERSION,
    id: request.id,
    op: request.op,
    ok: false,
    error: { type: "runtime_down", message: request.op.startsWith("machine.") ? "Machine control is not available" : "The phone companion is not available" },
  }),
});
