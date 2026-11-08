import { Effect } from "effect";

export type LinkLogLevel = "Debug" | "Info" | "Warning" | "Error";

/**
 * One link log row. Fields are annotations the log writer turns into row
 * columns: machine, peer, sessionId, channel, operationId, requestId, by,
 * reason, exitCode, signal, peerBuild, peerInstallationId, and `failure`, an
 * EncodedFailure from failure-encode.ts. Every one is on the doctrine's
 * may-enter list; no payload, frame body or terminal byte is ever passed.
 */
export const linkLog = (level: LinkLogLevel, message: string, fields: Record<string, unknown>): Effect.Effect<void> => {
  const write = level === "Debug" ? Effect.logDebug : level === "Info" ? Effect.logInfo : level === "Warning" ? Effect.logWarning : Effect.logError;
  return write(message).pipe(Effect.annotateLogs({ area: "link", ...fields }));
};
