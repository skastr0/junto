import { Result } from "effect";
import { ulid } from "ulid";
import type { MachineArgsByOp, MachineDataByOp, MachineOpName } from "@shared/machine-control";
import type { MachineInstallError, MachineInstallResult, MachineInstallTransition } from "@shared/machine-install";
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

/** Where a failed install left a machine, as the owner said it. */
export type MachineInstallDisposition = MachineInstallError["disposition"];

/** A command the owner refused, or one the window could not ask. */
export type MachineCommandRefusal = {
  readonly ok: false;
  /** The owner's error type; `unavailable` when no answer came back. */
  readonly type: OperatorErrorType | "unavailable";
  /** The plain reason, as the owner said it. */
  readonly message: string;
  /** False once a command that changes a machine may have reached it. */
  readonly retryable: boolean;
  /**
   * The steps of an install the owner confirmed. A step that is not here is
   * not thereby a step that did not happen.
   */
  readonly transitions: ReadonlyArray<MachineInstallTransition>;
  /**
   * Where a failed install left the machine. Absent when the owner did not
   * say: then nothing is known about the machine, and nothing is assumed.
   */
  readonly disposition?: MachineInstallDisposition;
  /** The install that finished, when what failed came after it. */
  readonly installed?: MachineInstallResult;
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
  if (!answer.ok && answer.id === undefined && answer.op === undefined) {
    // Main refused before it read the command, so its answer names none. Its
    // reason is shown. Nothing else in it is taken as a fact about a machine.
    return refusal(answer.error.type, answer.error.message, READS.has(op));
  }
  // An answer is this command's only when it says so, whether it is data or a
  // refusal. Another command's answer gives this one nothing: not its data,
  // not its reason, not how far its install got.
  if (answer.id !== id || answer.op !== op) {
    return refusal("protocol_error", "Junto answered a different question.", READS.has(op));
  }
  if (!answer.ok) {
    const details = answer.error.details;
    return {
      ok: false,
      type: answer.error.type,
      message: answer.error.message,
      retryable: details?.retryable ?? false,
      transitions: details?.transitions ?? [],
      ...(details?.disposition === undefined ? {} : { disposition: details.disposition }),
      ...(details?.installed === undefined ? {} : { installed: details.installed }),
    };
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
