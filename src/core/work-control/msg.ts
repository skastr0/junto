/**
 * The core's handlers for the work socket's msg ops (`MsgRpcs`). Each reads
 * the seat its call was admitted as (`WorkSeat`), so none takes a caller as
 * an argument, and each refuses with the v1 error body as a `WorkFailure`.
 */
import { Effect } from "effect";
import { MsgRpcs } from "../../contract/work/msg";
import { workFailure } from "../../contract/work/failure";
import { Result } from "effect";
import { ulid } from "ulid";
import { type Message } from "@shared/work-model";
import { sortMessagesNewestFirst } from "@shared/message-delivery";
import { MAIL_MESSAGE_ID_SHAPE, isMailMessageId, type MailMessageId, mailExtensionMetadata, mailThreadOf } from "@shared/crew";
import { OPERATOR_SEAT_ID } from "@shared/work-reference";
import { mailListFilterOf, mailListMatches } from "@shared/mail-list-filter";
import { makeAgentMessage, makeUserMessage } from "@shared/task";
import { isOwnMailboxTarget, resolveMailboxTarget } from "@shared/mailbox-target";
import { MSG_LIST_LIMIT_DEFAULT, type WorkErrorBody } from "@shared/work-control";
import { commentOnTask, liveTaskPorts } from "../work/task-control";
import { messageDelivery } from "../work/message-delivery";
import { noticeTakesReply, subjectNoticeKindOf } from "@shared/subject-notice";
import { subjectLabel, threadSubjectOf } from "@shared/thread-subject";
import { OpId } from "@shared/work-ids";
import { postSubjectComment } from "../work/subject-comment";
import { subjectReplyOf } from "@shared/subject-comment";
import { subjectPeopleAt } from "../work/subject-people";
import { findNode } from "../work/authz";
import { linkMentionsAt, unlinkedField } from "../work/mention-links";
import { asNodeId, seatIdentity, type SeatIdentity } from "@shared/model";
import { withThread, asSeatReadsIt, mailIdArg, resolveMailTarget, mailTask, seatTaskCaller, replyThreadMetadata, mailSenderStamp, recipientOf, OPERATOR_RECIPIENT } from "./mail";
import { mapWorkCode, fromWorkResult, exposeWorkMutation } from "./answers";
import { requireTarget, WorkAdmission, WorkSeat } from "./seat";

/** The msg ops as this core serves them: each handler is handed its admitted seat. */
export const MsgServed = MsgRpcs.middleware(WorkAdmission);

export const MsgHandlers = MsgServed.toLayer(
  MsgServed.of({
  "msg.list": (args) =>
    Effect.gen(function* () {
      const op = "msg.list" as const;
      const { work, caller, board, actor, mailboxOf } = yield* WorkSeat;
      const targetId = resolveMailboxTarget(args.target, caller);
      const own = isOwnMailboxTarget(targetId, caller.nodeId);
      const filter = mailListFilterOf(args);
      if (Result.isFailure(filter)) {
        return yield* Effect.fail<WorkErrorBody>({
          type: "InputError",
          message: filter.failure.message,
          details: { path: filter.failure.path, expected: filter.failure.expected, retryable: false },
        });
      }
      // The inbox and the sent list are two streams, so each pages by its own cursor.
      const before = args.before?.trim();
      const sentBefore = args.sentBefore?.trim();
      for (const [cursor, name] of [[before, "before"], [sentBefore, "sentBefore"]] as const) {
        if (cursor !== undefined && !isMailMessageId(cursor)) {
          return yield* Effect.fail<WorkErrorBody>({
            type: "InputError",
            message: `${name} must be ${MAIL_MESSAGE_ID_SHAPE}`,
            details: { path: `args.${name}`, expected: "ULID", retryable: false },
          });
        }
      }
      const matches = mailListMatches(filter.success);
      const filtered = <M extends Message>(items: ReadonlyArray<M>): M[] => items.filter(matches);
      const threadId = filter.success.threadId;
      const threadField = threadId === undefined ? {} : { threadId };

      // A task's mail is its one thread, read from its node's mailbox (03).
      if (args.taskId) {
        const reader = actor;
        if (Result.isFailure(reader)) return yield* Effect.fail(reader.failure);
        const task = yield* mailTask(board, caller, reader.success, args.target, args.taskId, op);
        const onTask = (row: Message): boolean => {
          const on = threadSubjectOf(row);
          return on?.kind === "task" && on.nodeId === task.current.node && on.taskId === task.taskId;
        };
        // A task's thread is read whole and in order, as a conversation; pages are for mailboxes.
        const rows = (yield* mailboxOf(task.current.node)).filter(onTask);
        return { target: task.current.node, taskId: task.taskId, items: filtered(rows) };
      }

      if (own) {
        const ownNode = findNode(board, caller.nodeId);
        if (!ownNode) {
          return yield* Effect.fail({
            type: "UnknownTarget" as const,
            message: `target "${caller.nodeId}" not found`,
            details: { target: caller.nodeId, retryable: false },
          });
        }
        const reader = actor;
        if (Result.isFailure(reader)) return yield* Effect.fail(reader.failure);
        // Listing marks read, so the filters and the page apply first; a peek
        // marks nothing. The page is read as a page: with no filter only its
        // rows and their receipts are read, not the whole mailbox nor the
        // whole sent history.
        const limit = args.limit ?? MSG_LIST_LIMIT_DEFAULT;
        const page = yield* work
          .readMailboxPageSnapshot(caller.canvasName, caller.nodeId, {
            limit,
            ...(before === undefined ? {} : { before }),
            filter: filter.success,
          })
          .pipe(Effect.mapError((error) => mapWorkCode(error.code, error.message, error.details)));
        const sentPage = yield* work
          .readMailSentByPageSnapshot(caller.canvasName, caller.nodeId, {
            limit,
            ...(sentBefore === undefined ? {} : { before: sentBefore }),
            filter: filter.success,
          })
          .pipe(Effect.mapError((error) => mapWorkCode(error.code, error.message, error.details)));
        // One transaction marks the page's rows, not one per message.
        const unread = args.peek === true
          ? []
          : page.items.flatMap((item) => {
              if (item.role !== "user") return [];
              const existingReadAt = item.metadata?.readAt;
              return typeof existingReadAt === "number" && Number.isFinite(existingReadAt) ? [] : [item.messageId];
            });
        const readAtOf = new Map<string, number>();
        if (unread.length > 0) {
          const marked = yield* work.workMessagesMarkRead(
            caller.canvasName,
            caller.nodeId,
            unread,
            reader.success,
          );
          const mapped = fromWorkResult(marked);
          if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
          for (const mark of mapped.success.value.read) {
            const readAtMs = Date.parse(mark.readAt);
            if (Number.isFinite(readAtMs)) readAtOf.set(mark.messageId, readAtMs);
          }
        }
        const overlaid: Message[] = page.items.map((item) => {
          const readAtMs = readAtOf.get(item.messageId);
          return readAtMs === undefined
            ? item
            : { ...item, metadata: { ...(item.metadata ?? {}), readAt: readAtMs } };
        });
        return {
          target: caller.nodeId,
          ...threadField,
          items: yield* Effect.forEach(
            sortMessagesNewestFirst(overlaid).map(withThread),
            asSeatReadsIt(board, caller.canvasName, caller.nodeId),
          ),
          more: page.more,
          remaining: page.remaining,
          sent: sentPage.items.map((row) => withThread({ ...row.message, toNodeId: row.nodeId })),
          sentMore: sentPage.more,
          sentRemaining: sentPage.remaining,
        };
      }

      // Another seat's thread is named as mail names it: a name, id or ref.
      const named = resolveMailTarget(board, caller.nodeId, targetId, op);
      if (Result.isFailure(named)) return yield* Effect.fail(named.failure);
      const gate = requireTarget(board, caller.nodeId, named.success, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const page = yield* work
        .readMailboxPageSnapshot(caller.canvasName, named.success, {
          limit: args.limit ?? MSG_LIST_LIMIT_DEFAULT,
          ...(before === undefined ? {} : { before }),
          filter: filter.success,
        })
        .pipe(Effect.mapError((error) => mapWorkCode(error.code, error.message, error.details)));
      return {
        target: named.success,
        ...threadField,
        items: page.items.map(withThread),
        more: page.more,
        remaining: page.remaining,
      };
    }).pipe(Effect.mapError(workFailure)),
  "msg.prompt": (args) =>
    Effect.gen(function* () {
      const op = "msg.prompt" as const;
      const { work, caller, board, actor, beginWrite } = yield* WorkSeat;
      const named = resolveMailTarget(board, caller.nodeId, args.target, op);
      if (Result.isFailure(named)) return yield* Effect.fail(named.failure);
      const input = { ...args, target: named.success };
      const gate = requireTarget(board, caller.nodeId, input.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const text = input.text.trim();
      if (!text) return yield* Effect.fail<WorkErrorBody>({
        type: "InputError", message: "text must be non-empty", details: { path: "text", retryable: false },
      });
      const sender = actor;
      if (Result.isFailure(sender)) return yield* Effect.fail(sender.failure);
      const messageId = ulid();
      const message = makeUserMessage({
        messageId, text, contextId: caller.canvasName,
        metadata: {
          factoryMail: true,
          ...mailExtensionMetadata({
            ...mailSenderStamp(board, caller, sender.success),
            mailKind: "prompt",
            ...(input.subject === undefined ? {} : { subject: input.subject }),
            ...(input.refs === undefined ? {} : { refs: input.refs }),
          }),
        },
      });
      yield* beginWrite;
      const appended = fromWorkResult(yield* work.workMessageAppend(
        caller.canvasName, input.target, null, message, sender.success,
      ));
      if (Result.isFailure(appended)) return yield* Effect.fail(appended.failure);
      const delivery = yield* Effect.promise(() =>
        messageDelivery.deliver(caller.canvasName, input.target, messageId),
      );
      return { ...exposeWorkMutation(appended.success), messageId, recipient: recipientOf(board, input.target), delivery };
    }).pipe(Effect.mapError(workFailure)),
  "msg.sent": (args) =>
    Effect.gen(function* () {
      const op = "msg.sent" as const;
      const { work, caller, board, actor, sentMailOf } = yield* WorkSeat;
      const sender = actor;
      if (Result.isFailure(sender)) return yield* Effect.fail(sender.failure);
      // One indexed read of what this seat sent, on the mail worker, not a
      // read of every mailbox on the canvas (775 ms on the factory board).
      const items: Array<Message & { readonly toNodeId: string; readonly to: SeatIdentity }> = [];
      for (const message of yield* sentMailOf(true)) {
        if (args.target !== undefined && message.toNodeId !== args.target) continue;
        const node = board.nodes.get(asNodeId(message.toNodeId));
        if (node === undefined) continue;
        items.push({ ...message, to: seatIdentity(board, node) });
      }
      return { target: caller.nodeId, items };
    }).pipe(Effect.mapError(workFailure)),
  "msg.send": (args) =>
    Effect.gen(function* () {
      const op = "msg.send" as const;
      const { work, caller, board, actor, mailboxOf, sentMailOf, beginWrite } = yield* WorkSeat;
      // Mail on a task is a comment in its one thread, on the task comment path (03).
      if (args.taskId !== undefined) {
        const typed = args.text.trim();
        if (!typed) {
          return yield* Effect.fail({
            type: "InputError" as const,
            message: "text must be non-empty",
            details: { path: "text", retryable: false },
          });
        }
        const sentBy = actor;
        if (Result.isFailure(sentBy)) return yield* Effect.fail(sentBy.failure);
        const task = yield* mailTask(board, caller, sentBy.success, args.target, args.taskId, op);
        // A task's thread is the task: its id.
        if (args.threadId !== undefined && args.threadId.trim() !== task.taskId) {
          return yield* Effect.fail({
            type: "InputError" as const,
            message: `a comment on task "${args.taskId}" is in its thread "${task.taskId}"`,
            details: { path: "threadId", retryable: false, next_step: "drop threadId: a task comment joins its task's thread" },
          });
        }
        yield* beginWrite;
        const posted = yield* commentOnTask(seatTaskCaller(board, caller, sentBy.success), liveTaskPorts, {
          // The caller's write id keeps a retry one comment; a raw frame with none gets its own.
          opId: args.opId ?? OpId.make(ulid()),
          task: task.taskId,
          text: typed,
          node: task.current.node,
        });
        return { ...posted, recipient: recipientOf(board, task.current.node) };
      }
      // A target is a node id or the name of a seat this one is wired to.
      const named = resolveMailTarget(board, caller.nodeId, args.target, op);
      if (Result.isFailure(named)) return yield* Effect.fail(named.failure);
      const decoded = { success: { ...args, target: named.success } };
      const recipient = recipientOf(board, named.success);
      const gate = requireTarget(board, caller.nodeId, decoded.success.target, op);
      if ("type" in gate) return yield* Effect.fail(gate);
      const typed = decoded.success.text.trim();
      if (!typed) {
        return yield* Effect.fail({
          type: "InputError" as const,
          message: "text must be non-empty",
          details: { path: "text", retryable: false },
        });
      }
      const sentBy = actor;
      if (Result.isFailure(sentBy)) return yield* Effect.fail(sentBy.failure);
      let threadId: string | undefined;
      if (decoded.success.threadId !== undefined) {
        const asked = mailIdArg("threadId", decoded.success.threadId);
        if (Result.isFailure(asked)) return yield* Effect.fail(asked.failure);
      }
      // Each mention becomes its link in this seat's mail (03).
      const linked = yield* linkMentionsAt(board, caller.canvasName, caller.nodeId, typed, { kind: "mail" });
      const text = linked.text;
      if (decoded.success.threadId !== undefined) {
        const askedThread = decoded.success.threadId.trim();
        // Only a thread this seat can read: its own mailbox, or mail it sent.
        // An id inside a thread stands for that thread.
        const readable = [...(yield* mailboxOf(caller.nodeId)), ...(yield* sentMailOf())];
        const named = readable.find((item) => item.messageId === askedThread);
        threadId = named !== undefined
          ? mailThreadOf(named)
          : readable.some((item) => mailThreadOf(item) === askedThread) ? askedThread : undefined;
        if (threadId === undefined) {
          return yield* Effect.fail({
            type: "UnknownTarget" as const,
            message: `threadId "${askedThread}" names no mail this seat can read`,
            details: {
              path: "threadId",
              target: askedThread,
              retryable: false,
              next_step: "run junto msg list to see this seat's mail and the threadId each one carries",
            },
          });
        }
      }
      // Durable body first. The transport adds the authenticated sender
      // envelope; storing it in the body would duplicate it on a retry.
      const messageId = ulid();
      const contextId = caller.canvasName;
      const message: Message = makeUserMessage({
        messageId,
        text,
        contextId,
        metadata: {
          factoryMail: true,
          ...mailExtensionMetadata({
            ...mailSenderStamp(board, caller, sentBy.success),
            mailKind: "notice",
            ...(decoded.success.subject === undefined ? {} : { subject: decoded.success.subject }),
            ...(decoded.success.refs === undefined ? {} : { refs: decoded.success.refs }),
          }),
          ...(threadId === undefined ? {} : { threadId }),
        },
      });
      yield* beginWrite;
      const result = yield* work.workMessageAppend(
        caller.canvasName,
        decoded.success.target,
        null,
        message,
        sentBy.success,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      const delivery = yield* Effect.promise(() =>
        messageDelivery.deliver(caller.canvasName, decoded.success.target, messageId),
      );
      return { ...exposeWorkMutation(mapped.success), messageId, threadId: threadId ?? messageId, recipient, delivery, ...unlinkedField(linked) };
    }).pipe(Effect.mapError(workFailure)),
  "msg.read": (args) =>
    Effect.gen(function* () {
      const op = "msg.read" as const;
      const { work, caller, board, actor } = yield* WorkSeat;
      const targetId = resolveMailboxTarget(args.target, caller);
      // Own mailbox only — the seat credential is the authority (not edge OptIn ports).
      if (targetId !== caller.nodeId) {
        return yield* Effect.fail({
          type: "ScopeError" as const,
          message: "msg.read only applies to this seat's own mailbox",
          details: {
            caller: caller.nodeId,
            target: targetId,
            next_step: `retry with target "${caller.nodeId}" (your own node) and the same messageId`,
            retryable: false,
          },
        });
      }
      const own = findNode(board, caller.nodeId);
      if (!own) {
        return yield* Effect.fail({
          type: "UnknownTarget" as const,
          message: `target "${caller.nodeId}" not found`,
          details: { target: caller.nodeId, retryable: false },
        });
      }
      const reader = actor;
      if (Result.isFailure(reader)) return yield* Effect.fail(reader.failure);
      const message = yield* work.readMailMessage(caller.canvasName, caller.nodeId, args.messageId.trim()).pipe(Effect.mapError((error) => mapWorkCode(error.code, error.message, error.details)));
      const result = yield* work.workMessageMarkRead(
        caller.canvasName,
        caller.nodeId,
        args.messageId.trim(),
        reader.success,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return {
        ...exposeWorkMutation(mapped.success),
        message: message === undefined ? message : yield* asSeatReadsIt(board, caller.canvasName, caller.nodeId)(withThread(message)),
      };
    }).pipe(Effect.mapError(workFailure)),
  "msg.react": (args) =>
    Effect.gen(function* () {
      const op = "msg.react" as const;
      const { work, caller, board, actor } = yield* WorkSeat;
      const targetId = resolveMailboxTarget(args.target, caller);
      if (targetId !== caller.nodeId) {
        return yield* Effect.fail({
          type: "ScopeError" as const,
          message: "msg.react only applies to this seat's own mailbox",
          details: {
            caller: caller.nodeId,
            target: targetId,
            next_step: `retry with target "${caller.nodeId}" (your own node) and the same messageId`,
            retryable: false,
          },
        });
      }
      const own = findNode(board, caller.nodeId);
      if (!own) {
        return yield* Effect.fail({
          type: "UnknownTarget" as const,
          message: `target "${caller.nodeId}" not found`,
          details: { target: caller.nodeId, retryable: false },
        });
      }
      const reactor = actor;
      if (Result.isFailure(reactor)) return yield* Effect.fail(reactor.failure);
      const result = yield* work.workMessageReact(
        caller.canvasName,
        caller.nodeId,
        args.messageId.trim(),
        args.reaction ?? "ack",
        reactor.success,
      );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return exposeWorkMutation(mapped.success);
    }).pipe(Effect.mapError(workFailure)),
  "msg.reply": (args) =>
    Effect.gen(function* () {
      const op = "msg.reply" as const;
      const { work, caller, board, actor, beginWrite } = yield* WorkSeat;
      // The operator is no node: a reply to them is admitted by the mail it
      // answers, below, never by an edge.
      const toOperator = args.target.trim() === "operator";
      let target = args.target;
      // Held until the parent is read: a reply in a subject thread is admitted
      // by reach to the subject, not by its node's kind (an artifacts or page
      // node takes no mail).
      let refusedByKind: WorkErrorBody | undefined;
      if (!toOperator) {
        const named = resolveMailTarget(board, caller.nodeId, target, op);
        if (Result.isFailure(named)) return yield* Effect.fail(named.failure);
        target = named.success;
        const gate = requireTarget(board, caller.nodeId, target, op);
        if ("type" in gate) refusedByKind = gate;
      }
      const decoded = { success: { ...args, target } };
      const typed = decoded.success.text.trim();
      if (!typed) {
        return yield* Effect.fail({
          type: "InputError" as const,
          message: "text must be non-empty",
          details: { path: "text", retryable: false },
        });
      }
      const parentId = mailIdArg("inReplyTo", decoded.success.inReplyTo);
      if (Result.isFailure(parentId)) return yield* Effect.fail(parentId.failure);
      const inReplyTo = parentId.success;
      const sentBy = actor;
      if (Result.isFailure(sentBy)) return yield* Effect.fail(sentBy.failure);
      // The parent is mail to this seat, and its thread is the reply's.
      const parent = yield* work.readMailMessage(caller.canvasName, caller.nodeId, inReplyTo).pipe(Effect.mapError((error) => mapWorkCode(error.code, error.message, error.details)));
      // A comment read from a task's thread (msg list on the task) is no
      // mail of this seat's: the thread is answered on the task.
      const onTask = !toOperator && findNode(board, target)?.kind === "task";
      const taskStep = 'answer in the task\'s thread with junto task comment <task> "...", the task as #42, its id or its junto:// ref';
      if (refusedByKind !== undefined && (parent === undefined || threadSubjectOf(parent)?.nodeId !== target)) {
        return yield* Effect.fail(onTask ? { ...refusedByKind, details: { ...refusedByKind.details, next_step: taskStep } } : refusedByKind);
      }
      if (parent === undefined) {
        return yield* Effect.fail({
          type: "UnknownTarget" as const,
          message: `inReplyTo "${inReplyTo}" is not mail in this seat's mailbox`,
          details: {
            path: "inReplyTo",
            target: inReplyTo,
            retryable: false,
            next_step: onTask ? taskStep : "run junto msg list to see this seat's mail",
          },
        });
      }
      // A stored row's fromSeat is its authenticated author, never what the
      // sender wrote: the repository stamps it from sentBy on every mailbox
      // row (admitMailboxMessage), and the exchange takes a row authored as
      // the operator only from the machine that edits the canvas
      // (writtenByItsAuthor, editorTakesFromNoPeer).
      if (toOperator && !(parent.metadata?.fromSeat === OPERATOR_SEAT_ID && parent.metadata?.senderName === "operator")) {
        return yield* Effect.fail({
          type: "ScopeError" as const,
          message: "a seat writes to the operator only in reply to mail the operator sent it",
          details: {
            caller: caller.nodeId,
            target: "operator",
            retryable: false,
            next_step: "reply to the seat that sent this mail, or report with junto feedback",
          },
        });
      }
      // A reply in a subject thread posts to the subject, whoever wrote the
      // parent (03 section 4), on the one comment path. Reach to the
      // subject's node admits it there, as for any comment.
      const subject = threadSubjectOf(parent);
      if (subject !== undefined) {
        const kind = subjectNoticeKindOf(parent);
        const refused = kind !== undefined && !noticeTakesReply(kind)
          ? "a refusal notice takes no reply"
          : toOperator || target !== subject.nodeId
            ? `a reply in this thread posts to ${subjectLabel(subject)}, not to its sender`
            : undefined;
        if (refused !== undefined) {
          return yield* Effect.fail({
            type: "InputError" as const,
            message: refused,
            details: {
              path: "target",
              target: subject.nodeId,
              retryable: false,
              next_step: kind === "refusal"
                ? "follow the next step the refusal names"
                : `retry with target "${subject.nodeId}" and the same inReplyTo`,
            },
          });
        }
      }
      // Each mention becomes its link: in reach of the subject, or this seat's mail (03).
      const linked = yield* linkMentionsAt(board, caller.canvasName, caller.nodeId, typed, subject === undefined
        ? { kind: "mail" }
        : { kind: "comments", nodeId: subject.nodeId });
      const text = linked.text;
      // The reply writes from here: the mark-read, then the reply or comment.
      yield* beginWrite;
      // Mark the parent mail read on own inbox first (idempotent).
      const marked = yield* work.workMessageMarkRead(
        caller.canvasName,
        caller.nodeId,
        inReplyTo,
        sentBy.success,
      );
      const markedMapped = fromWorkResult(marked);
      if (Result.isFailure(markedMapped)) return yield* Effect.fail(markedMapped.failure);
      if (subject !== undefined) {
        const base = {
          text,
          actor: { kind: "seat" as const, seatId: sentBy.success.seatId, nodeId: asNodeId(caller.nodeId) },
          opId: decoded.success.opId ?? OpId.make(ulid()),
          threadId: mailThreadOf(parent) as MailMessageId,
          inReplyTo: inReplyTo as MailMessageId,
        };
        const context = { canvas: board, canvasName: caller.canvasName, people: yield* subjectPeopleAt(board, caller.canvasName, subject) };
        const posted = yield* postSubjectComment(subjectReplyOf(subject, base), context);
        return {
          ...posted,
          inReplyTo,
          recipient: recipientOf(board, subject.nodeId),
          read: exposeWorkMutation(markedMapped.success),
          ...unlinkedField(linked),
        };
      }
      const thread = replyThreadMetadata(parent);
      const metadata = {
        factoryMail: true,
        ...mailExtensionMetadata({
          ...mailSenderStamp(board, caller, sentBy.success),
          mailKind: "notice",
          ...(decoded.success.refs === undefined ? {} : { refs: decoded.success.refs }),
        }),
        ...thread,
      };
      const result = toOperator
        ? yield* work.workOperatorReply(
            caller.canvasName,
            caller.nodeId,
            makeAgentMessage({
              messageId: ulid(),
              text,
              contextId: caller.canvasName,
              metadata: { ...metadata, toNodeId: "operator" },
            }),
            sentBy.success,
          )
        : yield* work.workMessageAppend(
            caller.canvasName,
            decoded.success.target,
            null,
            makeUserMessage({ messageId: ulid(), text, contextId: caller.canvasName, metadata }),
            sentBy.success,
          );
      const mapped = fromWorkResult(result);
      if (Result.isFailure(mapped)) return yield* Effect.fail(mapped.failure);
      return {
        ...exposeWorkMutation(mapped.success),
        ...thread,
        recipient: toOperator ? OPERATOR_RECIPIENT : recipientOf(board, target),
        read: exposeWorkMutation(markedMapped.success),
        ...unlinkedField(linked),
      };
    }).pipe(Effect.mapError(workFailure)),
  }),
);
