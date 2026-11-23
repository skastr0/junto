/**
 * How a seat raises its signals: one (`signal.raise`) or a batch in the
 * order to act (`signal.batch`), each in a thread or not, each after other
 * signals or not (docs/security-doctrine.md, after the no-edge signals line).
 *
 * Everything is judged before anything is written: the words, the form, the
 * thread, what each comes after. Then the files are held, and every signal
 * and its mail in a thread are written in one transaction, so a refusal at
 * any step writes nothing: no signal row, no mail row, no file held.
 */
import { Effect, Option, Result } from "effect";
import { SqlClient, SqlError } from "effect/sql";
import { ulid } from "ulid";
import {
  AGENT_SIGNAL_MAX_DETAIL_LENGTH,
  AGENT_SIGNAL_MAX_TEXT_LENGTH,
  type AgentSignalAttachment,
  normalizeSignalText,
} from "@shared/agent-signals";
import { mailExtensionMetadata, mailThreadOf } from "@shared/crew";
import { asNodeId, type Canvas } from "@shared/model";
import { resourcesSeatReaches } from "@shared/region-reach";
import { makeAgentMessage } from "@shared/task";
import { AGENT_SIGNAL_MAX_DEPENDS_ON, type AgentSignal } from "@shared/wire/agent-signals";
import type { SignalBatchItem, SignalRaiseArgs, WorkErrorBody } from "@shared/work-control";
import type { Message } from "@shared/work-model";
import type { ActorRef } from "@shared/work-reference";
import { ContentService } from "../content/service";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { claimSignalAttachments, signalAttachmentOwner } from "../signals/attachments";
import { resolveSignalForm, signalKindTakesForm } from "../signals/form-rule";
import { AgentSignalRepository, type AgentSignalRepositoryError, type RaiseAgentSignal } from "../signals/repository";
import { signalResourcesFor } from "../signals/resource-refs";
import { StateTransactionOperation } from "../state/service";
import { fromWorkResult } from "./answers";
import { mailSenderStamp } from "./mail";
import { OPERATOR_REPLY_REFUSAL, operatorReplyFault, type OperatorReplyFault } from "@shared/operator-reply";
import { OPERATOR_SEAT_ID } from "@shared/work-reference";
import { isUlid } from "@shared/ulid";
import { SIGNAL_THREAD_REFUSAL, type SignalThreadRow, signalThreadFault } from "@shared/signal-thread";
import { WorkSeat, type WorkCaller } from "./seat";

type Seat = { readonly canvasName: string; readonly nodeId: string };

/** One signal as the seat asked for it, with where its errors point. */
type Asked = {
  readonly path: string;
  readonly args: Omit<SignalRaiseArgs, "dependsOn" | "dependsOnLast">;
  /** What it comes after, as given: an earlier item of the batch by index from 0, or an existing signal by id. */
  readonly after: ReadonlyArray<number | string>;
  /** Also after the signal this seat raised last on this canvas. */
  readonly afterLast: boolean;
};

/**
 * A thread a signal is raised in: its id, the operator's newest mail in it,
 * which the signal's mail answers, and the signal whose answer started it.
 */
type InThread = { readonly threadId: string; readonly parent: Message; readonly head?: string };

/** One signal judged and ready to write. */
type Judged = {
  readonly raise: RaiseAgentSignal & { readonly signalId: string };
  /** Its mail in its thread, built and judged by the reply rule before anything is written. */
  readonly mail?: { readonly thread: InThread; readonly row: Message };
  readonly dependsOn: ReadonlyArray<string>;
};

const refused = (type: WorkErrorBody["type"], message: string, details: WorkErrorBody["details"]): Effect.Effect<never, WorkErrorBody> =>
  Effect.fail({ type, message, details });

const unavailable = (what: string): WorkErrorBody => ({
  type: "RuntimeDown",
  message: `${what} are unavailable in this Junto runtime`,
  details: { retryable: false },
});

const storeFailure = (error: AgentSignalRepositoryError): WorkErrorBody => ({
  type: "InternalError",
  message: error.message,
  details: { retryable: true },
});

/** The store refuses a signal that comes after one not the seat's own: said in the seat's words. */
const raiseFailure = (error: AgentSignalRepositoryError): WorkErrorBody =>
  error._tag === "AgentSignalNotFound"
    ? { type: "ScopeError", message: NOT_RAISED_BY_THIS_SEAT, details: { retryable: false, next_step: "junto signal list shows this seat's signals; name one you raised, or none" } }
    : storeFailure(error);

/** The words the seat gave for this signal, if any ask for an order or a thread. */
const linkFlags = (asked: ReadonlyArray<Asked>): ReadonlyArray<string> => {
  const used = new Set<string>();
  for (const one of asked) {
    if (one.args.thread !== undefined) used.add("--thread");
    if (one.after.length > 0) used.add("--depends-on");
    if (one.afterLast) used.add("--depends-on-last");
  }
  return [...used];
};

/**
 * Until Remote carries a signal's thread and order to the machine that edits
 * the canvas, a seat on another machine raises plain signals only: a mail row
 * that names its signal would be refused there by the reply rule, and a
 * refused row closes that machine's link. Remote removes this in the commit
 * that makes them cross. Unknown is this machine, as the onboard reads it.
 */
export const signalLinksOnlyOnTheEditor = (canvasName: string, flags: ReadonlyArray<string>, batch: boolean) =>
  Effect.gen(function* () {
    if (flags.length === 0 && !batch) return;
    const records = yield* Effect.serviceOption(ModelRecords);
    const machines = yield* Effect.serviceOption(MachineRepository);
    if (Option.isNone(records) || Option.isNone(machines)) return;
    const editor = yield* records.value.canvasEditor(canvasName).pipe(Effect.orElseSucceed(() => undefined));
    if (editor === undefined) return;
    const here = yield* machines.value.installationId.pipe(Effect.orElseSucceed(() => undefined));
    if (here === undefined || here === editor) return;
    const named = batch ? "junto signal batch" : flags.join(", ");
    return yield* refused("ScopeError", `${named} is not available yet for a seat whose canvas another machine edits`, {
      retryable: false,
      reason: "other_machine",
      next_step: batch
        ? "raise each signal on its own with junto feedback, escalate or blocked, without --thread or --depends-on"
        : "raise the signal without --thread, --depends-on and --depends-on-last",
    });
  });

/** The words, the detail, the form and the replies of one signal, judged. */
const judgeWords = (board: Canvas, caller: WorkCaller, asked: Asked) =>
  Effect.gen(function* () {
    const { args, path } = asked;
    const text = normalizeSignalText(args.text);
    if (!text || text.length > AGENT_SIGNAL_MAX_TEXT_LENGTH) {
      return yield* refused("InputError", `text must be one sentence of 1 to ${AGENT_SIGNAL_MAX_TEXT_LENGTH} characters`, {
        path: `${path}.text`,
        retryable: false,
        hint: "put the longer explanation in --detail",
      });
    }
    const detail = args.detail?.trim() || undefined;
    if (detail !== undefined && detail.length > AGENT_SIGNAL_MAX_DETAIL_LENGTH) {
      return yield* refused("InputError", `detail must be at most ${AGENT_SIGNAL_MAX_DETAIL_LENGTH} characters`, {
        path: `${path}.detail`,
        retryable: false,
      });
    }
    // The reply the signal asks for (0.11, 07 N1). The wire lets a form ride
    // any raise; here is where it is resolved, and only the kinds that ask
    // the operator to produce something may carry one.
    const request = args.form;
    if (request !== undefined && !signalKindTakesForm(args.kind)) {
      return yield* refused("InputError", `${args.kind} asks for no form: a notice is read and cleared, a review asks the operator to look`, {
        path: `${path}.form`,
        retryable: false,
        next_step: "raise blocked or escalate to ask for something",
      });
    }
    const form =
      request === undefined
        ? undefined
        : yield* Effect.fromResult(
            resolveSignalForm({
              board,
              reaches: resourcesSeatReaches(board, asNodeId(caller.nodeId)).map((node) => node.id),
              text,
              request,
            }),
          );
    // Pre-baked replies: each one line the operator can send as-is. The wire
    // already bounds their count and length; what is left to do here is fold
    // each to a single line and drop the ones that fold to none.
    const suggestions = args.suggest
      ?.map((suggestion) => normalizeSignalText(suggestion))
      .filter((suggestion): suggestion is string => suggestion.length > 0);
    return {
      kind: args.kind,
      text,
      ...(detail ? { detail } : {}),
      ...(form === undefined ? {} : { form }),
      ...(suggestions !== undefined && suggestions.length > 0 ? { suggestions } : {}),
    };
  });

/**
 * A mailbox row as the thread rule reads it: its stored author, which every
 * admit path stamps as `metadata.fromSeat`. A row with no stamp was not
 * written by the operator.
 */
export const threadRow = (message: Pick<Message, "messageId" | "metadata">): SignalThreadRow => ({
  messageId: message.messageId,
  actorSeatId: typeof message.metadata?.fromSeat === "string" ? message.metadata.fromSeat : undefined,
  metadata: message.metadata,
});

/**
 * The thread a signal is raised in, named by its id or by the id of any mail
 * of it in this seat's mailbox, and the operator's newest mail there, which
 * the signal's mail answers. Whether a signal may be raised there is the one
 * thread rule (`signalThreadFault`), which the editing machine runs again
 * when it takes the signal; the row itself then answers to the reply rule.
 */
const resolveThread = (seat: Seat, ref: string, path: string) =>
  Effect.gen(function* () {
    const { mailboxOf } = yield* WorkSeat;
    const mailbox = yield* mailboxOf(seat.nodeId);
    const named = mailbox.find((message) => message.messageId === ref);
    const threadId = named === undefined ? ref : mailThreadOf(named);
    const held = mailbox.filter((message) => mailThreadOf(message) === threadId);
    if (held.length === 0) {
      return yield* refused("UnknownTarget", `no thread "${ref}" in this seat's mail`, {
        path,
        target: ref,
        retryable: false,
        next_step: "junto thread list --group with-you lists the threads you have with the operator",
      });
    }
    const rows = held.map(threadRow);
    const fault = signalThreadFault(threadId, rows);
    const parent = held
      .filter((_, index) => rows[index]!.actorSeatId === OPERATOR_SEAT_ID)
      .sort((a, b) => a.messageId.localeCompare(b.messageId))
      .at(-1);
    if (fault !== undefined || parent === undefined) {
      return yield* refused("ScopeError", SIGNAL_THREAD_REFUSAL, {
        path,
        target: ref,
        retryable: false,
        next_step: "name a thread from junto thread list --group with-you, or raise the signal without --thread",
      });
    }
    // The root is the operator's answer to the signal that heads the thread, when it is one.
    const head = held.find((message) => message.messageId === threadId)?.metadata?.agentSignalId;
    return { threadId, parent, ...(typeof head === "string" && isUlid(head) ? { head } : {}) } satisfies InThread;
  });

/** Why the reply rule refuses a signal's mail, said to the seat. */
const threadRefusal = (fault: OperatorReplyFault, ref: string, path: string): Effect.Effect<never, WorkErrorBody> =>
  refused("ScopeError", fault === "parent_in_subject_thread" ? "a signal is not raised in a task or resource thread" : OPERATOR_REPLY_REFUSAL, {
    path,
    target: ref,
    retryable: false,
    next_step: "name a thread from junto thread list --group with-you, or raise the signal without --thread",
  });

/** What a signal is refused for coming after one the seat did not raise itself. */
const NOT_RAISED_BY_THIS_SEAT = "a signal can only come after one this seat raised itself";

/** An existing signal this seat raised itself on this canvas, by id (the store's rule: no source), or the refusal. */
const ownSignal = (signals: AgentSignalRepository["Service"], seat: Seat, id: string, path: string) =>
  signals.get(id).pipe(
    Effect.option,
    Effect.flatMap((found) => {
      const mine = Option.isSome(found) && found.value.canvasName === seat.canvasName && found.value.nodeId === seat.nodeId;
      if (mine && found.value.source === undefined) return Effect.succeed(id);
      if (mine) return refused("ScopeError", `${NOT_RAISED_BY_THIS_SEAT}: "${id}" was raised for it`, { path, target: id, retryable: false, next_step: "name a signal you raised, or none" });
      return refused("UnknownTarget", `no signal "${id}" of this seat on this canvas`, {
        path,
        target: id,
        retryable: false,
        next_step: "junto signal list shows this seat's signals; a signal comes after this seat's own only",
      });
    }),
  );


/**
 * Raise the signals in the order given, all or none. Each comes after what it
 * names; in a thread, its mail there is written with it. Answers them in order.
 */
export const raiseSignals = (asked: ReadonlyArray<Asked>, batch: boolean) =>
  Effect.gen(function* () {
    const { caller, board, actor, beginWrite, work } = yield* WorkSeat;
    const signalsOption = yield* Effect.serviceOption(AgentSignalRepository);
    if (Option.isNone(signalsOption)) return yield* Effect.fail(unavailable("agent signals"));
    const signals = signalsOption.value;
    const seat: Seat = { canvasName: caller.canvasName, nodeId: caller.nodeId };
    yield* signalLinksOnlyOnTheEditor(seat.canvasName, linkFlags(asked), batch);

    // Judged first, all of them: a bad item writes none.
    const sentBy = actor;
    if (asked.some((one) => one.args.thread !== undefined) && Result.isFailure(sentBy)) return yield* Effect.fail(sentBy.failure);
    const threads = new Map<string, InThread>();
    const ids = asked.map(() => ulid());
    const judged: Array<Judged> = [];
    for (const [index, one] of asked.entries()) {
      const words = yield* judgeWords(board, caller, one);
      let mail: Judged["mail"];
      if (one.args.thread !== undefined && Result.isSuccess(sentBy)) {
        const ref = one.args.thread;
        const path = `${one.path}.thread`;
        const thread = threads.get(ref) ?? (yield* resolveThread(seat, ref, path));
        threads.set(ref, thread);
        const row = threadMailRow(board, caller, sentBy.success, thread, ids[index]!, words.text);
        // The one thread rule, the reply's, on the row as it will be written.
        const fault = operatorReplyFault(
          { mailbox: seat.nodeId, author: seat.nodeId, message: row },
          { actorSeatId: String(thread.parent.metadata?.fromSeat ?? ""), message: thread.parent },
        );
        if (fault !== undefined) return yield* threadRefusal(fault, ref, path);
        mail = { thread, row };
      }
      const after: Array<string> = [];
      for (const [at, ref] of one.after.entries()) {
        const path = `${one.path}.dependsOn[${at}]`;
        if (typeof ref === "string") {
          after.push(yield* ownSignal(signals, seat, ref.trim(), path));
          continue;
        }
        if (ref >= index) {
          return yield* refused("InputError", `item ${index + 1} can come only after an earlier item, not item ${ref + 1}`, {
            path,
            retryable: false,
            hint: "a batch is raised first to last: name items before this one, counted from 1",
          });
        }
        after.push(ids[ref]!);
      }
      if (one.afterLast) {
        // The signal this seat raised last on this canvas; none, after nothing.
        const last = yield* newestSeatSignal(signals, seat).pipe(Effect.mapError(storeFailure));
        if (last !== undefined) after.push(last.signalId);
      }
      const dependsOn = [...new Set(after)];
      if (dependsOn.length > AGENT_SIGNAL_MAX_DEPENDS_ON) {
        return yield* refused("InputError", `a signal comes after at most ${AGENT_SIGNAL_MAX_DEPENDS_ON} others; this one names ${dependsOn.length}`, {
          path: `${one.path}.dependsOn`,
          retryable: false,
          hint: "--depends-on-last counts as one more: name fewer, or drop --depends-on-last",
        });
      }
      judged.push({
        raise: { ...seat, signalId: ids[index]!, ...words },
        ...(mail === undefined ? {} : { mail }),
        dependsOn,
      });
    }

    // The files: the seat uploaded them already. They are judged here,
    // whatever the CLI already checked, and held under each signal's id
    // before any signal is written.
    const content = yield* Effect.serviceOption(ContentService);
    const release = Effect.forEach(
      judged,
      (one) =>
        Option.isNone(content)
          ? Effect.void
          : content.value.releaseOwner(signalAttachmentOwner({ ...seat, signalId: one.raise.signalId })).pipe(Effect.ignore),
      { discard: true },
    );
    const attachments: Array<ReadonlyArray<AgentSignalAttachment>> = [];
    for (const [index, one] of asked.entries()) {
      const attach = one.args.attach ?? [];
      if (attach.length === 0) {
        attachments.push([]);
        continue;
      }
      if (Option.isNone(content)) {
        yield* release;
        return yield* refused("RuntimeDown", "attachments are unavailable in this Junto runtime", {
          retryable: false,
          next_step: "raise the signal without --attach",
        });
      }
      // A task or an artifact is named as the seat typed it: resolved here
      // in its reach to the canonical ref, then judged with the rest.
      const held = yield* Effect.gen(function* () {
        const named = yield* signalResourcesFor(board, caller.canvasName, asNodeId(caller.nodeId), attach);
        return yield* claimSignalAttachments(content.value, { ...seat, signalId: judged[index]!.raise.signalId }, named.inputs, named.resources).pipe(
          Effect.mapError((refusal): WorkErrorBody => ({
            type: "InputError",
            message: refusal.message,
            details: { path: `${one.path}.${refusal.path}`, retryable: false },
          })),
        );
      }).pipe(Effect.tapError(() => release));
      attachments.push(held);
    }

    const write = Effect.gen(function* () {
      const raised: Array<AgentSignal> = [];
      for (const [index, one] of judged.entries()) {
        let inThread: Pick<AgentSignal, "threadId" | "messageId" | "followsSignalId"> = {};
        if (one.mail !== undefined && Result.isSuccess(sentBy)) {
          const { thread, row } = one.mail;
          const follows = yield* followedIn(signals, seat, thread);
          const written = fromWorkResult(yield* work.workOperatorReply(seat.canvasName, seat.nodeId, row, sentBy.success));
          if (Result.isFailure(written)) return yield* Effect.fail(written.failure);
          inThread = { threadId: thread.threadId, messageId: row.messageId, ...(follows === undefined ? {} : { followsSignalId: follows }) };
        }
        const held = attachments[index]!;
        raised.push(
          yield* signals
            .raise({
              ...one.raise,
              ...(held.length > 0 ? { attachments: held } : {}),
              ...inThread,
              ...(one.dependsOn.length > 0 ? { dependsOn: one.dependsOn } : {}),
            })
            .pipe(Effect.mapError(raiseFailure)),
        );
      }
      return raised;
    });
    const needsOne = batch || judged.some((one) => one.mail !== undefined);
    if (needsOne) yield* beginWrite.pipe(Effect.tapError(() => release));
    const sql = needsOne ? yield* Effect.serviceOption(SqlClient.SqlClient) : Option.none();
    if (needsOne && Option.isNone(sql)) {
      yield* release;
      return yield* Effect.fail(unavailable("signals in threads"));
    }
    // One act: every signal of the batch, and each one's mail in its thread.
    return yield* (Option.isSome(sql)
      ? write.pipe(
          sql.value.withTransaction,
          Effect.provideService(StateTransactionOperation, "work.signal.raise"),
          // A transaction that could not open or commit wrote nothing.
          Effect.mapError((error): WorkErrorBody =>
            error instanceof SqlError.SqlError ? { type: "InternalError", message: "the signals could not be written", details: { retryable: true } } : error,
          ),
        )
      : write
    ).pipe(Effect.tapError(() => release));
  });

/**
 * The seat's next mail in the thread, that is this signal: its words, as a
 * plain reply to the operator's newest mail there, and the signal's id as
 * the one field beyond a reply's.
 */
const threadMailRow = (board: Canvas, caller: WorkCaller, sentBy: ActorRef, thread: InThread, signalId: string, text: string): Message =>
  makeAgentMessage({
    messageId: ulid(),
    text,
    contextId: caller.canvasName,
    metadata: {
      factoryMail: true,
      ...mailExtensionMetadata({ ...mailSenderStamp(board, caller, sentBy), mailKind: "notice" }),
      inReplyTo: thread.parent.messageId,
      threadId: thread.threadId,
      toNodeId: "operator",
      raisedSignalId: signalId,
    },
  });

/**
 * The nearest earlier signal in the thread: the newest this seat raised in it,
 * else the signal whose answer started it. Read inside the write, so an
 * earlier item of the same batch counts.
 */
const followedIn = (signals: AgentSignalRepository["Service"], seat: Seat, thread: InThread) =>
  newestInThread(signals, seat, thread.threadId).pipe(
    Effect.mapError(storeFailure),
    Effect.map((newest) => newest?.signalId ?? thread.head),
  );

/** The newest of the seat's signals in one thread, any state: the one a raise there follows. */
const newestInThread = (signals: AgentSignalRepository["Service"], seat: Seat, threadId: string) =>
  Effect.map(signals.listSeatThread(seat, threadId), (held) => held[0]);

/** The seat's newest signal on its canvas, any state. */
const newestSeatSignal = (signals: AgentSignalRepository["Service"], seat: Seat) => signals.latestSeat(seat);

/** One raise as the seat asked for it. */
export const askedRaise = (args: SignalRaiseArgs): Asked => {
  const { dependsOn, dependsOnLast, ...rest } = args;
  return { path: "args", args: rest, after: dependsOn ?? [], afterLast: dependsOnLast === true };
};

/** A batch as the seat asked for it: an item that names nothing comes after the one before it. */
export const askedBatch = (items: ReadonlyArray<SignalBatchItem>): ReadonlyArray<Asked> =>
  items.map((item, index) => {
    const { dependsOn, ...rest } = item;
    // Positions are counted from 1 on the wire, from 0 here.
    const after = dependsOn === undefined
      ? index === 0 ? [] : [index - 1]
      : dependsOn.map((ref) => (typeof ref === "number" ? ref - 1 : ref));
    return { path: `args.signals[${index}]`, args: rest, after, afterLast: false };
  });
