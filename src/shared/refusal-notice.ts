/**
 * The notice a seat gets when the editing machine refuses its command (plan
 * 0.10, 02 "Refusal and rollback" point 4). The seat's own machine writes it
 * into the seat's own mailbox when its cursor covers the `ruling.refused`, as
 * an ordinary local `message.append`: from the refused resource's node, with
 * no reply command, under an id derived from (installation, opId, recipient)
 * so writing it twice writes one row. Only the root of a chain of refused
 * dependents is told, and its notice names the commands refused with it.
 *
 * Pure: no I/O, no clock.
 */
import { mailExtensionMetadata, type MailMessageId } from "./crew";
import { noticeSenderStamp } from "./mail-sender";
import { refusalErrorOf, type QueuedCommand, type RulingRefusedResult } from "./command-row";
import type { NodeId } from "./physics/schema";
import type { ResourceRef } from "./resource-command";
import {
  refusalText,
  SUBJECT_NOTICE_KEY,
  subjectNoticeId,
  subjectNoticeRow,
  type SubjectNoticeRow,
} from "./subject-notice";
import { taskRefusalWordsOf } from "./task-machine";
import type { ResourceSubject } from "./thread-subject";
import type { OpId } from "./work-ids";

/** A command of this machine's queue, as far as its chain goes. */
export type QueuedLink = { readonly opId: OpId; readonly after: ReadonlyArray<OpId> };

/**
 * The commands refused with `root`: every one whose `after` chain reaches it.
 * The editing machine refuses all of them (rule 1), so the writer knows them
 * from its own queue when the root's ruling arrives, before their own do.
 * Oldest first, the root itself left out.
 */
export const refusedWith = (root: OpId, queue: ReadonlyArray<QueuedLink>): ReadonlyArray<OpId> => {
  const reached = new Set<OpId>([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const command of queue) {
      if (reached.has(command.opId) || !command.after.some((before) => reached.has(before))) continue;
      reached.add(command.opId);
      grew = true;
    }
  }
  reached.delete(root);
  return [...reached].sort();
};

/** The thread subject of the resource a command named, when it names one item. */
export const refusalSubjectOf = (target: ResourceRef): ResourceSubject | undefined => {
  if (target.itemId === undefined) return undefined;
  switch (target.kind) {
    case "task":
      return { kind: "task", nodeId: target.nodeId, taskId: target.itemId };
    case "artifact":
      return { kind: "artifact", nodeId: target.nodeId, artifactId: target.itemId };
    // A thread's or an automation's own item has no subject thread of its own.
    case "thread":
    case "automation":
      return undefined;
  }
};

/** Words a seat reads for a resource kind: who the notice is from. */
const KIND_NAMES: { readonly [K in ResourceRef["kind"]]: string } = {
  task: "Tasks",
  artifact: "Artifacts",
  thread: "Threads",
  automation: "Automations",
};

/** The op's own kind, when it names a plain one. */
const opKindOf = (command: QueuedCommand): string | undefined => {
  const { op } = command;
  const kind = typeof op === "object" && op !== null && !Array.isArray(op) ? (op as { readonly kind?: unknown }).kind : undefined;
  return typeof kind === "string" && /^[a-z][a-z_-]{0,31}$/.test(kind) ? kind : undefined;
};

/** The command as a seat would name it: its resource kind and its op's own kind. */
export const commandWords = (command: QueuedCommand): string => {
  const kind = opKindOf(command);
  return kind === undefined ? command.target.kind : `${command.target.kind} ${kind}`;
};

/** A task's own words for what it refused (`This task is canceled, so it cannot be started`), decoded from the row's closed token. */
const domainWordsOf = (ruling: RulingRefusedResult, command: QueuedCommand): string | undefined => {
  const kind = opKindOf(command);
  return command.target.kind === "task" && kind !== undefined ? taskRefusalWordsOf(ruling.reason, ruling.expected, kind) : undefined;
};

/** What the command lost to, as a bounded token, such as `epoch:7`; anything else is left out of the text. */
export const lostToWords = (expected: string | undefined): string | undefined =>
  expected !== undefined && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/.test(expected) ? expected : undefined;

export type RefusalNoticeInput = {
  /** This machine: the writer of the refused command. */
  readonly installationId: string;
  readonly ruling: RulingRefusedResult;
  /** This machine's own command row for the ruling. */
  readonly command: QueuedCommand;
  /** This machine's unruled and ruled commands on the canvas, for the chain. */
  readonly queue: ReadonlyArray<QueuedLink>;
};

export type RefusalNotice = {
  /** The actor seat's node: whose mailbox the notice goes in. */
  readonly recipient: NodeId;
  readonly row: SubjectNoticeRow;
};

/**
 * The one notice for a refused command, or none: a dependent is told through
 * its root's notice, and only a seat has a mailbox to tell.
 */
export const refusalNoticeOf = (input: RefusalNoticeInput): RefusalNotice | undefined => {
  const { ruling, command, installationId } = input;
  if (ruling.root !== ruling.opId || ruling.actor.kind !== "seat") return undefined;
  const recipient = ruling.actor.nodeId;
  const dependents = refusedWith(ruling.opId, input.queue);
  const words = domainWordsOf(ruling, command);
  // The domain's words already say what the token says.
  const lostTo = words === undefined ? lostToWords(ruling.expected) : undefined;
  const error = refusalErrorOf(ruling);
  const text = refusalText({
    command: commandWords(command),
    error: words === undefined ? error : { ...error, message: words },
    ...(lostTo === undefined ? {} : { lostTo }),
    ...(dependents.length === 0 ? {} : { dependents }),
  });
  const from = { nodeId: command.target.nodeId, name: KIND_NAMES[command.target.kind] };
  const source = { installationId, sourceId: ruling.opId, kind: "refusal" as const, recipient };
  // The notice opens its own thread: no thread of the resource is known on this machine.
  const threadId: MailMessageId = subjectNoticeId(source);
  const subject = refusalSubjectOf(command.target);
  const row = subject === undefined
    ? {
        messageId: threadId,
        text,
        metadata: {
          factoryMail: true,
          ...mailExtensionMetadata({ ...noticeSenderStamp(from.nodeId, from.name), mailKind: "notice" }),
          [SUBJECT_NOTICE_KEY]: "refusal",
        },
      }
    : subjectNoticeRow({ ...source, subject, threadId, text, from });
  return { recipient, row };
};
