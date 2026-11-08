/**
 * The work socket's overseer and overseer.live ops, as one Effect `RpcGroup`. Owned by cli-overseer.
 *
 * `overseer` carries one closed administrative command: the envelope is its
 * payload, and the command's own outcome (`OverseerResult`, `ok: false`
 * included) is its answer. `overseer.live` is the native Overseer's private
 * controller protocol. The work server admits both before they reach this
 * group (an overseer seat, the request's byte limit, the native seat), so
 * nothing here grants authority; the closed command set and its rules are
 * `src/shared/overseer-control.ts`'s.
 */
import { Rpc, RpcGroup } from "effect/rpc";
import { OverseerRequest, OverseerResult } from "../../shared/overseer-control";
import { OverseerHostAssignment, OverseerHostRequest } from "../../shared/overseer-host-control";
import { WorkFailure, WorkInputRefusal } from "./failure";

export const Overseer = Rpc.make("overseer", { payload: OverseerRequest, success: OverseerResult, error: WorkFailure })
  // v1 refused an envelope in the schema's words, with no path or hint.
  .annotate(WorkInputRefusal, (message) => ({ type: "InputError", message, details: { retryable: false } }));
export const OverseerLive = Rpc.make("overseer.live", {
  payload: OverseerHostRequest,
  success: OverseerHostAssignment,
  error: WorkFailure,
})
  // v1 refused a controller request in the schema's words, with no details.
  .annotate(WorkInputRefusal, (message) => ({ type: "InputError", message }));

/** Decoded strictly where the core serves it: an argument or an answer field the contract does not name is refused. */
export const OverseerRpcs = RpcGroup.make(Overseer, OverseerLive).annotateRpcs(Rpc.ParseOptions, { onExcessProperty: "error" });
