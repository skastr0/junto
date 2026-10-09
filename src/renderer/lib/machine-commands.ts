import { Result } from "effect";
import { ulid } from "ulid";
import type { MachineArgsByOp, MachineDataByOp, MachineOpName } from "@shared/machine-control";
import type { MachineInstallTransition } from "@shared/machine-install";
import { decodeMachineCommandProgress, type MachineCommandProgress } from "@shared/machine-progress";
import {
  OPERATOR_PROTOCOL_VERSION,
  decodeOperatorResponse,
  type OperatorErrorType,
  type OperatorRequestEnvelope,
} from "@shared/operator-control";
import { getJuntoApi } from "./junto-api";

// The window's whole reach over machines: the closed owner commands, the same
// ones `junto machine` sends, carried over one IPC call. Nothing here opens
// SSH or knows a second way to a machine. Main decodes the request; this
// decodes the answer with its closed schema before anything reads it.

/** A command the owner refused, or one the window could not ask. */
export type MachineCommandRefusal = {
  readonly ok: false;
  /** The owner's error type; `unavailable` when no answer came back. */
  readonly type: OperatorErrorType | "unavailable";
  /** The plain reason, as the owner said it. */
  readonly message: string;
  /** False once a command that changes a machine may have reached it. */
  readonly retryable: boolean;
  /** How far an install got before it stopped. */
  readonly transitions: ReadonlyArray<MachineInstallTransition>;
};

export type MachineCommandAnswer<Op extends MachineOpName> =
  | { readonly ok: true; readonly data: MachineDataByOp[Op] }
  | MachineCommandRefusal;

/** Reads change nothing, so asking again is always safe. */
const READS: ReadonlySet<MachineOpName> = new Set(["machine.list", "machine.status", "machine.harnesses"]);

const refusal = (
  type: MachineCommandRefusal["type"],
  message: string,
  retryable: boolean,
): MachineCommandRefusal => ({ ok: false, type, message, retryable, transitions: [] });

/** The id a command and its progress steps share. */
export const newMachineCommandId = (): string => `window-${ulid()}`;

/** Send one owner machine command and read its answer. Never throws. */
export const machineCommand = async <Op extends MachineOpName>(
  op: Op,
  args: MachineArgsByOp[Op],
  id: string = newMachineCommandId(),
): Promise<MachineCommandAnswer<Op>> => {
  const send = getJuntoApi()?.machineCommand;
  if (!send) return refusal("unavailable", "Machines are not available in this Junto.", false);
  let raw: unknown;
  try {
    raw = await send({ protocol: OPERATOR_PROTOCOL_VERSION, id, op, args } as OperatorRequestEnvelope);
  } catch (cause) {
    return refusal("unavailable", cause instanceof Error ? cause.message : String(cause), READS.has(op));
  }
  const decoded = decodeOperatorResponse(raw);
  if (Result.isFailure(decoded)) {
    return refusal("protocol_error", "Junto answered in a form this window does not know.", READS.has(op));
  }
  const answer = decoded.success;
  if (!answer.ok) {
    return {
      ok: false,
      type: answer.error.type,
      message: answer.error.message,
      retryable: answer.error.details?.retryable ?? false,
      transitions: answer.error.details?.transitions ?? [],
    };
  }
  if (answer.id !== id || answer.op !== op) {
    return refusal("protocol_error", "Junto answered a different question.", READS.has(op));
  }
  return { ok: true, data: answer.data as MachineDataByOp[Op] };
};

/** Follow the steps of commands in flight. A step that does not decode is dropped. */
export const onMachineCommandProgress = (
  listener: (progress: MachineCommandProgress) => void,
): (() => void) => {
  const subscribe = getJuntoApi()?.onMachineProgress;
  if (!subscribe) return () => {};
  return subscribe((payload: unknown) => {
    const decoded = decodeMachineCommandProgress(payload);
    if (Result.isSuccess(decoded)) listener(decoded.success);
  });
};
