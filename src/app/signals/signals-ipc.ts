/**
 * Main's handlers of the window's signals group
 * (src/contract/window/signals.ts): the operator reads every seat's claim on
 * a canvas, answers one (typed into the seat as operator mail, then marked
 * answered), hands in what its form asks for, sets the value a secret form
 * asks for, or dismisses it. Each asks the core's signals group
 * (src/contract/core/signals.ts) as it is; each write runs under main's
 * authoring gate. What the window sends is decoded closed by the group's own
 * schemas, here and at the core. Each change the core pushes reaches the
 * window on `SignalsChanged`.
 */
import { Effect } from "effect";
import type { SignalSecretPutResult } from "@shared/vault";
import { AGENT_SIGNAL_CHANGED } from "../../contract/core/channels";
import { SignalsCore } from "../../contract/core/signals";
import { SignalsWindowRpcs } from "../../contract/window/signals";
import { authored, fromCore, pushes } from "../window/ipc";

/** A secret's refusal never carries a thrown message: it can hold anything the failure saw. One sentence, no value. */
const NOT_SET: SignalSecretPutResult = { ok: false, reason: "store-failed", message: "The secret was not set." };

export const SignalsWindowHandlers = SignalsWindowRpcs.toLayer(
  Effect.gen(function* () {
    const signals = yield* SignalsCore;
    return {
      SignalsList: (payload) => fromCore(signals.SignalsList(payload)),
      // The answer's mail is typed into the seat in the core, where delivery is configured.
      SignalsAnswer: (payload) => authored("ipc.work.signal-answer", fromCore(signals.SignalsAnswer(payload))),
      SignalsReply: (payload) => authored("ipc.work.signal-reply", fromCore(signals.SignalsReply(payload))),
      // The value a secret form asks for (0.12, N5): the core reads the region, the
      // machine and the name from the form the raise stored, writes through the
      // vault's own port, and keeps nothing but names. The value is never echoed,
      // logged or answered with.
      SignalsSecretPut: (payload) =>
        authored("ipc.work.signal-secret-put", fromCore(signals.SignalsSecretPut(payload))).pipe(
          Effect.catchCause(() => Effect.succeed(NOT_SET)),
        ),
      SignalsDismiss: (payload) => authored("ipc.work.signal-dismiss", fromCore(signals.SignalsDismiss(payload))),
      SignalsChanged: () => pushes(AGENT_SIGNAL_CHANGED),
    };
  }),
);
