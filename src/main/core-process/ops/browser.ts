import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { makeBrowserTouchedOriginStore, type BrowserTouchedOrigin, type BrowserTouchedOriginStore } from "../../junto/browser/touched-origins";
import { coreOps, type CoreOp } from "../ops";
import type { CoreClient } from "../client";

/**
 * What the browser composition in main keeps in the core's database: the
 * origins a seat ran code in. Main holds no SQL client; it asks for these by
 * name.
 */

declare module "../ops" {
  interface CoreOps {
    "browser.touchedOrigins.record": CoreOp<BrowserTouchedOrigin, void>;
    "browser.touchedOrigins.list": CoreOp<Record<string, never>, ReadonlyArray<BrowserTouchedOrigin>>;
    "browser.touchedOrigins.remove": CoreOp<{ readonly entries: ReadonlyArray<BrowserTouchedOrigin> }, void>;
    "browser.touchedOrigins.removeProfile": CoreOp<{ readonly profile: string }, void>;
  }
}

const touched = <A>(use: (store: BrowserTouchedOriginStore) => Promise<A>) =>
  Effect.flatMap(SqlClient.SqlClient, (sql) => Effect.tryPromise(() => use(makeBrowserTouchedOriginStore(sql))));

coreOps({
  "browser.touchedOrigins.record": (entry) => touched((store) => store.record(entry)),
  "browser.touchedOrigins.list": () => touched((store) => store.list()),
  "browser.touchedOrigins.remove": ({ entries }) => touched((store) => store.remove(entries)),
  "browser.touchedOrigins.removeProfile": ({ profile }) => touched((store) => store.removeProfile(profile)),
});

/** The touched-origin store as main uses it, each method one core call. */
export const coreTouchedOriginStore = (core: CoreClient): BrowserTouchedOriginStore => ({
  record: (entry) => core.call("browser.touchedOrigins.record", entry),
  list: () => core.call("browser.touchedOrigins.list", {}),
  remove: (entries) => core.call("browser.touchedOrigins.remove", { entries }),
  removeProfile: (profile) => core.call("browser.touchedOrigins.removeProfile", { profile }),
});
