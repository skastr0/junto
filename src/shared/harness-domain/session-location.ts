/**
 * Session location: where a harness keeps one of its sessions. Session
 * identity is the foundation of every channel past the screen, and where the
 * session lives is the half of it that outlasts the process: the transcript an
 * ended session leaves, its size, Junto's record of it.
 *
 * A harness supplies it two ways, both under this contract:
 *
 *   locator  its record declares a session store (`sessions`), and main looks
 *            there by session id. The answer's source is `store`.
 *   report   the harness names the path itself, as `SessionIdentified`'s
 *            `transcriptPath`, on a structured channel. The path comes from
 *            the seat's own process, so it is kept only when it resolves
 *            inside that harness's store on the seat's machine, never as a
 *            path that makes Junto read any file. The source is the channel.
 *
 * A lookup always answers: a location, or why there is none.
 * Design: `docs/harness-domain.md`.
 */
import { Schema } from "effect";
import { Fidelity, HarnessChannel } from "./signal";

/** What a located session is: the conversation file, a folder holding it, or the harness's own database. */
export const SESSION_HOLDS = ["transcript", "folder", "database"] as const;
export const SessionHolds = Schema.Literals(SESSION_HOLDS);
export type SessionHolds = typeof SessionHolds.Type;

/**
 * What a harness record declares about its sessions. "none" is explicit: the
 * harness keeps nothing Junto can find (Junto's own overseer seat).
 */
export const SessionStoreSupport = Schema.Union([
  Schema.Struct({ level: Schema.Literal("none") }),
  Schema.Struct({ level: Schema.Literal("store"), holds: Schema.NonEmptyArray(SessionHolds) }),
]);
export type SessionStoreSupport = typeof SessionStoreSupport.Type;

export const NO_SESSION_STORE: SessionStoreSupport = { level: "none" };

/** Who found a location: main's locator over the declared store, or the harness on a channel. */
export const SessionLocationSource = Schema.Union([Schema.Literal("store"), HarnessChannel]);
export type SessionLocationSource = typeof SessionLocationSource.Type;

export const SessionLocation = Schema.Struct({
  path: Schema.String,
  source: SessionLocationSource,
});
export type SessionLocation = typeof SessionLocation.Type;

/**
 * Why a session has no location. none: Junto looked where the harness keeps
 * its sessions and there is nothing under this id, as with a session that
 * ended before the harness wrote anything. unsearchable: Junto cannot look,
 * because the harness keeps no store it can read, or the store depends on a
 * folder the session did not name.
 */
export const SESSION_LOCATION_MISSING = ["none", "unsearchable"] as const;
export const SessionLocationMissing = Schema.Literals(SESSION_LOCATION_MISSING);
export type SessionLocationMissing = typeof SessionLocationMissing.Type;

export const SessionLocated = Schema.Union([
  Schema.TaggedStruct("Located", { location: SessionLocation }),
  Schema.TaggedStruct("Missing", { missing: SessionLocationMissing }),
]);
export type SessionLocated = typeof SessionLocated.Type;

/** The longest path a location keeps. */
export const SESSION_LOCATION_PATH_MAX = 4096;

/**
 * Whether a reported location may be weighed at all, before main checks it
 * against the store: read off a structured channel (never screen text), and
 * an absolute path of bounded length. Main then requires that it resolve
 * inside the harness's store on this machine.
 */
export const reportedLocationAdmissible = (report: {
  readonly path: string;
  readonly channel: HarnessChannel;
  readonly fidelity: Fidelity;
}): boolean =>
  report.fidelity !== "screen" &&
  report.channel !== "screen" &&
  report.path.startsWith("/") &&
  report.path.length <= SESSION_LOCATION_PATH_MAX &&
  !report.path.includes("\0");
