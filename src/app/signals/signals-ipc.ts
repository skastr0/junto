/**
 * Agent signals over IPC: the operator reads every seat's claim on a canvas,
 * answers one (typed into the seat as operator mail, then marked answered),
 * hands in what its form asks for, sets the value a secret form asks for, or
 * dismisses it. Each asks the core's signals group
 * (src/contract/core/signals.ts). The renderer's arguments are decoded here,
 * at main's edge, closed. The window hears of every change through the
 * store's own push (main/index.ts), so this path only answers the caller,
 * and a failure is answered as a refusal the pane shows.
 */
import type { IpcMain } from "electron";
import { Context, Effect, Result, Schema } from "effect";
import { IPC_CHANNELS, type AgentSignalAnswerOptions } from "@shared/ipc";
import { OperatorAttachments } from "@shared/operator-attachments";
import { SignalReply } from "@shared/signal-reply";
import { SignalSecretPutRequest, type SignalSecretPutResult } from "@shared/vault";
import { SignalsCore, type AgentSignalOperatorResult } from "../../contract/core/signals";
import { AppRuntime } from "../runtime";

/** Main's authoring gate around one write, under the label junto/ipc.ts names for it. */
type Authoring = <A>(operation: () => Promise<A>) => Promise<A>;

/** The writes and the gate each one is admitted through. */
export type SignalAuthoring = {
  readonly answer: Authoring;
  readonly reply: Authoring;
  readonly secretPut: Authoring;
  readonly dismiss: Authoring;
};

const closed = { onExcessProperty: "error" } as const;

export const registerSignalsIpc = (
  ipc: Pick<IpcMain, "handle">,
  core: Context.Context<SignalsCore>,
  authoring: SignalAuthoring,
): void => {
  const signals = Context.get(core, SignalsCore);

  const operator = (
    gate: Authoring,
    call: Effect.Effect<AgentSignalOperatorResult, unknown>,
  ): Promise<AgentSignalOperatorResult> =>
    gate(() => AppRuntime.runPromise(call)).catch((error: unknown) => ({
      ok: false as const,
      message: error instanceof Error ? error.message : "signal update failed",
    }));

  ipc.handle(IPC_CHANNELS.agentSignalsList, (_event, raw: unknown) =>
    AppRuntime.runPromise(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)(raw, closed), (canvasName) => signals.SignalsList({ canvasName })),
    ),
  );

  ipc.handle(
    IPC_CHANNELS.agentSignalRespond,
    (_event, signalId: unknown, text: unknown, options?: AgentSignalAnswerOptions): Promise<AgentSignalOperatorResult> => {
      const files = Schema.decodeUnknownResult(OperatorAttachments)(options?.attachments ?? [], closed);
      if (Result.isFailure(files)) return Promise.resolve({ ok: false as const, message: "The attached files could not be read." });
      // The answer's mail is typed into the seat in the core, where delivery
      // is configured; main only relays the answer.
      return operator(
        authoring.answer,
        signals.SignalsAnswer({
          signalId: String(signalId),
          text: String(text),
          silent: options?.silent === true,
          attachments: files.success,
        }),
      );
    },
  );

  ipc.handle(IPC_CHANNELS.agentSignalReply, (_event, signalId: unknown, raw: unknown): Promise<AgentSignalOperatorResult> => {
    const reply = Schema.decodeUnknownResult(SignalReply)(raw, closed);
    if (Result.isFailure(reply)) return Promise.resolve({ ok: false as const, message: "The reply could not be read." });
    return operator(authoring.reply, signals.SignalsReply({ signalId: String(signalId), reply: reply.success }));
  });

  // The value a secret form asks for (0.12, N5): the window sends the signal
  // and the value only; the core reads the region, the machine and the name
  // from the form the raise stored, writes through the vault's own port, and
  // keeps nothing but names. The value is never echoed, logged or answered with.
  ipc.handle(IPC_CHANNELS.signalSecretPut, (_event, raw: unknown): Promise<SignalSecretPutResult> => {
    const request = Schema.decodeUnknownResult(SignalSecretPutRequest)(raw, closed);
    if (Result.isFailure(request)) {
      return Promise.resolve({ ok: false as const, reason: "store-failed" as const, message: "The secret could not be read." });
    }
    return authoring
      .secretPut(() => AppRuntime.runPromise(signals.SignalsSecretPut({ request: request.success })))
      // Never its text: a thrown message can hold anything the failure saw, and the
      // pane shows a refusal as a sentence. One sentence, no value, no detail.
      .catch((): SignalSecretPutResult => ({ ok: false, reason: "store-failed", message: "The secret was not set." }));
  });

  ipc.handle(IPC_CHANNELS.agentSignalDismiss, (_event, signalId: unknown): Promise<AgentSignalOperatorResult> =>
    operator(authoring.dismiss, signals.SignalsDismiss({ signalId: String(signalId) })),
  );
};
