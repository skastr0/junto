/**
 * The auto cache mode's question, for the seat's open terminal view: a
 * service of the window's runtime (src/window/rpc/runtime.ts), built once at
 * boot. It follows `SeatCacheDueFollow` for as long as the runtime lives; the
 * stream opens with the whole list and sends it whole after each change, so
 * no read races a change. Never writes the canvas. It imports no runtime
 * module: the runtime builds it.
 */
import { observable, type Observable } from "@legendapp/state";
import { Context, Effect, Layer, Stream } from "effect";
import type { SeatCacheDueAnswer } from "@shared/seat-cache-due";
import type { SeatCacheDue as SeatCacheDueSchema, SeatCacheDueAnswerResult as AnswerResultSchema } from "../../contract/core/seat-cache-due";
import { SeatCacheDueWindow } from "../../contract/window/seat-cache-due";

/** A seat due the question, as the core's group answers it. */
export type SeatCacheDue = typeof SeatCacheDueSchema.Type;
export type SeatCacheDueAnswerResult = typeof AnswerResultSchema.Type;

export const keyOf = (canvasName: string, seatId: string): string => `${canvasName}\u0000${seatId}`;

/** The seats due the question, keyed by canvas and seat. */
export const byKeyOf = (due: ReadonlyArray<SeatCacheDue>): Record<string, SeatCacheDue> => {
  const byKey: Record<string, SeatCacheDue> = {};
  for (const ask of due) byKey[keyOf(ask.canvasName, ask.seatId)] = ask;
  return byKey;
};

const UNREACHABLE = "Junto could not reach this seat's machine.";

export class SeatCacheDueState extends Context.Service<SeatCacheDueState, {
  readonly byKey$: Observable<Record<string, SeatCacheDue | undefined>>;
  /**
   * The operator's answer to the question the seat is asked now, named by
   * its id. A refusal and a lost link both answer with a sentence.
   */
  readonly answer: (canvasName: string, seatId: string, answer: SeatCacheDueAnswer) => Effect.Effect<SeatCacheDueAnswerResult>;
}>()("@junto/window/SeatCacheDueState") {
  static readonly layer = Layer.effect(
    SeatCacheDueState,
    Effect.gen(function* () {
      const due = yield* SeatCacheDueWindow;
      const byKey$ = observable<Record<string, SeatCacheDue | undefined>>({});
      // Fails soft: the band is optional chrome, and main's follow outlives a core restart.
      yield* due.SeatCacheDueFollow().pipe(
        Stream.runForEach((list) => Effect.sync(() => byKey$.set(byKeyOf(list)))),
        Effect.ignore,
        Effect.forkScoped,
      );
      return {
        byKey$,
        answer: (canvasName, seatId, answer) => {
          const question = byKey$[keyOf(canvasName, seatId)].peek()?.question;
          if (question === undefined) return Effect.succeed({ ok: false, message: "This seat is no longer asking." });
          return due.SeatCacheDueAnswer({ input: { canvasName, seatId, question, answer } }).pipe(
            Effect.catchCause(() => Effect.succeed({ ok: false as const, message: UNREACHABLE })),
          );
        },
      };
    }),
  );
}

/** "Cache expired 12m ago.", from when the window ended. */
export const cacheDueLine = (windowEndsAt: number, now: number): string => {
  const minutes = Math.floor((now - windowEndsAt) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "Cache expired just now.";
  if (minutes < 60) return `Cache expired ${minutes}m ago.`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `Cache expired ${hours}h ago.` : `Cache expired ${hours}h ${rest}m ago.`;
};
