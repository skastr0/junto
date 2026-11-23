/**
 * Whether a signal's mail is here and paired, on every signal the core serves
 * a window: the list and each change carry `paired` once the seat's mail that
 * is the signal is held too and each names the other (thread-signals.ts
 * `pairedIn`). The feed shows a card's thread link only then.
 *
 * A signal can land before its mail, as a peer's sync brings them apart, and
 * the mail's arrival is no signal change. So the core hears mail too: once a
 * canvas's mail moves, its open signals not yet paired are checked again, and
 * each that pairs now is served again, marked. Once paired it stays marked.
 */
import { Effect, Option } from "effect";
import type { SqlClient } from "effect/sql";
import { ModelService } from "../model/service";
import type { AgentSignal } from "@shared/wire/agent-signals";
import { AgentSignalRepository } from "../signals/repository";
import { onAgentSignalChanged } from "../signals/changes";
import { WorkRepository } from "./repository";
import type { WorkService } from "./service";
import { canvasThreads } from "./operator-threads";
import { pairedIn, type RowOf } from "./thread-signals";

/** Per canvas, the signals known to be paired. */
const known = new Map<string, Set<string>>();

const isKnown = (signal: AgentSignal): boolean => known.get(signal.canvasName)?.has(signal.signalId) === true;

/** The signal as a window is served it: marked once its mail is paired. */
export const servedSignal = (signal: AgentSignal): AgentSignal =>
  isKnown(signal) ? { ...signal, paired: true } : signal;

/** A signal that may still pair: open, naming its mail and its thread. */
const unpaired = (signal: AgentSignal): boolean =>
  signal.state === "open" && signal.messageId !== undefined && signal.threadId !== undefined && !isKnown(signal);

/** Mark each of the canvas's signals that pairs against these rows; returns the ones newly paired. */
export const markPaired = (canvasName: string, signals: ReadonlyArray<AgentSignal>, rowOf: RowOf): ReadonlyArray<AgentSignal> => {
  const newly: AgentSignal[] = [];
  for (const signal of signals) {
    if (signal.canvasName !== canvasName || !unpaired(signal) || !pairedIn(signal, rowOf)) continue;
    let held = known.get(canvasName);
    if (held === undefined) known.set(canvasName, (held = new Set()));
    held.add(signal.signalId);
    newly.push(signal);
  }
  return newly;
};

/** Forget a canvas (a test's fresh store). */
export const forgetPaired = (canvasName?: string): void => {
  if (canvasName === undefined) known.clear();
  else known.delete(canvasName);
};

/** The canvas's mail rows as the thread index holds them; none without a mail store, or when the read fails. */
const rowsOf = (canvasName: string) =>
  Effect.gen(function* () {
    const model = yield* Effect.serviceOption(ModelService);
    const repository = yield* Effect.serviceOption(WorkRepository);
    if (Option.isNone(model) || Option.isNone(repository)) return undefined;
    return yield* canvasThreads(canvasName).pipe(
      Effect.map(({ rowOf }): RowOf | undefined => rowOf),
      Effect.provideService(ModelService, model.value),
      Effect.provideService(WorkRepository, repository.value),
      Effect.orElseSucceed(() => undefined),
    );
  });

/** Check the canvas's signals against its mail as held now; the newly paired, marked. A read that fails pairs nothing. */
export const pairSignals = (canvasName: string, signals: ReadonlyArray<AgentSignal>) =>
  Effect.gen(function* () {
    if (!signals.some(unpaired)) return [];
    const rowOf = yield* rowsOf(canvasName);
    return rowOf === undefined ? [] : markPaired(canvasName, signals, rowOf);
  });

/** The canvas's signals as served, each paired one marked. */
export const servedSignals = (canvasName: string, signals: ReadonlyArray<AgentSignal>) =>
  Effect.as(pairSignals(canvasName, signals), signals.map(servedSignal));

/**
 * Hear mail and signals, and serve again each signal that pairs; `serve`
 * sends a newly paired signal. A canvas's changes close together are one
 * check, run in the context it was started in. Without a mail store it hears
 * nothing. Returns the stop.
 */
export const watchSignalPairing = (serve: (signal: AgentSignal) => void) =>
  Effect.gen(function* () {
    const mail = yield* Effect.serviceOption(WorkRepository);
    if (Option.isNone(mail)) return () => {};
    const repository = mail.value;
    const signals = yield* AgentSignalRepository;
    const run = Effect.runForkWith(yield* Effect.context<SqlClient.SqlClient | WorkService>());
    const due = new Set<string>();
    const check = (canvasName: string): void => {
      if (due.has(canvasName)) return;
      due.add(canvasName);
      run(
        Effect.gen(function* () {
          // The thread index marks the mailbox stale on this same change; read after it.
          yield* Effect.yieldNow;
          due.delete(canvasName);
          const listed = yield* signals.listCanvas(canvasName).pipe(Effect.orElseSucceed((): ReadonlyArray<AgentSignal> => []));
          for (const signal of yield* pairSignals(canvasName, listed)) serve(servedSignal(signal));
        }),
      );
    };
    const stopMail = repository.subscribeChanges((canvasName, _nodeId, kind) => {
      if (kind !== "work") check(canvasName);
    });
    // A signal that lands after its mail pairs on its own change.
    const stopSignals = onAgentSignalChanged((signal) => {
      if (unpaired(signal)) check(signal.canvasName);
    });
    return () => {
      stopMail();
      stopSignals();
    };
  });
