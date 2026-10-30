/**
 * The operator's signals (junto/ipc.ts): a canvas's signals, an answer typed
 * into its seat, a handed-in reply, a dismissal, and the value a secret form
 * asks for. Each answer is plain data; the window hears of a change through
 * the store's own change, pushed from one place, so these only answer the
 * caller.
 *
 * `op` and the login shell are main's, so the secret write asks main for the
 * two it cannot do here (a tool run and the login PATH); the value never
 * crosses that call, only the tool call does.
 */
import { Effect } from "effect";
import { homedir } from "node:os";
import type { AgentSignal } from "@shared/agent-signals";
import { resolveJuntoHome } from "@shared/junto-home";
import type { ContentRef } from "@shared/wire/content-ref";
import type { SignalReply } from "@shared/signal-reply";
import type { SignalSecretPutRequest, SignalSecretPutResult } from "@shared/vault";
import { AgentSignalRepository } from "../../junto/signals/repository";
import {
  answerAgentSignal,
  dismissAgentSignal,
  listCanvasAgentSignals,
  replyAgentSignal,
  type SignalOperatorResult,
} from "../../junto/signals/operator";
import type { ToolCall, ToolResult } from "../../junto/region-env/tool";
import { putSignalSecret } from "../../junto/vault/secret-put";
import { liveArtifactPorts } from "../../junto/work/artifact-control";
import { WorkService } from "../../junto/work/service";
import { host, hostOps, type HostOp } from "../host-ops";
import { coreOps, type CoreOp } from "../ops";

declare module "../ops" {
  interface CoreOps {
    "ipc.signals.list": CoreOp<{ readonly canvasName: string }, ReadonlyArray<AgentSignal>>;
    "ipc.signals.answer": CoreOp<
      {
        readonly signalId: string;
        readonly text: string;
        readonly silent: boolean;
        readonly attachments: ReadonlyArray<ContentRef>;
      },
      SignalOperatorResult
    >;
    "ipc.signals.reply": CoreOp<
      { readonly signalId: string; readonly reply: SignalReply },
      SignalOperatorResult
    >;
    "ipc.signals.dismiss": CoreOp<{ readonly signalId: string }, SignalOperatorResult>;
    "ipc.signals.secretPut": CoreOp<
      { readonly request: SignalSecretPutRequest },
      SignalSecretPutResult
    >;
  }
}

declare module "../host-ops" {
  interface HostOps {
    /** One tool run, as main's own process plane makes it. */
    "signals.tool.run": HostOp<{ readonly call: ToolCall }, ToolResult>;
    /** The login shell's PATH, as main resolves it. */
    "signals.tool.path": HostOp<Record<string, never>, string | undefined>;
  }
}

let serving: (() => void) | undefined;
export const serveSignalTools = (ports: {
  readonly run: (call: ToolCall) => Promise<ToolResult>;
  readonly path: () => Promise<string | undefined>;
}): (() => void) =>
  (serving ??= hostOps({
    "signals.tool.run": ({ call }) => ports.run(call),
    "signals.tool.path": () => ports.path(),
  }));

coreOps({
  "ipc.signals.list": ({ canvasName }) => listCanvasAgentSignals(canvasName),
  "ipc.signals.answer": ({ signalId, text, silent, attachments }) =>
    answerAgentSignal(signalId, text, { silent, attachments }),
  "ipc.signals.reply": ({ signalId, reply }) =>
    Effect.flatMap(WorkService, (work) =>
      replyAgentSignal(signalId, reply, {
        topology: (canvasName) =>
          work.readTopology(canvasName).pipe(
            Effect.map((read) => read.canvas),
            Effect.mapError(() => ({
              type: "InternalError" as const,
              message: `canvas ${canvasName} could not be read`,
              details: { retryable: true },
            })),
          ),
        artifacts: liveArtifactPorts,
      }),
    ),
  "ipc.signals.dismiss": ({ signalId }) => dismissAgentSignal(signalId),
  "ipc.signals.secretPut": ({ request }) =>
    putSignalSecret(request, {
      home: resolveJuntoHome(),
      userHome: homedir(),
      run: (call) => host.call("signals.tool.run", { call }),
      path: () => host.call("signals.tool.path", {}),
    }),
});
