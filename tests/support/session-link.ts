import { Effect } from "effect";
import { isMachineLinkError, MachineLink } from "../../src/core/link/service";
import { linkClosed, type LinkSession } from "../../src/core/link/types";

/** `MachineLink` over one real session, so a contract's typed client runs as it does in the core. */
export const machineLinkOver = (session: LinkSession) => {
  const unused = Effect.die("unused");
  const toLink = (cause: unknown) => (isMachineLinkError(cause) ? cause : linkClosed({ by: "this-end", reason: "failed", cause }));
  return MachineLink.of({
    setChannels: () => unused, listen: () => unused, connect: () => unused, connectSetup: () => unused, disconnect: () => unused, peerBuild: () => unused,
    request: (_machine, channel, payload, options) => Effect.tryPromise({ try: () => session.request(channel, payload, options?.operationId, options?.tag), catch: toLink }),
    sendEvent: (_machine, channel, payload) => Effect.tryPromise({ try: () => session.sendEvent(channel, payload), catch: toLink }),
  });
};
