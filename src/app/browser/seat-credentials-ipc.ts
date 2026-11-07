/**
 * Main's side of the seat credentials the browser door admits on: the core's
 * registry, read through its group (src/contract/core/seat-credentials.ts),
 * and its changes, heard on the push bus. Main holds no copy, so a suspension
 * or a revocation is never a stale yes here.
 */
import { Context } from "effect";
import { SeatCredentialsCore } from "../../contract/core/seat-credentials";
import { SEAT_CREDENTIAL_CHANGED } from "../../contract/core/channels";
import { CorePushesMain } from "../core-process/main-side/core-pushes";
import { AppRuntime } from "../runtime";
import type { SeatCredentialPort } from "./edge-grant";

export const coreSeatCredentials = (core: Context.Context<SeatCredentialsCore | CorePushesMain>): SeatCredentialPort => {
  const credentials = Context.get(core, SeatCredentialsCore);
  const pushes = Context.get(core, CorePushesMain);
  return {
    lookup: (credential) => AppRuntime.runPromise(credentials.SeatCredentialsLookup({ credential })),
    onEvent: (listener) => pushes.subscribe(SEAT_CREDENTIAL_CHANGED, listener),
  };
};
