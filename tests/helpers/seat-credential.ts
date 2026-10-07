import type { ProcessPrincipal } from "../../src/main/junto/process-identity";
import {
  mintSeatCredential,
  type SeatCredentialRegistry,
} from "../../src/main/junto/work/seat-credentials";

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
