import { Effect, Result } from "effect";
import { OPERATOR_PROTOCOL_VERSION, OPERATOR_MAX_TIMEOUT_MS, decodeOperatorRequest, type OperatorResponseEnvelope } from "@shared/operator-control";
import { decodeMachineCommandProgress, type MachineCommandProgress } from "@shared/machine-progress";
import { MACHINE_INSTALL_COMMANDS, MACHINE_INSTALL_COMMAND_TIMEOUT_MS } from "@shared/machine-command-bounds";
import type { MachineOwnerActions } from "./machine-owner";
import type { MachineFarInstallTransition } from "@shared/machine-install";

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
  // A machine takes its vault token only from the window machine's SSH session, through vault-token-local.
  if (request.op === "machine.vault-receive") return Effect.succeed({
    protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false,
    error: { type: "forbidden", message: "A vault token is received only over the window machine's SSH session", details: { retryable: false } },
  });
  // An install waits for each of its steps, every one bounded (machine-command-bounds.ts); any other command takes the operator bound.
  const installs = (MACHINE_INSTALL_COMMANDS as ReadonlyArray<string>).includes(request.op);
  /** The far installer's steps seen, for a timeout's answer: never this machine's own `pinned`. */
  const transitions: MachineFarInstallTransition[] = [];
  let active = true;
  const observer = (event: MachineCommandProgress["event"]) => {
    if (!active || !installs) return;
    const progress = decodeMachineCommandProgress({ id: request.id, event });
    if (Result.isFailure(progress)) return;
    if (progress.success.event.event === "machine-install") {
      const step = progress.success.event.step;
      if (step !== "pinned") {
        if (transitions.length >= 5) return;
        transitions.push({ ...progress.success.event, step });
      }
    }
    try { notify(progress.success); } catch { /* Closing a window does not cancel the owner operation. */ }
  };
  return actions.dispatch(request, observer).pipe(
    Effect.timeoutOrElse({ duration: installs ? MACHINE_INSTALL_COMMAND_TIMEOUT_MS : OPERATOR_MAX_TIMEOUT_MS, orElse: () => Effect.succeed({
      protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: false,
      error: { type: "io", message: "The machine command timed out; check its status before trying again", details: {
        retryable: false,
        ...(installs ? { disposition: "uncertain" as const, transitions } : {}),
      } },
    } as const) }),
    Effect.ensuring(Effect.sync(() => { active = false; })),
  );
};
