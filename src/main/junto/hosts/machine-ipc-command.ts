import { Effect, Result } from "effect";
import { OPERATOR_PROTOCOL_VERSION, OPERATOR_MAX_TIMEOUT_MS, decodeOperatorRequest, type OperatorResponseEnvelope } from "@shared/operator-control";
import { decodeMachineCommandProgress, type MachineCommandProgress } from "@shared/machine-progress";
import type { MachineOwnerActions } from "./machine-owner";

/** A window uses the same closed owner action implementation as the local socket. */
export const dispatchMachineIpcCommand = (
  actions: MachineOwnerActions,
  input: unknown,
  notify: (progress: MachineCommandProgress) => void,
): Effect.Effect<OperatorResponseEnvelope> => {
  const decoded = decodeOperatorRequest(input);
  if (Result.isFailure(decoded) || !decoded.success.op.startsWith("machine.")) return Effect.succeed({
    protocol: OPERATOR_PROTOCOL_VERSION, ok: false,
    error: { type: "validation", message: "invalid machine command", details: { retryable: false } },
  });
  const request = decoded.success;
  const transitions: Extract<MachineCommandProgress["event"], { event: "machine-install" }>[] = [];
  let active = true;
  const observer = (event: MachineCommandProgress["event"]) => {
    if (!active || (request.op !== "machine.send" && request.op !== "machine.update")) return;
    const progress = decodeMachineCommandProgress({ id: request.id, event });
    if (Result.isFailure(progress)) return;
    if (progress.success.event.event === "machine-install") {
      if (transitions.length >= 5) return;
      transitions.push(progress.success.event);
    }
    try { notify(progress.success); } catch { /* Closing a window does not cancel the owner operation. */ }
  };
  return actions.dispatch(request, observer).pipe(
    Effect.timeoutOrElse({ duration: OPERATOR_MAX_TIMEOUT_MS, orElse: () => Effect.succeed({
      protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false,
      error: { type: "io", message: "The machine command timed out; check its status before trying again", details: {
        retryable: false,
        ...(request.op === "machine.send" || request.op === "machine.update" ? { disposition: "uncertain" as const, transitions } : {}),
      } },
    } as const) }),
    Effect.ensuring(Effect.sync(() => { active = false; })),
  );
};
