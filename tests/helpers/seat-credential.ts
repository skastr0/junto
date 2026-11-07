import type { ProcessPrincipal } from "../../src/core/process-identity";
import {
  mintSeatCredential,
  type SeatCredentialRegistry,
} from "../../src/core/work/seat-credentials";

/** Publish one fresh generation credential and return the value callers present. */
export const publishSeatCredential = (
  registry: SeatCredentialRegistry,
  principal: ProcessPrincipal,
): string => {
  const mint = mintSeatCredential();
  if (!registry.publish(mint, principal)) {
    throw new Error("test credential publish failed");
  }
  return mint.credential;
};
