import { Effect } from "effect";
import { coreOps, type CoreOp } from "../ops";

/**
 * The desktop's operator socket listens on demand: main asks the core to open
 * it when a phone pairs. The core process binds the opener once it booted.
 */

declare module "../ops" {
  interface CoreOps {
    "operator.ensureListening": CoreOp<Record<string, never>, void>;
  }
}

let opener: (() => Promise<void>) | undefined;

/** Core boot only: how this core opens its operator socket. */
export const bindOperatorListening = (open: () => Promise<void>): void => {
  opener = open;
};

coreOps({
  "operator.ensureListening": () =>
    Effect.tryPromise(() => (opener === undefined ? Promise.reject(new Error("the operator socket has no opener in this core")) : opener())),
});
