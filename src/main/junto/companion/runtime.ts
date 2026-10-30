import type { Effect, ManagedRuntime } from "effect";
import type { AgentSignal } from "@shared/agent-signals";
import type { CoreRuntime } from "../../core-runtime";

/**
 * Where the phone companion runs its effects and shows a signal it answered:
 * the core it is bound to at boot. In Electron main that is the app runtime
 * and the windows; in the core process it is the core and the push to main.
 * A phone request reads and writes in the core and never waits on main.
 */

/** What a core provides to an effect. */
export type CompanionServices = CoreRuntime extends ManagedRuntime.ManagedRuntime<infer R, infer _E> ? R : never;

export type CompanionHost = {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, CompanionServices>) => Promise<A>;
  /** A signal the operator answered from the phone, for every window. */
  readonly showSignal: (signal: AgentSignal) => void;
};

let bound: CompanionHost | undefined;

/** Boot only: the core the companion runs in. */
export const bindCompanionHost = (host: CompanionHost): (() => void) => {
  bound = host;
  return () => {
    if (bound === host) bound = undefined;
  };
};

export const CompanionRuntime = {
  runPromise: <A, E>(effect: Effect.Effect<A, E, CompanionServices>): Promise<A> =>
    bound === undefined ? Promise.reject(new Error("the phone companion has no core")) : bound.runPromise(effect),
};

export const showCompanionSignal = (signal: AgentSignal): void => {
  bound?.showSignal(signal);
};
