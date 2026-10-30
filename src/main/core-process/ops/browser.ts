import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  BrowserProfileError,
  makeSqlBrowserProfileStore,
  type BrowserProfileErrorCode,
  type BrowserProfilePendingWipe,
  type BrowserProfileRecord,
  type BrowserProfileState,
  type BrowserProfileStatePending,
  type BrowserProfileStateReady,
  type BrowserProfileStore,
  type BrowserProfileWipeBegin,
} from "../../junto/browser/profiles";
import { makeBrowserTouchedOriginStore, type BrowserTouchedOrigin, type BrowserTouchedOriginStore } from "../../junto/browser/touched-origins";
import { coreOps, type CoreOp } from "../ops";

/**
 * What the browser composition in main keeps in the core's database: the
 * origins a seat ran code in, and the profile registry. Main holds no SQL
 * client; it asks for these by name.
 */

/** A profile transaction's outcome as data, so its error code crosses with it. */
export type Profiled<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly code?: BrowserProfileErrorCode; readonly message: string };

declare module "../ops" {
  interface CoreOps {
    "browser.touchedOrigins.record": CoreOp<BrowserTouchedOrigin, void>;
    "browser.touchedOrigins.list": CoreOp<Record<string, never>, ReadonlyArray<BrowserTouchedOrigin>>;
    "browser.touchedOrigins.remove": CoreOp<{ readonly entries: ReadonlyArray<BrowserTouchedOrigin> }, void>;
    "browser.touchedOrigins.removeProfile": CoreOp<{ readonly profile: string }, void>;
    "browser.profiles.initialize": CoreOp<{ readonly initial: BrowserProfileStateReady }, Profiled<BrowserProfileState>>;
    "browser.profiles.create": CoreOp<{ readonly record: BrowserProfileRecord }, Profiled<void>>;
    "browser.profiles.touch": CoreOp<{ readonly id: string; readonly at: string }, Profiled<void>>;
    "browser.profiles.beginWipe": CoreOp<BrowserProfileWipeBegin, Profiled<BrowserProfileStatePending>>;
    "browser.profiles.markRestartPending": CoreOp<{ readonly wipeId: string }, Profiled<void>>;
    "browser.profiles.finalizeWipe": CoreOp<{ readonly expected: BrowserProfilePendingWipe }, Profiled<BrowserProfileStateReady>>;
  }
}

const touched = <A>(use: (store: BrowserTouchedOriginStore) => Promise<A>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.tryPromise(() => use(makeBrowserTouchedOriginStore(sql))));

const profiled = <A>(use: (store: BrowserProfileStore) => Effect.Effect<A, BrowserProfileError>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    use(makeSqlBrowserProfileStore(sql)).pipe(
      Effect.match({
        onSuccess: (value): Profiled<A> => ({ ok: true, value }),
        onFailure: (error): Profiled<A> => ({ ok: false, ...(error.code === undefined ? {} : { code: error.code }), message: error.message }),
      }),
    ));

coreOps({
  "browser.profiles.initialize": ({ initial }) => profiled((store) => store.initialize(initial)),
  "browser.profiles.create": ({ record }) => profiled((store) => store.create(record)),
  "browser.profiles.touch": ({ id, at }) => profiled((store) => store.touch(id, at)),
  "browser.profiles.beginWipe": (begin) => profiled((store) => store.beginWipe(begin)),
  "browser.profiles.markRestartPending": ({ wipeId }) => profiled((store) => store.markRestartPending(wipeId)),
  "browser.profiles.finalizeWipe": ({ expected }) => profiled((store) => store.finalizeWipe(expected)),
  "browser.touchedOrigins.record": (entry) => touched((store) => store.record(entry)),
  "browser.touchedOrigins.list": () => touched((store) => store.list()),
  "browser.touchedOrigins.remove": ({ entries }) => touched((store) => store.remove(entries)),
  "browser.touchedOrigins.removeProfile": ({ profile }) => touched((store) => store.removeProfile(profile)),
});
