import { Effect } from "effect";
import { ulid } from "ulid";
import {
  AGENT_SIGNAL_MAX_RESPONSE_LENGTH,
  composeSignalAnswerMail,
  type AgentSignal,
} from "@shared/agent-signals";
import { mailExtensionMetadata } from "@shared/crew";
import { makeUserMessage } from "@shared/task";
import { operatorActorRef } from "@shared/work-reference";
import { WorkService } from "../work/service";
import { AgentSignalRepository } from "./repository";

/**
 * Operator-side signal actions. Answering types the response into the seat as
 * operator prompt mail (the ordinary mailbox path) and only then records the
 * signal answered; dismissing records it without mail.
 */

export type SignalOperatorResult =
  | { readonly ok: true; readonly signal: AgentSignal; readonly messageId?: string }
  | { readonly ok: false; readonly message: string };

const refused = (message: string): SignalOperatorResult => ({ ok: false, message });

const repositoryMessage = (error: { readonly message: string }) => error.message;

export const answerAgentSignal = (signalId: string, response: string) =>
  Effect.gen(function* () {
    const text = response.trim();
    if (!text) return refused("an answer needs some text");
    if (text.length > AGENT_SIGNAL_MAX_RESPONSE_LENGTH) {
      return refused(`an answer is at most ${AGENT_SIGNAL_MAX_RESPONSE_LENGTH} characters`);
    }
    const signals = yield* AgentSignalRepository;
    const current = yield* Effect.result(signals.get(signalId));
    if (current._tag === "Failure") return refused(repositoryMessage(current.failure));
    const signal = current.success;
    if (signal.state !== "open") return refused(`this signal is already ${signal.state}`);

    const sender = operatorActorRef(signal.canvasName);
    const messageId = ulid();
    const work = yield* WorkService;
    const appended = yield* work.workSystemMailboxNotify(
      signal.canvasName,
      signal.nodeId,
      makeUserMessage({
        messageId,
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

    const answered = yield* Effect.result(signals.answer(signalId, text));
    if (answered._tag === "Failure") return refused(repositoryMessage(answered.failure));
    return {
      ok: true as const,
      signal: answered.success,
      messageId: appended.data.messageId,
    };
  });

export const dismissAgentSignal = (signalId: string) =>
  Effect.gen(function* () {
    const signals = yield* AgentSignalRepository;
    const dismissed = yield* Effect.result(signals.dismiss(signalId));
    if (dismissed._tag === "Failure") return refused(repositoryMessage(dismissed.failure));
    return { ok: true as const, signal: dismissed.success };
  });

export const listCanvasAgentSignals = (canvasName: string) =>
  Effect.flatMap(AgentSignalRepository, (signals) => signals.listCanvas(canvasName));
