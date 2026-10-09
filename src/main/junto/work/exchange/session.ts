/**
 * The row exchange over open links (docs/machines.md, rules 2 and 4 to 7).
 *
 * The same code runs at both ends of a link. On open, each end sends the
 * copies of the canvases it edits that the other has a seat on, then says how
 * far it is caught up; each answers with the rows the other lacks and is
 * entitled to; after that a local commit is pushed to every open link.
 * Nothing here knows which end opened the link, and nothing about a peer is
 * kept once its link closes.
 *
 * A copy goes before any word about its canvas. A machine says nothing of a
 * canvas it does not hold, so it sends its own catch-up again once it has
 * taken a copy, and the machine that sent the copy sends its own after it:
 * each end then hears of the canvas only once it holds it.
 *
 * A seat's signal to the operator crosses the same way and under the same
 * law: the machine the seat lives on states the raise and a withdrawal to the
 * machine that edits the canvas, and that machine states its answer or
 * dismissal back. Each is stated again when a link opens, so one written
 * while no link was open arrives when one is.
 */
import { Effect, Result, Semaphore } from "effect";
import type { CanvasCopy } from "@shared/canvas-copy";
import type { InstallationId } from "@shared/installation-id";
import type { Message } from "@shared/work-model";
import {
  EXCHANGE_MAX_FACTS_PER_FRAME,
  EXCHANGE_MAX_SIGNALS_PER_FRAME,
  compareSequence,
  decodeExchangeFrame,
  entitledTo,
  signalStatedTo,
  type CanvasPlacement,
  type CopyRefusedFrame,
  type ExchangeFrame,
  type ExchangeSignal,
  type HaveFrame,
  type SignalsFrame,
} from "@shared/work-exchange";
import type { WorkRepositoryShape } from "../repository";

/**
 * One open link, as the exchange sees it: who is there and how to send. A
 * frame that cannot be sent ends the exchange on that link.
 */
export type ExchangeLink = {
  readonly peer: InstallationId;
  readonly send: (frame: ExchangeFrame) => Effect.Effect<void, unknown>;
};

export type RowExchangeDeps = {
  readonly self: InstallationId;
  readonly repository: Pick<
    WorkRepositoryShape,
    "exchangeHave" | "exchangeWriters" | "exchangeRows" | "applyExchangeRows"
  >;
  /** The canvases this machine holds. */
  readonly canvases: Effect.Effect<ReadonlyArray<string>>;
  /** Where the seats of a canvas live; absent when this machine does not hold it. */
  readonly placement: (canvasName: string) => Effect.Effect<CanvasPlacement | undefined>;
  /** Mail that arrived for a seat, for this machine to deliver if the seat is here. */
  readonly mailArrived: (canvasName: string, nodeId: string, message: Message) => void;
  /**
   * This machine's canvas, cut for that machine. Absent when this machine does
   * not edit the canvas or that machine has no seat on it.
   */
  readonly cutCopy: (canvasName: string, peer: InstallationId) => Effect.Effect<CanvasCopy | undefined, unknown>;
  /**
   * A copy is about to leave for the machine it was cut for. Kept before it is
   * sent: a row may state only a canvas count its writer was sent.
   */
  readonly copySent: (copy: CanvasCopy) => Effect.Effect<void, unknown>;
  /**
   * Take a copy from the machine that edits the canvas, with the texts and
   * play state it carries. `refused` when this machine already has a canvas of
   * that name which is not this one. Fails for a copy no honest machine sends.
   */
  readonly installCopy: (copy: CanvasCopy) => Effect.Effect<CopyInstalled, unknown>;
  /** The signals this machine holds for the seats of one canvas, as they stand. */
  readonly signals: (canvasName: string) => Effect.Effect<ReadonlyArray<ExchangeSignal>, unknown>;
  /**
   * Keep a signal a peer stated. `raises` when that peer is the machine the
   * seat lives on, which alone may raise it. Fails for a closing of a signal
   * this machine does not hold.
   */
  readonly takeSignal: (canvasName: string, signal: ExchangeSignal, raises: boolean) => Effect.Effect<void, unknown>;
  /** A push to a linked machine failed: the exchange on that link is over. */
  readonly linkFailed?: (peer: InstallationId, cause: ExchangeClosed) => void;
};

export type CopyInstalled =
  | { readonly installed: boolean; readonly seq: number }
  | { readonly refused: CopyRefusedFrame["reason"] };

/** A peer broke the exchange: the link must close. */
export class ExchangeClosed extends Error {
  readonly _tag = "ExchangeClosed";
}

/** How far a linked machine is caught up, as far as this machine knows. */
export type ExchangeLinkStatus = {
  readonly peer: InstallationId;
  readonly caughtUp: ReadonlyArray<{
    readonly canvasName: string;
    readonly writer: InstallationId;
    readonly through: string;
  }>;
  /** The copies this machine sent that machine on this link, by canvas, at their count. */
  readonly copies: ReadonlyArray<{ readonly canvasName: string; readonly canvasId: string; readonly seq: number }>;
  /** The copies that machine would not take, and why. */
  readonly refused: ReadonlyArray<Omit<CopyRefusedFrame, "kind">>;
  /** Counts on this live link, never a claim of terminal delivery. */
  readonly rows: ReadonlyArray<{ readonly canvasName: string; readonly sent: number; readonly taken: number }>;
};

type LinkState = {
  readonly link: ExchangeLink;
  /** `canvas`, then `writer`, to the sequence the peer is caught up through. */
  readonly have: Map<string, Map<InstallationId, string>>;
  /** The copy last sent on this link, by canvas, and the texts and play state it carried. */
  readonly copies: Map<string, { readonly canvasId: string; readonly seq: number; readonly carried: string }>;
  /** What the peer would not take, by canvas. */
  readonly refused: Map<string, Omit<CopyRefusedFrame, "kind">>;
  readonly rows: Map<string, { sent: number; taken: number }>;
  /** Each signal as last stated on this link, by canvas and signal id. */
  readonly signals: Map<string, string>;
  readonly turn: Semaphore.Semaphore;
};

/**
 * What a copy carries beside the canvas rows: guidance, the briefing,
 * references, play or pause. None of it moves the canvas count, so a copy at
 * the count already sent goes again when this differs.
 */
const carriedBy = (copy: CanvasCopy): string =>
  JSON.stringify([copy.guidance, copy.briefing ?? null, copy.references, copy.playing]);

const closed = (cause: unknown): ExchangeClosed =>
  new ExchangeClosed(cause instanceof Error ? cause.message : String(cause));

export const makeRowExchange = (deps: RowExchangeDeps) => {
  const links = new Map<InstallationId, LinkState>();

  const send = (state: LinkState, frame: ExchangeFrame): Effect.Effect<void, ExchangeClosed> =>
    state.link.send(frame).pipe(Effect.mapError(closed));

  /** How far this machine is caught up, on the canvases that peer holds too and no other. */
  const haveFrameFor = (peer: InstallationId): Effect.Effect<HaveFrame, ExchangeClosed> =>
    Effect.gen(function* () {
      const canvases = [];
      for (const canvasName of yield* deps.canvases) {
        const placement = yield* deps.placement(canvasName);
        if (placement === undefined || !placement.holds(peer)) continue;
        canvases.push({
          canvasName,
          canvasId: placement.canvasId,
          writers: yield* deps.repository.exchangeHave(canvasName),
        });
      }
      return { kind: "have" as const, canvases };
    }).pipe(Effect.mapError(closed));

  /**
   * Send a peer this machine's copy of one canvas, when there is one for it
   * and it is not the one already sent on this link: a newer count, or the
   * same count carrying other texts or play state. True when a copy went.
   */
  const sendCopy = (state: LinkState, canvasName: string): Effect.Effect<boolean, ExchangeClosed> =>
    Effect.gen(function* () {
      const copy = yield* deps.cutCopy(canvasName, state.link.peer).pipe(Effect.mapError(closed));
      if (copy === undefined) return false;
      const sent = state.copies.get(canvasName);
      const carried = carriedBy(copy);
      if (sent !== undefined && sent.canvasId === copy.canvasId) {
        if (sent.seq > copy.seq || (sent.seq === copy.seq && sent.carried === carried)) return false;
      }
      yield* deps.copySent(copy).pipe(Effect.mapError(closed));
      yield* send(state, { kind: "copy", copy });
      state.copies.set(canvasName, { canvasId: copy.canvasId, seq: copy.seq, carried });
      state.refused.delete(canvasName);
      return true;
    });

  const sendHave = (state: LinkState): Effect.Effect<void, ExchangeClosed> =>
    Effect.gen(function* () {
      yield* send(state, yield* haveFrameFor(state.link.peer));
    });

  /** Send a peer everything of one writer and canvas it lacks and is entitled to. */
  const sendWriter = (
    state: LinkState,
    canvasName: string,
    writer: InstallationId,
    placement: CanvasPlacement,
  ): Effect.Effect<void, ExchangeClosed> =>
    Effect.gen(function* () {
      const have = state.have.get(canvasName);
      if (have === undefined) return;
      for (;;) {
        const after = have.get(writer) ?? "0";
        const page = yield* deps.repository
          .exchangeRows({ canvasName, writer, after, limit: EXCHANGE_MAX_FACTS_PER_FRAME })
          .pipe(Effect.mapError(closed));
        const facts = page.rows
          .filter((row) => entitledTo(state.link.peer, row.fact, placement, row.mailAuthorNodeId))
          .map((row) => row.fact);
        if (facts.length > 0 || compareSequence(page.through, after) > 0) {
          yield* send(state, {
            kind: "rows",
            canvasName,
            canvasId: placement.canvasId,
            writer,
            facts,
            through: page.through,
          });
          const counts = state.rows.get(canvasName) ?? { sent: 0, taken: 0 };
          counts.sent += facts.length;
          state.rows.set(canvasName, counts);
          have.set(writer, page.through);
        }
        if (!page.more) return;
      }
    });

  /**
   * Offer one canvas to a peer that holds it: this machine's rows, and every
   * writer's when it edits the canvas. A peer naming a canvas it does not hold
   * is offered nothing.
   */
  const offer = (state: LinkState, canvasName: string): Effect.Effect<void, ExchangeClosed> =>
    Effect.gen(function* () {
      if (!state.have.has(canvasName)) return;
      const placement = yield* deps.placement(canvasName);
      if (placement === undefined || !placement.holds(state.link.peer)) return;
      const writers =
        placement.editor === deps.self
          ? [...new Set([deps.self, ...(yield* deps.repository.exchangeWriters(canvasName).pipe(Effect.mapError(closed)))])]
          : [deps.self];
      for (const writer of writers) {
        if (writer !== state.link.peer) yield* sendWriter(state, canvasName, writer, placement);
      }
    });

  /**
   * State to a peer the signals of one canvas it has not heard as they stand:
   * this machine's seats' raises and withdrawals to the machine that edits the
   * canvas, its own answers and dismissals to the machine each seat lives on.
   */
  const sendSignals = (state: LinkState, canvasName: string): Effect.Effect<void, ExchangeClosed> =>
    Effect.gen(function* () {
      if (!state.have.has(canvasName)) return;
      const placement = yield* deps.placement(canvasName);
      if (placement === undefined || !placement.holds(state.link.peer)) return;
      const fresh: Array<{ readonly key: string; readonly stated: string; readonly signal: ExchangeSignal }> = [];
      for (const held of yield* deps.signals(canvasName).pipe(Effect.mapError(closed))) {
        const signal = signalStatedTo(deps.self, state.link.peer, held, placement);
        if (signal === undefined) continue;
        const key = `${canvasName}::${signal.signalId}`;
        const stated = JSON.stringify(signal);
        if (state.signals.get(key) !== stated) fresh.push({ key, stated, signal });
      }
      for (let at = 0; at < fresh.length; at += EXCHANGE_MAX_SIGNALS_PER_FRAME) {
        const page = fresh.slice(at, at + EXCHANGE_MAX_SIGNALS_PER_FRAME);
        yield* send(state, {
          kind: "signals",
          canvasName,
          canvasId: placement.canvasId,
          signals: page.map((entry) => entry.signal),
        });
        for (const entry of page) state.signals.set(entry.key, entry.stated);
      }
    });

  /**
   * Signals arrived. A raise or a withdrawal is taken only from the machine
   * the seat lives on, by the machine that edits the canvas; an answer or a
   * dismissal only from the editing machine, by the seat's own machine.
   * Anything else closes the link.
   */
  const takeSignals = (state: LinkState, frame: SignalsFrame): Effect.Effect<void, ExchangeClosed> =>
    Effect.gen(function* () {
      const peer = state.link.peer;
      const placement = yield* deps.placement(frame.canvasName);
      if (placement === undefined || placement.canvasId !== frame.canvasId || !placement.holds(peer)) {
        return yield* Effect.fail(new ExchangeClosed("signals of a canvas these two machines do not share"));
      }
      for (const signal of frame.signals) {
        const home = placement.seatOf(signal.nodeId)?.machine;
        const raised = home === peer && placement.editor === deps.self;
        const closedByEditor = peer === placement.editor && home === deps.self;
        if (raised) {
          if (signal.closing !== undefined && signal.closing.state !== "withdrawn") {
            return yield* Effect.fail(new ExchangeClosed("only the machine that edits a canvas answers or dismisses a signal"));
          }
        } else if (closedByEditor) {
          if (signal.closing === undefined || signal.closing.state === "withdrawn") {
            return yield* Effect.fail(new ExchangeClosed("a seat's signal is raised and withdrawn only on its own machine"));
          }
        } else {
          return yield* Effect.fail(new ExchangeClosed("a signal from a machine that may not state it"));
        }
        yield* deps.takeSignal(frame.canvasName, signal, raised).pipe(Effect.mapError(closed));
      }
    });

  const inTurn = <A>(
    state: LinkState,
    effect: Effect.Effect<A, ExchangeClosed>,
  ): Effect.Effect<A, ExchangeClosed> => state.turn.withPermits(1)(effect);

  const receive = (peer: InstallationId, raw: unknown): Effect.Effect<void, ExchangeClosed> =>
    Effect.gen(function* () {
      const state = links.get(peer);
      if (state === undefined) return yield* Effect.fail(new ExchangeClosed("no link is open to that machine"));
      const decoded = decodeExchangeFrame(raw);
      if (Result.isFailure(decoded)) return yield* Effect.fail(new ExchangeClosed("a frame this machine does not know"));
      const frame = decoded.success;
      if (frame.kind === "have") {
        yield* inTurn(
          state,
          Effect.gen(function* () {
            // What a peer says of a canvas it does not hold is not kept: it
            // is offered nothing of it and is never reported caught up on it.
            state.have.clear();
            for (const canvas of frame.canvases) {
              const placement = yield* deps.placement(canvas.canvasName);
              if (placement === undefined || !placement.holds(peer)) continue;
              // The same name on two machines can be two canvases.
              if (placement.canvasId !== canvas.canvasId) continue;
              state.have.set(canvas.canvasName, new Map(canvas.writers.map((entry) => [entry.writer, entry.through])));
            }
            for (const canvasName of state.have.keys()) {
              yield* offer(state, canvasName);
              yield* sendSignals(state, canvasName);
            }
          }),
        );
        return;
      }
      if (frame.kind === "signals") {
        yield* inTurn(state, takeSignals(state, frame));
        return;
      }
      if (frame.kind === "copy") {
        yield* inTurn(state, takeCopy(state, frame.copy));
        return;
      }
      if (frame.kind === "copy-refused") {
        const sent = state.copies.get(frame.canvasName);
        if (sent === undefined || sent.canvasId !== frame.canvasId) {
          return yield* Effect.fail(new ExchangeClosed("a refusal of a copy this machine did not send"));
        }
        const { kind: _kind, ...refusal } = frame;
        state.refused.set(frame.canvasName, refusal);
        return;
      }
      const applied = yield* deps.repository
        .applyExchangeRows({ peer, frame, placement: yield* deps.placement(frame.canvasName) })
        .pipe(Effect.mapError(closed));
      const counts = state.rows.get(frame.canvasName) ?? { sent: 0, taken: 0 };
      counts.taken += applied.taken;
      state.rows.set(frame.canvasName, counts);
      for (const mail of applied.mail) deps.mailArrived(mail.canvasName, mail.nodeId, mail.message);
      // Rows taken from one machine go on to the others entitled to them.
      if (applied.taken > 0) yield* committed(frame.canvasName, peer);
    });

  /**
   * A copy arrived. Only the machine that edits a canvas sends its copy, and
   * only to the machine it was cut for; anything else closes the link. A copy
   * this machine cannot hold is answered, never dropped.
   */
  const takeCopy = (state: LinkState, copy: CanvasCopy): Effect.Effect<void, ExchangeClosed> =>
    Effect.gen(function* () {
      if (copy.target !== deps.self) return yield* Effect.fail(new ExchangeClosed("a copy cut for another machine"));
      if (copy.editor !== state.link.peer) {
        return yield* Effect.fail(new ExchangeClosed("only the machine that edits a canvas sends its copy"));
      }
      const outcome = yield* deps.installCopy(copy).pipe(Effect.mapError(closed));
      if ("refused" in outcome) {
        yield* send(state, {
          kind: "copy-refused",
          canvasName: copy.canvasName,
          canvasId: copy.canvasId,
          seq: copy.seq,
          reason: outcome.refused,
        });
        return;
      }
      // This machine holds the canvas now, or a newer one: say how far it is caught up on it.
      if (outcome.installed) yield* sendHave(state);
    });

  /**
   * A local commit, or rows just taken, on a canvas: push to every other open
   * link. A canvas this machine edits goes first as its copy, when it changed.
   * A link the push fails on is dropped and the others are still served.
   */
  const committed = (canvasName: string, except?: InstallationId): Effect.Effect<void> =>
    Effect.forEach(
      [...links.values()].filter((state) => state.link.peer !== except),
      (state) =>
        inTurn(
          state,
          Effect.gen(function* () {
            if (yield* sendCopy(state, canvasName)) yield* sendHave(state);
            yield* offer(state, canvasName);
            yield* sendSignals(state, canvasName);
          }),
        ).pipe(
          Effect.catch((cause) =>
            Effect.sync(() => {
              if (links.get(state.link.peer) === state) links.delete(state.link.peer);
              deps.linkFailed?.(state.link.peer, cause);
            }),
          ),
        ),
      { discard: true },
    );

  return {
    /** A link opened: remember it and say how far this machine is caught up. */
    opened: (link: ExchangeLink): Effect.Effect<void, ExchangeClosed> =>
      Effect.gen(function* () {
        const state: LinkState = {
          link,
          have: new Map(),
          copies: new Map(),
          refused: new Map(),
          rows: new Map(),
          signals: new Map(),
          turn: Semaphore.makeUnsafe(1),
        };
        links.set(link.peer, state);
        yield* inTurn(
          state,
          Effect.gen(function* () {
            for (const canvasName of yield* deps.canvases) yield* sendCopy(state, canvasName);
            yield* sendHave(state);
          }),
        );
      }),
    closed: (peer: InstallationId): void => {
      links.delete(peer);
    },
    receive,
    committed: (canvasName: string) => committed(canvasName),
    /** Is a link open to that machine right now. */
    linked: (peer: InstallationId): boolean => links.has(peer),
    /**
     * Does mail for that seat of another machine leave on an open link: one to
     * the seat's machine, or to the machine that edits the canvas and passes
     * it on. False for a seat of this machine, and for a canvas not held.
     */
    routed: (canvasName: string, nodeId: string): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const placement = yield* deps.placement(canvasName);
        const seat = placement?.seatOf(nodeId);
        if (placement === undefined || seat === undefined || seat.machine === deps.self) return false;
        return links.has(seat.machine) || (placement.editor !== deps.self && links.has(placement.editor));
      }),
    /** Whether entitled rows have not yet been handed to this live link. */
    waiting: (canvasName: string, peer: InstallationId): Effect.Effect<boolean, ExchangeClosed> => Effect.gen(function* () {
      const state = links.get(peer);
      if (state === undefined) return true;
      const placement = yield* deps.placement(canvasName);
      if (placement === undefined || !placement.holds(peer)) return false;
      const have = state.have.get(canvasName);
      if (have === undefined) return true;
      const writers = placement.editor === deps.self
        ? [...new Set([deps.self, ...(yield* deps.repository.exchangeWriters(canvasName).pipe(Effect.mapError(closed)))])]
        : [deps.self];
      for (const writer of writers) {
        if (writer === peer) continue;
        let after = have.get(writer) ?? "0";
        for (;;) {
          const page = yield* deps.repository.exchangeRows({ canvasName, writer, after, limit: EXCHANGE_MAX_FACTS_PER_FRAME }).pipe(Effect.mapError(closed));
          if (page.rows.some(row => entitledTo(peer, row.fact, placement, row.mailAuthorNodeId))) return true;
          if (!page.more) break;
          after = page.through;
        }
      }
      return false;
    }),
    status: (): ReadonlyArray<ExchangeLinkStatus> =>
      [...links.values()].map((state) => ({
        peer: state.link.peer,
        caughtUp: [...state.have].flatMap(([canvasName, writers]) =>
          [...writers].map(([writer, through]) => ({ canvasName, writer, through })),
        ),
        copies: [...state.copies].map(([canvasName, sent]) => ({ canvasName, canvasId: sent.canvasId, seq: sent.seq })),
        refused: [...state.refused.values()],
        rows: [...state.rows].map(([canvasName, counts]) => ({ canvasName, ...counts })),
      })),
  };
};

export type RowExchange = ReturnType<typeof makeRowExchange>;
