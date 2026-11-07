import { Effect } from "effect";
import { post, type CorePort } from "../contract/core/port";

/**
 * The core's side of the port: what the core publishes reaches main. Its
 * groups are served on the same port by Effect RPC (`src/core/link.ts`) and
 * what it asks of Electron is answered by main's host server
 * (`src/contract/host/`); this carries the pushes alone.
 */
export const serveCore = (port: CorePort): {
  readonly push: (channel: string, payload: unknown) => void;
} => {
  // A push that cannot cross the port is dropped and logged, never thrown into what pushed.
  const push = (channel: string, payload: unknown): void =>
    post(port, { kind: "push", channel, payload }).pipe(
      Effect.catchTag("PortPostFailed", ({ message }) => Effect.logWarning(`core port: a push on ${channel} could not be posted: ${message}`)),
      Effect.runSync,
    );
  return { push };
};
