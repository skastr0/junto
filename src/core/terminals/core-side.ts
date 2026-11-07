import { Effect, Schema } from "effect";
import { TerminalHost } from "../../contract/host/terminal";
import { TERMINAL_CONNECT } from "../../contract/terminal/protocol";
import { terminalsOverPorts, type TerminalPortMain } from "./over-ports";
import { placeTerminals } from "../../node/terminals/use";

/** Main gave this core no port to a terminal process, or could not be asked. */
export class TerminalsNotGiven extends Schema.TaggedError<TerminalsNotGiven>()("TerminalsNotGiven", {
  message: Schema.String,
}) {}

export type CoreParentPort = {
  readonly on: (event: "message", listener: (event: { readonly data: unknown; readonly ports?: readonly TerminalPortMain[] }) => void) => void;
};

/**
 * The core in its own process: every PTY its plane spawns runs in the
 * terminal process over a port main hands it, never in the core. Installed
 * before the plane starts; resolves once the first port is here, so a seat
 * the boot resumes has its terminals. A later port (the terminal process
 * started again) replaces the last.
 */
export const connectCoreTerminals = (parent: CoreParentPort): Effect.Effect<void, TerminalsNotGiven, TerminalHost> =>
  Effect.gen(function* () {
    // The core's own context: every call on a terminal link runs on it.
    const terminals = terminalsOverPorts(yield* Effect.context<never>());
    placeTerminals({ kind: "process", client: terminals });
    let first!: () => void;
    const connected = new Promise<void>((resolve) => { first = resolve; });
    parent.on("message", (event) => {
      const message = event.data as { readonly kind?: unknown; readonly channel?: unknown };
      const port = event.ports?.[0];
      if (message.kind !== "push" || message.channel !== TERMINAL_CONNECT || port === undefined) return;
      terminals.connect(port);
      first();
    });
    const given = yield* (yield* TerminalHost).TerminalConnect().pipe(
      Effect.mapError((error) => new TerminalsNotGiven({ message: error.message })),
    );
    if (!given) return yield* new TerminalsNotGiven({ message: "Electron main gave the core no terminal process" });
    yield* Effect.promise(() => connected);
  });
