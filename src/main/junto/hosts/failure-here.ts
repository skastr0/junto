import type { EncodedFailure } from "@shared/failure";
import { encodeFailure } from "../failure-encode";
import { logMachine } from "../observability/logger";

/** A cause this machine wraps, encoded and scrubbed by the one encoder, as an optional `failure` field. */
export const failureHere = (cause: unknown): { readonly failure?: EncodedFailure } => {
  const failure = encodeFailure(cause, { machine: logMachine() });
  return failure === undefined ? {} : { failure };
};
