/**
 * Signals as a thread reads them: the seat's mail that is a signal, the
 * operator's mail that answered one, the signal whose answer began a thread,
 * and a thread's open signal. Read from the signal store and joined to the
 * mail rows the thread index holds; nothing here is stored.
 *
 * Pairing, as remote-security set it for seats on any machine: a mail is a
 * signal only when this machine holds both, each names the other (the
 * signal's `messageId`, the row's `metadata.raisedSignalId`), the row is in
 * that seat's own mailbox and the seat wrote it, and no automation raised the
 * signal. One signal pairs with one mail at most, since each names one. Until
 * both are here the mail reads as a plain reply.
 *
 * Live: the store tells every write (`onAgentSignalChanged`), and the
 * canvas's signals are read again on the next look.
 */
import { Effect, Option } from "effect";
import { mailThreadOf } from "@shared/crew";
import { crossedClosing } from "@shared/signal-crossing";
import { isSeatRaiseKind, type AgentSignal, type SeatRaiseKind, type SignalForm } from "@shared/wire/agent-signals";
import type { MailThreadMessage, ThreadHeadSignal, ThreadSignal, ThreadSignalAsks, ThreadSignalRef } from "@shared/wire/mail-threads";
import type { Message } from "@shared/work-model";
import { onAgentSignalChanged } from "../signals/changes";
import { AgentSignalRepository } from "../signals/repository";

/** A mail row as one mailbox holds it; undefined when that mailbox holds no such row. */
export type RowOf = (nodeId: string, messageId: string) => Message | undefined;

/** The signals of one canvas, as a read joins them. */
export type ThreadSignals = {
  readonly signalOf: (signalId: string) => AgentSignal | undefined;
  /** The open signals raised in a thread, oldest first. */
  readonly openIn: (threadId: string) => ReadonlyArray<AgentSignal>;
};

const NO_SIGNALS: ThreadSignals = { signalOf: () => undefined, openIn: () => [] };

type Held = {
  readonly byId: Map<string, AgentSignal>;
  /** Ids asked for that the store does not hold for this canvas, until the next write. */
  readonly missing: Set<string>;
  readonly open: ReadonlyMap<string, ReadonlyArray<AgentSignal>>;
};

type Cache = { readonly canvases: Map<string, Held>; readonly writes: Map<string, number> };

const caches = new WeakMap<object, Cache>();

const cacheOf = (repository: object): Cache => {
  let cache = caches.get(repository);
  if (cache === undefined) {
    const made: Cache = { canvases: new Map(), writes: new Map() };
    cache = made;
    caches.set(repository, made);
    // Any write to a canvas's signals: read them again on the next look.
    onAgentSignalChanged((signal) => {
      made.canvases.delete(signal.canvasName);
      made.writes.set(signal.canvasName, (made.writes.get(signal.canvasName) ?? 0) + 1);
    });
  }
  return cache;
};

const byAge = (a: AgentSignal, b: AgentSignal): number =>
  a.createdAt - b.createdAt || (a.signalId < b.signalId ? -1 : a.signalId > b.signalId ? 1 : 0);

const openByThread = (signals: ReadonlyArray<AgentSignal>): ReadonlyMap<string, ReadonlyArray<AgentSignal>> => {
  const open = new Map<string, AgentSignal[]>();
  for (const signal of signals) {
    if (signal.state !== "open" || signal.threadId === undefined) continue;
    const held = open.get(signal.threadId);
    if (held === undefined) open.set(signal.threadId, [signal]);
    else held.push(signal);
  }
  for (const held of open.values()) held.sort(byAge);
  return open;
};

/**
 * The canvas's signals: open ones and recent history from the store, and any
 * `wanted` id beside them. Without a signal store, none.
 */
export const threadSignalsOf = (canvasName: string, wanted: Iterable<string> = []) =>
  Effect.gen(function* () {
    const store = yield* Effect.serviceOption(AgentSignalRepository);
    if (Option.isNone(store)) return NO_SIGNALS;
    const signals = store.value;
    const cache = cacheOf(signals);
    let held = cache.canvases.get(canvasName);
    if (held === undefined) {
      const before = cache.writes.get(canvasName) ?? 0;
      const listed = yield* signals.listCanvas(canvasName).pipe(Effect.orElseSucceed((): ReadonlyArray<AgentSignal> => []));
      held = { byId: new Map(listed.map((signal) => [signal.signalId, signal])), missing: new Set(), open: openByThread(listed) };
      // A write during the read: this one answers now, and the next look reads again.
      if ((cache.writes.get(canvasName) ?? 0) === before) cache.canvases.set(canvasName, held);
    }
    for (const signalId of wanted) {
      if (held.byId.has(signalId) || held.missing.has(signalId)) continue;
      const got = yield* signals.get(signalId).pipe(Effect.option);
      if (Option.isSome(got) && got.value.canvasName === canvasName) held.byId.set(signalId, got.value);
      else held.missing.add(signalId);
    }
    const view = held;
    return {
      signalOf: (signalId) => view.byId.get(signalId),
      openIn: (threadId) => view.open.get(threadId) ?? [],
    } satisfies ThreadSignals;
  });

const field = (row: Message | undefined, key: string): string | undefined => {
  const value = row?.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/** The row is the seat's own: in its mailbox, written by it, by no automation. */
const writtenBy = (row: Message | undefined, nodeId: string): row is Message =>
  row !== undefined &&
  row.role === "agent" &&
  (field(row, "senderNodeId") ?? nodeId) === nodeId &&
  row.metadata?.senderAutomationId === undefined;

/** A seat's own signal, raised by no automation, of a kind a seat raises. */
const seatSignal = (signal: AgentSignal | undefined, nodeId: string): signal is AgentSignal & { readonly kind: SeatRaiseKind } =>
  signal !== undefined && signal.nodeId === nodeId && signal.source === undefined && isSeatRaiseKind(signal.kind);

const seatTo = (entry: MailThreadMessage): string | undefined => {
  for (const party of entry.to) if (party.kind === "seat") return party.nodeId;
  return undefined;
};

/** The signal ids a thread's rows name, raised or answered: what a read asks the store for. */
export const signalIdsOf = (entries: Iterable<MailThreadMessage>, rowOf: RowOf): ReadonlyArray<string> => {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (entry.mine) {
      const seat = seatTo(entry);
      const id = seat === undefined ? undefined : field(rowOf(seat, entry.messageId), "agentSignalId");
      if (id !== undefined) ids.add(id);
    } else if (entry.from.kind === "seat") {
      const id = field(rowOf(entry.from.nodeId, entry.messageId), "raisedSignalId");
      if (id !== undefined) ids.add(id);
    }
  }
  return [...ids];
};

/** The seat's signal this mail is, paired both ways; undefined for a plain mail. */
export const raisedIn = (entry: MailThreadMessage, signals: ThreadSignals, rowOf: RowOf) => {
  if (entry.mine || entry.from.kind !== "seat") return undefined;
  const nodeId = entry.from.nodeId;
  const row = rowOf(nodeId, entry.messageId);
  if (!writtenBy(row, nodeId)) return undefined;
  const signalId = field(row, "raisedSignalId");
  const signal = signalId === undefined ? undefined : signals.signalOf(signalId);
  return seatSignal(signal, nodeId) && signal.messageId === entry.messageId ? signal : undefined;
};

/** The signal the operator's mail answered, a signal of the seat it went to. */
export const answeredIn = (entry: MailThreadMessage, signals: ThreadSignals, rowOf: RowOf) => {
  if (!entry.mine) return undefined;
  const nodeId = seatTo(entry);
  if (nodeId === undefined) return undefined;
  const signalId = field(rowOf(nodeId, entry.messageId), "agentSignalId");
  const signal = signalId === undefined ? undefined : signals.signalOf(signalId);
  return seatSignal(signal, nodeId) ? signal : undefined;
};

const asksOf = (form: SignalForm | undefined): ThreadSignalAsks | undefined =>
  form?.kind === "artifact" ? "document" : form?.kind === "proof" ? "proof" : form?.kind === "secret" ? "secret" : undefined;

const faceOf = (signal: AgentSignal & { readonly kind: SeatRaiseKind }): ThreadSignal => {
  const asks = asksOf(signal.form);
  return {
    signalId: signal.signalId,
    kind: signal.kind,
    state: signal.state,
    text: signal.text,
    ...(asks === undefined ? {} : { asks }),
    ...(crossedClosing(signal) ? { crossed: true as const } : {}),
  };
};

/**
 * The operator's mail still waits for its seat. An answer whose signal
 * crossed a withdrawal is held on the seat's machine, never typed, so its
 * receipt never comes: it waits for nothing, and the thread never promises
 * it arrives when the seat is back. The withdrawal says what happened.
 */
export const waits = (entry: MailThreadMessage, signals: ThreadSignals, rowOf: RowOf): boolean => {
  if (entry.waiting !== true) return false;
  const answered = answeredIn(entry, signals, rowOf);
  return answered === undefined || !crossedClosing(answered);
};

/** The entry with no waiting mark, when it waits for nothing. */
export const settled = (entry: MailThreadMessage, signals: ThreadSignals, rowOf: RowOf): MailThreadMessage => {
  if (entry.waiting !== true || waits(entry, signals, rowOf)) return entry;
  const { waiting: _held, ...rest } = entry;
  return rest;
};

/** A thread's messages as it reads them: each signal and each answer named. */
export const withSignals = (
  entries: ReadonlyArray<MailThreadMessage>,
  signals: ThreadSignals,
  rowOf: RowOf,
): ReadonlyArray<MailThreadMessage> =>
  entries.map((entry) => {
    const raised = raisedIn(entry, signals, rowOf);
    if (raised !== undefined) return { ...entry, signal: faceOf(raised) };
    const answered = answeredIn(entry, signals, rowOf);
    return answered === undefined
      ? entry
      : { ...settled(entry, signals, rowOf), answers: { signalId: answered.signalId, kind: answered.kind, text: answered.text } };
  });

/** The signal whose answer is the thread's root, when the root is held. */
export const headSignalOf = (
  threadId: string,
  entries: ReadonlyArray<MailThreadMessage>,
  signals: ThreadSignals,
  rowOf: RowOf,
): ThreadHeadSignal | undefined => {
  const root = entries[0];
  if (root === undefined || root.messageId !== threadId) return undefined;
  const signal = answeredIn(root, signals, rowOf);
  return signal === undefined ? undefined : { ...faceOf(signal), at: signal.createdAt };
};

/**
 * The signal and its mail are both here and paired, seen from the signal:
 * the row it names is in its seat's own mailbox, written by the seat, names
 * it back, and sits in the thread the signal says. The one rule for a
 * thread's open signal and for the feed's thread link (`paired`).
 */
export const pairedIn = (signal: AgentSignal, rowOf: RowOf): boolean => {
  if (!seatSignal(signal, signal.nodeId) || signal.messageId === undefined || signal.threadId === undefined) return false;
  const row = rowOf(signal.nodeId, signal.messageId);
  return writtenBy(row, signal.nodeId) && field(row, "raisedSignalId") === signal.signalId && mailThreadOf(row) === signal.threadId;
};

/** The earliest open signal raised in the thread, paired with its mail there. */
export const openSignalOf = (threadId: string, signals: ThreadSignals, rowOf: RowOf): ThreadSignalRef | undefined => {
  for (const signal of signals.openIn(threadId)) {
    if (signal.threadId === threadId && seatSignal(signal, signal.nodeId) && pairedIn(signal, rowOf)) {
      return { signalId: signal.signalId, kind: signal.kind, text: signal.text };
    }
  }
  return undefined;
};
