/**
 * Main's side of what the browser composition keeps in the core's database:
 * the origins a seat ran code in, and the profile registry. Main holds no SQL
 * client; each method is one call of the core's browser store group
 * (src/contract/core/browser-store.ts), and a profile transaction keeps its
 * error code as it crosses.
 *
 * The composition starts before the window exists, so a call the core left
 * without answering (it is starting again) is asked again for as long as a
 * core coming back is plausible; a refusal the core itself answered is not.
 */
import { Context, Effect, Schedule } from "effect";
import type { RpcClientError } from "effect/rpc";
import { BrowserProfileError, type BrowserProfileStore } from "../../../node/browser/profiles";
import type { BrowserTouchedOriginStore } from "../../../node/browser/touched-origins";
import { BrowserStoreCore, type BrowserProfileRefused } from "../../../contract/core/browser-store";
import { AppRuntime } from "../../runtime";
import { CORE_STARTUP_WAIT_MS } from "../wait-for-core";

/** Ask again while no core answers, every quarter second, until a starting core has had its time. */
const waitedOut = <A, E extends { readonly _tag: string }>(call: Effect.Effect<A, E | RpcClientError.RpcClientError>) =>
  call.pipe(
    Effect.retry({
      while: (error) => error._tag === "RpcClientError",
      schedule: Schedule.spaced("250 millis").pipe(Schedule.upTo({ duration: CORE_STARTUP_WAIT_MS })),
    }),
  );

/** The touched-origin store as main uses it, each method one core call, waited out while the core starts. */
export const coreTouchedOriginStore = (core: Context.Context<BrowserStoreCore>): BrowserTouchedOriginStore => {
  const store = Context.get(core, BrowserStoreCore);
  return {
    record: (entry) => AppRuntime.runPromise(waitedOut(store.BrowserStoreOriginRecord({ entry }))),
    list: () => AppRuntime.runPromise(waitedOut(store.BrowserStoreOriginList())),
    remove: (entries) => AppRuntime.runPromise(waitedOut(store.BrowserStoreOriginRemove({ entries }))),
    removeProfile: (profile) => AppRuntime.runPromise(waitedOut(store.BrowserStoreOriginRemoveProfile({ profile }))),
  };
};

/** The profile registry's store as main uses it: each transaction one core call, its error code kept. */
export const coreBrowserProfileStore = (core: Context.Context<BrowserStoreCore>): BrowserProfileStore => {
  const store = Context.get(core, BrowserStoreCore);
  const unprofiled = <A>(
    call: Effect.Effect<A, BrowserProfileRefused | RpcClientError.RpcClientError>,
  ): Effect.Effect<A, BrowserProfileError> =>
    waitedOut(call).pipe(
      Effect.catchTags({
        BrowserProfileRefused: (refused) =>
          Effect.fail(new BrowserProfileError({ message: refused.message, ...(refused.code === undefined ? {} : { code: refused.code }) })),
        // Only a core that never came back is the registry being unavailable.
        RpcClientError: (cause) => Effect.fail(new BrowserProfileError({ message: "browser profile registry unavailable", code: "io", cause })),
      }),
    );
  return {
    initialize: (initial) => unprofiled(store.BrowserStoreProfileInitialize({ initial })),
    create: (record) => unprofiled(store.BrowserStoreProfileCreate({ record })),
    touch: (id, at) => unprofiled(store.BrowserStoreProfileTouch({ id, at })),
    beginWipe: (begin) => unprofiled(store.BrowserStoreProfileBeginWipe({ begin })),
    markRestartPending: (wipeId) => unprofiled(store.BrowserStoreProfileMarkRestartPending({ wipeId })),
    finalizeWipe: (expected) => unprofiled(store.BrowserStoreProfileFinalizeWipe({ expected })),
  };
};
