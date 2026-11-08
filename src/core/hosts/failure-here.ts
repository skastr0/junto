import type { EncodedFailure } from "@shared/failure";
import { defaultMachineName } from "@shared/machine-name";
import { encodeFailure } from "../../node/failure-encode";

/** A cause this machine wraps, encoded and scrubbed by the one encoder, as an optional `failure` field. */
export const failureHere = (cause: unknown, machine: string = defaultMachineName()): { readonly failure?: EncodedFailure } => {
  const failure = encodeFailure(cause, { machine });
  return failure === undefined ? {} : { failure };
};
