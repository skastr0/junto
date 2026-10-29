import { Effect, Option } from "effect";
import { ulid } from "ulid";
import type { Canvas } from "@shared/model";
import { rulingContextOf } from "@shared/ruling-context";
import { ItemId, OpId } from "@shared/work-ids";
import { asNodeId } from "@shared/physics/schema";
import type { WorkErrorBody } from "@shared/work-control";
import type { ArtifactPorts } from "../work/artifact-control";
import { ruleSignalReply, type SignalReply } from "@shared/signal-reply";
import type { SignalReplyRecord } from "./repository";
import {
  AGENT_SIGNAL_ACKNOWLEDGED_RESPONSE,
  AGENT_SIGNAL_MAX_RESPONSE_LENGTH,
  AGENT_SIGNAL_FILES_RESPONSE,
  AGENT_SIGNAL_TEXT_FILE_RESPONSE,
  composeSignalAnswerMail,
  type AgentSignal,
} from "@shared/agent-signals";
import { mailExtensionMetadata } from "@shared/crew";
import { makeUserMessage } from "@shared/task";
import type { ContentRef } from "@shared/wire/content-ref";
import { operatorActorRef } from "@shared/work-reference";
import { claimOperatorAttachments, operatorMailOwner } from "../content/operator-attachments";
import { ContentService } from "../content/service";
import { WorkService } from "../work/service";
import { writeMailCarryingText } from "../content/mail-text-file";
import { planAnswerCopies, sendAnswerCopies } from "./answer-mentions";
import { releaseSignalAttachments } from "./attachments";
import { AgentSignalRepository } from "./repository";

/**
 * Operator-side signal actions. Answering types the response into the seat as
 * operator prompt mail (the ordinary mailbox path) and only then records the
 * signal answered; a silent answer records the response without mail, so the
 * seat is never typed into or started and reads the answer later through
 * `signal list`; a silent answer with no text acknowledges, recorded as
 * AGENT_SIGNAL_ACKNOWLEDGED_RESPONSE; dismissing records it without mail or a
 * response. Files the operator attached are claimed for the answer and kept
 * on it by reference, and the mail carries them in `metadata.attachments`,
 * which delivery lists one line each with a path; with files the text may be
 * empty.
 */

export type SignalOperatorResult =
  | { readonly ok: true; readonly signal: AgentSignal; readonly messageId?: string }
  | { readonly ok: false; readonly message: string };

const refused = (message: string): SignalOperatorResult => ({ ok: false, message });

const repositoryMessage = (error: { readonly message: string }) => error.message;

export const answerAgentSignal = (
  signalId: string,
  response: string,
  options?: {
    readonly silent?: boolean;
    readonly attachments?: ReadonlyArray<ContentRef>;
    /** What a work form's reply left, recorded on the answer. */
    readonly reply?: SignalReplyRecord;
    /**
     * The words the seat's mail carries, when they say more than the recorded
     * answer does: proof's addresses ride with its words in the mail, and the
     * record keeps them structured instead of repeating them in its text.
     */
    readonly mailText?: string;
  },
) =>
  Effect.gen(function* () {
    const silent = options?.silent === true;
    const files = options?.attachments ?? [];
    const typed = response.trim();
    if (!typed && !silent && files.length === 0) return refused("an answer needs some text");
    if (typed.length > AGENT_SIGNAL_MAX_RESPONSE_LENGTH) {
      return refused(`an answer is at most ${AGENT_SIGNAL_MAX_RESPONSE_LENGTH} characters`);
    }
    const signals = yield* AgentSignalRepository;
    const current = yield* Effect.result(signals.get(signalId));
    if (current._tag === "Failure") return refused(repositoryMessage(current.failure));
    const signal = current.success;
    if (signal.state !== "open") return refused(`this signal is already ${signal.state}`);
    // Seats the answer copies, judged before anything is written. A quiet answer mails no one.
    const copies = silent ? { ok: true as const, seats: [], seatName: undefined } : yield* planAnswerCopies(signal, typed);
    if (!copies.ok) return refused(copies.message);

    // The mail's id names where its files are held, mailed or not.
    const id = ulid();
    const owner = operatorMailOwner(signal.canvasName, signal.nodeId, id);
    const content = yield* Effect.serviceOption(ContentService);
    // Every file the mail holds goes with it: those claimed, and its own text's if it went as one.
    const releaseFiles: Effect.Effect<void> = Option.isNone(content) ? Effect.void : content.value.releaseOwner(owner).pipe(Effect.ignore);
    let refs: ReadonlyArray<ContentRef> = [];
    if (files.length > 0) {
      if (Option.isNone(content)) return refused("files cannot be attached: the content store is unavailable");
      const claimed = yield* Effect.result(claimOperatorAttachments(content.value, signal.canvasName, files, owner));
      if (claimed._tag === "Failure") return refused(claimed.failure.message);
      refs = claimed.success;
    }
    const text = typed || (refs.length > 0 ? AGENT_SIGNAL_FILES_RESPONSE : AGENT_SIGNAL_ACKNOWLEDGED_RESPONSE);
    const mailed = options?.mailText ?? text;

    let messageId: string | undefined;
    if (!silent) {
      const sender = operatorActorRef(signal.canvasName);
      const work = yield* WorkService;
      const write = (said: string, held: ReadonlyArray<ContentRef>) => work.workSystemMailboxNotify(
        signal.canvasName,
        signal.nodeId,
        makeUserMessage({
          messageId: id,
          text: composeSignalAnswerMail(signal, said),
          contextId: signal.canvasName,
          metadata: {
            factoryMail: true,
            agentSignalId: signal.signalId,
            // As thread mail carries them: delivery lists each file with its
            // path, and a thread reads them back from here.
            ...(held.length > 0 ? { attachments: held } : {}),
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
      // A row main will not write goes again with the answer's words as a file.
      const carried = yield* writeMailCarryingText(write, { text: mailed, attachments: refs, owner, filesText: AGENT_SIGNAL_TEXT_FILE_RESPONSE });
      const appended = carried.written;
      refs = carried.attachments;
      if (!appended.ok) {
        yield* releaseFiles;
        return refused(appended.message);
      }
      messageId = appended.data.messageId;
    }

    const answered = yield* Effect.result(signals.answer(signalId, text, refs, options?.reply));
    if (answered._tag === "Failure") {
      // Mailed, the files stay with the mail; recorded only, they go with the answer.
      if (messageId === undefined) yield* releaseFiles;
      return refused(repositoryMessage(answered.failure));
    }
    yield* releaseSignalAttachments(answered.success);
    // Copies go only once the answer stands: a refused answer told no one.
    if (messageId !== undefined) yield* sendAnswerCopies(signal, copies.seatName ?? signal.nodeId, mailed, messageId, copies.seats);
    return {
      ok: true as const,
      signal: answered.success,
      ...(messageId === undefined ? {} : { messageId }),
    };
  });

/**
 * The operator hands in the work a signal asks for (0.11/07, N1): a document
 * written in the signal, or proof. The form's condition is ruled first, by
 * the same rule the pane fills its meter from, so nothing is written for a
 * reply that does not meet it. A document is created in the form's Artifacts
 * node as the operator, under the window's reply id, so a hand-in sent twice
 * writes one document; proof keeps its words, its addresses and its files on
 * the answer.
 */
/**
 * What the seat reads of a proof: its words, then its addresses, one a line,
 * so the mail carries what the record keeps. A proof whose addresses would
 * push the answer past its bound is sent with its words alone; the addresses
 * stay on the answer for the card to list.
 */
const proofSaid = (text: string, links: ReadonlyArray<string>): string => {
  if (links.length === 0) return text;
  const said = `${text}\n\n${links.join("\n")}`;
  return said.length > AGENT_SIGNAL_MAX_RESPONSE_LENGTH ? text : said;
};

export type SignalReplyPorts = {
  readonly topology: (canvasName: string) => Effect.Effect<Canvas, WorkErrorBody>;
  readonly artifacts: Pick<ArtifactPorts, "submit">;
};

export const replyAgentSignal = (signalId: string, reply: SignalReply, ports: SignalReplyPorts) =>
  Effect.gen(function* () {
    const signals = yield* AgentSignalRepository;
    const current = yield* Effect.result(signals.get(signalId));
    if (current._tag === "Failure") return refused(repositoryMessage(current.failure));
    const signal = current.success;
    if (signal.state !== "open") return refused(`this signal is already ${signal.state}`);
    const form = signal.form;
    if (form === undefined) return refused("this signal asks for no work: answer it instead of handing work in");
    const ruled = ruleSignalReply(form, reply);
    if (!ruled.ok) return refused(ruled.message);

    if (form.kind === "artifact") {
      if (reply.kind !== "artifact") return refused("this signal asks for a document; write it in the signal");
      const canvas = yield* Effect.result(ports.topology(signal.canvasName));
      if (canvas._tag === "Failure") return refused(canvas.failure.message);
      const shelf = canvas.success.nodes.get(asNodeId(form.nodeId));
      if (shelf === undefined || shelf.kind !== "artifacts") {
        return refused(`the Artifacts node this signal writes into is gone from ${signal.canvasName}`);
      }
      const artifactId = ItemId.make(ulid());
      const written = yield* Effect.result(
        ports.artifacts.submit(
          {
            opId: OpId.make(reply.replyId),
            canvasName: signal.canvasName,
            actor: { kind: "operator" },
            target: { kind: "artifact", nodeId: asNodeId(form.nodeId), itemId: artifactId },
            basis: null,
            after: [],
            op: {
              op: "create",
              title: form.title,
              body: { type: "document", markdown: reply.markdown },
              ...(form.labels.length === 0 ? {} : { labels: [...form.labels] }),
            },
          },
          rulingContextOf(canvas.success, () => undefined),
        ),
      );
      if (written._tag === "Failure") return refused(written.failure.message);
      if (written.success.kind === "refused") return refused(written.success.error.message);
      const record: SignalReplyRecord = { kind: "artifact", nodeId: form.nodeId, artifactId, title: form.title, words: ruled.words };
      return yield* answerAgentSignal(signalId, `${form.title} is written, ${ruled.words} ${ruled.words === 1 ? "word" : "words"}.`, { reply: record });
    }

    if (form.kind === "proof") {
      if (reply.kind !== "proof") return refused("this signal asks for proof: its words with links or files");
      const record: SignalReplyRecord = { kind: "links", links: [...reply.links] };
      return yield* answerAgentSignal(signalId, reply.text, {
        attachments: (reply.files ?? []) as ReadonlyArray<ContentRef>,
        reply: record,
        ...(reply.links.length === 0 ? {} : { mailText: proofSaid(reply.text, reply.links) }),
      });
    }
    return refused("this signal asks for a reply, not a document or proof: answer it in words");
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
