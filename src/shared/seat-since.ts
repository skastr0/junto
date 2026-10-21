import type { AgentSignal, AgentSignalKind } from "./agent-signals";
import { compareSignalListOrder } from "./agent-signals";
import { mailListMatches } from "./mail-list-filter";
import { seatMailThreadEntries, type HeldMailbox } from "./mail-threads";
import type { NodeId } from "./model/base";
import { noticeTakesReply, subjectNoticeKindOf } from "./subject-notice";
import { currentStamps } from "./task-machine";
import { formatTaskNumber, isOpenTaskState, type TaskId, type TaskNumber, type TaskState, type TaskView } from "./task-model";
import type { Message } from "./work-model";
import type { MailParty, MailThreadMessage } from "./wire/mail-threads";

/**
 * Since your last session: what a fresh session owes, waits on and missed,
 * computed at onboard from rows Junto already holds and never stored
 * (docs/plans/0.10/08-continuity.md, Contract).
 *
 * - Owed and awaited replies are thread state, with no time boundary: in
 *   each of the seat's threads in the `mail-threads.ts` derivation, the last
 *   mail the seat wrote or was written, its direction, and its `deliveredAt`
 *   and `readAt`. Mail between other seats in the same thread does not move
 *   it, nor does a notice that takes no reply (a refusal). A replaced session ends when the next starts, so a window would
 *   always be empty.
 * - A signal answer the operator mailed is mail and shows as a thread. A
 *   silent answer has no receipt, so the previous session's `started_at`
 *   bounds it.
 * - Unread is a count of the seat's own mailbox rows that `msg list --unread`
 *   would list, through the same filter, so the two never disagree.
 * - The seat's tasks are the open one it holds, with no time boundary, and
 *   any it held whose state changed since the previous session started: one
 *   it finished or that was canceled, or one sent on from its layer. Absent a
 *   previous session, every such task is listed.
 * - A review is owed on a task in review that lists the seat as a reviewer,
 *   is not its own, and has no stamp from it at the task's current epoch.
 *
 * `junto since --all` is this projection uncapped.
 */

export type SinceInput = {
  readonly seat: NodeId;
  /** Every mailbox on the canvas: sent mail lives in each recipient's. */
  readonly mailboxes: ReadonlyArray<HeldMailbox>;
  /** A node's display name, a seat's or a task node's; the node id stands in when it has none. */
  readonly nameOf: (nodeId: string) => string | undefined;
  /** The canvas's signals; only this seat's are read. */
  readonly signals: ReadonlyArray<AgentSignal>;
  /**
   * The canvas's tasks as the read holds them, each once: every open one,
   * and those changed lately. Only those the seat holds, held, or reviews
   * are read.
   */
  readonly tasks: ReadonlyArray<TaskView>;
  /**
   * Bounds silent signal answers and changed tasks. Absent on a first
   * session: no session has seen any of them, so every one is listed.
   */
  readonly previousStartedAt?: number;
  /** Epoch ms the projection is as of. */
  readonly now: number;
};

/** What a line is about, so the follow-up command is chosen by its kind. */
export type SinceRef =
  | { readonly kind: "mail"; readonly messageId: string }
  | { readonly kind: "signal"; readonly signalId: string }
  | { readonly kind: "task"; readonly taskId: TaskId; readonly number?: TaskNumber };
export type SinceLine = { readonly text: string; readonly ref: SinceRef };
export type SinceSection = {
  readonly lines: ReadonlyArray<SinceLine>;
  /** Lines past the cap, listed by `command`. */
  readonly more: number;
  readonly command: string;
};

export const SINCE_SECTIONS = [
  "owedReplies",
  "awaitingReplies",
  "openSignals",
  "answersSince",
  "yourTasks",
  "reviewsOwed",
] as const;
export type SinceSectionKey = (typeof SINCE_SECTIONS)[number];

export type Since = { readonly asOf: number; readonly unread: number } & {
  readonly [K in SinceSectionKey]: SinceSection;
};

/** Lines per section in onboard. */
export const SINCE_PER_SECTION = 8;
/** A line's quoted text, in code points as the mail composer counts, before it is cut. */
export const SINCE_QUOTE_MAX = 100;

/** The command that lists a section in full. */
export const SINCE_COMMANDS: Readonly<Record<SinceSectionKey, string>> = {
  owedReplies: "junto since --all",
  awaitingReplies: "junto since --all",
  openSignals: "junto signal list",
  // Not `signal list --since`: that bounds by when a signal was raised, so
  // it would miss one raised before the bound and answered after it.
  answersSince: "junto since --all",
  yourTasks: "junto task list --assignee me",
  reviewsOwed: "junto task list --reviewer me",
};

const KIND_WORDS: Readonly<Record<AgentSignalKind, string>> = {
  blocked: "blocked",
  escalate: "escalate",
  feedback: "feedback",
};

/** Each state as a sentence says it, after "is". Total, so a new state fails the typecheck until it is worded. */
const STATE_WORDS: Readonly<Record<TaskState, string>> = {
  backlog: "in the backlog",
  assigned: "assigned",
  working: "in progress",
  "input-required": "waiting for input",
  "in-review": "in review",
  done: "done",
  canceled: "canceled",
  archived: "archived",
};

/** One line of text, cut to {@link SINCE_QUOTE_MAX} code points, never inside a surrogate pair. */
export const sinceQuote = (text: string): string => {
  const points = [...text.replace(/\s+/gu, " ").trim()];
  return points.length <= SINCE_QUOTE_MAX ? points.join("") : `${points.slice(0, SINCE_QUOTE_MAX - 1).join("").trimEnd()}…`;
};

const partyName = (party: MailParty): string => (party.kind === "operator" ? "the operator" : party.name);

const isSeat = (party: MailParty, seat: string): boolean => party.kind === "seat" && party.nodeId === seat;

const stamp = (row: Message | undefined, key: "deliveredAt" | "readAt"): boolean => {
  const value = row?.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value);
};

/** What became of a mail: its recipient's read and delivery receipts. */
const receiptWords = (row: Message | undefined): string =>
  stamp(row, "readAt") ? "read" : stamp(row, "deliveredAt") ? "delivered, unread" : "not delivered yet";

const section = (key: SinceSectionKey, lines: ReadonlyArray<SinceLine>, cap: number): SinceSection => ({
  lines: lines.slice(0, cap),
  more: Math.max(0, lines.length - cap),
  command: SINCE_COMMANDS[key],
});

const taskRef = (task: TaskView): SinceRef =>
  task.number === undefined ? { kind: "task", taskId: task.taskId } : { kind: "task", taskId: task.taskId, number: task.number };

/** `#42 "Title"`, or the task id while its number is pending. */
const taskWords = (task: TaskView): string =>
  `${task.number === undefined ? task.taskId : formatTaskNumber(task.number)} "${sinceQuote(task.title)}"`;

/** Newest first; the task id breaks a tie. */
const byNewest = (a: { readonly at: number; readonly task: TaskView }, b: { readonly at: number; readonly task: TaskView }): number =>
  b.at - a.at || (a.task.taskId < b.task.taskId ? 1 : a.task.taskId > b.task.taskId ? -1 : 0);

/**
 * The seat's open task, then each task it held whose state changed since the
 * previous session started, newest change first.
 */
const yourTaskLines = (input: SinceInput): ReadonlyArray<SinceLine> => {
  const seat: string = input.seat;
  const changedSince = (at: number): boolean => input.previousStartedAt === undefined || at >= input.previousStartedAt;
  const nodeName = (nodeId: string): string => input.nameOf(nodeId) ?? nodeId;
  const open: SinceLine[] = [];
  const changed: Array<{ readonly at: number; readonly task: TaskView; readonly text: string }> = [];
  for (const task of input.tasks) {
    const current = task.current;
    if (current.assignee === seat) {
      const state = STATE_WORDS[current.state];
      if (isOpenTaskState(current.state)) {
        const moved = input.previousStartedAt !== undefined && task.stateSince >= input.previousStartedAt;
        open.push({
          text: moved
            ? `Your task ${taskWords(task)} is now ${state}, changed since your last session`
            : `Your task ${taskWords(task)} is ${state}`,
          ref: taskRef(task),
        });
      } else if (current.state !== "archived" && changedSince(task.stateSince)) {
        changed.push({ at: task.stateSince, task, text: `Your task ${taskWords(task)} is now ${state}, changed since your last session` });
      }
      continue;
    }
    // Sent on from the seat's layer: the layer closed, the task went on.
    const held = [...task.layers].reverse().find((layer) => layer.assignee === seat);
    if (held === undefined || !changedSince(held.closedAt) || current.state === "archived") continue;
    changed.push({
      at: held.closedAt,
      task,
      text: `Your task ${taskWords(task)} was sent on to ${nodeName(current.node)} since your last session, and is ${STATE_WORDS[current.state]} there`,
    });
  }
  return [...open, ...changed.sort(byNewest).map(({ task, text }): SinceLine => ({ text, ref: taskRef(task) }))];
};

/** Tasks in review that wait on this seat's stamp, the longest waiting first. */
const reviewOwedLines = (input: SinceInput): ReadonlyArray<SinceLine> => {
  const seat: string = input.seat;
  return input.tasks
    .filter((task) => {
      const current = task.current;
      return current.state === "in-review" &&
        current.assignee !== seat &&
        current.reviewers.some((reviewer) => reviewer.kind === "seat" && reviewer.seat === seat) &&
        !currentStamps(current).some((stamp) => stamp.reviewer.kind === "seat" && stamp.reviewer.seat === seat);
    })
    .sort((a, b) => a.stateSince - b.stateSince || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0))
    .map((task): SinceLine => {
      const assignee = task.current.assignee;
      const owner = assignee === undefined ? "A task" : `${input.nameOf(assignee) ?? assignee}'s task`;
      return { text: `${owner} ${taskWords(task)} is in review and waits on your stamp`, ref: taskRef(task) };
    });
};

/** Newest answer first; the signal id breaks a tie. */
const byAnswer = (a: AgentSignal, b: AgentSignal): number =>
  (b.response?.at ?? 0) - (a.response?.at ?? 0) || (a.signalId < b.signalId ? 1 : a.signalId > b.signalId ? -1 : 0);

export const seatSince = (input: SinceInput, caps: { readonly perSection: number }): Since => {
  const cap = Math.max(0, Math.trunc(caps.perSection));
  const seat: string = input.seat;

  // The row each thread mail is in, to read its receipts: a seat's mail sits
  // in the recipient's mailbox, a reply to the operator in the seat's own.
  const rows = new Map<string, Message>();
  for (const mailbox of input.mailboxes) for (const row of mailbox.messages) rows.set(row.messageId, row);

  // A notice that takes no reply never makes a reply owed.
  const answerable = (entry: MailThreadMessage): boolean => {
    const kind = subjectNoticeKindOf(rows.get(entry.messageId) ?? {});
    return kind === undefined || noticeTakesReply(kind);
  };

  // Each thread's last mail the seat wrote or was written, newest first.
  const lasts: MailThreadMessage[] = [];
  for (const entries of seatMailThreadEntries(input, seat).values()) {
    for (let at = entries.length - 1; at >= 0; at -= 1) {
      const entry = entries[at]!;
      if (![entry.from, ...entry.to].some((party) => isSeat(party, seat)) || !answerable(entry)) continue;
      lasts.push(entry);
      break;
    }
  }
  lasts.sort((a, b) => b.at - a.at || (a.messageId < b.messageId ? 1 : a.messageId > b.messageId ? -1 : 0));
  const owed: SinceLine[] = [];
  const awaiting: SinceLine[] = [];
  for (const last of lasts) {
    const quote = sinceQuote(last.text);
    const receipt = receiptWords(rows.get(last.messageId));
    const ref: SinceRef = { kind: "mail", messageId: last.messageId };
    if (isSeat(last.from, seat)) {
      awaiting.push({ text: `You wrote last to ${last.to.map(partyName).join(", ")}, ${receipt}: "${quote}"`, ref });
    } else {
      owed.push({ text: `${partyName(last.from)} wrote last, ${receipt}, you have not replied: "${quote}"`, ref });
    }
  }

  const mine = input.signals.filter((signal) => signal.nodeId === seat);
  const open = mine
    .filter((signal) => signal.state === "open")
    .sort(compareSignalListOrder)
    .map((signal): SinceLine => ({ text: `Open ${KIND_WORDS[signal.kind]}: "${sinceQuote(signal.text)}"`, ref: { kind: "signal", signalId: signal.signalId } }));

  const mailed = new Set<string>();
  for (const row of rows.values()) {
    const id = row.metadata?.agentSignalId;
    if (typeof id === "string") mailed.add(id);
  }
  const answers = mine
    .filter(
      (signal): signal is AgentSignal & { readonly response: NonNullable<AgentSignal["response"]> } =>
        signal.state === "answered" &&
        signal.response !== undefined &&
        (input.previousStartedAt === undefined || signal.response.at >= input.previousStartedAt) &&
        !mailed.has(signal.signalId),
    )
    .sort(byAnswer)
    .map((signal): SinceLine => ({
      text: `The operator answered your ${KIND_WORDS[signal.kind]} "${sinceQuote(signal.text)}" without mail: "${sinceQuote(signal.response.text)}"`,
      ref: { kind: "signal", signalId: signal.signalId },
    }));

  const unreadOnly = mailListMatches({ unread: true });
  const own = input.mailboxes.find((mailbox) => mailbox.nodeId === seat)?.messages ?? [];

  return {
    asOf: input.now,
    owedReplies: section("owedReplies", owed, cap),
    awaitingReplies: section("awaitingReplies", awaiting, cap),
    openSignals: section("openSignals", open, cap),
    answersSince: section("answersSince", answers, cap),
    yourTasks: section("yourTasks", yourTaskLines(input), cap),
    reviewsOwed: section("reviewsOwed", reviewOwedLines(input), cap),
    unread: own.filter(unreadOnly).length,
  };
};
