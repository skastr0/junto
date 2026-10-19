import { Effect } from "effect";
import { ulid } from "ulid";
import {
  AGENT_SIGNAL_ACKNOWLEDGED_RESPONSE,
  AGENT_SIGNAL_MAX_RESPONSE_LENGTH,
  composeSignalAnswerMail,
  type AgentSignal,
} from "@shared/agent-signals";
import { mailExtensionMetadata } from "@shared/crew";
import { makeUserMessage } from "@shared/task";
import { operatorActorRef } from "@shared/work-reference";
import { WorkService } from "../work/service";
import { releaseSignalAttachments } from "./attachments";
import { AgentSignalRepository } from "./repository";

/**
 * Operator-side signal actions. Answering types the response into the seat as
 * operator prompt mail (the ordinary mailbox path) and only then records the
 * signal answered; a silent answer records the response without mail, so the
 * seat is never typed into or started and reads the answer later through
 * `signal list`; a silent answer with no text acknowledges, recorded as
 * AGENT_SIGNAL_ACKNOWLEDGED_RESPONSE; dismissing records it without mail or a
 * response.
 */

export type SignalOperatorResult =
  | { readonly ok: true; readonly signal: AgentSignal; readonly messageId?: string }
  | { readonly ok: false; readonly message: string };

const refused = (message: string): SignalOperatorResult => ({ ok: false, message });

const repositoryMessage = (error: { readonly message: string }) => error.message;

export const answerAgentSignal = (
  signalId: string,
  response: string,
  options?: { readonly silent?: boolean },
) =>
  Effect.gen(function* () {
    const silent = options?.silent === true;
    const typed = response.trim();
    if (!typed && !silent) return refused("an answer needs some text");
    const text = typed || AGENT_SIGNAL_ACKNOWLEDGED_RESPONSE;
    if (text.length > AGENT_SIGNAL_MAX_RESPONSE_LENGTH) {
      return refused(`an answer is at most ${AGENT_SIGNAL_MAX_RESPONSE_LENGTH} characters`);
    }
    const signals = yield* AgentSignalRepository;
    const current = yield* Effect.result(signals.get(signalId));
    if (current._tag === "Failure") return refused(repositoryMessage(current.failure));
    const signal = current.success;
    if (signal.state !== "open") return refused(`this signal is already ${signal.state}`);

    let messageId: string | undefined;
    if (!silent) {
      const sender = operatorActorRef(signal.canvasName);
      const id = ulid();
      const work = yield* WorkService;
      const appended = yield* work.workSystemMailboxNotify(
        signal.canvasName,
        signal.nodeId,
        makeUserMessage({
          messageId: id,
          text: composeSignalAnswerMail(signal, text),
          contextId: signal.canvasName,
          metadata: {
            factoryMail: true,
            agentSignalId: signal.signalId,
            ...mailExtensionMetadata({
              mailKind: "prompt",
              fromSeat: sender.seatId,
              senderNodeId: sender.nodeId,
              senderName: "operator",
              senderGeneration: "operator",
              senderHarness: "unknown",
            }),
          },
        }),
      );
      if (!appended.ok) return refused(appended.message);
      messageId = appended.data.messageId;
    }

    const answered = yield* Effect.result(signals.answer(signalId, text));
    if (answered._tag === "Failure") return refused(repositoryMessage(answered.failure));
    yield* releaseSignalAttachments(answered.success);
    return {
      ok: true as const,
      signal: answered.success,
      ...(messageId === undefined ? {} : { messageId }),
    };
  });

export const dismissAgentSignal = (signalId: string) =>
  Effect.gen(function* () {
    const signals = yield* AgentSignalRepository;
    const dismissed = yield* Effect.result(signals.dismiss(signalId));
    if (dismissed._tag === "Failure") return refused(repositoryMessage(dismissed.failure));
    yield* releaseSignalAttachments(dismissed.success);
    return { ok: true as const, signal: dismissed.success };
  });

export const listCanvasAgentSignals = (canvasName: string) =>
  Effect.flatMap(AgentSignalRepository, (signals) => signals.listCanvas(canvasName));
