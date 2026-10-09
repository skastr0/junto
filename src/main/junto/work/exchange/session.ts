/**
 * The row exchange over open links (docs/machines.md, rules 4 to 7).
 *
 * The same code runs at both ends of a link. On open, each end says how far it
 * is caught up; each answers with the rows the other lacks and is entitled to;
 * after that a local commit is pushed to every open link. Nothing here knows
 * which end opened the link, and nothing about a peer is kept once its link
 * closes.
 */
import { Effect, Result, Semaphore } from "effect";
import type { InstallationId } from "@shared/installation-id";
import type { Message } from "@shared/work-model";
import {
  EXCHANGE_MAX_FACTS_PER_FRAME,
  compareSequence,
  decodeExchangeFrame,
  entitledTo,
  type CanvasPlacement,
  type ExchangeFrame,
  type HaveFrame,
} from "@shared/work-exchange";
import type { WorkRepositoryShape } from "../repository";

/** One open link, as the exchange sees it: who is there and how to send. */
export type ExchangeLink = {
  readonly peer: InstallationId;
  readonly send: (frame: ExchangeFrame) => Effect.Effect<void>;
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
};

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
};

type LinkState = {
  readonly link: ExchangeLink;
  /** `canvas`, then `writer`, to the sequence the peer is caught up through. */
  readonly have: Map<string, Map<InstallationId, string>>;
  readonly turn: Semaphore.Semaphore;
};

const closed = (cause: unknown): ExchangeClosed =>
  new ExchangeClosed(cause instanceof Error ? cause.message : String(cause));

export const makeRowExchange = (deps: RowExchangeDeps) => {
  const links = new Map<InstallationId, LinkState>();

  /** How far this machine is caught up, on the canvases that peer holds too and no other. */
  const haveFrameFor = (peer: InstallationId): Effect.Effect<HaveFrame, ExchangeClosed> =>
    Effect.gen(function* () {
      const canvases = [];
      for (const canvasName of yield* deps.canvases) {
        const placement = yield* deps.placement(canvasName);
        if (placement === undefined || !placement.holds(peer)) continue;
        canvases.push({ canvasName, writers: yield* deps.repository.exchangeHave(canvasName) });
      }
      return { kind: "have" as const, canvases };
    }).pipe(Effect.mapError(closed));

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
          yield* state.link.send({ kind: "rows", canvasName, writer, facts, through: page.through });
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
              state.have.set(canvas.canvasName, new Map(canvas.writers.map((entry) => [entry.writer, entry.through])));
            }
            for (const canvasName of state.have.keys()) yield* offer(state, canvasName);
          }),
        );
        return;
      }
      const applied = yield* deps.repository
        .applyExchangeRows({ peer, frame, placement: yield* deps.placement(frame.canvasName) })
        .pipe(Effect.mapError(closed));
      for (const mail of applied.mail) deps.mailArrived(mail.canvasName, mail.nodeId, mail.message);
      // Rows taken from one machine go on to the others entitled to them.
      if (applied.taken > 0) yield* committed(frame.canvasName, peer);
    });

  /** A local commit, or rows just taken, on a canvas: push to every other open link. */
  const committed = (canvasName: string, except?: InstallationId): Effect.Effect<void, ExchangeClosed> =>
    Effect.forEach(
      [...links.values()].filter((state) => state.link.peer !== except),
      (state) => inTurn(state, offer(state, canvasName)),
      { discard: true },
    );

  return {
    /** A link opened: remember it and say how far this machine is caught up. */
    opened: (link: ExchangeLink): Effect.Effect<void, ExchangeClosed> =>
      Effect.gen(function* () {
        links.set(link.peer, { link, have: new Map(), turn: Semaphore.makeUnsafe(1) });
        yield* link.send(yield* haveFrameFor(link.peer));
      }),
    closed: (peer: InstallationId): void => {
      links.delete(peer);
    },
    receive,
    committed: (canvasName: string) => committed(canvasName),
    /** Is a link open to that machine right now. */
    linked: (peer: InstallationId): boolean => links.has(peer),
    status: (): ReadonlyArray<ExchangeLinkStatus> =>
      [...links.values()].map((state) => ({
        peer: state.link.peer,
        caughtUp: [...state.have].flatMap(([canvasName, writers]) =>
          [...writers].map(([writer, through]) => ({ canvasName, writer, through })),
        ),
      })),
  };
};

export type RowExchange = ReturnType<typeof makeRowExchange>;
