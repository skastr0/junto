/**
 * One companion connection: the stdio side of junto-companion/1.
 *
 * `hello` goes out before any request is read. Requests are pipelined and each
 * response is written as soon as its host call settles. What the phone has
 * asked for becomes what it follows, and the host's change notifications
 * become events, whoever made the change (the phone, the desktop, an agent):
 *
 *   canvases.list   canvases.changed when the list differs
 *   machines.list   machines.changed when the list differs
 *   feed.subscribe  feed.changed per canvas that differs; signal.changed per upsert
 *   seats.list      seat.changed per seat that differs; seat.removed
 *   seat.get        that seat: seat.changed, preamble, signal.changed, mail.changed
 *   mail.list       mail.changed for that seat (new mail, delivery changes)
 *   threads.list    thread.changed per thread of that seat that differs: new
 *   thread.get        mail, a read from any surface, a new title
 *   canvas.open     canvas.changed for that canvas, numbered on from the open's seq
 *
 * A channel silent for two minutes is closed.
 *
 * The host is the running app (relayed over the operator socket) or the
 * built-in demo; the session does not know which.
 */

import type { AgentSignal } from "./agent-signals";
import {
  COMPANION_IDLE_CLOSE_MS,
  COMPANION_PROTOCOL,
  companionConnectionErrorLine,
  companionEvent,
  companionFail,
  decodeCompanionRequestLine,
  encodeCompanionFrame,
  COMPANION_MAIL_MAX_LIMIT,
  type CompanionCanvasNode,
  type CompanionCanvasWire,
  type CompanionError,
  type CompanionHello,
  type CompanionMachine,
  type CompanionMail,
  type CompanionSeatDetail,
  type CompanionRequestFrame,
  type CompanionResponseFrame,
  type CompanionSeat,
  type CompanionThreadSummary,
} from "./companion-protocol";
import type { CompanionArtifactChanged, CompanionCommentSubject } from "./wire/companion-artifacts";
import type { OperatorFeed } from "./operator-feed";

export type CompanionChange = {
  readonly cursor: string;
  /** Something the feed or a seat reads may have changed. */
  readonly changed: boolean;
  /** Signal upserts since the cursor, oldest first. */
  readonly signals: ReadonlyArray<AgentSignal>;
  /** Artifact changes since the cursor, oldest first: the host sends them only to a connection that asked. */
  readonly artifacts?: ReadonlyArray<CompanionArtifactChanged>;
  /** The cursor was not recognized (app restarted): refresh everything. */
  readonly reset: boolean;
};

export type CompanionHost = {
  readonly hello: () => Promise<
    { readonly ok: true; readonly hello: CompanionHello } | { readonly ok: false; readonly error: CompanionError }
  >;
  readonly call: (frame: CompanionRequestFrame) => Promise<CompanionResponseFrame>;
  /** Resolves on the next change after `cursor`, or after `waitMs` with `changed: false`. */
  readonly waitChange: (cursor: string | undefined, waitMs: number) => Promise<CompanionChange>;
};

export type CompanionSessionIo = {
  readonly lines: AsyncIterable<string>;
  readonly write: (line: string) => void;
  readonly host: CompanionHost;
  readonly idleCloseMs?: number;
  /** Long-poll window for change notifications. */
  readonly waitMs?: number;
};

/** A feed with its clock fields zeroed: two feeds that say the same thing compare equal. */
const feedKey = (feed: OperatorFeed): string =>
  JSON.stringify({
    ...feed,
    generatedAt: 0,
    sections: feed.sections.map((section) => ({
      ...section,
      items: section.items.map((item) => ({ ...item, ageMs: 0 })),
    })),
  });

const seatKey = (seat: CompanionSeat): string => JSON.stringify(seat);

/**
 * A check's age grows on its own, so ages are not a change; a newer check is
 * (its age is smaller than the one sent), and so is anything else that differs.
 */
const machinesDiffer = (sent: ReadonlyArray<CompanionMachine>, next: ReadonlyArray<CompanionMachine>): boolean => {
  const ageless = (machine: CompanionMachine): string => {
    const { lastCheck, ...rest } = machine;
    return JSON.stringify(lastCheck === undefined ? rest : { ...rest, lastCheck: { ...lastCheck, checkedAgoMs: 0 } });
  };
  if (sent.length !== next.length) return true;
  return next.some((machine, index) => {
    const before = sent[index]!;
    if (ageless(before) !== ageless(machine)) return true;
    return machine.lastCheck !== undefined && before.lastCheck !== undefined && machine.lastCheck.checkedAgoMs < before.lastCheck.checkedAgoMs;
  });
};

/** Seats whose threads one connection follows at once; following one more drops the oldest. */
const THREAD_FOCUS_MAX = 8;

type Next = { readonly kind: "line"; readonly line: string } | { readonly kind: "end" } | { readonly kind: "idle" };

export const runCompanionSession = async (io: CompanionSessionIo): Promise<void> => {
  const idleMs = io.idleCloseMs ?? COMPANION_IDLE_CLOSE_MS;
  const waitMs = io.waitMs ?? 25_000;
  let open = true;
  const write = (line: string): void => {
    if (open) io.write(line);
  };

  // Start reading before anything is awaited: a phone pipelines its first
  // requests right behind the connection, and a line stream that is not yet
  // being iterated drops what it has already read.
  const iterator = io.lines[Symbol.asyncIterator]();

  const hello = await io.host.hello().catch(() => ({
    ok: false as const,
    error: { code: "app-not-running" as const, message: "Junto is not open on the Mac." },
  }));
  if (!hello.ok) {
    write(companionConnectionErrorLine(hello.error.code, hello.error.message));
    void iterator.return?.();
    return;
  }
  write(encodeCompanionFrame(companionEvent("hello", hello.hello)));

  // --- subscriptions and events ---------------------------------------------
  // What this connection asked to follow, and what it was last sent. A seat
  // is tracked once however it is followed (a seats.list canvas, the seat.get
  // focus), so one change is one seat.changed.
  let feedSubscription: { readonly canvasName: string | undefined } | undefined;
  const sentFeeds = new Map<string, string>();
  let canvasesKey: string | undefined;
  let machinesSent: ReadonlyArray<CompanionMachine> | undefined;
  const seatCanvases = new Map<string, Set<string>>();
  const sentSeats = new Map<string, string>();
  let focus: { readonly canvasName: string; readonly nodeId: string; readonly preambles: Set<string> } | undefined;
  let mailFocus: { readonly canvasName: string; readonly nodeId: string; readonly sent: Map<string, string> } | undefined;
  /** Seats whose threads this connection listed or opened, by seat ref: each thread summary as last sent. The newest few. */
  const threadFocus = new Map<string, { readonly canvasName: string; readonly nodeId: string; readonly sent: Map<string, string> }>();
  /** The comments list this connection has open: its subject, and the answer it last sent. */
  /** The canvas whose artifact changes this connection follows, from `artifacts.subscribe`. */
  let artifactsCanvas: string | undefined;
  let commentsFocus:
    | { readonly canvasName: string; readonly subject: CompanionCommentSubject; readonly sent: string }
    | undefined;
  // The open canvas, as last sent: each node and wire by id. Its seq counts
  // per connection, so the phone reads any number but the next as a gap.
  let canvasSeq = 0;
  let canvasFocus:
    | { readonly canvasName: string; readonly nodes: Map<string, string>; readonly wires: Map<string, string> }
    | undefined;
  let eventLoop: Promise<void> | undefined;
  let internalId = 0;
  const seatRef = (canvasName: string, nodeId: string): string => `${canvasName}\u0000${nodeId}`;
  const internal = <Op extends CompanionRequestFrame["op"]>(op: Op, args: object): CompanionRequestFrame =>
    ({ v: COMPANION_PROTOCOL, type: "request", id: `_event.${(internalId += 1)}`, op, args }) as CompanionRequestFrame;
  const emit = <E extends Parameters<typeof companionEvent>[0]>(event: E, data: Parameters<typeof companionEvent<E>>[1]): void =>
    write(encodeCompanionFrame(companionEvent(event, data)));

  /** Record a seat; true when it differs from what was last sent. */
  const noteSeat = (canvasName: string, seat: CompanionSeat): boolean => {
    const ref = seatRef(canvasName, seat.nodeId);
    const key = seatKey(seat);
    if (sentSeats.get(ref) === key) return false;
    sentSeats.set(ref, key);
    return true;
  };
  const seatOnly = (detail: CompanionSeatDetail): CompanionSeat => {
    const { briefing: _b, preambles: _p, signals: _s, activity: _a, connected: _c, ...seat } = detail;
    return seat;
  };
  const mailKey = (message: CompanionMail): string => JSON.stringify(message);
  const keyed = <A>(items: ReadonlyArray<A>, id: (item: A) => string): Map<string, string> =>
    new Map(items.map((item) => [id(item), JSON.stringify(item)] as const));
  const nodeIdOf = (node: CompanionCanvasNode): string => node.nodeId;
  const wireIdOf = (wire: CompanionCanvasWire): string => wire.wireId;
  /** What differs from what was sent, whole, and what is gone. */
  const delta = <A>(items: ReadonlyArray<A>, id: (item: A) => string, sent: Map<string, string>) => {
    const next = keyed(items, id);
    const changed = items.filter((item) => sent.get(id(item)) !== next.get(id(item)));
    const removed = [...sent.keys()].filter((key) => !next.has(key));
    return { next, changed, removed };
  };

  const followMail = async (canvasName: string, nodeId: string): Promise<void> => {
    const sent = new Map<string, string>();
    const response = await io.host.call(internal("mail.list", { canvasName, nodeId, limit: COMPANION_MAIL_MAX_LIMIT }));
    if (response.ok && "messages" in response.result && !("cut" in response.result)) {
      for (const message of response.result.messages) sent.set(message.messageId, mailKey(message));
    }
    // Only a seeded focus is followed, so a refresh never replays the history.
    mailFocus = { canvasName, nodeId, sent };
  };

  /** A seat's newest page of threads; "gone" when the seat is, undefined when the host could not say. */
  const seatThreads = async (
    canvasName: string,
    nodeId: string,
  ): Promise<ReadonlyArray<CompanionThreadSummary> | "gone" | undefined> => {
    const response = await io.host.call(internal("threads.list", { canvasName, nodeId }));
    if (!response.ok) return response.error.code === "not-found" ? "gone" : undefined;
    // The answer to a threads.list frame is a threads.list result.
    return "threads" in response.result ? (response.result.threads as ReadonlyArray<CompanionThreadSummary>) : undefined;
  };

  /**
   * Follow a seat's threads from what the phone was just answered. Its newest
   * page is read again at once: a thread the phone holds that changed since
   * goes out now, one it was never sent is only noted. Following another seat
   * drops the oldest past the cap.
   */
  const followThreads = async (canvasName: string, nodeId: string, answered: ReadonlyArray<CompanionThreadSummary>): Promise<void> => {
    const ref = seatRef(canvasName, nodeId);
    const followed = threadFocus.get(ref);
    if (followed !== undefined) {
      for (const thread of answered) followed.sent.set(thread.threadId, JSON.stringify(thread));
      return;
    }
    const sent = keyed(answered, (thread) => thread.threadId);
    threadFocus.set(ref, { canvasName, nodeId, sent });
    for (const held of [...threadFocus.keys()].slice(0, Math.max(0, threadFocus.size - THREAD_FOCUS_MAX))) threadFocus.delete(held);
    const threads = await seatThreads(canvasName, nodeId);
    if (threads === undefined || threads === "gone") return;
    for (const thread of threads) {
      const key = JSON.stringify(thread);
      const held = sent.get(thread.threadId);
      if (held === key) continue;
      sent.set(thread.threadId, key);
      if (held !== undefined) emit("thread.changed", { canvasName, nodeId, thread });
    }
  };

  const refresh = async (signals: ReadonlyArray<AgentSignal>, artifacts: ReadonlyArray<CompanionArtifactChanged> = []): Promise<void> => {
    for (const change of artifacts) {
      if (artifactsCanvas !== undefined && change.canvasName === artifactsCanvas) emit("artifact.changed", change);
    }
    // signal.changed: every upsert, whoever made it, for a subscribed feed or the focused seat.
    for (const signal of signals) {
      const inFeed =
        feedSubscription !== undefined &&
        (feedSubscription.canvasName === undefined || feedSubscription.canvasName === signal.canvasName);
      const onFocus = focus !== undefined && focus.canvasName === signal.canvasName && focus.nodeId === signal.nodeId;
      if (inFeed || onFocus) emit("signal.changed", { signal });
    }
    if (canvasesKey !== undefined) {
      const response = await io.host.call(internal("canvases.list", {}));
      if (response.ok && "canvases" in response.result) {
        const key = JSON.stringify(response.result.canvases);
        if (key !== canvasesKey) {
          canvasesKey = key;
          emit("canvases.changed", { canvases: response.result.canvases });
        }
      }
    }
    if (machinesSent !== undefined) {
      const response = await io.host.call(internal("machines.list", {}));
      if (response.ok && "machines" in response.result && machinesDiffer(machinesSent, response.result.machines)) {
        machinesSent = response.result.machines;
        emit("machines.changed", { machines: response.result.machines });
      }
    }
    if (feedSubscription) {
      const filter = feedSubscription.canvasName;
      const response = await io.host.call(internal("feed.get", filter === undefined ? {} : { canvasName: filter }));
      if (response.ok && "feeds" in response.result) {
        for (const feed of response.result.feeds) {
          const key = feedKey(feed);
          if (sentFeeds.get(feed.canvasName) === key) continue;
          sentFeeds.set(feed.canvasName, key);
          emit("feed.changed", { feed });
        }
      }
    }
    for (const [canvasName, members] of seatCanvases) {
      const response = await io.host.call(internal("seats.list", { canvasName }));
      if (!response.ok || !("seats" in response.result)) continue;
      const present = new Set<string>();
      for (const seat of response.result.seats) {
        present.add(seat.nodeId);
        members.add(seat.nodeId);
        if (noteSeat(canvasName, seat)) emit("seat.changed", { canvasName, seat });
      }
      for (const nodeId of [...members]) {
        if (present.has(nodeId)) continue;
        members.delete(nodeId);
        sentSeats.delete(seatRef(canvasName, nodeId));
        emit("seat.removed", { canvasName, nodeId });
      }
    }
    if (focus) {
      const { canvasName, nodeId, preambles } = focus;
      const response = await io.host.call(internal("seat.get", { canvasName, nodeId }));
      if (response.ok && "seat" in response.result) {
        const detail = response.result.seat;
        const seat = seatOnly(detail);
        if (noteSeat(canvasName, seat)) emit("seat.changed", { canvasName, seat });
        for (const preamble of [...detail.preambles].reverse()) {
          if (preambles.has(preamble.preambleId)) continue;
          preambles.add(preamble.preambleId);
          emit("preamble", { canvasName, nodeId, preamble });
        }
      } else if (!response.ok && response.error.code === "not-found") {
        focus = undefined;
        if (!seatCanvases.get(canvasName)?.has(nodeId)) emit("seat.removed", { canvasName, nodeId });
        sentSeats.delete(seatRef(canvasName, nodeId));
      }
    }
    if (canvasFocus) {
      const { canvasName } = canvasFocus;
      const response = await io.host.call(internal("canvas.open", { canvasName }));
      if (response.ok && "wires" in response.result && canvasFocus?.canvasName === canvasName) {
        const nodes = delta(response.result.nodes, nodeIdOf, canvasFocus.nodes);
        const wires = delta(response.result.wires, wireIdOf, canvasFocus.wires);
        if (nodes.changed.length + nodes.removed.length + wires.changed.length + wires.removed.length > 0) {
          canvasFocus = { canvasName, nodes: nodes.next, wires: wires.next };
          canvasSeq += 1;
          emit("canvas.changed", {
            canvasName,
            seq: canvasSeq,
            nodes: nodes.changed,
            wires: wires.changed,
            removedNodes: nodes.removed,
            removedWires: wires.removed,
          });
        }
      } else if (!response.ok && response.error.code === "not-found" && canvasFocus?.canvasName === canvasName) {
        canvasFocus = undefined;
      }
    }
    if (commentsFocus) {
      const { canvasName, subject, sent } = commentsFocus;
      const response = await io.host.call(internal("comments.list", { canvasName, subject }));
      if (response.ok && "threads" in response.result) {
        const key = JSON.stringify(response.result);
        if (key !== sent && commentsFocus?.canvasName === canvasName) {
          commentsFocus = { canvasName, subject, sent: key };
          emit("comments.changed", { canvasName, subject });
        }
      } else if (!response.ok && response.error.code === "not-found" && commentsFocus?.canvasName === canvasName) {
        commentsFocus = undefined;
      }
    }
    for (const [ref, { canvasName, nodeId, sent }] of threadFocus) {
      const threads = await seatThreads(canvasName, nodeId);
      if (threads === "gone") {
        threadFocus.delete(ref);
        continue;
      }
      if (threads !== undefined) {
        for (const thread of [...threads].reverse()) {
          const key = JSON.stringify(thread);
          if (sent.get(thread.threadId) === key) continue;
          sent.set(thread.threadId, key);
          emit("thread.changed", { canvasName, nodeId, thread });
        }
      }
    }
    if (mailFocus) {
      const { canvasName, nodeId, sent } = mailFocus;
      const response = await io.host.call(internal("mail.list", { canvasName, nodeId, limit: COMPANION_MAIL_MAX_LIMIT }));
      if (response.ok && "messages" in response.result && !("cut" in response.result)) {
        for (const message of [...response.result.messages].reverse()) {
          const key = mailKey(message);
          if (sent.get(message.messageId) === key) continue;
          sent.set(message.messageId, key);
          emit("mail.changed", { canvasName, nodeId, message });
        }
      }
    }
  };

  const subscribed = (): boolean =>
    feedSubscription !== undefined ||
    canvasesKey !== undefined ||
    machinesSent !== undefined ||
    seatCanvases.size > 0 ||
    focus !== undefined ||
    mailFocus !== undefined ||
    threadFocus.size > 0 ||
    commentsFocus !== undefined ||
    artifactsCanvas !== undefined ||
    canvasFocus !== undefined;

  const runEvents = async (): Promise<void> => {
    let cursor: string | undefined;
    while (open && subscribed()) {
      let change: CompanionChange;
      try {
        change = await io.host.waitChange(cursor, waitMs);
      } catch {
        // The app went away mid-poll; the next request will say so.
        return;
      }
      if (!open) return;
      const first = cursor === undefined;
      cursor = change.cursor;
      // The first cursor may already count a change made while the phone's
      // answer was on its way: read once against what was sent, then wait.
      if (first || change.changed || change.reset || change.signals.length > 0) {
        await refresh(change.signals, change.artifacts ?? []).catch(() => undefined);
      }
    }
  };
  const ensureEvents = (): void => {
    if (eventLoop === undefined && subscribed()) {
      eventLoop = runEvents().finally(() => {
        eventLoop = undefined;
      });
    }
  };

  // --- requests ---------------------------------------------------------------
  const pending = new Set<Promise<void>>();
  const handle = async (frame: CompanionRequestFrame): Promise<void> => {
    let response: CompanionResponseFrame;
    try {
      response = await io.host.call(frame);
    } catch {
      response = companionFail(frame.id, { code: "app-not-running", message: "Junto is not open on the Mac." });
    }
    if (response.ok) {
      if (frame.op === "feed.subscribe" && "feeds" in response.result) {
        feedSubscription = { canvasName: frame.args.canvasName };
        sentFeeds.clear();
        for (const feed of response.result.feeds) sentFeeds.set(feed.canvasName, feedKey(feed));
      } else if (frame.op === "feed.unsubscribe") {
        feedSubscription = undefined;
        sentFeeds.clear();
      } else if (frame.op === "canvases.list" && "canvases" in response.result) {
        canvasesKey = JSON.stringify(response.result.canvases);
      } else if (frame.op === "machines.list" && "machines" in response.result) {
        machinesSent = response.result.machines;
      } else if (frame.op === "seats.list" && "seats" in response.result) {
        const members = new Set<string>();
        for (const seat of response.result.seats) {
          members.add(seat.nodeId);
          noteSeat(frame.args.canvasName, seat);
        }
        seatCanvases.set(frame.args.canvasName, members);
      } else if (frame.op === "seat.get" && "seat" in response.result) {
        const { canvasName, nodeId } = frame.args;
        const detail = response.result.seat;
        noteSeat(canvasName, seatOnly(detail));
        focus = { canvasName, nodeId, preambles: new Set(detail.preambles.map((preamble) => preamble.preambleId)) };
      } else if (frame.op === "canvas.open" && "wires" in response.result) {
        const scene = response.result;
        canvasSeq += 1;
        canvasFocus = {
          canvasName: frame.args.canvasName,
          nodes: keyed(scene.nodes, nodeIdOf),
          wires: keyed(scene.wires, wireIdOf),
        };
        response = { ...response, result: { ...scene, seq: canvasSeq } };
      } else if (frame.op === "canvas.close" && canvasFocus?.canvasName === frame.args.canvasName) {
        canvasFocus = undefined;
      } else if (frame.op === "threads.read" && "thread" in response.result) {
        // The phone has the thread as its read left it: no echo of its own read.
        threadFocus.get(seatRef(frame.args.canvasName, frame.args.nodeId))?.sent.set(response.result.thread.threadId, JSON.stringify(response.result.thread));
      } else if (frame.op === "artifacts.subscribe") {
        artifactsCanvas = frame.args.canvasName;
      } else if (frame.op === "artifacts.unsubscribe") {
        artifactsCanvas = undefined;
      } else if (frame.op === "comments.list" && "threads" in response.result) {
        commentsFocus = { canvasName: frame.args.canvasName, subject: frame.args.subject, sent: JSON.stringify(response.result) };
      }
    }
    write(encodeCompanionFrame(response));
    // The phone's page may be short; follow from the whole recent history so
    // an older message is never mistaken for a new one.
    if (response.ok && (frame.op === "seat.get" || frame.op === "mail.list")) {
      await followMail(frame.args.canvasName, frame.args.nodeId).catch(() => undefined);
    }
    if (response.ok && (frame.op === "threads.list" || frame.op === "thread.get")) {
      // The answer to a threads.list frame is a threads.list result.
      const answered = frame.op === "threads.list" && "threads" in response.result ? (response.result.threads as ReadonlyArray<CompanionThreadSummary>) : [];
      await followThreads(frame.args.canvasName, frame.args.nodeId, answered).catch(() => undefined);
    }
    ensureEvents();
  };

  const next = (): Promise<Next> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ kind: "idle" }), idleMs);
      void iterator.next().then(
        (step) => {
          clearTimeout(timer);
          resolve(step.done ? { kind: "end" } : { kind: "line", line: step.value });
        },
        () => {
          clearTimeout(timer);
          resolve({ kind: "end" });
        },
      );
    });

  try {
    for (;;) {
      const step = await next();
      if (step.kind !== "line") break;
      const line = step.line.replace(/\r$/u, "");
      if (line.trim() === "") continue;
      const decoded = decodeCompanionRequestLine(line);
      if (decoded._tag === "Failure") {
        const failure = decoded.failure;
        write(
          failure.id === ""
            ? companionConnectionErrorLine(failure.error.code, failure.error.message)
            : encodeCompanionFrame(companionFail(failure.id, failure.error)),
        );
        if (failure.close) break;
        continue;
      }
      const flight = handle(decoded.success);
      pending.add(flight);
      void flight.finally(() => pending.delete(flight));
    }
  } finally {
    await Promise.allSettled([...pending]);
    open = false;
    void iterator.return?.();
  }
};
