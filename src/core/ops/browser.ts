/**
 * The core's handlers of the browser store group
 * (src/contract/core/browser-store.ts): the origins a seat ran code in, and
 * the profile registry, both in the core's database. Main holds no SQL
 * client; its browser composition asks for each row here.
 *
 * A registry refusal fails the call with its code kept; a touched-origin read
 * or write that the database refused fails it with the reason.
 */
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import { type BrowserProfileError, makeSqlBrowserProfileStore } from "../../node/browser/profiles";
import { makeBrowserTouchedOriginStore } from "../../node/browser/touched-origins";
import { BrowserProfileRefused, BrowserStoreRpcs, BrowserTouchedOriginsUnavailable } from "../../contract/core/browser-store";

const refusedBy = (error: BrowserProfileError): BrowserProfileRefused =>
  new BrowserProfileRefused({ message: error.message, ...(error.code === undefined ? {} : { code: error.code }) });

export const BrowserStoreHandlers = BrowserStoreRpcs.toLayer(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const profiles = makeSqlBrowserProfileStore(sql);
    const origins = makeBrowserTouchedOriginStore(sql);
    const profiled = <A>(transaction: Effect.Effect<A, BrowserProfileError>) => Effect.mapError(transaction, refusedBy);
    const touched = <A>(use: () => Promise<A>) =>
      Effect.tryPromise({
        try: use,
        catch: (cause) => new BrowserTouchedOriginsUnavailable({ message: cause instanceof Error ? cause.message : String(cause) }),
      });
    return {
      BrowserStoreOriginRecord: ({ entry }) => touched(() => origins.record(entry)),
      BrowserStoreOriginList: () => touched(() => origins.list()),
      BrowserStoreOriginRemove: ({ entries }) => touched(() => origins.remove(entries)),
      BrowserStoreOriginRemoveProfile: ({ profile }) => touched(() => origins.removeProfile(profile)),
      BrowserStoreProfileInitialize: ({ initial }) => profiled(profiles.initialize(initial)),
      BrowserStoreProfileCreate: ({ record }) => profiled(profiles.create(record)),
      BrowserStoreProfileTouch: ({ id, at }) => profiled(profiles.touch(id, at)),
      BrowserStoreProfileBeginWipe: ({ begin }) => profiled(profiles.beginWipe(begin)),
      BrowserStoreProfileMarkRestartPending: ({ wipeId }) => profiled(profiles.markRestartPending(wipeId)),
      BrowserStoreProfileFinalizeWipe: ({ expected }) => profiled(profiles.finalizeWipe(expected)),
    };
  }),
);
