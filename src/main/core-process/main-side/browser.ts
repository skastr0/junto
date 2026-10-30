/**
 * Main's side of what the browser composition keeps in the core's database:
 * the origins a seat ran code in, and the profile registry. Main holds no SQL
 * client; each method is one core call, and a profile transaction keeps its
 * error code as it crosses.
 */
import { Effect } from "effect";
import { BrowserProfileError, type BrowserProfileStore } from "../../junto/browser/profiles";
import type { BrowserTouchedOriginStore } from "../../junto/browser/touched-origins";
import type { CoreClient } from "../client";
import { awaitCore } from "../wait-for-core";
import type { Profiled } from "../ops/browser";

/** The touched-origin store as main uses it, each method one core call, waited out while the core starts. */
export const coreTouchedOriginStore = (core: CoreClient): BrowserTouchedOriginStore => ({
  record: (entry) => awaitCore(() => core.call("browser.touchedOrigins.record", entry)),
  list: () => awaitCore(() => core.call("browser.touchedOrigins.list", {})),
  remove: (entries) => awaitCore(() => core.call("browser.touchedOrigins.remove", { entries })),
  removeProfile: (profile) => awaitCore(() => core.call("browser.touchedOrigins.removeProfile", { profile })),
});

const unprofiled = <A>(call: () => Promise<Profiled<A>>): Effect.Effect<A, BrowserProfileError> =>
  Effect.flatMap(
    Effect.tryPromise({
      // The composition starts before the window exists: a core still coming up
      // is waited out, and only a real refusal is the registry being unavailable.
      try: () => awaitCore(call),
      catch: () => new BrowserProfileError({ message: "browser profile registry unavailable", code: "io" }),
    }),
    (answer) => (answer.ok ? Effect.succeed(answer.value) : Effect.fail(new BrowserProfileError({ message: answer.message, ...(answer.code === undefined ? {} : { code: answer.code }) }))),
  );

/** The profile registry's store as main uses it: each transaction one core call, its error code kept. */
export const coreBrowserProfileStore = (core: CoreClient): BrowserProfileStore => ({
  initialize: (initial) => unprofiled(() => core.call("browser.profiles.initialize", { initial })),
  create: (record) => unprofiled(() => core.call("browser.profiles.create", { record })),
  touch: (id, at) => unprofiled(() => core.call("browser.profiles.touch", { id, at })),
  beginWipe: (begin) => unprofiled(() => core.call("browser.profiles.beginWipe", begin)),
  markRestartPending: (wipeId) => unprofiled(() => core.call("browser.profiles.markRestartPending", { wipeId })),
  finalizeWipe: (expected) => unprofiled(() => core.call("browser.profiles.finalizeWipe", { expected })),
});
