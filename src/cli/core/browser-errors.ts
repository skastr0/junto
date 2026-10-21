import type { ControlError, ControlErrorTag } from "../../shared/browser-control";
import type { WorkErrorBody, WorkErrorType } from "../../shared/work-control";
import { WireError } from "./errors";

interface Mapped {
  readonly type: WorkErrorType;
  readonly retryable: boolean;
  readonly next_step?: string;
}

/**
 * Every control-plane tag as a work error. The record is total over
 * ControlErrorTag, so a new tag fails tsc until it is mapped here.
 */
const BY_TAG = {
  unauthorized: { type: "AuthError", retryable: false, next_step: "run junto browser from a seat with a navigates edge to the page" },
  forbidden: { type: "AuthError", retryable: false },
  bad_request: { type: "InputError", retryable: false, next_step: "junto schema show <browser command> lists the fields" },
  invalid: { type: "InputError", retryable: false },
  not_found: { type: "UnknownTarget", retryable: false, next_step: "junto browser pages and junto browser sessions list what exists" },
  timeout: { type: "Timeout", retryable: true },
  cancelled: { type: "Timeout", retryable: true },
  resource_exhausted: { type: "InternalError", retryable: true, next_step: "retry after a moment, or stop a session you no longer need" },
  unsupported_capability: { type: "InputError", retryable: false },
  unsupported_result: { type: "InputError", retryable: false, next_step: "return a plain JSON value from the page" },
  result_too_large: { type: "InputError", retryable: false },
  failed: { type: "InternalError", retryable: false },
  runtime_down: { type: "RuntimeDown", retryable: true, next_step: "start the Junto app on this machine" },
} as const satisfies Record<ControlErrorTag, Mapped>;

/** The work error body for a control error; `reason` keeps the control tag. */
export const browserErrorBody = (error: ControlError): WorkErrorBody => {
  const mapped: Mapped = BY_TAG[error._tag];
  return {
    type: mapped.type,
    message: error.message,
    details: {
      reason: error._tag,
      retryable: mapped.retryable,
      ...(mapped.next_step === undefined ? {} : { next_step: mapped.next_step }),
    },
  };
};

export const browserWireError = (error: ControlError): WireError => {
  const body = browserErrorBody(error);
  return new WireError({ type: body.type, message: body.message, details: body.details });
};
