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
import { perfStage } from "@shared/perf-stages";
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
 *
 * A signal is answered in its thread. One raised in a thread is answered as
 * the operator's next mail there, in reply to the seat's mail that is the
 * signal; one with no thread starts one, and the signal records that thread
 * as its head. A reply the operator types in a thread answers every open
 * signal there that asks only for words (answerThreadSignals); one that asks
 * for work (a document, proof, a secret) stays open until the work is in.
 * Either way the answer is written here, by answerOpenSignals.
 *
 * An automation's signal has no seat to mail: its answer is recorded as a
 * silent one is, and the automation's machine hears the answered row through
 * the store's own change, to fire its answered watches and deliver the answer
 * where the step says (0.11/09). Its mentions copy no seat, since there is no
 * signalling seat for a copy to come from.
 */

export type SignalOperatorResult =
  | { readonly ok: true; readonly signal: AgentSignal; readonly messageId?: string }
  | {
      readonly ok: false;
      readonly message: string;
      /** In a thread: the mail written before its signal could not be recorded, which stands and is delivered. */
      readonly messageId?: string;
    };

const refused = (message: string): SignalOperatorResult => ({ ok: false, message });

const repositoryMessage = (error: { readonly message: string }) => error.message;

/** The answer's mail: each signal it answers named, the one it names first, then the words once. */
const composeAnswerMail = (signals: ReadonlyArray<AgentSignal>, said: string): string =>
  signals.length === 1
    ? composeSignalAnswerMail(signals[0]!, said)
    : [...signals.map((one) => composeSignalAnswerMail(one, "").trimEnd()), "", said.trim()].join("\n");

type AnswerOptions = {
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
};

/** Typed in a thread: the mail it replies to, and no copies, as the thread input promises. */
type InThread = {
  readonly inReplyTo?: string;
};

/**
 * A signal that asks only for words: no form, or a text form. An answer in
 * its thread closes it. One that asks for work (a document, proof, a secret)
 * waits for the work to be handed in.
 */
export const asksOnlyForWords = (signal: Pick<AgentSignal, "form">): boolean =>
  signal.form === undefined || signal.form.kind === "text";

/**
 * Answer open signals of one seat with one mail. The first is the one the
 * mail names (`agentSignalId`) and the thread it goes in: its thread, in
 * reply to the seat's mail that is the signal, or a new thread it heads.
 * Every one is recorded answered with the same words. Each must be open.
 */
const answerOpenSignals = (
  signals: readonly [AgentSignal, ...ReadonlyArray<AgentSignal>],
  response: string,
  options: AnswerOptions = {},
  inThread?: InThread,
) =>
  Effect.gen(function* () {
    const [signal] = signals;
    const silent = options.silent === true;
    const files = options.attachments ?? [];
    const typed = response.trim();
    if (!typed && !silent && files.length === 0) return refused("an answer needs some text");
    if (typed.length > AGENT_SIGNAL_MAX_RESPONSE_LENGTH) {
      return refused(`an answer is at most ${AGENT_SIGNAL_MAX_RESPONSE_LENGTH} characters`);
    }
    const repository = yield* AgentSignalRepository;
    // Who hears it: the seat the signal belongs to. A quiet answer mails no
    // one, and an automation's signal has no seat to mail at all.
    const mails = !silent && signal.source?.kind !== "automation";
    // Seats the answer copies, judged before anything is written. A quiet
    // answer mails no one; typed in a thread, a mention copies no one.
    const copies = mails && inThread === undefined
      ? yield* planAnswerCopies(signal, typed)
      : { ok: true as const, seats: [], seatName: undefined };
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
    const mailed = options.mailText ?? text;
    // The thread it goes in: the signal's own, in reply to what the operator
    // answered there, else to the seat's mail that is the signal.
    const thread = signal.threadId;
    const inReplyTo = inThread?.inReplyTo ?? signal.messageId;

    let messageId: string | undefined;
    if (mails) {
      const sender = operatorActorRef(signal.canvasName);
      const work = yield* WorkService;
      const write = (said: string, held: ReadonlyArray<ContentRef>) => work.workSystemMailboxNotify(
        signal.canvasName,
        signal.nodeId,
        makeUserMessage({
          messageId: id,
          text: composeAnswerMail(signals, said),
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
            // In its thread; with none, this mail is the root and its id the thread.
            ...(thread === undefined ? {} : { threadId: thread }),
            ...(thread === undefined || inReplyTo === undefined ? {} : { inReplyTo }),
          },
        }),
      );
      // A row main will not write goes again with the answer's words as a file.
      perfStage("core", "core-step-start", { op: "SignalWriteRow" });
      const carried = yield* writeMailCarryingText(write, { text: mailed, attachments: refs, owner, filesText: AGENT_SIGNAL_TEXT_FILE_RESPONSE });
      perfStage("core", "core-step-end", { op: "SignalWriteRow" });
      const appended = carried.written;
      refs = carried.attachments;
      if (!appended.ok) {
        yield* releaseFiles;
        return refused(appended.message);
      }
      messageId = appended.data.messageId;
    }

    perfStage("core", "core-step-start", { op: "SignalRecordAnswer" });
    const answered = yield* Effect.result(repository.answer(signal.signalId, text, refs, options.reply));
    perfStage("core", "core-step-end", { op: "SignalRecordAnswer" });
    if (answered._tag === "Failure") {
      // Mailed, the files stay with the mail; recorded only, they go with the answer.
      if (messageId === undefined) yield* releaseFiles;
      // In a thread the mail stands: the seat closed its signal meanwhile, and
      // the reply is still the operator's, delivered as written.
      if (inThread !== undefined && messageId !== undefined) {
        for (const other of signals.slice(1)) {
          const also = yield* Effect.result(repository.answer(other.signalId, text, refs));
          if (also._tag === "Success") yield* releaseSignalAttachments(also.success);
        }
        return { ok: false as const, message: repositoryMessage(answered.failure), messageId };
      }
      return refused(repositoryMessage(answered.failure));
    }
    yield* releaseSignalAttachments(answered.success);
    // An answer that started a thread makes its signal that thread's head. The
    // answer stands either way: a signal the store will not place is said in the log.
    let closed = answered.success;
    if (thread === undefined && messageId !== undefined) {
      perfStage("core", "core-step-start", { op: "SignalSetThread" });
      const placed = yield* Effect.result(repository.setThread(signal.signalId, messageId));
      perfStage("core", "core-step-end", { op: "SignalSetThread" });
      if (placed._tag === "Success") closed = placed.success;
      else yield* Effect.logWarning("the answer started a thread its signal was not put in", { signalId: signal.signalId });
    }
    // The others the same mail answers: recorded with its words. One closed
    // meanwhile (withdrawn, dismissed, answered elsewhere) is left as it is.
    for (const other of signals.slice(1)) {
      const also = yield* Effect.result(repository.answer(other.signalId, text, refs));
      if (also._tag === "Success") yield* releaseSignalAttachments(also.success);
      else yield* Effect.logWarning("a signal the thread reply answers was not recorded", { signalId: other.signalId });
    }
    // Copies go only once the answer stands: a refused answer told no one.
    if (messageId !== undefined) yield* sendAnswerCopies(signal, copies.seatName ?? signal.nodeId, mailed, messageId, copies.seats);
    return {
      ok: true as const,
      signal: closed,
      ...(messageId === undefined ? {} : { messageId }),
    };
  });

export const answerAgentSignal = (signalId: string, response: string, options?: AnswerOptions) =>
  Effect.gen(function* () {
    const signals = yield* AgentSignalRepository;
    perfStage("core", "core-step-start", { op: "SignalGet" });
    const current = yield* Effect.result(signals.get(signalId));
    perfStage("core", "core-step-end", { op: "SignalGet" });
    if (current._tag === "Failure") return refused(repositoryMessage(current.failure));
    const signal = current.success;
    if (signal.state !== "open") return refused(`this signal is already ${signal.state}`);
    return yield* answerOpenSignals([signal], response, options);
  });

/**
 * The open signals of a seat's thread that a reply there answers: those that
 * ask only for words, newest first. Empty when there are none, and the reply
 * is plain mail.
 */
export const openThreadSignals = (canvasName: string, nodeId: string, threadId: string) =>
  Effect.gen(function* () {
    const signals = yield* AgentSignalRepository;
    const listed = yield* signals.listSeat({ canvasName, nodeId });
    return listed
      .filter((signal) => signal.state === "open" && signal.threadId === threadId && asksOnlyForWords(signal))
      .sort((a, b) => b.createdAt - a.createdAt || b.signalId.localeCompare(a.signalId));
  });

/**
 * A reply the operator typed in a seat's thread, as the answer to the open
 * signals there that ask only for words: one mail in the thread, which names
 * the one replied to (else the newest), and every one recorded answered. A
 * signal the seat closed meanwhile leaves the mail standing, with its id.
 * Undefined when the thread has none, so the reply goes as plain mail.
 */
export const answerThreadSignals = (
  thread: { readonly canvasName: string; readonly nodeId: string; readonly threadId: string; readonly inReplyTo?: string },
  text: string,
  attachments: ReadonlyArray<ContentRef>,
) =>
  Effect.gen(function* () {
    const open = yield* openThreadSignals(thread.canvasName, thread.nodeId, thread.threadId);
    // The signal whose mail the operator replied to is the one the mail names; else the newest.
    const replied = open.find((signal) => thread.inReplyTo !== undefined && signal.messageId === thread.inReplyTo);
    const [head, ...rest] = replied === undefined ? open : [replied, ...open.filter((signal) => signal !== replied)];
    if (head === undefined) return undefined;
    return yield* answerOpenSignals(
      [head, ...rest],
      text,
      attachments.length === 0 ? {} : { attachments },
      thread.inReplyTo === undefined ? {} : { inReplyTo: thread.inReplyTo },
    );
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
    perfStage("core", "core-step-start", { op: "SignalGet" });
    const current = yield* Effect.result(signals.get(signalId));
    perfStage("core", "core-step-end", { op: "SignalGet" });
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
