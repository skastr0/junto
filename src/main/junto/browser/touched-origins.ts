import { Effect, Schema } from "effect";
import { SqlSchema, type SqlClient } from "effect/unstable/sql";
import { StateTransactionOperation } from "../state/service";
import { runClosedBrowserEffect } from "./run-closed";

/** One (profile, origin) a seat ran code in. */
export interface BrowserTouchedOrigin {
  readonly profile: string;
  readonly origin: string;
}

/**
 * The write-ahead record of origins a seat ran code in (remote-security):
 * an eval's origin is committed here before the eval is dispatched, and the
 * start step clears each one's service workers before any view opens. Rows
 * go only at start, after their own clear, or with their profile's wipe.
 */
export interface BrowserTouchedOriginStore {
  readonly record: (entry: BrowserTouchedOrigin) => Promise<void>;
  readonly list: () => Promise<ReadonlyArray<BrowserTouchedOrigin>>;
  readonly remove: (entries: ReadonlyArray<BrowserTouchedOrigin>) => Promise<void>;
  readonly removeProfile: (profile: string) => Promise<void>;
}

const Row = Schema.Struct({ profile: Schema.String, origin: Schema.String });

export const makeBrowserTouchedOriginStore = (sql: SqlClient.SqlClient): BrowserTouchedOriginStore => {
  const write = <A, E>(operation: string, body: Effect.Effect<A, E>): Promise<A> =>
    runClosedBrowserEffect(
      sql.withTransaction(body).pipe(Effect.provideService(StateTransactionOperation, operation)),
    );
  return {
    record: ({ profile, origin }) =>
      write(
        "browser.touched-origin.record",
        sql`
          INSERT INTO browser_touched_origins (profile, origin)
          VALUES (${profile}, ${origin})
          ON CONFLICT (profile, origin) DO NOTHING
        `,
      ).then(() => undefined),
    list: () =>
      runClosedBrowserEffect(
        SqlSchema.findAll({
          Request: Schema.Void,
          Result: Row,
          execute: () => sql`SELECT profile, origin FROM browser_touched_origins ORDER BY profile, origin`,
        })(undefined),
      ),
    remove: (entries) =>
      write(
        "browser.touched-origin.remove",
        Effect.forEach(
          entries,
          ({ profile, origin }) =>
            sql`DELETE FROM browser_touched_origins WHERE profile = ${profile} AND origin = ${origin}`,
          { discard: true },
        ),
      ),
    removeProfile: (profile) =>
      write(
        "browser.touched-origin.remove-profile",
        sql`DELETE FROM browser_touched_origins WHERE profile = ${profile}`,
      ).then(() => undefined),
  };
};
